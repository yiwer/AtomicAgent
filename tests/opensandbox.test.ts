import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import type { Run } from '../src/domain.js';
import { fixtureProfile } from '../src/profile.js';
import { defaultLimits } from '../src/limits.js';

for(const recordFails of [false,true])test(`real SDK stream memory pressure aborts the running command even when observation storage fails=${recordFails}`,{timeout:8000},async t=>{
 let host='',reads=0,runnerStarted=false,runnerClosed=false,observations=0,deleted=false;let finishRunner:()=>void=()=>{};
 const accepted=new Date().toISOString(),deadline=new Date(Date.now()+6000).toISOString();
 const evidence={source:'trusted-supervisor:cgroup-v2-and-tmpfs',observed_at:accepted,cpu_quota:25000,cpu_period:100000,memory_bytes:402653184,workspace_bytes:190840832,deadline_at:deadline,memory_events:{max:0,oom:0,oom_kill:0}};
 const server=createServer(async(req,res)=>{
  if(req.method==='DELETE'&&req.url==='/v1/sandboxes/owned'){deleted=true;finishRunner();res.writeHead(204).end();return;}
  if(req.url==='/v1/sandboxes/owned'){res.writeHead(404).end('{}');return;}
  res.setHeader('Content-Type','application/json');
  if(req.url?.includes('/endpoints/')){res.end(JSON.stringify({endpoint:host,headers:{}}));return;}
  if(req.url==='/ping'){res.end('{}');return;}
  if(req.url==='/directories'||req.url==='/files/upload'){for await(const _ of req){}res.writeHead(204).end();return;}
  if(req.url?.startsWith('/files/download')){if(req.url.includes('resources.json')){reads++;if(reads===1){res.writeHead(404).end('{}');return;}res.end(JSON.stringify(evidence));}else res.writeHead(404).end('{}');return;}
  if(req.url==='/command'){
   let body='';for await(const chunk of req)body+=String(chunk);res.setHeader('Content-Type','text/event-stream');
   const events=(texts:string[])=>texts.map(text=>'data: '+JSON.stringify({type:'stdout',text})+'\n\n').join('')+'data: '+JSON.stringify({type:'execution_complete',execution_time:1})+'\n\n';
   if(body.includes('isolation-probe.js')){res.end(events(['atomic-isolation-v1:node24.18.0:sdk0.3.270:permit-v1']));return;}
   if(body.includes('memory.events')){while(!runnerStarted&&!res.destroyed)await new Promise(r=>setTimeout(r,5));res.end(events(['low 0','high 0','max 45','oom 1','oom_kill 1','oom_group_kill 0']));return;}
   runnerStarted=true;finishRunner=()=>res.end(events([]));res.write('data: '+JSON.stringify({type:'init',text:'running'})+'\n\n');res.on('close',()=>{runnerClosed=true;});return;
  }
  res.writeHead(500).end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});host=`127.0.0.1:${(server.address() as {port:number}).port}`;
 const adapter=new OpenSandboxAdapter({domain:'http://'+host},()=> 'synthetic-token',[fixtureProfile.image]);
 const run={run_id:'run',attempt_id:'attempt',accepted_at:accepted,prompt:'test',allocation:{resource_id:'owned',operation_id:'op'},manifest:{profile:fixtureProfile,deadline_at:deadline,limits:{...defaultLimits,cpu:.25,memory_mib:384,workspace_bytes:190840832,policy_revision:1,pids:128},grant:{inputs:[],mcp:[]},output_contract:'summary-value@1'}} as unknown as Run;
 await assert.rejects(adapter.execute(run,AbortSignal.timeout(6500),undefined,undefined,()=>{},value=>{observations++;if(observations===2){assert.equal((value as typeof evidence).memory_events.oom_kill,1);if(recordFails)throw new Error('controlled_store_failure');}}),error=>(error as {code:string;dimension:string}).code==='budget_exceeded'&&(error as {dimension:string}).dimension==='memory_mib');
 for(let i=0;i<50&&!runnerClosed;i++)await new Promise(r=>setTimeout(r,5));
 assert.ok(reads>=2);assert.equal(observations,2);assert.ok(deleted&&runnerStarted&&runnerClosed);
});

