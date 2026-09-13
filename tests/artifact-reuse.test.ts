import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';
import { DiskBlobs, type BlobPort } from '../src/blob-store.js';
const identities = [
 { token: 'a'.repeat(40), actor: 'a', workspace: 'lab', role: 'caller' as const },
 { token: 'b'.repeat(40), actor: 'b', workspace: 'lab', role: 'caller' as const },
 { token: 'h'.repeat(40), actor: 'h', workspace: 'lab', role: 'health' as const },
 { token: 'm'.repeat(40), actor: 'm', workspace: 'lab', role: 'maintainer' as const },
 { token: 'z'.repeat(40), actor: 'z', workspace: 'other', role: 'maintainer' as const },
];
const base = { prompt: 'Process only this new input.', profile: fixtureProfile.id, output_contract: 'data-statistics@1' };
async function lab(t: TestContext, sandbox = new FixtureSandbox(), storage?: (disk: DiskBlobs) => BlobPort) {
 const directory = await mkdtemp(join(tmpdir(), 'atomic-reuse-'));
 const disk = new DiskBlobs(join(directory, 'blobs'));
 const options = { database: join(directory, 'runs.db'), profile: fixtureProfile, identities, sandbox, blobs: storage?.(disk) ?? disk };
 let app = await createApp(options), url = await app.listen();
 t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
 const request = (path: string, value?: unknown, key = 'original', token = identities[0]!.token) => fetch(url + path, { method: value === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
 const settle = async (id: string) => {
  for (let n = 0; n < 500; n++) { const run = await (await request(`/v1/runs/${id}`)).json(); if (run.terminal_at && run.cleanup.status !== 'pending') return run; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Run did not settle');
 };
 const file = await (await request('/v1/files', { format: 'csv', content: 'id,category,value\na,x,0.1\nb,x,0.2\nc,y,invalid\n' })).json();
 const originalBody = { ...base, inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] };
 const original = await (await request('/v1/runs', originalBody)).json(); await settle(original.run_id);
 const result = await (await request(`/v1/runs/${original.run_id}/result`)).json();
 return { directory, disk, sandbox, request, settle, original, originalBody, result, artifact: result.artifacts.find((a: any) => a.format === 'csv'),
  async restart() { await app.close(); app = await createApp(options); url = await app.listen(); } };
}
test('explicit Artifact reuse creates a distinct Run binding and independent copy, preserves source and survives restart', async t => {
 const l = await lab(t);
 const body = { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, path: 'input/previous.csv' }] };
 const response = await l.request('/v1/runs', body, 'reuse'); assert.equal(response.status, 202);
 const submitted = await response.json(), run = await l.settle(submitted.run_id);
 assert.equal(run.status, 'succeeded'); assert.notEqual(run.run_id, l.original.run_id);
 assert.notEqual(run.attempt_id, (await l.settle(l.original.run_id)).attempt_id);
 assert.match(run.inputs[0].binding_id, /^[a-f0-9-]{36}$/);
 assert.deepEqual(run.inputs[0].source, { kind: 'artifact', artifact_id: l.artifact.artifact_id, run_id: l.original.run_id, expires_at: l.artifact.expires_at });
 assert.equal(run.inputs[0].copy.status, 'removed'); assert.equal(run.inputs[0].copy.run_id, run.run_id);
 assert.ok(run.inputs[0].copy.loaded_at); assert.equal(run.inputs[0].path, 'input/previous.csv');
 assert.equal((await (await l.request(`/v1/runs/${run.run_id}/result`)).json()).result.total, '0.3');
 assert.deepEqual(await (await l.request(`/v1/runs/${l.original.run_id}/result`)).json(), l.result);
 assert.equal((await l.request(`/v1/artifacts/${l.artifact.artifact_id}/download-link`, {})).status, 200);
 await l.restart();
 assert.deepEqual((await (await l.request(`/v1/runs/${run.run_id}`)).json()).inputs, run.inputs);
 assert.equal((await (await l.request('/v1/runs', body, 'reuse')).json()).run_id, run.run_id);
 assert.equal(l.sandbox.executions.size, 2);
});
test('reuse rejects unauthorized, unsafe, ambiguous and incomplete sources before admission; same-name replacements are not substituted', async t => {
 const l = await lab(t);
 const body = { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, path: 'input/reuse.csv' }] };
 for (const token of [identities[1]!.token, identities[4]!.token]) assert.equal((await l.request('/v1/runs', body, 'denied', token)).status, 404);
 assert.equal((await l.request('/v1/runs', body, 'health', identities[2]!.token)).status, 403);
 for (const path of ['../reuse.csv', 'input/../reuse.csv', '/input/reuse.csv', 'input/reuse.json']) assert.equal((await l.request('/v1/runs', { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, path }] }, path)).status, 400);
 assert.equal((await l.request('/v1/runs', { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, file_id: l.artifact.artifact_id, path: 'input/reuse.csv' }] }, 'ambiguous')).status, 400);
 await writeFile(join(l.directory, 'blobs', l.artifact.artifact_id), 'id,category,value\na,x,999\n');
 const rejected = await l.request('/v1/runs', body, 'corrupt'); assert.equal(rejected.status, 409); assert.equal((await rejected.json()).submission_status, 'not_accepted');
 assert.equal((await (await l.request('/v1/runs')).json()).runs.length, 1);
 assert.equal(l.sandbox.executions.size, 1);
 assert.equal((await (await l.request('/v1/runs', l.originalBody)).json()).run_id, l.original.run_id);
});
test('expired source blocks new reuse but accepted reuse and original keys still replay after restart', async t => {
 t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
 const l = await lab(t); const body = { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, path: 'input/reuse.csv' }] };
 const run = await (await l.request('/v1/runs', body, 'reuse')).json(); await l.settle(run.run_id);
 t.mock.timers.tick(86400_001); await l.restart();
 const expired = await l.request('/v1/runs', body, 'new'); assert.equal(expired.status, 410);
 assert.equal((await expired.json()).error, 'file_expired');
 assert.equal((await (await l.request('/v1/runs', body, 'reuse')).json()).run_id, run.run_id);
 assert.equal((await (await l.request('/v1/runs', l.originalBody)).json()).run_id, l.original.run_id);
 assert.equal(l.sandbox.executions.size, 2);
});
for (const phase of ['admission-read', 'prepare', 'load-read', 'copy', 'after-copy'] as const) test(`source expiration at ${phase} respects the confirmed-copy boundary`, async t => {
 t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
 let armed = false, reads = 0; const sandbox = new FixtureSandbox();
 const l = await lab(t, sandbox, disk => ({ write: (id,b) => disk.write(id,b), remove: id => disk.remove(id), read: async (id, limit) => {
  const bytes = await disk.read(id, limit);
  if (armed && ((phase === 'admission-read' && ++reads === 1) || (phase === 'load-read' && ++reads === 2))) t.mock.timers.tick(2000);
  return bytes;
 } }));
 // Leave one second of source lifetime, while a newly accepted Run has its full own deadline.
 t.mock.timers.tick(Date.parse(l.artifact.expires_at) - Date.now() - 1000); armed = true;
 const prepare = sandbox.prepare.bind(sandbox), load = sandbox.loadInputs.bind(sandbox), execute = sandbox.execute.bind(sandbox);
 sandbox.prepare = async run => { const resource = await prepare(run); if (phase === 'prepare') t.mock.timers.tick(2000); return resource; };
 sandbox.loadInputs = async (run, inputs) => { await load(run, inputs); if (phase === 'copy') t.mock.timers.tick(2000); };
 sandbox.execute = async (run, signal) => { if (phase === 'after-copy') { t.mock.timers.tick(2000); await l.disk.remove(l.artifact.artifact_id); } return execute(run, signal); };
 const response = await l.request('/v1/runs', { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, path: 'input/reuse.csv' }] }, 'new');
 if (phase === 'admission-read') { assert.equal(response.status, 410); return; }
 assert.equal(response.status, 202); const run = await l.settle((await response.json()).run_id);
 if (phase === 'after-copy') { assert.equal(run.status, 'succeeded'); assert.ok(run.inputs[0].copy.loaded_at); }
 else { assert.equal(run.failure, 'input_source_expired'); assert.equal(run.attempt_id, null); assert.equal(run.inputs[0].loaded, false); }
 assert.equal((await (await l.request(`/v1/artifacts/${l.artifact.artifact_id}`)).json()).expires_at, l.artifact.expires_at);
 assert.equal((await (await l.request(`/v1/runs/${l.original.run_id}/result`)).json()).result.total, '0.3');
});
test('copy failure is explicit and cleans only the new Run; another consumer can still reuse the source', async t => {
 const sandbox = new FixtureSandbox(), l = await lab(t, sandbox); const load = sandbox.loadInputs.bind(sandbox);
 sandbox.loadInputs = async (run, inputs) => { await load(run, inputs); throw new Error('SYNTHETIC_SECRET'); };
 const body = { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, path: 'input/reuse.csv' }] };
 const failed = await (await l.request('/v1/runs', body, 'failed-copy')).json(), ended = await l.settle(failed.run_id);
 assert.equal(ended.failure, 'input_copy_failed'); assert.equal(ended.cleanup.status, 'complete'); assert.equal(ended.attempt_id, null);
 assert.equal(sandbox.directories.has(failed.run_id), false);
 sandbox.loadInputs = load;
 const next = await (await l.request('/v1/runs', body, 'another')).json(); assert.equal((await l.settle(next.run_id)).status, 'succeeded');
 assert.deepEqual(await (await l.request(`/v1/runs/${l.original.run_id}/result`)).json(), l.result);
 const health = await (await l.request('/internal/health', undefined, 'health', identities[2]!.token)).json();
 assert.equal(health.artifact_reuse.copy_failed, 1); assert.equal(health.artifact_reuse.confirmed, 1);
 assert.ok(health.artifact_reuse.observed_at); assert.equal(JSON.stringify(health).includes('SYNTHETIC_SECRET'), false);
});
test('metadata-known oversize, Markdown and incomplete Artifact sources fail at admission with bounded reasons', async t => {
 const l = await lab(t); const db = new DatabaseSync(join(l.directory, 'runs.db'));
 try {
 const row = db.prepare('SELECT document FROM objects WHERE id=?').get(l.artifact.artifact_id)!;
 const original = JSON.parse(row.document as string);
 for (const [change, status, code] of [[{ size_bytes: 50*1024*1024+1 }, 413, 'input_limit'], [{ format: 'markdown' }, 400, 'input_contract_incompatible'], [{ status: 'staged' }, 409, 'file_incomplete']] as const) {
  db.prepare('UPDATE objects SET document=? WHERE id=?').run(JSON.stringify({ ...original, ...change }), l.artifact.artifact_id);
  const response = await l.request('/v1/runs', { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, path: 'input/reuse.csv' }] }, code);
  assert.equal(response.status, status); assert.equal((await response.json()).error, code);
 }
 db.prepare('UPDATE objects SET document=? WHERE id=?').run(row.document as string, l.artifact.artifact_id);
 assert.equal(l.sandbox.executions.size, 1);
 } finally { db.close(); }
});
test('source replacement during copying fails before Attempt and leaves original Result unchanged', async t => {
 const sandbox = new FixtureSandbox(), l = await lab(t, sandbox); const load = sandbox.loadInputs.bind(sandbox);
 sandbox.loadInputs = async (run, inputs) => { await load(run, inputs); await writeFile(join(l.directory, 'blobs', l.artifact.artifact_id), 'id,category,value\na,x,999\n'); };
 const response = await l.request('/v1/runs', { ...base, inputs: [{ artifact_id: l.artifact.artifact_id, path: 'input/reuse.csv' }] }, 'replace');
 assert.equal(response.status, 202); const run = await l.settle((await response.json()).run_id);
 assert.equal(run.failure, 'input_required'); assert.equal(run.attempt_id, null); assert.equal(run.inputs[0].loaded, false);
 assert.deepEqual(await (await l.request(`/v1/runs/${l.original.run_id}/result`)).json(), l.result);
});
test('a same-workspace maintainer can explicitly reuse an authorized source with a new grant', async t => {
 const sandbox = new FixtureSandbox(), l = await lab(t, sandbox); const execute = sandbox.execute.bind(sandbox);
 sandbox.execute = async (run, signal) => {
  assert.equal(run.owner, 'm'); assert.equal(run.prompt, 'New maintainer task');
  assert.deepEqual(run.manifest.grant.tools, ['process-data@1']); assert.deepEqual(run.manifest.grant.mcp, []); assert.equal(run.manifest.skills, undefined);
  assert.notEqual(run.run_id, l.original.run_id); return execute(run, signal);
 };
 const response = await l.request('/v1/runs?wait_seconds=5', { ...base, prompt: 'New maintainer task', inputs: [{ artifact_id: l.artifact.artifact_id, path: 'input/reuse.csv' }] }, 'maintainer', identities[3]!.token);
 assert.equal(response.status, 200); assert.equal((await response.json()).status, 'succeeded');
});
