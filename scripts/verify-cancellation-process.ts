import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';
const root=await mkdtemp(join(tmpdir(),'atomic-cancel-process-'));
const sandbox=new FixtureSandbox(); let child: ChildProcess|undefined, closed=false, forcedAt=0;
let closeReceipt: { code: number|null; signal: string|null }|undefined;
let ready!:()=>void; const started=new Promise<void>(r=>ready=r);
let exited!:()=>void; const exit=new Promise<void>(r=>exited=r);
sandbox.execute=async()=>{
  child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  child.stdout!.once('data',()=>ready()); child.once('error',()=>ready());
  child.once('close',(code,signal)=>{closed=true;closeReceipt={code,signal};exited();});
  await exit; return {summary:'late process result',value:1};
};
sandbox.forceStop=async()=>{
  forcedAt=Date.now();
  if(!child)return 'unknown';
  if(!closed && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([exit.then(()=> 'stopped' as const),new Promise<'unknown'>(r=>{timer=setTimeout(()=>r('unknown'),5000);})]);}
  finally{clearTimeout(timer);}
};
Object.assign(sandbox,{sourceFor:()=> 'controlled-local-child-process:node-close-event'});
const token='local-process-test-only-token-000000000000000000';
const app=await createApp({database:join(root,'runs.db'),profile:fixtureProfile,sandbox,identities:[{token,actor:'process-test',workspace:'isolated-test',role:'caller'}]});
const url=await app.listen();
const request=(path:string,body?:unknown)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':'owned-process'},...(body===undefined?{}:{body:JSON.stringify(body)})});
try{
  const {run_id}=await (await request('/v1/runs',{prompt:'Controlled process cancellation experiment',profile:fixtureProfile.id,output_contract:'summary-value@1'})).json();
  await started; assert.ok(child?.pid); assert.equal(closed,false);
  const accepted=await (await request(`/v1/runs/${run_id}:cancel`,{})).json();
  assert.equal(accepted.stop.status,'pending'); assert.equal(closed,false);
  let run=accepted;
  const end=Date.now()+40000;
  while(Date.now()<end){run=await (await request(`/v1/runs/${run_id}`)).json();if(run.stop?.status==='stopped'&&run.cleanup.status==='complete')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(run.status,'cancelled');assert.equal(run.stop.status,'stopped');assert.equal(run.cleanup.status,'complete');assert.equal(closed,true);assert.equal(sandbox.resources.size,0);
  const elapsed=forcedAt-Date.parse(accepted.cancellation.requested_at);assert.ok(elapsed>=30000&&elapsed<35000);assert.equal((await request(`/v1/runs/${run_id}/result`)).status,409);
  const evidence={source:'real-local-controlled-node-process',verified_at:new Date().toISOString(),run_id,owned_pid:child!.pid,close_receipt:closeReceipt,force_after_ms:elapsed,run,provider_resources_remaining:sandbox.resources.size,
    scope:'Actual Windows local child exit observed. Provider HTTP deletion separately protocol-tested. No paid model or Linux sandbox qualification.'};
  await mkdir('.scratch/v0/evidence/ticket09',{recursive:true});await writeFile('.scratch/v0/evidence/ticket09/process-stop.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({status:'PASS',force_after_ms:elapsed,closed,resources_remaining:sandbox.resources.size}));
}finally{
  if(child&&!closed){child.kill('SIGKILL');await exit;}
  await app.close();await rm(root,{recursive:true,force:true});
}
