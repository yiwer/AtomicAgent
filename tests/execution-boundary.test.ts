import type { SandboxPort } from '../src/domain.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { processData } from '../src/process-data.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelGateway } from '../src/model-gateway.js';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';
import { randomUUID } from 'node:crypto';
import type { BoundaryEvidence, ObserveBoundary } from '../src/execution-boundary.js';

test('model gateway constrains raw HTTP to one model operation, never follows redirect and revokes on close', async t => {
 const root = await mkdtemp(join(tmpdir(), 'atomic-gateway-'));
 const calls: { url: string; method: string; token: string }[] = [];
 let status=302;
 const receiver = createServer((req, res) => { calls.push({ url: req.url!, method: req.method!, token: String(req.headers['x-api-key']) }); res.writeHead(status, { location: '/business-write' }); res.end(); });
 await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r));
 const address = receiver.address() as { port: number };
 const socket = process.platform === 'win32' ? `\\\\.\\pipe\\atomic-${Date.now()}` : join(root, 'gateway.sock');
 const events: string[] = [];
 const gateway = new ModelGateway({ endpoint: `http://127.0.0.1:${address.port}`, model: 'approved-model', token: 'CANARY_PRIVATE_MODEL_TOKEN', deadline: Date.now()+30000 }, async event => { events.push(event.outcome); });
 await gateway.listen(socket);
 t.after(async () => { await gateway.close(); await new Promise<void>(r => receiver.close(() => r())); await rm(root, { recursive: true, force: true }); });
 const call = (method: string, path: string, body: unknown) => new Promise<number>((resolve, reject) => { const req = request({ socketPath: socket, method, path, headers: { 'content-length': Buffer.byteLength(JSON.stringify(body)) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.on('error', reject); req.end(JSON.stringify(body)); });
 for (const [method,path,body] of [['POST','/business-write',{}], ['GET','/v1/messages',{}], ['POST','https://other.invalid/v1/messages',{}], ['POST','/v1/messages',{model:'other'}],['POST','/v1/messages',{model:'approved-model',mcp_servers:[{url:'https://other.invalid'}]}],['POST','/v1/messages',{model:'approved-model',tools:[{name:'web',type:'web_search_20250305'}]}]] as const) assert.equal(await call(method,path,body),403);
 assert.equal(await call('HEAD','/api/hello',{}),204);
 assert.equal(await call('POST','/v1/messages',{model:'approved-model',messages:[{role:'user',content:[{type:'image',source:{type:'url',url:'https://unapproved.invalid/image'}}]}]}),403);
 assert.equal(calls.length,0);
 assert.equal(await call('POST','/v1/messages',{model:'approved-model',messages:[],max_tokens:10}),502);
 assert.deepEqual(calls,[{url:'/v1/messages',method:'POST',token:'CANARY_PRIVATE_MODEL_TOKEN'}]);
 assert.ok(events.includes('denied')); assert.ok(events.includes('failed'));
 status=429;assert.equal(await call('POST','/v1/messages',{model:'approved-model',messages:[],max_tokens:10}),429);assert.deepEqual(events.slice(-3),['requested','started','failed']);
 await gateway.close(); await assert.rejects(call('POST','/v1/messages',{model:'approved-model'}));
});

test('parallel action admissions survive older snapshots and duplicate outcomes; cancellation rejects every new intent',async t=>{
 const root=await mkdtemp(join(tmpdir(),'atomic-admission-'));const sandbox:SandboxPort=new FixtureSandbox();
 let observe!:ObserveBoundary,base!:BoundaryEvidence,release!:()=>void;
 sandbox.execute=async(run,_signal,_skills,_mcp,boundary)=>{
  observe=boundary!;base={run_id:run.run_id,attempt_id:run.attempt_id!,source:'controlled-runner:namespace-and-gateway',observed_at:new Date().toISOString(),isolation:'enforced',audit_coverage:'partial',calls:[]};
  await new Promise<void>(r=>release=r);return {summary:'late',value:3};
 };
 const app=await createApp({database:join(root,'runs.db'),profile:fixtureProfile,sandbox,identities:[{token:'a'.repeat(40),actor:'a',workspace:'lab',role:'caller'}]});const url=await app.listen();
 t.after(async()=>{release?.();await app.close();await rm(root,{recursive:true,force:true});});
 const call=(path:string,body?:unknown)=>fetch(url+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${'a'.repeat(40)}`,'Content-Type':'application/json','Idempotency-Key':'admission'},...(body?{body:JSON.stringify(body)}:{})});
 const run=await(await call('/v1/runs',{prompt:'parallel',profile:fixtureProfile.id,output_contract:'summary-value@1'})).json();
 for(let i=0;i<200&&!observe;i++)await new Promise(r=>setTimeout(r,10));assert.ok(observe);
 const first={invocation_id:randomUUID(),boundary:'model' as const,outcome:'requested' as const,observed_at:base.observed_at};
 const second={...first,invocation_id:randomUUID(),boundary:'mcp' as const};
 observe({...base,calls:[first]});observe({...base,calls:[first,second]});
 observe({...base,calls:[{...second,outcome:'completed'}]});observe({...base,calls:[{...first,outcome:'completed'}]});
 observe({...base,calls:[first]});
 const third={...first,invocation_id:randomUUID()};observe({...base,calls:[third]});
 const before=await(await call('/v1/runs/'+run.run_id)).json();assert.equal(before.boundary.calls.length,8);assert.equal(before.boundary.calls.filter((c:{outcome:string})=>c.outcome==='admitted').length,3);assert.equal(before.boundary.calls.some((c:{outcome:string})=>c.outcome==='started'),false);
 assert.equal((await call(`/v1/runs/${run.run_id}:cancel`,{})).status,200);
 const cancelled=await(await call('/v1/runs/'+run.run_id)).json();assert.equal(cancelled.boundary.call_results.find((c:{invocation_id:string})=>c.invocation_id===third.invocation_id).outcome,'unknown');
 assert.throws(()=>observe({...base,calls:[{...first,invocation_id:randomUUID()},{...third,outcome:'failed'}]}),/execution_lost/);
 const mixed=await(await call('/v1/runs/'+run.run_id)).json();assert.equal(mixed.boundary.calls.at(-1).outcome,'failed');assert.equal(mixed.boundary.calls.at(-1).invocation_id,third.invocation_id);assert.equal(mixed.boundary.calls.length,9);
 observe({...base,calls:[{...third,outcome:'failed'}]});
 const after=await(await call('/v1/runs/'+run.run_id)).json();assert.equal(after.status,'cancelled');assert.deepEqual(after.boundary.calls.slice(0,8),before.boundary.calls);assert.equal(after.boundary.calls.at(-1).outcome,'failed');release();
});

test('file processor refuses an input directory symlink to material outside its task', async t => {
 const root=await mkdtemp(join(tmpdir(),'atomic-path-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'task'));await mkdir(join(root,'outside'));
 await writeFile(join(root,'outside/data.csv'),'id,category,value\n1,a,3\n');
 await writeFile(join(root,'task/request.json'),JSON.stringify({input_path:'input/data.csv',format:'csv'}));
 await symlink(join(root,'outside'),join(root,'task/input'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(processData(join(root,'task')));
});

test('a denied task has one durable failure despite a successful adapter candidate; repeat and other caller cannot bypass it',async t=>{
 const root=await mkdtemp(join(tmpdir(),'atomic-denied-'));const sandbox:SandboxPort=new FixtureSandbox();let starts=0;
 sandbox.execute=async(run,_signal,_skills,_mcp,boundary)=>{starts++;boundary?.({run_id:run.run_id,attempt_id:run.attempt_id!,source:'controlled-runner:namespace-and-gateway',observed_at:new Date().toISOString(),isolation:'enforced',audit_coverage:'partial',calls:[{invocation_id:randomUUID(),boundary:'tool',outcome:'denied',observed_at:new Date().toISOString()}]});return {summary:'claimed success',value:3};};
 const identities=[{token:'a'.repeat(40),actor:'a',workspace:'lab',role:'caller' as const},{token:'b'.repeat(40),actor:'b',workspace:'lab',role:'caller' as const},{token:'h'.repeat(40),actor:'h',workspace:'lab',role:'health' as const}];
 const options={database:join(root,'runs.db'),profile:fixtureProfile,sandbox,identities};let app=await createApp(options),url=await app.listen();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const call=(path:string,body?:unknown,actor='a')=>fetch(url+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${actor.repeat(40)}`,'Content-Type':'application/json','Idempotency-Key':'same'},...(body?{body:JSON.stringify(body)}:{})});
 const task={prompt:'Attempt prohibited action',profile:'json-lab@1',output_contract:'summary-value@1'};
 const accepted=await(await call('/v1/runs',task)).json();let run=accepted;
 for(let i=0;i<200&&!run.terminal_at;i++){await new Promise(r=>setTimeout(r,10));run=await(await call('/v1/runs/'+accepted.run_id)).json();}
 assert.equal(run.failure,'policy_denied');assert.equal(run.status,'failed');assert.equal(run.boundary.audit_coverage,'partial');
 assert.equal((await call('/v1/runs/'+run.run_id,undefined,'b')).status,404);assert.equal((await call('/v1/runs/'+run.run_id,undefined,'h')).status,403);
 assert.equal((await(await call('/v1/runs',task)).json()).run_id,run.run_id);assert.equal(starts,1);
 await app.close();app=await createApp(options);url=await app.listen();assert.equal((await(await call('/v1/runs/'+run.run_id)).json()).failure,'policy_denied');
 assert.equal((await call('/v1/runs',{...task,audit_requirement:'complete'})).status,422);
 const health=await(await call('/internal/health',undefined,'h')).json();assert.equal(health.boundary.denied,1);assert.equal(health.boundary.complete_audit_available,false);
});
