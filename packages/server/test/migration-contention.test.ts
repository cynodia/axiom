import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApplicationGraph, collectionType, entityType, fieldId, nodeId, primitiveType } from '@cynodia/axiom-core';
import type { EntityDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  SqliteContentionError,
  classifyMigrationContention,
  createSqliteMigrationStore,
  evaluateSchemaGate,
  getMigrationStatus,
  isSqliteContentionError,
  isSqliteMigrationAvailable,
  runWithBusyHandling,
} from '@cynodia/axiom-server';

/**
 * Unit + in-process coverage for the SQLite contention reconciliation (spec11.2 §5-6,
 * §15, §24, §32, §33, §35). The genuine cross-process race is in `migration-race.test.ts`.
 */

const available = await isSqliteMigrationAvailable();

// --- isSqliteContentionError: structured recognition only (spec11.2 §23, §24) -----------

test('isSqliteContentionError recognises only SQLITE_BUSY / SQLITE_LOCKED, by structured fields', () => {
  assert.equal(isSqliteContentionError({ code: 'ERR_SQLITE_ERROR', errcode: 5 }), true); // SQLITE_BUSY
  assert.equal(isSqliteContentionError({ code: 'ERR_SQLITE_ERROR', errcode: 6 }), true); // SQLITE_LOCKED
  assert.equal(isSqliteContentionError({ code: 'ERR_SQLITE_ERROR', errcode: 517 }), true); // BUSY_SNAPSHOT (5 | 2<<8)
  assert.equal(isSqliteContentionError(new SqliteContentionError(null, 'x', 4)), true);

  // Not contention: constraint, generic IO, malformed SQL, programmer errors.
  assert.equal(isSqliteContentionError({ code: 'ERR_SQLITE_ERROR', errcode: 19 }), false); // SQLITE_CONSTRAINT
  assert.equal(isSqliteContentionError({ code: 'ERR_SQLITE_ERROR', errcode: 1 }), false); // SQLITE_ERROR (syntax)
  assert.equal(isSqliteContentionError({ code: 'ERR_SQLITE_ERROR', errcode: 10 }), false); // SQLITE_IOERR
  assert.equal(isSqliteContentionError(new TypeError('bad binding')), false);
  assert.equal(isSqliteContentionError(new Error('database is locked')), false); // message text is not enough
  assert.equal(isSqliteContentionError(null), false);
  assert.equal(isSqliteContentionError('database is locked'), false);
});

// --- runWithBusyHandling: bounded, never swallows real failures (spec11.2 §7, §24) ------

test('runWithBusyHandling returns immediately on success and never retries a non-contention error', async () => {
  let calls = 0;
  const value = await runWithBusyHandling(() => {
    calls += 1;
    return 42;
  }, { context: 'ok' });
  assert.equal(value, 42);
  assert.equal(calls, 1);

  let attempts = 0;
  await assert.rejects(
    runWithBusyHandling(() => {
      attempts += 1;
      throw new SyntaxError('malformed SQL');
    }, { context: 'syntax', sleep: async () => {} }),
    /malformed SQL/,
  );
  assert.equal(attempts, 1, 'a non-contention error is not retried');
});

test('runWithBusyHandling retries contention a bounded number of times, then throws SqliteContentionError', async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    runWithBusyHandling(
      () => {
        attempts += 1;
        throw { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' };
      },
      { context: 'readCheckpoint', attempts: 4, backoffMs: 10, sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SqliteContentionError);
      assert.equal(error.attempts, 4);
      assert.match(error.providerCause, /database is locked/);
      assert.match(error.message, /readCheckpoint/);
      return true;
    },
  );
  assert.equal(attempts, 4, 'exactly `attempts` tries — bounded, not unbounded');
  assert.deepEqual(sleeps, [10, 20, 30], 'a backoff between each retry but not after the last');
});

test('runWithBusyHandling recovers when contention clears within the bounded window', async () => {
  let attempts = 0;
  const value = await runWithBusyHandling(
    () => {
      attempts += 1;
      if (attempts < 3) throw { code: 'ERR_SQLITE_ERROR', errcode: 6 };
      return 'ok';
    },
    { context: 'writeCheckpoint', attempts: 5, sleep: async () => {} },
  );
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
});

// --- The SQLite metadata store under a real second connection's lock -------------------

