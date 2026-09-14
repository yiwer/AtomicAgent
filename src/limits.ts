import { ApiError, now, type Identity, type Profile, type Run } from './domain.js';
import type { Store } from './store.js';
import { contentDigest } from './submission.js';

export const limitRanges = {
 concurrency:{min:1,max:2,step:1},total_timeout_seconds:{min:1,max:3600,step:1},
 input_bytes:{min:1,max:52428800,step:1},artifact_bytes:{min:1,max:104857600,step:1},
 cpu:{min:0.25,max:2,step:0.25},memory_mib:{min:128,max:4096,step:1},
} as const;
export const defaultLimits={concurrency:2,total_timeout_seconds:3600,input_bytes:52428800,artifact_bytes:104857600,cpu:2,memory_mib:4096};
export type LimitValues=typeof defaultLimits;
export interface ExecutionLimits extends LimitValues {policy_revision:number;workspace_bytes:number;pids:128}
interface Revision {revision:number;values:LimitValues;published_at:string;actor:string;reason:string}
interface State {revisions:Revision[]}
const stateKey=(workspace:string)=>`limits:${workspace}`;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'invalid_limits');return value as Record<string,unknown>;}
function values(value:unknown,partial=false):Partial<LimitValues>{
 const input=object(value);
 if(Object.keys(input).some(k=>/(?:cost|money|usd|^currency$)/i.test(k)))throw new ApiError(422,'hard_money_limit_unsupported');
 if(Object.keys(input).some(k=>!Object.hasOwn(limitRanges,k))||(!partial&&Object.keys(limitRanges).some(k=>!Object.hasOwn(input,k))))throw new ApiError(400,'invalid_limits');
 for(const [key,value] of Object.entries(input)){const range=limitRanges[key as keyof LimitValues];if(typeof value!=='number'||!Number.isFinite(value)||value<range.min||value>range.max||Math.abs(value/range.step-Math.round(value/range.step))>1e-8)throw new ApiError(400,'limit_outside_registered_range');}
 return input as Partial<LimitValues>;
}
export function effectiveLimits(run:Run):ExecutionLimits{return run.manifest.limits??{...defaultLimits,total_timeout_seconds:run.manifest.profile.timeout_seconds,policy_revision:0,workspace_bytes:190840832,pids:128};}
export function executionSlotHeld(run:Run,active=false):boolean{return active||run.status==='running'||Boolean(run.allocation&&run.cleanup.status!=='complete')||Boolean(run.stop&&!['stopped','not_started'].includes(run.stop.status));}
export class Limits {
 constructor(private store:Store,workspaces:string[]){for(const workspace of workspaces)if(!store.configurationState(stateKey(workspace)))store.transaction(()=>{store.saveConfigurationState(stateKey(workspace),{revisions:[{revision:1,values:defaultLimits,published_at:now(),actor:'platform',reason:'Registered v0 defaults'}]});store.audit('platform',workspace,'limits.register','default');});}
 private state(workspace:string){return this.store.configurationState(stateKey(workspace)) as State;}
 current(workspace:string){return this.state(workspace).revisions.at(-1)!;}
 list(workspace:string){return {current:this.current(workspace),history:this.state(workspace).revisions,ranges:limitRanges,global_capacity:2,hard_money:'unsupported',source:'platform:durable-limit-revisions',observed_at:now()};}
 resolve(workspace:string,profile:Profile,input:unknown):ExecutionLimits {
  const current=this.current(workspace),requested=input===undefined?{}:values(input,true);
  if('concurrency' in requested)throw new ApiError(400,'concurrency_is_scheduler_policy');
  for(const [key,value] of Object.entries(requested))if(value>current.values[key as keyof LimitValues])throw new ApiError(400,'limit_exceeds_policy');
  const effective={...current.values,...requested,total_timeout_seconds:Math.min(requested.total_timeout_seconds??current.values.total_timeout_seconds,profile.timeout_seconds)};
  return {...effective,policy_revision:current.revision,workspace_bytes:effective.input_bytes+effective.artifact_bytes+33554432,pids:128};
 }
 private command(value:unknown){const input=object(value);if(Object.keys(input).some(k=>!['expected_revision','values','reason','preview_digest'].includes(k))||!Number.isSafeInteger(input.expected_revision)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>300)throw new ApiError(400,'invalid_limits');return {expected_revision:input.expected_revision as number,values:values(input.values) as LimitValues,reason:input.reason};}
 preview(identity:Identity,input:unknown){if(identity.role!=='maintainer')throw new ApiError(403,'forbidden');const command=this.command(input),current=this.current(identity.workspace);if(command.expected_revision!==current.revision)throw new ApiError(409,'limits_revision_conflict');return {...command,preview_digest:contentDigest({workspace:identity.workspace,actor:identity.actor,...command}),changes:Object.keys(limitRanges).filter(k=>current.values[k as keyof LimitValues]!==command.values[k as keyof LimitValues]).map(field=>({field,before:current.values[field as keyof LimitValues],after:command.values[field as keyof LimitValues]})),impact:{new_runs:'New Runs freeze this revision; registered environment may impose a shorter deadline.',scheduling:'Lower concurrency prevents subsequent starts; existing executions retain slots until disposal is observed.',existing_manifests:'unchanged',global_capacity:2}};}
 execute(identity:Identity,input:unknown,key:string){if(identity.role!=='maintainer')throw new ApiError(403,'forbidden');const digest=contentDigest(input),commandKey=`limits:${key}`;return this.store.transaction(()=>{const prior=this.store.configurationCommand(identity.workspace,identity.actor,commandKey);if(prior){if(prior.digest!==digest)throw new ApiError(409,'limits_command_conflict');return prior.receipt;}const preview=this.preview(identity,input);if(object(input).preview_digest!==preview.preview_digest)throw new ApiError(409,'limits_preview_required');const state=this.state(identity.workspace),revision={revision:preview.expected_revision+1,values:preview.values,published_at:now(),actor:identity.actor,reason:preview.reason};state.revisions.push(revision);this.store.saveConfigurationState(stateKey(identity.workspace),state);this.store.audit(identity.actor,identity.workspace,'limits.publish','applied',null,{source:'platform:durable-limits',resource_id:`limits:${revision.revision}`,operation_id:key,observed_at:revision.published_at});this.store.saveConfigurationCommand(identity.workspace,identity.actor,commandKey,digest,revision);return revision;});}
 observation(workspace:string,runs:Run[],activeIds:ReadonlySet<string>=new Set()){const queried_at=now(),active=runs.filter(r=>executionSlotHeld(r,activeIds.has(r.run_id)));return {source:'platform:durable-limits-and-resource-observations',queried_at,observed_at:queried_at,freshness:'fresh-record-projection',coverage:'recorded-state; independent-guardian-health-separate',policy_revision:this.current(workspace).revision,concurrency:this.current(workspace).values.concurrency,global_capacity:2,occupied:active.length,queued:runs.filter(r=>r.status==='queued').length,deadline_exceeded:runs.filter(r=>r.failure==='deadline_exceeded').length,budget_exceeded:runs.filter(r=>r.failure==='budget_exceeded').length,overdue_unresolved:active.filter(r=>Date.parse(r.manifest.deadline_at)<=Date.now()).length};}
}
