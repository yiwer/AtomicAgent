// Runs only in the self-owned Linux experiment container; never on the deployment host.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chown, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedQuery, namespaceArgs } from '../src/isolated-query.js';
import { runClaude } from '../src/claude-execution.js';
import { ModelGateway } from '../src/model-gateway.js';
if(process.platform!=='linux' || process.env.ATOMIC_ISOLATION_EXPERIMENT!=='ticket10') throw new Error('experiment_container_required');
const root=await mkdtemp('/tmp/atomic-ticket10-'), task=join(root,'task-a'), control=join(root,'control');
await chmod(root,0o755);await mkdir(task,{mode:0o700});await chown(task,1000,1000);await mkdir(control,{mode:0o700});await writeFile(join(control,'secret'),'PARENT_CANARY');
process.env.ANTHROPIC_API_KEY='SYNTHETIC_MODEL_KEY'; process.env.ATOMIC_PARENT_CANARY='PARENT_CANARY';
let modelCalls=0,businessWrites=0;
const receiver=createServer(async(req,res)=>{
 if(req.url!=='/v1/messages'){ businessWrites++;res.writeHead(403).end();return; }
 modelCalls++;assert.equal(req.headers['x-api-key'],'SYNTHETIC_MODEL_KEY');
 const parts=[];for await(const part of req)parts.push(part);const input=JSON.parse(Buffer.concat(parts).toString());assert.equal(input.model,'controlled-model');
 res.writeHead(200,{'content-type':'text/event-stream'});
 const event=(type:string,data:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
 event('message_start',{type:'message_start',message:{id:'msg_controlled',type:'message',role:'assistant',model:'controlled-model',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}});
 event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
 event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'{"summary":"controlled protocol","value":3}'}});
 event('content_block_stop',{type:'content_block_stop',index:0});event('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:12}});event('message_stop',{type:'message_stop'});res.end();
});
await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${(receiver.address() as {port:number}).port}`;
const events:unknown[]=[];
let gate:ModelGateway|undefined;
try {
 const request={prompt:'Return the approved JSON.',model:'controlled-model',endpoint,deadline_at:new Date(Date.now()+60000).toISOString(),run_id:'run-cli',attempt_id:'attempt-cli',output_contract:'summary-value@1'};
 const isolated=await isolatedQuery(request,task,control,async event=>{events.push(event);});
 const result=await runClaude(request,task,isolated.query);await isolated.close();
 assert.equal(result.failure,undefined,JSON.stringify({result,diagnostic:isolated.diagnostic(),modelCalls,events}));assert.deepEqual(result.candidate,{summary:'controlled protocol',value:3});assert.ok(modelCalls>=1);
 const socket=join(control,'adversary.sock');gate=new ModelGateway({endpoint,model:'controlled-model',token:'SYNTHETIC_MODEL_KEY',deadline:Date.now()+60000},async event=>{events.push(event);});await gate.listen(socket);await chmod(socket,0o666);
 const attack=`const fs=require('fs'),http=require('http'),cp=require('child_process');const root=${JSON.stringify(task)};const facts={};for(const [name,path] of [['parent',${JSON.stringify(join(control,'secret'))}],['proc','/proc/1/environ']]){try{fs.readFileSync(path);facts[name]=false}catch{facts[name]=true}}try{fs.writeFileSync('/usr/atomic-canary','bad');facts.readonly=false}catch{facts.readonly=true}facts.env=process.env.ATOMIC_PARENT_CANARY===undefined;fs.symlinkSync(${JSON.stringify(join(control,'secret'))},root+'/escape');try{fs.readFileSync(root+'/escape');facts.symlink=false}catch{facts.symlink=true}const req=http.request('http://127.0.0.1:3999/business-write',{method:'POST'},r=>{facts.proxy=r.statusCode===403;r.resume();r.on('end',()=>{const raw=http.request(${JSON.stringify(endpoint+'/business-write')},{method:'POST'},r=>{facts.raw=false;r.resume();done()});raw.on('error',()=>{facts.raw=true;done()});raw.end();})});req.end();function done(){fs.writeFileSync(root+'/facts.json',JSON.stringify(facts));cp.spawn(process.execPath,['-e','setInterval(()=>require("fs").writeFileSync('+JSON.stringify(root+'/heartbeat')+',String(Date.now())),20)'],{stdio:'ignore'});setInterval(()=>{},1000)}`;
 const child=spawn('/usr/bin/bwrap',[...namespaceArgs(task,socket),'/usr/local/bin/node','/opt/atomicagent/dist/src/isolation-bridge.js','/usr/local/bin/node','-e',attack],{env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:task},stdio:['ignore','ignore','pipe']});
 let attackError='';child.stderr!.on('data',chunk=>{attackError=(attackError+String(chunk)).slice(-2000);});
 try{
  for(let i=0;i<200;i++){try{await readFile(join(task,'heartbeat'));break}catch{await new Promise(r=>setTimeout(r,25));}}
  const facts=JSON.parse(await readFile(join(task,'facts.json'),'utf8').catch(()=>{throw new Error(attackError)}));assert.deepEqual(facts,{parent:true,proc:true,readonly:true,env:true,symlink:true,proxy:true,raw:true});
  const closed=new Promise<void>(r=>child.once('close',()=>r()));child.kill('SIGKILL');await closed;await gate.close();
  const heartbeat=await readFile(join(task,'heartbeat'),'utf8');await new Promise(r=>setTimeout(r,100));assert.equal(await readFile(join(task,'heartbeat'),'utf8'),heartbeat);
  const taskB=join(root,'task-b');await mkdir(taskB,{mode:0o700});await chown(taskB,1000,1000);
  const b=await isolatedQuery({...request,run_id:'run-b',attempt_id:'attempt-b'},taskB,control,async event=>{events.push(event);});
  const resultB=await runClaude({...request,run_id:'run-b',attempt_id:'attempt-b'},taskB,b.query);await b.close();assert.equal(resultB.failure,undefined);await assert.rejects(readFile(join(taskB,'heartbeat')));await assert.rejects(readFile(join(taskB,'facts.json')));
  console.log(JSON.stringify({source:'linux-docker-real-bwrap-and-bundled-claude-cli',node:process.versions.node,sdk:'0.3.270',observed_at:new Date().toISOString(),facts,child_stopped:true,b_clean:true,modelCalls,businessWrites,model:'controlled-http-protocol-not-model-inference',gvisor:'not-tested',audit_coverage:'partial',events},null,2));
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}finally{await gate?.close();await new Promise<void>(r=>receiver.close(()=>r()));await rm(root,{recursive:true,force:true});}
