// Adversarial sibling processes operate only on their own temporary task directory.
import { mkdir, mkdtemp, chmod, chown, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { namespaceArgs } from '../src/isolated-query.js';
import { ModelGateway } from '../src/model-gateway.js';
if(process.platform!=='linux'||process.env.ATOMIC_ISOLATION_EXPERIMENT!=='ticket10')throw new Error('experiment_only');
const root=await mkdtemp('/tmp/atomic-swap-'),task=join(root,'task'),control=join(root,'control');
await chmod(root,0o755);await mkdir(task,{mode:0o700});await chown(task,1000,1000);await mkdir(control,{mode:0o700});
await writeFile(join(control,'secret'),'SYNTHETIC_OUTSIDE_CANARY');
const socket=join(control,'capability.sock');const gateway=new ModelGateway({endpoint:'https://unused.invalid',model:'unused',token:'',deadline:Date.now()+30000},async()=>{throw new Error('no_network_authority');});
await gateway.listen(socket);await chmod(socket,0o666);
const swapper=`const fs=require('fs');let n=0;setInterval(()=>{fs.renameSync('swap','parked');fs.symlinkSync(${JSON.stringify(control)},'swap');fs.unlinkSync('swap');fs.renameSync('parked','swap');fs.writeFileSync('swap-count',String(++n));},1);`;
const attack=`const fs=require('fs'),cp=require('child_process');fs.mkdirSync('swap');cp.spawn(process.execPath,['-e',${JSON.stringify(swapper)}],{stdio:'ignore'});(async()=>{let exposed=false;for(let i=0;i<1000;i++){try{exposed ||= fs.readFileSync('swap/secret','utf8')==='SYNTHETIC_OUTSIDE_CANARY'}catch{}await new Promise(r=>setTimeout(r,1))}const status=fs.readFileSync('/proc/self/status','utf8');console.log(JSON.stringify({uid:process.getuid(),capabilities_empty:/CapBnd:\\s+0+\\n/.test(status),no_new_privileges:/NoNewPrivs:\\s+1/.test(status),swaps:Number(fs.readFileSync('swap-count','utf8')),outside_read:exposed}));})();`;
const child=spawn('/usr/bin/bwrap',[...namespaceArgs(task,socket),'/usr/local/bin/node','-e',attack],{env:{PATH:'/usr/local/bin:/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
let output='';const ended=new Promise<void>(resolve=>child.once('close',()=>resolve()));
try{
 const facts=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('swap_timeout')),10000);child.stdout.on('data',part=>{output+=String(part);if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.trim()));}});child.once('error',reject);});
 assert.equal(facts.uid,1000);assert.equal(facts.capabilities_empty,true);assert.equal(facts.no_new_privileges,true);assert.ok(facts.swaps>10);assert.equal(facts.outside_read,false);
 child.kill('SIGKILL');await ended;const count=await readFile(join(task,'swap-count'),'utf8');await new Promise(r=>setTimeout(r,100));assert.equal(await readFile(join(task,'swap-count'),'utf8'),count);
 console.log(JSON.stringify({source:'actual-linux-sibling-directory-swap',observed_at:new Date().toISOString(),...facts,all_attack_processes_stopped:true}));
}finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}await gateway.close();await rm(root,{recursive:true,force:true});}
