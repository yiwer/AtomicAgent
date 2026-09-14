import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { fixtureProfile } from '../src/profile.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { ModelGateway, type CallMeasurement } from '../src/model-gateway.js';
import { createServer, request as httpRequest } from 'node:http';
import type { ObserveUsage } from '../src/usage.js';
import { callUsageEntries, mergeUsage, normalizeUsage, sdkUsageEntries, USAGE_ENTRY_LIMIT, type UsageEntry, type InvocationRecord, type UsageObservation } from '../src/usage.js';

const attempt = '11111111-1111-4111-8111-111111111111';
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 14, 0, 0, seconds)).toISOString();
function entry(overrides: Partial<UsageEntry> & { entry_id: string }): UsageEntry {
 return { series: 'model-tokens', attempt_id: attempt, invocation_id: null, scope: 'agent-main', provider: 'api.example/model-a',
  basis: 'sdk-estimate', unit: 'input_tokens', value: 100, reporting: 'cumulative', measurement_scope: 'attempt',
  completeness: 'complete', observation_version: 1, observed_at: at(1), source: 'engine:claude-agent-sdk', in_flight: false, ...overrides };
}
const bucket = (totals: ReturnType<typeof normalizeUsage>, basis: string, unit: string, provider = 'api.example/model-a') =>
 totals.find(t => t.basis === basis && t.unit === unit && t.provider === provider);

test('a cumulative series is replaced by its newest report; older, duplicate and out-of-order observations never add', () => {
 const totals = normalizeUsage([
  entry({ entry_id: 'a', value: 100, observation_version: 1 }),
  entry({ entry_id: 'b', value: 260, observation_version: 2, observed_at: at(2) }),
  entry({ entry_id: 'b', value: 260, observation_version: 2, observed_at: at(2) }),
  entry({ entry_id: 'c', value: 130, observation_version: 1, observed_at: at(3) }),
 ]);
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens')!.value, 260);
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens')!.series, 1);
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens')!.observations, 3);
});

test('delta observations sum once per stable observation identity and keep their own series apart', () => {
 const delta = { reporting: 'delta' as const, basis: 'provider-confirmed' as const, measurement_scope: 'invocation' as const };
 const totals = normalizeUsage([
  entry({ entry_id: 'call-1', series: 'invocation:1', value: 40, ...delta }),
  entry({ entry_id: 'call-1', series: 'invocation:1', value: 40, ...delta }),
  entry({ entry_id: 'call-2', series: 'invocation:2', value: 60, ...delta }),
 ]);
 assert.equal(bucket(totals, 'provider-confirmed', 'input_tokens')!.value, 100);
 assert.equal(bucket(totals, 'provider-confirmed', 'input_tokens')!.series, 2);
});

test('the same consumption reported by the engine estimate and by the provider is never summed into one total', () => {
 const totals = normalizeUsage([
  entry({ entry_id: 'sdk', value: 240 }),
  entry({ entry_id: 'provider', value: 240, basis: 'provider-confirmed', reporting: 'delta', series: 'invocation:1', measurement_scope: 'invocation' }),
 ]);
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens')!.value, 240);
 assert.equal(bucket(totals, 'provider-confirmed', 'input_tokens')!.value, 240);
 assert.equal(totals.filter(t => t.unit === 'input_tokens').length, 2);
});

test('two providers reporting the same unit stay in separate totals', () => {
 const totals = normalizeUsage([
  entry({ entry_id: 'a', value: 10 }),
  entry({ entry_id: 'b', value: 7, provider: 'other.example/model-b', series: 'other-tokens' }),
 ]);
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens')!.value, 10);
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens', 'other.example/model-b')!.value, 7);
});

test('unknown consumption stays unknown instead of zero and degrades the completeness of what is known', () => {
 const unknown = { value: null, completeness: 'unknown' as const };
 const only = normalizeUsage([entry({ entry_id: 'a', ...unknown })]);
 assert.equal(bucket(only, 'sdk-estimate', 'input_tokens')!.value, null);
 assert.equal(bucket(only, 'sdk-estimate', 'input_tokens')!.completeness, 'unknown');
 const mixed = normalizeUsage([
  entry({ entry_id: 'a', value: 12, series: 'known' }),
  entry({ entry_id: 'b', series: 'unmeasured', ...unknown }),
 ]);
 assert.equal(bucket(mixed, 'sdk-estimate', 'input_tokens')!.value, 12);
 assert.equal(bucket(mixed, 'sdk-estimate', 'input_tokens')!.unknown_series, 1);
 assert.equal(bucket(mixed, 'sdk-estimate', 'input_tokens')!.completeness, 'partial');
});

