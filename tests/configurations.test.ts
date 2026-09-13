import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';
import { DatabaseSync } from 'node:sqlite';
import type { Profile, Run } from '../src/domain.js';
import { RoutedSandbox } from '../src/profile-routing.js';

const identities = [
  { token: 'm'.repeat(40), actor: 'operator', workspace: 'lab', role: 'maintainer' as const },
  { token: 'c'.repeat(40), actor: 'backend', workspace: 'lab', role: 'caller' as const },
  { token: 'x'.repeat(40), actor: 'operator', workspace: 'other', role: 'maintainer' as const },
];
async function lab(t: TestContext, approvedProfiles: Profile[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-config-'));
  const sandbox = new FixtureSandbox();
  const options = { database: join(directory, 'runs.db'), profile: fixtureProfile, identities, sandbox, approvedProfiles };
  let app = await createApp(options), url = await app.listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { sandbox, database: options.database,
    async restart() { await app.close(); app = await createApp(options); url = await app.listen(); },
    async request(path: string, data?: unknown, key = 'command-1', token = identities[0]!.token) {
      return fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
      }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    },
  };
}

test('maintainer previews and publishes an independent immutable environment revision, then uses it in an ordinary Run', async t => {
  const l = await lab(t);
  const response = await l.request('/v1/configurations');
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.models[0].compatibility.status, 'unverified');
  const command = { action: 'publish', kind: 'environment', name: 'json-lab', expected_generation: 1,
    content: { binding_ref: catalog.bindings.environments[0].binding_ref, timeout_seconds: 30 }, reason: 'Short task limit' };
  const preview = await (await l.request('/v1/configurations/preview', command)).json();
  assert.deepEqual(preview.changes, [{ field: 'timeout_seconds', before: 60, after: 30 }]);
  assert.match(preview.impact.new_runs, /explicit/);
  const published = await l.request('/v1/configurations/commands', { ...command, preview_digest: preview.preview_digest });
  assert.equal(published.status, 200);
  const receipt = await published.json();
  assert.equal(receipt.revision.version, '2');
  assert.equal(receipt.revision.content.timeout_seconds, 30);
  assert.match(receipt.revision.content_digest, /^[a-f0-9]{64}$/);
  assert.notEqual(receipt.revision.content_digest, catalog.environments[0].content_digest);
  const runResponse = await l.request('/v1/runs?wait_seconds=5', { prompt: 'three apples',
    environment: { profile_id: 'json-lab', version: '2' }, model: { profile_id: 'json-lab', version: '1' }, output_contract: 'summary-value@1' }, 'run-1');
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.execution.environment, { profile_id: 'json-lab', version: '2' });
  assert.deepEqual(run.execution.model_revision, { profile_id: 'json-lab', version: '1' });
  await l.restart();
  const after = await (await l.request('/v1/configurations')).json();
  assert.equal(after.environments.length, 2);
  assert.equal(after.environments[0].content.timeout_seconds, 60);
  assert.equal(after.environments[1].content.timeout_seconds, 30);
  const old = await (await l.request(`/v1/runs/${run.run_id}`)).json();
  assert.equal(old.execution.manifest_digest, run.execution.manifest_digest);
});

test('independent model registration actually reaches the execution port; disabling an in-flight revision retains its frozen grant', async t => {
  const second = { ...fixtureProfile, id: 'approved-second@1', model: 'fixture:second-model', image: 'fixture:second-image', timeout_seconds: 20 };
  const l = await lab(t, [second]);
  const catalog = await (await l.request('/v1/configurations')).json();
  const invalidEnvironment = { action: 'publish', kind: 'environment', name: 'too-long', expected_generation: 0, reason: 'Test approved image bounds',
    content: { binding_ref: catalog.bindings.environments[0].binding_ref, image: second.image, timeout_seconds: 21 } };
  assert.equal((await l.request('/v1/configurations/preview', invalidEnvironment)).status, 400);
  const command = { action: 'publish', kind: 'model', name: 'alternate', expected_generation: 0, reason: 'Select another approved model',
    content: { binding_ref: catalog.bindings.models[0].binding_ref, model: second.model } };
  const preview = await (await l.request('/v1/configurations/preview', command)).json();
  assert.equal((await l.request('/v1/configurations/commands', { ...command, preview_digest: preview.preview_digest }, 'model-publish')).status, 200);
  let started!: (run: Run) => void, release!: () => void;
  const observed = new Promise<Run>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = l.sandbox.execute.bind(l.sandbox);
  l.sandbox.execute = async (run, signal) => { started(structuredClone(run)); await gate; return execute(run, signal); };
  t.after(() => release());
  const task = { prompt: 'three apples', environment: { profile_id: 'json-lab', version: '1' }, model: { profile_id: 'alternate', version: '1' }, output_contract: 'summary-value@1' };
  const accepted = await (await l.request('/v1/runs', task, 'frozen-task')).json();
  const invoked = await observed;
  assert.equal(invoked.manifest.profile.model, 'fixture:second-model');
  assert.equal(invoked.manifest.profile.image, fixtureProfile.image);
  const disable = { action: 'disable', kind: 'model', name: 'alternate', version: '1', expected_generation: 1, reason: 'Stop new tasks only' };
  const impact = await (await l.request('/v1/configurations/preview', disable)).json();
  assert.equal(impact.impact.existing_runs[0].status, 'running');
  assert.equal((await l.request('/v1/configurations/commands', { ...disable, preview_digest: impact.preview_digest }, 'disable-active')).status, 200);
  assert.equal((await l.request('/v1/runs', task, 'another-task')).status, 400);
  release();
  const result = await (await l.request('/v1/runs?wait_seconds=5', task, 'frozen-task')).json();
  assert.equal(result.status, 'succeeded'); assert.equal(result.execution.manifest_digest, accepted.execution.manifest_digest);
});

