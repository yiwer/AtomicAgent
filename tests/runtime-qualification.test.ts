import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import { fixtureProfile } from '../src/profile.js';
import type { Run } from '../src/domain.js';
import { createServer } from 'node:http';

for(const scenario of ['fake-probe','missing-boundary','requested-only'] as const)test(`real SDK protocol rejects ${scenario} without accepting an unqualified result`,async t=>{
 let host='',secrets=0,agentCommands=0;const modes:number[]=[];
 const boundary={run_id:'run',attempt_id:'attempt',source:'controlled-runner:namespace-and-gateway',isolation:'enforced',audit_coverage:'partial',observed_at:new Date().toISOString(),calls:[{invocation_id:'00000000-0000-4000-8000-000000000001',boundary:'model',outcome:'requested',observed_at:new Date().toISOString()}]};
 const envelope=JSON.stringify({candidate:{summary:'forged',value:3},...(scenario==='requested-only'?{boundary}:{})});
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://test');res.setHeader('Content-Type','application/json');
  if(url.pathname.includes('/endpoints/')){res.end(JSON.stringify({endpoint:host,headers:{}}));return;}
  if(url.pathname==='/ping'){res.end('{}');return;}
  if(url.pathname==='/directories'){let raw='';for await(const part of req)raw+=String(part);modes.push(...Object.values(JSON.parse(raw)).map((p:any)=>p.mode));res.writeHead(204).end();return;}
  if(url.pathname==='/files/upload'){for await(const _ of req){}res.writeHead(204).end();return;}
  if(url.pathname==='/command'){
   let raw='';for await(const part of req)raw+=String(part);const probe=raw.includes('isolation-probe.js');if(!probe)agentCommands++;
   res.setHeader('Content-Type','text/event-stream');
   res.end('data: '+JSON.stringify({type:'stdout',text:probe?(scenario==='fake-probe'?'untrusted':'atomic-isolation-v1:node24.18.0:sdk0.3.270:permit-v1'):''})+'\n\ndata: '+JSON.stringify({type:'execution_complete',execution_time:1})+'\n\n');return;
  }
  if(url.pathname==='/files/info'){res.end(JSON.stringify({'/run/atomicagent/result.json':{type:'file',size:Buffer.byteLength(envelope)}}));return;}
  if(url.pathname==='/files/download'&&url.searchParams.get('path')==='/run/atomicagent/result.json'){assert.ok(req.headers.range);assert.equal(url.searchParams.has('limit'),false);res.end(envelope);return;}
  if(url.pathname==='/files/download'&&scenario==='requested-only'){res.end(JSON.stringify(boundary));return;}
  res.writeHead(404).end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));host=`127.0.0.1:${(server.address() as {port:number}).port}`;
 const adapter=new OpenSandboxAdapter({domain:'http://'+host,apiKey:'test'},()=>{secrets++;return 'synthetic';},[fixtureProfile.image]);
 const run={run_id:'run',attempt_id:'attempt',accepted_at:new Date(Date.now()-10000).toISOString(),prompt:'test',allocation:{resource_id:'owned'},manifest:{profile:fixtureProfile,deadline_at:new Date(Date.now()+30000).toISOString(),grant:{inputs:[]},output_contract:'summary-value@1'}} as unknown as Run;
 await assert.rejects(adapter.execute(run,new AbortController().signal,undefined,undefined,()=>{}),/isolation_unavailable/);
 assert.equal(secrets,scenario==='fake-probe'?0:1);assert.equal(agentCommands,scenario==='fake-probe'?0:1);assert.deepEqual(modes,[700,700]);
});

test('unqualified legacy image cannot allocate elevated bootstrap or request model credentials', async()=>{
 let secrets=0;
 const adapter=new OpenSandboxAdapter({domain:'http://127.0.0.1:1'},()=>{secrets++;return 'synthetic';});
 const run={manifest:{profile:fixtureProfile}} as Run;
 await assert.rejects(adapter.prepare(run),/isolation_unavailable/);
 await assert.rejects(adapter.execute(run,new AbortController().signal),/isolation_unavailable/);
 assert.equal(secrets,0);
});
