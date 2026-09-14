import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { fixtureProfile } from '../src/profile.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';

const identities = [{ token:'m'.repeat(40),actor:'operator',workspace:'lab',role:'maintainer' as const },
 {token:'c'.repeat(40),actor:'caller',workspace:'lab',role:'caller' as const},
 {token:'h'.repeat(40),actor:'health',workspace:'lab',role:'health' as const}];
async function lab(t:TestContext,sandbox=new FixtureSandbox()) {
 const directory=await mkdtemp(join(tmpdir(),'atomic-limits-'));
 const options={database:join(directory,'runs.db'),profile:{...fixtureProfile,timeout_seconds:3600},identities,sandbox};
 let app=await createApp(options),url=await app.listen();
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 return {sandbox,async restart(){await app.close();app=await createApp(options);url=await app.listen();},
  async request(path:string,data?:unknown,key='command',token=identities[0]!.token){return fetch(url+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},...(data===undefined?{}:{body:JSON.stringify(data)})});}};
}
const task={prompt:'three apples',profile:'json-lab@1',output_contract:'summary-value@1'};
test('a fresh normal setup uses a new 60 minute profile without mutating the legacy profile',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'atomic-setup-limit-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await promisify(execFile)(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('../scripts/setup-local.ts',import.meta.url))],{cwd:directory});
 const config=JSON.parse(await readFile(join(directory,'.local/config.json'),'utf8'));
 assert.equal(config.profile.id,'json-default@1');assert.equal(config.profile.timeout_seconds,3600);assert.equal(fixtureProfile.timeout_seconds,60);
 const app=await createApp({database:join(directory,'verify.db'),profile:config.profile,identities,sandbox:new FixtureSandbox()});const url=await app.listen();
 try{const response=await fetch(url+'/v1/runs',{method:'POST',headers:{Authorization:`Bearer ${identities[0]!.token}`,'Content-Type':'application/json','Idempotency-Key':'fresh-default'},body:JSON.stringify({...task,profile:'json-default@1'})});const run=await response.json();assert.equal(response.status,202);assert.equal(Date.parse(run.execution.deadline_at)-Date.parse(run.accepted_at),3600000);}finally{await app.close();}
});
test('a tighter input limit rejects admission and a cumulative artifact limit terminates without publishing output',async t=>{
 const l=await lab(t),file=await(await l.request('/v1/files',{format:'csv',content:'id,category,value\na,alpha,3\n'},'upload')).json();
 const input={...task,output_contract:'data-statistics@1',inputs:[{file_id:file.file_id,path:'input/data.csv'}]};
 assert.equal((await l.request('/v1/runs',{...input,limits:{input_bytes:1}},'too-large-input')).status,413);
 const run=await(await l.request('/v1/runs?wait_seconds=5',{...input,limits:{artifact_bytes:1}},'too-large-output')).json();
 assert.equal(run.failure,'budget_exceeded');assert.equal(run.limit_termination.dimension,'artifact_bytes');
 assert.equal((await l.request(`/v1/runs/${run.run_id}/result`)).status,409);
 await waitFor(async()=>(await(await l.request(`/v1/runs/${run.run_id}`)).json()).cleanup.status==='complete');
});
async function waitFor(check:()=>Promise<boolean>){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('observation timeout');}
test('two slots start concurrently; lowering to one preserves existing work and queued deadline expires without an Attempt',async t=>{
 const sandbox=new FixtureSandbox(),base=sandbox.execute.bind(sandbox),releases=new Map<string,()=>void>();
 sandbox.execute=async(run,signal)=>{await new Promise<void>(resolve=>{const timer=setTimeout(resolve,5000);releases.set(run.run_id,()=>{clearTimeout(timer);resolve();});});return base(run,signal);};
 const l=await lab(t,sandbox);t.after(()=>{for(const release of releases.values())release();});
 const submit=async(key:string,limits?:unknown)=>(await(await l.request('/v1/runs',{...task,...(limits?{limits}:{})},key)).json()).run_id as string;
 const a=await submit('a'),b=await submit('b');
 await waitFor(async()=>releases.size===2);
 const initial=await(await l.request('/v1/limits')).json(),command={expected_revision:1,values:{...initial.current.values,concurrency:1},reason:'Reduce slots'};
 const preview=await(await l.request('/v1/limits/preview',command)).json();
 assert.equal((await l.request('/v1/limits/commands',{...command,preview_digest:preview.preview_digest})).status,200);
 const c=await submit('c',{total_timeout_seconds:1});
 await waitFor(async()=>(await(await l.request(`/v1/runs/${c}`)).json()).status==='timed_out');
 assert.equal((await(await l.request(`/v1/runs/${c}`)).json()).attempt_id,null);
 for(const id of [a,b])assert.equal((await(await l.request(`/v1/runs/${id}`)).json()).status,'running');
 const d=await submit('d');releases.get(a)!();
 await waitFor(async()=>(await(await l.request(`/v1/runs/${a}`)).json()).cleanup.status==='complete');
 assert.equal((await(await l.request(`/v1/runs/${d}`)).json()).status,'queued');
 releases.get(b)!();await waitFor(async()=>releases.has(d));releases.get(d)!();
});
test('limits are reviewed, published once, restored and frozen into new Runs; unsupported money is refused',async t=>{
 const l=await lab(t);
 const response=await l.request('/v1/limits');assert.equal(response.status,200);
 const initial=await response.json();
 for(const extra of ['constructor','toString','__proto__']){
  const malformed=JSON.parse(JSON.stringify(initial.current.values));delete malformed.cpu;Object.defineProperty(malformed,extra,{value:1,enumerable:true});
  assert.equal((await l.request('/v1/limits/preview',{expected_revision:1,values:malformed,reason:'Invalid own fields'})).status,400);
 }
 assert.deepEqual(initial.current.values,{concurrency:2,total_timeout_seconds:3600,input_bytes:52428800,artifact_bytes:104857600,cpu:2,memory_mib:4096});
 const old=await(await l.request('/v1/runs?wait_seconds=5',task,'old')).json();
 const command={expected_revision:1,values:{...initial.current.values,concurrency:1,total_timeout_seconds:30},reason:'Short tasks'};
 const preview=await(await l.request('/v1/limits/preview',command)).json();assert.ok(preview.preview_digest,JSON.stringify(preview));
 const body={...command,preview_digest:preview.preview_digest};
 const receipt=await(await l.request('/v1/limits/commands',body)).json();assert.equal(receipt.revision,2);
 await l.restart();
 assert.deepEqual(await(await l.request('/v1/limits/commands',body)).json(),receipt);
 assert.equal((await l.request('/v1/limits/commands',{...body,reason:'changed'})).status,409);
 assert.equal((await l.request('/v1/limits/preview',command,'caller',identities[1]!.token)).status,403);
 assert.equal((await l.request('/v1/limits',undefined,'health',identities[2]!.token)).status,403);
 const next=await(await l.request('/v1/runs?wait_seconds=5',task,'new')).json();
 assert.equal(next.execution.limits.total_timeout_seconds,30);assert.equal(next.execution.limits.policy_revision,2);
 assert.deepEqual((await(await l.request(`/v1/runs/${old.run_id}`)).json()).execution,old.execution);
 const money=await l.request('/v1/runs',{...task,limits:{max_cost_usd:1}},'money');assert.equal(money.status,422);assert.equal((await money.json()).error,'hard_money_limit_unsupported');
});


