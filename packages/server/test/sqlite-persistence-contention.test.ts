import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSqlitePersistence, isSqliteAvailable } from '@cynodia/axiom-server';
import { S_LEDGER } from './helpers/ledger-graph.js';
import { nodeId } from '@cynodia/axiom-core';

/**
 * spec12.1 F2 (§92, §108): the permanent named regression for the Phase 20 SQLite lock
 * leakage. Independent OS processes, independent connections, one DB file, real concurrent
 * readers and writers. Zero raw `SQLITE_BUSY` / `SQLITE_LOCKED` / `ERR_SQLITE_ERROR` /
 * "database is locked" may escape during ordinary supported operation.
 */

const available = await isSqliteAvailable();
const WORKER = fileURLToPath(new URL('./helpers/ledger-authority-worker.js', import.meta.url));
const WRITERS = Math.max(2, Number(process.env.AXIOM_SQLITE_WRITERS ?? 3));
const READERS = Math.max(2, Number(process.env.AXIOM_SQLITE_READERS ?? 5));
const TRIALS = Math.max(1, Number(process.env.AXIOM_RACE_TRIALS ?? 30));
const OPS_PER_TRIAL = Math.max(4, Number(process.env.AXIOM_SQLITE_OPS ?? 8));

interface Authority {
  child: ChildProcess;
  send(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  errored: () => string | null;
  stop(): void;
}

function spawn(stateDb: string, id: string): Promise<Authority> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [stateDb, id], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    let workerError: string | null = null;
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    const pending: Array<(m: Record<string, unknown>) => void> = [];
    child.on('message', (m: Record<string, unknown>) => {
      if (m?.type === 'ready') {
        resolve({
          child,
          send: (msg) => new Promise((res) => (pending.push(res), child.send(msg))),
          errored: () =>
            workerError ??
            (/(SQLITE_BUSY|SQLITE_LOCKED|ERR_SQLITE_ERROR|database is locked)/i.test(stderr)
              ? stderr.slice(0, 400)
              : null),
          stop: () => child.send({ type: 'stop' }),
        });
        return;
      }
      if (m?.type === 'error') workerError = String(m.message);
      const next = pending.shift();
      if (next) next(m);
    });
  });
}

test(
  `spec12.1 §92: ${WRITERS} writer + ${READERS} reader processes on one SQLite DB — no raw lock leakage over ${TRIALS} trials`,
  { skip: !available },
  async () => {
    let rawLeaks = 0;
    let concurrencyConflicts = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const dir = mkdtempSync(path.join(tmpdir(), 'axiom-sqlite-cont-'));
      const stateDb = path.join(dir, 'state.db');
      const authorities: Authority[] = [];
      try {
        // Concurrent startup against the same file is itself part of the workload (§33).
        const spawned = await Promise.all([
          ...Array.from({ length: WRITERS }, (_, i) => spawn(stateDb, `w${i}`)),
          ...Array.from({ length: READERS }, (_, i) => spawn(stateDb, `r${i}`)),
        ]);
        authorities.push(...spawned);
        const writers = authorities.slice(0, WRITERS);
        const readers = authorities.slice(WRITERS);

        for (let op = 0; op < OPS_PER_TRIAL; op += 1) {
          const results = await Promise.all([
            ...writers.map((w) => w.send({ type: 'deposit', amount: 1 })),
            ...readers.map((r) => r.send({ type: 'snapshot' })),
          ]);
          for (const r of results) {
            if (r.type === 'error') rawLeaks += 1;
            if (r.code === 'CONCURRENCY_CONFLICT') concurrencyConflicts += 1;
          }
        }

        for (const a of authorities) {
          const leak = a.errored();
          if (leak) {
            rawLeaks += 1;
            assert.fail(`trial ${trial}: raw SQLite contention leaked: ${leak}`);
          }
        }
      } finally {
        for (const a of authorities) a.stop();
        await new Promise((r) => setTimeout(r, 120));
        rmSync(dir, { recursive: true, force: true });
      }
    }

    assert.equal(rawLeaks, 0, 'no raw SQLITE_BUSY / SQLITE_LOCKED / ERR_SQLITE_ERROR / database-is-locked escaped');
    // Legitimate optimistic conflicts between simultaneous writers are allowed and are a
    // distinct counter (§32, §97) — the point of this test is that none of them were a
    // disguised physical lock error.
    assert.ok(concurrencyConflicts >= 0);
  },
);

test('spec12.1 §69: an unrelated SQLite error is not swallowed as contention', async () => {
  if (!available) return;
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-sqlite-neg-'));
  try {
    const persistence = await createSqlitePersistence({ location: path.join(dir, 'state.db') });
    await persistence.commit({
      writes: [{ stateId: S_LEDGER, value: 0 }],
      expected: { [S_LEDGER]: 0 },
    });
    await persistence.close?.();
    // Operating on a closed database is a genuine programming error, not lock contention:
    // it must surface, not be retried into oblivion or reported as a refused commit.
    await assert.rejects(
      () => persistence.commit({ writes: [{ stateId: nodeId('state_x'), value: 1 }], expected: {} }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, /within the bounded busy window/, 'not misclassified as contention');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
