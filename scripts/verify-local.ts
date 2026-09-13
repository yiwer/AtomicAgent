import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixtureProfile } from '../src/profile.js';

// Exercises the built entry point and process lock using isolated, disposable fixture data.
const directory = await mkdtemp(join(tmpdir(), 'atomicagent-release-'));
const configPath = join(directory, 'config.json'); const database = join(directory, 'runs.db');
const token = randomBytes(32).toString('hex');
await writeFile(configPath, JSON.stringify({ profile: fixtureProfile, database, port: 0,
  identities: [{ token, actor: 'release-audit', workspace: 'test', role: 'maintainer' }] }), { mode: 0o600 });
async function launch() {
  const child = spawn(process.execPath, ['dist/src/main.js'], { env: { ...process.env, ATOMIC_CONFIG: configPath }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup_timeout')), 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('startup_failed')); });
    child.stdout!.on('data', (data: Buffer) => {
      const match = data.toString().match(/AtomicAgent fixture: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
  }).catch(async error => { await stop({ child, closed }); throw error; });
  return { child, closed, url };
}
async function stop(processInfo: { child: ChildProcess; closed: Promise<void> }) {
  processInfo.child.kill('SIGTERM'); await processInfo.closed;
  // Windows force-termination leaves a stale lock. Remove only this verified-dead audit child's exact lock.
  try {
    const lock = JSON.parse(await readFile(`${database}.lock`, 'utf8'));
    assert.equal(lock.pid, processInfo.child.pid); await unlink(`${database}.lock`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
let current: Awaited<ReturnType<typeof launch>> | undefined;
try {
  current = await launch();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'release-check' };
  const response = await fetch(current.url + '/v1/runs', { method: 'POST', headers,
    body: JSON.stringify({ prompt: 'Return three apples and integer 3.', profile: 'json-lab@1', output_contract: 'summary-value@1' }) });
  assert.equal(response.status, 202); const accepted = await response.json();
  for (let i = 0; i < 100; i++) {
    const run = await (await fetch(`${current.url}/v1/runs/${accepted.run_id}`, { headers })).json();
    if (run.status === 'succeeded' && run.cleanup.status === 'complete') break;
    if (i === 99) throw new Error('run_not_complete');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const catalog = await (await fetch(current.url + '/v1/configurations', { headers })).json();
  const publication = { action: 'publish', kind: 'environment', name: 'json-lab', expected_generation: 1, reason: 'Built entrypoint revision audit',
    content: { binding_ref: catalog.bindings.environments[0].binding_ref, image: fixtureProfile.image, timeout_seconds: 30 } };
  const preview = await (await fetch(current.url + '/v1/configurations/preview', { method: 'POST', headers, body: JSON.stringify(publication) })).json();
  const commandBody = JSON.stringify({ ...publication, preview_digest: preview.preview_digest });
  const commandHeaders = { ...headers, 'Idempotency-Key': 'configuration-publication' };
  const published = await (await fetch(current.url + '/v1/configurations/commands', { method: 'POST', headers: commandHeaders, body: commandBody })).json();
  assert.equal(published.revision.version, '2');
  const task = { prompt: 'Return three apples and integer 3.', environment: { profile_id: 'json-lab', version: '2' },
    model: { profile_id: 'json-lab', version: '1' }, output_contract: 'summary-value@1' };
  const fixed = await (await fetch(current.url + '/v1/runs?wait_seconds=5', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'fixed-revision' }, body: JSON.stringify(task) })).json();
  assert.equal(fixed.status, 'succeeded'); assert.deepEqual(fixed.execution.environment, task.environment);
  const disable = { action: 'disable', kind: 'environment', name: 'json-lab', version: '1', expected_generation: 2, reason: 'Only new admission is disabled' };
  const disablePreview = await (await fetch(current.url + '/v1/configurations/preview', { method: 'POST', headers, body: JSON.stringify(disable) })).json();
  assert.equal((await fetch(current.url + '/v1/configurations/commands', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'disable-original' },
    body: JSON.stringify({ ...disable, preview_digest: disablePreview.preview_digest }) })).status, 200);
  const duplicate = spawn(process.execPath, ['dist/src/main.js'], { env: { ...process.env, ATOMIC_CONFIG: configPath }, windowsHide: true, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { duplicate.kill('SIGTERM'); }, 10_000);
    duplicate.once('error', error => { clearTimeout(timer); reject(error); });
    duplicate.once('close', code => { clearTimeout(timer); resolve(code); });
  }); assert.equal(code, 1);
  await stop(current); current = undefined; current = await launch();
  const result = await (await fetch(`${current.url}/v1/runs/${accepted.run_id}/result`, { headers })).json();
  assert.deepEqual(result.result, { summary: 'three apples', value: 3 });
  assert.deepEqual(await (await fetch(current.url + '/v1/configurations/commands', { method: 'POST', headers: commandHeaders, body: commandBody })).json(), published);
  const frozen = await (await fetch(`${current.url}/v1/runs/${fixed.run_id}`, { headers })).json();
  assert.equal(frozen.execution.manifest_digest, fixed.execution.manifest_digest);
  const legacyBody = JSON.stringify({ prompt: 'Return three apples and integer 3.', profile: 'json-lab@1', output_contract: 'summary-value@1' });
  const replay = await (await fetch(current.url + '/v1/runs', { method: 'POST', headers, body: legacyBody })).json();
  assert.equal(replay.run_id, accepted.run_id);
  assert.equal((await fetch(current.url + '/v1/runs', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'new-disabled' }, body: legacyBody })).status, 400);
  console.log(JSON.stringify({ check: 'built-entrypoint-restart', mode: 'fixture', result: 'PASS', duplicate_process: 'rejected', persisted_result: true }));
  console.log(JSON.stringify({ check: 'configuration-publication-restart', mode: 'fixture', result: 'PASS', fixed_manifest: true, command_replay: true, disabled_new_admission: true, legacy_run_replay: true }));
} finally { if (current) await stop(current); await rm(directory, { recursive: true, force: true }); }