test('in-flight and failed calls are counted in their scope and flagged until an ending is observed', () => {
 const call = { unit: 'calls' as const, basis: 'platform-observed' as const, reporting: 'delta' as const, measurement_scope: 'invocation' as const };
 const started = normalizeUsage([entry({ entry_id: 'c1', series: 'invocation:1', value: 1, in_flight: true, completeness: 'partial', ...call })]);
 assert.equal(bucket(started, 'platform-observed', 'calls')!.value, 1);
 assert.equal(bucket(started, 'platform-observed', 'calls')!.in_flight, true);
 const ended = normalizeUsage([
  entry({ entry_id: 'c1', series: 'invocation:1', value: 1, in_flight: true, completeness: 'partial', ...call }),
  entry({ entry_id: 'c1-final', series: 'invocation:1', value: 0, ...call }),
  entry({ entry_id: 'c2', series: 'invocation:2', value: 1, ...call }),
 ]);
 assert.equal(bucket(ended, 'platform-observed', 'calls')!.value, 2);
 assert.equal(bucket(ended, 'platform-observed', 'calls')!.in_flight, false);
});

test('a series reported both cumulatively and incrementally is unusable rather than added twice', () => {
 const totals = normalizeUsage([
  entry({ entry_id: 'a', value: 10 }),
  entry({ entry_id: 'b', value: 10, reporting: 'delta' }),
 ]);
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens')!.value, null);
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens')!.completeness, 'unknown');
 assert.equal(bucket(totals, 'sdk-estimate', 'input_tokens')!.unknown_series, 1);
});

const invocation = (overrides: Partial<InvocationRecord> & { invocation_id: string }): InvocationRecord => ({
 parent_invocation_id: null, retry_of: null, attempt_id: attempt, kind: 'model', target: 'model-a', scope: 'agent-main',
 status: 'requested', source: 'platform:model-gateway', observed_at: at(1), ...overrides });

const observation = (overrides: Partial<UsageObservation> = {}): UsageObservation => ({ version: 1, run_id: 'run', attempt_id: attempt,
 source: 'platform:model-gateway', observed_at: at(1), coverage: 'controlled-model-and-mcp-calls', invocations: [], entries: [], ...overrides });

test('a later observation appends late facts and advances invocation status without rewriting earlier records', () => {
 const first = observation({ invocations: [invocation({ invocation_id: 'i1', status: 'started' })],
  entries: [entry({ entry_id: 'a', value: 100, invocation_id: 'i1' })] });
 const merged = mergeUsage(mergeUsage(undefined, first), { ...first, observed_at: at(9),
  invocations: [invocation({ invocation_id: 'i1', status: 'completed', observed_at: at(9) }), invocation({ invocation_id: 'i2', parent_invocation_id: 'i1', retry_of: null, observed_at: at(9) })],
  entries: [entry({ entry_id: 'a', value: 100, invocation_id: 'i1' }), entry({ entry_id: 'late', value: 260, observation_version: 2, observed_at: at(9), invocation_id: 'i1' })] });
 assert.equal(merged.entries.length, 2);
 assert.deepEqual(merged.entries[0], first.entries[0]);
 assert.equal(merged.invocations.find(i => i.invocation_id === 'i1')!.status, 'completed');
 assert.equal(merged.invocations.find(i => i.invocation_id === 'i2')!.parent_invocation_id, 'i1');
 assert.equal(bucket(normalizeUsage(merged.entries), 'sdk-estimate', 'input_tokens')!.value, 260);
});

test('a late observation contributes its own source and coverage instead of replacing what was already recorded', () => {
 const gateway = mergeUsage(undefined, observation({ entries: [entry({ entry_id: 'a', value: 100 })] }));
 const mcp = mergeUsage(gateway, observation({ source: 'platform:registered-mcp-observations', coverage: 'controlled-read-source-only', observed_at: at(9) }));
 assert.deepEqual(mcp.sources, ['platform:model-gateway', 'platform:registered-mcp-observations']);
 assert.deepEqual(mcp.coverage, ['controlled-model-and-mcp-calls', 'controlled-read-source-only']);
 assert.equal(mcp.accepted, 2);
 assert.deepEqual(mcp.entries, gateway.entries);
});

