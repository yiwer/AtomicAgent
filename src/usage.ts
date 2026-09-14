import { createHash } from 'node:crypto';
import { now, type Profile, type Run } from './domain.js';
import { effectiveLimits } from './limits.js';
import type { McpEvidence } from './research.js';

// One bounded allowlist governs every usage observation that leaves an execution boundary.
export const usageUnits = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
 'web_search_requests', 'estimated_cost_micro_usd', 'calls', 'request_bytes', 'response_bytes', 'source_bytes'] as const;
export const providerTokenUnits = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
export const usageBases = ['sdk-estimate', 'provider-confirmed', 'platform-observed'] as const;
export const usageScopes = ['agent-main', 'auxiliary', 'transport', 'registered-readonly'] as const;
export const invocationKinds = ['model', 'tool', 'mcp', 'transport'] as const;
export const invocationStatuses = ['requested', 'admitted', 'started', 'completed', 'failed', 'denied', 'unknown'] as const;
export type UsageUnit = typeof usageUnits[number];
export type UsageBasis = typeof usageBases[number];
export type UsageScope = typeof usageScopes[number];
export type InvocationStatus = typeof invocationStatuses[number];
export const USAGE_INVOCATION_LIMIT = 128, USAGE_ENTRY_LIMIT = 512;
// Deliberately ranked so a definite ending outranks 'unknown' and no late report walks an ending backwards.
const statusRank: Record<InvocationStatus, number> = { requested: 0, admitted: 1, started: 2, unknown: 3, completed: 4, failed: 4, denied: 4 };

export interface InvocationRecord {
 invocation_id: string; parent_invocation_id: string | null; retry_of: string | null; attempt_id: string;
 kind: typeof invocationKinds[number]; target: string; scope: UsageScope;
 status: InvocationStatus; source: string; observed_at: string;
}
export interface UsageEntry {
 entry_id: string; series: string; attempt_id: string; invocation_id: string | null; scope: UsageScope;
 provider: string; basis: UsageBasis; unit: UsageUnit; value: number | null;
 reporting: 'cumulative' | 'delta'; measurement_scope: 'invocation' | 'attempt' | 'run';
 completeness: 'complete' | 'partial' | 'unknown'; observation_version: number;
 observed_at: string; source: string; in_flight: boolean;
}
// What one observer reports at one moment: exactly one source and one coverage statement.
export interface UsageObservation {
 version: 1; run_id: string; attempt_id: string; source: string; observed_at: string; coverage: string;
 invocations: InvocationRecord[]; entries: UsageEntry[];
}
// What the Run durably holds: the union of every accepted observation, with each contributing source kept.
export interface UsageLedger {
 version: 1; run_id: string; attempt_id: string; observed_at: string; sources: string[]; coverage: string[];
 invocations: InvocationRecord[]; entries: UsageEntry[]; accepted: number; rejected: number; truncated: boolean;
}
export interface UsageTotal {
 provider: string; basis: UsageBasis; unit: UsageUnit; scope: UsageScope;
 value: number | null; series: number; observations: number; unknown_series: number;
 in_flight: boolean; completeness: 'complete' | 'partial' | 'unknown'; observed_at: string | null; sources: string[];
}
export type ObserveUsage = (value: unknown) => void;
export class UsageRejected extends Error { constructor() { super('usage_observation_rejected'); } }

