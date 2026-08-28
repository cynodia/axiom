import { randomUUID } from 'node:crypto';
import {
  COORDINATION_CAPABILITIES,
  type AcquireResult,
  type CoordinationProvider,
  type FencingGeneration,
  type Lease,
  type LeaseView,
  type OwnershipCheck,
} from './coordination.js';
import { DEFAULT_BUSY_TIMEOUT_MS, runWithBusyHandling } from './sqlite-contention.js';

/**
 * The SQLite cross-process coordination provider (spec12 §11, §64).
 *
 * This is the *real* reference: independent OS processes, independent connections, one
 * database file. Every claim transition is an atomic compare-and-set inside `BEGIN
 * IMMEDIATE` — two racing processes serialize on SQLite's writer lock and the loser sees
 * the winner's live row (spec12 §17, §50). A crashed owner strands nothing: its lease
 * expires and any authority reclaims it under a fresh `generation` (spec12 §9, §72).
 *
 * Physical `SQLITE_BUSY` / `SQLITE_LOCKED` never leaks as a semantic result (spec12 §65,
 * §87): `runWithBusyHandling` absorbs a short contention window, and sustained contention
 * surfaces as the typed `SqliteContentionError`, not a coordination outcome.
 *
 * **Clock (spec12 §24, §91, §92).** SQLite provides no independent server clock. Lease
 * expiry is compared against the wall clock of whichever authority performs the operation.
 * The contract tolerates bounded skew: `renewIntervalMs <= leaseDurationMs / 2` (enforced
 * by `validateCoordinationConfig`) leaves a full lease-length safety margin. A deployment
 * with unbounded clock skew across authority hosts is unsupported and must be rejected
 * operationally.
 */

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

export async function isSqliteCoordinationAvailable(): Promise<boolean> {
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
  CREATE TABLE IF NOT EXISTS _axiom_coordination_lease (
    resource_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    token TEXT NOT NULL,
    generation INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

export interface SqliteCoordinationOptions {
  /** A file path shared by every authority process. `:memory:` defeats the purpose. */
  location: string;
  /** Reuse an already-open database instead of opening `location`. */
  database?: unknown;
  now?: () => number;
  nextToken?: () => string;
  /** Physical SQLite busy window in ms (spec11.2 §21). Not coordination configuration. */
  busyTimeoutMs?: number;
  /** Test seam — deterministic sleep for the bounded busy retry. */
  sleep?: (ms: number) => Promise<void>;
}

/** A released row is kept (so `generation` never rewinds) with this sentinel expiry. */
const RELEASED = 0;

export async function createSqliteCoordinationProvider(
  options: SqliteCoordinationOptions,
): Promise<CoordinationProvider & { database: unknown }> {
  const db =
    (options.database as SqliteDatabase | undefined) ?? (await openDatabase(options.location));
  const ms = Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
  db.exec(`PRAGMA busy_timeout = ${ms};`);
  db.exec(DDL);

  const now = options.now ?? (() => Date.now());
  // A per-acquisition nonce that must be globally unique across every authority process
  // sharing this file — a per-process counter would collide (`lease-1` in two processes),
  // letting a stale owner's `renew`/`release` match the reclaimer's row. Conformance
  // fixtures inject a deterministic `nextToken`.
  const nextToken = options.nextToken ?? (() => randomUUID());

  const guard = <T>(context: string, fn: () => T): Promise<T> =>
    runWithBusyHandling(fn, {
      context,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });

  const readRow = db.prepare(
    'SELECT owner_id, token, generation, acquired_at, expires_at FROM _axiom_coordination_lease WHERE resource_id = ?',
  );
  const upsertRow = db.prepare(
    `INSERT INTO _axiom_coordination_lease (resource_id, owner_id, token, generation, acquired_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_id) DO UPDATE SET owner_id = excluded.owner_id, token = excluded.token,
       generation = excluded.generation, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
  );
  const renewRow = db.prepare(
    'UPDATE _axiom_coordination_lease SET expires_at = ? WHERE resource_id = ? AND token = ? AND expires_at > ?',
  );
  const releaseRow = db.prepare(
    `UPDATE _axiom_coordination_lease SET expires_at = ${RELEASED}, token = '' WHERE resource_id = ? AND token = ?`,
  );
  const listRows = db.prepare(
    "SELECT resource_id, owner_id, token, generation, acquired_at, expires_at FROM _axiom_coordination_lease WHERE resource_id LIKE ? AND token != '' ORDER BY resource_id",
  );

  const rowToLease = (resourceId: string, row: Record<string, unknown>): Lease => ({
    resourceId,
    ownerId: String(row.owner_id),
    token: String(row.token),
    generation: Number(row.generation),
    acquiredAt: Number(row.acquired_at),
    expiresAt: Number(row.expires_at),
  });

  return {
    database: db,
    capabilities: {
      provider: 'sqlite',
      supports: COORDINATION_CAPABILITIES,
      physicalDurability: true,
    },

    async acquire(resourceId, ownerId, leaseMs): Promise<AcquireResult> {
      return guard('coordination.acquire', () => {
        const acquiredAt = now();
        db.exec('BEGIN IMMEDIATE;');
        try {
          const row = readRow.get(resourceId);
          if (row && Number(row.expires_at) > acquiredAt) {
            db.exec('COMMIT;');
            return { ok: false, heldBy: rowToLease(resourceId, row) };
          }
          const generation: FencingGeneration = (row ? Number(row.generation) : 0) + 1;
          const token = nextToken();
          const expiresAt = acquiredAt + leaseMs;
          upsertRow.run(resourceId, ownerId, token, generation, acquiredAt, expiresAt);
          db.exec('COMMIT;');
          return { ok: true, lease: { resourceId, ownerId, token, generation, acquiredAt, expiresAt } };
        } catch (error) {
          try {
            db.exec('ROLLBACK;');
          } catch {
            /* nothing open */
          }
          throw error;
        }
      });
    },

    async renew(resourceId, token, leaseMs) {
      return guard('coordination.renew', () => {
        const result = renewRow.run(now() + leaseMs, resourceId, token, now());
        return (result.changes ?? 0) > 0;
      });
    },

    async release(resourceId, token) {
      await guard('coordination.release', () => releaseRow.run(resourceId, token));
    },

    async inspect(resourceId) {
      return guard('coordination.inspect', () => {
        const row = readRow.get(resourceId);
        if (!row || Number(row.expires_at) <= now()) {
          return null;
        }
        return rowToLease(resourceId, row);
      });
    },

    async checkOwnership(resourceId, ownerId, generation): Promise<OwnershipCheck> {
      return guard('coordination.checkOwnership', () => {
        const row = readRow.get(resourceId);
        if (!row) {
          return { current: false, lease: null, reason: 'unknown-resource' };
        }
        const at = now();
        const live = Number(row.expires_at) > at ? rowToLease(resourceId, row) : null;
        if (live && live.ownerId === ownerId && live.generation === generation) {
          return { current: true, lease: live };
        }
        let reason: OwnershipCheck['reason'];
        if (Number(row.generation) > generation) {
          reason = 'fenced';
        } else if (!live) {
          reason = 'expired';
        } else {
          reason = 'not-owner';
        }
        return { current: false, lease: live, reason };
      });
    },

    async list(prefix): Promise<LeaseView[]> {
      return guard('coordination.list', () => {
        const at = now();
        return listRows.all(`${prefix ?? ''}%`).map((row) => {
          const lease = rowToLease(String(row.resource_id), row);
          return { ...lease, live: lease.expiresAt > at };
        });
      });
    },

    async close() {
      db.close();
    },
  };
}
