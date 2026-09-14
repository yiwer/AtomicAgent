import { now, type Run, type SandboxPort } from './domain.js';
import type { Store } from './store.js';
import { randomUUID } from 'node:crypto';

export function cancellationObservation(runs: Run[]) {
  const cancelled = runs.filter(r => r.cancellation?.decision === 'accepted');
  return { source: 'platform:durable-cancellation-and-stop-observations', queried_at: now(),
    observed_at: cancelled.map(r => r.stop?.observed_at).filter(Boolean).sort().at(-1) ?? null,
    coverage: 'recorded-stop-evidence-only', accepted: cancelled.length,
    stopped: cancelled.filter(r => r.stop?.status === 'stopped').length,
    not_started: cancelled.filter(r => r.stop?.status === 'not_started').length,
    pending: cancelled.filter(r => r.stop?.status === 'pending').length,
    unknown: cancelled.filter(r => r.stop?.status === 'unknown').length,
    cleanup_unfinished: cancelled.filter(r => r.cleanup.status !== 'complete').length };
}

// Persisted intent is authoritative; SDK cancellation and deletion receipts are never stop observations.
export class Cancellation {
  private busy = new Map<string, Promise<void>>();
  private signalled = new Set<string>();
  private nextCheck = new Map<string, number>();
  private emergency = new Map<string, Run>();
  private known = new Map<string, Run>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private store: Store, private sandbox: SandboxPort, private cleanup: (run: Run) => Promise<void>,
    private resumed: () => void, private clock = Date.now) {
    this.timer = setInterval(() => this.wake(), 250); this.timer.unref();
  }
  wake() {
    if (this.closed) return;
    let records: Run[];
    try { records = this.store.all(); }
    catch { records = [...new Map([...this.known, ...this.emergency]).values()]; }
    for (const recorded of records) {
      const fallback = this.emergency.get(recorded.run_id);
      const run = fallback ? { ...recorded, cancellation: fallback.cancellation, stop: recorded.stop ?? fallback.stop } : recorded;
      if (run.cleanup.status === 'complete' && this.stopped(run)) {
        this.signalled.delete(run.run_id); this.nextCheck.delete(run.run_id); this.emergency.delete(run.run_id); this.known.delete(run.run_id); continue;
      }
      if (run.cancellation?.decision !== 'accepted' && !run.limit_termination) continue;
      this.known.set(run.run_id, run);
      if (this.busy.has(run.run_id)) continue;
      if (this.clock() < Math.max(this.nextCheck.get(run.run_id) ?? 0, Date.parse(run.stop?.retry_at ?? '') || 0)) continue;
      const operation = this.reconcile(run).catch(() => { /* Immutable identities and pending facts survive failed writes. */ })
        .finally(() => { this.busy.delete(run.run_id); this.resumed(); });
      this.busy.set(run.run_id, operation);
    }
  }
  private stopped(run: Run) { return run.stop?.status === 'stopped' || run.stop?.status === 'not_started'; }
  private current(run: Run) { try { return this.store.get(run.run_id) ?? run; } catch { return run; } }
  recordFailure(run: Run) {
    if (run.terminal_at || this.emergency.has(run.run_id)) return;
    const requestedAt = this.clock();
    this.emergency.set(run.run_id, { ...run,
      cancellation: { operation_id: randomUUID(), actor: 'platform', role: 'maintainer', requested_at: new Date(requestedAt).toISOString(), decision: 'accepted', grace_deadline_at: run.attempt_id ? new Date(requestedAt + 30_000).toISOString() : null },
      stop: { status: run.attempt_id ? 'pending' : 'not_started', source: null, observed_at: null, forced_at: null } });
    this.wake();
  }
  private async reconcile(run: Run) {
    const checks = (run.stop?.checks ?? 0) + 1;
    const retryAt = this.clock() + Math.min(30_000, 1000 * 2 ** Math.min(checks - 1, 5));
    if (run.attempt_id && !this.stopped(run)) {
      if (!this.signalled.has(run.run_id)) {
        this.signalled.add(run.run_id);
        // Best effort graceful SDK interrupt through the controlled runner. Failure cannot defer the forced deadline.
        void this.sandbox.requestStop?.(run).catch(() => {});
      }
      if (this.clock() < Date.parse(run.limit_termination?.observed_at ?? run.cancellation!.grace_deadline_at!)) return;
      this.nextCheck.set(run.run_id, retryAt);
      let status: 'stopped' | 'unknown' = 'unknown';
      const forcedAt = now();
      try { this.store.change(run.run_id, 'execution.force-stop-intent', r => { r.stop ??= run.stop; r.stop!.forced_at ??= forcedAt; }); }
      catch { /* Disposal of an already-read immutable resource remains permitted during record failure. */ }
      try { status = await this.sandbox.forceStop?.(run) ?? 'unknown'; } catch { /* Remains unknown. */ }
      const observedAt = now(), source = this.sandbox.sourceFor?.(run) ?? this.sandbox.source;
      try {
        this.store.change(run.run_id, 'execution.stop-observed', r => { r.stop = { status, forced_at: r.stop?.forced_at ?? forcedAt, observed_at: observedAt, source, checks, retry_at: status === 'unknown' ? new Date(retryAt).toISOString() : null }; },
          { outcome: status, evidence: { source, resource_id: run.allocation?.resource_id ?? null, operation_id: run.attempt_id, observed_at: observedAt } });
      } finally {
        // Cleanup is independent and can still proceed during observation-write failure.
        if (status === 'stopped') { this.signalled.delete(run.run_id); await this.cleanup(this.current(run)); }
      }
      return;
    }
    this.nextCheck.set(run.run_id, this.clock() + 30_000);
    await this.cleanup(this.current(run));
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled(this.busy.values()); }
}