test('observations dropped at the ledger cap are reported as truncated rather than silently lost', () => {
 const oversized = Array.from({ length: 400 }, (_, index) => entry({ entry_id: `e${index}`, series: `s${index}`, value: 1, reporting: 'delta' }));
 const first = mergeUsage(undefined, observation({ entries: oversized }));
 assert.equal(first.truncated, false);
 const second = mergeUsage(first, observation({ observed_at: at(9), entries: oversized.map((e, index) => ({ ...e, entry_id: `late${index}`, series: `late${index}` })) }));
 assert.equal(second.entries.length, USAGE_ENTRY_LIMIT);
 assert.equal(second.truncated, true);
});

test('a late observation cannot move an ended invocation back to an earlier state', () => {
 const base = observation({ invocations: [invocation({ invocation_id: 'i1', status: 'failed', observed_at: at(5) })] });
 const merged = mergeUsage(mergeUsage(undefined, base), { ...base, invocations: [invocation({ invocation_id: 'i1', status: 'started', observed_at: at(9) })] });
 assert.equal(merged.invocations[0]!.status, 'failed');
 assert.equal(merged.invocations[0]!.observed_at, at(5));
});

test('two model names that sanitize to the same text keep separate series and provider keys', () => {
 const context = { attempt_id: attempt, endpoint: 'https://api.example/v1', model: 'a/b', version: 1, observed_at: at(1) };
 const entries = sdkUsageEntries(context, { 'a/b': { inputTokens: 10 }, 'a-b': { inputTokens: 7 } });
 const series = entries.filter(e => e.unit === 'input_tokens');
 assert.equal(new Set(series.map(e => e.series)).size, 2);
 assert.equal(new Set(series.map(e => e.provider)).size, 2);
 const totals = normalizeUsage(entries).filter(t => t.unit === 'input_tokens');
 assert.deepEqual(totals.map(t => t.value).sort(), [10, 7]);
 // The model the request asked for is the main scope; anything else the engine reports is auxiliary.
 assert.deepEqual([...new Set(series.map(e => e.scope))].sort(), ['agent-main', 'auxiliary']);
});

test('a call first seen in its ending state still counts as one call and is not in flight', () => {
 const call = { invocation_id: 'i1', attempt_id: attempt, scope: 'transport' as const, provider: 'p', source: 'platform:model-gateway', observed_at: at(1) };
 // A connectivity probe and a request that fails before it is dispatched are both first seen already ended.
 const ended = normalizeUsage(callUsageEntries({ ...call, in_flight: false }));
 assert.equal(bucket(ended, 'platform-observed', 'calls', 'p')!.value, 1);
 assert.equal(bucket(ended, 'platform-observed', 'calls', 'p')!.in_flight, false);
 assert.equal(bucket(ended, 'platform-observed', 'calls', 'p')!.completeness, 'complete');
 // Opening then closing the same call still totals one, and clears the in-flight flag.
 const lifecycle = normalizeUsage([...callUsageEntries({ ...call, in_flight: true }),
  ...callUsageEntries({ ...call, observed_at: at(2), in_flight: false }).slice(1)]);
 assert.equal(bucket(lifecycle, 'platform-observed', 'calls', 'p')!.value, 1);
 assert.equal(bucket(lifecycle, 'platform-observed', 'calls', 'p')!.in_flight, false);
});

test('an engine model the SDK could not price reports unknown cost rather than zero', () => {
 const context = { attempt_id: attempt, endpoint: 'https://api.example/v1', model: 'm', version: 1, observed_at: at(1) };
 const priced = sdkUsageEntries(context, { m: { inputTokens: 4, costUSD: 0.25, costBasis: 'list' } });
 assert.equal(priced.find(e => e.unit === 'estimated_cost_micro_usd')!.value, 250_000);
 const unpriced = sdkUsageEntries(context, { m: { inputTokens: 4, costUSD: 0.25, costBasis: 'unknown' } });
 assert.equal(unpriced.find(e => e.unit === 'estimated_cost_micro_usd')!.value, null);
 assert.equal(unpriced.find(e => e.unit === 'estimated_cost_micro_usd')!.completeness, 'unknown');
});

const identities = [{ token: 'm'.repeat(40), actor: 'operator', workspace: 'lab', role: 'maintainer' as const },
 { token: 'c'.repeat(40), actor: 'caller', workspace: 'lab', role: 'caller' as const },
 { token: 'h'.repeat(40), actor: 'health', workspace: 'lab', role: 'health' as const }];
