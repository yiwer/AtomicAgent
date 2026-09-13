import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';

const identities = [
  { actor: 'owner', workspace: 'lab', role: 'caller' as const, token: 'owner-test-only-00000000000000000000000' },
  { actor: 'other', workspace: 'lab', role: 'caller' as const, token: 'other-test-only-00000000000000000000000' },
  { actor: 'health', workspace: 'lab', role: 'health' as const, token: 'health-test-only-0000000000000000000000' },
];
const task = { prompt: 'SYNTHETIC_SECRET https://private.example/?token=secret done', profile: fixtureProfile.id, output_contract: 'summary-value@1' };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function lab(t: test.TestContext, sandbox = new FixtureSandbox()) {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-events-'));
  let offset = 0;
  const options = { database: join(directory, 'runs.db'), profile: fixtureProfile, identities, sandbox, clock: () => Date.now() + offset };
  let app = await createApp(options);
  let url = await app.listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (path: string, options: RequestInit = {}) => fetch(url + path, { ...options, headers: {
    Authorization: `Bearer ${identities[0]!.token}`, 'Content-Type': 'application/json', ...options.headers,
  } });
  return { request, sandbox, url: () => url, advance: (ms: number) => { offset += ms; }, restart: async (beforeOpen?: (database: string) => void) => {
    await app.close(); beforeOpen?.(options.database); app = await createApp(options); url = await app.listen();
  } };
}
const submit = (wait: string, key = 'wait-task') => ({ method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(task) });

test('finite HTTP waiting returns a committed Result and replay changes no execution identity or deadline', async t => {
  const l = await lab(t);
  const response = await l.request('/v1/runs?wait_seconds=1', submit('1'));
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.result, { summary: 'three apples', value: 3 });
  const replay = await (await l.request('/v1/runs?wait_seconds=0', submit('0'))).json();
  assert.equal(replay.run_id, run.run_id);
  assert.equal(replay.execution.deadline_at, run.execution.deadline_at);
  assert.equal(replay.submission_digest, run.submission_digest);
  assert.equal(replay.execution.manifest_digest, run.execution.manifest_digest);
  assert.equal(l.sandbox.executions.size, 1);
});
test('expired cursors explicitly recover via the authoritative Run, while live sessions stop sending after rotation or expiry', async t => {
  const sandbox = new FixtureSandbox('cleanup-unknown');
  const l = await lab(t, sandbox);
  const run = await (await l.request('/v1/runs?wait_seconds=1', submit('1'))).json();
  const path = `/v1/runs/${run.run_id}/events`;
  const login = async (cookie = '') => {
    const response = await l.request('/auth/session', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ token: identities[0]!.token }) });
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const oldCookie = await login();
  const stream = await l.request(path, { headers: { Authorization: '', Cookie: oldCookie }, signal: AbortSignal.timeout(3000) });
  const reader = stream.body!.getReader(); await reader.read();
  const newCookie = await login(oldCookie);
  assert.equal((await l.request('/v1/me', { headers: { Authorization: '', Cookie: oldCookie } })).status, 401);
  try { while (!(await reader.read()).done) {} } catch (error) { assert.notEqual((error as Error).name, 'TimeoutError'); }
  const expiring = await l.request(path, { headers: { Authorization: '', Cookie: newCookie }, signal: AbortSignal.timeout(3000) });
  const nextReader = expiring.body!.getReader(); await nextReader.read();
  l.advance(8 * 3600_000 + 1);
  try { while (!(await nextReader.read()).done) {} } catch (error) { assert.notEqual((error as Error).name, 'TimeoutError'); }
  l.advance(7 * 24 * 3600_000);
  const expired = await l.request(path, { headers: { 'Last-Event-ID': `${run.run_id}:1` } });
  assert.equal(expired.status, 410);
  assert.deepEqual(await expired.json(), { error: 'event_cursor_expired', recovery: 'query_run', run_url: `/v1/runs/${run.run_id}` });
  const authoritative = await (await l.request(`/v1/runs/${run.run_id}`)).json();
  assert.equal(authoritative.status, 'succeeded'); assert.equal(authoritative.cleanup.status, 'unknown');
  assert.deepEqual((await (await l.request(`/v1/runs/${run.run_id}/result`)).json()).result, run.result);
});

