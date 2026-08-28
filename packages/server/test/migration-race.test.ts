import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isSqliteMigrationAvailable } from '@cynodia/axiom-server';
import {
  RACE_ROW_COUNT,
  expectedN,
  inspectRaceDatabase,
  seedRaceDatabase,
} from './helpers/migration-race.js';
import type { RaceWorkerResult } from './helpers/migration-race.js';

/**
 * D-4 (spec11.2 §4, §27-30, §55): two independent OS processes race `executeMigration` on
 * the same SQLite database. Ordinary physical lock contention must resolve to an Axiom
 * semantic outcome — never a leaked `SQLITE_BUSY` / `ERR_SQLITE_ERROR` — and the
 * non-idempotent `n := n + 1` transition must run exactly once.
 *
 * This is a **real process-level** test (spec11.2 §55): it must not be replaced with an
 * in-process approximation. Trials default to 25 (`AXIOM_RACE_TRIALS` overrides, e.g. 50
 * for the pre-release run).
 */

const available = await isSqliteMigrationAvailable();
const WORKER = fileURLToPath(new URL('./helpers/migration-race-worker.js', import.meta.url));
const TRIALS = Math.max(1, Number(process.env.AXIOM_RACE_TRIALS ?? 25));

function runWorker(dbPath: string, startAt: number): Promise<RaceWorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [dbPath, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          resolve(JSON.parse(trimmed) as RaceWorkerResult);
          return;
        } catch {
          /* fall through to the error below */
        }
      }
      reject(
        new Error(`race worker exited ${code} with no parseable result. stdout=${stdout} stderr=${stderr}`),
      );
    });
  });
}

const ALLOWED_LOSER_CODES = new Set(['MIGRATION_IN_PROGRESS']);

test(
  'D-4: two OS processes racing executeMigration on SQLite never leak SQLITE_BUSY and never execute the transition twice',
  { skip: !available },
  async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const dir = mkdtempSync(path.join(tmpdir(), 'axiom-race-'));
      const dbPath = path.join(dir, 'race.db');
      try {
        await seedRaceDatabase(dbPath);

        const startAt = Date.now() + 60;
        const [a, b] = await Promise.all([runWorker(dbPath, startAt), runWorker(dbPath, startAt)]);
        const label = `trial ${trial}: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`;

        // (spec11.2 §29) Neither process may leak a provider-native error or throw.
        for (const result of [a, b]) {
          assert.equal(result.thrown ?? false, false, `${label} — a worker threw`);
          assert.notEqual(result.errorCode, 'ERR_SQLITE_ERROR', `${label} — raw SQLite error leaked`);
          if (result.ok) {
            assert.equal(result.phase, 'completed', `${label} — unexpected ok phase`);
          } else {
            assert.ok(
              ALLOWED_LOSER_CODES.has(result.code ?? ''),
              `${label} — loser code ${result.code} is not an allowed contention outcome`,
            );
          }
        }

        // (spec11.2 §29, §30) Exactly one semantic completion of the transition; the other
        // process either observed the lock (MIGRATION_IN_PROGRESS) or the finished schema
        // (alreadyAtTarget).
        const completions = [a, b].filter((r) => r.ok && r.alreadyAtTarget === false).length;
        const alreadyAtTarget = [a, b].filter((r) => r.ok && r.alreadyAtTarget === true).length;
        const inProgress = [a, b].filter((r) => !r.ok && r.code === 'MIGRATION_IN_PROGRESS').length;
        assert.equal(completions, 1, `${label} — expected exactly one completion`);
        assert.equal(completions + alreadyAtTarget + inProgress, 2, `${label} — unaccounted result`);

        // (spec11.2 §30) Final data: every row incremented exactly once, one history entry,
        // target version committed, no lock, no stale checkpoint.
        const state = await inspectRaceDatabase(dbPath);
        assert.equal(state.rowCount, RACE_ROW_COUNT, `${label} — row count changed`);
        state.ns.forEach((n, index) => {
          assert.equal(n, expectedN(index), `${label} — row ${index} n=${n}, expected ${expectedN(index)} (never +2)`);
        });
        assert.equal(state.schemaVersion, 2, `${label} — schema version not committed`);
        assert.equal(state.historyLength, 1, `${label} — duplicate / missing history entry`);
        assert.equal(state.lockHeld, false, `${label} — migration lock left held`);
        assert.equal(state.checkpointPresent, false, `${label} — stale checkpoint left behind`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