const task = { prompt: 'three apples', profile: 'json-lab@1', output_contract: 'summary-value@1' };
async function lab(t: TestContext, sandbox = new FixtureSandbox()) {
 const directory = await mkdtemp(join(tmpdir(), 'atomic-usage-'));
 const options = { database: join(directory, 'runs.db'), profile: { ...fixtureProfile, timeout_seconds: 3600 }, identities, sandbox };
 let app = await createApp(options), url = await app.listen();
 t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
 return { sandbox, database: options.database,
  async restart() { await app.close(); app = await createApp(options); url = await app.listen(); },
  request(path: string, data?: unknown, key = 'usage', token = identities[0]!.token) {
   return fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  } };
}
interface PublicTotals { totals: { basis: string; unit: string; value: number | null; provider: string; completeness: string }[] }
const total = (usage: PublicTotals, basis: string, unit: string) => usage.totals.find(t => t.basis === basis && t.unit === unit);

test('a Run reports normalized consumption with source, unit, estimate/confirmation split and unknown range, and it survives restart', async t => {
 const l = await lab(t);
 const run = await (await l.request('/v1/runs?wait_seconds=5', task, 'measured')).json();
 assert.equal(run.status, 'succeeded');
 const usage = run.usage;
 assert.equal(usage.provider, 'deterministic-fixture:no-model');
 assert.equal(usage.measured, true);
 assert.equal(usage.in_flight, false);
 // The engine reports a cumulative session total twice; the later report replaces the earlier one.
 assert.equal(total(usage, 'sdk-estimate', 'input_tokens')!.value, 310);
 assert.equal(total(usage, 'sdk-estimate', 'output_tokens')!.value, 64);
 // The same consumption confirmed by the provider stays a separate figure and is never added to the estimate.
 assert.equal(total(usage, 'provider-confirmed', 'input_tokens')!.value, 118);
 assert.equal(total(usage, 'provider-confirmed', 'output_tokens')!.value, 21);
 assert.equal(total(usage, 'platform-observed', 'calls')!.value, 1);
 assert.equal(total(usage, 'platform-observed', 'request_bytes')!.value, 512);
 // No priced provider stands behind a fixture: cost stays unknown instead of becoming a zero.
 assert.equal(total(usage, 'sdk-estimate', 'estimated_cost_micro_usd')!.value, null);
 assert.equal(total(usage, 'sdk-estimate', 'estimated_cost_micro_usd')!.completeness, 'unknown');
 assert.equal(usage.budget.unsupported[0].dimension, 'cost');
 assert.ok(usage.budget.enforced.some((d: { dimension: string }) => d.dimension === 'artifact_bytes'));
 assert.equal(usage.invocations.length, 1);
 assert.equal(usage.invocations[0].status, 'completed');
 assert.equal(usage.invocations[0].attempt_id, run.attempt_id);
 await l.restart();
 const reread = await (await l.request(`/v1/runs/${run.run_id}`)).json();
 assert.deepEqual(reread.usage.totals, usage.totals);
 assert.deepEqual(reread.usage.entries, usage.entries);
});

test('re-observation adds nothing, a late report appends after the terminal state and an unusable report leaves consumption unknown', async t => {
 const sandbox = new FixtureSandbox();
 const base = sandbox.execute.bind(sandbox);
 let observe: ObserveUsage | undefined, last: unknown;
 sandbox.execute = async (run, signal, skills, mcp, boundary, resources, usage) => {
  observe = value => { last = value; usage?.(value); };
  return base(run, signal, skills, mcp, boundary, resources, observe);
 };
 const l = await lab(t, sandbox);
 const run = await (await l.request('/v1/runs?wait_seconds=5', task, 'repeat')).json();
 const before = run.usage;
 assert.ok(observe && last);
 observe!(last);
 const repeated = await (await l.request(`/v1/runs/${run.run_id}`)).json();
 assert.deepEqual(repeated.usage.totals, before.totals);
 assert.equal(repeated.usage.entries.length, before.entries.length);
 assert.equal(repeated.usage.imports.accepted, before.imports.accepted + 1);
 // A late arrival appends its own observation and leaves every earlier record byte for byte unchanged.
 const ledger = last as { entries: UsageEntry[] };
 const original = ledger.entries.find(e => e.series === 'sdk:input_tokens')!;
 observe!({ ...ledger, entries: [...ledger.entries, { ...original, entry_id: 'sdk:input_tokens:v9', value: 480, observation_version: 9 }] });
 const late = await (await l.request(`/v1/runs/${run.run_id}`)).json();
 assert.equal(total(late.usage, 'sdk-estimate', 'input_tokens')!.value, 480);
 assert.deepEqual(late.usage.entries.slice(0, before.entries.length), before.entries);
 // An untrusted or malformed report is not imported at all and does not change the committed Run.
 observe!({ version: 1, run_id: 'not-this-run', attempt_id: run.attempt_id, source: 'x', observed_at: new Date().toISOString(), coverage: 'x', invocations: [], entries: [] });
 const rejected = await (await l.request(`/v1/runs/${run.run_id}`)).json();
 assert.equal(rejected.usage.imports.rejected, 1);
 assert.deepEqual(rejected.usage.totals, late.usage.totals);
 assert.equal(rejected.status, 'succeeded');
});

