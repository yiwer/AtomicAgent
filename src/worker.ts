import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { now, outputSchema, TaskError, type Failure, type Run, type SandboxPort } from './domain.js';
import { Store } from './store.js';
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
  constructor(private store: Store, private sandbox: SandboxPort) {}
  async recover() {
    for (const run of this.store.all()) {
      if (run.status === 'running') this.finish(run.run_id, 'execution_lost');
      if (run.status !== 'queued' && run.cleanup.status !== 'complete') await this.cleanup(run.run_id);
    }
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
  private finish(id: string, failure: Failure | null, result?: unknown) {
    this.store.change(id, failure ? 'run.fail' : 'result.commit', run => {
      if (run.terminal_at) return;
      run.failure = failure;
      run.status = failure === 'deadline_exceeded' ? 'timed_out' : failure ? 'failed' : 'succeeded';
      run.phase = 'terminal'; run.terminal_at = now();
      if (!failure || failure === 'output_invalid') run.validation = { status: failure ? 'failed' : 'passed', contract: 'summary-value@1' };
      if (!failure) run.result = result as Run['result'];
    });
  }
  private async execute(queued: Run) {
    let phase: 'preparing' | 'executing' | 'committing' = 'preparing';
    const left = Date.parse(queued.manifest.deadline_at) - Date.now();
    if (left <= 0) { this.finish(queued.run_id, 'deadline_exceeded'); await this.cleanup(queued.run_id); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    try {
      const run = this.store.change(queued.run_id, 'sandbox.create-intent', r => {
        if (r.status !== 'queued') throw new TaskError('execution_lost');
        r.status = 'running'; r.phase = 'preparing';
        r.allocation = { operation_id: randomUUID(), resource_id: null };
      });
      const resource = await beforeDeadline(this.sandbox.prepare(run), controller.signal);
      const prepared = this.store.change(run.run_id, 'sandbox.prepared', r => { r.allocation!.resource_id = resource; });
      if (controller.signal.aborted) throw new TaskError('deadline_exceeded');
      phase = 'executing';
      const executing = this.store.change(prepared.run_id, 'attempt.start-intent', r => {
        if (r.attempt_id) throw new TaskError('execution_lost');
        r.attempt_id = randomUUID(); r.phase = 'executing';
      });
      const result = await beforeDeadline(this.sandbox.execute(executing, controller.signal), controller.signal);
      if (controller.signal.aborted) throw new TaskError('deadline_exceeded');
      if (!validates(result)) throw new TaskError('output_invalid');
      phase = 'committing';
      this.finish(run.run_id, null, result);
    } catch (error) {
      const failure = controller.signal.aborted ? 'deadline_exceeded' : error instanceof TaskError ? error.code :
        phase === 'preparing' ? 'provisioning_failed' : phase === 'committing' ? 'artifact_commit_failed' : 'runtime_failed';
      this.finish(queued.run_id, failure);
    } finally {
      clearTimeout(timer);
      await this.cleanup(queued.run_id);
    }
  }
  private async cleanup(id: string) {
    const run = this.store.get(id)!;
    let status: Run['cleanup']['status'] = 'unknown';
    try { status = !run.allocation || await this.sandbox.cleanup(run) === 'absent' ? 'complete' : 'unknown'; }
    catch { status = 'failed'; }
    this.store.change(id, 'sandbox.cleanup-observed', r => {
      r.cleanup = { status, observed_at: now(), source: run.allocation ? this.sandbox.source : 'platform:no-create-intent' };
    });
  }
  async close() { this.stopping = true; await this.active; }
}
