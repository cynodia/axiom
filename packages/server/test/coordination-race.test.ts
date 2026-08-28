import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSqliteCoordinationProvider,
  isSqliteCoordinationAvailable,
} from '@cynodia/axiom-server';

/**
 * Spec12 §67, §68, §71, §83: coordination guarantees proved with **real OS processes** on
 * one shared SQLite file — never `Promise.all` or a mocked lease.
 *
 * - N authorities race one `acquire`: exactly one wins, at `generation` 1 (§71, §50).
 * - An owner is `SIGKILL`ed without cleanup: its lease expires, another authority reclaims
 *   under `generation` 2, and the killed owner's identity is `fenced` (§67).
 * - A paused owner resumes after reclaim and attempts `renew` + ownership check: both
 *   report it is no longer current — a stale owner cannot regain ownership (§68,
 *   release-blocking at the completion layer, proved here at the lease layer).
 */

const available = await isSqliteCoordinationAvailable();
const WORKER = fileURLToPath(new URL('./helpers/coordination-race-worker.js', import.meta.url));
// Four real processes is enough to prove the semantics; the dedicated 8-authority chaos run
// is Phase 16 (spec12 §81) and raises these via env.
const AUTHORITIES = Math.max(2, Number(process.env.AXIOM_AUTHORITIES ?? 4));
const TRIALS = Math.max(1, Number(process.env.AXIOM_RACE_TRIALS ?? 5));

interface RaceLine {
  ownerId: string;
  ok: boolean;
  generation: number | null;
  heldBy: string | null;
  thrown?: boolean;
  errorCode?: string;
}

function spawnRacer(dbPath: string, ownerId: string, barrierAt: number, leaseMs: number): Promise<RaceLine | null> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [dbPath, 'race', ownerId, String(barrierAt), String(leaseMs)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += String(c)));
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        // A peer killed by the OS scheduler under load before it produced output did not
        // participate — the caller retries it. A genuine crash (stderr, ERR_SQLITE_ERROR)
        // is surfaced instead.
        if (stderr.includes('ERR_SQLITE_ERROR') || stderr.includes('SqliteContention')) {
          reject(new Error(`racer ${ownerId} crashed (code=${code} signal=${signal}): ${stderr.slice(0, 400)}`));
          return;
        }
        resolve(null);
        return;
      }
      resolve(JSON.parse(trimmed) as RaceLine);
    });
  });
}

async function runRacer(dbPath: string, ownerId: string, barrierAt: number, leaseMs: number): Promise<RaceLine> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const line = await spawnRacer(dbPath, ownerId, attempt === 0 ? barrierAt : Date.now() + 40, leaseMs);
    if (line) return line;
  }
  throw new Error(`racer ${ownerId} produced no output across 3 attempts`);
}