test('a failed attempt still reports what it consumed', async t => {
 const l = await lab(t, new FixtureSandbox('invalid'));
 const run = await (await l.request('/v1/runs?wait_seconds=5', task, 'invalid')).json();
 assert.equal(run.failure, 'output_invalid');
 assert.equal(run.usage.measured, true);
 assert.equal(total(run.usage, 'platform-observed', 'calls')!.value, 1);
 assert.equal(total(run.usage, 'sdk-estimate', 'input_tokens')!.value, 310);
 assert.equal(run.usage.invocations[0].status, 'completed');
});

test('the quota view aggregates the same facts the task view reports, and server authorization decides its scope', async t => {
 const l = await lab(t);
 const mine = await (await l.request('/v1/runs?wait_seconds=5', task, 'aggregate-a')).json();
 await (await l.request('/v1/runs?wait_seconds=5', task, 'aggregate-b')).json();
 const workspace = await (await l.request('/v1/usage')).json();
 assert.equal(workspace.scope, 'workspace');
 assert.equal(workspace.runs, 2);
 assert.equal(workspace.measured_runs, 2);
 assert.equal(workspace.in_flight_runs, 0);
 assert.equal(total(workspace, 'sdk-estimate', 'input_tokens')!.value, 620);
 assert.equal(total(workspace, 'provider-confirmed', 'input_tokens')!.value, 236);
 assert.equal(total(workspace, 'sdk-estimate', 'estimated_cost_micro_usd')!.value, null);
 const row = workspace.by_run.find((r: { run_id: string }) => r.run_id === mine.run_id);
 assert.equal(row.usage.entry_count, mine.usage.entries.length);
 assert.deepEqual(row.usage.totals, mine.usage.totals);
 // A caller aggregates only the Runs it owns; a health reader cannot read business consumption at all.
 const own = await (await l.request('/v1/usage', undefined, 'usage', identities[1]!.token)).json();
 assert.equal(own.scope, 'own-runs');
 assert.equal(own.runs, 0);
 assert.deepEqual(own.totals, []);
 assert.equal((await l.request('/v1/usage', undefined, 'usage', identities[2]!.token)).status, 403);
 const health = await (await l.request('/internal/health')).json();
 assert.equal(total(health.usage, 'sdk-estimate', 'input_tokens')!.value, 620);
 assert.equal(health.usage.confirmed_cost, null);
 assert.deepEqual(health.usage.providers, ['deterministic-fixture:no-model']);
 const db = new DatabaseSync(l.database);
 try {
  assert.ok(Number(db.prepare("SELECT count(*) AS n FROM audit WHERE action='usage.observed' AND outcome='recorded'").get()!.n) >= 2);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM audit WHERE action='invocation.observed' AND outcome='completed'").get()!.n), 2);
  assert.ok(Number(db.prepare("SELECT count(*) AS n FROM audit WHERE action='usage.read'").get()!.n) >= 2);
 } finally { db.close(); }
});

