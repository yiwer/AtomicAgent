import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import { sha256 } from '../src/files.js';
import { fixtureProfile } from '../src/profile.js';
import type { Run, InputBinding } from '../src/domain.js';
for (const scenario of ['verified', 'corrupt-copy', 'partial-copy', 'symlink-copy'] as const) test(`production OpenSandbox adapter ${scenario} validates the actual Artifact input target over SDK HTTP`, async t => {
 const bytes = Buffer.from('id,category,value\na,x,0.3\n'); let host = '', uploads = 0, downloaded = false;
 const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://test'); res.setHeader('Content-Type', 'application/json');
  if (url.pathname.includes('/endpoints/')) { res.end(JSON.stringify({ endpoint: host, headers: {} })); return; }
  if (url.pathname === '/ping') { res.end('{}'); return; }
  if (url.pathname === '/directories') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/files/upload') { uploads++; let raw = ''; for await (const chunk of req) raw += chunk.toString(); assert.ok(raw.includes('/workspace/input/reuse.csv')); assert.ok(raw.includes(bytes.toString())); res.writeHead(204); res.end(); return; }
  if (url.pathname === '/files/info') { res.end(JSON.stringify({ '/workspace/input/reuse.csv': { type: scenario === 'symlink-copy' ? 'symlink' : 'file', size: scenario === 'partial-copy' ? 1 : bytes.length } })); return; }
  if (url.pathname === '/files/download') { downloaded = true; res.end(scenario === 'corrupt-copy' ? Buffer.alloc(bytes.length, 120) : bytes); return; }
  res.writeHead(404); res.end('{}');
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
 const address = server.address(); if (!address || typeof address === 'string') throw new Error('address'); host = `127.0.0.1:${address.port}`;
 const adapter = new OpenSandboxAdapter({ domain: `http://${host}`, apiKey: 'test-only' }, () => 'unused');
 const binding: InputBinding = { binding_id: 'new-binding', file_id: 'source-artifact', source: { kind: 'artifact', artifact_id: 'source-artifact', run_id: 'old-run', expires_at: new Date(Date.now()+30000).toISOString() }, path: 'input/reuse.csv', format: 'csv', sha256: sha256(bytes), size_bytes: bytes.length, owner: 'a', workspace: 'lab', expires_at: new Date(Date.now()+30000).toISOString(), loaded: false };
 const run = { run_id: 'new-run', allocation: { resource_id: 'new-sandbox', operation_id: 'new-operation' }, manifest: { profile: fixtureProfile, grant: { inputs: [binding] }, deadline_at: new Date(Date.now()+30000).toISOString() } } as Run;
 const copy = adapter.loadInputs(run, [{ binding, bytes }]);
 if (scenario === 'verified') { await copy; assert.equal(downloaded, true); }
 else await assert.rejects(copy, { code: 'input_required' });
 assert.equal(uploads, 1);
});
