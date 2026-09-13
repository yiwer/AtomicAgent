import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const token = 'recovery-test-only-token-0000000000000000';
const body = JSON.stringify({ prompt: 'Return three apples.', profile: 'json-lab@1', output_contract: 'summary-value@1' });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'lost-response' };
const delay = () => new Promise(resolve => setTimeout(resolve, 20));

test('real TCP response loss and abrupt controller process death recover one Run and one controlled start', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atomicagent-response-loss-'));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function start(mode: 'hold' | 'success') {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const child = fork(new URL(`./recovery-server.${extension}`, import.meta.url), [directory, mode], {
      execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(child);
    const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('recovery harness exited before listening'); })]);
    return { child, url: (ready as { url: string }).url };
  }
  const first = await start('hold');
  // The proxy receives the upstream 202 after durable acceptance, then destroys the actual client socket
  // without forwarding a response byte. No product fault flag or database mutation controls this experiment.
  let acceptedStatus = 0;
  const proxy = createServer((request, response) => {
    const upstream = httpRequest(first.url + '/v1/runs', { method: request.method, headers: request.headers }, received => {
      acceptedStatus = received.statusCode!;
      received.resume(); response.socket!.destroy();
    });
    upstream.on('error', () => response.destroy()); request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  const address = proxy.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}/v1/runs`, { method: 'POST', headers, body }));
  assert.equal(acceptedStatus, 202);
  const repeats = await Promise.all(Array.from({ length: 16 }, () => fetch(first.url + '/v1/runs', { method: 'POST', headers, body })));
  assert.ok(repeats.every(r => r.status === 202));
  const runs = await Promise.all(repeats.map(r => r.json()));
  const runId = runs[0].run_id;
  assert.equal(new Set(runs.map(r => r.run_id)).size, 1);
  let running;
  for (let i = 0; i < 100; i++) {
    running = await (await fetch(first.url + `/v1/runs/${runId}`, { headers })).json();
    if (running.attempt_id) break;
    await delay();
  }
  assert.ok(running.attempt_id);
  assert.equal(running.status, 'running');
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  const second = await start('success');
  assert.notEqual(second.child.pid, first.child.pid);
  const recovered = await (await fetch(second.url + '/v1/runs', { method: 'POST', headers, body })).json();
  assert.equal(recovered.run_id, runId);
  assert.equal(recovered.attempt_id, running.attempt_id);
  assert.equal(recovered.failure, 'execution_lost');
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.execution.manifest_digest, running.execution.manifest_digest);
  assert.equal((await (await fetch(second.url + '/v1/runs', { headers })).json()).runs.length, 1);
  const starts = (await readFile(join(directory, 'starts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].run_id, runId);
  assert.equal(starts[0].attempt_id, running.attempt_id);
  const closed = once(second.child, 'exit'); second.child.send('close'); await closed;
  t.diagnostic(`upstream_acceptance=202; client_response=TCP_reset; concurrent_retries=16; controller_processes=2; Run=1; Attempt=1; controlled_SandboxPort_starts=1; actual_model_starts=unverified`);
});
