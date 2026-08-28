/**
 * The SQLite cross-process {@link DurableWorkStorage} (spec12 §11, §64).
 *
 * Independent OS processes, independent connections, one database file. Each conditional
 * transition is a single `UPDATE ... WHERE <fence>` — atomic by SQLite's row semantics — so
 * a stale-generation `settle` matches zero rows and is reported as `fenced` by
 * {@link DurableWorkStore}, never as a raw SQLite error. `runWithBusyHandling` absorbs the
 * physical `SQLITE_BUSY` window (spec12 §65).
 *
 * Parity with `createMemoryDurableWorkStorage` is a release requirement (spec12 §63) and is
 * asserted by running the same body against both in `durable-work.test.ts`.
 */

import type {
  DurableWorkError,
  DurableWorkItem,
  DurableWorkStorage,
  SettlePatch,
} from './durable-work.js';
import { DEFAULT_BUSY_TIMEOUT_MS, runWithBusyHandling } from './sqlite-contention.js';

interface SqliteStatement {
  run(...parameters: unknown[]): { changes?: number };
  all(...parameters: unknown[]): Array<Record<string, unknown>>;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export async function isSqliteDurableWorkAvailable(): Promise<boolean> {
  try {
    const module = (await import('node:sqlite')) as { DatabaseSync?: unknown };
    return typeof module.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

async function openDatabase(location: string): Promise<SqliteDatabase> {
  const module = (await import('node:sqlite')) as {
    DatabaseSync: new (location: string) => SqliteDatabase;
  };
  return new module.DatabaseSync(location);
}

const DDL = `
  CREATE TABLE IF NOT EXISTS _axiom_durable_work (
    work_class TEXT NOT NULL,
    work_id TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    uncertain_attempts INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT,
    owner_generation INTEGER,
    last_attempt_at INTEGER,
    next_eligible_at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    last_error TEXT,
    result TEXT,
    compatibility_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (work_class, work_id)
  );
  CREATE INDEX IF NOT EXISTS _axiom_durable_work_claimable
    ON _axiom_durable_work (work_class, state, next_eligible_at, created_at, work_id);
`;

export interface SqliteDurableWorkOptions {
  /** A file path shared by every authority process. `:memory:` defeats the purpose. */
  location: string;
  /** Reuse an already-open database instead of opening `location`. */
  database?: unknown;
  busyTimeoutMs?: number;
  /** Test seam — deterministic sleep for the bounded busy retry. */
  sleep?: (ms: number) => Promise<void>;
}

const UNDEFINED = Symbol('undefined-result');

function toJson(value: unknown): string | null {
  if (value === undefined) return JSON.stringify({ [String(UNDEFINED)]: true });
  return JSON.stringify(value ?? null);
}
function fromJson(text: unknown): unknown {
  if (text === null || text === undefined) return null;
  const parsed = JSON.parse(String(text)) as unknown;
  if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)[String(UNDEFINED)] === true) {
    return undefined;
  }
  return parsed;
}
function errorFromJson(text: unknown): DurableWorkError | null {
  if (text === null || text === undefined) return null;
  return JSON.parse(String(text)) as DurableWorkError;
}

function rowToItem(row: Record<string, unknown>): DurableWorkItem {
  return {
    workClass: String(row.work_class),
    workId: String(row.work_id),
    state: String(row.state) as DurableWorkItem['state'],
    attemptNumber: Number(row.attempt_number),
    uncertainAttempts: Number(row.uncertain_attempts ?? 0),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    ownerGeneration:
      row.owner_generation === null || row.owner_generation === undefined
        ? null
        : Number(row.owner_generation),
    lastAttemptAt:
      row.last_attempt_at === null || row.last_attempt_at === undefined
        ? null
        : Number(row.last_attempt_at),
    nextEligibleAt: Number(row.next_eligible_at),
    payload: fromJson(row.payload),
    lastError: errorFromJson(row.last_error),
    result: row.result === null || row.result === undefined ? undefined : fromJson(row.result),
    compatibilityKey:
      row.compatibility_key === null || row.compatibility_key === undefined
        ? null
        : String(row.compatibility_key),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function createSqliteDurableWorkStorage(
  options: SqliteDurableWorkOptions,
): Promise<DurableWorkStorage & { database: unknown }> {
  const db =
    (options.database as SqliteDatabase | undefined) ?? (await openDatabase(options.location));
  const ms = Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
  db.exec(`PRAGMA busy_timeout = ${ms};`);
  db.exec(DDL);

  const guard = <T>(context: string, fn: () => T): Promise<T> =>
    runWithBusyHandling(fn, {
      context,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });

  const insertRow = db.prepare(
    `INSERT INTO _axiom_durable_work
       (work_class, work_id, state, attempt_number, uncertain_attempts, owner_id, owner_generation,
        last_attempt_at, next_eligible_at, payload, last_error, result, compatibility_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_class, work_id) DO NOTHING`,
  );
  const getRow = db.prepare('SELECT * FROM _axiom_durable_work WHERE work_class = ? AND work_id = ?');
  const selectClaimableRows = db.prepare(
    `SELECT * FROM _axiom_durable_work
     WHERE work_class = ? AND state NOT IN ('succeeded', 'failed') AND next_eligible_at <= ?
     ORDER BY (state = 'claimed') ASC, created_at ASC, work_id ASC
     LIMIT ?`,
  );
  const markClaimedRow = db.prepare(
    `UPDATE _axiom_durable_work
       SET state = 'claimed',
           attempt_number = attempt_number + 1,
           uncertain_attempts = uncertain_attempts + (state = 'claimed'),
           owner_id = ?, owner_generation = ?, last_attempt_at = ?, updated_at = ?
     WHERE work_class = ? AND work_id = ?
       AND state NOT IN ('succeeded', 'failed')
       AND (owner_generation IS NULL OR owner_generation < ?)`,
  );
  const settleRow = db.prepare(
    `UPDATE _axiom_durable_work
       SET state = ?, last_error = ?, result = ?, next_eligible_at = ?, owner_id = NULL, owner_generation = NULL, updated_at = ?
     WHERE work_class = ? AND work_id = ? AND state = 'claimed' AND owner_id = ? AND owner_generation = ?`,
  );
  const releaseRow = db.prepare(
    `UPDATE _axiom_durable_work
       SET state = 'retry', next_eligible_at = ?, owner_id = NULL, owner_generation = NULL, updated_at = ?
     WHERE work_class = ? AND work_id = ? AND state = 'claimed' AND owner_id = ? AND owner_generation = ?`,
  );
  const listRows = db.prepare(
    'SELECT * FROM _axiom_durable_work WHERE work_class = ? ORDER BY created_at ASC, work_id ASC LIMIT ?',
  );

  return {
    database: db,

    async insert(item) {
      return guard('durableWork.insert', () => {
        const result = insertRow.run(
          item.workClass,
          item.workId,
          item.state,
          item.attemptNumber,
          item.uncertainAttempts,
          item.ownerId,
          item.ownerGeneration,
          item.lastAttemptAt,
          item.nextEligibleAt,
          toJson(item.payload),
          item.lastError ? JSON.stringify(item.lastError) : null,
          item.result === undefined ? null : toJson(item.result),
          item.compatibilityKey,
          item.createdAt,
          item.updatedAt,
        );
        return (result.changes ?? 0) > 0;
      });
    },

    async get(workClass, workId) {
      return guard('durableWork.get', () => {
        const row = getRow.get(workClass, workId);
        return row ? rowToItem(row) : null;
      });
    },

    async selectClaimable(workClass, at, limit) {
      return guard('durableWork.selectClaimable', () =>
        selectClaimableRows.all(workClass, at, limit).map(rowToItem),
      );
    },

    async markClaimed(workClass, workId, ownerId, generation, at) {
      return guard('durableWork.markClaimed', () => {
        const result = markClaimedRow.run(ownerId, generation, at, at, workClass, workId, generation);
        if ((result.changes ?? 0) === 0) {
          return null;
        }
        const row = getRow.get(workClass, workId);
        return row ? rowToItem(row) : null;
      });
    },

    async settleConditional(workClass, workId, ownerId, generation, patch: SettlePatch, at) {
      return guard('durableWork.settle', () => {
        const terminal = patch.state === 'succeeded' || patch.state === 'failed';
        const existing = getRow.get(workClass, workId);
        const nextEligibleAt = terminal
          ? Number(existing?.next_eligible_at ?? at)
          : patch.nextEligibleAt;
        const result = settleRow.run(
          patch.state,
          patch.lastError ? JSON.stringify(patch.lastError) : null,
          patch.state === 'succeeded' ? toJson(patch.result) : null,
          nextEligibleAt,
          at,
          workClass,
          workId,
          ownerId,
          generation,
        );
        return (result.changes ?? 0) > 0;
      });
    },

    async releaseConditional(workClass, workId, ownerId, generation, at) {
      return guard('durableWork.release', () => {
        const result = releaseRow.run(at, at, workClass, workId, ownerId, generation);
        return (result.changes ?? 0) > 0;
      });
    },

    async list(workClass, limit) {
      return guard('durableWork.list', () => listRows.all(workClass, limit).map(rowToItem));
    },

    async close() {
      db.close();
    },
  };
}
