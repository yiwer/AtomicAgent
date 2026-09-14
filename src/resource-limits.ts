import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskError, type Run } from './domain.js';
import { effectiveLimits } from './limits.js';
export interface ResourceEvidence {source:'trusted-supervisor:cgroup-v2-and-tmpfs'|'opensandbox:cgroup-v2-observation';observed_at:string;cpu_quota:number;cpu_period:number;memory_bytes:number;workspace_bytes:number;deadline_at:string;memory_events:Record<string,number>}
export function memoryEvents(text:string):Record<string,number>{return Object.fromEntries(text.trim().split('\n').map(line=>{const [key,value]=line.trim().split(/\s+/);return [key,Number(value)];}));}
export function memoryBudgetExceeded(before:Record<string,number>,text:string):boolean {
 const current=memoryEvents(text);
 return ['max','oom','oom_kill'].every(key=>Number.isSafeInteger(current[key])&&current[key]!>before[key]!);
}
export function resourceEvidence(run:Run,value:unknown):ResourceEvidence {
 const v=value as ResourceEvidence,l=effectiveLimits(run);
 if(!v||!['trusted-supervisor:cgroup-v2-and-tmpfs','opensandbox:cgroup-v2-observation'].includes(v.source)||!Number.isFinite(Date.parse(v.observed_at))||Date.parse(v.observed_at)<Date.parse(run.accepted_at)||Date.parse(v.observed_at)>Date.now()+1000||v.deadline_at!==run.manifest.deadline_at||!Number.isSafeInteger(v.cpu_quota)||!Number.isSafeInteger(v.cpu_period)||v.cpu_quota<=0||v.cpu_period<=0||v.cpu_quota/v.cpu_period>l.cpu||v.memory_bytes!==l.memory_mib*1024*1024||v.workspace_bytes!==l.workspace_bytes)throw new TaskError('resource_limits_unavailable');
 const memory_events:Record<string,number>={};for(const key of ['max','oom','oom_kill']){const n=v.memory_events?.[key];if(!Number.isSafeInteger(n)||n!<0)throw new TaskError('resource_limits_unavailable');memory_events[key]=n!;}
 return {source:v.source,observed_at:v.observed_at,cpu_quota:v.cpu_quota,cpu_period:v.cpu_period,memory_bytes:v.memory_bytes,workspace_bytes:v.workspace_bytes,deadline_at:v.deadline_at,memory_events};
}
// This is a sampled termination rule, not a no-overshoot disk quota. The enclosing tmpfs is hard-bounded.
export async function outputBytes(root:string,maximum:number):Promise<number>{
 let size=0,entries=0;
 async function visit(path:string){let items;try{items=await readdir(path,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  for(const item of items){if(++entries>10000)throw new TaskError('budget_exceeded');const pathName=join(path,item.name),stat=await lstat(pathName);if(stat.isSymbolicLink())continue;if(stat.isDirectory())await visit(pathName);else if(stat.isFile())size+=stat.size;if(size>maximum)throw new TaskError('budget_exceeded');}}
 await visit(root);return size;
}
