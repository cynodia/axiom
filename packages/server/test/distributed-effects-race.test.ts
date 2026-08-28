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
 * Spec12 §17, §66, §83: the distributed outbox proved with **real OS processes** sharing one
 * SQLite pair — never `Promise.all` or a mocked lease.
 *
 * - N authorities each dispatch + poll the same committed effect intent → the adapter's
 *   physical side effect happens once, exactly one authority records the terminal (§17).
 * - An authority is `SIGKILL`ed mid-attempt → another reclaims the logical effect and
 *   durably completes it; the side effect is delivered at least once, the completion exactly
 *   once (§15, §66).
 */

const available = await isSqliteDurableWorkAvailable();
const WORKER = fileURLToPath(new URL('./helpers/distributed-effects-race-worker.js', import.meta.url));
const AUTHORITIES = Math.max(2, Number(process.env.AXIOM_AUTHORITIES ?? 4));

interface RunLine {
  instanceId: string;
  terminals: number;
  finalState: string | null;
  uncertainAttempts: number;
  calls: number;
  thrown?: boolean;
  errorCode?: string;
}

function paths(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    coordDb: path.join(dir, 'coord.db'),
    workDb: path.join(dir, 'work.db'),
    ledger: path.join(dir, 'side-effects.log'),
  };
}

function forkWorker(args: string[]): Promise<{ out: string; code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => (out += String(c)));
    child.stderr?.on('data', (c) => (err += String(c)));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (err.includes('ERR_SQLITE_ERROR')) {
        reject(new Error(`worker crashed: ${err.slice(0, 300)}`));
        return;
      }
      resolve({ out: out.trim(), code, signal });
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
  `spec12 §17: ${AUTHORITIES} OS processes dispatch+poll one effect — one physical execution, one terminal`,
  { skip: !available },
  async () => {
    const { dir, coordDb, workDb, ledger } = paths('axiom-dfx-race-');
    try {
      writeFileSync(ledger, '');
      const seeded = await forkWorker([coordDb, workDb, ledger, 'seed', 'seeder']);
      assert.equal(seeded.out, 'ok', 'the effect intent was seeded');

      const results = await Promise.all(
        Array.from({ length: AUTHORITIES }, (_, i) =>
          forkWorker([coordDb, workDb, ledger, 'run', `auth-${i}`]),
        ),
      );
      const lines = results.map((r) => JSON.parse(r.out) as RunLine);
      const label = JSON.stringify(lines);

      for (const line of lines) {
        assert.notEqual(line.thrown ?? false, true, `${label} — a worker threw`);
      }
      assert.deepEqual(ledgerLines(ledger), ['e-cross'], `${label} — exactly one physical execution`);
      assert.equal(
        lines.reduce((n, l) => n + l.terminals, 0),
        1,
        `${label} — exactly one authority recorded the terminal transition`,
      );
      assert.ok(
        lines.every((l) => l.finalState === 'succeeded'),
        `${label} — every authority observes the durable succeeded state`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'spec12 §66: SIGKILL an authority mid-attempt — another reclaims and completes the effect exactly once',
  { skip: !available },
  async () => {
    const { dir, coordDb, workDb, ledger } = paths('axiom-dfx-kill-');
    let victim: ChildProcess | undefined;
    try {
      writeFileSync(ledger, '');
      const seeded = await forkWorker([coordDb, workDb, ledger, 'seed', 'seeder']);
      assert.equal(seeded.out, 'ok');

      // A slow-adapter worker with a short lease: it will claim, start the (4s) attempt, and
      // be killed before it can finish or renew.
      const victimDone = new Promise<void>((resolve) => {
        victim = fork(WORKER, [coordDb, workDb, ledger, 'run-slow', 'victim', '800'], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        victim.on('exit', () => resolve());
      });
      await new Promise((r) => setTimeout(r, 700)); // let it claim and enter the adapter call
      victim?.kill('SIGKILL');
      await victimDone;
      await new Promise((r) => setTimeout(r, 400)); // let the 800ms lease lapse

      const recovered = await forkWorker([coordDb, workDb, ledger, 'run', 'reclaimer', '30000']);
      const line = JSON.parse(recovered.out) as RunLine;

      assert.equal(line.thrown ?? false, false);
      assert.equal(line.finalState, 'succeeded', 'the reclaimer durably completed the effect');
      assert.equal(line.terminals, 1, 'the reclaimer recorded exactly one terminal transition');
      assert.ok(
        line.uncertainAttempts >= 1,
        'the reclaim of an in-flight attempt is recorded as an uncertain outcome (spec12 §70)',
      );
      assert.ok(
        ledgerLines(ledger).length >= 1,
        'the side effect was delivered at least once (at-least-once physical execution)',
      );
      assert.ok(
        ledgerLines(ledger).every((l) => l === 'e-cross'),
        'every physical execution used the logical effect id as the idempotency key',
      );
    } finally {
      victim?.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
