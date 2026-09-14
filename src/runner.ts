import { outputBytes } from './resource-limits.js';
// Runs only inside the pinned Linux image, never in the API process or developer workspace.
import { readFile, writeFile, open, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runClaude, type ClaudeRequest } from './claude-execution.js';
import { isolatedQuery } from './isolated-query.js';
import { TaskError } from './domain.js';
import type { BoundaryEvidence } from './execution-boundary.js';
import type { CallMeasurement } from './model-gateway.js';
import { UsageSpool, callUsageEntries, providerIdentity, providerTokenUnits, sdkUsageEntries, type UsageEntry, type UsageScope } from './usage.js';
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
 const usage = new UsageSpool({ run_id:request.run_id, attempt_id:request.attempt_id, source:'controlled-runner:usage-ledger' });
 const provider = providerIdentity(request.endpoint, request.model);
 let usageWrites = Promise.resolve();
 // A usage journal failure degrades measurement to unknown; it never ends an otherwise healthy execution.
 const persistUsage = () => {
  const snapshot = JSON.stringify(usage.observation());
  usageWrites = usageWrites.then(async()=>{
   const journal = await open(`${controlRoot}/usage.next`, 'w', 0o600);
   try { await journal.writeFile(snapshot); await journal.sync(); } finally { await journal.close(); }
   await rename(`${controlRoot}/usage.next`,`${controlRoot}/usage.json`);
  }).catch(()=>{});
  return usageWrites;
 };
 const measure = (call: BoundaryEvidence['calls'][number], measurement?: CallMeasurement) => {
  if(call.boundary==='mcp')return; // Registered MCP consumption is owned by the validated MCP evidence.
  const kind = call.boundary==='tool'?'tool':call.boundary==='transport'?'transport':'model';
  const scope: UsageScope = call.boundary==='transport'?'transport':'agent-main';
  const inFlight = call.outcome==='requested'||call.outcome==='started';
  usage.invocation({ invocation_id:call.invocation_id, parent_invocation_id:null, retry_of:null, attempt_id:request.attempt_id, kind, scope,
   target: kind==='model'?provider:kind==='transport'?'engine-connectivity-probe':'registered-tool',
   status:call.outcome, source: kind==='tool'?'controlled-runner:tool-boundary':'platform:model-gateway', observed_at:call.observed_at });
  if(kind==='tool')return; // A local tool call is an observable invocation; it meters no provider unit.
  // Counted on first sighting whatever the outcome: a denied, failed or probe call is still a call.
  for(const entry of callUsageEntries({invocation_id:call.invocation_id,attempt_id:request.attempt_id,scope,provider,source:'platform:model-gateway',observed_at:call.observed_at,in_flight:inFlight})) usage.entry(entry);
  if(inFlight||!measurement)return;
  const shared = { attempt_id:request.attempt_id, invocation_id:call.invocation_id, scope, provider,
   measurement_scope:'invocation' as const, observed_at:call.observed_at, source:'platform:model-gateway', in_flight:false };
  const entry = (suffix:string, unit:UsageEntry['unit'], value:number|null, basis:UsageEntry['basis'], partial=false):UsageEntry =>
   ({ ...shared, entry_id:`${call.invocation_id}:${suffix}`, series:`${call.invocation_id}:${unit}:${basis}`, unit, value,
      basis, reporting:'delta', observation_version:1, in_flight:false,
      completeness: value===null?'unknown':partial?'partial':'complete' });
  usage.entry(entry('request-bytes','request_bytes',measurement.request_bytes,'platform-observed'));
  usage.entry(entry('response-bytes','response_bytes',measurement.response_bytes,'platform-observed',call.outcome!=='completed'));
  // Only a call that actually reached the provider can have provider-confirmed consumption. When it was
  // dispatched but reported no usage, that consumption is unknown — it is never recorded as zero or dropped.
  if(!measurement.dispatched)return;
  for(const unit of providerTokenUnits) {
   const value = measurement.tokens?.[unit];
   usage.entry(entry(`provider-${unit}`,unit,typeof value==='number'?value:null,'provider-confirmed'));
  }
 };
 const pending = new Map<string,BoundaryEvidence['calls'][number]['boundary']>();
 const record = async (event: BoundaryEvidence['calls'][number] & { measurement?: CallMeasurement }) => {
  const { measurement, ...call } = event;
  try {
   if(boundary.calls.length>=128)throw new TaskError('policy_denied');
   boundary.calls.push(call);await persist();
   measure(call,measurement);void persistUsage();
   if(call.outcome==='requested') {
    pending.set(call.invocation_id,call.boundary);
    await waitForPermit(controlRoot,{run_id:request.run_id,attempt_id:request.attempt_id,invocation_id:call.invocation_id},Math.min(Date.parse(request.deadline_at),Date.now()+10000),controller.signal);
   }
   if(['completed','failed','denied'].includes(call.outcome))pending.delete(call.invocation_id);
  }catch(error){controller.abort();throw error;}
 };
 let outcome: Record<string, unknown>;
 try {
  isolation = await isolatedQuery(request, '/workspace', controlRoot, record);
  boundary.isolation = 'enforced'; await persist();
  request.evidence_root = controlRoot;
  request.authorizeAction = async (kind, invocation_id=randomUUID()) => {
   await record({invocation_id,boundary:kind,outcome:'requested',observed_at:new Date().toISOString()});return invocation_id;
  };
  request.finishAction = async(invocation_id,outcome)=>{const kind=pending.get(invocation_id);if(!kind)throw new TaskError('execution_lost');await record({invocation_id,boundary:kind,outcome,observed_at:new Date().toISOString()});};
  request.onDenied = async () => record({invocation_id:randomUUID(),boundary:'tool',outcome:'denied',observed_at:new Date().toISOString()});
  let engineVersion = 0;
  request.observeEngineUsage = async modelUsage => {
   for(const entry of sdkUsageEntries({attempt_id:request.attempt_id,endpoint:request.endpoint,model:request.model,version:++engineVersion,observed_at:new Date().toISOString()},modelUsage)) usage.entry(entry);
   await persistUsage();
  };
  const result = await runClaude(request, '/workspace', isolation.query, controller.signal);
  await isolation.close();
  if(request.limits)await outputBytes('/workspace/output',request.limits.artifact_bytes);
  if(limitFailure)throw new TaskError('budget_exceeded');
  outcome = { ...result, ...(boundary.calls.some(c=>c.outcome==='denied') ? { failure:'policy_denied' } : {}) };
 } catch (error) {
  boundary.isolation = isolation ? 'unknown':'unavailable'; await persist();
  outcome = { failure:limitFailure?'budget_exceeded':error instanceof TaskError ? error.code:'isolation_unavailable' };
 }
 finally { await isolation?.close(); clearInterval(timer);clearInterval(limitsTimer);for(const [invocation_id,kind] of pending)await record({invocation_id,boundary:kind,outcome:'unknown',observed_at:new Date().toISOString()}); await persistUsage(); }
 // Built after the pending-call sweep so an unfinished invocation leaves an unknown ending, not a silent gap.
 return { ...outcome, boundary, usage: usage.observation() };
}
try { await writeFile('/run/atomicagent/result.json', JSON.stringify(await main()), { flag: 'wx', mode: 0o600 }); }
catch { process.exitCode = 1; }
