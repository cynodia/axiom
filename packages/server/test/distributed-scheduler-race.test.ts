import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isSqliteDurableWorkAvailable } from '@cynodia/axiom-server';

/**
 * Spec12 §21, §71, §72, §83: the distributed scheduler proved with **real OS processes**.
 *
 * - N authorities observe one due firing → the scheduled side effect happens once; exactly
 *   one authority records the firing (§21, §71).
 * - An owner is `SIGKILL`ed mid-firing → another authority reclaims the **same** logical
 *   firing id and completes it; no second firing identity is created (§72).
 */

const available = await isSqliteDurableWorkAvailable();
const WORKER = fileURLToPath(new URL('./helpers/distributed-scheduler-race-worker.js', import.meta.url));
const AUTHORITIES = Math.max(3, Number(process.env.AXIOM_AUTHORITIES ?? 4));
const NOW_MS = 5_000; // an everyMs=1000 boundary → firing trg@5000

interface RunLine {
  instanceId: string;
  fired: number;
  finalState: string | null;
  attemptNumber: number;
  uncertainAttempts: number;
  thrown?: boolean;
}

function paths(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    coordDb: path.join(dir, 'coord.db'),
    workDb: path.join(dir, 'work.db'),
    ledger: path.join(dir, 'firings.log'),
  };
}

function forkWorker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => (out += String(c)));
    child.stderr?.on('data', (c) => (err += String(c)));
    child.on('error', reject);
    child.on('exit', () => {
      if (err.includes('ERR_SQLITE_ERROR')) reject(new Error(`worker crashed: ${err.slice(0, 300)}`));
      else resolve(out.trim());
    });
  });
}

function ledgerLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test(
  `spec12 §71: ${AUTHORITIES} OS processes observe one due firing — one side effect, one firing record`,
  { skip: !available },
  async () => {
    const { dir, coordDb, workDb, ledger } = paths('axiom-sched-race-');
    try {
      writeFileSync(ledger, '');
      const lines = (
        await Promise.all(
          Array.from({ length: AUTHORITIES }, (_, i) =>
            forkWorker([coordDb, workDb, ledger, 'run', `auth-${i}`, String(NOW_MS)]),
          ),
        )
      ).map((s) => JSON.parse(s) as RunLine);
      const label = JSON.stringify(lines);

      for (const line of lines) assert.notEqual(line.thrown ?? false, true, `${label} — a worker threw`);
      assert.deepEqual(ledgerLines(ledger), ['5000'], `${label} — the firing's side effect happened once`);
      assert.equal(
        lines.reduce((n, l) => n + l.fired, 0),
        1,
        `${label} — exactly one authority recorded the firing`,
      );
      assert.ok(lines.every((l) => l.finalState === 'succeeded'), `${label} — all observe the succeeded firing`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'spec12 §72: SIGKILL a firing owner — another authority reclaims the same firing id, no second identity',
  { skip: !available },
  async () => {
    const { dir, coordDb, workDb, ledger } = paths('axiom-sched-kill-');
    let victim: ChildProcess | undefined;
    try {
      writeFileSync(ledger, '');
      const victimDone = new Promise<void>((resolve) => {
        victim = fork(WORKER, [coordDb, workDb, ledger, 'run-slow', 'victim', String(NOW_MS), '800'], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        victim.on('exit', () => resolve());
      });
      await new Promise((r) => setTimeout(r, 700)); // let it claim trg@5000 and enter the (slow) firing
      victim?.kill('SIGKILL');
      await victimDone;
      await new Promise((r) => setTimeout(r, 400)); // 800ms lease lapses

      const recovered = JSON.parse(
        await forkWorker([coordDb, workDb, ledger, 'run', 'reclaimer', String(NOW_MS), '30000']),
      ) as RunLine;

      assert.equal(recovered.thrown ?? false, false);
      assert.equal(recovered.finalState, 'succeeded', 'the reclaimer completed the firing');
      assert.equal(recovered.fired, 1, 'the reclaimer recorded exactly one firing');
      assert.ok(recovered.attemptNumber >= 2, 'the same firing id carried a second attempt');
      assert.ok(recovered.uncertainAttempts >= 1, 'the interrupted attempt is recorded uncertain');
      assert.ok(ledgerLines(ledger).every((l) => l === '5000'), 'every side effect was for the one firing id');
    } finally {
      victim?.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
