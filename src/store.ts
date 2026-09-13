import { DatabaseSync } from 'node:sqlite';
import { ApiError, now, type Profile, type Run, type RunEvent, type StoredObject } from './domain.js';
import { manifestDigest, submissionDigest } from './submission.js';

interface AuditEvidence { source: string; resource_id: string | null; operation_id: string | null; observed_at: string }

// One local control process owns this SQLite database. Every authority change and its audit commit together.
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(workspace,owner,idempotency_key));
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, run_id TEXT, actor TEXT NOT NULL,
        workspace TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_events(run_id TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY(run_id,sequence));
      CREATE TABLE IF NOT EXISTS configuration_state(workspace TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS configuration_commands(workspace TEXT NOT NULL, actor TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(workspace,actor,command_id));
      CREATE TABLE IF NOT EXISTS deployment_bindings(id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registered_profile(id TEXT PRIMARY KEY, document TEXT NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(audit)').all().map(row => row.name);
    for (const column of ['source', 'resource_id', 'operation_id', 'observed_at']) {
      if (!columns.includes(column)) this.db.exec(`ALTER TABLE audit ADD COLUMN ${column} TEXT`);
    }
  }
  registerProfile(profile: Profile) {
    const document = JSON.stringify(profile, Object.keys(profile).sort());
    const existing = this.db.prepare('SELECT document FROM registered_profile WHERE id=?').get(profile.id);
    if (existing && existing.document !== document) throw new Error('immutable_profile_conflict');
    // Matching registrations need no writes: a read-capable database must still permit disposal during a write outage.
    for (const run of this.all()) {
      if (run.manifest.profile.id === profile.id && JSON.stringify(run.manifest.profile, Object.keys(run.manifest.profile).sort()) !== document) throw new Error('immutable_profile_conflict');
    }
    if (existing) return;
    this.transaction(() => {
      const current = this.db.prepare('SELECT document FROM registered_profile WHERE id=?').get(profile.id);
      if (current && current.document !== document) throw new Error('immutable_profile_conflict');
      if (!current) {
        this.db.prepare('INSERT INTO registered_profile VALUES(?,?)').run(profile.id, document);
        this.audit('platform', null, 'profile.register', 'fixed-revision');
      }
    });
  }
  registerDeploymentBinding(id: string, document: string) {
    const existing = this.db.prepare('SELECT document FROM deployment_bindings WHERE id=?').get(id);
    if (existing) { if (existing.document !== document) throw new Error('immutable_deployment_binding_conflict'); return; }
    this.transaction(() => {
      this.db.prepare('INSERT INTO deployment_bindings VALUES(?,?)').run(id, document);
      this.audit('platform', null, 'binding.register', 'fixed-identity');
    });
  }
  configurationState(workspace: string): unknown {
    const row = this.db.prepare('SELECT document FROM configuration_state WHERE workspace=?').get(workspace);
    return row ? JSON.parse(row.document as string) : undefined;
  }
  saveConfigurationState(workspace: string, state: unknown) {
    this.db.prepare('INSERT INTO configuration_state VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET document=excluded.document').run(workspace, JSON.stringify(state));
  }
  configurationCommand(workspace: string, actor: string, key: string): { digest: string; receipt: unknown } | undefined {
    const row = this.db.prepare('SELECT digest,document FROM configuration_commands WHERE workspace=? AND actor=? AND command_id=?').get(workspace, actor, key);
    return row ? { digest: row.digest as string, receipt: JSON.parse(row.document as string) } : undefined;
  }
  saveConfigurationCommand(workspace: string, actor: string, key: string, digest: string, receipt: unknown) {
    this.db.prepare('INSERT INTO configuration_commands VALUES(?,?,?,?,?)').run(workspace, actor, key, digest, JSON.stringify(receipt));
  }
  configurationAudit(workspace: string) {
    return this.db.prepare("SELECT actor,action,outcome,recorded_at,resource_id,operation_id,source FROM audit WHERE workspace=? AND action LIKE 'configuration.%' ORDER BY seq DESC LIMIT 100").all(workspace);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor: string, workspace: string | null, action: string, outcome: string, id: string | null = null, evidence?: AuditEvidence) {
    this.db.prepare('INSERT INTO audit(run_id,actor,workspace,action,outcome,recorded_at,source,resource_id,operation_id,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, actor, workspace, action, outcome, now(), evidence?.source ?? 'platform', evidence?.resource_id ?? null,
        evidence?.operation_id ?? null, evidence?.observed_at ?? null);
  }
  submissionObservation(workspace: string) {
    const counts = { accepted: 0, replayed: 0, conflict: 0 };
    for (const row of this.db.prepare("SELECT outcome, COUNT(*) AS total FROM audit WHERE workspace=? AND action='run.accept' GROUP BY outcome").all(workspace)) {
      if (row.outcome === 'accepted' || row.outcome === 'replayed' || row.outcome === 'conflict') counts[row.outcome] = Number(row.total);
    }
    return { source: 'platform:durable-submission-audit', observed_at: now(), counts };
  }
  initializeEvents() {
    // Called after resource recovery, before accepting work. Never invent past transitions.
    for (const run of this.all()) if (!this.eventHead(run.run_id)) this.transaction(() => this.appendEvent(run, 'run.snapshot'));
  }
  replay(owner: string, workspace: string, key: string, digest: string): Run | undefined {
    const row = this.db.prepare('SELECT document FROM runs WHERE workspace=? AND owner=? AND idempotency_key=?').get(workspace, owner, key);
    if (!row) return undefined;
    const run = JSON.parse(row.document as string) as Run;
    if (submissionDigest(run) !== digest) {
      this.audit(owner, workspace, 'run.accept', 'conflict', run.run_id);
      throw new ApiError(409, 'idempotency_conflict');
    }
    this.audit(owner, workspace, 'run.accept', 'replayed', run.run_id); return run;
  }
  accept(run: Run, key: string): Run {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT document FROM runs WHERE workspace=? AND owner=? AND idempotency_key=?')
        .get(run.workspace, run.owner, key);
      if (row) {
        const existing = JSON.parse(row.document as string) as Run;
        if (submissionDigest(existing) !== run.request_digest) throw new ApiError(409, 'idempotency_conflict');
        this.audit(run.owner, run.workspace, 'run.accept', 'replayed', existing.run_id);
        return existing;
      }
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(run.run_id, run.owner, run.workspace, key, JSON.stringify(run));
      this.audit(run.owner, run.workspace, 'run.accept', 'accepted', run.run_id);
      this.appendEvent(run);
      this.audit('platform', run.workspace, 'grant.freeze', run.manifest.grant.inputs.length ? 'model-and-process-data@1' : 'model-only', run.run_id);
      for (const binding of run.manifest.grant.inputs) this.audit(run.owner, run.workspace, 'input.bind', 'fixed-authorized-content', run.run_id,
        { source: 'platform:input-object', resource_id: binding.file_id, operation_id: null, observed_at: now() });
      return run;
    });
  }
  get(id: string): Run | undefined {
    const row = this.db.prepare('SELECT document FROM runs WHERE id=?').get(id);
    return row ? JSON.parse(row.document as string) as Run : undefined;
  }
  all(): Run[] { return this.db.prepare('SELECT document FROM runs ORDER BY rowid DESC').all().map(r => JSON.parse(r.document as string) as Run); }
  change(id: string, action: string, update: (run: Run) => void, observation?: { outcome: string; evidence: AuditEvidence }): Run {
    return this.transaction(() => {
      const run = this.get(id)!;
      const previous = JSON.stringify(this.progress(run));
      const frozenManifest = manifestDigest(run.manifest);
      update(run);
      if (manifestDigest(run.manifest) !== frozenManifest) throw new Error('immutable_manifest_conflict');
      this.db.prepare('UPDATE runs SET document=? WHERE id=?').run(JSON.stringify(run), id);
      this.audit('platform', run.workspace, action, observation?.outcome ?? run.failure ?? run.status, id, observation?.evidence);
      if (JSON.stringify(this.progress(run)) !== previous) this.appendEvent(run);
      return run;
    });
  }
  private progress(run: Run) {
    return { attempt_id: run.attempt_id, status: run.status, phase: run.phase, failure: run.failure,
      validation: run.validation?.status ?? null, cleanup: { status: run.cleanup.status, observed_at: run.cleanup.observed_at } };
  }
  private appendEvent(run: Run, type: RunEvent['type'] = 'run.progress') {
    const sequence = this.eventHead(run.run_id) + 1;
    const timestamp = now();
    const event: RunEvent = { version: 1, event_id: `${run.run_id}:${sequence}`, run_id: run.run_id, sequence,
      occurred_at: timestamp, recorded_at: timestamp, type, source: 'platform:durable-run-state', ...this.progress(run) };
    this.db.prepare('INSERT INTO run_events VALUES(?,?,?)').run(run.run_id, sequence, JSON.stringify(event));
  }
  eventHead(id: string): number { return Number(this.db.prepare('SELECT MAX(sequence) AS seq FROM run_events WHERE run_id=?').get(id)!.seq ?? 0); }
  events(id: string, after: number): RunEvent[] {
    return this.db.prepare('SELECT document FROM run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 32')
      .all(id, after).map(row => JSON.parse(row.document as string) as RunEvent);
  }
  eventObservation(workspace: string) {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM run_events e JOIN runs r ON e.run_id=r.id WHERE r.workspace=?').get(workspace)!;
    return { source: 'platform:durable-run-events', observed_at: now(), persisted: Number(row.total) };
  }
  objects(): StoredObject[] { return this.db.prepare('SELECT document FROM objects').all().map(r => JSON.parse(r.document as string) as StoredObject); }
  object(id: string): StoredObject | undefined {
    const row = this.db.prepare('SELECT document FROM objects WHERE id=?').get(id);
    return row ? JSON.parse(row.document as string) as StoredObject : undefined;
  }
  saveObject(object: StoredObject) {
    this.db.prepare('INSERT INTO objects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(object.object_id, JSON.stringify(object));
  }
  close() { this.db.close(); }
}
