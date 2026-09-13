import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';
import { OpenSandboxAdapter } from '../src/opensandbox.js';
import { RoutedSandbox } from '../src/profile-routing.js';
import { contentDigest } from '../src/submission.js';

test('an old live obligation cannot be closed by another account 404 without explicit legacy provider binding confirmation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-provider-migrate-'));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(req.method === 'DELETE' ? 204 : 404, { 'Content-Type': 'application/json' });
    res.end(req.method === 'DELETE' ? undefined : JSON.stringify({ code: 'not_found', message: 'This test account cannot see the resource' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  const provider = { ref: 'legacy-provider', endpoint: `http://127.0.0.1:${address.port}`, api_key_ref: 'CURRENT_ACCOUNT_REFERENCE' };
  const profile = { ...fixtureProfile, mode: 'opensandbox' as const, image: `test/runner@sha256:${'1'.repeat(64)}`, model: 'approved-test', endpoint: 'https://model.example.com',
    provider_ref: provider.ref, provider_endpoint: provider.endpoint, linux_node: 'test-node', approval_ref: 'controlled-test-only' };
  const identities = [{ token: 'm'.repeat(40), actor: 'operator', workspace: 'lab', role: 'maintainer' as const }];
  const initialPort = new FixtureSandbox('cleanup-unknown'); Object.defineProperty(initialPort, 'source', { value: 'opensandbox' });
  const database = join(directory, 'runs.db');
  // Models the pre-05 public application, which persisted the frozen provider ref/endpoint but no credential-variable mapping.
  const first = await createApp({ database, profile, identities, sandbox: initialPort }); const firstUrl = await first.listen();
  const headers = { Authorization: `Bearer ${identities[0]!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'legacy-live' };
  const accepted = await (await fetch(firstUrl + '/v1/runs?wait_seconds=5', { method: 'POST', headers,
    body: JSON.stringify({ prompt: 'three apples', profile: profile.id, output_contract: 'summary-value@1' }) })).json();
  await first.close();
  assert.equal(accepted.cleanup.status, 'unknown');
  const routed = new RoutedSandbox([profile], p => new OpenSandboxAdapter({ domain: p.provider_endpoint, apiKey: 'controlled-other-account' }, () => 'not-used'));
  const binding = { id: `provider:${provider.ref}`, document: contentDigest(provider) };
  await assert.rejects(async () => {
    const unsafe = await createApp({ database, profile, identities, sandbox: routed, deploymentBindings: [binding] }); await unsafe.close();
  }, /legacy_provider_binding_confirmation_required/);
  assert.deepEqual(requests, [], 'no DELETE or wrong-account GET may occur before explicit confirmation');
  const attested = await createApp({ database, profile, identities, sandbox: routed,
    deploymentBindings: [{ ...binding, legacyApproval: `approval-${'1'.repeat(64)}` }] });
  const attestedUrl = await attested.listen();
  try {
    const recovered = await (await fetch(`${attestedUrl}/v1/runs/${accepted.run_id}`, { headers })).json();
    assert.equal(recovered.execution.manifest_digest, accepted.execution.manifest_digest);
    assert.equal(recovered.cleanup.status, 'complete');
    assert.equal(requests.length, 2, 'the explicitly confirmed test binding enables the controlled fresh disposal observation');
  } finally { await attested.close(); }
  await assert.rejects(async () => {
    const changed = await createApp({ database, profile, identities, sandbox: routed, deploymentBindings: [{ ...binding, document: contentDigest({ ...provider, api_key_ref: 'DIFFERENT_ACCOUNT_REFERENCE' }) }] }); await changed.close();
  }, /immutable_deployment_binding_conflict/);
});
