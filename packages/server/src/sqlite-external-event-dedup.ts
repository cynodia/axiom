/**
 * The SQLite cross-process {@link ExternalEventDedupStore} (spec12 §11, §25, §73).
 *
 * The atomic claim is `INSERT ... ON CONFLICT DO NOTHING` on `(source, external_event_id)`
 * followed by a read-back: the caller whose insert took the row is `accepted`; every other
 * caller reads the winner's fingerprint and answers `duplicate` or `conflict`. Two OS
 * processes racing the same delivery therefore produce exactly one accepted event.
 * `runWithBusyHandling` absorbs the physical `SQLITE_BUSY` window (spec12 §65).
 */

import {
  DEFAULT_DEDUP_WINDOW_PER_SOURCE,
  externalDeliveryKey,
  payloadFingerprint,
  type ExternalEventDedupRecord,
  type ExternalEventDedupStore,
} from './external-event-dedup.js';
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

export async function isSqliteExternalEventDedupAvailable(): Promise<boolean> {
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
  CREATE TABLE IF NOT EXISTS _axiom_external_event_dedup (
    source TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    admitted_at INTEGER NOT NULL,
    PRIMARY KEY (source, external_event_id)
  );
  CREATE INDEX IF NOT EXISTS _axiom_external_event_dedup_age
    ON _axiom_external_event_dedup (source, admitted_at);
`;

export interface SqliteExternalEventDedupOptions {
  location: string;
  database?: unknown;
  now?: () => number;
  windowPerSource?: number;
  busyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function createSqliteExternalEventDedupStore(
  options: SqliteExternalEventDedupOptions,
): Promise<ExternalEventDedupStore & { database: unknown }> {
  const db =
    (options.database as SqliteDatabase | undefined) ?? (await openDatabase(options.location));
  const ms = Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
  db.exec(`PRAGMA busy_timeout = ${ms};`);
  db.exec(DDL);

  const now = options.now ?? (() => Date.now());
  const windowPerSource = Math.max(1, options.windowPerSource ?? DEFAULT_DEDUP_WINDOW_PER_SOURCE);
  const guard = <T>(context: string, fn: () => T): Promise<T> =>
    runWithBusyHandling(fn, {
      context,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });

  const insertRow = db.prepare(
    `INSERT INTO _axiom_external_event_dedup (source, external_event_id, fingerprint, admitted_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(source, external_event_id) DO NOTHING`,
  );
  const readRow = db.prepare(
    'SELECT fingerprint FROM _axiom_external_event_dedup WHERE source = ? AND external_event_id = ?',
  );
  const trimRows = db.prepare(
    `DELETE FROM _axiom_external_event_dedup
     WHERE source = ? AND external_event_id NOT IN (
       SELECT external_event_id FROM _axiom_external_event_dedup
       WHERE source = ? ORDER BY admitted_at DESC, external_event_id DESC LIMIT ?
     )`,
  );
  const listAll = db.prepare(
    'SELECT source, external_event_id, fingerprint, admitted_at FROM _axiom_external_event_dedup ORDER BY admitted_at DESC LIMIT ?',
  );
  const listSource = db.prepare(
    'SELECT source, external_event_id, fingerprint, admitted_at FROM _axiom_external_event_dedup WHERE source = ? ORDER BY admitted_at DESC LIMIT ?',
  );

  const toRecord = (row: Record<string, unknown>): ExternalEventDedupRecord => ({
    source: String(row.source),
    externalEventId: String(row.external_event_id),
    fingerprint: String(row.fingerprint),
    admittedAt: Number(row.admitted_at),
  });

  return {
    database: db,

    async admit(ingestion) {
      if (ingestion.externalEventId === undefined || ingestion.externalEventId === '') {
        return { status: 'unidentified' };
      }
      const externalEventId = ingestion.externalEventId;
      const key = externalDeliveryKey(ingestion.source, externalEventId);
      const incoming = payloadFingerprint(ingestion.payload);
      return guard('externalEventDedup.admit', () => {
        const inserted = insertRow.run(ingestion.source, externalEventId, incoming, now());
        if ((inserted.changes ?? 0) > 0) {
          trimRows.run(ingestion.source, ingestion.source, windowPerSource);
          return { status: 'accepted' as const, deliveryKey: key, fingerprint: incoming };
        }
        const existing = readRow.get(ingestion.source, externalEventId);
        const stored = existing ? String(existing.fingerprint) : incoming;
        return stored === incoming
          ? { status: 'duplicate' as const, deliveryKey: key, fingerprint: incoming }
          : {
              status: 'conflict' as const,
              deliveryKey: key,
              code: 'EVENT_ID_CONFLICT' as const,
              storedFingerprint: stored,
              incomingFingerprint: incoming,
            };
      });
    },

    async list(source, limit = 100) {
      return guard('externalEventDedup.list', () =>
        (source === undefined ? listAll.all(limit) : listSource.all(source, limit)).map(toRecord),
      );
    },

    async close() {
      db.close();
    },
  };
}
