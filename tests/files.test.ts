import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { DiskBlobs, type BlobPort } from '../src/blob-store.js';
import { fixtureProfile } from '../src/profile.js';

export const csv = 'id,category,value\nr01,alpha,10\nr02,beta,20\nr03,alpha,15\nr04,beta,invalid\nr05,alpha,-5\nr06,beta,0\nr07,alpha,2.5\nr08,beta,7.5\n';
const identities = [
  { token: 'a'.repeat(40), actor: 'a', workspace: 'lab', role: 'caller' as const },
  { token: 'b'.repeat(40), actor: 'b', workspace: 'lab', role: 'caller' as const },
  { token: 'h'.repeat(40), actor: 'health', workspace: 'lab', role: 'health' as const },
];
async function lab(t: TestContext, sandbox = new FixtureSandbox(), storage?: (directory: string) => BlobPort) {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-files-'));
  const options = { database: join(directory, 'runs.db'), profile: fixtureProfile, identities, sandbox, blobs: storage?.(directory) };
  let app = await createApp(options); let url = await app.listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, sandbox,
    async restart() { await app.close(); app = await createApp(options); url = await app.listen(); },
    uploadRaw(content: Uint8Array, format = 'csv') {
      return fetch(url + '/v1/files', { method: 'POST', headers: { Authorization: `Bearer ${identities[0]!.token}`, 'X-File-Format': format }, body: Buffer.from(content) });
    },
    request(path: string, body?: unknown, token = identities[0]!.token, key = 'file-task') {
      return fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
  };
}
test('uploaded CSV becomes an owned immutable InputObject only after content validation and survives restart', async t => {
  const l = await lab(t);
  const response = await l.request('/v1/files', { format: 'csv', content: csv });
  assert.equal(response.status, 201);
  const file = await response.json();
  assert.equal(file.status, 'available'); assert.equal(file.size_bytes, Buffer.byteLength(csv));
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  await l.restart();
  assert.deepEqual(await (await l.request(`/v1/files/${file.file_id}`)).json(), file);
  assert.equal((await l.request(`/v1/files/${file.file_id}`, undefined, identities[1]!.token)).status, 404);
  assert.equal((await l.request('/v1/files', { format: 'json', content: '{broken' })).status, 400);
});
test('file task executes real code and delivers verified ordered bytes after sandbox cleanup and restart', async t => {
  const l = await lab(t);
  const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
  const response = await l.request('/v1/runs', { prompt: 'Process the input with decimal statistics.', profile: fixtureProfile.id,
    output_contract: 'data-statistics@1', inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] });
  assert.equal(response.status, 202);
  const { run_id } = await response.json();
  let run;
  for (let i = 0; i < 400; i++) {
    run = await (await l.request(`/v1/runs/${run_id}`)).json();
    if (run.terminal_at && run.cleanup.status === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(run.status, 'succeeded'); assert.equal(run.cleanup.status, 'complete');
  assert.equal(run.inputs[0].loaded, true);
  await l.restart();
  const result = await (await l.request(`/v1/runs/${run_id}/result`)).json();
  assert.deepEqual(result.result, { summary: 'Processed 8 rows', input_count: 8, valid_count: 7, rejected_count: 1,
    total: '50', groups: { alpha: '22.5', beta: '27.5' } });
  assert.equal(result.artifacts.length, 2);
  for (const artifact of result.artifacts) {
    const issued = await (await l.request(`/v1/artifacts/${artifact.artifact_id}/download-link`, {})).json();
    assert.ok(Date.parse(issued.expires_at) <= Date.parse(artifact.expires_at));
    const downloaded = await l.request(issued.url);
    assert.equal(downloaded.status, 200);
    const bytes = await downloaded.text();
    if (artifact.path === 'output/valid.csv') assert.equal(bytes, csv.replace('r04,beta,invalid\n', ''));
    else assert.deepEqual(JSON.parse(bytes), [{ id: 'r04', category: 'beta', value: 'invalid' }]);
    assert.equal((await l.request(issued.url, undefined, identities[1]!.token)).status, 404);
  }
});

test('equivalent JSON and changed decimal data are computed from actual input, not fixture answers', async t => {
  const l = await lab(t);
  for (const [key, content, expected] of [
    ['equivalent', JSON.stringify(csv.trim().split('\n').slice(1).map(line => { const [id, category, value] = line.split(','); return { id, category, value }; })), '50'],
    ['decimal', JSON.stringify([{ id: 'a', category: 'x', value: '0.1' }, { id: 'b', category: 'x', value: '0.2' }, { id: 'c', category: 'x', value: '-0.1' }]), '0.2'],
  ]) {
    const file = await (await l.request('/v1/files', { format: 'json', content })).json();
    const submitted = await (await l.request('/v1/runs', { prompt: 'Process decimal rows.', profile: fixtureProfile.id,
      output_contract: 'data-statistics@1', inputs: [{ file_id: file.file_id, path: 'input/data.json' }] }, undefined, key)).json();
    const run = await settle(l, submitted.run_id);
    assert.equal(run.status, 'succeeded');
    const result = await (await l.request(`/v1/runs/${run.run_id}/result`)).json();
    assert.equal(result.result.total, expected);
  }
});
async function settle(l: Awaited<ReturnType<typeof lab>>, id: string) {
  for (let i = 0; i < 400; i++) {
    const run = await (await l.request(`/v1/runs/${id}`)).json();
    if (run.terminal_at && run.cleanup.status !== 'pending') return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Run did not settle');
}

test('transient artifact transfer failures retry only storage and do not repeat Agent execution', async t => {
  let failures = 0, writes = 0;
  const l = await lab(t, new FixtureSandbox(), directory => {
    const disk = new DiskBlobs(join(directory, 'blobs'));
    return { read: (id, limit) => disk.read(id, limit), remove: id => disk.remove(id),
      write: async (id, bytes) => { writes++; if (writes > 1 && failures++ < 2) throw new Error('synthetic-storage-outage'); await disk.write(id, bytes); } };
  });
  const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
  const submitted = await (await l.request('/v1/runs', { prompt: 'Process rows', profile: fixtureProfile.id,
    output_contract: 'data-statistics@1', inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] })).json();
  assert.equal((await settle(l, submitted.run_id)).status, 'succeeded');
  assert.equal(l.sandbox.executions.size, 1);
});

test('JSON number lexemes retain exact decimal precision beyond JavaScript Number', async t => {
  const l = await lab(t);
  const file = await (await l.request('/v1/files', { format: 'json', content: '[{"id":"large","category":"exact","value":9007199254740993},{"id":"decimal","category":"exact","value":0.1}]' })).json();
  const submitted = await (await l.request('/v1/runs', { prompt: 'Process exact decimals', profile: fixtureProfile.id,
    output_contract: 'data-statistics@1', inputs: [{ file_id: file.file_id, path: 'input/data.json' }] })).json();
  assert.equal((await settle(l, submitted.run_id)).status, 'succeeded');
  const result = await (await l.request(`/v1/runs/${submitted.run_id}/result`)).json();
  assert.equal(result.result.total, '9007199254740993.1');
});

test('input authorization and safe target rules reject before any execution', async t => {
  const l = await lab(t);
  const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
  const base = { prompt: 'Process', profile: fixtureProfile.id, output_contract: 'data-statistics@1' };
  for (const path of ['../data.csv', 'input/../data.csv', '/tmp/data.csv', 'input/a/b.csv', 'input\\data.csv', 'input/a:stream.csv', 'input/data.json']) {
    assert.equal((await l.request('/v1/runs', { ...base, inputs: [{ file_id: file.file_id, path }] }, undefined, path)).status, 400);
  }
  assert.equal((await l.request('/v1/runs', { ...base, inputs: [{ file_id: file.file_id, path: 'input/data.csv' }, { file_id: file.file_id, path: 'input/data.csv' }] })).status, 400);
  assert.equal((await l.request('/v1/runs', { ...base, inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] }, identities[1]!.token)).status, 404);
  assert.equal((await l.request('/v1/files', { format: 'csv', content: csv }, identities[2]!.token)).status, 403);
  assert.equal(l.sandbox.executions.size, 0);
});
test('tampered input bytes fail preparation without executing or changing the accepted binding', async t => {
  const l = await lab(t);
  const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
  await writeFile(join(l.directory, 'runs.db.objects', file.file_id), 'truncated');
  const run = await (await l.request('/v1/runs', { prompt: 'Process', profile: fixtureProfile.id, output_contract: 'data-statistics@1',
    inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] })).json();
  const ended = await settle(l, run.run_id);
  assert.equal(ended.failure, 'input_required'); assert.equal(ended.attempt_id, null);
  assert.equal(ended.inputs[0].sha256, file.sha256); assert.equal(l.sandbox.executions.size, 0);
});
test('fabricated completion, missing JSON/files and corrupted output content never commit a Result', async t => {
  for (const mode of ['claimed', 'missing-json', 'missing-file', 'wrong-statistics', 'wrong-csv', 'wrong-rejections']) {
    const sandbox = new FixtureSandbox(); const execute = sandbox.execute.bind(sandbox);
    sandbox.execute = async (run, signal) => {
      const envelope = await execute(run, signal) as any;
      if (mode === 'claimed') return { summary: 'I have succeeded', value: 3, actor: 'maintainer', success: true };
      if (mode === 'missing-json') delete envelope.candidate;
      if (mode === 'missing-file') envelope.files.pop();
      if (mode === 'wrong-statistics') envelope.candidate.total = '999';
      if (mode === 'wrong-csv') envelope.files[0].bytes = Buffer.from('id,category,value\nr01,alpha,999\n');
      if (mode === 'wrong-rejections') envelope.files[1].bytes = Buffer.from('[]');
      return envelope;
    };
    const l = await lab(t, sandbox);
    const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
    const run = await (await l.request('/v1/runs', { prompt: 'Process', profile: fixtureProfile.id, output_contract: 'data-statistics@1',
      inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] })).json();
    const ended = await settle(l, run.run_id);
    assert.equal(ended.failure, 'output_invalid', mode); assert.equal(ended.validation.status, 'failed');
    assert.equal((await l.request(`/v1/runs/${run.run_id}/result`)).status, 409);
  }
});
test('links expire independently; source and artifact expiry block new use without rerunning an old key', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const l = await lab(t);
  const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
  const request = { prompt: 'Process', profile: fixtureProfile.id, output_contract: 'data-statistics@1', inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] };
  const run = await (await l.request('/v1/runs', request)).json(); await settle(l, run.run_id);
  const result = await (await l.request(`/v1/runs/${run.run_id}/result`)).json();
  const id = result.artifacts[0].artifact_id;
  const link = await (await l.request(`/v1/artifacts/${id}/download-link`, {})).json();
  t.mock.timers.tick(300_001);
  assert.equal((await l.request(link.url)).status, 410);
  assert.equal((await l.request(`/v1/artifacts/${id}/download-link`, {})).status, 200);
  t.mock.timers.tick(86400_000);
  assert.equal((await l.request(`/v1/artifacts/${id}/download-link`, {})).status, 410);
  assert.equal((await (await l.request(`/v1/runs/${run.run_id}/result`)).json()).artifacts[0].availability, 'expired');
  assert.equal((await (await l.request('/v1/runs', request)).json()).run_id, run.run_id);
  assert.equal((await l.request('/v1/runs', request, undefined, 'new-expired')).status, 410);
  assert.equal(l.sandbox.executions.size, 1);
});

