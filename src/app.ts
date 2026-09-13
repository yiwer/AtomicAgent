import { createHash, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApiError, now, outputSchema, type Identity, type Profile, type Run, type SandboxPort } from './domain.js';
import { validateProfile } from './profile.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { Files, publicObject, sha256 } from './files.js';
import { DiskBlobs, type BlobPort } from './blob-store.js';
import { fileSchema, ARTIFACT_LIMIT, INPUT_LIMIT } from './file-contract.js';
import { contentDigest, manifestDigest, submissionDigest } from './submission.js';

interface AppOptions { database: string; profile: Profile; identities: Identity[]; sandbox: SandboxPort; blobs?: BlobPort }
const digest = (value: string) => createHash('sha256').update(value).digest();
function publicRun(run: Run) {
  return {
    run_id: run.run_id, status: run.status, phase: run.phase, failure: run.failure,
    accepted_at: run.accepted_at, terminal_at: run.terminal_at, attempt_id: run.attempt_id,
    submission_digest: submissionDigest(run),
    cleanup: run.cleanup, validation: run.validation,
    inputs: run.manifest.grant.inputs.map(({ file_id, path, sha256, size_bytes, loaded }) => ({ file_id, path, sha256, size_bytes, loaded })),
    execution: { manifest_digest: run.manifest_digest ?? manifestDigest(run.manifest), profile: run.manifest.profile.id, mode: run.manifest.profile.mode, model: run.manifest.profile.model,
      sdk: run.manifest.profile.sdk, cli: run.manifest.profile.cli, node: run.manifest.profile.node,
      image: run.manifest.profile.image, deadline_at: run.manifest.deadline_at, output_contract: run.manifest.output_contract },
  };
}
async function requestBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new ApiError(413, 'request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(request: IncomingMessage, limit = 16_384): Promise<unknown> {
  const bytes = await requestBytes(request, limit);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'invalid_json'); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_request');
  return value as Record<string, unknown>;
}
export async function createApp(options: AppOptions) {
  options = { ...options, profile: structuredClone(options.profile), identities: structuredClone(options.identities) };
  validateProfile(options.profile);
  if (options.sandbox.source !== (options.profile.mode === 'fixture' ? 'deterministic-fixture' : 'opensandbox')) throw new Error('profile_adapter_mismatch');
  if (options.identities.length === 0 || options.identities.some(i => i.token.length < 32 || !['caller', 'maintainer', 'health'].includes(i.role) ||
      !/^[\w.-]{1,80}$/.test(i.actor) || !/^[\w.-]{1,80}$/.test(i.workspace)) ||
      new Set(options.identities.map(i => i.token)).size !== options.identities.length) throw new Error('invalid_identity_configuration');
  const store = new Store(options.database);
  try { store.registerProfile(options.profile); } catch (error) { store.close(); throw error; }
  const files = new Files(store, options.blobs ?? new DiskBlobs(`${options.database}.objects`));
  await files.recover();
  const worker = new Worker(store, options.sandbox, files);
  try { await worker.recover(); } catch (error) { store.close(); throw error; }
  worker.wake();
  const linkSecret = randomUUID() + randomUUID();
  const sessions = new Map<string, { identity: Identity; expires: number }>();
  function authenticate(request: IncomingMessage): Identity {
    const bearer = request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (bearer) {
      const identity = options.identities.find(i => timingSafeEqual(digest(i.token), digest(bearer)));
      if (identity) return identity;
    } else {
      const session = request.headers.cookie?.match(/(?:^|; )atomic_session=([a-f0-9-]+)(?:;|$)/)?.[1];
      const found = session && sessions.get(session);
      if (found && found.expires > Date.now()) return found.identity;
    }
    throw new ApiError(401, 'authentication_required');
  }
  function visible(identity: Identity, run: Run) {
    return identity.role !== 'health' && identity.workspace === run.workspace && (identity.role === 'maintainer' || identity.actor === run.owner);
  }
  function send(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data));
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let identity: Identity | undefined;
    let submissionNotAccepted = false;
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const method = request.method ?? 'GET';
      if (method === 'POST' && request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`)
        throw new ApiError(403, 'origin_denied');
      if (method === 'GET' && ['/', '/app.js', '/styles.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const contents = await readFile(resolve('web', file));
        response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        response.end(contents); return;
      }
      if (path === '/auth/session' && method === 'POST') {
        const payload = record(await body(request));
        if (typeof payload.token !== 'string') throw new ApiError(401, 'authentication_required');
        request.headers.authorization = `Bearer ${payload.token}`;
        identity = authenticate(request);
        store.audit(identity.actor, identity.workspace, 'session.create', 'allowed');
        for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
        if (sessions.size >= 1000) throw new ApiError(503, 'session_capacity');
        const session = randomUUID(); sessions.set(session, { identity, expires: Date.now() + 8 * 3600_000 });
        response.setHeader('Set-Cookie', `atomic_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        send(response, 200, { actor: identity.actor, workspace: identity.workspace, role: identity.role }); return;
      }
      identity = authenticate(request);
      if (path === '/auth/logout' && method === 'POST') {
        const session = request.headers.cookie?.match(/atomic_session=([a-f0-9-]+)/)?.[1];
        if (session) sessions.delete(session);
        response.setHeader('Set-Cookie', 'atomic_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        send(response, 200, { logged_out: true }); return;
      }
      if (path === '/v1/me' && method === 'GET') {
        send(response, 200, { actor: identity.actor, workspace: identity.workspace, role: identity.role,
          mode: options.profile.mode, profile: options.profile.id, output_contract: 'summary-value@1' }); return;
      }
      if (path === '/internal/health' && method === 'GET') {
        if (identity.role === 'caller') throw new ApiError(403, 'forbidden');
        const runs = store.all().filter(r => r.workspace === identity!.workspace);
        send(response, 200, { observed_at: now(), source: 'platform:durable-runs', coverage: 'ticket01-03', submissions: store.submissionObservation(identity.workspace), object_storage: { source: 'platform:durable-object-obligations', observed_at: now(),
            unresolved: store.objects().filter(o => o.workspace === identity!.workspace && o.status === 'staged').length },
          running: runs.filter(r => r.status === 'running').length, queued: runs.filter(r => r.status === 'queued').length,
          cleanup_unfinished: runs.filter(r => r.terminal_at && r.cleanup.status !== 'complete').length,
          failed: runs.filter(r => r.status === 'failed' || r.status === 'timed_out').length,
          model: { status: 'unknown', source: 'no-live-probe', observed_at: null },
        }); return;
      }
      if (identity.role === 'health') throw new ApiError(403, 'forbidden');
      if (path === '/v1/files' && method === 'POST') {
        let input: Record<string, unknown>;
        if (request.headers['x-file-format']) {
          const bytes = await requestBytes(request, INPUT_LIMIT);
          let content: string;
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ApiError(400, 'invalid_file_encoding'); }
          input = { format: request.headers['x-file-format'], content };
        } else input = record(await body(request, 64 * 1024 * 1024));
        const object = await files.upload(identity, input);
        send(response, 201, publicObject(object)); return;
      }
      const fileMatch = path.match(/^\/v1\/files\/([a-f0-9-]{36})$/);
      if (fileMatch && method === 'GET') {
        const object = files.authorized(fileMatch[1]!, identity, 'input');
        files.audit(object, 'input.read', 'allowed', identity.actor);
        send(response, 200, publicObject(object)); return;
      }
      if (path === '/v1/runs' && method === 'POST') {
        const expectedActor = request.headers['x-submission-actor'];
        const expectedWorkspace = request.headers['x-submission-workspace'];
        if ((expectedActor !== undefined || expectedWorkspace !== undefined) &&
            (expectedActor !== identity.actor || expectedWorkspace !== identity.workspace)) throw new ApiError(403, 'submission_identity_changed');
        const input = record(await body(request));
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required');
        if (Object.keys(input).some(k => !['prompt', 'profile', 'output_contract', 'inputs'].includes(k)) ||
            typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw new ApiError(400, 'invalid_request');
        const requestDigest = contentDigest(input);
        // Replay precedes source resolution; an expired source must not invalidate the original accepted request.
        const replay = store.replay(identity.actor, identity.workspace, key, requestDigest);
        if (replay) { send(response, 202, publicRun(replay)); return; }
        // Only this confirmed absent binding can authorize discarding a rejected pending submission.
        submissionNotAccepted = true;
        if (input.profile !== options.profile.id) throw new ApiError(400, 'config_unavailable');
        if (!['summary-value@1', 'data-statistics@1'].includes(String(input.output_contract))) throw new ApiError(400, 'output_contract_unavailable');
        const bindings = input.output_contract === 'data-statistics@1' ? files.bind(identity, input.inputs) : [];
        if (input.output_contract === 'summary-value@1' && input.inputs !== undefined) throw new ApiError(400, 'invalid_request');
        const acceptedAt = now();
        const run: Run = {
          run_id: randomUUID(), owner: identity.actor, workspace: identity.workspace, prompt: input.prompt,
          request_digest: requestDigest, request_digest_version: 2,
          manifest: { profile: structuredClone(options.profile), output_contract: input.output_contract as Run['manifest']['output_contract'], schema: bindings.length ? fileSchema : outputSchema,
            grant: { tools: bindings.length ? ['process-data@1'] : [], mcp: [], inputs: bindings, external_access: 'model-only' },
            deadline_at: new Date(Date.now() + options.profile.timeout_seconds * 1000).toISOString() },
          status: 'queued', phase: 'queued', failure: null, accepted_at: acceptedAt, terminal_at: null, attempt_id: null,
          allocation: null, cleanup: { status: 'pending', observed_at: null, source: null }, validation: null, result: null,
        };
        run.manifest_digest = manifestDigest(run.manifest);
        submissionNotAccepted = false;
        const accepted = store.accept(run, key);
        send(response, 202, publicRun(accepted)); worker.wake(); return;
      }
      if (path === '/v1/runs' && method === 'GET') {
        store.audit(identity.actor, identity.workspace, 'run.list', 'allowed');
        send(response, 200, { runs: store.all().filter(r => visible(identity!, r)).slice(0, 100).map(publicRun) }); return;
      }
      const artifactMatch = path.match(/^\/v1\/artifacts\/([a-f0-9-]{36})(\/download-link|\/content)?$/);
      if (artifactMatch) {
        const object = files.authorized(artifactMatch[1]!, identity, 'artifact');
        if (method === 'GET' && !artifactMatch[2]) { files.audit(object, 'artifact.read', 'allowed', identity.actor); send(response, 200, publicObject(object)); return; }
        files.available(object);
        if (method === 'POST' && artifactMatch[2] === '/download-link') {
          const expires = Math.min(Date.now() + 300_000, Date.parse(object.expires_at));
          const signature = createHmac('sha256', linkSecret).update(JSON.stringify([object.object_id, identity.actor, identity.workspace, expires])).digest('hex');
          files.audit(object, 'artifact.link-issued', 'allowed', identity.actor);
          send(response, 200, { url: `/v1/artifacts/${object.object_id}/content?expires=${expires}&signature=${signature}`, expires_at: new Date(expires).toISOString() }); return;
        }
        if (method === 'GET' && artifactMatch[2] === '/content') {
          const query = new URL(request.url!, 'http://localhost').searchParams;
          const expires = Number(query.get('expires')); const signature = query.get('signature') ?? '';
          const expected = createHmac('sha256', linkSecret).update(JSON.stringify([object.object_id, identity.actor, identity.workspace, expires])).digest('hex');
          if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.parse(object.expires_at) || !timingSafeEqual(digest(signature), digest(expected))) throw new ApiError(410, 'download_link_expired');
          const bytes = await files.blobs.read(object.object_id, ARTIFACT_LIMIT);
          if (bytes.length !== object.size_bytes || sha256(bytes) !== object.sha256) throw new ApiError(503, 'artifact_unavailable');
          files.available(object);
          if (expires <= Date.now()) throw new ApiError(410, 'download_link_expired');
          files.audit(object, 'artifact.transfer-start', 'allowed', identity.actor);
          let observed = false;
          const recordTransfer = (outcome: string) => { if (observed) return; observed = true; try { files.audit(object, 'artifact.transfer-observed', outcome, identity!.actor); } catch { /* not proof of receipt */ } };
          response.once('finish', () => recordTransfer('server-response-finished'));
          response.once('close', () => recordTransfer('connection-closed'));
          response.writeHead(200, { 'Content-Type': object.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
            'Content-Disposition': `attachment; filename="${object.format === 'csv' ? 'valid.csv' : 'rejected.json'}"`, 'Content-Length': bytes.length });
          response.end(bytes); return;
        }
      }
      const match = path.match(/^\/v1\/runs\/([a-f0-9-]{36})(\/result)?$/);
      if (match && method === 'GET') {
        const run = store.get(match[1]!);
        if (!run || !visible(identity, run)) throw new ApiError(404, 'run_not_found');
        store.audit(identity.actor, identity.workspace, match[2] ? 'result.read' : 'run.read', 'allowed', run.run_id);
        if (match[2]) {
          if (run.status !== 'succeeded') throw new ApiError(409, 'result_unavailable');
          send(response, 200, { run_id: run.run_id, result: run.result, artifacts: (run.artifacts ?? []).map(id => publicObject(store.object(id)!)), validation: run.validation });
        } else send(response, 200, publicRun(run));
        return;
      }
      throw new ApiError(404, 'not_found');
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 503;
      const code = error instanceof ApiError ? error.code : 'service_unavailable';
      try { store.audit(identity?.actor ?? 'unauthenticated', identity?.workspace ?? null, 'request.reject', code); } catch { /* fail closed */ }
      if (!response.headersSent) send(response, status, { error: code,
        ...(submissionNotAccepted && status >= 400 && status < 500 ? { submission_status: 'not_accepted' } : {}) }); else response.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return {
    async listen(port = 0) {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listen_failed');
      return `http://127.0.0.1:${address.port}`;
    },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); await worker.close(); store.close(); },
  };
}
