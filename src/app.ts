import { Limits } from './limits.js';
import { boundaryObservation, boundaryCallResults } from './execution-boundary.js';
import { requestedMcp, researchSchema } from './research.js';
import { requestedSkills } from './skills.js';
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
import { Events } from './events.js';
import { Configurations } from './configurations.js';
import { cancellationObservation } from './cancellation.js';

interface AppOptions { guardian?:import('./guardian.js').GuardianPort; database: string; profile: Profile; identities: Identity[]; sandbox: SandboxPort; blobs?: BlobPort; clock?: () => number; cancellationClock?: () => number; approvedProfiles?: Profile[]; deploymentBindings?: { id: string; document: string; legacyApproval?: string }[] }
const digest = (value: string) => createHash('sha256').update(value).digest();
function publicRun(run: Run) {
  return {
    run_id: run.run_id, status: run.status, phase: run.phase, failure: run.failure,
    resource_limits:run.resource_limits??null, limit_termination: run.limit_termination ?? null, accepted_at: run.accepted_at, terminal_at: run.terminal_at, attempt_id: run.attempt_id,
    submission_digest: submissionDigest(run),
    boundary: run.boundary ? {...run.boundary,call_results:boundaryCallResults(run)} : null, cleanup: run.cleanup, cancellation: run.cancellation ?? null, stop: run.stop ?? null, validation: run.validation, skills: run.skills ?? [], mcp: run.mcp ?? [],
    inputs: run.manifest.grant.inputs.map(({ file_id, path, sha256, size_bytes, loaded, binding_id, source, loaded_at }) => ({ file_id, path, sha256, size_bytes, loaded, binding_id, source,
      copy: { run_id: run.run_id, path, loaded_at: loaded_at ?? null, status: loaded ? (run.cleanup.status === 'complete' ? 'removed' : 'loaded') : 'unconfirmed',
        cleanup_status: run.cleanup.status, observed_at: run.cleanup.observed_at, source: run.cleanup.source } })),
    execution: { limits:run.manifest.limits ?? null, mcp: run.manifest.grant.mcp.map(({ sources, ...b }) => ({ ...b, sources: sources.map(({ snapshot, ...source }) => source) })), skills: (run.manifest.skills ?? []).map(({ id, version, must_use, entry, content_digest }) => ({ id, version, must_use, entry, content_digest })), environment: run.manifest.environment, model_revision: run.manifest.model, manifest_digest: run.manifest_digest ?? manifestDigest(run.manifest), profile: run.manifest.profile.id, mode: run.manifest.profile.mode, model: run.manifest.profile.model,
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
function sessionId(request: IncomingMessage) {
  return request.headers.cookie?.match(/(?:^|; )atomic_session=([a-f0-9-]+)(?:;|$)/)?.[1];
}
export async function createApp(options: AppOptions) {
  options = { ...options, profile: structuredClone(options.profile), identities: structuredClone(options.identities) };
  validateProfile(options.profile);
  if (options.sandbox.supports ? ![options.profile, ...(options.approvedProfiles ?? [])].every(p => options.sandbox.supports!(p)) : ![options.profile, ...(options.approvedProfiles ?? [])].every(p => options.sandbox.source === (p.mode === 'fixture' ? 'deterministic-fixture' : 'opensandbox'))) throw new Error('profile_adapter_mismatch');
  if (options.identities.length === 0 || options.identities.some(i => i.token.length < 32 || !['caller', 'maintainer', 'health'].includes(i.role) ||
      !/^[\w.-]{1,80}$/.test(i.actor) || !/^[\w.-]{1,80}$/.test(i.workspace)) ||
      new Set(options.identities.map(i => i.token)).size !== options.identities.length) throw new Error('invalid_identity_configuration');
  const store = new Store(options.database);
  try {
    for (const profile of [options.profile, ...(options.approvedProfiles ?? [])]) { validateProfile(profile); store.registerProfile(profile); }
    for (const binding of options.deploymentBindings ?? []) store.registerDeploymentBinding(binding.id, binding.document, binding.legacyApproval);
  } catch (error) { store.close(); throw error; }
  const files = new Files(store, options.blobs ?? new DiskBlobs(`${options.database}.objects`));
  await files.recover();
  const limits = new Limits(store, [...new Set(options.identities.map(i => i.workspace))]);
  const worker = new Worker(store, options.sandbox, files, options.cancellationClock, limits);
  try { await worker.recover(); store.initializeEvents(); } catch (error) { await worker.close(); store.close(); throw error; }
  let configurations: Configurations;
  try { configurations = new Configurations(store, options.profile, [options.profile, ...(options.approvedProfiles ?? [])], [...new Set(options.identities.map(i => i.workspace))]); }
  catch (error) { await worker.close(); store.close(); throw error; }
  worker.wake();
  // Observation/session clock is an external test seam; it never sets execution deadlines.
  const clock = options.clock ?? Date.now;
  const events = new Events(store, clock);
  const linkSecret = randomUUID() + randomUUID();
  const sessions = new Map<string, { identity: Identity; expires: number }>();
  function authenticate(request: IncomingMessage): Identity {
    const bearer = request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (bearer) {
      const identity = options.identities.find(i => timingSafeEqual(digest(i.token), digest(bearer)));
      if (identity) return identity;
    } else {
      const session = sessionId(request);
      const found = session && sessions.get(session);
      if (found && found.expires > clock()) return found.identity;
    }
    throw new ApiError(401, 'authentication_required');
  }
  function visible(identity: Identity, run: Run) {
    return identity.role !== 'health' && identity.workspace === run.workspace && (identity.role === 'maintainer' || identity.actor === run.owner);
  }
  function send(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data));
  }
  async function replySubmission(request: IncomingMessage, response: ServerResponse, run: Run, waitSeconds: number) {
    const until = performance.now() + waitSeconds * 1000;
    let current = run;
    let disconnected = response.destroyed;
    let wake: (() => void) | undefined;
    const onClose = () => { disconnected = true; wake?.(); };
    response.once('close', onClose);
    try {
      while (waitSeconds > 0 && !current.terminal_at && !disconnected && performance.now() < until) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.min(25, until - performance.now()));
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
        current = store.get(run.run_id)!;
      }
      if (disconnected) return;
      const authorized = authenticate(request);
      if (!visible(authorized, current)) throw new ApiError(404, 'run_not_found');
      if (waitSeconds > 0 && current.terminal_at) {
        send(response, 200, { ...publicRun(current), result: current.result,
          artifacts: (current.artifacts ?? []).map(id => publicObject(store.object(id)!)) });
      } else send(response, 202, publicRun(current));
    } finally { response.removeListener('close', onClose); }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let identity: Identity | undefined;
    let submissionNotAccepted = false;
    let configurationNotApplied = false;
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const method = request.method ?? 'GET';
      if (method === 'POST' && request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`)
        throw new ApiError(403, 'origin_denied');
      if (method === 'GET' && ['/', '/app.js', '/events.js', '/configurations.js', '/limits.js', '/styles.css'].includes(path)) {
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
        for (const [key, value] of sessions) if (value.expires <= clock()) sessions.delete(key);
        const previousSession = sessionId(request);
        if (previousSession) sessions.delete(previousSession);
        if (sessions.size >= 1000) throw new ApiError(503, 'session_capacity');
        const session = randomUUID(); sessions.set(session, { identity, expires: clock() + 8 * 3600_000 });
        response.setHeader('Set-Cookie', `atomic_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        send(response, 200, { actor: identity.actor, workspace: identity.workspace, role: identity.role }); return;
      }
      identity = authenticate(request);
      if (path === '/auth/logout' && method === 'POST') {
        const session = sessionId(request);
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
        let guardian:unknown={source:'independent-guardian',status:'unknown',observed_at:null,coverage:'not-connected'};
        if(options.guardian)try{guardian=await options.guardian.observation();}catch{/* Failure stays unknown. */}
        send(response, 200, { observed_at: now(), source: 'platform:durable-runs', coverage: 'ticket01-11', guardian, limits: limits.observation(identity.workspace,runs,worker.activeRunIds), boundary: boundaryObservation(runs), cancellation: cancellationObservation(runs), configurations: configurations.observation(identity.workspace), skills: { observed_at: now(), source: 'platform:durable-skill-observations', coverage: 'recorded-run-capabilities-only', requested: runs.reduce((n, r) => n + (r.skills?.length ?? 0), 0), callable: runs.flatMap(r => r.skills ?? []).filter(e => e.callable === true).length, used: runs.flatMap(r => r.skills ?? []).filter(e => e.used === true).length, unknown: runs.flatMap(r => r.skills ?? []).filter(e => e.callable === null || e.used === null).length, failed_runs: runs.filter(r => r.manifest.skills?.length && (r.failure === 'required_capability_failed' || r.failure === 'skill_use_unproven')).length }, mcp: { source: 'platform:durable-mcp-run-observations', observed_at: runs.flatMap(r => r.mcp ?? []).map(e => e.observed_at).filter(Boolean).sort().at(-1) ?? null, coverage: 'controlled-read-source-only', failed_runs: runs.filter(r => r.manifest.grant.mcp.length && r.failure === 'required_capability_failed').length, requested: runs.reduce((n, r) => n + (r.mcp?.length ?? 0), 0), unknown: runs.flatMap(r => r.mcp ?? []).filter(e => e.connected === null || e.authorized === null).length, acquired: runs.flatMap(r => r.mcp ?? []).reduce((n, e) => n + e.acquired, 0), model_tokens: null, model_cost: null }, artifact_reuse: { source: 'platform:durable-input-bindings', observed_at: now(), coverage: 'artifact-copy-confirmation-and-run-cleanup', requested: runs.filter(r => r.manifest.grant.inputs.some(i => i.source)).length, confirmed: runs.filter(r => r.manifest.grant.inputs.some(i => i.source && i.loaded)).length, copy_failed: runs.filter(r => r.failure === 'input_copy_failed').length, source_expired: runs.filter(r => r.failure === 'input_source_expired').length, cleanup_unfinished: runs.filter(r => r.terminal_at && r.manifest.grant.inputs.some(i => i.source) && r.cleanup.status !== 'complete').length }, submissions: store.submissionObservation(identity.workspace), events: events.observation(identity.workspace), object_storage: { source: 'platform:durable-object-obligations', observed_at: now(),
            unresolved: store.objects().filter(o => o.workspace === identity!.workspace && o.status === 'staged').length },
          running: runs.filter(r => r.status === 'running').length, queued: runs.filter(r => r.status === 'queued').length,
          cleanup_unfinished: runs.filter(r => r.terminal_at && r.cleanup.status !== 'complete').length,
          failed: runs.filter(r => r.status === 'failed' || r.status === 'timed_out').length,
          model: { status: 'unknown', source: 'no-live-probe', observed_at: null },
        }); return;
      }
      if (identity.role === 'health') throw new ApiError(403, 'forbidden');
      if (!worker.acceptingWork && method === 'POST' && (path.startsWith('/v1/configurations') || path === '/v1/files')) throw new ApiError(503, 'core_records_unavailable');
      if (path === '/v1/limits' && method === 'GET') { send(response,200,limits.list(identity.workspace)); return; }
      if (['/v1/limits/preview','/v1/limits/commands'].includes(path) && method === 'POST') {
        if(identity.role!=='maintainer')throw new ApiError(403,'forbidden');
        if(!worker.acceptingWork)throw new ApiError(503,'core_records_unavailable');
        const actor=request.headers['x-configuration-actor'],workspace=request.headers['x-configuration-workspace'];
        if((actor!==undefined||workspace!==undefined)&&(actor!==identity.actor||workspace!==identity.workspace))throw new ApiError(403,'configuration_identity_changed');
        const input=await body(request);
        if(path.endsWith('/preview')){send(response,200,limits.preview(identity,input));return;}
        const key=request.headers['idempotency-key'];
        if(typeof key!=='string'||!/^[\x21-\x7e]{1,128}$/.test(key))throw new ApiError(400,'command_id_required');
        configurationNotApplied=!store.configurationCommand(identity.workspace,identity.actor,`limits:${key}`);
        send(response,200,limits.execute(identity,input,key));configurationNotApplied=false;worker.wake();return;
      }
      if (path === '/v1/configurations' && method === 'GET') {
        send(response, 200, configurations.list(identity)); return;
      }
      if (path === '/v1/configurations/mcp-probe' && method === 'POST') {
        if (identity.role !== 'maintainer') throw new ApiError(403, 'forbidden');
        const actor = request.headers['x-configuration-actor'], workspace = request.headers['x-configuration-workspace'];
        if ((actor !== undefined || workspace !== undefined) && (actor !== identity.actor || workspace !== identity.workspace)) throw new ApiError(403, 'configuration_identity_changed');
        send(response, 200, await configurations.probe(identity, await body(request))); return;
      }
      if (path === '/v1/configurations/audit' && method === 'GET') {
        if (identity.role !== 'maintainer') throw new ApiError(403, 'forbidden');
        store.audit(identity.actor, identity.workspace, 'configuration.audit-read', 'allowed');
        send(response, 200, { records: store.configurationAudit(identity.workspace), observed_at: now(), source: 'platform:durable-configuration-audit', limit: 100 }); return;
      }
      if (['/v1/configurations/preview', '/v1/configurations/commands'].includes(path) && method === 'POST') {
        if (identity.role !== 'maintainer') throw new ApiError(403, 'forbidden');
        const expectedActor = request.headers['x-configuration-actor'], expectedWorkspace = request.headers['x-configuration-workspace'];
        if ((expectedActor !== undefined || expectedWorkspace !== undefined) &&
            (expectedActor !== identity.actor || expectedWorkspace !== identity.workspace)) throw new ApiError(403, 'configuration_identity_changed');
        const input = await body(request);
        if (path.endsWith('/preview')) { send(response, 200, configurations.preview(identity, input)); return; }
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new ApiError(400, 'command_id_required');
        configurationNotApplied = !store.configurationCommand(identity.workspace, identity.actor, key);
        send(response, 200, configurations.execute(identity, input, key)); configurationNotApplied = false; return;
      }
      if (path === '/v1/files' && method === 'POST') {
        let input: Record<string, unknown>;
        if (request.headers['x-file-format']) {
          const bytes = await requestBytes(request, INPUT_LIMIT);
          let content: string;
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ApiError(400, 'invalid_file_encoding'); }
          input = { format: request.headers['x-file-format'], content };
        } else input = record(await body(request, 64 * 1024 * 1024));
        const object = await files.upload(identity, input,limits.current(identity.workspace).values.input_bytes);
        send(response, 201, publicObject(object)); return;
      }
      const fileMatch = path.match(/^\/v1\/files\/([a-f0-9-]{36})$/);
      if (fileMatch && method === 'GET') {
        const object = files.authorized(fileMatch[1]!, identity, 'input');
        files.audit(object, 'input.read', 'allowed', identity.actor);
        send(response, 200, publicObject(object)); return;
      }
      if (path === '/v1/runs' && method === 'POST') {
        const waits = new URL(request.url!, 'http://localhost').searchParams.getAll('wait_seconds');
        const waitSeconds = waits.length ? Number(waits[0]) : 0;
        if (waits.length > 1 || (waits.length && !/^\d+(?:\.\d{1,3})?$/.test(waits[0]!)) ||
            !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) throw new ApiError(400, 'invalid_wait_seconds');
        const expectedActor = request.headers['x-submission-actor'];
        const expectedWorkspace = request.headers['x-submission-workspace'];
        if ((expectedActor !== undefined || expectedWorkspace !== undefined) &&
            (expectedActor !== identity.actor || expectedWorkspace !== identity.workspace)) throw new ApiError(403, 'submission_identity_changed');
        const input = record(await body(request));
        if (input.audit_requirement === 'complete') throw new ApiError(422, 'audit_coverage_unavailable');
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required');
        if (Object.keys(input).some(k => !['prompt', 'profile', 'environment', 'model', 'output_contract', 'inputs', 'skills', 'mcp', 'limits'].includes(k)) ||
            typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw new ApiError(400, 'invalid_request');
        const requestDigest = contentDigest(input);
        // Replay precedes source resolution; an expired source must not invalidate the original accepted request.
        const replay = store.replay(identity.actor, identity.workspace, key, requestDigest);
        if (replay) { await replySubmission(request, response, replay, waitSeconds); return; }
        if (!worker.acceptingWork) throw new ApiError(503, 'core_records_unavailable');
        // Only this confirmed absent binding can authorize discarding a rejected pending submission.
        submissionNotAccepted = true;
        let bindings: Run['manifest']['grant']['inputs'];
        try { bindings = input.output_contract === 'data-statistics@1' ? await files.bind(identity, input.inputs) : []; }
        catch (error) {
          // Another identical request may have committed while source IO was in flight.
          const concurrent = store.replay(identity.actor, identity.workspace, key, requestDigest);
          if (concurrent) { submissionNotAccepted = false; await replySubmission(request, response, concurrent, waitSeconds); return; }
          throw error;
        }
        const concurrent = store.replay(identity.actor, identity.workspace, key, requestDigest);
        if (concurrent) { submissionNotAccepted = false; await replySubmission(request, response, concurrent, waitSeconds); return; }
        if (!worker.acceptingWork) throw new ApiError(503, 'core_records_unavailable');
        const resolved = configurations.resolve(identity.workspace, input);
        if (!['summary-value@1', 'data-statistics@1', 'research-report@1'].includes(String(input.output_contract))) throw new ApiError(400, 'output_contract_unavailable');
        const mcp = configurations.resolveMcp(identity.workspace, input.mcp);
        if ((input.output_contract === 'research-report@1') !== (mcp.length === 1)) throw new ApiError(400, 'mcp_contract_unavailable');
        if (mcp.length && (input.inputs !== undefined || input.skills !== undefined)) throw new ApiError(400, 'invalid_request');
        if (mcp.length && resolved.profile.mode === 'fixture' && mcp[0]!.mode !== 'snapshot') throw new ApiError(400, 'mcp_mode_unavailable');
        const skills = configurations.resolveSkills(identity.workspace, input.skills);
        if (skills.length && input.output_contract !== 'data-statistics@1') throw new ApiError(400, 'skill_contract_unavailable');
        if (input.output_contract === 'summary-value@1' && input.inputs !== undefined) throw new ApiError(400, 'invalid_request');
        const effective = limits.resolve(identity.workspace,resolved.profile,input.limits);
        if(bindings.reduce((sum,b)=>sum+b.size_bytes,0)>effective.input_bytes)throw new ApiError(413,'input_limit');
        const acceptedAt = now();
        const run: Run = {
          run_id: randomUUID(), owner: identity.actor, workspace: identity.workspace, prompt: input.prompt,
          request_digest: requestDigest, request_digest_version: 2, ...(mcp.length ? { mcp: mcp.map(requestedMcp) } : {}),
          ...(skills.length ? { skills: requestedSkills(skills) } : {}),
          manifest: { ...resolved, limits:effective, ...(skills.length ? { skills } : {}), output_contract: input.output_contract as Run['manifest']['output_contract'], schema: mcp.length ? researchSchema : bindings.length ? fileSchema : outputSchema,
            grant: { tools: bindings.length ? ['process-data@1'] : [], mcp, inputs: bindings, external_access: mcp.length ? 'registered-readonly' : 'model-only' },
            deadline_at: new Date(Date.parse(acceptedAt) + effective.total_timeout_seconds * 1000).toISOString() },
          status: 'queued', phase: 'queued', failure: null, accepted_at: acceptedAt, terminal_at: null, attempt_id: null,
          allocation: null, cleanup: { status: 'pending', observed_at: null, source: null }, validation: null, result: null,
        };
        run.manifest_digest = manifestDigest(run.manifest);
        submissionNotAccepted = false;
        const accepted = store.accept(run, key);
        worker.wake(); await replySubmission(request, response, accepted, waitSeconds); return;
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
          response.writeHead(200, { 'Content-Type': object.format === 'markdown' ? 'text/markdown; charset=utf-8' : object.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
            'Content-Disposition': `attachment; filename="${object.format === 'markdown' ? 'report.md' : object.format === 'csv' ? 'valid.csv' : 'rejected.json'}"`, 'Content-Length': bytes.length });
          response.end(bytes); return;
        }
      }
      const cancellation = path.match(/^\/v1\/runs\/([a-f0-9-]{36}):cancel$/);
      if (cancellation && method === 'POST') {
        const run = store.get(cancellation[1]!);
        if (!run || !visible(identity, run)) throw new ApiError(404, 'run_not_found');
        const actor = request.headers['x-cancellation-actor'], workspace = request.headers['x-cancellation-workspace'];
        if ((actor !== undefined || workspace !== undefined) && (actor !== identity.actor || workspace !== identity.workspace)) throw new ApiError(403, 'cancellation_identity_changed');
        if (Object.keys(record(await body(request))).length) throw new ApiError(400, 'invalid_request');
        let cancelled: Run;
        try { cancelled = store.cancel(run.run_id, identity, options.cancellationClock?.()); }
        catch (error) { worker.cancelRecordFailure(run); throw error; }
        worker.cancel(run.run_id);
        send(response, 200, publicRun(cancelled)); return;
      }
      const match = path.match(/^\/v1\/runs\/([a-f0-9-]{36})(\/result|\/events)?$/);
      if (match && method === 'GET') {
        const run = store.get(match[1]!);
        if (!run || !visible(identity, run)) throw new ApiError(404, 'run_not_found');
        if (match[2] === '/events') {
          const expectedActor = request.headers['x-observation-actor'];
          const expectedWorkspace = request.headers['x-observation-workspace'];
          if ((expectedActor !== undefined || expectedWorkspace !== undefined) &&
              (expectedActor !== identity.actor || expectedWorkspace !== identity.workspace)) throw new ApiError(403, 'observation_identity_changed');
          events.open(request, response, identity, run, () => {
            if (!visible(authenticate(request), store.get(run.run_id)!)) throw new ApiError(404, 'run_not_found');
          }); return;
        }
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
      try {
        const configuration = new URL(request.url ?? '/', 'http://localhost').pathname.startsWith('/v1/configurations');
        const key = request.headers['idempotency-key'];
        store.audit(identity?.actor ?? 'unauthenticated', identity?.workspace ?? null, configuration ? 'configuration.reject' : 'request.reject', code, null,
          configuration ? { source: 'platform:configuration-command', resource_id: null,
            operation_id: typeof key === 'string' && /^[\x21-\x7e]{1,128}$/.test(key) ? key : null, observed_at: now() } : undefined);
      } catch { /* fail closed */ }
      if (!response.headersSent) send(response, status, { error: code,
        ...(code === 'event_cursor_expired' || code === 'event_cursor_ahead' ? { recovery: 'query_run', run_url: new URL(request.url!, 'http://localhost').pathname.replace(/\/events$/, '') } : {}),
        ...(configurationNotApplied && status >= 400 && status < 500 ? { command_status: 'not_applied' } : {}),
        ...(submissionNotAccepted && status >= 400 && status < 500 ? { submission_status: 'not_accepted' } : {}) }); else response.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return {
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listen_failed');
      return `http://127.0.0.1:${address.port}`;
    },
    async close() { events.close(); await new Promise<void>(resolve => server.close(() => resolve())); await worker.close(); store.close(); },
  };
}
