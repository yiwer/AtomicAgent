import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import { GuardianClient } from '../src/guardian.js';
import { fixtureProfile } from '../src/profile.js';
import type { Profile } from '../src/domain.js';
if(process.platform!=='linux'||process.env.ATOMIC_LIMIT_EXPERIMENT!=='ticket11'||!process.env.ATOMIC_TEST_IMAGE)throw new Error('experiment_only');
const mode=process.env.ATOMIC_LIMIT_MODE??'normal';
const profile:Profile={...fixtureProfile,id:'provider-limits@1',mode:'opensandbox',image:process.env.ATOMIC_TEST_IMAGE,model:'controlled-model',endpoint:'https://172-17-0-1.sslip.io:43811',secret_ref:'SYNTHETIC_MODEL',provider_ref:'ticket11-server',provider_endpoint:'http://127.0.0.1:43810',linux_node:'owned-linux-experiment',approval_ref:'controlled-protocol-no-model-billing',timeout_seconds:120};
const guardian=new GuardianClient('/guardian/guardian.sock','ticket11');
const sandbox=new OpenSandboxAdapter({domain:profile.provider_endpoint,apiKey:'ticket11-controlled-server-key'},()=> 'SYNTHETIC_MODEL_KEY',[profile.image],guardian);
const prepare=sandbox.prepare.bind(sandbox);sandbox.prepare=async run=>{const resource=await prepare(run);console.log(JSON.stringify({prepared:{run_id:run.run_id,operation_id:run.allocation!.operation_id,resource_id:resource,deadline_at:run.manifest.deadline_at,limits:run.manifest.limits}}));return resource;};
await mkdir('/records/'+mode,{recursive:true});
const app=await createApp({guardian,database:`/records/${mode}/runs.db`,profile,sandbox,identities:[{token:'ticket11-backend-token-00000000000000000000',actor:'experiment',workspace:'ticket11',role:'maintainer'}]});
const url=await app.listen();const headers={Authorization:'Bearer ticket11-backend-token-00000000000000000000','Content-Type':'application/json'};
const call=(path:string,body?:unknown,key='task')=>fetch(url+path,{headers:{...headers,'Idempotency-Key':key},method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});
try{
 const file=await(await call('/v1/files',{format:'csv',content:'id,category,value\n1,a,3\n'},'file')).json();
 const cases=mode==='crash'?[['crash','deadline-ticket11']]:mode==='pressure'?[['memory','deadline-ticket11']]:[['default','Return approved JSON.'],['artifact','file-positive-ticket10'],['deadline','deadline-ticket11']];
 for(const [key,prompt] of cases){
  const fileTask=key==='artifact';
  const limits=key==='default'?{}:{cpu:0.25,memory_mib:384,total_timeout_seconds:key==='crash'?30:key==='deadline'?15:60,...(fileTask?{artifact_bytes:1}:{})};
  const response=await call('/v1/runs',{prompt,profile:profile.id,output_contract:fileTask?'data-statistics@1':'summary-value@1',limits,...(fileTask?{inputs:[{file_id:file.file_id,path:'input/data.csv'}]}:{})},key);
  assert.equal(response.status,202,await response.clone().text());let run=await response.json();
  await writeFile(`/records/${mode}/${key}-accepted.json`,JSON.stringify(run,null,2));
  for(let i=0;i<800&&(!run.terminal_at||run.cleanup.status==='pending');i++){await new Promise(r=>setTimeout(r,200));run=await(await call('/v1/runs/'+run.run_id)).json();}
  console.log(JSON.stringify({key,run}));await writeFile(`/records/${mode}/${key}-result.json`,JSON.stringify(run,null,2));
  assert.equal(run.cleanup.status,'complete');if(key==='default'){assert.equal(run.status,'succeeded');assert.equal(run.resource_limits.memory_bytes,4294967296);}else if(key==='artifact'||key==='memory'){assert.equal(run.failure,'budget_exceeded');assert.equal(run.limit_termination.dimension,key==='memory'?'memory_mib':'artifact_bytes');}else assert.equal(run.failure,'deadline_exceeded');
 }
 console.log(JSON.stringify({health:await(await call('/internal/health')).json(),source:'real-api-provider-cli-controlled-protocol',model_inference:'not-tested'}));
}finally{await app.close();}
