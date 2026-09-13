import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';

const identities = [
  { token: 'a'.repeat(40), actor: 'backend-a', workspace: 'lab', role: 'caller' as const },
  { token: 'b'.repeat(40), actor: 'backend-b', workspace: 'lab', role: 'caller' as const },
  { token: 'm'.repeat(40), actor: 'operator', workspace: 'lab', role: 'maintainer' as const },
  { token: 'h'.repeat(40), actor: 'monitor', workspace: 'lab', role: 'health' as const },
];
async function lab(t: TestContext, sandbox = new FixtureSandbox(), timeoutSeconds = 60) {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-'));
  const profile = { ...fixtureProfile, timeout_seconds: timeoutSeconds };
  let app = await createApp({ database: join(directory, 'runs.db'), profile, identities, sandbox });
  let url = await app.listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    sandbox,
    async restart() { await app.close(); app = await createApp({ database: join(directory, 'runs.db'), profile, identities, sandbox }); url = await app.listen(); },
    async request(path: string, options: { method?: string; body?: unknown; token?: string; key?: string } = {}) {
      return fetch(url + path, { method: options.method ?? 'GET', headers: {
        Authorization: `Bearer ${options.token ?? identities[0]!.token}`, 'Content-Type': 'application/json',
        'Idempotency-Key': options.key ?? 'first-task',
      }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    },
  };
}
const task = { prompt: 'Return summary "three apples" and value 3.', profile: 'json-lab@1', output_contract: 'summary-value@1' };
async function terminal(l: Awaited<ReturnType<typeof lab>>, id: string) {
  for (let i = 0; i < 200; i++) {
    const run = await (await l.request(`/v1/runs/${id}`)).json();
    if (['succeeded', 'failed', 'timed_out'].includes(run.status) && run.cleanup.status !== 'pending') return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Run did not settle');
}
test('a submitted task survives restart with a validated result and verified cleanup', async t => {
  const l = await lab(t);
  const response = await l.request('/v1/runs', { method: 'POST', body: task });
  assert.equal(response.status, 202);
  const { run_id } = await response.json();
  const run = await terminal(l, run_id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.cleanup.status, 'complete');
  assert.ok(run.cleanup.observed_at);
  assert.equal(run.validation.status, 'passed');
  await l.restart();
  const result = await (await l.request(`/v1/runs/${run_id}/result`)).json();
  assert.deepEqual(result.result, { summary: 'three apples', value: 3 });
  assert.equal((await (await l.request('/v1/runs')).json()).runs.length, 1);
});

test('invalid schema, missing input, and missing authorization fail without an authoritative result', async t => {
  for (const [scenario, failure] of [['invalid', 'output_invalid'], ['input-required', 'input_required'], ['authorization-required', 'authorization_required']] as const) {
    const l = await lab(t, new FixtureSandbox(scenario));
    const { run_id } = await (await l.request('/v1/runs', { method: 'POST', body: task })).json();
    const run = await terminal(l, run_id);
    assert.equal(run.status, 'failed'); assert.equal(run.failure, failure);
    assert.equal((await l.request(`/v1/runs/${run_id}/result`)).status, 409);
    assert.equal(JSON.stringify(run).includes('SYNTHETIC_SECRET'), false);
  }
});
test('preparation failure cleans its allocated resource without starting an Attempt', async t => {
  const l = await lab(t, new FixtureSandbox('prepare-failed'));
  const { run_id } = await (await l.request('/v1/runs', { method: 'POST', body: task })).json();
  const run = await terminal(l, run_id);
  assert.equal(run.failure, 'provisioning_failed'); assert.equal(run.attempt_id, null);
  assert.equal(run.cleanup.status, 'complete'); assert.equal(l.sandbox.resources.size, 0);
});
test('cleanup uncertainty does not rewrite committed success and is retried on restart', async t => {
  const sandbox = new FixtureSandbox('cleanup-unknown'); const l = await lab(t, sandbox);
  const { run_id } = await (await l.request('/v1/runs', { method: 'POST', body: task })).json();
  const run = await terminal(l, run_id);
  assert.equal(run.status, 'succeeded'); assert.equal(run.cleanup.status, 'unknown');
  sandbox.scenario = 'success'; await l.restart();
  assert.equal((await terminal(l, run_id)).cleanup.status, 'complete');
  assert.equal(sandbox.executions.size, 1);
});
test('authentication and server authorization isolate callers and health readers', async t => {
  const l = await lab(t);
  const { run_id } = await (await l.request('/v1/runs', { method: 'POST', body: task })).json();
  await terminal(l, run_id);
  assert.equal((await l.request('/v1/runs', { token: 'invalid' })).status, 401);
  for (const suffix of ['', '/result']) {
    assert.equal((await l.request(`/v1/runs/${run_id}${suffix}`, { token: identities[1]!.token })).status, 404);
    assert.equal((await l.request(`/v1/runs/${run_id}${suffix}`, { token: identities[3]!.token })).status, 403);
  }
  assert.deepEqual((await (await l.request('/v1/runs', { token: identities[1]!.token })).json()).runs, []);
  assert.equal((await l.request('/v1/runs', { token: identities[3]!.token, method: 'POST', body: task })).status, 403);
  const health = await (await l.request('/internal/health', { token: identities[3]!.token })).json();
  assert.equal(health.model.status, 'unknown'); assert.equal(JSON.stringify(health).includes(run_id), false);
  assert.equal((await l.request(`/v1/runs/${run_id}`, { token: identities[2]!.token })).status, 200);
});
test('concurrent duplicate submissions bind one Run, and changed content conflicts', async t => {
  const l = await lab(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => l.request('/v1/runs', { method: 'POST', body: task })));
  const runs = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(runs.map(r => r.run_id)).size, 1);
  await terminal(l, runs[0].run_id);
  assert.equal(l.sandbox.executions.size, 1);
  assert.equal((await l.request('/v1/runs', { method: 'POST', body: { ...task, prompt: 'different' } })).status, 409);
  assert.equal((await l.request('/v1/runs', { method: 'POST', body: { ...task, secret: 'SYNTHETIC_SECRET' }, key: 'bad' })).status, 400);
});

test('the registered runner cannot silently be replaced by a different execution mode', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sandbox = new FixtureSandbox();
  Object.defineProperty(sandbox, 'source', { value: 'opensandbox' });
  await assert.rejects(createApp({ database: join(directory, 'runs.db'), profile: fixtureProfile, identities, sandbox }), /profile_adapter_mismatch/);
});

test('a nonresponsive preparation cannot outlive the platform deadline or lose its cleanup obligation', async t => {
  const sandbox = new FixtureSandbox();
  sandbox.prepare = async () => { await new Promise(resolve => setTimeout(resolve, 2800)); return 'late-resource'; };
  sandbox.cleanup = async () => 'unknown';
  const l = await lab(t, sandbox, 1);
  const { run_id } = await (await l.request('/v1/runs', { method: 'POST', body: task })).json();
  await new Promise(resolve => setTimeout(resolve, 1200));
  const run = await (await l.request(`/v1/runs/${run_id}`)).json();
  assert.equal(run.status, 'timed_out'); assert.equal(run.cleanup.status, 'unknown'); assert.equal(run.attempt_id, null);
});
