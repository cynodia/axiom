import type { EntityDef, LiteralValue, ServerIR } from './deps.js';
import type {
  AcquireLockResult,
  MigrationCheckpoint,
  MigrationHistoryEntry,
  MigrationLock,
  MigrationMetadataStore,
  MigrationSchemaRecord,
} from './migration-store.js';
import type { MigrationRowStore } from './migration-row-store.js';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  runWithBusyHandling,
} from './sqlite-contention.js';

/**
 * The SQLite-backed schema-evolution durability layer (spec11 §10, §82).
 *
 * `createSqliteMigrationStore` records the schema version, fingerprint, completed-step
 * history, migration lock and resume checkpoint in reserved `_axiom_migration_*` tables.
 * `createSqliteRowStore` executes schema operations as real `ALTER TABLE` / rebuilds and row
 * transforms as batched `UPDATE`s — **no application-authored SQL** (spec11 §82). Both must
 * produce semantically equivalent target data to the in-memory reference (spec11 §83).
 */

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

export async function isSqliteMigrationAvailable(): Promise<boolean> {
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

/**
 * Set the connection's physical busy window (spec11.2 §7, §21). This is the first line of
 * contention handling: a synchronous statement blocked by another connection's lock waits up
 * to this long for the lock to clear before `node:sqlite` throws `SQLITE_BUSY`. It is
 * deliberately short — it tolerates a lock hand-off, it must not serialise a whole migration
 * behind the writer lock. `runWithBusyHandling` adds a small bounded retry on top.
 */
function applyBusyTimeout(db: SqliteDatabase, busyTimeoutMs: number | undefined): void {
  const ms = Math.max(0, Math.floor(busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
  db.exec(`PRAGMA busy_timeout = ${ms};`);
}

function tableName(entityId: string): string {
  return `t_${entityId.replace(/[^A-Za-z0-9_]/g, '_')}`;
}
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
function bind(value: LiteralValue | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

// --------------------------------------------------------------------- metadata store

const DDL = `
  CREATE TABLE IF NOT EXISTS _axiom_migration_schema (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _axiom_migration_history (
    migration_id TEXT PRIMARY KEY,
    from_schema INTEGER NOT NULL,
    to_schema INTEGER NOT NULL,
    operation_ids TEXT NOT NULL,
    completed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _axiom_migration_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    token TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    lease_expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _axiom_migration_checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    plan_id TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    operation_index INTEGER NOT NULL,
    batch_cursor TEXT,
    rows_processed INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export interface SqliteMigrationStoreOptions {
  location: string;
  now?: () => number;
  nextToken?: () => string;
  /** Reuse an already-open database instead of opening `location`. */
  database?: unknown;
  /**
   * Physical SQLite busy window in milliseconds (spec11.2 §21, §53). This tunes how long a
   * statement waits for another connection's file lock before `SQLITE_BUSY` surfaces; it is
   * **not** migration-ownership configuration and correctness never depends on it. Default
   * {@link DEFAULT_BUSY_TIMEOUT_MS}. `0` disables the wait (each contended statement then
   * relies solely on the bounded retry).
   */
  busyTimeoutMs?: number;
  /** Test seam — deterministic sleep for the bounded busy retry. */
  sleep?: (ms: number) => Promise<void>;
}

export async function createSqliteMigrationStore(
  options: SqliteMigrationStoreOptions,
): Promise<MigrationMetadataStore & { database: unknown }> {
  const db = (options.database as SqliteDatabase | undefined) ?? (await openDatabase(options.location));
  applyBusyTimeout(db, options.busyTimeoutMs);
  db.exec(DDL);
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const nextToken = options.nextToken ?? (() => `lock-${(counter += 1)}`);

  // Every metadata operation — read and write alike — can race another OS process on the
  // same file (spec11.2 §11). `guard` runs the synchronous statement inside the bounded
  // busy window; a non-contention error is re-thrown untouched, sustained contention becomes
  // a typed `SqliteContentionError` the migration-aware callers classify.
  const guard = <T>(context: string, fn: () => T): Promise<T> =>
    runWithBusyHandling(fn, {
      context,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });

  const readSchemaRow = db.prepare('SELECT version, fingerprint FROM _axiom_migration_schema WHERE id = 1');
  const readHistoryRows = db.prepare(
    'SELECT migration_id, from_schema, to_schema, operation_ids, completed_at FROM _axiom_migration_history ORDER BY to_schema',
  );
  const upsertSchema = db.prepare(
    `INSERT INTO _axiom_migration_schema (id, version, fingerprint, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
  );
  const insertHistory = db.prepare(
    `INSERT OR IGNORE INTO _axiom_migration_history
       (migration_id, from_schema, to_schema, operation_ids, completed_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const readLockRow = db.prepare(
    'SELECT holder, token, acquired_at, lease_expires_at FROM _axiom_migration_lock WHERE id = 1',
  );
  // Atomic compare-and-set for the lease (spec11.2 §10): inside `BEGIN IMMEDIATE`, drop an
  // expired lease then insert *only if the row is now absent*. Two racing processes serialise
  // on the writer lock; the second sees the first's live row and its INSERT is a no-op
  // (`changes = 0`), so it loses cleanly instead of overwriting the lease.
  const clearExpiredLock = db.prepare(
    'DELETE FROM _axiom_migration_lock WHERE id = 1 AND lease_expires_at <= ?',
  );
  const insertLockIfAbsent = db.prepare(
    `INSERT INTO _axiom_migration_lock (id, holder, token, acquired_at, lease_expires_at)
     VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  );
  const deleteLock = db.prepare('DELETE FROM _axiom_migration_lock WHERE id = 1 AND token = ?');
  const extendLock = db.prepare(
    'UPDATE _axiom_migration_lock SET lease_expires_at = ? WHERE id = 1 AND token = ? AND lease_expires_at > ?',
  );
  const readCheckpointRow = db.prepare(
    'SELECT plan_id, target_fingerprint, operation_index, batch_cursor, rows_processed, updated_at FROM _axiom_migration_checkpoint WHERE id = 1',
  );
  const upsertCheckpoint = db.prepare(
    `INSERT INTO _axiom_migration_checkpoint
       (id, plan_id, target_fingerprint, operation_index, batch_cursor, rows_processed, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, target_fingerprint = excluded.target_fingerprint,
       operation_index = excluded.operation_index, batch_cursor = excluded.batch_cursor,
       rows_processed = excluded.rows_processed, updated_at = excluded.updated_at`,
  );
  const deleteCheckpoint = db.prepare('DELETE FROM _axiom_migration_checkpoint WHERE id = 1');

  const rowToLock = (row: Record<string, unknown>): MigrationLock => ({
    holder: String(row.holder),
    token: String(row.token),
    acquiredAt: Number(row.acquired_at),
    leaseExpiresAt: Number(row.lease_expires_at),
  });
  const liveLock = (): MigrationLock | null => {
    const row = readLockRow.get();
    if (!row) return null;
    const lock = rowToLock(row);
    return lock.leaseExpiresAt > now() ? lock : null;
  };

  return {
    database: db,
    async readSchema(): Promise<MigrationSchemaRecord | null> {
      return guard('readSchema', () => {
        const row = readSchemaRow.get();
        if (!row) return null;
        const history: MigrationHistoryEntry[] = readHistoryRows.all().map((entry) => ({
          migrationId: String(entry.migration_id),
          fromSchema: Number(entry.from_schema),
          toSchema: Number(entry.to_schema),
          operationIds: JSON.parse(String(entry.operation_ids)) as string[],
          completedAt: Number(entry.completed_at),
        }));
        return {
          schemaVersion: Number(row.version),
          schemaFingerprint: String(row.fingerprint),
          history,
          updatedAt: now(),
        };
      });
    },
    async writeSchema(schemaVersion, schemaFingerprint) {
      await guard('writeSchema', () => upsertSchema.run(schemaVersion, schemaFingerprint, now()));
    },
    async appendHistory(entry) {
      await guard('appendHistory', () =>
        insertHistory.run(
          entry.migrationId,
          entry.fromSchema,
          entry.toSchema,
          JSON.stringify(entry.operationIds),
          entry.completedAt,
        ),
      );
    },
    async acquireLock(holder, leaseMs): Promise<AcquireLockResult> {
      return guard('acquireLock', () => {
        const acquiredAt = now();
        const token = nextToken();
        const leaseExpiresAt = acquiredAt + leaseMs;
        db.exec('BEGIN IMMEDIATE;');
        try {
          clearExpiredLock.run(acquiredAt);
          const inserted = insertLockIfAbsent.run(holder, token, acquiredAt, leaseExpiresAt) as {
            changes?: number;
          };
          if ((inserted.changes ?? 0) > 0) {
            db.exec('COMMIT;');
            return { ok: true, lock: { holder, token, acquiredAt, leaseExpiresAt } };
          }
          const row = readLockRow.get();
          db.exec('COMMIT;');
          return { ok: false, ...(row ? { heldBy: rowToLock(row) } : {}) };
        } catch (error) {
          try {
            db.exec('ROLLBACK;');
          } catch {
            /* nothing open to roll back */
          }
          throw error;
        }
      });
    },
    async renewLock(token, leaseMs) {
      return guard('renewLock', () => {
        const result = extendLock.run(now() + leaseMs, token, now()) as { changes?: number };
        return (result.changes ?? 0) > 0;
      });
    },
    async releaseLock(token) {
      await guard('releaseLock', () => deleteLock.run(token));
    },
    async readLock() {
      return guard('readLock', () => liveLock());
    },
    async readCheckpoint(): Promise<MigrationCheckpoint | null> {
      return guard('readCheckpoint', () => {
        const row = readCheckpointRow.get();
        if (!row) return null;
        return {
          planId: String(row.plan_id),
          targetFingerprint: String(row.target_fingerprint),
          operationIndex: Number(row.operation_index),
          batchCursor:
            row.batch_cursor === null || row.batch_cursor === undefined ? null : String(row.batch_cursor),
          rowsProcessed: Number(row.rows_processed),
          updatedAt: Number(row.updated_at),
        };
      });
    },
    async writeCheckpoint(checkpoint) {
      await guard('writeCheckpoint', () =>
        upsertCheckpoint.run(
          checkpoint.planId,
          checkpoint.targetFingerprint,
          checkpoint.operationIndex,
          checkpoint.batchCursor,
          checkpoint.rowsProcessed,
          now(),
        ),
      );
    },
    async clearCheckpoint() {
      await guard('clearCheckpoint', () => deleteCheckpoint.run());
    },
  };
}

// ----------------------------------------------------------------------- row store

export interface SqliteRowStoreOptions {
  location: string;
  ir: ServerIR;
  seed?: Record<string, Array<Record<string, LiteralValue>>>;
  database?: unknown;
  /** Physical SQLite busy window in ms (spec11.2 §21). See {@link SqliteMigrationStoreOptions.busyTimeoutMs}. */
  busyTimeoutMs?: number;
  /** Test seam — deterministic sleep for the bounded busy retry. */
  sleep?: (ms: number) => Promise<void>;
}

export async function createSqliteRowStore(
  options: SqliteRowStoreOptions,
): Promise<MigrationRowStore & { database: unknown; snapshot: (entityId: string) => Array<Record<string, LiteralValue>> }> {
  const db = (options.database as SqliteDatabase | undefined) ?? (await openDatabase(options.location));
  applyBusyTimeout(db, options.busyTimeoutMs);
  const guard = <T>(context: string, fn: () => T): Promise<T> =>
    runWithBusyHandling(fn, {
      context,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });
  const entitiesById = new Map(
    options.ir.entities.map((entity) => [String(entity.id), entity as EntityDef]),
  );

  const columnsOf = (entityId: string): string[] => {
    const info = db.prepare(`PRAGMA table_info(${tableName(entityId)})`).all();
    return info.map((row) => String(row.name)).filter((name) => name !== '_seq');
  };
  const hasColumn = (entityId: string, column: string): boolean => columnsOf(entityId).includes(column);
  const tableExists = (entityId: string): boolean =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName(entityId)) !== undefined;

  const createTable = (entityId: string): void => {
    const entity = entitiesById.get(entityId);
    const fieldColumns = (entity?.fields ?? []).map((fieldDef) => `${quote(String(fieldDef.id))} `);
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${tableName(entityId)} (${[...fieldColumns, '_seq INTEGER'].join(', ')});`,
    );
  };

  // The database starts at the *source* schema shape — the seed's columns — and the
  // migration's own operations run the real ALTER TABLEs toward the target. The IR
  // (`options.ir`) describes the target and is used only for column types on `add-entity`.
  for (const [entityId, rows] of Object.entries(options.seed ?? {})) {
    if (!tableExists(entityId)) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${tableName(entityId)} (_seq INTEGER);`);
    }
    const seedColumns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    for (const column of seedColumns) {
      if (!hasColumn(entityId, column)) {
        db.exec(`ALTER TABLE ${tableName(entityId)} ADD COLUMN ${quote(column)};`);
      }
    }
    const insert = db.prepare(
      `INSERT INTO ${tableName(entityId)} (${seedColumns.map(quote).join(', ')}, _seq) VALUES (${seedColumns
        .map(() => '?')
        .join(', ')}, ?)`,
    );
    rows.forEach((row, index) => {
      insert.run(...seedColumns.map((column) => bind(row[column] ?? null)), index);
    });
  }

  const snapshot = (entityId: string): Array<Record<string, LiteralValue>> => {
    if (!tableExists(entityId)) return [];
    const columns = columnsOf(entityId);
    return db
      .prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${tableName(entityId)} ORDER BY _seq`)
      .all()
      .map((raw) => {
        const record: Record<string, LiteralValue> = {};
        for (const column of columns) {
          record[column] = raw[column] as LiteralValue;
        }
        return record;
      });
  };

  return {
    database: db,
    snapshot,
    async addEntity(entityId) {
      await guard('addEntity', () => createTable(entityId));
    },
    async removeEntity(entityId) {
      await guard('removeEntity', () => db.exec(`DROP TABLE IF EXISTS ${tableName(entityId)};`));
    },
    async addColumn(entityId, fieldId) {
      await guard('addColumn', () => {
        if (!tableExists(entityId)) createTable(entityId);
        if (!hasColumn(entityId, fieldId)) {
          db.exec(`ALTER TABLE ${tableName(entityId)} ADD COLUMN ${quote(fieldId)};`);
        }
      });
    },
    async dropColumn(entityId, fieldId) {
      await guard('dropColumn', () => {
        if (tableExists(entityId) && hasColumn(entityId, fieldId)) {
          db.exec(`ALTER TABLE ${tableName(entityId)} DROP COLUMN ${quote(fieldId)};`);
        }
      });
    },
    async countRows(entityId) {
      return guard('countRows', () => {
        if (!tableExists(entityId)) return 0;
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${tableName(entityId)}`).get();
        return Number(row?.n ?? 0);
      });
    },
    async readBatch(entityId, identityField, afterIdentity, limit) {
      return guard('readBatch', () => {
        if (!tableExists(entityId)) return [];
        const columns = columnsOf(entityId);
        const where = afterIdentity === null ? '' : `WHERE ${quote(identityField)} > ?`;
        const sql = `SELECT ${columns.map(quote).join(', ')} FROM ${tableName(entityId)} ${where} ORDER BY ${quote(
          identityField,
        )} LIMIT ?`;
        const statement = db.prepare(sql);
        const rows =
          afterIdentity === null ? statement.all(limit) : statement.all(bind(afterIdentity), limit);
        return rows.map((raw) => {
          const record: Record<string, LiteralValue> = {};
          for (const column of columns) {
            record[column] = raw[column] as LiteralValue;
          }
          return record;
        });
      });
    },
    async writeBatch(entityId, identityField, updates) {
      if (updates.length === 0) return;
      // The whole batch is one `BEGIN IMMEDIATE` transaction; a `SQLITE_BUSY` at any point
      // rolls it back atomically and the bounded retry re-applies the *already-computed*
      // updates — idempotent, so a retried batch can never double-transform a row
      // (spec11.2 §17).
      await guard('writeBatch', () => {
        const existing = new Set(columnsOf(entityId));
        db.exec('BEGIN IMMEDIATE;');
        try {
          for (const update of updates) {
            const columns = Object.keys(update.values).filter((column) => existing.has(column));
            if (columns.length === 0) continue;
            const sql = `UPDATE ${tableName(entityId)} SET ${columns
              .map((column) => `${quote(column)} = ?`)
              .join(', ')} WHERE ${quote(identityField)} = ?`;
            db.prepare(sql).run(...columns.map((column) => bind(update.values[column])), bind(update.identity));
          }
          db.exec('COMMIT;');
        } catch (error) {
          try {
            db.exec('ROLLBACK;');
          } catch {
            /* the BEGIN itself failed — nothing open to roll back */
          }
          throw error;
        }
      });
    },
    async requiredFieldViolation(entityId, requiredFields, identityField) {
      return guard('requiredFieldViolation', () => {
        if (!tableExists(entityId)) return null;
        const columns = new Set(columnsOf(entityId));
        for (const fieldId of requiredFields) {
          if (!columns.has(fieldId)) {
            return `${entityId} is missing required column ${fieldId} after migration`;
          }
          const row = db
            .prepare(`SELECT COUNT(*) AS n FROM ${tableName(entityId)} WHERE ${quote(fieldId)} IS NULL`)
            .get();
          if (Number(row?.n ?? 0) > 0) {
            return `${entityId} has ${row?.n} row(s) missing required field ${fieldId} after migration`;
          }
        }
        if (identityField && columns.has(identityField)) {
          const row = db
            .prepare(`SELECT COUNT(*) AS n FROM ${tableName(entityId)} WHERE ${quote(identityField)} IS NULL`)
            .get();
          if (Number(row?.n ?? 0) > 0) {
            return `${entityId} has ${row?.n} row(s) with no identity value after migration`;
          }
        }
        return null;
      });
    },
  };
}