async function events(response: Response, count: number) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader();
  let buffer = ''; const found: { id: string; data: any }[] = [];
  try {
    while (found.length < count) {
      const part = await reader.read(); if (part.done) break;
      buffer += new TextDecoder().decode(part.value);
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (data) found.push({ id: frame.match(/^id: (.*)$/m)?.[1] ?? '', data: JSON.parse(data) });
      }
    }
  } finally { await reader.cancel(); }
  return found;
}
test('SSE replays durable ordered identities after reconnect and restart without counting delivery as execution', async t => {
  const l = await lab(t);
  const run = await (await l.request('/v1/runs?wait_seconds=1', submit('1'))).json();
  const path = `/v1/runs/${run.run_id}/events`;
  const original = await events(await l.request(path, { signal: AbortSignal.timeout(4000) }), 5);
  assert.equal(original.length, 5);
  assert.deepEqual(original.map(e => e.data.sequence), [1, 2, 3, 4, 5]);
  assert.equal(original[0]!.data.attempt_id, null);
  assert.equal(original[3]!.data.status, 'succeeded');
  assert.equal(original[3]!.data.cleanup.status, 'pending');
  assert.equal(original[4]!.data.cleanup.status, 'complete');
  for (const event of original) {
    assert.equal(event.data.version, 1); assert.equal(event.data.run_id, run.run_id);
    assert.equal(event.id, event.data.event_id); assert.ok(event.data.occurred_at); assert.ok(event.data.recorded_at);
    assert.equal(/SYNTHETIC_SECRET|private.example|secret_ref|operation_id|resource_id|prompt/.test(JSON.stringify(event)), false);
  }
  await l.restart();
  const replay = await events(await l.request(path, { headers: { 'Last-Event-ID': original[1]!.id }, signal: AbortSignal.timeout(4000) }), 3);
  assert.deepEqual(replay, original.slice(2));
  const health = await (await l.request('/internal/health', { headers: { Authorization: `Bearer ${identities[2]!.token}` } })).json();
  assert.equal(health.submissions.counts.accepted, 1);
  assert.equal(health.events.persisted, 5);
  assert.ok(health.events.observed_at); assert.equal(health.events.source, 'platform:durable-run-events');
});

test('a real 30-second HTTP wait and paused SSE socket release connections without stopping their Run', { timeout: 45_000 }, async t => {
  const sandbox = new FixtureSandbox();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = sandbox.execute.bind(sandbox);
  sandbox.execute = async (run, signal) => { await gate; return execute(run, signal); };
  const l = await lab(t, sandbox);
  try {
    const start = performance.now();
    const waiting = l.request('/v1/runs?wait_seconds=30', submit('30'));
    await delay(100);
    const accepted = await (await l.request('/v1/runs', submit('0'))).json();
    await assert.rejects(l.request('/v1/runs?wait_seconds=30', { ...submit('30'), signal: AbortSignal.timeout(100) }));
    const socket = get(`${l.url()}/v1/runs/${accepted.run_id}/events`, { headers: { Authorization: `Bearer ${identities[0]!.token}` } });
    socket.on('error', () => {}); t.after(() => socket.destroy());
    const paused = await new Promise<import('node:http').IncomingMessage>(resolve => socket.once('response', response => { response.pause(); resolve(response); }));
    const response = await waiting;
    const elapsed = performance.now() - start;
    assert.equal(response.status, 202); assert.ok(elapsed >= 29_500 && elapsed < 33_000, `wait elapsed ${elapsed}ms`);
    const stillRunning = await response.json();
    assert.equal(stillRunning.run_id, accepted.run_id); assert.equal(stillRunning.status, 'running');
    assert.equal(stillRunning.execution.deadline_at, accepted.execution.deadline_at);
    assert.equal((await l.request(`/v1/runs/${accepted.run_id}/result`)).status, 409);
    await delay(600);
    const health = await (await l.request('/internal/health', { headers: { Authorization: `Bearer ${identities[2]!.token}` } })).json();
    assert.equal(health.events.active_connections, 0);
    paused.destroy(); release();
    const result = await (await l.request('/v1/runs?wait_seconds=1', submit('1'))).json();
    assert.equal(result.status, 'succeeded'); assert.equal(result.run_id, accepted.run_id);
    assert.equal(sandbox.executions.size, 1);
  } finally { release(); }
});

test('wait validation, failed results, event authorization and connection quotas preserve authority', async t => {
  const l = await lab(t, new FixtureSandbox('invalid'));
  for (const wait of ['31', '-1', 'NaN', '', '1&wait_seconds=2']) assert.equal((await l.request(`/v1/runs?wait_seconds=${wait}`, submit(wait))).status, 400);
  const result = await (await l.request('/v1/runs?wait_seconds=1', submit('1'))).json();
  assert.equal(result.status, 'failed'); assert.equal(result.failure, 'output_invalid'); assert.equal(result.result, null);
  const path = `/v1/runs/${result.run_id}/events`;
  for (const [token, status] of [[identities[1]!.token, 404], [identities[2]!.token, 403], ['invalid', 401]] as const)
    assert.equal((await l.request(path, { headers: { Authorization: `Bearer ${token}` } })).status, status);
  assert.equal((await l.request(path, { headers: { 'X-Observation-Actor': 'other', 'X-Observation-Workspace': 'lab' } })).status, 403);
  assert.equal((await l.request(path, { headers: { 'Last-Event-ID': 'other-run:1' } })).status, 400);
  assert.equal((await l.request(path, { headers: { 'Last-Event-ID': `${result.run_id}:999` } })).status, 409);
  const connections: Response[] = [];
  try {
    for (let i = 0; i < 8; i++) connections.push(await l.request(path));
    assert.equal((await l.request(path)).status, 429);
  } finally { await Promise.all(connections.map(r => r.body!.cancel())); }
  await delay(100);
  const health = await (await l.request('/internal/health', { headers: { Authorization: `Bearer ${identities[2]!.token}` } })).json();
  assert.equal(health.events.active_connections, 0); assert.equal(health.submissions.counts.accepted, 1);
});

