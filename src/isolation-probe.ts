import { readFile, mkdir } from 'node:fs/promises';
import { isolatedQuery } from './isolated-query.js';

// Trusted, digest-qualified runtime only. This capability probe receives no model credential and starts no CLI.
const sdk=JSON.parse(await readFile('/opt/atomicagent/node_modules/@anthropic-ai/claude-agent-sdk/package.json','utf8'));
if(process.version!=='v24.18.0'||sdk.version!=='0.3.270')throw new Error('isolation_unavailable');
await mkdir('/run/atomicagent/probe',{mode:0o700});
const isolation=await isolatedQuery({run_id:'probe',attempt_id:'probe',prompt:'',model:'probe',endpoint:'https://probe.invalid',deadline_at:new Date(Date.now()+10000).toISOString()},'/workspace','/run/atomicagent/probe',async()=>{throw new Error('probe_has_no_external_authority');});
await isolation.close();
process.stdout.write('atomic-isolation-v1:node24.18.0:sdk0.3.270:permit-v1\n');
