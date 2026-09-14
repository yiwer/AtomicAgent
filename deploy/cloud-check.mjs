// Runs inside the app container; credentials never travel through CI or stdout.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const config = JSON.parse(await readFile(process.env.ATOMIC_CONFIG, 'utf8'));
const identity = config.identities.find(i => i.role === 'maintainer');
const base = process.env.CHECK_URL ?? `http://127.0.0.1:${config.port}`;
async function request(path, options = {}) {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10000), headers: {
    Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json', ...options.headers,
  } });
  assert.ok(response.ok, `HTTP ${response.status} at ${path}`);
  return response;
}
assert.equal((await fetch(base + '/v1/me', { signal: AbortSignal.timeout(10000) })).status, 401);
assert.equal((await (await request('/v1/me')).json()).mode, 'fixture');
assert.equal((await (await request('/internal/health')).json()).source, 'platform:durable-runs');
for (const path of ['/', '/app.js', '/styles.css']) await request(path);
if (process.argv.includes('--idle')) {
  const health = await (await request('/internal/health')).json();
  assert.equal(health.limits.occupied, 0, 'Active executions: retry deployment after they finish');
  assert.equal(health.limits.queued, 0, 'Queued executions: retry deployment after they finish');
}
if (process.argv.includes('--smoke')) {
  const run = await (await request('/v1/runs?wait_seconds=5', { method: 'POST', headers: { 'Idempotency-Key': `deployment-${process.env.DEPLOYMENT_REVISION}` },
    body: JSON.stringify({ prompt: 'Return summary "three apples" and value 3.', profile: config.profile.id, output_contract: 'summary-value@1' }) })).json();
  assert.equal(run.status, 'succeeded');
  assert.equal(run.validation.status, 'passed');
  assert.deepEqual(run.result, { summary: 'three apples', value: 3 });
  console.log(JSON.stringify({ mode: 'fixture', run_id: run.run_id, revision: process.env.DEPLOYMENT_REVISION }));
}
console.log('Authenticated application check passed (fixture; no model inference).');
