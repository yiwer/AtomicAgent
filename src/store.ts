import { DatabaseSync } from 'node:sqlite';
import { ApiError, now, type Identity, type Run } from './domain.js';

// One local control process owns this SQLite database. Every authority change and its audit commit together.
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(workspace,owner,idempotency_key));
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, run_id TEXT, actor TEXT NOT NULL,
        workspace TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at TEXT NOT NULL);`);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor: string, workspace: string | null, action: string, outcome: string, id: string | null = null) {
    this.db.prepare('INSERT INTO audit(run_id,actor,workspace,action,outcome,recorded_at) VALUES(?,?,?,?,?,?)')
      .run(id, actor, workspace, action, outcome, now());
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
  change(id: string, action: string, update: (run: Run) => void): Run {
    return this.transaction(() => {
      const run = this.get(id)!;
      update(run);
      this.db.prepare('UPDATE runs SET document=? WHERE id=?').run(JSON.stringify(run), id);
      this.audit('platform', run.workspace, action, run.failure ?? run.status, id);
      return run;
    });
  }
  observations(identity: Identity) {
    return this.db.prepare('SELECT seq,run_id,actor,action,outcome,recorded_at FROM audit WHERE workspace=? ORDER BY seq DESC LIMIT 100').all(identity.workspace);
  }
  close() { this.db.close(); }
}
