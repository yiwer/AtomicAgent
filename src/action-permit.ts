import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { TaskError } from './domain.js';
export async function waitForPermit(root:string, intent:{run_id:string;attempt_id:string;invocation_id:string}, deadline:number, signal:AbortSignal) {
 if(!/^[0-9a-f-]{36}$/.test(intent.invocation_id))throw new TaskError('authorization_required');
 while(Date.now()<deadline) {
  signal.throwIfAborted();
  try {
   const raw=await readFile(join(root,`permit-${intent.invocation_id}.json`),'utf8');
   if(raw.length<1024){const receipt=JSON.parse(raw);if(receipt.run_id===intent.run_id&&receipt.attempt_id===intent.attempt_id&&receipt.invocation_id===intent.invocation_id&&receipt.allowed===true){signal.throwIfAborted();return;}}
  }catch{/* Incomplete, missing and mismatched receipts never authorize. */}
  await setTimeout(50,undefined,{signal});
 }
 throw new TaskError('execution_lost');
}
