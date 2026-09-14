import { validateResearch, researchMarkdown, type SourceReceipt, type McpEvidence, validateMcpEvidence } from './research.js';
import { validateSkillEvidence, type ObserveSkills } from './skills.js';
import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { now, outputSchema, TaskError, type Failure, type Run, type SandboxPort } from './domain.js';
import { Store } from './store.js';
import { Files } from './files.js';
import { validateFiles } from './file-validator.js';
import type { StoredObject } from './domain.js';
import { Cancellation } from './cancellation.js';
import { validateBoundary, type ObserveBoundary } from './execution-boundary.js';
const validates = new Ajv({ strict: true }).compile(outputSchema);
async function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw signal.reason instanceof TaskError ? signal.reason : new TaskError('deadline_exceeded'); }
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason instanceof TaskError ? signal.reason : new TaskError('deadline_exceeded'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation, deadline]); }
  finally { signal.removeEventListener('abort', abort); }
}
export class Worker {
  private active: Promise<void> | null = null;
  private stopping = false;
  private closed = false;
  private recordFailure = false;
  private controllers = new Map<string, AbortController>();
  private cancellation: Cancellation;
  constructor(private store: Store, private sandbox: SandboxPort, private files: Files, cancellationClock?: () => number) {
    this.cancellation = new Cancellation(store, sandbox, run => this.cleanup(run), () => this.wake(), cancellationClock);
  }
  cancel(id: string) { if (this.store.get(id)?.cancellation?.decision === 'accepted') this.controllers.get(id)?.abort(); this.cancellation.wake(); }
  cancelRecordFailure(run: Run) { this.recordFailure = true; this.controllers.get(run.run_id)?.abort(new TaskError('execution_lost')); this.cancellation.recordFailure(run); }
  get acceptingWork() { return !this.recordFailure; }
  async recover() {
    let recordFailure = false;
    for (const run of this.store.all()) {
      try { if (run.status === 'running') this.finish(run.run_id, 'execution_lost'); }
      catch { recordFailure = true; }
      // Already-read immutable identities remain usable for disposal when a business or audit write fails.
      try { if (run.status !== 'queued' && run.cleanup.status !== 'complete' && run.cancellation?.decision !== 'accepted') await this.cleanup(run); }
      catch { recordFailure = true; }
    }
    if (recordFailure) throw new Error('recovery_record_unavailable');
    this.cancellation.wake();
  }
  wake() {
    if (this.active || this.stopping || this.recordFailure) return;
    this.active = this.drain().catch(() => { /* No raw error payload at an observation exit. Durable running intent is recovered on restart. */ })
      .finally(() => { this.active = null; });
  }
  private async drain() {
    while (!this.stopping && !this.recordFailure) {
      if (this.store.all().some(r => r.cancellation?.decision === 'accepted' && r.attempt_id && r.stop?.status !== 'stopped')) return;
      const run = this.store.all().reverse().find(r => r.status === 'queued');
      if (!run) return;
      await this.execute(run);
    }
  }
  private finish(id: string, failure: Failure | null, result?: unknown, artifacts: StoredObject[] = []) {
    if (this.store.get(id)?.terminal_at) return;
    this.store.change(id, failure ? 'run.fail' : 'result.commit', run => {
      if (run.terminal_at) return;
      run.failure = failure;
      run.status = failure === 'deadline_exceeded' ? 'timed_out' : failure ? 'failed' : 'succeeded';
      run.phase = 'terminal'; run.terminal_at = now();
      if (!failure || failure === 'output_invalid') run.validation = { status: failure ? 'failed' : 'passed', contract: run.manifest.output_contract, checks: failure ? ['output-contract'] : run.manifest.output_contract === 'research-report@1' ? ['schema', 'acquired-sources', 'quote-correspondence', 'markdown', 'durable-transfer', 'semantic-review-not-covered'] : run.manifest.output_contract === 'data-statistics@1' ? ['schema', 'input-integrity', 'required-files', 'decimal-statistics', 'ordered-rows', 'tool-execution', 'durable-transfer'] : ['schema'] };
      if (!failure) { this.files.commit(artifacts, run.terminal_at); run.result = result as Run['result']; run.artifacts = artifacts.map(a => a.object_id); }
    });
  }
  private async preparationReturned(run: Run, action: string, update: (run: Run) => void) {
    if (this.closed) { await this.sandbox.cleanup(run); return; }
    try { this.store.change(run.run_id, action, update); }
    finally {
      let disposalRequired = true;
      try { disposalRequired = !!this.store.get(run.run_id)?.terminal_at; } catch { /* No new execution is safe without its record. */ }
      if (disposalRequired) await this.cleanup(run);
    }
  }
  private async execute(queued: Run) {
    let latest = queued;
    let staged: StoredObject[] = [];
    let phase: 'preparing' | 'executing' | 'committing' = 'preparing';
    const left = Date.parse(queued.manifest.deadline_at) - Date.now();
    if (left <= 0) { try { this.finish(queued.run_id, 'deadline_exceeded'); } finally { await this.cleanup(latest); } return; }
    const controller = new AbortController();
    this.controllers.set(queued.run_id, controller);
    const timer = setTimeout(() => controller.abort(), left);
    try {
      const run = this.store.change(queued.run_id, 'sandbox.create-intent', r => {
        if (r.status !== 'queued') throw new TaskError('execution_lost');
        r.status = 'running'; r.phase = 'preparing';
        r.allocation = { operation_id: randomUUID(), resource_id: null, creation_pending: true };
      });
      latest = run;
      const preparation = this.sandbox.prepare(run).then(async resource => {
        latest = { ...run, allocation: { ...run.allocation!, resource_id: resource, creation_pending: false } };
        await this.preparationReturned(latest, 'sandbox.create-receipt', r => { r.allocation!.resource_id = resource; r.allocation!.creation_pending = false; });
        return resource;
      }, error => {
        latest = { ...run, allocation: { ...run.allocation!, creation_pending: false } };
        if (!this.closed) this.store.change(run.run_id, 'sandbox.create-returned', r => { r.allocation!.creation_pending = false; });
        throw error;
      });
      const resource = await beforeDeadline(preparation, controller.signal);
      latest = { ...run, allocation: { ...run.allocation!, resource_id: resource, creation_pending: false } };
      const prepared = this.store.change(run.run_id, 'sandbox.prepared', r => { if (r.terminal_at) throw new TaskError('execution_lost'); r.allocation!.resource_id = resource; });
      if (controller.signal.aborted || Date.now() >= Date.parse(queued.manifest.deadline_at)) throw new TaskError('deadline_exceeded');
      const inputs = await beforeDeadline(this.files.load(prepared), controller.signal);
      if (inputs.length) {
        if (!this.sandbox.loadInputs) throw new TaskError('provisioning_failed');
        try {
          latest = this.store.change(run.run_id, 'input.copy-intent', r => { if (r.terminal_at) throw new TaskError('execution_lost'); r.allocation!.input_copy_pending = true; });
          const copy = this.sandbox.loadInputs(prepared, inputs).finally(async () => {
            latest = { ...latest, allocation: { ...latest.allocation!, input_copy_pending: false } };
            await this.preparationReturned(latest, 'input.copy-returned', r => { r.allocation!.input_copy_pending = false; });
          });
          await beforeDeadline(copy, controller.signal);
        }
        catch (error) { if (inputs.some(i => i.binding.source) && !(error instanceof TaskError && error.code === 'deadline_exceeded')) throw new TaskError('input_copy_failed'); throw error; }
        await beforeDeadline(this.files.confirmCopies(prepared), controller.signal);
        this.store.change(prepared.run_id, 'input.loaded', r => { if (r.terminal_at) throw new TaskError('execution_lost'); for (const binding of r.manifest.grant.inputs) { binding.loaded = true; binding.loaded_at = now(); } });
      }
      phase = 'executing';
      const executing = this.store.change(prepared.run_id, 'attempt.start-intent', r => {
        if (r.attempt_id || r.terminal_at) throw new TaskError('execution_lost');
        r.attempt_id = randomUUID(); r.phase = 'executing';
        for (const e of r.skills ?? []) e.attempt_id = r.attempt_id;
      });
      const observeSkills: ObserveSkills = evidence => {
        const checked = validateSkillEvidence(executing, evidence);
        this.store.change(executing.run_id, 'skill.observed', r => {
          if (r.terminal_at || r.attempt_id !== executing.attempt_id) throw new TaskError('execution_lost');
          for (const e of checked) if (e.used && !r.skills?.find(old => old.id === e.id)?.used) {
            this.store.audit('platform', r.workspace, 'skill.used', 'completed', r.run_id, { source: e.source, resource_id: `skill:${e.id}@${e.version}`, operation_id: e.invocation_id, observed_at: e.observed_at! });
          }
          r.skills = checked;
        }, { outcome: checked.every(e => e.callable) ? 'callable' : 'unknown', evidence: { source: this.sandbox.sourceFor?.(executing) ?? this.sandbox.source, resource_id: executing.allocation!.resource_id, operation_id: executing.attempt_id, observed_at: now() } });
      };
      const observeMcp = (value: unknown) => { const checked = validateMcpEvidence(executing, value); this.store.change(executing.run_id, 'mcp.observed', r => { if (r.terminal_at || r.attempt_id !== executing.attempt_id) throw new TaskError('execution_lost'); for (const e of checked) for (const call of e.calls) {
        const old = r.mcp?.find(m => m.id === e.id)?.calls.find(c => c.invocation_id === call.invocation_id);
        if (old?.outcome !== call.outcome) this.store.audit('platform', r.workspace, 'mcp.call-observed', call.outcome, r.run_id, { source: e.source, resource_id: `mcp:${e.id}@${e.version}/${call.source_id ?? 'denied-tool'}`, operation_id: call.invocation_id, observed_at: call.observed_at });
      } r.mcp = checked; }); };
      const observeBoundary: ObserveBoundary = value => {
        const checked = validateBoundary(executing, value);
        this.store.change(executing.run_id, 'boundary.observed', r => {
          if (r.terminal_at || r.attempt_id !== executing.attempt_id) throw new TaskError('execution_lost');
          const previous = r.boundary?.calls ?? [];
          const added = checked.calls.filter(call=>!previous.some(old=>old.invocation_id===call.invocation_id && old.outcome===call.outcome));
          if(previous.length+added.length>128)throw new TaskError('policy_denied');
          for (const call of added)
            this.store.audit('platform',r.workspace,call.outcome==='started'?'boundary.action-admit':'boundary.call',call.outcome==='started'?'admitted':call.outcome,r.run_id,{ source:checked.source,operation_id:call.invocation_id,resource_id:call.boundary,observed_at:call.observed_at });
          r.boundary = { ...(r.boundary && r.boundary.observed_at>checked.observed_at ? r.boundary:checked),calls:[...previous,...added] };
        });
      };
      const result = await beforeDeadline(this.sandbox.execute(executing, controller.signal, observeSkills, observeMcp, observeBoundary), controller.signal);
      if (this.store.get(executing.run_id)?.boundary?.calls.some(c=>c.outcome==='denied')) throw new TaskError('policy_denied');
      const skillEvidence = this.store.get(executing.run_id)!.skills ?? [];
      for (const s of executing.manifest.skills ?? []) {
        const e = skillEvidence.find(e => e.id === s.id && e.version === s.version);
        if (!e?.loaded || !e.callable) throw new TaskError('required_capability_failed');
        if (s.must_use && !e.used) throw new TaskError('skill_use_unproven');
      }
      if (controller.signal.aborted || Date.now() >= Date.parse(queued.manifest.deadline_at)) throw new TaskError('deadline_exceeded');
      let candidate = result;
      if (executing.manifest.output_contract === 'research-report@1') {
        const envelope = result as { candidate: unknown; receipts: SourceReceipt[]; mcp: McpEvidence[]; files: { path: string; bytes: Buffer }[] };
        const binding = executing.manifest.grant.mcp[0]!;
        observeMcp(envelope.mcp);
        const research = validateResearch(envelope.candidate, envelope.receipts, binding);
        if (!Array.isArray(envelope.files) || envelope.files.length !== 1 || envelope.files[0]?.path !== 'output/report.md' || !Buffer.isBuffer(envelope.files[0].bytes) || envelope.files[0].bytes.toString('utf8') !== researchMarkdown(research)) throw new TaskError('output_invalid');
        const checked = validateMcpEvidence(executing, envelope.mcp);
        const e = checked[0];
        if (envelope.receipts.some(s => !e?.calls.some(c => c.invocation_id === s.invocation_id && c.source_id === s.id && c.outcome === 'acquired') || Date.parse(s.acquired_at) < Date.parse(executing.accepted_at) || Date.parse(s.acquired_at) > Date.now()+1000)) throw new TaskError('output_invalid');
        if (!e || e.id !== binding.id || e.version !== binding.version || e.connected !== true || e.callable !== true || e.authorized !== true || e.acquired !== envelope.receipts.length) throw new TaskError('required_capability_failed');
        this.store.change(executing.run_id, 'mcp.observed', r => { r.mcp = checked;
          for (const receipt of envelope.receipts) this.store.audit('platform', r.workspace, 'mcp.source-acquired', 'acquired', r.run_id, { source: receipt.source, resource_id: `mcp:${binding.id}@${binding.version}/${receipt.id}`, operation_id: receipt.invocation_id, observed_at: receipt.acquired_at });
        });
        candidate = research; phase = 'committing';
        staged = await beforeDeadline(this.files.stage(executing, envelope.files, controller.signal), controller.signal);
      } else if (executing.manifest.output_contract === 'data-statistics@1') {
        const validated = validateFiles(result, inputs[0]!); candidate = validated.result;
        this.store.audit('platform', executing.workspace, 'tool.process-data-observed', 'completed', executing.run_id,
          { source: this.sandbox.sourceFor?.(executing) ?? this.sandbox.source, resource_id: executing.allocation!.resource_id, operation_id: executing.attempt_id, observed_at: now() });
        phase = 'committing';
        staged = await beforeDeadline(this.files.stage(executing, validated.files, controller.signal), controller.signal);
      } else if (!validates(result)) throw new TaskError('output_invalid');
      if (controller.signal.aborted || Date.now() >= Date.parse(queued.manifest.deadline_at)) throw new TaskError('deadline_exceeded');
      phase = 'committing';
      this.finish(run.run_id, null, candidate, staged);
    } catch (error) {
      const failure = controller.signal.aborted ? (controller.signal.reason instanceof TaskError ? controller.signal.reason.code : 'deadline_exceeded') : error instanceof TaskError ? error.code :
        phase === 'preparing' ? 'provisioning_failed' : phase === 'committing' ? 'artifact_commit_failed' : 'runtime_failed';
      this.finish(queued.run_id, failure);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(queued.run_id);
      try { if (this.store.get(queued.run_id)?.status !== 'succeeded') for (const object of staged) await this.files.discard(object); }
      finally { if (this.store.get(queued.run_id)?.cancellation?.decision === 'accepted' || this.recordFailure) this.cancellation.wake(); else await this.cleanup(latest); }
    }
  }
  private async cleanup(run: Run) {
    let status: Run['cleanup']['status'] = 'unknown';
    try { status = !run.allocation || await this.sandbox.cleanup(run) === 'absent' ? 'complete' : 'unknown'; if (run.allocation?.creation_pending || run.allocation?.input_copy_pending) status = 'unknown'; }
    catch { status = 'failed'; }
    const observedAt = now();
    const source = run.allocation ? (this.sandbox.sourceFor?.(run) ?? this.sandbox.source) : 'platform:no-create-intent';
    this.store.change(run.run_id, 'sandbox.cleanup-observed', r => {
      r.cleanup = { status, observed_at: observedAt, source };
    }, { outcome: status, evidence: { source, observed_at: observedAt,
      resource_id: run.allocation?.resource_id ?? null, operation_id: run.allocation?.operation_id ?? null } });
  }
  async close() { this.stopping = true; await this.active; await this.cancellation.close(); this.closed = true; }
}
