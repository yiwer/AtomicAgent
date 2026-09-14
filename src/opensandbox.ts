import { validateBoundary, type ObserveBoundary } from './execution-boundary.js';
import { type ObserveMcp, validateMcpEvidence } from './research.js';
import { validateSkillEvidence, type ObserveSkills } from './skills.js';
import { Sandbox, SandboxManager, SandboxApiException, type ConnectionConfigOptions } from '@alibaba-group/opensandbox';
import { ARTIFACT_LIMIT, INPUT_LIMIT } from './file-contract.js';
import { sha256 } from './files.js';
import { TaskError, type Run, type SandboxPort, type LoadedInput } from './domain.js';

// Only this adapter may contact the provider. No request may supply endpoints, commands, credentials or images.
export class OpenSandboxAdapter implements SandboxPort {
  readonly source = 'opensandbox';
  constructor(private connection: ConnectionConfigOptions, private secrets: (reference: string) => string,
    private qualifiedImages: readonly string[] = []) {}
  private requireRuntime(run: Run) {
    if (!this.qualifiedImages.includes(run.manifest.profile.image)) throw new TaskError('isolation_unavailable');
  }
  private config(run: Run): ConnectionConfigOptions {
    return { ...this.connection, requestTimeoutSeconds: Math.max(1, Math.min(30, (Date.parse(run.manifest.deadline_at) - Date.now()) / 1000)),
      debug: false, disableMetrics: true, useServerProxy: true };
  }
  async prepare(run: Run): Promise<string> {
    this.requireRuntime(run);
    const profile = run.manifest.profile;
    const sandbox = await Sandbox.create({
      connectionConfig: this.config(run), image: profile.image, entrypoint: ['tail', '-f', '/dev/null'],
      timeoutSeconds: Math.max(1, Math.ceil((Date.parse(run.manifest.deadline_at) - Date.now()) / 1000)),
      readyTimeoutSeconds: Math.max(1, Math.min(30, (Date.parse(run.manifest.deadline_at) - Date.now()) / 1000)),
      metadata: { atomicagent_operation: run.allocation!.operation_id, atomicagent_run: run.run_id },
      extensions: { 'bootstrap.execd.isolation': 'enable' },
      // The pinned Docker server rejects Kubernetes-only secureAccess. Its patched loopback ports
      // are reachable through the authenticated server proxy; they must never be publicly published.
      env: {}, resource: { cpu: '2', memory: '4Gi' }, secureAccess: false,
      networkPolicy: { defaultAction: 'deny', egress: [...new Set([new URL(profile.endpoint).hostname, ...(run.manifest.grant.mcp ?? []).flatMap(b => b.network)])].map(target => ({ action: 'allow' as const, target })) },
    });
    try { return sandbox.id; } finally { await sandbox.close(); }
  }
  async loadInputs(run: Run, inputs: LoadedInput[]) {
    const sandbox = await Sandbox.connect({ sandboxId: run.allocation!.resource_id!, connectionConfig: this.config(run), readyTimeoutSeconds: 10 });
    try {
      await sandbox.files.createDirectories([{ path: '/workspace/input', mode: 700, owner: 'node', group: 'node' }]);
      for (const input of inputs) {
        const path = `/workspace/${input.binding.path}`;
        await sandbox.files.writeFiles([{ path, data: input.bytes, mode: 400, owner: 'node', group: 'node' }]);
        const info = (await sandbox.files.getFileInfo([path]))[path];
        if (info?.type !== 'file' || info.size !== input.binding.size_bytes) throw new TaskError('input_required');
        const copy = await sandbox.files.readBytes(path, { range: `bytes=0-${INPUT_LIMIT}` });
        if (copy.length !== input.binding.size_bytes || sha256(copy) !== input.binding.sha256) throw new TaskError('input_required');
      }
    } finally { await sandbox.close(); }
  }
  async execute(run: Run, signal: AbortSignal, observeSkills?: ObserveSkills, observeMcp?: ObserveMcp, observeBoundary?: ObserveBoundary): Promise<unknown> {
    signal.throwIfAborted();
    this.requireRuntime(run);
    const sandbox = await Sandbox.connect({ sandboxId: run.allocation!.resource_id!, connectionConfig: this.config(run), readyTimeoutSeconds: 10 });
    let observationImported = false, mcpImported = false;
    let pollingDone = false;
    let polling: Promise<void> | undefined;
    const admittedCalls=new Set<string>();
    try {
      signal.throwIfAborted();
      await sandbox.files.createDirectories([{ path: '/run/atomicagent', mode: 700, owner: 'root', group: 'root' }]);
      await sandbox.files.createDirectories([{ path: '/workspace', mode: 700, owner: 'node', group: 'node' }]);
      const probe = await sandbox.commands.run('node /opt/atomicagent/dist/src/isolation-probe.js', {
        workingDirectory: '/workspace', uid: 0, gid: 0, envs: {}, timeoutSeconds: 10,
      }, undefined, signal);
      if (probe.error || probe.exitCode !== 0 || probe.logs.stdout.map(line=>line.text).join('').trim() !== 'atomic-isolation-v1:node24.18.0:sdk0.3.270:permit-v1')
        throw new TaskError('isolation_unavailable');
      signal.throwIfAborted();
      await sandbox.files.writeFiles([{ path: '/run/atomicagent/request.json', mode: 600, owner: 'root', group: 'root', data: JSON.stringify({
        run_id: run.run_id, mcp: run.manifest.grant.mcp, skills: run.manifest.skills, prompt: run.prompt, model: run.manifest.profile.model, endpoint: run.manifest.profile.endpoint,
        deadline_at: run.manifest.deadline_at, attempt_id: run.attempt_id,
        output_contract: run.manifest.output_contract, input_path: run.manifest.grant.inputs[0]?.path,
        format: run.manifest.grant.inputs[0]?.format,
      }) }]);
      const token = this.secrets(run.manifest.profile.secret_ref);
      if (!token) throw new TaskError('authorization_required');
      signal.throwIfAborted();
      if(observeBoundary) polling = (async()=>{
        const acknowledged = new Set<string>();
        while(!pollingDone && !signal.aborted) {
          let checked;
          try { const raw=await sandbox.files.readFile('/run/atomicagent/boundary.json',{range:'bytes=0-32768'}); if(Buffer.byteLength(raw)<=32768) checked=validateBoundary(run,JSON.parse(raw)); } catch { /* A missing or partial spool cannot authorize. */ }
          if(checked) for(const call of checked.calls.filter(c=>c.outcome==='requested'&&!acknowledged.has(c.invocation_id))) {
            if(pollingDone||signal.aborted)break;
            try {
              // Worker performs durable authority admission before this acknowledgement is sent.
              observeBoundary(checked);
              admittedCalls.add(call.invocation_id);
              if(pollingDone||signal.aborted)break;
              await sandbox.files.writeFiles([{path:`/run/atomicagent/permit-${call.invocation_id}.json`,mode:400,owner:'root',group:'root',data:JSON.stringify({run_id:run.run_id,attempt_id:run.attempt_id,invocation_id:call.invocation_id,allowed:true})}]);
              acknowledged.add(call.invocation_id);
            } catch { return; /* Record failure or terminal state ends admission; the runner times out closed. */ }
          }
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      })();
      const execution = await sandbox.commands.run('node /opt/atomicagent/dist/src/runner.js', {
        workingDirectory: '/workspace', uid: 0, gid: 0,
        envs: { ANTHROPIC_API_KEY: token },
        timeoutSeconds: Math.max(1, Math.ceil((Date.parse(run.manifest.deadline_at) - Date.now()) / 1000)),
      }, { skipAccumulation: true }, signal);
      if (execution.error || execution.exitCode !== 0) throw new TaskError('runtime_failed');
      const info = await sandbox.files.getFileInfo(['/run/atomicagent/result.json']);
      const size = info['/run/atomicagent/result.json']?.size;
      const limit = run.manifest.output_contract !== 'summary-value@1' ? Math.ceil(ARTIFACT_LIMIT * 4 / 3) + 32_768 : 16_384;
      if (info['/run/atomicagent/result.json']?.type !== 'file' || typeof size !== 'number' || size > limit) throw new TaskError('output_invalid');
      const content = await sandbox.files.readFile('/run/atomicagent/result.json', { range: `bytes=0-${limit}` });
      let envelope: { boundary?: unknown; failure?: unknown; candidate?: unknown; files?: { path: string; base64: string }[]; execution?: unknown; skills?: unknown; receipts?: unknown; mcp?: unknown };
      if (Buffer.byteLength(content) > limit) throw new TaskError('output_invalid');
      try { envelope = JSON.parse(content); } catch { throw new TaskError('output_invalid'); }
      const boundary = validateBoundary(run, envelope.boundary);
      observeBoundary?.(boundary);
      if (run.manifest.skills?.length) { observeSkills?.(validateSkillEvidence(run, envelope.skills)); observationImported = true; }
      if (run.manifest.grant.mcp?.length) { observeMcp?.(validateMcpEvidence(run, envelope.mcp)); mcpImported = true; }
      if (envelope.failure) {
        const code = envelope.failure;
        throw new TaskError(code === 'isolation_unavailable' || code === 'policy_denied' || code === 'input_required' || code === 'authorization_required' || code === 'output_invalid' || code === 'deadline_exceeded' || code === 'required_capability_failed' || code === 'skill_use_unproven' ? code : 'runtime_failed');
      }
      if (!observeBoundary || boundary.isolation !== 'enforced' || !boundary.calls.some(c=>c.boundary==='model'&&c.outcome==='completed'&&admittedCalls.has(c.invocation_id)&&boundary.calls.some(start=>start.invocation_id===c.invocation_id&&start.outcome==='started'))) throw new TaskError('isolation_unavailable');
      if (run.manifest.output_contract === 'research-report@1') {
        if (!Array.isArray(envelope.files) || envelope.files.length !== 1 || envelope.files.some(f => typeof f.base64 !== 'string' || typeof f.path !== 'string')) throw new TaskError('output_invalid');
        return { candidate: envelope.candidate, receipts: envelope.receipts, mcp: envelope.mcp, files: envelope.files.map(f => ({ path: f.path, bytes: Buffer.from(f.base64, 'base64') })) };
      }
      if (run.manifest.output_contract === 'data-statistics@1') {
        if (!Array.isArray(envelope.files) || envelope.files.length !== 2 || envelope.files.some(f => typeof f.base64 !== 'string' || typeof f.path !== 'string')) throw new TaskError('output_invalid');
        return { candidate: envelope.candidate, execution: envelope.execution,
          files: envelope.files.map(f => ({ path: f.path, bytes: Buffer.from(f.base64, 'base64') })) };
      }
      return envelope.candidate;
    } catch (error) {
      if (observeBoundary) {
        try { const raw = await sandbox.files.readFile('/run/atomicagent/boundary.json', { range:'bytes=0-32768' }); if (Buffer.byteLength(raw)<=32768) observeBoundary(validateBoundary(run,JSON.parse(raw))); } catch { /* Missing or invalid protected evidence remains unknown. */ }
      }
      if (!mcpImported && run.manifest.grant.mcp?.length && observeMcp) {
        try {
          const path = '/run/atomicagent/mcp-evidence.jsonl';
          const info = (await sandbox.files.getFileInfo([path]))[path];
          if (info?.type === 'file' && typeof info.size === 'number' && info.size <= 32000) {
            const journal = await sandbox.files.readFile(path, { range: 'bytes=0-32000' });
            if (Buffer.byteLength(journal) <= 32000 && journal.endsWith('\n')) {
              const rows = journal.trimEnd().split('\n');
              if (rows.length <= 16) { const last = JSON.parse(rows.at(-1)!); if (last.run_id === run.run_id && last.attempt_id === run.attempt_id) observeMcp(validateMcpEvidence(run, last.mcp)); }
            }
          }
        } catch { /* Invalid or unavailable journal stays unknown; original execution failure remains authoritative. */ }
      }
      if (!observationImported && run.manifest.skills?.length && observeSkills) {
        // Command failure can leave authoritative hook records even without a result envelope.
        try {
          const path = '/run/atomicagent/skill-evidence.jsonl';
          const info = (await sandbox.files.getFileInfo([path]))[path];
          if (info?.type === 'file' && typeof info.size === 'number' && info.size <= 256_000) {
            const journal = await sandbox.files.readFile(path, { range: 'bytes=0-256000' });
            if (Buffer.byteLength(journal) <= 256_000 && journal.endsWith('\n')) {
              const rows = journal.trimEnd().split('\n');
              if (rows.length <= 40) {
                const last = JSON.parse(rows.at(-1)!);
                if (last.run_id === run.run_id && last.attempt_id === run.attempt_id) observeSkills(validateSkillEvidence(run, last.skills));
              }
            }
          }
        } catch { /* Missing, partial or untrusted evidence stays unknown; never turn a failed command into success. */ }
      }
      throw error;
    } finally { pollingDone=true; await polling; await sandbox.close(); }
  }
  async requestStop(run: Run) {
    if (!run.allocation?.resource_id || !run.attempt_id) return;
    const sandbox = await Sandbox.connect({ sandboxId: run.allocation.resource_id, connectionConfig: { ...this.config(run), requestTimeoutSeconds: 5 }, readyTimeoutSeconds: 5 });
    try { await sandbox.files.writeFiles([{ path: '/run/atomicagent-cancel.json', mode: 400, owner: 'root', group: 'root',
      data: JSON.stringify({ run_id: run.run_id, attempt_id: run.attempt_id }) }]); }
    finally { await sandbox.close(); }
  }
  async forceStop(run: Run): Promise<'stopped' | 'unknown'> {
    // Destroying this immutable sandbox stops its entire process namespace. The DELETE receipt is insufficient.
    return await this.cleanup(run) === 'absent' ? 'stopped' : 'unknown';
  }
  async cleanup(run: Run): Promise<'absent' | 'unknown' | 'present'> {
    const manager = SandboxManager.create({ connectionConfig: { ...this.connection, requestTimeoutSeconds: 10, debug: false, disableMetrics: true } });
    try {
      if (run.allocation?.resource_id) return await this.removeAndVerify(manager, run.allocation.resource_id);
      // A lost create response is not an empty resource set. Find owned resources for disposal, never create again.
      const found = await manager.listSandboxInfos({ metadata: { atomicagent_operation: run.allocation!.operation_id }, page: 1, pageSize: 100 });
      for (const resource of found.items) {
        if (resource.metadata?.atomicagent_operation === run.allocation!.operation_id && resource.metadata?.atomicagent_run === run.run_id)
          await this.removeAndVerify(manager, resource.id);
      }
      // Even an empty list cannot prove an in-flight create will not complete later. Ticket14 owns complete reconciliation.
      return 'unknown';
    } finally { await manager.close(); }
  }
  private async removeAndVerify(manager: SandboxManager, id: string): Promise<'absent' | 'present'> {
    try { await manager.killSandbox(id); }
    catch (error) { if (!(error instanceof SandboxApiException && error.statusCode === 404)) throw error; }
    try { await manager.getSandboxInfo(id); return 'present'; }
    catch (error) { if (error instanceof SandboxApiException && error.statusCode === 404) return 'absent'; throw error; }
  }
}