test('registered read-only MCP reads are measured under their own provider and never merged into model units', async t => {
 const l = await lab(t);
 const catalog = await (await l.request('/v1/configurations')).json();
 const command = { action: 'publish', kind: 'mcp', name: 'research', expected_generation: 0, content: { binding_ref: catalog.bindings.mcps[0].binding_ref }, reason: 'Measure registered reads' };
 const preview = await (await l.request('/v1/configurations/preview', command)).json();
 assert.equal((await l.request('/v1/configurations/commands', { ...command, preview_digest: preview.preview_digest })).status, 200);
 const run = await (await l.request('/v1/runs?wait_seconds=10', { ...task, prompt: 'Compare project scope and identify unknown reliability.', output_contract: 'research-report@1', mcp: [{ id: 'research', version: '1' }] }, 'mcp-run')).json();
 assert.equal(run.status, 'succeeded');
 const mcpTotals = run.usage.totals.filter((t: { provider: string }) => t.provider.startsWith('registered-mcp/'));
 assert.equal(mcpTotals.find((t: { unit: string }) => t.unit === 'calls').value, 2);
 assert.equal(mcpTotals.find((t: { unit: string }) => t.unit === 'calls').scope, 'registered-readonly');
 assert.ok(mcpTotals.find((t: { unit: string }) => t.unit === 'source_bytes').value > 0);
 // Model units keep their own provider key; a read-only source byte is never added to a model token.
 assert.equal(total(run.usage, 'sdk-estimate', 'input_tokens')!.provider, 'deterministic-fixture:no-model');
 assert.equal(run.usage.invocations.filter((i: { kind: string }) => i.kind === 'mcp').length, 2);
 assert.equal(run.usage.in_flight, false);
 const workspace = await (await l.request('/v1/usage')).json();
 assert.equal(workspace.totals.filter((t: { provider: string }) => t.provider.startsWith('registered-mcp/')).find((t: { unit: string }) => t.unit === 'calls').value, 2);
});

test('the gateway records only the provider own usage report and reports nothing rather than a partial number', async t => {
 const root = await mkdtemp(join(tmpdir(), 'atomic-usage-gateway-'));
 let body = '', type = 'application/json';
 const upstream = createServer((_request, response) => { response.writeHead(200, { 'content-type': type }); response.end(body); });
 await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
 const port = (upstream.address() as { port: number }).port;
 const socket = process.platform === 'win32' ? `\\\\.\\pipe\\atomic-usage-${Date.now()}` : join(root, 'gateway.sock');
 const seen: { outcome: string; measurement?: CallMeasurement }[] = [];
 const gateway = new ModelGateway({ endpoint: `http://127.0.0.1:${port}`, model: 'approved-model', token: 'CANARY_PRIVATE_MODEL_TOKEN', deadline: Date.now() + 30_000 },
  async event => { seen.push({ outcome: event.outcome, measurement: event.measurement }); });
 await gateway.listen(socket);
 t.after(async () => { await gateway.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
 const call = (payload: unknown) => new Promise<void>((resolve, reject) => {
  const data = JSON.stringify(payload);
  const sent = httpRequest({ socketPath: socket, method: 'POST', path: '/v1/messages', headers: { 'content-length': Buffer.byteLength(data) } }, response => { response.resume(); response.on('end', () => resolve()); });
  sent.on('error', reject); sent.end(data);
 });
 const payload = { model: 'approved-model', messages: [], max_tokens: 10 };
 body = JSON.stringify({ usage: { input_tokens: 91, output_tokens: 17, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 } });
 await call(payload);
 assert.deepEqual(seen.at(-1)!.measurement!.tokens, { input_tokens: 91, output_tokens: 17, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
 assert.equal(seen.at(-1)!.measurement!.request_bytes, Buffer.byteLength(JSON.stringify(payload)));
 type = 'text/event-stream';
 body = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":40,"cache_read_input_tokens":7}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":33}}\n\n';
 await call(payload);
 assert.equal(seen.at(-1)!.measurement!.tokens!.input_tokens, 40);
 assert.equal(seen.at(-1)!.measurement!.tokens!.output_tokens, 33);
 assert.equal(seen.at(-1)!.measurement!.tokens!.cache_read_input_tokens, 7);
 // A response carrying no usage report is unknown, never zero — and it is marked as actually dispatched,
 // so the runner records an unknown provider figure instead of dropping the call.
 type = 'application/json'; body = JSON.stringify({ content: [] });
 await call(payload);
 assert.equal(seen.at(-1)!.measurement!.tokens, null);
 assert.equal(seen.at(-1)!.measurement!.dispatched, true);
 // A refused request never reached the provider, so it is not reported as unknown provider consumption.
 await call({ model: 'another-model', messages: [] });
 assert.equal(seen.at(-1)!.outcome, 'denied');
 assert.equal(seen.at(-1)!.measurement!.dispatched, false);
 type = 'application/json'; body = JSON.stringify({ content: [] });
 // An oversized body is not parsed at all rather than reported from a truncated prefix.
 body = JSON.stringify({ usage: { input_tokens: 5 }, filler: 'x'.repeat(300_000) });
 await call(payload);
 assert.equal(seen.at(-1)!.measurement!.tokens, null);
 assert.ok(seen.at(-1)!.measurement!.response_bytes > 262_144);
});