function buildIr() {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.setSchemaVersion(2);
  const E = nodeId('entity_order');
  graph.addNode<EntityDef>({
    id: E,
    kind: 'entity',
    identityFieldId: fieldId('field_order_id'),
    fields: [
      { id: fieldId('field_order_id'), valueType: primitiveType('string') },
      { id: fieldId('field_order_status'), valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  graph.addNode({
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [],
  } as never);
  return compileToServerIR(graph, { validate: false });
}

interface RawDb {
  exec(sql: string): void;
  close(): void;
}

async function openRaw(location: string): Promise<RawDb> {
  const mod = (await import('node:sqlite')) as { DatabaseSync: new (l: string) => RawDb };
  const db = new mod.DatabaseSync(location);
  return db;
}

async function withLockedDatabase(
  run: (dbPath: string, store: Awaited<ReturnType<typeof createSqliteMigrationStore>>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-contend-'));
  const dbPath = path.join(dir, 'm.db');
  const store = await createSqliteMigrationStore({
    location: dbPath,
    now: () => 1_000,
    // Small window + no-op sleep: contention that will not clear is exhausted quickly.
    busyTimeoutMs: 30,
    sleep: async () => {},
  });
  await store.writeSchema(1, 'fp-1');
  const blocker = await openRaw(dbPath);
  blocker.exec('PRAGMA busy_timeout = 0;');
  blocker.exec('BEGIN EXCLUSIVE;');
  try {
    await run(dbPath, store);
  } finally {
    try {
      blocker.exec('ROLLBACK;');
    } catch {
      /* ignore */
    }
    blocker.close();
    (store as { database: { close(): void } }).database.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a metadata read under a foreign exclusive lock surfaces a typed SqliteContentionError', { skip: !available }, async () => {
  await withLockedDatabase(async (_dbPath, store) => {
    await assert.rejects(store.readSchema(), (error: unknown) => {
      assert.ok(error instanceof SqliteContentionError, 'a typed contention error, not a raw ERR_SQLITE_ERROR');
      assert.notEqual((error as { code?: string }).code, 'ERR_SQLITE_ERROR');
      return true;
    });
  });
});

test('evaluateSchemaGate under contention returns migration-in-progress, never a raw SQLite error (spec11.2 §33)', { skip: !available }, async () => {
  const ir = buildIr();
  await withLockedDatabase(async (_dbPath, store) => {
    const gate = await evaluateSchemaGate(ir, store);
    assert.equal(gate.status, 'migration-in-progress');
    assert.equal(gate.code, 'MIGRATION_IN_PROGRESS');
  });
});

test('getMigrationStatus under contention returns a coherent in-progress status, never throws (spec11.2 §32)', { skip: !available }, async () => {
  await withLockedDatabase(async (_dbPath, store) => {
    const status = await getMigrationStatus(store);
    assert.equal(status.phase, 'in-progress');
    // Host inspection stays usable — the call resolved rather than throwing a provider error.
  });
});

test('classifyMigrationContention: a lease-holder blocked by an unrelated writer is MIGRATION_FAILED, not IN_PROGRESS (spec11.2 §35)', { skip: !available }, async () => {
  await withLockedDatabase(async (_dbPath, store) => {
    // This runner validly owns the migration lease...
    const acquired = await store.acquireLock('owner', 60_000).catch(() => null);
    // ...but the lease row could not be written because a foreign EXCLUSIVE lock is held, so
    // acquireLock itself contends. Either way, simulate "I hold token T" and unrelated
    // contention: classify must not claim another migration owns it.
    const ownToken = acquired && acquired.ok ? acquired.lock?.token : 'owner-token';
    const resolution = await classifyMigrationContention(
      store,
      2,
      ownToken,
      new SqliteContentionError({ code: 'ERR_SQLITE_ERROR', errcode: 5 }, 'writeCheckpoint', 4),
    );
    assert.equal(resolution.kind, 'failed', 'unrelated contention while owning the lease is a real failure');
    assert.match((resolution as { message: string }).message, /lease/i);
  });
});

test('classifyMigrationContention: no lease of our own + unobservable metadata is MIGRATION_IN_PROGRESS (spec11.2 §8)', { skip: !available }, async () => {
  await withLockedDatabase(async (_dbPath, store) => {
    const resolution = await classifyMigrationContention(
      store,
      2,
      undefined,
      new SqliteContentionError({ code: 'ERR_SQLITE_ERROR', errcode: 5 }, 'readSchema', 4),
    );
    assert.equal(resolution.kind, 'in-progress');
  });
});
