/**
 * The SQLite cross-process {@link CursorPositionStore} (spec12 §11, §30, §75).
 *
 * `advanceConditional` is a single `UPDATE ... WHERE ? >= writer_generation AND ? >= sequence`
 * (plus an `INSERT ... ON CONFLICT DO NOTHING` for the first write), so a stalled owner's
 * lower-generation write matches zero rows and is reported `fenced` by
 * {@link createSubscriptionCursorStore} — never a raw SQLite error, and never a silent
 * cursor regression. `runWithBusyHandling` absorbs the physical `SQLITE_BUSY` window
 * (spec12 §65).
 */

import type { CursorPositionStore, SubscriptionCursor } from './subscription-cursor.js';
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

export async function isSqliteSubscriptionCursorAvailable(): Promise<boolean> {
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
  CREATE TABLE IF NOT EXISTS _axiom_subscription_cursor (
    subscription_id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    writer_generation INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export interface SqliteSubscriptionCursorOptions {
  location: string;
  database?: unknown;
  busyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function createSqliteCursorPositionStore(
  options: SqliteSubscriptionCursorOptions,
): Promise<CursorPositionStore & { database: unknown }> {
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

  const readRow = db.prepare(
    'SELECT subscription_id, sequence, writer_generation, updated_at FROM _axiom_subscription_cursor WHERE subscription_id = ?',
  );
  const insertRow = db.prepare(
    `INSERT INTO _axiom_subscription_cursor (subscription_id, sequence, writer_generation, updated_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(subscription_id) DO NOTHING`,
  );
  const updateRow = db.prepare(
    `UPDATE _axiom_subscription_cursor
       SET sequence = ?, writer_generation = ?, updated_at = ?
     WHERE subscription_id = ? AND ? >= writer_generation AND ? >= sequence`,
  );
  const listRows = db.prepare(
    'SELECT subscription_id, sequence, writer_generation, updated_at FROM _axiom_subscription_cursor ORDER BY subscription_id LIMIT ?',
  );

  const toCursor = (row: Record<string, unknown>): SubscriptionCursor => ({
    subscriptionId: String(row.subscription_id),
    sequence: Number(row.sequence),
    writerGeneration: Number(row.writer_generation),
    updatedAt: Number(row.updated_at),
  });

  return {
    database: db,

    async read(subscriptionId) {
      return guard('subscriptionCursor.read', () => {
        const row = readRow.get(subscriptionId);
        return row ? toCursor(row) : null;
      });
    },

    async advanceConditional(subscriptionId, generation, toSequence, at) {
      return guard('subscriptionCursor.advance', () => {
        const created = insertRow.run(subscriptionId, toSequence, generation, at);
        if ((created.changes ?? 0) > 0) {
          return true;
        }
        const updated = updateRow.run(
          toSequence,
          generation,
          at,
          subscriptionId,
          generation,
          toSequence,
        );
        return (updated.changes ?? 0) > 0;
      });
    },

    async list(limit) {
      return guard('subscriptionCursor.list', () => listRows.all(limit).map(toCursor));
    },

    async close() {
      db.close();
    },
  };
}
