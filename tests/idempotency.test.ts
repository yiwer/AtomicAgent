import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { fixtureProfile } from '../src/profile.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';

const identities = [
  { actor: 'caller-a', workspace: 'lab', role: 'caller' as const, token: 'a'.repeat(40) },
  { actor: 'caller-b', workspace: 'lab', role: 'caller' as const, token: 'b'.repeat(40) },
  { actor: 'caller-a', workspace: 'other', role: 'caller' as const, token: 'c'.repeat(40) },
  { actor: 'health', workspace: 'lab', role: 'health' as const, token: 'h'.repeat(40) },
];
const task = { prompt: 'Return three apples.', profile: fixtureProfile.id, output_contract: 'summary-value@1' };
async function lab(t: TestContext, sandbox = new FixtureSandbox()) {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-idempotency-'));
  const options = { database: join(directory, 'runs.db'), profile: fixtureProfile, identities, sandbox };
  let app = await createApp(options); let url = await app.listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    sandbox,
    async restart() { await app.close(); app = await createApp(options); url = await app.listen(); },
    request(path: string, body?: unknown, key = 'same-key', token = identities[0]!.token) {
      return fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
  };
}

test('JSON member order does not change the identity of a file submission', async t => {
  const l = await lab(t);
  const file = await (await l.request('/v1/files', { format: 'csv', content: 'id,category,value\na,x,3\n' })).json();
  const body = { ...task, output_contract: 'data-statistics@1', inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] };
  const first = await (await l.request('/v1/runs', body)).json();
  const retry = await l.request('/v1/runs', { ...body, inputs: [{ path: 'input/data.csv', file_id: file.file_id }] });
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).run_id, first.run_id);
  await l.restart();
  const completed = await (await l.request(`/v1/runs/${first.run_id}`)).json();
  assert.equal(completed.inputs[0].loaded, true);
  assert.equal(completed.execution.manifest_digest, first.execution.manifest_digest);
  const future = Date.now() + 2 * 24 * 3600_000;
  t.mock.method(Date, 'now', () => future);
  const expiredReplay = await l.request('/v1/runs', body);
  assert.equal(expiredReplay.status, 202);
  assert.equal((await expiredReplay.json()).run_id, first.run_id);
  assert.equal((await l.request('/v1/runs', body, 'new-expired-input')).status, 410);
  assert.equal(l.sandbox.executions.size, 1);
});

test('same key conflicts for every changed execution field and is isolated by actor and workspace', async t => {
  const l = await lab(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => l.request('/v1/runs', task)));
  assert.ok(responses.every(r => r.status === 202));
  const runs = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(runs.map(r => r.run_id)).size, 1);
  for (const change of [{ prompt: 'changed' }, { profile: 'unavailable@2' }, { output_contract: 'data-statistics@1' }, { inputs: [] }]) {
    const conflict = await l.request('/v1/runs', { ...task, ...change });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
  }
  for (const identity of identities.slice(1, 3)) {
    const other = await (await l.request('/v1/runs', task, 'same-key', identity.token)).json();
    assert.notEqual(other.run_id, runs[0].run_id);
    assert.equal((await l.request(`/v1/runs/${runs[0].run_id}`, undefined, 'same-key', identity.token)).status, 404);
    assert.equal((await (await l.request('/v1/runs', undefined, 'same-key', identity.token)).json()).runs.length, 1);
  }
  assert.equal((await (await l.request('/v1/runs')).json()).runs.length, 1);
});

test('submission and frozen manifest digests remain distinct across execution and restart, including failed Runs', async t => {
  const l = await lab(t, new FixtureSandbox('invalid'));
  const accepted = await (await l.request('/v1/runs', task)).json();
  assert.match(accepted.submission_digest, /^[a-f0-9]{64}$/);
  assert.match(accepted.execution.manifest_digest, /^[a-f0-9]{64}$/);
  assert.notEqual(accepted.submission_digest, accepted.execution.manifest_digest);
  await l.restart();
  const recovered = await (await l.request('/v1/runs', task)).json();
  assert.equal(recovered.run_id, accepted.run_id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.submission_digest, accepted.submission_digest);
  assert.equal(recovered.execution.manifest_digest, accepted.execution.manifest_digest);
  assert.equal(l.sandbox.executions.size, 1);
  const next = await (await l.request('/v1/runs', task, 'new-business-execution')).json();
  assert.notEqual(next.run_id, accepted.run_id);
  assert.equal(next.submission_digest, accepted.submission_digest);
  assert.notEqual(next.execution.manifest_digest, accepted.execution.manifest_digest);
});

test('health reports scoped durable acceptance, replay and conflict observations with freshness', async t => {
  const l = await lab(t);
  await l.request('/v1/runs', task);
  await l.request('/v1/runs', task);
  await l.request('/v1/runs', { ...task, prompt: 'conflict' });
  await l.request('/v1/runs', task, 'same-key', identities[2]!.token);
  await l.restart();
  const health = await (await l.request('/internal/health', undefined, 'same-key', identities[3]!.token)).json();
  assert.deepEqual(health.submissions.counts, { accepted: 1, replayed: 1, conflict: 1 });
  assert.equal(health.submissions.source, 'platform:durable-submission-audit');
  assert.ok(Date.now() - Date.parse(health.submissions.observed_at) < 5000);
  assert.equal(health.model.status, 'unknown');
  assert.equal((await l.request('/internal/health')).status, 403);
  assert.equal(JSON.stringify(health).includes('Return three apples.'), false);
});