test('configuration state, command receipt and audit roll back together on storage failure and recover under the original command identity', async t => {
  const l = await lab(t);
  const command = { action: 'disable', kind: 'environment', name: 'json-lab', version: '1', expected_generation: 1, reason: 'Storage fault seam' };
  const preview = await (await l.request('/v1/configurations/preview', command)).json();
  const body = { ...command, preview_digest: preview.preview_digest };
  const db = new DatabaseSync(l.database);
  try {
    db.exec("CREATE TRIGGER audit_fault BEFORE INSERT ON audit WHEN NEW.action='configuration.disable' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET'); END;");
    const failed = await l.request('/v1/configurations/commands', body, 'recover-original');
    assert.equal(failed.status, 503); assert.equal((await failed.json()).error, 'service_unavailable');
    assert.equal((await (await l.request('/v1/configurations')).json()).environments[0].enabled, true);
    db.exec('DROP TRIGGER audit_fault');
  } finally { db.close(); }
  await l.restart();
  const recovered = await (await l.request('/v1/configurations/commands', body, 'recover-original')).json();
  assert.equal(recovered.command_id, 'recover-original'); assert.equal(recovered.revision.enabled, false);
});

test('configuration commands reject arbitrary secrets, endpoints, mounts, scripts and invented compatibility evidence', async t => {
  const l = await lab(t);
  const catalog = await (await l.request('/v1/configurations')).json();
  const command = { action: 'publish', kind: 'model', name: 'denied', expected_generation: 0, reason: 'Reject privilege expansion',
    content: { binding_ref: catalog.bindings.models[0].binding_ref, model: fixtureProfile.model } };
  for (const extra of [{ secret_ref: 'OTHER_ACCOUNT_TOKEN' }, { endpoint: 'https://attacker.example.com' }, { mounts: ['/home'] }, { script: 'sh' }, { compatibility: 'verified' }]) {
    assert.equal((await l.request('/v1/configurations/preview', { ...command, content: { ...command.content, ...extra } })).status, 400);
  }
  assert.equal((await l.request('/v1/configurations/preview', { ...command, content: { ...command.content, model: 'unapproved-model' } })).status, 400);
  const caller = await (await l.request('/v1/configurations', undefined, '', identities[1]!.token)).json();
  assert.equal(caller.bindings, undefined); assert.ok(!JSON.stringify(caller).includes('secret_ref'));
});

test('a connection change preview names the actual endpoint and credential identity without exposing secret references', async t => {
  const alternate = { ...fixtureProfile, id: 'connection-change@1', endpoint: 'https://second-fixture.invalid', secret_ref: 'PRIVATE_MODEL_REFERENCE', approval_ref: 'fixture-connection-test' };
  const l = await lab(t, [alternate]);
  const catalog = await (await l.request('/v1/configurations')).json();
  const connection = catalog.bindings.models.find((b: { endpoint: string }) => b.endpoint === alternate.endpoint);
  const command = { action: 'publish', kind: 'model', name: 'json-lab', expected_generation: 1, reason: 'Review changed connection',
    content: { binding_ref: connection.binding_ref, model: alternate.model } };
  const preview = await (await l.request('/v1/configurations/preview', command)).json();
  assert.ok(preview.changes.some((c: { field: string; before: string; after: string }) => c.field === 'endpoint' && c.before === fixtureProfile.endpoint && c.after === alternate.endpoint));
  assert.ok(preview.changes.some((c: { field: string }) => c.field === 'credential_identity'));
  assert.ok(!JSON.stringify(preview).includes('PRIVATE_MODEL_REFERENCE'));
  assert.equal((await l.request('/v1/configurations/commands', { ...command, preview_digest: preview.preview_digest }, 'new-connection')).status, 200);
  await l.restart();
  const after = await (await l.request('/v1/configurations')).json();
  assert.equal(after.models[1].definition.endpoint, alternate.endpoint);
});