test(
  `spec12 §71: ${AUTHORITIES} OS processes race one acquire — exactly one winner, no leaked SQLITE_BUSY`,
  { skip: !available },
  async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const dir = mkdtempSync(path.join(tmpdir(), 'axiom-coord-race-'));
      const dbPath = path.join(dir, 'coord.db');
      try {
        // Materialize the schema before the racers open their own connections.
        const seed = await createSqliteCoordinationProvider({ location: dbPath });
        await seed.close?.();

        const barrierAt = Date.now() + 80;
        const lines = await Promise.all(
          Array.from({ length: AUTHORITIES }, (_, i) => runRacer(dbPath, `auth-${i}`, barrierAt, 30_000)),
        );
        const label = `trial ${trial}: ${JSON.stringify(lines)}`;

        for (const line of lines) {
          assert.notEqual(line.thrown ?? false, true, `${label} — a racer threw`);
          assert.notEqual(line.errorCode, 'ERR_SQLITE_ERROR', `${label} — raw SQLite error leaked`);
        }

        // Ground truth is the database, not the self-reports: exactly one holder, at
        // generation 1. (A racer can in principle die between COMMIT and stdout and then, on
        // its retry, observe its own prior claim — so the durable row is the authority.)
        const observer = await createSqliteCoordinationProvider({ location: dbPath });
        const holder = await observer.inspect('effect:contended');
        await observer.close?.();
        assert.ok(holder, `${label} — exactly one authority holds the resource`);
        assert.equal(holder.generation, 1, `${label} — the sole claim is generation 1`);

        const winners = lines.filter((l) => l.ok);
        assert.ok(winners.length <= 1, `${label} — at most one self-reported winner`);
        if (winners.length === 1) {
          assert.equal(winners[0]?.ownerId, holder.ownerId, `${label} — the winner is the durable holder`);
          assert.equal(winners[0]?.generation, 1, `${label} — winner is generation 1`);
        }
        for (const loser of lines.filter((l) => !l.ok && l.heldBy)) {
          assert.equal(loser.heldBy, holder.ownerId, `${label} — every loser saw the durable holder`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

test(
  'spec12 §67-§68: SIGKILL a lease holder — another authority reclaims (generation 2) and the killed/stale owner is fenced',
  { skip: !available },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-coord-kill-'));
    const dbPath = path.join(dir, 'coord.db');
    let victim: ChildProcess | undefined;
    let paused: ChildProcess | undefined;
    try {
      const seed = await createSqliteCoordinationProvider({ location: dbPath });
      await seed.close?.();

      // ---- §67: hard-kill a holder, prove reclaim + fencing ---------------------------
      const killLeaseMs = 600;
      const acquired = await new Promise<{ token: string | null; generation: number | null }>((resolve, reject) => {
        victim = fork(WORKER, [dbPath, 'hold', 'victim', String(Date.now()), String(killLeaseMs)], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        victim.on('error', reject);
        victim.on('message', (m: { type?: string; ok?: boolean; token?: string | null; generation?: number | null }) => {
          if (m?.type === 'acquired') resolve({ token: m.token ?? null, generation: m.generation ?? null });
        });
      });
      assert.equal(acquired.generation, 1, 'victim holds generation 1');

      victim?.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, killLeaseMs + 300)); // let the lease lapse

      const reclaimer = await createSqliteCoordinationProvider({ location: dbPath });
      const reclaimed = await reclaimer.acquire('effect:contended', 'reclaimer', 30_000);
      assert.ok(reclaimed.ok && reclaimed.lease, 'a healthy authority reclaims the abandoned lease');
      assert.equal(reclaimed.lease.generation, 2, 'reclaim mints generation 2');

      const victimNow = await reclaimer.checkOwnership('effect:contended', 'victim', 1);
      assert.equal(victimNow.current, false);
      assert.equal(victimNow.reason, 'fenced', 'the killed owner is fenced, not merely expired');
      await reclaimer.close?.();
      rmSync(dir, { recursive: true, force: true });

      // ---- §68: a paused owner resumes after reclaim and cannot regain ownership ------
      const dir2 = mkdtempSync(path.join(tmpdir(), 'axiom-coord-stale-'));
      const dbPath2 = path.join(dir2, 'coord.db');
      try {
        const seed2 = await createSqliteCoordinationProvider({ location: dbPath2 });
        await seed2.close?.();

        const probe = await new Promise<{ renewed: boolean; current: boolean; reason: string | null }>((resolve, reject) => {
          paused = fork(WORKER, [dbPath2, 'hold', 'A', String(Date.now()), '500'], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          });
          paused.on('error', reject);
          paused.on('message', async (m: { type?: string; generation?: number | null }) => {
            if (m?.type === 'acquired') {
              // Let A's 500ms lease lapse, then B reclaims out-of-process.
              await new Promise((r) => setTimeout(r, 800));
              const b = await createSqliteCoordinationProvider({ location: dbPath2 });
              const bClaim = await b.acquire('effect:contended', 'B', 30_000);
              assert.ok(bClaim.ok && bClaim.lease && bClaim.lease.generation === 2);
              await b.close?.();
              // Now tell A to wake up and try to act on its old claim.
              paused?.send({ type: 'probe' });
            }
            if (m?.type === 'probed') {
              resolve({ renewed: Boolean((m as { renewed?: boolean }).renewed), current: Boolean((m as { current?: boolean }).current), reason: (m as { reason?: string | null }).reason ?? null });
            }
          });
        });

        assert.equal(probe.renewed, false, '§68 — a stale owner cannot renew');
        assert.equal(probe.current, false, '§68 — a stale owner is not current');
        assert.equal(probe.reason, 'fenced', '§68 — the reason is fencing, not expiry');
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      victim?.kill('SIGKILL');
      paused?.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
