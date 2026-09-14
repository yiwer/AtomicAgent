import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { waitForPermit } from '../src/action-permit.js';
test('an action cannot start on another Attempt receipt, and cancellation ends an unacknowledged intent',async t=>{
 const root=await mkdtemp(join(tmpdir(),'atomic-permit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id=randomUUID(),signal=new AbortController();let started=false;
 const pending=waitForPermit(root,{run_id:'run',attempt_id:'attempt',invocation_id:id},Date.now()+5000,signal.signal).then(()=>{started=true;});
 await writeFile(join(root,`permit-${id}.json`),JSON.stringify({run_id:'run',attempt_id:'old',invocation_id:id,allowed:true}));
 await new Promise(r=>setTimeout(r,150));assert.equal(started,false);signal.abort();await assert.rejects(pending);assert.equal(started,false);
});