test('pre-05 databases retain old fixed references and cleanup routing while a different default serves new Runs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-config-migrate-'));
  const database = join(directory, 'runs.db'), sandbox = new FixtureSandbox('cleanup-unknown');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const headers = { Authorization: `Bearer ${identities[0]!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'legacy-key' };
  const task = { prompt: 'three apples', profile: fixtureProfile.id, output_contract: 'summary-value@1' };
  const first = await createApp({ database, profile: fixtureProfile, identities, sandbox }); const url = await first.listen();
  const accepted = await (await fetch(url + '/v1/runs?wait_seconds=5', { method: 'POST', headers, body: JSON.stringify(task) })).json();
  await first.close();
  const oldDb = new DatabaseSync(database);
  oldDb.exec('DROP TABLE configuration_state; DROP TABLE configuration_commands; DROP TABLE deployment_bindings;'); oldDb.close();
  const newDefault = { ...fixtureProfile, id: 'next-default@1', model: 'fixture:next-model', image: 'fixture:next-image' };
  const cleaned: Profile[] = [];
  const originalCleanup = sandbox.cleanup.bind(sandbox); sandbox.scenario = 'success';
  sandbox.cleanup = async run => { cleaned.push(structuredClone(run.manifest.profile)); return originalCleanup(run); };
  const routed = new RoutedSandbox([newDefault, fixtureProfile], () => sandbox);
  const second = await createApp({ database, profile: newDefault, approvedProfiles: [fixtureProfile], identities, sandbox: routed }); const nextUrl = await second.listen();
  try {
    assert.deepEqual(cleaned, [fixtureProfile]);
    const recovered = await (await fetch(nextUrl + '/v1/runs', { method: 'POST', headers, body: JSON.stringify(task) })).json();
    assert.equal(recovered.run_id, accepted.run_id); assert.equal(recovered.execution.manifest_digest, accepted.execution.manifest_digest);
    const catalog = await (await fetch(nextUrl + '/v1/configurations', { headers })).json();
    assert.ok(catalog.environments.some((r: { name: string }) => r.name === 'json-lab'));
    assert.ok(catalog.environments.some((r: { name: string }) => r.name === 'next-default'));
    const next = await (await fetch(nextUrl + '/v1/runs?wait_seconds=5', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'next-key' },
      body: JSON.stringify({ ...task, profile: newDefault.id }) })).json();
    assert.equal(next.execution.model, 'fixture:next-model');
  } finally { await second.close(); }
});

test('disable retains old grants and idempotency recovery; conflicts, command replay and authorization survive restart', async t => {
  const l = await lab(t);
  const task = { prompt: 'three apples', profile: 'json-lab@1', output_contract: 'summary-value@1' };
  const accepted = await (await l.request('/v1/runs?wait_seconds=5', task, 'old-task')).json();
  const command = { action: 'disable', kind: 'model', name: 'json-lab', version: '1', expected_generation: 1, reason: 'Stop new admission' };
  const preview = await (await l.request('/v1/configurations/preview', command)).json();
  assert.equal(preview.impact.existing_run_count, 1);
  assert.equal(preview.impact.existing_runs[0].run_id, accepted.run_id);
  const body = { ...command, preview_digest: preview.preview_digest };
  const results = await Promise.all(['disable-1', 'disable-2'].map(key => l.request('/v1/configurations/commands', body, key)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const key = results[0]!.status === 200 ? 'disable-1' : 'disable-2';
  const receipt = await results.find(r => r.status === 200)!.json();
  assert.equal((await l.request('/v1/runs', task, 'new-task')).status, 400);
  const recovered = await (await l.request('/v1/runs', task, 'old-task')).json();
  assert.equal(recovered.run_id, accepted.run_id);
  assert.equal(recovered.execution.manifest_digest, accepted.execution.manifest_digest);
  await l.restart();
  assert.deepEqual(await (await l.request('/v1/configurations/commands', body, key)).json(), receipt);
  assert.equal((await l.request('/v1/configurations/commands', { ...body, reason: 'Different content' }, key)).status, 409);
  assert.equal((await l.request('/v1/configurations/preview', command, 'denied', identities[1]!.token)).status, 403);
  const other = await (await l.request('/v1/configurations', undefined, '', identities[2]!.token)).json();
  assert.equal(other.models[0].enabled, true);
  const audit = await (await l.request('/v1/configurations/audit')).json();
  assert.equal(audit.records.filter((r: { action: string }) => r.action === 'configuration.disable').length, 1);
  assert.equal(audit.records.find((r: { action: string }) => r.action === 'configuration.disable').operation_id, key);
  const enable = { ...command, action: 'enable', expected_generation: 2 };
  const enablePreview = await (await l.request('/v1/configurations/preview', enable)).json();
  assert.equal((await l.request('/v1/configurations/commands', { ...enable, preview_digest: enablePreview.preview_digest }, 'enable-1')).status, 200);
  assert.equal((await l.request('/v1/runs?wait_seconds=5', task, 'new-task')).status, 200);
});
