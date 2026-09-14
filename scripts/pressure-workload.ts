// Explicit host-operated fault injection into one owned experiment container; not an Agent tool.
import { open, unlink } from 'node:fs/promises';
if(process.env.ATOMIC_LIMIT_EXPERIMENT!=='ticket11')throw new Error('experiment_only');
if(process.argv[2]==='cpu'){const end=Date.now()+4000;let x=1;while(Date.now()<end)x=Math.sin(x)+1;console.log(JSON.stringify({cpu_work_completed:true}));}
else if(process.argv[2]==='memory'){const chunks:Buffer[]=[];for(let i=0;i<192;i++){chunks.push(Buffer.alloc(4*1024*1024,1));await new Promise(r=>setTimeout(r,10));}console.log(JSON.stringify({allocated:chunks.length*4*1024*1024}));}
else if(process.argv[2]==='workspace'){const file=await open('/workspace/quota-pressure','wx');let written=0;try{const chunk=Buffer.alloc(1024*1024,1);for(let i=0;i<200;i++){await file.write(chunk);written+=chunk.length;}throw new Error('quota_not_enforced');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOSPC')throw error;console.log(JSON.stringify({workspace_quota:'ENOSPC',written_bytes:written}));}finally{await file.close();await unlink('/workspace/quota-pressure');}}
else throw new Error('unknown_experiment');
