import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import { fixtureProfile } from '../src/profile.js';
import type { Profile } from '../src/domain.js';
import { Sandbox } from '@alibaba-group/opensandbox';
import { sha256 } from '../src/files.js';
if(process.platform!=='linux'||process.env.ATOMIC_ISOLATION_EXPERIMENT!=='ticket10'||!process.env.ATOMIC_TEST_IMAGE)throw new Error('experiment_only');
const directory=await mkdtemp('/tmp/atomic-provider-');
const profile:Profile={...fixtureProfile,id:'provider-isolation@1',mode:'opensandbox',image:process.env.ATOMIC_TEST_IMAGE,model:'controlled-model',endpoint:'https://172-17-0-1.sslip.io:43811',secret_ref:'SYNTHETIC_MODEL',provider_ref:'ticket10-server',provider_endpoint:'http://127.0.0.1:43810',linux_node:'owned-linux-experiment',approval_ref:'controlled-protocol-no-model-billing',timeout_seconds:120};
const sandbox=new OpenSandboxAdapter({domain:profile.provider_endpoint,apiKey:'ticket10-controlled-server-key'},()=> 'SYNTHETIC_MODEL_KEY',[profile.image]);
const canaries:unknown[]=[];
const prepare=sandbox.prepare.bind(sandbox);sandbox.prepare=async run=>{try{
 const id=await prepare(run);
 const resource=await Sandbox.connect({sandboxId:id,connectionConfig:{domain:profile.provider_endpoint,apiKey:'ticket10-controlled-server-key',useServerProxy:true,disableMetrics:true}});
 try{const result=await resource.commands.run(`node /opt/atomicagent/dist/scripts/provider-canary.js ${run.prompt.includes('attack-ticket10')?'A':'B'}`,{uid:0,gid:0,envs:{ATOMIC_ISOLATION_EXPERIMENT:'ticket10'},timeoutSeconds:5});
 assert.equal(result.exitCode,0);canaries.push({run_id:run.run_id,resource_id:id,result:result.logs.stdout.map(v=>v.text).join('')});
 console.log(JSON.stringify({prepared:canaries.at(-1)}));
 }finally{await resource.close();}return id;
}catch(error){console.log('controlled-provider-prepare',String(error));throw error;}};
const execute=sandbox.execute.bind(sandbox);sandbox.execute=async(...args)=>{try{return await execute(...args);}catch(error){console.log('controlled-provider-execute',String(error));throw error;}};
const load=sandbox.loadInputs.bind(sandbox);sandbox.loadInputs=async(run,inputs)=>{try{await load(run,inputs);}catch(error){
 const resource=await Sandbox.connect({sandboxId:run.allocation!.resource_id!,connectionConfig:{domain:profile.provider_endpoint,apiKey:'ticket10-controlled-server-key',useServerProxy:true,disableMetrics:true}});
 try{const bytes=await resource.files.readBytes('/workspace/input/data.csv',{limit:1048577});console.log('controlled-input-info',JSON.stringify({info:await resource.files.getFileInfo(['/workspace/input/data.csv']),length:bytes.length,digest:sha256(bytes),error:String(error)}));}finally{await resource.close();}throw error;
}};
const app=await createApp({database:join(directory,'runs.db'),profile,sandbox,identities:[{token:'ticket10-backend-token-00000000000000000000',actor:'experiment',workspace:'ticket10',role:'maintainer'}]});
const url=await app.listen();const headers={Authorization:'Bearer ticket10-backend-token-00000000000000000000','Content-Type':'application/json'};
const call=(path:string,body?:unknown,key='task')=>fetch(url+path,{headers:{...headers,'Idempotency-Key':key},method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});
try{
 const output=[];
 const uploaded=await call('/v1/files',{format:'csv',content:'id,category,value\n1,a,3\n'});assert.equal(uploaded.status,201);const file=await uploaded.json();
 const catalog=await(await call('/v1/configurations')).json();
 const command={action:'publish',kind:'mcp',name:'research',expected_generation:0,content:{binding_ref:catalog.bindings.mcps[0].binding_ref},reason:'Controlled real SDK MCP transport'};
 const preview=await(await call('/v1/configurations/preview',command,'mcp-preview')).json();assert.equal((await call('/v1/configurations/commands',{...command,preview_digest:preview.preview_digest},'mcp-publish')).status,200);
 for(const [key,prompt] of [['A','attack-ticket10'],['B','Return the approved JSON.'],['C','file-positive-ticket10'],['D','research-positive-ticket10']]){
  const fileTask=key==='A'||key==='C';
  const accepted=await call('/v1/runs',{prompt,profile:profile.id,output_contract:fileTask?'data-statistics@1':key==='D'?'research-report@1':'summary-value@1',...(fileTask?{inputs:[{file_id:file.file_id,path:'input/data.csv'}]}:{}),...(key==='D'?{mcp:[{id:'research',version:'1'}]}:{})},key);assert.equal(accepted.status,202,await accepted.clone().text());let run=await accepted.json();
  for(let i=0;i<700 && (!run.terminal_at||run.cleanup.status==='pending');i++){await new Promise(r=>setTimeout(r,200));run=await(await call('/v1/runs/'+run.run_id)).json();}
  output.push(run);console.log(JSON.stringify({key,run}));
  assert.equal(run.cleanup.status,'complete');assert.equal(run.boundary?.isolation,'enforced');
  if(key==='A')assert.equal(run.failure,'policy_denied');else assert.equal(run.status,'succeeded');
  if(key==='D')assert.equal(run.mcp[0].acquired,2);
 }
 assert.notEqual(output[0].run_id,output[1].run_id);assert.notEqual(output[0].attempt_id,output[1].attempt_id);
 console.log(JSON.stringify({source:'real-api-worker-opensandbox-sdk-server-docker-claude-cli-controlled-model-protocol',observed_at:new Date().toISOString(),canaries,runs:output.map(r=>({run_id:r.run_id,attempt_id:r.attempt_id,status:r.status,failure:r.failure,cleanup:r.cleanup,boundary:r.boundary})),model_inference:'not-tested',gvisor:'not-tested'}));
}finally{await app.close();await rm(directory,{recursive:true,force:true});}
