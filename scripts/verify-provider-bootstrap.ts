// Create a credential-free resource for host-side port/capability inspection before any Agent runs.
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import { fixtureProfile } from '../src/profile.js';
import { randomUUID } from 'node:crypto';
import type { Run } from '../src/domain.js';
if(process.platform!=='linux'||process.env.ATOMIC_ISOLATION_EXPERIMENT!=='ticket10'||!process.env.ATOMIC_TEST_IMAGE)throw new Error('experiment_only');
const profile={...fixtureProfile,image:process.env.ATOMIC_TEST_IMAGE,endpoint:'https://172-17-0-1.sslip.io:43811'};
const run={run_id:randomUUID(),allocation:{operation_id:randomUUID(),resource_id:null},manifest:{profile,deadline_at:new Date(Date.now()+120000).toISOString(),grant:{mcp:[]}}} as unknown as Run;
const adapter=new OpenSandboxAdapter({domain:'http://127.0.0.1:43810',apiKey:'ticket10-controlled-server-key'},()=>{throw new Error('no_credential_in_bootstrap_probe');},[profile.image]);
try{
 run.allocation!.resource_id=await adapter.prepare(run);console.log(JSON.stringify({run_id:run.run_id,resource_id:run.allocation!.resource_id,stage:'inspect-before-agent'}));
 await new Promise(r=>setTimeout(r,25000));
}finally{console.log(JSON.stringify({resource_id:run.allocation!.resource_id,cleanup:await adapter.cleanup(run)}));}
