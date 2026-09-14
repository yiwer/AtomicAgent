import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import { fixtureProfile } from '../src/profile.js';
import { requestedSkills, registeredSkills, type SkillEvidence } from '../src/skills.js';
import type { Run } from '../src/domain.js';

for (const scenario of ['completed', 'started', 'wrong-attempt', 'partial', 'oversized'] as const) {
 test(`OpenSandbox command failure imports only matching bounded ${scenario} hook journal and never returns success`, async t => {
   const skill = { ...registeredSkills[0]!, id: 'statistics', version: '1', must_use: true };
   const evidence = requestedSkills([skill]).map(e => ({ ...e, materialized: true, loaded: true, callable: true, used: scenario === 'started' ? null : true, invocation_id: scenario === 'started' ? null : 'tool-1', attempt_id: 'attempt', observed_at: new Date().toISOString() }));
   const document = JSON.stringify({ run_id: 'run', attempt_id: scenario === 'wrong-attempt' ? 'other' : 'attempt', skills: evidence }) + (scenario === 'partial' ? '' : '\n');
   let host = '', commands = 0, uploaded = '';
   const server = createServer(async (req, res) => {
     const url = new URL(req.url!, 'http://test');
     res.setHeader('Content-Type', 'application/json');
     if (url.pathname.includes('/endpoints/')) { res.end(JSON.stringify({ endpoint: host, headers: {} })); return; }
     if (url.pathname === '/ping') { res.end('{}'); return; }
     if (url.pathname === '/directories') { res.writeHead(204); res.end(); return; }
     if (url.pathname === '/files/upload') { for await (const chunk of req) uploaded += String(chunk); res.writeHead(204); res.end(); return; }
     if (url.pathname === '/command') { let body='';for await(const chunk of req)body+=String(chunk);
       if(body.includes('isolation-probe.js')){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({type:'stdout',text:'atomic-isolation-v1:node24.18.0:sdk0.3.270:permit-v1'})+'\n\ndata: '+JSON.stringify({type:'execution_complete',execution_time:1})+'\n\n');return;}
       commands++; res.writeHead(500); res.end('{"message":"SYNTHETIC_SECRET"}'); return; }
     if (url.pathname === '/files/info') { res.end(JSON.stringify({ '/run/atomicagent/skill-evidence.jsonl': { type: 'file', size: scenario === 'oversized' ? 256001 : Buffer.byteLength(document) } })); return; }
     if (url.pathname === '/files/download') { res.end(document); return; }
     res.writeHead(404); res.end('{}');
   });
   await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
   const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing_address'); host = `127.0.0.1:${address.port}`;
   const adapter = new OpenSandboxAdapter({ domain: 'http://' + host, apiKey: 'test' }, () => 'synthetic-model-token',[fixtureProfile.image]);
   const run = { run_id: 'run', attempt_id: 'attempt', prompt: 'file task', allocation: { resource_id: 'sandbox', operation_id: 'allocation' }, manifest: { profile: { ...fixtureProfile, mode: 'opensandbox' }, skills: [skill], output_contract: 'data-statistics@1', deadline_at: new Date(Date.now()+30000).toISOString(), grant: { inputs: [] } } } as unknown as Run;
   let observed: SkillEvidence[] | undefined;
   await assert.rejects(adapter.execute(run, new AbortController().signal, e => { observed = e; }));
   assert.equal(commands, 1); assert.ok(uploaded.includes('atomic-registered:data-statistics'));
   if (scenario === 'completed' || scenario === 'started') { assert.equal(observed?.[0]?.used, scenario === 'completed' ? true : null); assert.equal(observed?.[0]?.attempt_id, 'attempt'); }
   else assert.equal(observed, undefined);
 });
}
