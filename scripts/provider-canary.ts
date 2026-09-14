import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, chown } from 'node:fs/promises';
import { existsSync } from 'node:fs';
if(process.platform!=='linux'||process.env.ATOMIC_ISOLATION_EXPERIMENT!=='ticket10')throw new Error('experiment_only');
const paths=['/workspace/a-canary','/workspace/.claude-isolated/inherited-marker','/workspace/a-heartbeat'];
const mode=process.argv[2];
if(mode==='heartbeat'){
 setInterval(()=>{void writeFile(paths[2]!,String(Date.now()));},50);
}else if(mode==='A'){
 await mkdir('/workspace/.claude-isolated',{recursive:true});
 await chown('/workspace',1000,1000);await chown('/workspace/.claude-isolated',1000,1000);
 await writeFile(paths[0]!,'synthetic-run-A-marker');await writeFile(paths[1]!,'synthetic-run-A-config');
 const child=spawn(process.execPath,[process.argv[1]!,'heartbeat'],{detached:true,stdio:'ignore'});child.unref();
 await new Promise(r=>setTimeout(r,200));const before=await readFile(paths[2]!,'utf8');await new Promise(r=>setTimeout(r,150));assert.notEqual(await readFile(paths[2]!,'utf8'),before);
 console.log(JSON.stringify({mode,child_pid:child.pid,marker_written:true,heartbeat_advancing:true}));
}else if(mode==='B'){
 for(const path of paths)assert.equal(existsSync(path),false);
 console.log(JSON.stringify({mode,prior_file_config_heartbeat_absent:true}));
}else throw new Error('experiment_mode');