// Identity tokens must survive sanitizing without colliding: two different names never normalize to one series.
export function usageToken(value: string, limit = 64): string {
 const safe = value.replace(/[^\w.:-]/g, '-').slice(0, limit);
 return safe === value ? safe : `${safe || 'unnamed'}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}
// Provider identity carries the endpoint host and model: two providers' units are never added together,
// and a list-price estimate from one engine is never reused as another provider's figure.
export function providerIdentity(endpoint: string, model: string): string {
 let host = 'unknown-endpoint';
 try { host = new URL(endpoint).hostname; } catch { /* An unusable endpoint is still its own distinct key. */ }
 return `${usageToken(host)}/${usageToken(model)}`;
}
export function usageProvider(profile: Profile): string {
 return profile.mode === 'fixture' ? 'deterministic-fixture:no-model' : providerIdentity(profile.endpoint, profile.model);
}
export const invocationOpen = (status: InvocationStatus) => statusRank[status] < statusRank.unknown;

// Every observed call counts exactly once, on first sighting, whatever its outcome. The closing observation
// adds no further call; it only records that this invocation is no longer in flight.
export function callUsageEntries(call: { invocation_id: string; attempt_id: string; scope: UsageScope; provider: string; source: string; observed_at: string; in_flight: boolean }): UsageEntry[] {
 const shared = { attempt_id: call.attempt_id, invocation_id: call.invocation_id, scope: call.scope, provider: call.provider,
  source: call.source, observed_at: call.observed_at, series: `call:${call.invocation_id}:calls`,
  basis: 'platform-observed' as const, unit: 'calls' as const, reporting: 'delta' as const, measurement_scope: 'invocation' as const };
 const entries: UsageEntry[] = [{ ...shared, entry_id: `call:${call.invocation_id}:calls`, value: 1,
  completeness: call.in_flight ? 'partial' : 'complete', observation_version: 1, in_flight: call.in_flight }];
 if (!call.in_flight) entries.push({ ...shared, entry_id: `call:${call.invocation_id}:calls-end`, value: 0,
  completeness: 'complete', observation_version: 2, in_flight: false });
 return entries;
}

// Built inside an execution boundary and re-read as a whole snapshot; it only ever adds observations.
export class UsageSpool {
 private invocations = new Map<string, InvocationRecord>();
 private entries = new Map<string, UsageEntry>();
 private truncated = false;
 constructor(private context: { run_id: string; attempt_id: string; source: string }) {}
 invocation(record: InvocationRecord) {
  const existing = this.invocations.get(record.invocation_id);
  if (existing) { if (statusRank[record.status] > statusRank[existing.status]) this.invocations.set(record.invocation_id, record); return; }
  if (this.invocations.size >= USAGE_INVOCATION_LIMIT) { this.truncated = true; return; }
  this.invocations.set(record.invocation_id, record);
 }
 entry(entry: UsageEntry) {
  if (this.entries.has(entry.entry_id)) return;
  if (this.entries.size >= USAGE_ENTRY_LIMIT) { this.truncated = true; return; }
  this.entries.set(entry.entry_id, entry);
 }
 observation(): UsageObservation {
  return { version: 1, run_id: this.context.run_id, attempt_id: this.context.attempt_id, source: this.context.source,
   observed_at: new Date().toISOString(),
   coverage: this.truncated ? 'controlled-boundary-observations:truncated' : 'controlled-boundary-observations',
   invocations: [...this.invocations.values()], entries: [...this.entries.values()] };
 }
}

const token = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value);
const id = /^[\w.:-]{1,160}$/, name = /^[\w@./:-]{1,160}$/;

export function validateUsage(run: Run, value: unknown): UsageObservation {
 const observation = value as UsageObservation;
 const floor = Date.parse(run.accepted_at), ceiling = Date.now() + 1000;
 const inWindow = (at: unknown) => typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) >= floor && Date.parse(at) <= ceiling;
 if (!observation || typeof observation !== 'object' || observation.version !== 1 || observation.run_id !== run.run_id ||
  !run.attempt_id || observation.attempt_id !== run.attempt_id ||
  !token(observation.source, name) || !token(observation.coverage, name) || !inWindow(observation.observed_at) ||
  !Array.isArray(observation.invocations) || observation.invocations.length > USAGE_INVOCATION_LIMIT ||
  !Array.isArray(observation.entries) || observation.entries.length > USAGE_ENTRY_LIMIT) throw new UsageRejected();
 const invocations = observation.invocations.map(raw => {
  const i = raw as InvocationRecord;
  if (!i || !token(i.invocation_id, id) || (i.parent_invocation_id !== null && !token(i.parent_invocation_id, id)) ||
   (i.retry_of !== null && !token(i.retry_of, id)) || i.attempt_id !== run.attempt_id || !invocationKinds.includes(i.kind) ||
   !token(i.target, name) || !usageScopes.includes(i.scope) || !invocationStatuses.includes(i.status) ||
   !token(i.source, name) || !inWindow(i.observed_at)) throw new UsageRejected();
  return { invocation_id: i.invocation_id, parent_invocation_id: i.parent_invocation_id, retry_of: i.retry_of, attempt_id: i.attempt_id,
   kind: i.kind, target: i.target, scope: i.scope, status: i.status, source: i.source, observed_at: i.observed_at };
 });
 const known = new Set(invocations.map(i => i.invocation_id));
 if (known.size !== invocations.length) throw new UsageRejected();
 for (const i of invocations) {
  if (i.invocation_id === i.parent_invocation_id || i.invocation_id === i.retry_of) throw new UsageRejected();
  for (const reference of [i.parent_invocation_id, i.retry_of]) if (reference !== null && !known.has(reference)) throw new UsageRejected();
 }
 const entries = observation.entries.map(raw => {
  const e = raw as UsageEntry;
  if (!e || !token(e.entry_id, id) || !token(e.series, id) || e.attempt_id !== run.attempt_id ||
   (e.invocation_id !== null && !known.has(e.invocation_id as string)) || !usageScopes.includes(e.scope) ||
   !token(e.provider, name) || !usageBases.includes(e.basis) || !usageUnits.includes(e.unit) ||
   !['cumulative', 'delta'].includes(e.reporting) || !['invocation', 'attempt', 'run'].includes(e.measurement_scope) ||
   !['complete', 'partial', 'unknown'].includes(e.completeness) ||
   // Unknown consumption is never a number and a number is never labelled unknown.
   (e.value === null) !== (e.completeness === 'unknown') ||
   (e.value !== null && (!Number.isSafeInteger(e.value) || e.value < 0 || e.value > 2 ** 42)) ||
   !Number.isSafeInteger(e.observation_version) || e.observation_version < 1 || e.observation_version > 1_000_000 ||
   !inWindow(e.observed_at) || !token(e.source, name) || typeof e.in_flight !== 'boolean' ||
   (e.measurement_scope === 'invocation' && e.invocation_id === null)) throw new UsageRejected();
  // Run-scoped identities keep one Run's series from colliding with another's during aggregation.
  return { entry_id: `${run.run_id}:${e.entry_id}`, series: `${run.run_id}:${e.series}`, attempt_id: e.attempt_id,
   invocation_id: e.invocation_id, scope: e.scope, provider: e.provider, basis: e.basis, unit: e.unit, value: e.value,
   reporting: e.reporting, measurement_scope: e.measurement_scope, completeness: e.completeness,
   observation_version: e.observation_version, observed_at: e.observed_at, source: e.source, in_flight: e.in_flight };
 });
 const collisions = new Map<string, string>();
 for (const e of entries) {
  const document = JSON.stringify(e, Object.keys(e).sort());
  if ((collisions.get(e.entry_id) ?? document) !== document) throw new UsageRejected();
  collisions.set(e.entry_id, document);
 }
 return { version: 1, run_id: observation.run_id, attempt_id: observation.attempt_id, source: observation.source,
  observed_at: observation.observed_at, coverage: observation.coverage, invocations, entries };
}

// Observations are append-only: a later report adds entries, advances status and contributes its own source
// statement. It never rewrites an earlier record, and anything dropped at the cap is reported as truncated.
export function mergeUsage(previous: UsageLedger | undefined, incoming: UsageObservation): UsageLedger {
 const invocations = [...(previous?.invocations ?? [])];
 let truncated = previous?.truncated ?? false;
 for (const next of incoming.invocations) {
  const index = invocations.findIndex(i => i.invocation_id === next.invocation_id);
  if (index < 0) { if (invocations.length >= USAGE_INVOCATION_LIMIT) { truncated = true; continue; } invocations.push(next); continue; }
  if (statusRank[next.status] > statusRank[invocations[index]!.status]) invocations[index] = next;
 }
 const entries = [...(previous?.entries ?? [])];
 const seen = new Set(entries.map(e => e.entry_id));
 for (const next of incoming.entries) {
  if (seen.has(next.entry_id)) continue;
  if (entries.length >= USAGE_ENTRY_LIMIT) { truncated = true; continue; }
  seen.add(next.entry_id); entries.push(next);
 }
 return { version: 1, run_id: incoming.run_id, attempt_id: incoming.attempt_id,
  observed_at: incoming.observed_at > (previous?.observed_at ?? '') ? incoming.observed_at : previous!.observed_at,
  sources: [...new Set([...(previous?.sources ?? []), incoming.source])].sort(),
  coverage: [...new Set([...(previous?.coverage ?? []), incoming.coverage])].sort(),
  invocations, entries, accepted: (previous?.accepted ?? 0) + 1, rejected: previous?.rejected ?? 0, truncated };
}
export function rejectUsage(previous: UsageLedger | undefined, run: Run): UsageLedger {
 return previous ? { ...previous, rejected: previous.rejected + 1 }
  : { version: 1, run_id: run.run_id, attempt_id: run.attempt_id ?? 'unknown', observed_at: run.accepted_at,
      sources: [], coverage: ['usage-observation-unusable'], invocations: [], entries: [], accepted: 0, rejected: 1, truncated: false };
}

export function normalizeUsage(entries: UsageEntry[]): UsageTotal[] {
 const buckets = new Map<string, { key: Pick<UsageTotal, 'provider' | 'basis' | 'unit' | 'scope'>; series: Map<string, UsageEntry[]> }>();
 for (const entry of entries) {
  const key = JSON.stringify([entry.provider, entry.basis, entry.unit, entry.scope]);
  const bucket = buckets.get(key) ?? { key: { provider: entry.provider, basis: entry.basis, unit: entry.unit, scope: entry.scope }, series: new Map() };
  bucket.series.set(entry.series, [...(bucket.series.get(entry.series) ?? []), entry]);
  buckets.set(key, bucket);
 }
 return [...buckets.values()].map(bucket => {
  let value: number | null = null, unknown_series = 0, observations = 0, in_flight = false, partial = false;
  let observed_at: string | null = null; const sources = new Set<string>();
  for (const [, all] of bucket.series) {
   const unique = [...new Map(all.map(entry => [entry.entry_id, entry])).values()];
   observations += unique.length;
   for (const entry of unique) { sources.add(entry.source); if (entry.observed_at > (observed_at ?? '')) observed_at = entry.observed_at; }
   // A series reported both ways cannot be reconciled; it stays unknown rather than being added twice.
   const mixed = new Set(unique.map(entry => entry.reporting)).size !== 1;
   const contributing = mixed ? [] : unique[0]!.reporting === 'delta' ? unique
    : [unique.reduce((best, entry) => entry.observation_version > best.observation_version ||
      (entry.observation_version === best.observation_version && entry.observed_at > best.observed_at) ? entry : best)];
   if (contributing.some(entry => entry.in_flight && !unique.some(other => other.observed_at >= entry.observed_at && !other.in_flight))) in_flight = true;
   if (mixed || contributing.some(entry => entry.value === null)) { unknown_series++; partial = true; continue; }
   if (contributing.some(entry => entry.completeness !== 'complete')) partial = true;
   value = (value ?? 0) + contributing.reduce((sum, entry) => sum + entry.value!, 0);
  }
  const completeness = value === null ? 'unknown' as const : partial ? 'partial' as const : 'complete' as const;
  return { ...bucket.key, value, series: bucket.series.size, observations, unknown_series, in_flight, completeness, observed_at, sources: [...sources].sort() };
 }).sort((a, b) => `${a.provider}${a.basis}${a.unit}${a.scope}`.localeCompare(`${b.provider}${b.basis}${b.unit}${b.scope}`));
}

const freshnessOf = (run: Run, ledger?: UsageLedger) => !ledger ? 'unknown' :
 run.terminal_at ? 'final-recorded-observation' : Date.now() - Date.parse(ledger.observed_at) <= 60_000 ? 'fresh' : 'stale';
// What the recorded shape can carry versus what a controlled boundary can actually observe today.
const linkage = {
 parent: 'recorded-when-observable; the controlled boundary cannot attribute one tool or MCP call to one model turn, so it stays null rather than inferred',
 retry: 'v0 performs no stage retry, so retry_of stays null; ticket13 owns bounded stage retries and their linkage',
};

// The budget dimensions this platform actually enforces, and the measured units that only inform.
export function usageBudget(limits: { total_timeout_seconds: number; artifact_bytes: number; memory_mib: number; input_bytes: number; policy_revision: number }) {
 return {
  enforced: [
   { dimension: 'total_timeout_seconds', limit: limits.total_timeout_seconds, source: 'platform:fixed-execution-limits' },
   { dimension: 'artifact_bytes', limit: limits.artifact_bytes, source: 'platform:fixed-execution-limits' },
   { dimension: 'memory_mib', limit: limits.memory_mib, source: 'platform:fixed-execution-limits' },
   { dimension: 'input_bytes', limit: limits.input_bytes, source: 'platform:fixed-execution-limits' },
  ],
  observed_only: ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'calls', 'request_bytes', 'response_bytes', 'source_bytes'],
  unsupported: [{ dimension: 'cost', reason: 'no-provider-billing-adapter; engine list-price figures are estimates, not statements' }],
  policy_revision: limits.policy_revision,
 };
}
export function usageView(run: Run) {
 const ledger = run.usage;
 const totals = normalizeUsage(ledger?.entries ?? []);
 return {
  source: 'platform:durable-usage-ledger', queried_at: now(), observed_at: ledger?.observed_at ?? null,
  freshness: freshnessOf(run, ledger),
  coverage: ledger?.coverage.length ? ledger.coverage.join('; ') : 'no-usage-observation-recorded',
  observation_sources: ledger?.sources ?? [], truncated: ledger?.truncated ?? false, linkage,
  attempt_id: ledger?.attempt_id ?? null, provider: usageProvider(run.manifest.profile),
  imports: { accepted: ledger?.accepted ?? 0, rejected: ledger?.rejected ?? 0 },
  measured: Boolean(ledger?.entries.length),
  in_flight: totals.some(total => total.in_flight) || (ledger?.invocations ?? []).some(i => invocationOpen(i.status)),
  invocations: ledger?.invocations ?? [], entries: ledger?.entries ?? [], totals, budget: usageBudget(effectiveLimits(run)),
 };
}
// The list and aggregate views carry the same normalized facts without the per-observation ledger.
// The budget policy is workspace-wide, so it is read once from the quota view instead of once per Run.
export function usageSummary(run: Run) {
 const { invocations, entries, budget, linkage: _linkage, ...summary } = usageView(run);
 return { ...summary, invocation_count: invocations.length, entry_count: entries.length,
  open_invocations: invocations.filter(i => invocationOpen(i.status)).length,
  unknown_invocations: invocations.filter(i => i.status === 'unknown').length };
}

// The engine reports one cumulative per-model total per result message. It is an estimate, never a bill,
// and a model the engine could not price stays unknown instead of being written down as a number.
export interface EngineModelUsage { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; webSearchRequests?: number; costUSD?: number; costBasis?: 'list' | 'managed' | 'unknown' }
export function sdkUsageEntries(context: { attempt_id: string; endpoint: string; model: string; version: number; observed_at: string }, modelUsage: Record<string, EngineModelUsage> | undefined): UsageEntry[] {
 const entries: UsageEntry[] = [];
 for (const [reported, usage] of Object.entries(modelUsage ?? {}).slice(0, 8)) {
  if (!usage || typeof usage !== 'object') continue;
  const model = usageToken(reported);
  const shared = { attempt_id: context.attempt_id, invocation_id: null, scope: (reported === context.model ? 'agent-main' : 'auxiliary') as UsageScope,
   provider: providerIdentity(context.endpoint, reported), basis: 'sdk-estimate' as const, reporting: 'cumulative' as const,
   measurement_scope: 'attempt' as const, observation_version: context.version, observed_at: context.observed_at,
   source: 'engine:claude-agent-sdk', in_flight: false };
  const counted = (unit: UsageUnit, value: number | undefined) => {
   const known = Number.isSafeInteger(value) && value! >= 0;
   entries.push({ ...shared, entry_id: `sdk:${model}:${unit}:v${context.version}`, series: `sdk:${model}:${unit}`, unit,
    value: known ? value! : null, completeness: known ? 'complete' : 'unknown' });
  };
  counted('input_tokens', usage.inputTokens); counted('output_tokens', usage.outputTokens);
  counted('cache_read_input_tokens', usage.cacheReadInputTokens); counted('cache_creation_input_tokens', usage.cacheCreationInputTokens);
  counted('web_search_requests', usage.webSearchRequests);
  const priced = (usage.costBasis ?? 'list') !== 'unknown' && typeof usage.costUSD === 'number' && Number.isFinite(usage.costUSD) && usage.costUSD >= 0;
  counted('estimated_cost_micro_usd', priced ? Math.round(usage.costUSD! * 1e6) : undefined);
 }
 return entries;
}

// Registered read-only MCP reads are separately measured consumption. They are folded in from already validated
// evidence, so re-observation of the same call adds nothing and no MCP figure is invented.
export function mcpUsageLedger(run: Run, evidence: McpEvidence[]): UsageObservation | undefined {
 if (!run.attempt_id || !evidence.length) return undefined;
 const invocations: InvocationRecord[] = [], entries: UsageEntry[] = [];
 let observed_at = run.accepted_at;
 const advance = (at: string) => { if (at > observed_at && Date.parse(at) <= Date.now() + 1000) observed_at = at; };
 for (const e of evidence) {
  const provider = `registered-mcp/${usageToken(e.id)}@${usageToken(e.version)}`;
  for (const call of e.calls) {
   const in_flight = call.outcome === 'started';
   invocations.push({ invocation_id: call.invocation_id, parent_invocation_id: null, retry_of: null, attempt_id: run.attempt_id,
    kind: 'mcp', target: `${usageToken(e.id)}:${call.source_id ?? 'denied-tool'}`, scope: 'registered-readonly', source: e.source,
    status: call.outcome === 'acquired' ? 'completed' : call.outcome, observed_at: call.observed_at });
   entries.push(...callUsageEntries({ invocation_id: call.invocation_id, attempt_id: run.attempt_id, scope: 'registered-readonly',
    provider, source: e.source, observed_at: call.observed_at, in_flight }));
   advance(call.observed_at);
  }
  // A cumulative snapshot whose version advances with every observed call and acquisition, never re-added.
  const version = e.acquired + e.calls.length;
  if (version > 0 && e.observed_at) entries.push({ entry_id: `mcp:${usageToken(e.id)}:source_bytes:v${version}`,
   series: `mcp:${usageToken(e.id)}:source_bytes`, attempt_id: run.attempt_id, invocation_id: null, scope: 'registered-readonly',
   provider, basis: 'platform-observed', unit: 'source_bytes',
   value: e.usage.completeness === 'unknown' ? null : e.usage.bytes, reporting: 'cumulative', measurement_scope: 'attempt',
   completeness: e.usage.completeness === 'unknown' || e.usage.bytes === null ? 'unknown' : e.usage.completeness === 'complete' ? 'complete' : 'partial',
   observation_version: version, observed_at: e.observed_at, source: e.source, in_flight: false });
  if (e.observed_at) advance(e.observed_at);
 }
 return { version: 1, run_id: run.run_id, attempt_id: run.attempt_id, source: 'platform:registered-mcp-observations',
  observed_at, coverage: 'controlled-read-source-only', invocations, entries };
}

export function aggregateUsage(runs: Run[]) {
 const ledgers = runs.map(run => run.usage).filter(Boolean) as UsageLedger[];
 const totals = normalizeUsage(ledgers.flatMap(ledger => ledger.entries));
 const observed_at = ledgers.map(ledger => ledger.observed_at).sort().at(-1) ?? null;
 return {
  source: 'platform:durable-usage-ledger', queried_at: now(), observed_at,
  freshness: !observed_at ? 'unknown' : Date.now() - Date.parse(observed_at) <= 60_000 ? 'fresh' : 'recorded-projection',
  coverage: 'controlled-model-gateway-and-registered-mcp-calls; provider billing not connected',
  observation_sources: [...new Set(ledgers.flatMap(ledger => ledger.sources))].sort(), linkage,
  runs: runs.length, measured_runs: runs.filter(run => run.usage?.entries.length).length,
  unmeasured_runs: runs.filter(run => !run.usage?.entries.length).length,
  truncated_runs: ledgers.filter(ledger => ledger.truncated).length,
  in_flight_runs: runs.filter(run => (run.usage?.invocations ?? []).some(i => invocationOpen(i.status)) ||
   normalizeUsage(run.usage?.entries ?? []).some(total => total.in_flight)).length,
  rejected_observations: ledgers.reduce((count, ledger) => count + ledger.rejected, 0),
  limit_reached: runs.filter(run => run.failure === 'budget_exceeded' || run.failure === 'deadline_exceeded').length,
  invocations: ledgers.reduce((count, ledger) => count + ledger.invocations.length, 0),
  unknown_invocations: ledgers.reduce((count, ledger) => count + ledger.invocations.filter(i => i.status === 'unknown').length, 0),
  totals,
 };
}
export function usageObservation(runs: Run[]) {
 return { ...aggregateUsage(runs), confirmed_cost: null, estimated_cost_source: 'engine-list-price-estimate-only',
  providers: [...new Set(runs.map(run => usageProvider(run.manifest.profile)))].sort() };
}
