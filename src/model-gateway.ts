import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';

export interface ProviderTokens { input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null }
// `dispatched` separates "the provider reported no usage" from "the provider was never contacted".
export interface CallMeasurement { request_bytes: number; response_bytes: number; tokens: ProviderTokens | null; dispatched: boolean }
export interface BoundaryCall { invocation_id: string; boundary: 'model' | 'transport'; outcome: 'requested' | 'started' | 'completed' | 'denied' | 'failed'; observed_at: string; measurement?: CallMeasurement }
const tokenFields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
// Reads only the provider's own usage report out of its response. Bounded, never buffers a whole stream,
// and reports nothing rather than a partial figure when the response outgrows the budget.
export class ProviderUsageReader {
 private readonly streamed: boolean;
 private readonly decoder = new StringDecoder('utf8');
 private chunks: Buffer[] = [];
 private carry = '';
 private budget = 262_144;
 private overflowed = false;
 tokens: ProviderTokens | null = null;
 constructor(contentType: string | null | undefined) { this.streamed = Boolean(contentType?.includes('text/event-stream')); }
 push(chunk: Buffer) {
  this.budget -= chunk.length;
  if (this.budget < 0) { this.overflowed = true; this.chunks = []; this.carry = ''; return; }
  if (!this.streamed) { this.chunks.push(chunk); return; }
  this.carry += this.decoder.write(chunk);
  for (let index = this.carry.indexOf('\n'); index >= 0; index = this.carry.indexOf('\n')) {
   this.line(this.carry.slice(0, index)); this.carry = this.carry.slice(index + 1);
  }
  if (this.carry.length > 65_536) this.carry = '';
 }
 finish() {
  if (this.overflowed) return;
  if (this.streamed) { this.line(this.carry + this.decoder.end()); return; }
  try { this.take((JSON.parse(Buffer.concat(this.chunks).toString('utf8')) as { usage?: unknown }).usage); } catch { /* No confirmed report is not a zero. */ }
 }
 private line(raw: string) {
  const line = raw.trim();
  if (!line.startsWith('data:') || line.length > 65_536) return;
  let event: { usage?: unknown; message?: { usage?: unknown } };
  try { event = JSON.parse(line.slice(5)); } catch { return; }
  this.take(event?.message?.usage); this.take(event?.usage);
 }
 private take(usage: unknown) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;
  const reported = usage as Record<string, unknown>;
  if (!tokenFields.some(field => Number.isSafeInteger(reported[field]))) return;
  this.tokens ??= { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null };
  for (const field of tokenFields) {
   const value = reported[field];
   if (Number.isSafeInteger(value) && (value as number) >= 0) this.tokens[field] = value as number;
  }
 }
}
function hasRemoteSource(value: unknown): boolean {
 if (!value || typeof value !== 'object') return false;
 if (Array.isArray(value)) return value.some(hasRemoteSource);
 const object=value as Record<string,unknown>;
 if (object.source && typeof object.source==='object' && 'type' in object.source && object.source.type==='url') return true;
 return Object.values(object).some(hasRemoteSource);
}
// This broker stays outside the Agent's mount/PID/network namespaces. Only it owns the model credential.
export class ModelGateway {
 private controller = new AbortController();
 private server = createServer((request, response) => { void this.handle(request, response); });
 private active = false;
 private count = 0;
 constructor(private grant: { endpoint: string; model: string; token: string; deadline: number; tools?: string[] }, private observe: (event: BoundaryCall) => Promise<void>) {
  this.server.on('connect', (_req, socket) => socket.destroy());
  this.server.on('upgrade', (_req, socket) => socket.destroy());
  this.server.headersTimeout = 5000; this.server.requestTimeout = 10000;
 }
 async listen(socket: string) { await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(socket, () => { this.active = true; resolve(); }); }); }
 async close() { this.active = false; this.controller.abort(); this.server.closeAllConnections(); if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve())); }
 private async handle(request: IncomingMessage, response: ServerResponse) {
  const invocation_id = randomUUID();
  const disconnected = new AbortController();
  response.once('close', () => { if (!response.writableEnded) disconnected.abort(); });
  const record = async (outcome: BoundaryCall['outcome'], boundary: BoundaryCall['boundary']='model', measurement?: CallMeasurement) => { try { await this.observe({ invocation_id, boundary, outcome, observed_at: new Date().toISOString(), ...(measurement ? { measurement } : {}) }); } catch (error) { this.active = false; this.controller.abort(); throw error; } };
  const valid = () => this.active && !this.controller.signal.aborted && Date.now() < this.grant.deadline;
  let measured: CallMeasurement = { request_bytes: 0, response_bytes: 0, tokens: null, dispatched: false };
  try {
   // Bundled CLI 2.1.270 connectivity probe. Respond locally; never send a credential or network request.
   if(valid() && request.method==='HEAD' && request.url==='/api/hello' && ++this.count<=64) { await record('completed','transport',measured); response.writeHead(204).end(); return; }
   if (!valid() || ++this.count > 64 || request.method !== 'POST' || !['/v1/messages', '/v1/messages?beta=true'].includes(request.url!)) {
    await record('denied','model',measured); response.writeHead(403).end(); return;
   }
   const chunks: Buffer[] = []; let size = 0;
   for await (const chunk of request) { size += chunk.length; if (size > 1048576) throw new Error('request_limit'); chunks.push(chunk); }
   const body = Buffer.concat(chunks); const candidate = JSON.parse(body.toString());
   measured = { ...measured, request_bytes: body.length };
   if (candidate.model !== this.grant.model || candidate.mcp_servers !== undefined || candidate.container !== undefined || hasRemoteSource(candidate.messages) ||
    candidate.tools !== undefined && (!Array.isArray(candidate.tools) || candidate.tools.some((tool: { name?: string; type?: string }) => !tool || tool.type !== undefined && tool.type !== 'custom' || !this.grant.tools?.includes(tool.name ?? '')))) {
    await record('denied','model',measured); response.writeHead(403).end(); return;
   }
   await record('requested','model',measured);
   if (!valid()) throw new Error('revoked');
   const endpoint = new URL(this.grant.endpoint); endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/v1/messages'; endpoint.search = '';
   const dispatched = fetch(endpoint, { method: 'POST', body, redirect: 'error', signal: AbortSignal.any([this.controller.signal, disconnected.signal, AbortSignal.timeout(Math.max(1, this.grant.deadline-Date.now()))]),
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': this.grant.token,
     ...(typeof request.headers['anthropic-beta'] === 'string' && request.headers['anthropic-beta'].length <= 2000 ? { 'anthropic-beta': request.headers['anthropic-beta'] } : {}) } });
   void dispatched.catch(()=>{});
   measured = { ...measured, dispatched: true };
   await record('started','model',measured);
   const result = await dispatched;
   if (result.status >= 300 && result.status < 400 || !valid()) throw new Error('redirect_or_revoked');
   const streamed = result.headers.get('content-type')?.includes('text/event-stream');
   response.writeHead(result.status, { 'content-type': streamed ? 'text/event-stream' : 'application/json' });
   const reader = new ProviderUsageReader(streamed ? 'text/event-stream' : 'application/json');
   let received = 0;
   try {
    if (result.body) for await (const chunk of result.body) { received += chunk.length; reader.push(Buffer.from(chunk)); if (received > 8388608 || !valid() || disconnected.signal.aborted) throw new Error('response_limit'); if (!response.write(chunk)) await once(response, 'drain', { signal: AbortSignal.any([this.controller.signal,disconnected.signal]) }); }
   } finally { reader.finish(); measured = { ...measured, response_bytes: received, tokens: reader.tokens }; }
   await record(result.ok ? 'completed' : 'failed','model',measured); response.end();
  } catch {
   try { await record('failed','model',measured); } catch { this.active = false; this.controller.abort(); }
   if (!response.headersSent) response.writeHead(502); response.end();
  }
 }
}
