import { Sandbox, SandboxManager, SandboxApiException, type ConnectionConfigOptions } from '@alibaba-group/opensandbox';
import { ARTIFACT_LIMIT, INPUT_LIMIT } from './file-contract.js';
import { sha256 } from './files.js';
import { TaskError, type Run, type SandboxPort, type LoadedInput } from './domain.js';

// Only this adapter may contact the provider. No request may supply endpoints, commands, credentials or images.
export class OpenSandboxAdapter implements SandboxPort {
  readonly source = 'opensandbox';
  constructor(private connection: ConnectionConfigOptions, private secrets: (reference: string) => string) {}
  private config(run: Run): ConnectionConfigOptions {
    return { ...this.connection, requestTimeoutSeconds: Math.max(1, Math.min(30, (Date.parse(run.manifest.deadline_at) - Date.now()) / 1000)),
      debug: false, disableMetrics: true, useServerProxy: true };
  }
  async prepare(run: Run): Promise<string> {
    const profile = run.manifest.profile;
    const sandbox = await Sandbox.create({
      connectionConfig: this.config(run), image: profile.image, entrypoint: ['tail', '-f', '/dev/null'],
      timeoutSeconds: Math.max(1, Math.ceil((Date.parse(run.manifest.deadline_at) - Date.now()) / 1000)),
      readyTimeoutSeconds: Math.max(1, Math.min(30, (Date.parse(run.manifest.deadline_at) - Date.now()) / 1000)),
      metadata: { atomicagent_operation: run.allocation!.operation_id, atomicagent_run: run.run_id },
      env: {}, resource: { cpu: '2', memory: '4Gi' }, secureAccess: true,
      networkPolicy: { defaultAction: 'deny', egress: [{ action: 'allow', target: new URL(profile.endpoint).hostname }] },
    });
    try { return sandbox.id; } finally { await sandbox.close(); }
  }
  async loadInputs(run: Run, inputs: LoadedInput[]) {
    const sandbox = await Sandbox.connect({ sandboxId: run.allocation!.resource_id!, connectionConfig: this.config(run), readyTimeoutSeconds: 10 });
    try {
      await sandbox.files.createDirectories([{ path: '/workspace/input', mode: 0o700, owner: 'node', group: 'node' }]);
      for (const input of inputs) {
        const path = `/workspace/${input.binding.path}`;
        await sandbox.files.writeFiles([{ path, data: input.bytes, mode: 0o400, owner: 'node', group: 'node' }]);
        const info = (await sandbox.files.getFileInfo([path]))[path];
        if (info?.type !== 'file' || info.size !== input.binding.size_bytes) throw new TaskError('input_required');
        const copy = await sandbox.files.readBytes(path, { limit: INPUT_LIMIT + 1 });
        if (copy.length !== input.binding.size_bytes || sha256(copy) !== input.binding.sha256) throw new TaskError('input_required');
      }
    } finally { await sandbox.close(); }
  }
  async execute(run: Run, signal: AbortSignal): Promise<unknown> {
    const sandbox = await Sandbox.connect({ sandboxId: run.allocation!.resource_id!, connectionConfig: this.config(run), readyTimeoutSeconds: 10 });
    try {
      await sandbox.files.createDirectories([{ path: '/workspace', mode: 0o700, owner: 'node', group: 'node' }]);
      await sandbox.files.writeFiles([{ path: '/workspace/request.json', mode: 0o600, owner: 'node', group: 'node', data: JSON.stringify({
        prompt: run.prompt, model: run.manifest.profile.model, endpoint: run.manifest.profile.endpoint,
        deadline_at: run.manifest.deadline_at, attempt_id: run.attempt_id,
        output_contract: run.manifest.output_contract, input_path: run.manifest.grant.inputs[0]?.path,
        format: run.manifest.grant.inputs[0]?.format,
      }) }]);
      const token = this.secrets(run.manifest.profile.secret_ref);
      if (!token) throw new TaskError('authorization_required');
      const execution = await sandbox.commands.run('node /opt/atomicagent/dist/src/runner.js', {
        workingDirectory: '/workspace', uid: 1000, gid: 1000,
        envs: { ANTHROPIC_API_KEY: token },
        timeoutSeconds: Math.max(1, Math.ceil((Date.parse(run.manifest.deadline_at) - Date.now()) / 1000)),
      }, { skipAccumulation: true }, signal);
      if (execution.error || execution.exitCode !== 0) throw new TaskError('runtime_failed');
      const info = await sandbox.files.getFileInfo(['/workspace/result.json']);
      const size = info['/workspace/result.json']?.size;
      const limit = run.manifest.output_contract === 'data-statistics@1' ? Math.ceil(ARTIFACT_LIMIT * 4 / 3) + 32_768 : 16_384;
      if (info['/workspace/result.json']?.type !== 'file' || typeof size !== 'number' || size > limit) throw new TaskError('output_invalid');
      const content = await sandbox.files.readFile('/workspace/result.json', { limit: limit + 1 });
      let envelope: { failure?: unknown; candidate?: unknown; files?: { path: string; base64: string }[]; execution?: unknown };
      if (Buffer.byteLength(content) > limit) throw new TaskError('output_invalid');
      try { envelope = JSON.parse(content); } catch { throw new TaskError('output_invalid'); }
      if (envelope.failure) {
        const code = envelope.failure;
        throw new TaskError(code === 'input_required' || code === 'authorization_required' || code === 'output_invalid' || code === 'deadline_exceeded' ? code : 'runtime_failed');
      }
      if (run.manifest.output_contract === 'data-statistics@1') {
        if (!Array.isArray(envelope.files) || envelope.files.length !== 2 || envelope.files.some(f => typeof f.base64 !== 'string' || typeof f.path !== 'string')) throw new TaskError('output_invalid');
        return { candidate: envelope.candidate, execution: envelope.execution,
          files: envelope.files.map(f => ({ path: f.path, bytes: Buffer.from(f.base64, 'base64') })) };
      }
      return envelope.candidate;
    } finally { await sandbox.close(); }
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
