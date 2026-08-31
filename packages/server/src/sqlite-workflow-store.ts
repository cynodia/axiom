/**
 * The SQLite cross-process {@link WorkflowStore} (spec14 §83, §132-§135).
 *
 * Independent OS processes, independent connections, one database file. Every logical
 * transition runs `BEGIN IMMEDIATE; verify expected instance revision + fence; write;
 * revision + 1; append history; COMMIT` — the check is **inside** the transaction (the
 * spec13.1 lesson), so two authorities attempting a transition from the same revision cannot
 * both commit (spec14 §133). `runWithBusyHandling` + `PRAGMA busy_timeout` absorb physical
 * `SQLITE_BUSY` so it never surfaces as application semantics (spec14 §134). Schema init is
 * `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` under the same handling, so N processes
 * initializing a fresh store concurrently is safe (spec14 §135).
 *
 * No SQLite path / table / rowid / WAL position appears in the `WorkflowStore` contract
 * (spec14 §84).
 */

import { DEFAULT_BUSY_TIMEOUT_MS, SqliteContentionError, runWithBusyHandling } from './sqlite-contention.js';
import {
  workflowStartKey,
  type WorkflowEventWait,
  type WorkflowHistoryEntry,
  type WorkflowInstanceRecord,
  type WorkflowJournalEntry,
  type WorkflowStartIdentity,
  type WorkflowStore,
  type WorkflowTransition,
  type WorkflowTransitionResult,
} from './workflow-store.js';

/** How many journalled accepted events to retain per store — a bounded crash-window buffer. */
const JOURNAL_CAP = 8192;

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

