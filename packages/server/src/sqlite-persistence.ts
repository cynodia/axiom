import type {
  CommitOutcome,
  EffectRecord,
  PersistedState,
  PersistenceAdapter,
  PersistenceCommit,
} from './persistence.js';
import type { NodeId } from './deps.js';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  SqliteContentionError,
  runWithBusyHandling,
} from './sqlite-contention.js';

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
 *
 * **Multi-process contention (spec12.1 §27-§34).** This adapter is part of the supported
 * SQLite multi-authority reference path: independent OS processes, independent connections,
 * one database file. SQLite's single-writer file lock surfaces physical contention as
 * `SQLITE_BUSY` / `SQLITE_LOCKED`; that MUST NOT escape as a semantic result during ordinary
 * operation. Every statement runs behind a short `PRAGMA busy_timeout` plus the bounded
 * {@link runWithBusyHandling} retry shared with the migration and coordination providers —
 * physical contention is absorbed, a genuine constraint / corruption / IO / programmer error
 * passes straight through, and a semantic optimistic `CONCURRENCY_CONFLICT` is never
 * manufactured from a lock wait (§32). Waiting is always bounded (§28).
 */
export interface SqlitePersistenceOptions {
  /** A file path, or `':memory:'`. */
  location: string;
  table?: string;
  /**
   * The SQLite native busy wait, in ms (spec12.1 §30). Infrastructure tuning, never
   * application semantics. `0` disables the native wait; the bounded retry still applies.
   * Defaults to the value the migration / coordination providers use.
   */
  busyTimeoutMs?: number;
  /** Test seam — deterministic sleep for the bounded busy retry. */
  sleep?: (ms: number) => Promise<void>;
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
  const busyMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));

  const guard = <T>(context: string, fn: () => T): Promise<T> =>
    runWithBusyHandling(fn, {
      context,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });

  const effectsTable = `${table}_effects`;

  // Schema creation is itself a write and can hit a concurrent initializer's lock (spec12.1
  // §33) — run it behind the same bounded handling as everything else.
  await guard('sqlitePersistence.init', () => {
    database.exec(`PRAGMA busy_timeout = ${busyMs};`);
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
      CREATE TABLE IF NOT EXISTS ${effectsTable} (
        effect_id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
  });

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
  const insertEffect = database.prepare(
    `INSERT INTO ${effectsTable} (effect_id, record, status) VALUES (?, ?, ?)`,
  );
  const readPendingEffects = database.prepare(
    `SELECT record FROM ${effectsTable} WHERE status != 'succeeded' AND status != 'failed'`,
  );
  const readEffect = database.prepare(`SELECT record FROM ${effectsTable} WHERE effect_id = ?`);
  const updateEffect = database.prepare(
    `UPDATE ${effectsTable} SET record = ?, status = ? WHERE effect_id = ?`,
  );

  const currentRevision = (): number => Number(readRevision.get()?.value ?? 0);

  return {
    async load(): Promise<PersistedState[]> {
      return guard('sqlitePersistence.load', () =>
        readAll.all().map((row) => ({
          stateId: String(row.state_id) as NodeId,
          revision: Number(row.revision),
          value: JSON.parse(String(row.value)) as unknown,
        })),
      );
    },

    async commit(commit: PersistenceCommit): Promise<CommitOutcome> {
      // The whole commit — the conflict check and the atomic write — runs behind bounded
      // busy handling. A physical lock we wait out then re-checks conflicts against the
      // now-current revisions, so a concurrent writer's commit becomes a legitimate
      // CONCURRENCY_CONFLICT rather than a leaked SQLITE_BUSY (spec12.1 §32).
      //
      // The conflict check and the revision it is checked against MUST be read inside the
      // `BEGIN IMMEDIATE` transaction. Read outside it and two OS processes can both pass the
      // check against revision r, both compute r+1, and both COMMIT — the second silently
      // clobbers the first while both report `committed: true` and a lost write survives
      // forever (spec12.1 §31, F1). `BEGIN IMMEDIATE` takes the RESERVED lock up front, so a
      // racing writer blocks here, then re-reads the now-advanced revision and conflicts.
      try {
        return await guard('sqlitePersistence.commit', () => {
          database.exec('BEGIN IMMEDIATE');
          try {
            const conflicts = commit.writes
              .map((write) => write.stateId)
              .filter(
                (stateId) =>
                  Number(readOne.get(stateId)?.revision ?? 0) !== (commit.expected[stateId] ?? 0),
              );
            if (conflicts.length > 0) {
              database.exec('ROLLBACK');
              return { committed: false, revision: currentRevision(), conflicts };
            }

            const revision = currentRevision() + 1;
            for (const write of commit.writes) {
              upsert.run(write.stateId, revision, JSON.stringify(write.value ?? null));
            }
            setRevision.run(revision);
            for (const effect of commit.effects ?? []) {
              insertEffect.run(effect.id, JSON.stringify(effect), effect.status);
            }
            database.exec('COMMIT');
            return { committed: true, revision, conflicts: [] };
          } catch (error) {
            try {
              database.exec('ROLLBACK');
            } catch {
              /* nothing open */
            }
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof SqliteContentionError) {
          // Physical contention outlasted the bounded window. Report a refused commit (like
          // an optimistic conflict) so the authority reconciles and the caller may retry —
          // never a raw provider error (spec12.1 §27, §67).
          return {
            committed: false,
            revision: await guard('sqlitePersistence.revision', currentRevision),
            conflicts: commit.writes.map((write) => write.stateId),
          };
        }
        throw error;
      }
    },

    async revision(): Promise<number> {
      return guard('sqlitePersistence.revision', currentRevision);
    },

    async loadPendingEffects(): Promise<EffectRecord[]> {
      return guard('sqlitePersistence.loadPendingEffects', () =>
        readPendingEffects.all().map((row) => JSON.parse(String(row.record)) as EffectRecord),
      );
    },

    async recordEffectAttempt(id: string, update: Partial<EffectRecord>): Promise<void> {
      await guard('sqlitePersistence.recordEffectAttempt', () => {
        const row = readEffect.get(id);
        if (!row) {
          return;
        }
        const existing = JSON.parse(String(row.record)) as EffectRecord;
        const updated: EffectRecord = { ...existing, ...update };
        updateEffect.run(JSON.stringify(updated), updated.status, id);
      });
    },

    async close(): Promise<void> {
      database.close();
    },
  };
}
