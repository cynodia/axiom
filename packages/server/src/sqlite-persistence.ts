import type { PersistenceAdapter, PersistedState, PersistenceCommit, CommitOutcome } from './persistence.js';
import type { NodeId } from './deps.js';

/**
 * Durable persistence on SQLite, through Node's built-in `node:sqlite`.
 *
 * State is stored in document form — one row per state, holding its serialized semantic
 * value and its revision. That is deliberate: 0.6 is about persistence *semantics*, and a
 * relational projection of the semantic model is separate design work. What matters here is
 * durability, atomicity, identity preservation and transaction correctness.
 *
 * The whole semantic transaction is written inside one SQL transaction, so a crash cannot
 * leave half of an action committed.
 */
export interface SqlitePersistenceOptions {
  /** A file path, or `':memory:'`. */
  location: string;
  table?: string;
}

interface SqliteStatement {
  run(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): Array<Record<string, unknown>>;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** Whether this Node build offers `node:sqlite` at all. */
export async function isSqliteAvailable(): Promise<boolean> {
  try {
    const module = (await import('node:sqlite')) as { DatabaseSync?: unknown };
    return typeof module.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

export async function createSqlitePersistence(
  options: SqlitePersistenceOptions,
): Promise<PersistenceAdapter> {
  const module = (await import('node:sqlite')) as {
    DatabaseSync: new (location: string) => SqliteDatabase;
  };
  const table = options.table ?? 'axiom_state';
  const database = new module.DatabaseSync(options.location);

  database.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      state_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${table}_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);

  const readAll = database.prepare(`SELECT state_id, revision, value FROM ${table}`);
  const readRevision = database.prepare(`SELECT value FROM ${table}_meta WHERE key = 'revision'`);
  const readOne = database.prepare(`SELECT revision FROM ${table} WHERE state_id = ?`);
  const upsert = database.prepare(
    `INSERT INTO ${table} (state_id, revision, value) VALUES (?, ?, ?)
     ON CONFLICT(state_id) DO UPDATE SET revision = excluded.revision, value = excluded.value`,
  );
  const setRevision = database.prepare(
    `INSERT INTO ${table}_meta (key, value) VALUES ('revision', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const currentRevision = (): number => Number(readRevision.get()?.value ?? 0);

  return {
    async load(): Promise<PersistedState[]> {
      return readAll.all().map((row) => ({
        stateId: String(row.state_id) as NodeId,
        revision: Number(row.revision),
        value: JSON.parse(String(row.value)) as unknown,
      }));
    },

    async commit(commit: PersistenceCommit): Promise<CommitOutcome> {
      const conflicts = commit.writes
        .map((write) => write.stateId)
        .filter(
          (stateId) =>
            Number(readOne.get(stateId)?.revision ?? 0) !== (commit.expected[stateId] ?? 0),
        );
      if (conflicts.length > 0) {
        return { committed: false, revision: currentRevision(), conflicts };
      }

      const revision = currentRevision() + 1;
      // One SQL transaction for one semantic transaction. A failure part-way leaves the
      // store exactly as it was.
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const write of commit.writes) {
          upsert.run(write.stateId, revision, JSON.stringify(write.value ?? null));
        }
        setRevision.run(revision);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return { committed: true, revision, conflicts: [] };
    },

    async revision(): Promise<number> {
      return currentRevision();
    },

    async close(): Promise<void> {
      database.close();
    },
  };
}
