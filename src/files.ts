import { effectiveLimits } from './limits.js';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError, now, TaskError, type Identity, type StoredObject, type InputBinding, type LoadedInput, type Run, type FileCandidate } from './domain.js';
import { type BlobPort } from './blob-store.js';
import { ARTIFACT_LIMIT, INPUT_LIMIT, parseRows, safeInputPath } from './file-contract.js';
import { Store } from './store.js';
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function publicObject(object: StoredObject) {
  return { ...(object.kind === 'input' ? { file_id: object.object_id } : { artifact_id: object.object_id }),
    path: object.path, format: object.format, size_bytes: object.size_bytes, sha256: object.sha256,
    status: object.status, availability: Date.parse(object.expires_at) <= Date.now() ? 'expired' : object.status,
    expires_at: object.expires_at };
}
export class Files {
  constructor(readonly store: Store, readonly blobs: BlobPort) {}
  authorized(id: string, identity: Identity, kind: StoredObject['kind']) {
    const object = this.store.object(id);
    if (!object || object.kind !== kind || identity.role === 'health' || object.workspace !== identity.workspace ||
        (object.owner !== identity.actor && identity.role !== 'maintainer')) throw new ApiError(404, 'file_not_found');
    return object;
  }
  available(object: StoredObject) {
    if (Date.parse(object.expires_at) <= Date.now()) throw new ApiError(410, 'file_expired');
    if (object.status !== 'available') throw new ApiError(409, 'file_incomplete');
  }
  async upload(identity: Identity, value: Record<string, unknown>, inputLimit=INPUT_LIMIT) {
    if (Object.keys(value).some(k => !['format', 'content'].includes(k)) ||
        !['csv', 'json'].includes(String(value.format)) || typeof value.content !== 'string') throw new ApiError(400, 'invalid_file');
    const bytes = Buffer.from(value.content);
    if (bytes.length > inputLimit) throw new ApiError(413, 'input_limit');
    try { parseRows(value.content, value.format as 'csv' | 'json'); } catch { throw new ApiError(400, 'invalid_file'); }
    const object: StoredObject = { object_id: randomUUID(), kind: 'input', owner: identity.actor, workspace: identity.workspace,
      run_id: null, path: null, format: value.format as 'csv' | 'json', size_bytes: bytes.length, sha256: sha256(bytes),
      status: 'staged', expires_at: new Date(Date.now() + 86400_000).toISOString(), cleanup_observed_at: null };
    this.store.transaction(() => { this.store.saveObject(object); this.audit(object, 'input.upload-intent', 'staged', identity.actor); });
    try {
      await this.blobs.write(object.object_id, bytes);
      const stored = await this.blobs.read(object.object_id, INPUT_LIMIT);
      if (sha256(stored) !== object.sha256) throw new Error('incomplete_upload');
      object.status = 'available';
      this.store.transaction(() => { this.store.saveObject(object); this.audit(object, 'input.validated', 'available'); });
      return object;
    } catch (error) { await this.discard(object); throw error; }
  }
  audit(object: StoredObject, action: string, outcome: string, actor = 'platform') {
    this.store.audit(actor, object.workspace, action, outcome, object.run_id, {
      source: 'platform:object-store', resource_id: object.object_id, operation_id: null, observed_at: now(),
    });
  }
  async discard(object: StoredObject) {
    try {
      await this.blobs.remove(object.object_id); object.status = 'removed'; object.cleanup_observed_at = now();
      this.store.transaction(() => { this.store.saveObject(object); this.audit(object, 'object.cleanup-observed', 'absent'); });
    } catch { /* Durable staged object remains an unresolved cleanup obligation, never an unowned file. */ }
  }
  async recover() {
    for (const object of this.store.objects()) if (object.status === 'staged') await this.discard(object);
  }
  async bind(identity: Identity, inputs: unknown): Promise<InputBinding[]> {
    if (!Array.isArray(inputs) || inputs.length !== 1) throw new ApiError(400, 'one_data_input_required');
    return Promise.all(inputs.map(async value => {
      if (!value || typeof value !== 'object' || !['file_id,path', 'artifact_id,path'].includes(Object.keys(value).sort().join(',')) ||
          typeof (value.artifact_id ?? value.file_id) !== 'string' || !safeInputPath(value.path)) throw new ApiError(400, 'invalid_input_binding');
      const kind = value.artifact_id ? 'artifact' : 'input';
      const object = this.authorized(value.artifact_id ?? value.file_id, identity, kind); this.available(object);
      if (object.size_bytes > INPUT_LIMIT) throw new ApiError(413, 'input_limit');
      if (object.format === 'markdown') throw new ApiError(400, 'input_contract_incompatible');
      if (!value.path.endsWith('.' + object.format)) throw new ApiError(400, 'input_format_mismatch');
      const binding: InputBinding = { binding_id: randomUUID(), file_id: object.object_id, path: value.path, sha256: object.sha256,
        size_bytes: object.size_bytes, format: object.format, owner: object.owner, workspace: object.workspace, expires_at: object.expires_at, loaded: false,
        ...(kind === 'artifact' ? { source: { kind: 'artifact', artifact_id: object.object_id, run_id: object.run_id!, expires_at: object.expires_at } } : {}) };
      if (kind === 'artifact') {
        let bytes: Buffer;
        try { bytes = await this.readBinding(binding); } catch (error) {
          if (error instanceof TaskError && error.code === 'input_source_expired') throw new ApiError(410, 'file_expired');
          throw new ApiError(409, 'file_incomplete');
        }
        try { parseRows(new TextDecoder('utf-8', { fatal: true }).decode(bytes), binding.format); }
        catch { throw new ApiError(400, 'input_contract_incompatible'); }
        this.available(this.authorized(object.object_id, identity, 'artifact'));
      }
      return binding;
    }));
  }
  private checkBinding(binding: InputBinding) {
    const object = this.store.object(binding.file_id);
    if (!object || !safeInputPath(binding.path) || !binding.path.endsWith('.' + binding.format) || object.owner !== binding.owner || object.workspace !== binding.workspace ||
        object.sha256 !== binding.sha256 || object.size_bytes !== binding.size_bytes || object.format !== binding.format || object.expires_at !== binding.expires_at ||
        object.kind !== (binding.source ? 'artifact' : 'input') || (binding.source && (object.run_id !== binding.source.run_id || object.object_id !== binding.source.artifact_id)) ||
        object.status !== 'available') throw new TaskError('input_required');
    if (Date.parse(object.expires_at) <= Date.now()) throw new TaskError(binding.source ? 'input_source_expired' : 'input_required');
    return object;
  }
  private async readBinding(binding: InputBinding) {
    const object = this.checkBinding(binding);
    let bytes: Buffer;
    try {
      bytes = await this.blobs.read(object.object_id, INPUT_LIMIT);
      if (bytes.length !== binding.size_bytes || sha256(bytes) !== binding.sha256) throw new Error('input_integrity');
    } catch { throw new TaskError('input_required'); }
    this.checkBinding(binding);
    return bytes;
  }
  async load(run: Run): Promise<LoadedInput[]> {
    return Promise.all(run.manifest.grant.inputs.map(async binding => ({ binding, bytes: await this.readBinding(binding) })));
  }
  // The copy becomes independent only after the adapter verifies bytes and the source is still valid.
  async confirmCopies(run: Run) {
    for (const binding of run.manifest.grant.inputs) {
      if (binding.source) await this.readBinding(binding);
      else this.checkBinding(binding);
    }
  }
  async stage(run: Run, candidates: FileCandidate['files'], signal: AbortSignal): Promise<StoredObject[]> {
    if(candidates.reduce((sum,file)=>sum+file.bytes.length,0)>effectiveLimits(run).artifact_bytes)throw new TaskError('budget_exceeded');
    const staged: StoredObject[] = []; let retries = 0;
    try {
      for (const file of candidates) {
        const object: StoredObject = { object_id: randomUUID(), kind: 'artifact', owner: run.owner, workspace: run.workspace,
          run_id: run.run_id, path: file.path, format: file.path.endsWith('.md') ? 'markdown' : file.path.endsWith('.csv') ? 'csv' : 'json',
          size_bytes: file.bytes.length, sha256: sha256(file.bytes), status: 'staged', expires_at: run.manifest.deadline_at, cleanup_observed_at: null };
        this.store.transaction(() => { this.store.saveObject(object); this.audit(object, 'artifact.transfer-intent', 'staged'); });
        staged.push(object);
        for (;;) {
          if (signal.aborted || Date.now() >= Date.parse(run.manifest.deadline_at)) throw new TaskError('deadline_exceeded');
          try {
            await this.blobs.write(object.object_id, file.bytes);
            const stored = await this.blobs.read(object.object_id, ARTIFACT_LIMIT);
            if (stored.length !== object.size_bytes || sha256(stored) !== object.sha256) throw new Error('artifact_integrity');
            break;
          } catch (error) {
            // A write response can be lost after durable storage. Reconcile this same owned key first.
            let verified = false;
            try { const bytes = await this.blobs.read(object.object_id, ARTIFACT_LIMIT); verified = bytes.length === object.size_bytes && sha256(bytes) === object.sha256; } catch { /* unknown */ }
            if (verified) break;
            if (signal.aborted || retries++ >= 2) throw error;
            this.audit(object, 'artifact.transfer-retry', 'bounded-storage-retry');
            await this.blobs.remove(object.object_id);
          }
        }
        if (signal.aborted || Date.now() >= Date.parse(run.manifest.deadline_at)) throw new TaskError('deadline_exceeded');
        this.audit(object, 'artifact.transfer-observed', 'verified');
      }
      return staged;
    } catch (error) { for (const object of staged) await this.discard(object); throw error; }
  }
  commit(objects: StoredObject[], terminalAt: string) {
    // Called inside the same SQLite transaction as ValidationReport and Result.
    for (const object of objects) {
      object.status = 'available'; object.expires_at = new Date(Date.parse(terminalAt) + 86400_000).toISOString();
      this.store.saveObject(object); this.audit(object, 'artifact.commit', 'available');
    }
  }
}
