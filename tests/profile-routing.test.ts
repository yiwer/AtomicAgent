import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RoutedSandbox } from '../src/profile-routing.js';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import { fixtureProfile } from '../src/profile.js';
import type { Run } from '../src/domain.js';

test('frozen provider identities route disposal to each actual HTTP provider and reject changed credentials or endpoints', async t => {
  const requests: string[][] = [[], []];
  const profiles = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer((req, res) => {
      requests[i]!.push(`${req.method} ${req.url}`);
      res.writeHead(req.method === 'DELETE' ? 204 : 404, { 'Content-Type': 'application/json' }); res.end(req.method === 'DELETE' ? undefined : JSON.stringify({ code: 'not_found', message: 'missing' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
    profiles.push({ ...fixtureProfile, id: `runtime-${i}@1`, mode: 'opensandbox' as const,
      provider_ref: `provider-${i}`, provider_endpoint: `http://127.0.0.1:${address.port}`, secret_ref: `MODEL_${i}`, endpoint: `https://model-${i}.example.com` });
  }
  const routed = new RoutedSandbox(profiles, profile => new OpenSandboxAdapter({ domain: profile.provider_endpoint, apiKey: 'test-only' }, () => 'unused'));
  for (const profile of profiles) {
    const run = { manifest: { profile }, allocation: { resource_id: 'owned-resource', operation_id: 'owned-operation' } } as Run;
    assert.equal(await routed.cleanup(run), 'absent');
  }
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ['DELETE /v1/sandboxes/owned-resource', 'GET /v1/sandboxes/owned-resource']));
  assert.equal(routed.supports({ ...profiles[0]!, provider_endpoint: profiles[1]!.provider_endpoint }), false);
  assert.equal(routed.supports({ ...profiles[0]!, secret_ref: 'UNRELATED_ACCOUNT_SECRET' }), false);
  const old = { ...profiles[0]!, image: 'old-image-no-longer-approved', node: 'old-runtime', model: 'removed-model', secret_ref: 'REMOVED_MODEL_SECRET' };
  assert.equal(routed.supports(old), false);
  assert.equal(routed.supports(old, 'cleanup'), true, 'removing execution templates must not strand a resource at an approved provider');
  assert.equal(await routed.cleanup({ manifest: { profile: old }, allocation: { resource_id: 'old-resource', operation_id: 'old-operation' } } as Run), 'absent');
  assert.deepEqual(requests[0]!.slice(-2), ['DELETE /v1/sandboxes/old-resource', 'GET /v1/sandboxes/old-resource']);
});
