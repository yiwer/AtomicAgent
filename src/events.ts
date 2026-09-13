import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type Identity, type Run } from './domain.js';
import type { Store } from './store.js';

const RETENTION_MS = 7 * 24 * 3600_000;
// Durable storage is the queue. Each connection holds at most one 32-event page;
// backpressure pauses reads until drain, with a bounded five-second drain deadline.
export class Events {
  private connections = new Map<ServerResponse, Identity>();
  constructor(private store: Store, private clock: () => number = Date.now) {}
  private expired(run: Run) { return !!run.terminal_at && this.clock() >= Date.parse(run.terminal_at) + RETENTION_MS; }
  open(request: IncomingMessage, response: ServerResponse, identity: Identity, run: Run, authorize: () => void) {
    const query = new URL(request.url!, 'http://localhost').searchParams.getAll('cursor');
    const cursor = request.headers['last-event-id'] ?? query[0];
    let sequence = 0;
    if (query.length > 1 || typeof cursor !== 'undefined' && (typeof cursor !== 'string' || !cursor.startsWith(`${run.run_id}:`) ||
        !/^[1-9]\d{0,14}$/.test(cursor.slice(37)))) throw new ApiError(400, 'invalid_event_cursor');
    if (typeof cursor === 'string') sequence = Number(cursor.slice(37));
    if (this.expired(run)) throw new ApiError(410, 'event_cursor_expired');
    if (sequence > this.store.eventHead(run.run_id)) throw new ApiError(409, 'event_cursor_ahead');
    if (this.connections.size >= 128 || [...this.connections.values()].filter(i => i.actor === identity.actor && i.workspace === identity.workspace).length >= 8)
      throw new ApiError(429, 'event_connection_limit');
    this.store.audit(identity.actor, identity.workspace, 'run.events.read', 'allowed', run.run_id);
    this.connections.set(response, identity);
    let interval: ReturnType<typeof setInterval>;
    let lifetime: ReturnType<typeof setTimeout>;
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    let blocked = false;
    let ending = false;
    const drained = () => { blocked = false; clearTimeout(drainTimeout); };
    const closed = () => {
      clearInterval(interval); clearTimeout(lifetime); clearTimeout(drainTimeout);
      response.removeListener('drain', drained); this.connections.delete(response);
    };
    response.once('close', closed);
    const end = (frame?: string) => {
      ending = true; clearInterval(interval); clearTimeout(drainTimeout);
      response.end(frame);
      drainTimeout = setTimeout(() => response.destroy(), 1000);
    };
    const write = (frame: string) => {
      if (ending || response.destroyed || response.writableEnded) return false;
      if (!response.write(frame)) {
        blocked = true; response.once('drain', drained);
        drainTimeout = setTimeout(() => response.destroy(), 5000); return false;
      }
      return true;
    };
    const pump = () => {
      try {
        if (ending || response.destroyed || response.writableEnded) return;
        authorize();
        if (this.expired(this.store.get(run.run_id)!)) { end('event: reset\ndata: {"error":"event_cursor_expired"}\n\n'); return; }
        if (blocked) return;
        for (const event of this.store.events(run.run_id, sequence)) {
          sequence = event.sequence;
          if (!write(`id: ${event.event_id}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`)) return;
        }
      } catch { response.destroy(); }
    };
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    interval = setInterval(pump, 250);
    lifetime = setTimeout(() => end(), 30_000);
    pump();
  }
  observation(workspace: string) {
    return { ...this.store.eventObservation(workspace), active_connections: [...this.connections.values()].filter(i => i.workspace === workspace).length,
      connection_source: 'platform:local-event-connections', connection_observed_at: new Date(this.clock()).toISOString() };
  }
  close() { for (const response of this.connections.keys()) response.destroy(); }
}
