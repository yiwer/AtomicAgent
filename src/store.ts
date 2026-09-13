import { DatabaseSync } from 'node:sqlite';
import { ApiError, now, type Profile, type Run } from './domain.js';

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
      if (JSON.stringify(run.manifest.profile, Object.keys(run.manifest.profile).sort()) !== document) throw new Error('immutable_profile_conflict');
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
  accept(run: Run, key: string): Run {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT document FROM runs WHERE workspace=? AND owner=? AND idempotency_key=?')
        .get(run.workspace, run.owner, key);
      if (row) {
        const existing = JSON.parse(row.document as string) as Run;
        if (existing.request_digest !== run.request_digest) throw new ApiError(409, 'idempotency_conflict');
        this.audit(run.owner, run.workspace, 'run.accept', 'replayed', existing.run_id);
        return existing;
      }
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(run.run_id, run.owner, run.workspace, key, JSON.stringify(run));
      this.audit(run.owner, run.workspace, 'run.accept', 'accepted', run.run_id);
      this.audit('platform', run.workspace, 'grant.freeze', 'model-only', run.run_id);
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
      update(run);
      this.db.prepare('UPDATE runs SET document=? WHERE id=?').run(JSON.stringify(run), id);
      this.audit('platform', run.workspace, action, observation?.outcome ?? run.failure ?? run.status, id, observation?.evidence);
      return run;
    });
  }
  close() { this.db.close(); }
}