test('persistent transfer failure leaves no Result and cleanup debt retains identity until storage recovery', async t => {
  let writes = 0, recover = false;
  const l = await lab(t, new FixtureSandbox(), directory => {
    const disk = new DiskBlobs(join(directory, 'blobs'));
    return { read: (id, limit) => disk.read(id, limit), remove: async id => { if (!recover) throw new Error('SYNTHETIC_SECRET'); await disk.remove(id); },
      write: async (id, bytes) => { await disk.write(id, ++writes > 1 ? Buffer.from('partial') : bytes); if (writes > 1) throw new Error('SYNTHETIC_SECRET'); } };
  });
  const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
  const run = await (await l.request('/v1/runs', { prompt: 'Process', profile: fixtureProfile.id, output_contract: 'data-statistics@1',
    inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] })).json();
  assert.equal((await settle(l, run.run_id)).failure, 'artifact_commit_failed');
  assert.equal((await l.request(`/v1/runs/${run.run_id}/result`)).status, 409);
  const health = await (await l.request('/internal/health', undefined, identities[2]!.token)).json();
  assert.equal(health.object_storage.unresolved, 1);
  assert.equal(JSON.stringify(health).includes('SYNTHETIC_SECRET'), false);
  recover = true; await l.restart();
  assert.equal((await (await l.request('/internal/health', undefined, identities[2]!.token)).json()).object_storage.unresolved, 0);
  assert.equal(l.sandbox.executions.size, 1);
});
test('Result, validation and artifact availability roll back together when the commit audit cannot persist', async t => {
  const sandbox = new FixtureSandbox(); const l = await lab(t, sandbox);
  const db = new DatabaseSync(join(l.directory, 'runs.db'));
  try {
  db.exec("CREATE TRIGGER result_fault BEFORE INSERT ON audit WHEN NEW.action='result.commit' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET'); END;");
  const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
  const run = await (await l.request('/v1/runs', { prompt: 'Process', profile: fixtureProfile.id, output_contract: 'data-statistics@1',
    inputs: [{ file_id: file.file_id, path: 'input/data.csv' }] })).json();
  const ended = await settle(l, run.run_id);
  assert.equal(ended.failure, 'artifact_commit_failed'); assert.equal(ended.validation, null);
  assert.equal((await l.request(`/v1/runs/${run.run_id}/result`)).status, 409);
  const staged = db.prepare("SELECT resource_id FROM audit WHERE action='artifact.transfer-intent'").all();
  assert.equal(staged.length, 2);
  for (const object of staged) assert.equal((await l.request(`/v1/artifacts/${object.resource_id}/download-link`, {})).status, 409);
  assert.equal(l.sandbox.executions.size, 1);
  db.exec('DROP TRIGGER result_fault');
  } finally { db.close(); }
});

test('raw file upload validates UTF-8 and enforces the 50 MiB byte limit independently of JSON transport', async t => {
  const l = await lab(t);
  assert.equal((await l.uploadRaw(Buffer.from(csv))).status, 201);
  assert.equal((await l.uploadRaw(Buffer.from([0xff, 0xfe]))).status, 400);
  assert.equal((await l.uploadRaw(Buffer.alloc(50 * 1024 * 1024 + 1, 120))).status, 413);
});

test('upload audit preserves the authenticated initiator separately from platform validation', async t => {
  const l = await lab(t);
  const file = await (await l.request('/v1/files', { format: 'csv', content: csv })).json();
  const db = new DatabaseSync(join(l.directory, 'runs.db'));
  try {
    const record = db.prepare("SELECT actor,source,resource_id FROM audit WHERE action='input.upload-intent'").get();
    assert.equal(record?.actor, 'a'); assert.equal(record?.resource_id, file.file_id); assert.equal(record?.source, 'platform:object-store');
    assert.equal(db.prepare("SELECT actor FROM audit WHERE action='input.validated'").get()?.actor, 'platform');
  } finally { db.close(); }
});
