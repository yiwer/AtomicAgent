// Trusted entrypoint, separate from the API, worker, provider and Agent processes.
// Exiting the container entrypoint ends its PID namespace. Host guardian owns deletion.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
const [deadlineText,workspaceText]=process.argv.slice(2);
const deadline=Number(deadlineText),workspace=Number(workspaceText);
if(!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>Date.now()+3601000||!Number.isSafeInteger(workspace)||workspace<33554434||workspace>190840832)process.exit(125);
const timer=setTimeout(()=>process.exit(124),Math.max(1,deadline-Date.now()));
try {
 await mkdir('/workspace',{recursive:true,mode:0o700});
 await mkdir('/run/atomicagent',{recursive:true,mode:0o700});await chmod('/run/atomicagent',0o700);
 execFileSync('/bin/mount',['-t','tmpfs','-o',`size=${workspace},mode=0700,uid=1000,gid=1000,nosuid,nodev`,'tmpfs','/workspace'],{stdio:'ignore'});
 const cpu=(await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim().split(' ');
 const memory=Number((await readFile('/sys/fs/cgroup/memory.max','utf8')).trim());
 const events=Object.fromEntries((await readFile('/sys/fs/cgroup/memory.events','utf8')).trim().split('\n').map(line=>{const [key,value]=line.split(' ');return [key,Number(value)];}));
 await writeFile('/run/atomicagent/resources.json',JSON.stringify({source:'trusted-supervisor:cgroup-v2-and-tmpfs',observed_at:new Date().toISOString(),cpu_quota:Number(cpu[0]),cpu_period:Number(cpu[1]),memory_bytes:memory,workspace_bytes:workspace,deadline_at:new Date(deadline).toISOString(),memory_events:events}),{mode:0o600,flag:'wx'});
}catch{clearTimeout(timer);process.exit(125);}
