import { createSqliteMigrationStore, createSqliteRowStore, executeMigration, migrationAuthority } from '@cynodia/axiom-server';
import { buildRaceIr } from './migration-race.js';
import type { RaceWorkerResult } from './migration-race.js';

/**
 * One racer in the D-4 cross-process test (spec11.2 §27). Run as its own OS process:
 *
 *   node migration-race-worker.js <dbPath> <startAtEpochMs>
 *
 * It opens the shared on-disk database with its **own** SQLite connection, mints its **own**
 * `migrationAuthority` capability, busy-waits until the shared start instant so both racers
 * enter `executeMigration` as close together as practical, runs the migration, and prints a
 * single JSON {@link RaceWorkerResult} line to stdout. It must never let a `SQLITE_BUSY` /
 * `ERR_SQLITE_ERROR` escape.
 */
async function main(): Promise<void> {
  const dbPath = process.argv[2];
  const startAt = Number(process.argv[3] ?? 0);
  if (!dbPath) {
    process.stdout.write(JSON.stringify({ ok: false, thrown: true, errorName: 'Usage', message: 'missing dbPath' }));
    process.exit(2);
  }

  const ir = buildRaceIr();
  const meta = await createSqliteMigrationStore({ location: dbPath });
  const database = (meta as { database: { close(): void } }).database;
  const rows = await createSqliteRowStore({ location: dbPath, ir, database });

  while (Date.now() < startAt) {
    // tight spin to align both processes on the same instant
  }

  let out: RaceWorkerResult;
  try {
    const result = await executeMigration({
      ir,
      metadata: meta,
      rows,
      principal: migrationAuthority(`race-pid-${process.pid}`),
      batchSize: 7,
    });
    out = result.ok
      ? {
          ok: true,
          phase: result.run.phase,
          alreadyAtTarget: result.run.alreadyAtTarget,
          rowsTransformed: result.run.rowsTransformed,
        }
      : { ok: false, code: result.code, message: result.message };
  } catch (error) {
    const structured = error as { name?: string; code?: string; errcode?: number; message?: string };
    out = {
      ok: false,
      thrown: true,
      errorName: structured?.name,
      errorCode: structured?.code,
      errcode: structured?.errcode,
      message: structured?.message,
    };
  } finally {
    try {
      database.close();
    } catch {
      /* already closed */
    }
  }
  process.stdout.write(JSON.stringify(out));
}

void main();