export async function isSqliteWorkflowStoreAvailable(): Promise<boolean> {
  try {
    const module = (await import('node:sqlite')) as { DatabaseSync?: unknown };
    return typeof module.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

export interface SqliteWorkflowStoreOptions {
  location: string;
  busyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const J = (v: unknown): string => JSON.stringify(v ?? null);
const P = <T = unknown>(v: unknown): T => (v === null || v === undefined ? (undefined as T) : (JSON.parse(String(v)) as T));

function rowToRecord(row: Record<string, unknown>): WorkflowInstanceRecord {
  return {
    instanceId: String(row.instance_id),
    workflowId: String(row.workflow_id),
    compatibilityFingerprint: String(row.compat),
    principal: P(row.principal),
    principalFingerprint: String(row.principal_fp),
    inputs: P(row.inputs) ?? {},
    status: String(row.status) as WorkflowInstanceRecord['status'],
    currentStepId: String(row.current_step),
    activationId: String(row.activation_id),
    attempt: Number(row.attempt),
    bindings: P(row.bindings) ?? {},
    wait: P(row.wait),
    pendingAction: P(row.pending_action),
    nextEligibleAt: row.next_eligible_at === null || row.next_eligible_at === undefined ? undefined : Number(row.next_eligible_at),
    instanceRevision: Number(row.instance_revision),
    fence: Number(row.fence),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    failure: P(row.failure),
    output: P(row.output),
  };
}

function eventWaitOf(row: Record<string, unknown>): WorkflowEventWait {
  const record = rowToRecord(row);
  const wait = record.wait as Extract<WorkflowInstanceRecord['wait'], { kind: 'event' }>;
  return {
    instanceId: record.instanceId,
    instanceRevision: record.instanceRevision,
    stepId: wait.stepId,
    activationId: record.activationId,
    eventId: wait.eventId,
    correlation: wait.correlation,
    sinceEventSeq: wait.sinceEventSeq,
    ...(wait.timeoutAt !== undefined ? { timeoutAt: wait.timeoutAt } : {}),
  };
}

export async function createSqliteWorkflowStore(options: SqliteWorkflowStoreOptions): Promise<WorkflowStore> {
  const module = (await import('node:sqlite')) as { DatabaseSync: new (location: string) => SqliteDatabase };
  const db = new module.DatabaseSync(options.location);
  const busyMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
  const guard = <T>(context: string, fn: () => T): Promise<T> =>
    runWithBusyHandling(fn, { context, ...(options.sleep !== undefined ? { sleep: options.sleep } : {}) });

  await guard('sqliteWorkflowStore.init', () => {
    if (options.location !== ':memory:') {
      try {
        db.exec('PRAGMA journal_mode = WAL;');
      } catch {
        /* fall back to the default journal */
      }
    }
    db.exec(`PRAGMA busy_timeout = ${busyMs};`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS axiom_workflow_instances (
        instance_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        compat TEXT NOT NULL,
        principal TEXT,
        principal_fp TEXT NOT NULL,
        inputs TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step TEXT NOT NULL,
        activation_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        bindings TEXT NOT NULL,
        wait TEXT,
        wait_event_id TEXT,
        pending_action TEXT,
        next_eligible_at INTEGER,
        instance_revision INTEGER NOT NULL,
        fence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failure TEXT,
        output TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_workflow_eligible ON axiom_workflow_instances (status, next_eligible_at);
      CREATE INDEX IF NOT EXISTS ix_workflow_event ON axiom_workflow_instances (wait_event_id, status);
      CREATE TABLE IF NOT EXISTS axiom_workflow_starts (
        start_key TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS axiom_workflow_history (
        instance_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        step_id TEXT,
        activation_id TEXT,
        attempt INTEGER,
        at INTEGER NOT NULL,
        detail TEXT,
        PRIMARY KEY (instance_id, seq)
      );
      CREATE TABLE IF NOT EXISTS axiom_workflow_action_outcomes (
        instance_id TEXT NOT NULL,
        activation_id TEXT NOT NULL,
        outcome TEXT,
        PRIMARY KEY (instance_id, activation_id)
      );
      CREATE TABLE IF NOT EXISTS axiom_workflow_event_journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        payload TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_workflow_journal_event ON axiom_workflow_event_journal (event_id, seq);
    `);
  });

  const readInstance = db.prepare(`SELECT * FROM axiom_workflow_instances WHERE instance_id = ?`);
  const readStart = db.prepare(`SELECT instance_id FROM axiom_workflow_starts WHERE start_key = ?`);
  const nextHistorySeq = db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM axiom_workflow_history WHERE instance_id = ?`);
  const insertHistory = db.prepare(
    `INSERT INTO axiom_workflow_history (instance_id, seq, kind, step_id, activation_id, attempt, at, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const readHistory = db.prepare(`SELECT * FROM axiom_workflow_history WHERE instance_id = ? ORDER BY seq ASC`);
  const readOutcome = db.prepare(
    `SELECT outcome FROM axiom_workflow_action_outcomes WHERE instance_id = ? AND activation_id = ?`,
  );
  const upsertOutcome = db.prepare(
    `INSERT INTO axiom_workflow_action_outcomes (instance_id, activation_id, outcome) VALUES (?, ?, ?)
     ON CONFLICT(instance_id, activation_id) DO UPDATE SET outcome = excluded.outcome`,
  );
  const insertJournal = db.prepare(
    `INSERT INTO axiom_workflow_event_journal (event_id, payload, at) VALUES (?, ?, ?)`,
  );
  const lastRowId = db.prepare(`SELECT last_insert_rowid() AS seq`);
  const trimJournal = db.prepare(
    `DELETE FROM axiom_workflow_event_journal
     WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM axiom_workflow_event_journal) - ?`,
  );
  const readJournalSince = db.prepare(
    `SELECT seq, event_id, payload FROM axiom_workflow_event_journal
     WHERE event_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  );
  // `sqlite_sequence` holds the highest AUTOINCREMENT value ever allocated for the table —
  // monotone even after the journal is trimmed, which is exactly the `sinceEventSeq`
  // boundary a fresh wait must capture (spec14pt2 F2).
  const readJournalHighWater = db.prepare(
    `SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'axiom_workflow_event_journal'), 0) AS seq`,
  );

  const terminal = (s: string): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';

  function appendHistory(
    instanceId: string,
    entry: Omit<WorkflowHistoryEntry, 'instanceId' | 'seq' | 'at'> & { at?: number },
    at: number,
  ): void {
    const seq = Number(nextHistorySeq.get(instanceId)?.seq ?? 0);
    insertHistory.run(
      instanceId,
      seq,
      entry.kind,
      entry.stepId ?? null,
      entry.activationId ?? null,
      entry.attempt ?? null,
      entry.at ?? at,
      entry.detail ? J(entry.detail) : null,
    );
  }

  return {
    async createIdempotent(start, make) {
      const key = workflowStartKey(start);
      return guard('sqliteWorkflowStore.createIdempotent', () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (start.idempotencyKey !== null) {
            const existing = readStart.get(key);
            if (existing) {
              const row = readInstance.get(String(existing.instance_id));
              db.exec('COMMIT');
              return { instance: rowToRecord(row!), created: false };
            }
          }
          const init = make();
          const now = Date.now();
          db.prepare(
            `INSERT INTO axiom_workflow_instances
             (instance_id, workflow_id, compat, principal, principal_fp, inputs, status, current_step, activation_id,
              attempt, bindings, wait, wait_event_id, pending_action, next_eligible_at, instance_revision, fence,
              created_at, updated_at, failure, output)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            init.instanceId,
            init.workflowId,
            init.compatibilityFingerprint,
            J(init.principal),
            init.principalFingerprint,
            J(init.inputs),
            'running',
            init.entryStepId,
            `${init.entryStepId}#0`,
            0,
            J({}),
            null,
            null,
            null,
            null,
            0,
            0,
            now,
            now,
            null,
            null,
          );
          if (start.idempotencyKey !== null) {
            db.prepare(`INSERT OR IGNORE INTO axiom_workflow_starts (start_key, instance_id) VALUES (?, ?)`).run(
              key,
              init.instanceId,
            );
          }
          appendHistory(init.instanceId, { kind: 'started', stepId: init.entryStepId }, now);
          db.exec('COMMIT');
          return { instance: rowToRecord(readInstance.get(init.instanceId)!), created: true };
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* nothing open */
          }
          throw error;
        }
      });
    },

    async load(instanceId) {
      return guard('sqliteWorkflowStore.load', () => {
        const row = readInstance.get(instanceId);
        return row ? rowToRecord(row) : undefined;
      });
    },

    async loadByStart(start) {
      return guard('sqliteWorkflowStore.loadByStart', () => {
        const existing = readStart.get(workflowStartKey(start));
        if (!existing) return undefined;
        const row = readInstance.get(String(existing.instance_id));
        return row ? rowToRecord(row) : undefined;
      });
    },

    async transition({ instanceId, expectedRevision, fence, next }): Promise<WorkflowTransitionResult> {
      try {
        return await guard('sqliteWorkflowStore.transition', () => {
          db.exec('BEGIN IMMEDIATE');
          try {
            const row = readInstance.get(instanceId);
            if (!row) {
              db.exec('ROLLBACK');
              return { ok: false, reason: 'not-found' as const };
            }
            const record = rowToRecord(row);
            if (terminal(record.status)) {
              db.exec('ROLLBACK');
              return { ok: false, reason: 'terminal' as const, record };
            }
            if (fence < record.fence) {
              db.exec('ROLLBACK');
              return { ok: false, reason: 'fenced' as const, record };
            }
            if (record.instanceRevision !== expectedRevision) {
              db.exec('ROLLBACK');
              return { ok: false, reason: 'revision' as const, record };
            }

            const now = Date.now();
            const nextStatus = next.status;
            const bindings = next.bindings ? { ...record.bindings, ...next.bindings } : record.bindings;
            const wait = nextStatus === 'waiting' ? (next.wait ?? record.wait) : undefined;
            const pending =
              next.pendingAction === null ? null : next.pendingAction ? next.pendingAction : record.pendingAction ?? null;
            const nextEligible =
              next.nextEligibleAt === null ? null : next.nextEligibleAt ?? record.nextEligibleAt ?? null;

            db.prepare(
              `UPDATE axiom_workflow_instances SET
                 status = ?, current_step = ?, activation_id = ?, attempt = ?, bindings = ?, wait = ?, wait_event_id = ?,
                 pending_action = ?, next_eligible_at = ?, instance_revision = instance_revision + 1,
                 fence = MAX(fence, ?), updated_at = ?, failure = ?, output = ?
               WHERE instance_id = ? AND instance_revision = ? AND fence <= ?`,
            ).run(
              nextStatus,
              next.currentStepId,
              next.activationId,
              next.attempt,
              J(bindings),
              wait ? J(wait) : null,
              wait && wait.kind === 'event' ? wait.eventId : null,
              pending ? J(pending) : null,
              nextEligible,
              fence,
              now,
              next.failure ? J(next.failure) : record.failure ? J(record.failure) : null,
              next.output ? J(next.output) : record.output ? J(record.output) : null,
              instanceId,
              expectedRevision,
              fence,
            );
            appendHistory(instanceId, next.history, now);
            db.exec('COMMIT');
            return { ok: true as const, record: rowToRecord(readInstance.get(instanceId)!) };
          } catch (error) {
            try {
              db.exec('ROLLBACK');
            } catch {
              /* nothing open */
            }
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof SqliteContentionError) {
          const row = await guard('sqliteWorkflowStore.transition.reload', () => readInstance.get(instanceId));
          return { ok: false, reason: 'revision', ...(row ? { record: rowToRecord(row) } : {}) };
        }
        throw error;
      }
    },

    async recordAttempt(entry) {
      await guard('sqliteWorkflowStore.recordAttempt', () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          appendHistory(entry.instanceId, entry, Date.now());
          db.exec('COMMIT');
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* nothing open */
          }
          throw error;
        }
      });
    },

    async recordActionOutcome(instanceId, activationId, outcome) {
      await guard('sqliteWorkflowStore.recordActionOutcome', () =>
        upsertOutcome.run(instanceId, activationId, outcome === undefined ? null : J(outcome)),
      );
    },
    async loadActionOutcome(instanceId, activationId) {
      return guard('sqliteWorkflowStore.loadActionOutcome', () => {
        const row = readOutcome.get(instanceId, activationId);
        if (!row || row.outcome === null || row.outcome === undefined) return undefined;
        return P(row.outcome);
      });
    },

    async recoverRunnable(now, limit) {
      return guard('sqliteWorkflowStore.recoverRunnable', () =>
        db
          .prepare(
            `SELECT * FROM axiom_workflow_instances
             WHERE status NOT IN ('completed','failed','cancelled')
               AND ( status = 'running'
                     OR pending_action IS NOT NULL
                     OR (next_eligible_at IS NOT NULL AND next_eligible_at <= ?) )
             ORDER BY updated_at ASC LIMIT ?`,
          )
          .all(now, limit)
          .map(rowToRecord),
      );
    },

    async findEventWaits(eventId, limit): Promise<WorkflowEventWait[]> {
      return guard('sqliteWorkflowStore.findEventWaits', () =>
        db
          .prepare(
            `SELECT * FROM axiom_workflow_instances WHERE wait_event_id = ? AND status = 'waiting' LIMIT ?`,
          )
          .all(eventId, limit)
          .map(eventWaitOf),
      );
    },

    async pendingEventWaits(limit): Promise<WorkflowEventWait[]> {
      return guard('sqliteWorkflowStore.pendingEventWaits', () =>
        db
          .prepare(
            `SELECT * FROM axiom_workflow_instances
             WHERE wait_event_id IS NOT NULL AND status = 'waiting'
             ORDER BY updated_at ASC LIMIT ?`,
          )
          .all(limit)
          .map(eventWaitOf),
      );
    },

    async appendAcceptedEvent(eventId, payload): Promise<number> {
      return guard('sqliteWorkflowStore.appendAcceptedEvent', () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          insertJournal.run(eventId, payload === undefined ? null : J(payload), Date.now());
          const seq = Number(lastRowId.get()?.seq ?? 0);
          trimJournal.run(JOURNAL_CAP);
          db.exec('COMMIT');
          return seq;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* nothing open */
          }
          throw error;
        }
      });
    },

    async readAcceptedEventsSince(eventId, sinceSeq, limit): Promise<WorkflowJournalEntry[]> {
      return guard('sqliteWorkflowStore.readAcceptedEventsSince', () =>
        readJournalSince.all(eventId, sinceSeq, limit).map((row) => ({
          seq: Number(row.seq),
          eventId: String(row.event_id),
          payload: P(row.payload),
        })),
      );
    },

    async latestAcceptedEventSeq(): Promise<number> {
      return guard('sqliteWorkflowStore.latestAcceptedEventSeq', () => Number(readJournalHighWater.get()?.seq ?? 0));
    },

    async history(instanceId) {
      return guard('sqliteWorkflowStore.history', () =>
        readHistory.all(instanceId).map((row) => ({
          instanceId: String(row.instance_id),
          seq: Number(row.seq),
          kind: String(row.kind) as WorkflowHistoryEntry['kind'],
          ...(row.step_id ? { stepId: String(row.step_id) } : {}),
          ...(row.activation_id ? { activationId: String(row.activation_id) } : {}),
          ...(row.attempt !== null && row.attempt !== undefined ? { attempt: Number(row.attempt) } : {}),
          at: Number(row.at),
          ...(row.detail ? { detail: P(row.detail) } : {}),
        })),
      );
    },

    async list(limit) {
      return guard('sqliteWorkflowStore.list', () =>
        db
          .prepare(`SELECT * FROM axiom_workflow_instances ORDER BY updated_at DESC LIMIT ?`)
          .all(limit)
          .map(rowToRecord),
      );
    },

    async close() {
      db.close();
    },
  };
}

// Keep an unused-import guard for the shared `WorkflowTransition` type.
export type { WorkflowTransition };
