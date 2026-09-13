import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import { fixtureProfile } from '../src/profile.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';

const token = 'storage-fault-test-only-credential-00000000000';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const requestBody = JSON.stringify({ prompt: 'Return three apples and 3.', profile: 'json-lab@1', output_contract: 'summary-value@1' });
test('unwritable recovery records do not block disposal of later resources, and observations reconcile after recovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-storage-'));
  const database = join(directory, 'runs.db'); const sandbox = new FixtureSandbox('cleanup-unknown');
  const options = { database, profile: fixtureProfile, sandbox, identities: [{ token, actor: 'operator', workspace: 'lab', role: 'maintainer' as const }] };
  const app = await createApp(options); const url = await app.listen();
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  for (const key of ['one', 'two']) {
    await fetch(url + '/v1/runs', { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: requestBody });
  }
  await app.close(); assert.equal(sandbox.resources.size, 2);
  // Storage fault injection is intentionally at the external SQLite boundary, not a mock of Store methods.
  const faultDb = new DatabaseSync(database);
  const auditBefore = faultDb.prepare("SELECT outcome,source,resource_id,observed_at FROM audit WHERE action='sandbox.cleanup-observed'").all();
  assert.equal(auditBefore.length, 2);
  assert.ok(auditBefore.every(row => row.outcome === 'unknown' && row.source === 'deterministic-fixture' && row.resource_id && row.observed_at));
  faultDb.exec("CREATE TRIGGER write_fault BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET'); END;");
  sandbox.scenario = 'success';
  await assert.rejects(createApp(options), /recovery_record_unavailable/);
  assert.equal(sandbox.resources.size, 0, 'provider disposal must cover both obligations despite failed observation writes');
  faultDb.exec('DROP TRIGGER write_fault'); faultDb.close();
  const recovered = await createApp(options); const recoveredUrl = await recovered.listen();
  try {
    const list = await (await fetch(recoveredUrl + '/v1/runs', { headers })).json();
    assert.ok(list.runs.every((run: { status: string; cleanup: { status: string } }) => run.status === 'succeeded' && run.cleanup.status === 'complete'));
    assert.equal(sandbox.executions.size, 2);
  } finally { await recovered.close(); }
});

test('a failed terminal write cannot prevent cleanup of the same already-started execution on restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-terminal-'));
  const database = join(directory, 'runs.db'); const sandbox = new FixtureSandbox('cleanup-unknown');
  const options = { database, profile: fixtureProfile, sandbox, identities: [{ token, actor: 'operator', workspace: 'lab', role: 'maintainer' as const }] };
  const app = await createApp(options); const url = await app.listen();
  const faultDb = new DatabaseSync(database);
  t.after(async () => { faultDb.close(); await rm(directory, { recursive: true, force: true }); });
  sandbox.execute = async () => {
    faultDb.exec("CREATE TRIGGER write_fault BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET'); END;");
    return { summary: 'three apples', value: 3 };
  };
  const accepted = await (await fetch(url + '/v1/runs', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'one' }, body: requestBody })).json();
  await app.close(); assert.equal(sandbox.resources.size, 1);
  sandbox.scenario = 'success';
  await assert.rejects(createApp(options), /recovery_record_unavailable/);
  assert.equal(sandbox.resources.size, 0);
  faultDb.exec('DROP TRIGGER write_fault');
  const recovered = await createApp(options); const recoveredUrl = await recovered.listen();
  try {
    const run = await (await fetch(`${recoveredUrl}/v1/runs/${accepted.run_id}`, { headers })).json();
    assert.equal(run.failure, 'execution_lost'); assert.equal(run.cleanup.status, 'complete');
    assert.equal((await fetch(`${recoveredUrl}/v1/runs/${accepted.run_id}/result`, { headers })).status, 409);
  } finally { await recovered.close(); }
});

test('an existing matching profile allows disposal even when a SQLite writer lock prevents transactions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-locked-'));
  const database = join(directory, 'runs.db'); const sandbox = new FixtureSandbox('cleanup-unknown');
  const options = { database, profile: fixtureProfile, sandbox, identities: [{ token, actor: 'operator', workspace: 'lab', role: 'maintainer' as const }] };
  const app = await createApp(options); const url = await app.listen();
  await fetch(url + '/v1/runs', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'one' }, body: requestBody });
  await app.close(); assert.equal(sandbox.resources.size, 1);
  const lockDb = new DatabaseSync(database); lockDb.exec('BEGIN IMMEDIATE');
  t.after(async () => { lockDb.exec('ROLLBACK'); lockDb.close(); await rm(directory, { recursive: true, force: true }); });
  sandbox.scenario = 'success';
  await assert.rejects(createApp(options), /recovery_record_unavailable/);
  assert.equal(sandbox.resources.size, 0);
});
