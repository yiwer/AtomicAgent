import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixtureProfile } from '../src/profile.js';

// Exercises attributed usage through the built entry point over real HTTP: the compiled artifact, not the sources.
const directory = await mkdtemp(join(tmpdir(), 'atomicagent-usage-release-'));
const configPath = join(directory, 'config.json'), database = join(directory, 'runs.db');
const token = randomBytes(32).toString('hex'), caller = randomBytes(32).toString('hex'), health = randomBytes(32).toString('hex');
await writeFile(configPath, JSON.stringify({ profile: { ...fixtureProfile, timeout_seconds: 600 }, database, port: 0,
  identities: [{ token, actor: 'release-audit', workspace: 'test', role: 'maintainer' },
    { token: caller, actor: 'release-caller', workspace: 'test', role: 'caller' },
    { token: health, actor: 'release-health', workspace: 'test', role: 'health' }] }), { mode: 0o600 });
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
  });
  return { child, closed, url };
}
async function stop(server: { child: ChildProcess; closed: Promise<void> }) {
  server.child.kill('SIGTERM'); await server.closed;
  // Windows force-termination leaves a stale lock. Remove only this verified-dead audit child's exact lock.
  try {
    const lock = JSON.parse(await readFile(`${database}.lock`, 'utf8'));
    assert.equal(lock.pid, server.child.pid); await unlink(`${database}.lock`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const checks: Record<string, unknown>[] = [];
let server = await launch();
const call = (path: string, body?: unknown, key = 'usage-release', credential = token) =>
  fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const find = (totals: { basis: string; unit: string; value: number | null }[], basis: string, unit: string) =>
  totals.find(t => t.basis === basis && t.unit === unit);
try {
  const run = await (await call('/v1/runs?wait_seconds=10', { prompt: 'three apples', profile: fixtureProfile.id, output_contract: 'summary-value@1' }, 'release-run')).json();
  assert.equal(run.status, 'succeeded');
  assert.equal(find(run.usage.totals, 'sdk-estimate', 'input_tokens')!.value, 310);
  assert.equal(find(run.usage.totals, 'provider-confirmed', 'input_tokens')!.value, 118);
  assert.equal(find(run.usage.totals, 'sdk-estimate', 'estimated_cost_micro_usd')!.value, null);
  checks.push({ check: 'run-usage-normalized', result: 'PASS', run: run.run_id, entries: run.usage.entries.length, invocations: run.usage.invocations.length });

  const workspace = await (await call('/v1/usage')).json();
  assert.equal(workspace.scope, 'workspace');
  assert.equal(find(workspace.totals, 'sdk-estimate', 'input_tokens')!.value, 310);
  assert.deepEqual(workspace.by_run.find((r: { run_id: string }) => r.run_id === run.run_id).usage.totals, run.usage.totals);
  checks.push({ check: 'quota-view-matches-task-view', result: 'PASS', measured_runs: workspace.measured_runs, unsupported: workspace.budget.unsupported[0].dimension });

  assert.equal((await call('/v1/usage', undefined, 'usage-release', health)).status, 403);
  assert.equal((await (await call('/v1/usage', undefined, 'usage-release', caller)).json()).runs, 0);
  checks.push({ check: 'server-side-authorization', result: 'PASS', health: 403, other_caller_runs: 0 });

  await stop(server); server = await launch();
  const reread = await (await call(`/v1/runs/${run.run_id}`)).json();
  assert.deepEqual(reread.usage.totals, run.usage.totals);
  assert.deepEqual(reread.usage.entries, run.usage.entries);
  checks.push({ check: 'usage-survives-restart', result: 'PASS', entries: reread.usage.entries.length });

  const script = await (await fetch(server.url + '/usage.js')).text();
  assert.match(script, /renderUsageTotals/);
  checks.push({ check: 'console-usage-module-served', result: 'PASS', bytes: script.length });
} finally {
  await stop(server); await rm(directory, { recursive: true, force: true });
  for (const check of checks) process.stdout.write(JSON.stringify(check) + '\n');
}
