import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';
import { DatabaseSync } from 'node:sqlite';
import { DiskBlobs, type BlobPort } from '../src/blob-store.js';
const identities = ['caller', 'caller', 'maintainer', 'health', 'maintainer'].map((role, i) => ({ role: role as 'caller'|'maintainer'|'health', actor: `actor-${i}`, workspace: i === 4 ? 'other' : 'lab', token: String(i).repeat(40) }));
const task = { prompt: 'Return three apples.', profile: 'json-lab@1', output_contract: 'summary-value@1' };
export async function until<T>(read: () => Promise<T>, matches: (v: T) => boolean): Promise<T> {
  for (let i=0;i<300;i++) { const v = await read(); if (matches(v)) return v; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('observation did not settle');
}
async function lab(t: TestContext, sandbox = new FixtureSandbox(), cancellationClock?: () => number, storage?: (directory: string) => BlobPort) {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-cancel-'));
  const options = { database: join(directory,'runs.db'), profile: fixtureProfile, sandbox, identities, cancellationClock, blobs: storage?.(directory) };
  let app = await createApp(options), url = await app.listen();
  t.after(async()=>{ await app.close(); await rm(directory,{recursive:true,force:true}); });
  return { sandbox, directory,
    restart: async()=>{ await app.close(); app=await createApp(options); url=await app.listen(); },
    request: (path: string, method='GET', value?: unknown, actor=0, extra: Record<string,string>={}) => fetch(url+path,{method,headers:{Authorization:`Bearer ${identities[actor]!.token}`,'Content-Type':'application/json',...extra},...(value===undefined?{}:{body:JSON.stringify(value)})}),
    submit: async(key: string,value:unknown=task)=> (await fetch(url+'/v1/runs',{method:'POST',headers:{Authorization:`Bearer ${identities[0]!.token}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(value)})).json(),
  };
}
test('queued cancellation is atomic, repeatable, authorized and persists without an Attempt or sandbox', async t=>{
  const sandbox = new FixtureSandbox(); let release!: ()=>void;
  const execute = sandbox.execute.bind(sandbox);
  sandbox.execute = async(...args)=>{await new Promise<void>(r=>release=r); return execute(...args);};
  const l=await lab(t,sandbox); t.after(()=>release?.()); setTimeout(()=>release?.(),1000);
  await l.submit('blocker'); await until(async()=>!!release,Boolean);
  const {run_id}=await l.submit('queued'); const path=`/v1/runs/${run_id}:cancel`;
  for (const actor of [1,3,4]) assert.ok([403,404].includes((await l.request(path,'POST',{},actor)).status));
  const response=await l.request(path,'POST',{}); assert.equal(response.status,200);
  const receipt=await response.json(); assert.equal(receipt.cancellation.decision,'accepted');
  assert.equal(receipt.status,'cancelled'); assert.equal(receipt.attempt_id,null); assert.equal(receipt.stop.status,'not_started'); assert.equal(receipt.cleanup.status,'complete');
  assert.deepEqual((await (await l.request(path,'POST',{})).json()).cancellation,receipt.cancellation);
  release(); await l.restart();
  const run=await (await l.request(`/v1/runs/${run_id}`)).json(); assert.equal(run.status,'cancelled'); assert.equal(run.attempt_id,null);
  assert.equal(sandbox.executions.size,1);
});
test('a cancellation during a lost preparation receipt retains cleanup until the late resource is verified gone', async t=>{
  const sandbox=new FixtureSandbox(); let prepared!: (id: string)=>void; const deleted: string[]=[];
  sandbox.prepare=async()=>new Promise(r=>prepared=r);
  sandbox.cleanup=async run=>{if(run.allocation?.resource_id) deleted.push(run.allocation.resource_id); return 'absent';};
  const l=await lab(t,sandbox); const {run_id}=await l.submit('preparing'); await until(async()=>!!prepared,Boolean);
  await l.request(`/v1/runs/${run_id}:cancel`,'POST',{});
  const unknown=await until(async()=> (await l.request(`/v1/runs/${run_id}`)).json(),r=>r.cleanup.status==='unknown');
  assert.equal(unknown.stop.status,'not_started'); assert.equal(unknown.attempt_id,null);
  prepared('late-owned-resource');
  const run=await until(async()=> (await l.request(`/v1/runs/${run_id}`)).json(),r=>r.cleanup.status==='complete');
  assert.equal(run.status,'cancelled'); assert.equal(run.attempt_id,null); assert.ok(deleted.includes('late-owned-resource'));
  await l.restart(); assert.equal(sandbox.executions.size,0);
});
test('success wins an earlier commit and a late cancellation remains a stable already-terminal receipt',async t=>{
  const l=await lab(t); const {run_id}=await l.submit('success');
  await until(async()=> (await l.request(`/v1/runs/${run_id}`)).json(),r=>r.status==='succeeded');
  const path=`/v1/runs/${run_id}:cancel`;
  const run=await (await l.request(path,'POST',{},2)).json(); assert.equal(run.status,'succeeded'); assert.equal(run.cancellation.decision,'already_terminal'); assert.equal(run.stop,null);
  assert.deepEqual((await (await l.request(path,'POST',{})).json()).cancellation,run.cancellation);
  assert.equal((await l.request(`/v1/runs/${run_id}/result`)).status,200);
  assert.equal((await l.request(path,'POST',{},0,{'X-Cancellation-Actor':'actor-2','X-Cancellation-Workspace':'lab'})).status,403);
});
test('executing cancellation waits 30 seconds, force-stops the owned execution, and never treats a late result as success', async t=>{
  let clock=Date.now(), finish!: (v: unknown)=>void, forced=0;
  const sandbox=new FixtureSandbox();
  sandbox.execute=async()=>new Promise(r=>finish=r);
  Object.assign(sandbox,{ forceStop: async()=>{forced++; return 'stopped';} });
  const l=await lab(t,sandbox,()=>clock); const {run_id}=await l.submit('running');
  await until(async()=>!!finish,Boolean); setTimeout(()=>finish({summary: 'late',value:4}),2000);
  const response=await l.request(`/v1/runs/${run_id}:cancel`,'POST',{},2); assert.equal(response.status,200);
  const run=await response.json(); assert.equal(run.stop.status,'pending'); assert.equal(run.cleanup.status,'pending');
  assert.equal(Date.parse(run.cancellation.grace_deadline_at)-Date.parse(run.cancellation.requested_at),30000);
  clock+=29999; await new Promise(r=>setTimeout(r,300)); assert.equal(forced,0);
  clock++; const stopped=await until(async()=> (await l.request(`/v1/runs/${run_id}`)).json(),r=>r.stop?.status==='stopped');
  assert.ok(stopped.stop.forced_at); assert.equal(forced,1);
  finish({summary:'late success',value:4});
  const settled=await until(async()=> (await l.request(`/v1/runs/${run_id}`)).json(),r=>r.cleanup.status==='complete');
  assert.equal(settled.status,'cancelled'); assert.equal((await l.request(`/v1/runs/${run_id}/result`)).status,409);
});
test('unknown stop retains the slot and cleanup obligation, backs off, and resumes from durable intent after restart',async t=>{
  let clock=Date.now(), started=false, gone=false, forced=0;
  const sandbox=new FixtureSandbox();
  sandbox.execute=async()=>{ if(started)return {summary:'next',value:2}; started=true; return new Promise(()=>{}); };
  sandbox.forceStop=async()=>{forced++;return gone?'stopped':'unknown';};
  const l=await lab(t,sandbox,()=>clock); const {run_id}=await l.submit('unknown'); await until(async()=>started,Boolean);
  await l.request(`/v1/runs/${run_id}:cancel`,'POST',{}); clock+=30000;
  const read=async()=> (await l.request(`/v1/runs/${run_id}`)).json();
  const unknown=await until(read,r=>r.stop?.status==='unknown'); assert.equal(unknown.cleanup.status,'pending'); assert.equal(unknown.stop.checks,1);
  await new Promise(r=>setTimeout(r,600)); assert.equal(forced,1);
  const second=await l.submit('next'); assert.equal((await (await l.request(`/v1/runs/${second.run_id}`)).json()).status,'queued');
  const health=await (await l.request('/internal/health','GET',undefined,3)).json(); assert.equal(health.cancellation.unknown,1); assert.equal(JSON.stringify(health).includes(run_id),false);
  gone=true;clock+=1001;await l.restart();
  await until(read,r=>r.stop?.status==='stopped'&&r.cleanup.status==='complete');
  await until(async()=> (await l.request(`/v1/runs/${second.run_id}`)).json(),r=>r.status==='succeeded');
});
test('cancel intent storage failure never acknowledges acceptance but preserves a bounded independent forced-stop path',async t=>{
  let clock=Date.now(), started=false, forced=0;
  const sandbox=new FixtureSandbox();sandbox.execute=async()=>{started=true;return new Promise(()=>{});};sandbox.forceStop=async()=>{forced++;return 'stopped';};
  const l=await lab(t,sandbox,()=>clock);const {run_id}=await l.submit('write-fault');await until(async()=>started,Boolean);
  const db=new DatabaseSync(join(l.directory,'runs.db'));
  db.exec("CREATE TRIGGER cancel_fault BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET'); END;");
  const response=await l.request(`/v1/runs/${run_id}:cancel`,'POST',{});assert.equal(response.status,503);assert.equal(JSON.stringify(await response.json()).includes('SYNTHETIC_SECRET'),false);
  clock+=30000;await until(async()=>forced,n=>n===1);assert.equal(sandbox.resources.size,0);
  db.exec('DROP TRIGGER cancel_fault');db.close();clock+=1001;
  await until(async()=> (await l.request(`/v1/runs/${run_id}`)).json(),r=>r.stop?.status==='stopped'&&r.cleanup.status==='complete');
  await l.restart();const run=await (await l.request(`/v1/runs/${run_id}`)).json();assert.equal(run.cancellation,null);assert.equal(run.status,'failed');assert.equal(run.failure,'execution_lost');
});
test('cancelled execution is disposed even when stop observation writes fail, then reconciles truthful observations',async t=>{
  let clock=Date.now(),started=false,forced=0;
  const sandbox=new FixtureSandbox();sandbox.execute=async()=>{started=true;return new Promise(()=>{});};sandbox.forceStop=async()=>{forced++;return 'stopped';};
  const l=await lab(t,sandbox,()=>clock);const {run_id}=await l.submit('observation-fault');await until(async()=>started,Boolean);
  await l.request(`/v1/runs/${run_id}:cancel`,'POST',{});
  const db=new DatabaseSync(join(l.directory,'runs.db'));db.exec("CREATE TRIGGER observation_fault BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET'); END;");
  clock+=30000;await until(async()=>forced,n=>n===1);assert.equal(sandbox.resources.size,0);
  assert.equal((await (await l.request(`/v1/runs/${run_id}`)).json()).stop.status,'pending');
  db.exec('DROP TRIGGER observation_fault');db.close();clock+=1001;
  await until(async()=> (await l.request(`/v1/runs/${run_id}`)).json(),r=>r.stop?.status==='stopped'&&r.cleanup.status==='complete');
});
test('input copying that finishes after cancellation cannot start an Attempt or leave a reclaimed-directory claim',async t=>{
  const sandbox=new FixtureSandbox();let release!:()=>void;
  const copy=sandbox.loadInputs.bind(sandbox);sandbox.loadInputs=async(...args)=>{await new Promise<void>(r=>release=r);await copy(...args);};
  const l=await lab(t,sandbox);
  const file=await (await l.request('/v1/files','POST',{format:'csv',content:'id,category,value\na,fruit,3\n'})).json();
  const {run_id}=await l.submit('copy',{...task,output_contract:'data-statistics@1',inputs:[{file_id:file.file_id,path:'input/data.csv'}]});
  await until(async()=>!!release,Boolean);await l.request(`/v1/runs/${run_id}:cancel`,'POST',{});
  const read=async()=> (await l.request(`/v1/runs/${run_id}`)).json();
  await until(read,r=>r.cleanup.status==='unknown');release();
  const run=await until(read,r=>r.cleanup.status==='complete');assert.equal(run.attempt_id,null);assert.equal(run.inputs[0].loaded,false);assert.equal(sandbox.directories.size,0);assert.equal(sandbox.executions.size,0);
});
test('artifact transfer finishing after cancellation is discarded and cannot publish a Result or available Artifact',async t=>{
  let clock=Date.now(),release!:()=>void,writes=0,artifact='';const removed:string[]=[];
  const l=await lab(t,new FixtureSandbox(),()=>clock,directory=>{
    const disk=new DiskBlobs(join(directory,'blobs'));
    return {read:disk.read.bind(disk),remove:async id=>{await disk.remove(id);removed.push(id);},write:async(id,bytes)=>{await disk.write(id,bytes);if(++writes===2){artifact=id;await new Promise<void>(r=>release=r);}}};
  });
  const file=await (await l.request('/v1/files','POST',{format:'csv',content:'id,category,value\na,fruit,3\n'})).json();
  const {run_id}=await l.submit('stage',{...task,output_contract:'data-statistics@1',inputs:[{file_id:file.file_id,path:'input/data.csv'}]});
  await until(async()=>!!release,Boolean);await l.request(`/v1/runs/${run_id}:cancel`,'POST',{});release();clock+=30000;
  const run=await until(async()=> (await l.request(`/v1/runs/${run_id}`)).json(),r=>r.stop?.status==='stopped'&&r.cleanup.status==='complete');
  await until(async()=>removed.includes(artifact),Boolean);assert.equal(run.status,'cancelled');assert.equal((await l.request(`/v1/runs/${run_id}/result`)).status,409);
  assert.equal((await (await l.request(`/v1/artifacts/${artifact}`)).json()).status,'removed');
  assert.equal((await l.request(`/v1/artifacts/${artifact}/download-link`,'POST',{})).status,409);
});
