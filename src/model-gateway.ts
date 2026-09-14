import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

export interface BoundaryCall { invocation_id: string; boundary: 'model' | 'transport'; outcome: 'requested' | 'started' | 'completed' | 'denied' | 'failed'; observed_at: string }
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
  const record = async (outcome: BoundaryCall['outcome'], boundary: BoundaryCall['boundary']='model') => { try { await this.observe({ invocation_id, boundary, outcome, observed_at: new Date().toISOString() }); } catch (error) { this.active = false; this.controller.abort(); throw error; } };
  const valid = () => this.active && !this.controller.signal.aborted && Date.now() < this.grant.deadline;
  try {
   // Bundled CLI 2.1.270 connectivity probe. Respond locally; never send a credential or network request.
   if(valid() && request.method==='HEAD' && request.url==='/api/hello' && ++this.count<=64) { await record('completed','transport'); response.writeHead(204).end(); return; }
   if (!valid() || ++this.count > 64 || request.method !== 'POST' || !['/v1/messages', '/v1/messages?beta=true'].includes(request.url!)) {
    await record('denied'); response.writeHead(403).end(); return;
   }
   const chunks: Buffer[] = []; let size = 0;
   for await (const chunk of request) { size += chunk.length; if (size > 1048576) throw new Error('request_limit'); chunks.push(chunk); }
   const body = Buffer.concat(chunks); const candidate = JSON.parse(body.toString());
   if (candidate.model !== this.grant.model || candidate.mcp_servers !== undefined || candidate.container !== undefined || hasRemoteSource(candidate.messages) ||
    candidate.tools !== undefined && (!Array.isArray(candidate.tools) || candidate.tools.some((tool: { name?: string; type?: string }) => !tool || tool.type !== undefined && tool.type !== 'custom' || !this.grant.tools?.includes(tool.name ?? '')))) {
    await record('denied'); response.writeHead(403).end(); return;
   }
   await record('requested');
   if (!valid()) throw new Error('revoked');
   const endpoint = new URL(this.grant.endpoint); endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/v1/messages'; endpoint.search = '';
   const dispatched = fetch(endpoint, { method: 'POST', body, redirect: 'error', signal: AbortSignal.any([this.controller.signal, disconnected.signal, AbortSignal.timeout(Math.max(1, this.grant.deadline-Date.now()))]),
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': this.grant.token,
     ...(typeof request.headers['anthropic-beta'] === 'string' && request.headers['anthropic-beta'].length <= 2000 ? { 'anthropic-beta': request.headers['anthropic-beta'] } : {}) } });
   void dispatched.catch(()=>{});
   await record('started');
   const result = await dispatched;
   if (result.status >= 300 && result.status < 400 || !valid()) throw new Error('redirect_or_revoked');
   response.writeHead(result.status, { 'content-type': result.headers.get('content-type')?.includes('text/event-stream') ? 'text/event-stream' : 'application/json' });
   let received = 0;
   if (result.body) for await (const chunk of result.body) { received += chunk.length; if (received > 8388608 || !valid() || disconnected.signal.aborted) throw new Error('response_limit'); if (!response.write(chunk)) await once(response, 'drain', { signal: AbortSignal.any([this.controller.signal,disconnected.signal]) }); }
   await record(result.ok ? 'completed' : 'failed'); response.end();
  } catch {
   try { await record('failed'); } catch { this.active = false; this.controller.abort(); }
   if (!response.headersSent) response.writeHead(502); response.end();
  }
 }
}
