import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import type { Run } from '../src/domain.js';

test('real OpenSandbox HTTP adapter requires a fresh 404 after delete, never a delete receipt or access denial', async t => {
  let getStatus = 404;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    res.writeHead(getStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus === 200 ? {
      id: 'owned-resource', image: { uri: 'test' }, entrypoint: ['tail'], status: { state: 'Running' },
      createdAt: new Date().toISOString(), expiresAt: null,
    } : { code: 'test_error', message: 'SYNTHETIC_SECRET must not be observed' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing_address');
  const adapter = new OpenSandboxAdapter({ domain: `http://127.0.0.1:${address.port}`, apiKey: 'test-only-key' }, () => 'not-used');
  const run = { allocation: { resource_id: 'owned-resource', operation_id: 'owned-operation' } } as Run;
  assert.equal(await adapter.cleanup(run), 'absent');
  assert.deepEqual(requests, ['DELETE /v1/sandboxes/owned-resource', 'GET /v1/sandboxes/owned-resource']);
  getStatus = 200; assert.equal(await adapter.cleanup(run), 'present');
  getStatus = 403; await assert.rejects(adapter.cleanup(run));
});

test('an empty provider listing cannot close an unknown create operation', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0, hasNextPage: false } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing_address');
  const adapter = new OpenSandboxAdapter({ domain: `http://127.0.0.1:${address.port}`, apiKey: 'test-only-key' }, () => 'not-used');
  assert.equal(await adapter.cleanup({ run_id: 'run', allocation: { resource_id: null, operation_id: 'op' } } as Run), 'unknown');
});
test('forced stop uses provider deletion plus a fresh resource observation and preserves uncertainty', async t => {
  let present=true; const calls: string[]=[];
  const server=createServer((req,res)=>{calls.push(`${req.method} ${req.url}`); if(req.method==='DELETE'){res.writeHead(204);res.end();return;} res.writeHead(present?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(present?{id:'owned',image:{uri:'test'},entrypoint:['tail'],status:{state:'Running'},createdAt:new Date().toISOString(),expiresAt:null}:{code:'not_found',message:'gone'}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const address=server.address(); if(!address||typeof address==='string') throw new Error('address');
  const adapter=new OpenSandboxAdapter({domain:`http://127.0.0.1:${address.port}`,apiKey:'test'},()=> 'unused');
  const run={allocation:{resource_id:'owned',operation_id:'op'}} as Run;
  assert.equal(await adapter.forceStop(run),'unknown'); present=false; assert.equal(await adapter.forceStop(run),'stopped');
  assert.deepEqual(calls,['DELETE /v1/sandboxes/owned','GET /v1/sandboxes/owned','DELETE /v1/sandboxes/owned','GET /v1/sandboxes/owned']);
});
test('an already cancelled execution cannot connect or start a new command',async()=>{
  const adapter=new OpenSandboxAdapter({domain:'http://127.0.0.1:1',apiKey:'test'},()=> 'unused');
  const controller=new AbortController();controller.abort(new Error('cancelled-before-dispatch'));
  await assert.rejects(adapter.execute({} as Run,controller.signal),/cancelled-before-dispatch/);
});
