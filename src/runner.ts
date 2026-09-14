import { outputBytes } from './resource-limits.js';
// Runs only inside the pinned Linux image, never in the API process or developer workspace.
import { readFile, writeFile, open, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runClaude, type ClaudeRequest } from './claude-execution.js';
import { isolatedQuery } from './isolated-query.js';
import { TaskError } from './domain.js';
import type { BoundaryEvidence } from './execution-boundary.js';
import { waitForPermit } from './action-permit.js';
async function main() {
 const request = JSON.parse(await readFile('/run/atomicagent/request.json', 'utf8')) as ClaudeRequest;
 const marker = await open('/run/atomicagent-attempt.started', 'wx', 0o600);
 await marker.writeFile(request.attempt_id); await marker.sync(); await marker.close();
 if (process.versions.node !== '24.18.0') return { failure: 'runtime_failed' };
 const controller = new AbortController();
 const check = async () => {
  try { const marker = JSON.parse(await readFile('/run/atomicagent-cancel.json', 'utf8'));
   if (marker.run_id === request.run_id && marker.attempt_id === request.attempt_id) controller.abort();
  } catch { /* A missing marker is not cancellation; forced provider disposal remains independent. */ }
 };
 await check();
 await writeFile('/workspace/request.json', JSON.stringify({ input_path:request.input_path, format:(request as ClaudeRequest & {format?:string}).format }), { flag:'wx', mode:0o444 });
 const timer = setInterval(() => void check(), 200);
 let limitFailure=false,checking=false;
 const limitsTimer=setInterval(()=>{if(checking||!request.limits)return;checking=true;void outputBytes('/workspace/output',request.limits.artifact_bytes).catch(()=>{limitFailure=true;controller.abort(new TaskError('budget_exceeded'));}).finally(()=>{checking=false;});},100);
 const controlRoot = '/run/atomicagent'; await mkdir(controlRoot, { mode:0o700, recursive:true });
 const boundary: BoundaryEvidence = { run_id:request.run_id,attempt_id:request.attempt_id,source:'controlled-runner:namespace-and-gateway',observed_at:new Date().toISOString(),isolation:'unknown',audit_coverage:'partial',calls:[] };
 let journalWrites = Promise.resolve();
 const persist = () => {
  boundary.observed_at = new Date().toISOString();
  const snapshot = JSON.stringify(boundary);
  journalWrites = journalWrites.then(async()=>{
   const journal = await open(`${controlRoot}/boundary.next`, 'w', 0o600);
   try { await journal.writeFile(snapshot); await journal.sync(); }
   finally { await journal.close(); }
   await rename(`${controlRoot}/boundary.next`,`${controlRoot}/boundary.json`);
  });
  return journalWrites;
 };
 let isolation: Awaited<ReturnType<typeof isolatedQuery>> | undefined;
 const pending = new Map<string,BoundaryEvidence['calls'][number]['boundary']>();
 const record = async (event: BoundaryEvidence['calls'][number]) => {
  try {
   if(boundary.calls.length>=128)throw new TaskError('policy_denied');
   boundary.calls.push(event);await persist();
   if(event.outcome==='requested') {
    pending.set(event.invocation_id,event.boundary);
    await waitForPermit(controlRoot,{run_id:request.run_id,attempt_id:request.attempt_id,invocation_id:event.invocation_id},Math.min(Date.parse(request.deadline_at),Date.now()+10000),controller.signal);
   }
   if(['completed','failed','denied'].includes(event.outcome))pending.delete(event.invocation_id);
  }catch(error){controller.abort();throw error;}
 };
 try {
  isolation = await isolatedQuery(request, '/workspace', controlRoot, record);
  boundary.isolation = 'enforced'; await persist();
  request.evidence_root = controlRoot;
  request.authorizeAction = async (kind, invocation_id=randomUUID()) => {
   await record({invocation_id,boundary:kind,outcome:'requested',observed_at:new Date().toISOString()});return invocation_id;
  };
  request.finishAction = async(invocation_id,outcome)=>{const kind=pending.get(invocation_id);if(!kind)throw new TaskError('execution_lost');await record({invocation_id,boundary:kind,outcome,observed_at:new Date().toISOString()});};
  request.onDenied = async () => record({invocation_id:randomUUID(),boundary:'tool',outcome:'denied',observed_at:new Date().toISOString()});
  const result = await runClaude(request, '/workspace', isolation.query, controller.signal);
  await isolation.close();
  if(request.limits)await outputBytes('/workspace/output',request.limits.artifact_bytes);
  if(limitFailure)throw new TaskError('budget_exceeded');
  return { ...result, ...(boundary.calls.some(c=>c.outcome==='denied') ? { failure:'policy_denied' } : {}), boundary };
 } catch (error) {
  boundary.isolation = isolation ? 'unknown':'unavailable'; await persist();
  return { failure:limitFailure?'budget_exceeded':error instanceof TaskError ? error.code:'isolation_unavailable',boundary };
 }
 finally { await isolation?.close(); clearInterval(timer);clearInterval(limitsTimer);for(const [invocation_id,kind] of pending)await record({invocation_id,boundary:kind,outcome:'unknown',observed_at:new Date().toISOString()}); }
}
try { await writeFile('/run/atomicagent/result.json', JSON.stringify(await main()), { flag: 'wx', mode: 0o600 }); }
catch { process.exitCode = 1; }