test('real OpenSandbox HTTP adapter requires a fresh 404 after delete, never a delete receipt or access denial', async t => {
  let getStatus = 404;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    res.writeHead(getStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus === 200 ? {
      id: 'owned-resource', image: { uri: 'test' }, entrypoint: ['tail'], status: { state: 'Running' },
      createdAt: new Date().toISOString(), expiresAt: null,
    } : { code: 'test_error', message: 'SYNTHETIC_SECRET must not be observed' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing_address');
  const adapter = new OpenSandboxAdapter({ domain: `http://127.0.0.1:${address.port}`, apiKey: 'test-only-key' }, () => 'not-used');
  const run = { allocation: { resource_id: 'owned-resource', operation_id: 'owned-operation' } } as Run;
  assert.equal(await adapter.cleanup(run), 'absent');
  assert.deepEqual(requests, ['DELETE /v1/sandboxes/owned-resource', 'GET /v1/sandboxes/owned-resource']);
  getStatus = 200; assert.equal(await adapter.cleanup(run), 'present');
  getStatus = 403; await assert.rejects(adapter.cleanup(run));
});

test('an empty provider listing cannot close an unknown create operation', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0, hasNextPage: false } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing_address');
  const adapter = new OpenSandboxAdapter({ domain: `http://127.0.0.1:${address.port}`, apiKey: 'test-only-key' }, () => 'not-used');
  assert.equal(await adapter.cleanup({ run_id: 'run', allocation: { resource_id: null, operation_id: 'op' } } as Run), 'unknown');
});
test('forced stop uses provider deletion plus a fresh resource observation and preserves uncertainty', async t => {
  let present=true; const calls: string[]=[];
  const server=createServer((req,res)=>{calls.push(`${req.method} ${req.url}`); if(req.method==='DELETE'){res.writeHead(204);res.end();return;} res.writeHead(present?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(present?{id:'owned',image:{uri:'test'},entrypoint:['tail'],status:{state:'Running'},createdAt:new Date().toISOString(),expiresAt:null}:{code:'not_found',message:'gone'}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const address=server.address(); if(!address||typeof address==='string') throw new Error('address');
  const adapter=new OpenSandboxAdapter({domain:`http://127.0.0.1:${address.port}`,apiKey:'test'},()=> 'unused');
  const run={allocation:{resource_id:'owned',operation_id:'op'}} as Run;
  assert.equal(await adapter.forceStop(run),'unknown'); present=false; assert.equal(await adapter.forceStop(run),'stopped');
  assert.deepEqual(calls,['DELETE /v1/sandboxes/owned','GET /v1/sandboxes/owned','DELETE /v1/sandboxes/owned','GET /v1/sandboxes/owned']);
});
test('an already cancelled execution cannot connect or start a new command',async()=>{
  const adapter=new OpenSandboxAdapter({domain:'http://127.0.0.1:1',apiKey:'test'},()=> 'unused');
  const controller=new AbortController();controller.abort(new Error('cancelled-before-dispatch'));
  await assert.rejects(adapter.execute({} as Run,controller.signal),/cancelled-before-dispatch/);
});
for(const [qualified,failedPath] of [[false,''],[true,''],[false,'/run/atomicagent-cancel.json'],[false,'/workspace/cancel.json']] as const)test(`cancellation markers preserve historical protocols: qualified=${qualified}, failed=${failedPath||'none'}`,async t=>{
 let host='',uploaded='';const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url?.includes('/endpoints/')){res.end(JSON.stringify({endpoint:host,headers:{}}));return;}
  if(req.url==='/ping'){res.end('{}');return;}
  if(req.url==='/files/upload'){let body='';for await(const chunk of req)body+=String(chunk);uploaded+=body;res.writeHead(failedPath&&body.includes(failedPath)?403:204).end();return;}
  res.writeHead(500).end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));host=`127.0.0.1:${(server.address() as {port:number}).port}`;
 const adapter=new OpenSandboxAdapter({domain:'http://'+host},()=>{throw new Error('must_not_read_model_key');},qualified?[fixtureProfile.image]:[]);
 const stopping=adapter.requestStop({run_id:'run',attempt_id:'attempt',allocation:{resource_id:'owned'},manifest:{profile:fixtureProfile,deadline_at:new Date(Date.now()+30000).toISOString()}} as Run);
 if(failedPath)await assert.rejects(stopping);else await stopping;
 // The current execution allowlist cannot identify the protocol of an already running, later revoked image.
 assert.ok(uploaded.includes('/run/atomicagent-cancel.json'));assert.ok(uploaded.includes('"owner":"root"'));
 assert.ok(uploaded.includes('/workspace/cancel.json'));assert.ok(uploaded.includes('"owner":"node"'));
});
for(const boundary of ['connect','request-upload'] as const) test(`cancellation during OpenSandbox ${boundary} prevents command dispatch`,async t=>{
  const controller=new AbortController();let host='',commands=0;
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url?.includes('/endpoints/')){if(boundary==='connect')controller.abort();res.end(JSON.stringify({endpoint:host,headers:{}}));return;}
    if(req.url==='/ping'){res.end('{}');return;}
    if(req.url==='/directories'){res.writeHead(204);res.end();return;}
    if(req.url==='/files/upload'){for await(const _ of req){}controller.abort();res.writeHead(204);res.end();return;}
    if(req.url==='/command'){let body='';for await(const chunk of req)body+=String(chunk);
      if(body.includes('isolation-probe.js')){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({type:'stdout',text:'atomic-isolation-v1:node24.18.0:sdk0.3.270:permit-v1'})+'\n\ndata: '+JSON.stringify({type:'execution_complete',execution_time:1})+'\n\n');return;}commands++;}
    res.writeHead(500);res.end('{}');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const address=server.address();if(!address||typeof address==='string')throw new Error('address');host=`127.0.0.1:${address.port}`;
  const adapter=new OpenSandboxAdapter({domain:'http://'+host,apiKey:'test'},()=> 'synthetic-token',[fixtureProfile.image]);
  const run={run_id:'run',attempt_id:'attempt',prompt:'test',allocation:{resource_id:'owned',operation_id:'op'},manifest:{profile:fixtureProfile,deadline_at:new Date(Date.now()+30000).toISOString(),grant:{inputs:[],mcp:[]},output_contract:'summary-value@1'}} as unknown as Run;
  await assert.rejects(adapter.execute(run,controller.signal));assert.equal(commands,0);
});
