import { now, TaskError, type Run } from './domain.js';
export interface BoundaryEvidence {
 run_id: string; attempt_id: string; source: 'controlled-runner:namespace-and-gateway'; observed_at: string;
 isolation: 'enforced' | 'unavailable' | 'unknown'; audit_coverage: 'partial';
 calls: { invocation_id: string; boundary: 'model' | 'tool' | 'transport' | 'mcp'; outcome: 'started' | 'completed' | 'denied' | 'failed'; observed_at: string }[];
}
export type ObserveBoundary = (evidence: BoundaryEvidence) => void;
export function validateBoundary(run: Run, value: unknown): BoundaryEvidence {
 const e = value as BoundaryEvidence;
 if (!e || e.run_id !== run.run_id || e.attempt_id !== run.attempt_id || e.source !== 'controlled-runner:namespace-and-gateway' || e.audit_coverage !== 'partial' ||
  !['enforced','unavailable','unknown'].includes(e.isolation) || !Number.isFinite(Date.parse(e.observed_at)) || Date.parse(e.observed_at) < Date.parse(run.accepted_at) || Date.parse(e.observed_at) > Date.now()+1000 || !Array.isArray(e.calls) || e.calls.length > 128) throw new TaskError('isolation_unavailable');
 const calls = e.calls.map(c => {
  if (!/^[0-9a-f-]{36}$/.test(c.invocation_id) || !['model','tool','transport','mcp'].includes(c.boundary) || !['started','completed','denied','failed'].includes(c.outcome) || !Number.isFinite(Date.parse(c.observed_at)) || Date.parse(c.observed_at) < Date.parse(run.accepted_at) || Date.parse(c.observed_at) > Date.now()+1000) throw new TaskError('isolation_unavailable');
  return { invocation_id:c.invocation_id,boundary:c.boundary,outcome:c.outcome,observed_at:c.observed_at };
 });
 return { run_id:e.run_id,attempt_id:e.attempt_id,source:e.source,observed_at:e.observed_at,isolation:e.isolation,audit_coverage:'partial',calls };
}
export function boundaryObservation(runs: Run[]) {
 const evidence = runs.flatMap(r => r.boundary ? [r.boundary] : []), last = evidence.map(e => e.observed_at).sort().at(-1) ?? null;
 return { source:'platform:durable-execution-boundaries',queried_at:now(),observed_at:last, freshness: last && Date.now()-Date.parse(last)<=60000 ? 'fresh':'unknown',
  coverage:'controlled-model-and-tool-calls; syscall-denials-not-observed', complete_audit_available:false,
  enforced:evidence.filter(e=>e.isolation==='enforced').length,unavailable:evidence.filter(e=>e.isolation==='unavailable').length,
  unknown:runs.filter(r=>!r.boundary || r.boundary.isolation==='unknown').length,denied:evidence.reduce((n,e)=>n+e.calls.filter(c=>c.outcome==='denied').length,0) };
}
