import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { now, outputSchema, TaskError, type Failure, type Run, type SandboxPort } from './domain.js';
import { Store } from './store.js';
import { Files } from './files.js';
import { validateFiles } from './file-validator.js';
import type { StoredObject } from './domain.js';
const validates = new Ajv({ strict: true }).compile(outputSchema);
async function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw new TaskError('deadline_exceeded'); }
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new TaskError('deadline_exceeded'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation, deadline]); }
  finally { signal.removeEventListener('abort', abort); }
}
export class Worker {
  private active: Promise<void> | null = null;
  private stopping = false;
  constructor(private store: Store, private sandbox: SandboxPort, private files: Files) {}
  async recover() {
    let recordFailure = false;
    for (const run of this.store.all()) {
      try { if (run.status === 'running') this.finish(run.run_id, 'execution_lost'); }
      catch { recordFailure = true; }
      // Already-read immutable identities remain usable for disposal when a business or audit write fails.
      try { if (run.status !== 'queued' && run.cleanup.status !== 'complete') await this.cleanup(run); }
      catch { recordFailure = true; }
    }
    if (recordFailure) throw new Error('recovery_record_unavailable');
  }
  wake() {
    if (this.active || this.stopping) return;
    this.active = this.drain().catch(() => { /* No raw error payload at an observation exit. Durable running intent is recovered on restart. */ })
      .finally(() => { this.active = null; });
  }
  private async drain() {
    while (!this.stopping) {
      const run = this.store.all().reverse().find(r => r.status === 'queued');
      if (!run) return;
      await this.execute(run);
    }
  }
  private finish(id: string, failure: Failure | null, result?: unknown, artifacts: StoredObject[] = []) {
    this.store.change(id, failure ? 'run.fail' : 'result.commit', run => {
      if (run.terminal_at) return;
      run.failure = failure;
      run.status = failure === 'deadline_exceeded' ? 'timed_out' : failure ? 'failed' : 'succeeded';
      run.phase = 'terminal'; run.terminal_at = now();
      if (!failure || failure === 'output_invalid') run.validation = { status: failure ? 'failed' : 'passed', contract: run.manifest.output_contract, checks: failure ? ['output-contract'] : run.manifest.output_contract === 'data-statistics@1' ? ['schema', 'input-integrity', 'required-files', 'decimal-statistics', 'ordered-rows', 'tool-execution', 'durable-transfer'] : ['schema'] };
      if (!failure) { this.files.commit(artifacts, run.terminal_at); run.result = result as Run['result']; run.artifacts = artifacts.map(a => a.object_id); }
    });
  }
  private async execute(queued: Run) {
    let latest = queued;
    let staged: StoredObject[] = [];
    let phase: 'preparing' | 'executing' | 'committing' = 'preparing';
    const left = Date.parse(queued.manifest.deadline_at) - Date.now();
    if (left <= 0) { try { this.finish(queued.run_id, 'deadline_exceeded'); } finally { await this.cleanup(latest); } return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    try {
      const run = this.store.change(queued.run_id, 'sandbox.create-intent', r => {
        if (r.status !== 'queued') throw new TaskError('execution_lost');
        r.status = 'running'; r.phase = 'preparing';
        r.allocation = { operation_id: randomUUID(), resource_id: null };
      });
      latest = run;
      const resource = await beforeDeadline(this.sandbox.prepare(run), controller.signal);
      latest = { ...run, allocation: { ...run.allocation!, resource_id: resource } };
      const prepared = this.store.change(run.run_id, 'sandbox.prepared', r => { r.allocation!.resource_id = resource; });
      if (controller.signal.aborted || Date.now() >= Date.parse(queued.manifest.deadline_at)) throw new TaskError('deadline_exceeded');
      const inputs = await beforeDeadline(this.files.load(prepared), controller.signal);
      if (inputs.length) {
        if (!this.sandbox.loadInputs) throw new TaskError('provisioning_failed');
        await beforeDeadline(this.sandbox.loadInputs(prepared, inputs), controller.signal);
        this.store.change(prepared.run_id, 'input.loaded', r => { for (const binding of r.manifest.grant.inputs) binding.loaded = true; });
      }
      phase = 'executing';
      const executing = this.store.change(prepared.run_id, 'attempt.start-intent', r => {
        if (r.attempt_id) throw new TaskError('execution_lost');
        r.attempt_id = randomUUID(); r.phase = 'executing';
      });
      const result = await beforeDeadline(this.sandbox.execute(executing, controller.signal), controller.signal);
      if (controller.signal.aborted || Date.now() >= Date.parse(queued.manifest.deadline_at)) throw new TaskError('deadline_exceeded');
      let candidate = result;
      if (executing.manifest.output_contract === 'data-statistics@1') {
        const validated = validateFiles(result, inputs[0]!); candidate = validated.result;
        this.store.audit('platform', executing.workspace, 'tool.process-data-observed', 'completed', executing.run_id,
          { source: this.sandbox.source, resource_id: executing.allocation!.resource_id, operation_id: executing.attempt_id, observed_at: now() });
        phase = 'committing';
        staged = await beforeDeadline(this.files.stage(executing, validated.files, controller.signal), controller.signal);
      } else if (!validates(result)) throw new TaskError('output_invalid');
      if (controller.signal.aborted || Date.now() >= Date.parse(queued.manifest.deadline_at)) throw new TaskError('deadline_exceeded');
      phase = 'committing';
      this.finish(run.run_id, null, candidate, staged);
    } catch (error) {
      const failure = controller.signal.aborted ? 'deadline_exceeded' : error instanceof TaskError ? error.code :
        phase === 'preparing' ? 'provisioning_failed' : phase === 'committing' ? 'artifact_commit_failed' : 'runtime_failed';
      this.finish(queued.run_id, failure);
    } finally {
      clearTimeout(timer);
      try { if (this.store.get(queued.run_id)?.status !== 'succeeded') for (const object of staged) await this.files.discard(object); }
      finally { await this.cleanup(latest); }
    }
  }
  private async cleanup(run: Run) {
    let status: Run['cleanup']['status'] = 'unknown';
    try { status = !run.allocation || await this.sandbox.cleanup(run) === 'absent' ? 'complete' : 'unknown'; }
    catch { status = 'failed'; }
    const observedAt = now();
    const source = run.allocation ? this.sandbox.source : 'platform:no-create-intent';
    this.store.change(run.run_id, 'sandbox.cleanup-observed', r => {
      r.cleanup = { status, observed_at: observedAt, source };
    }, { outcome: status, evidence: { source, observed_at: observedAt,
      resource_id: run.allocation?.resource_id ?? null, operation_id: run.allocation?.operation_id ?? null } });
  }
  async close() { this.stopping = true; await this.active; }
}