test('a pre-events database exposes an explicit current snapshot directly to its authorized caller', async t => {
  const l = await lab(t);
  const run = await (await l.request('/v1/runs?wait_seconds=1', submit('1'))).json();
  // External storage migration fixture: emulate the schema before Ticket04. Assertions use HTTP only.
  await l.restart(database => { const db = new DatabaseSync(database); db.exec('DROP TABLE run_events'); db.close(); });
  const snapshot = await events(await l.request(`/v1/runs/${run.run_id}/events`, { signal: AbortSignal.timeout(3000) }), 1);
  assert.equal(snapshot[0]!.data.type, 'run.snapshot'); assert.equal(snapshot[0]!.data.status, 'succeeded');
  assert.equal(snapshot[0]!.data.cleanup.status, 'complete'); assert.equal(snapshot[0]!.data.sequence, 1);
  assert.ok(Date.parse(snapshot[0]!.data.occurred_at) >= Date.parse(run.terminal_at));
  const health = await (await l.request('/internal/health', { headers: { Authorization: `Bearer ${identities[2]!.token}` } })).json();
  assert.equal(health.events.persisted, 1);
  await l.restart();
  assert.deepEqual(await events(await l.request(`/v1/runs/${run.run_id}/events`, { signal: AbortSignal.timeout(3000) }), 1), snapshot);
});

test('running Runs retain events beyond seven days of observation time and a logged-out waiter cannot receive a Result', async t => {
  const sandbox = new FixtureSandbox();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = sandbox.execute.bind(sandbox);
  sandbox.execute = async (run, signal) => { await gate; return execute(run, signal); };
  const l = await lab(t, sandbox);
  try {
    const run = await (await l.request('/v1/runs', submit('0'))).json();
    l.advance(8 * 24 * 3600_000);
    const progress = await events(await l.request(`/v1/runs/${run.run_id}/events`, { signal: AbortSignal.timeout(3000) }), 3);
    assert.equal(progress.at(-1)!.data.status, 'running');
    const login = await l.request('/auth/session', { method: 'POST', body: JSON.stringify({ token: identities[0]!.token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const waiting = l.request('/v1/runs?wait_seconds=1', { ...submit('1'), headers: { Authorization: '', Cookie: cookie, 'Idempotency-Key': 'wait-task' } });
    await delay(100);
    assert.equal((await l.request('/auth/logout', { method: 'POST', headers: { Authorization: '', Cookie: cookie } })).status, 200);
    release();
    const rejected = await waiting;
    assert.equal(rejected.status, 401); assert.deepEqual(await rejected.json(), { error: 'authentication_required' });
    const authoritative = await (await l.request(`/v1/runs/${run.run_id}`)).json();
    assert.equal(authoritative.status, 'succeeded'); assert.equal(authoritative.execution.deadline_at, run.execution.deadline_at);
  } finally { release(); }
});

test('a slow real HTTP consumer advances through a multi-page recovery backlog and resumes its last consumed cursor', async t => {
  const l = await lab(t, new FixtureSandbox('cleanup-unknown'));
  const run = await (await l.request('/v1/runs?wait_seconds=1', submit('1'))).json();
  // Repeated provider observations through normal recovery create genuine durable progress, not fabricated events.
  for (let i = 0; i < 100; i++) { await delay(2); await l.restart(); }
  const request = get(`${l.url()}/v1/runs/${run.run_id}/events`, { headers: { Authorization: `Bearer ${identities[0]!.token}` } });
  request.on('error', () => {}); t.after(() => request.destroy());
  const response = await new Promise<import('node:http').IncomingMessage>(resolve => request.once('response', resolve));
  let buffer = ''; const consumed: number[] = [];
  for await (const chunk of response) {
    buffer += chunk.toString(); await delay(100);
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = frame.match(/^data: (.*)$/m)?.[1]; if (data) consumed.push(JSON.parse(data).sequence);
      if (consumed.length >= 80) break;
    }
    if (consumed.length >= 80) break;
  }
  const last = consumed.at(-1)!;
  assert.ok(last >= 80); assert.equal(new Set(consumed).size, consumed.length);
  assert.equal(consumed[0], 1); assert.equal(last, consumed.length);
  const rest = await events(await l.request(`/v1/runs/${run.run_id}/events`, { headers: { 'Last-Event-ID': `${run.run_id}:${last}` }, signal: AbortSignal.timeout(3000) }), 105 - last);
  assert.equal(rest[0]!.data.sequence, last + 1); assert.equal(rest.at(-1)!.data.sequence, 105);
  assert.equal((await (await l.request(`/v1/runs/${run.run_id}`)).json()).status, 'succeeded');
  assert.equal(l.sandbox.executions.size, 1);
});
