import { TaskError, type Run, type SandboxPort } from './domain.js';
// Explicit external-system double. Never selected by a live profile or by user prompt.
export class FixtureSandbox implements SandboxPort {
  readonly source = 'deterministic-fixture';
  readonly resources = new Set<string>();
  readonly executions = new Set<string>();
  constructor(public scenario: 'success' | 'invalid' | 'prepare-failed' | 'cleanup-unknown' | 'input-required' | 'authorization-required' | 'timeout' = 'success') {}
  async prepare(run: Run) {
    const id = `fixture-${run.allocation!.operation_id}`;
    this.resources.add(id);
    if (this.scenario === 'prepare-failed') throw new TaskError('provisioning_failed');
    return id;
  }
  async execute(run: Run, signal: AbortSignal): Promise<unknown> {
    if (this.executions.has(run.run_id)) throw new TaskError('execution_lost');
    this.executions.add(run.run_id);
    if (this.scenario === 'timeout') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new TaskError('deadline_exceeded')), { once: true }));
    if (this.scenario === 'input-required') throw new TaskError('input_required');
    if (this.scenario === 'authorization-required') throw new TaskError('authorization_required');
    if (this.scenario === 'invalid') return { summary: 'I succeeded', value: '3', actor: 'admin', secret: 'SYNTHETIC_SECRET' };
    return { summary: 'three apples', value: 3 };
  }
  async cleanup(run: Run) {
    if (this.scenario === 'cleanup-unknown') return 'unknown' as const;
    this.resources.delete(run.allocation?.resource_id ?? `fixture-${run.allocation?.operation_id}`);
    return 'absent' as const;
  }
}
