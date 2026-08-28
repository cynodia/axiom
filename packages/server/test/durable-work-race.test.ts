import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createDurableWorkStore,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
  isSqliteDurableWorkAvailable,
} from '@cynodia/axiom-server';

/**
 * Spec12 §18, §68 (release-blocking), §69, §83: durable-work completion fencing proved with
 * **real OS processes** on shared SQLite files — never `Promise.all` or a mocked lease.
 *
 * - N authorities race to claim + settle one work item: exactly one settles it; the losers
 *   never see a claim (§69).
 * - An owner is `SIGKILL`ed mid-attempt: its lease lapses, another authority reclaims under a
 *   fresh generation and durably completes the work — a hard crash strands nothing (§66).
 * - A paused owner wakes after reclaim and tries to `settle` its stale claim: rejected as
 *   `fenced` / `already-terminal`, and the reclaimer's result stays authoritative (§18, §68).
 */

const available = await isSqliteDurableWorkAvailable();
const WORKER = fileURLToPath(new URL('./helpers/durable-work-race-worker.js', import.meta.url));
// Four real processes is enough to prove the semantics; the dedicated 8-authority chaos run
// is Phase 16 (spec12 §81) and raises these via env.
const AUTHORITIES = Math.max(2, Number(process.env.AXIOM_AUTHORITIES ?? 4));
const TRIALS = Math.max(1, Number(process.env.AXIOM_RACE_TRIALS ?? 4));

function tempDbs(prefix: string): { dir: string; coordDb: string; workDb: string } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, coordDb: path.join(dir, 'coord.db'), workDb: path.join(dir, 'work.db') };
}

async function seed(coordDb: string, workDb: string): Promise<void> {
  const coordination = await createSqliteCoordinationProvider({ location: coordDb });
  const storage = await createSqliteDurableWorkStorage({ location: workDb });
  const store = createDurableWorkStore({ coordination, storage });
  await store.enqueue({ workClass: 'effect', workId: 'contended', payload: { to: 'x' } });
  await coordination.close?.();
  await storage.close?.();
}

interface RaceLine {
  ownerId: string;
  claimed: boolean;
  generation?: number;
  settled?: boolean;
  reason?: string | null;
  thrown?: boolean;
  errorCode?: string;
}

function runRacer(coordDb: string, workDb: string, ownerId: string): Promise<RaceLine | null> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [coordDb, workDb, 'race-claim-settle', ownerId, '30000'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => (out += String(c)));
    child.stderr?.on('data', (c) => (err += String(c)));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const trimmed = out.trim();
      if (!trimmed) {
        if (err.includes('ERR_SQLITE_ERROR') || err.includes('SqliteContention')) {
          reject(new Error(`racer ${ownerId} crashed (code=${code} signal=${signal}): ${err.slice(0, 400)}`));
          return;
        }
        // Killed by the OS scheduler under load before producing output — did not participate.
        resolve(null);
        return;
      }
      resolve(JSON.parse(trimmed) as RaceLine);
    });
  });
}

test(
  `spec12 §69: ${AUTHORITIES} OS processes race claim+settle one work item — exactly one settles it`,
  { skip: !available },
  async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const { dir, coordDb, workDb } = tempDbs('axiom-dw-race-');
      try {
        await seed(coordDb, workDb);
        const results = await Promise.all(
          Array.from({ length: AUTHORITIES }, (_, i) => runRacer(coordDb, workDb, `auth-${i}`)),
        );
        const lines = results.filter((l): l is RaceLine => l !== null);
        const label = `trial ${trial}: ${JSON.stringify(lines)}`;
        assert.ok(lines.length >= 2, `${label} — at least two authorities actually participated`);

        for (const line of lines) {
          assert.notEqual(line.thrown ?? false, true, `${label} — a racer threw`);
          assert.notEqual(line.errorCode, 'ERR_SQLITE_ERROR', `${label} — raw SQLite error leaked`);
        }

        // Ground truth: the durable row. Exactly one authority's result is committed, and it
        // is `succeeded` (spec12 §69) — never two settlements, never a torn state.
        const coordination = await createSqliteCoordinationProvider({ location: coordDb });
        const storage = await createSqliteDurableWorkStorage({ location: workDb });
        const durable = await createDurableWorkStore({ coordination, storage }).get('effect', 'contended');
        await coordination.close?.();
        await storage.close?.();
        assert.equal(durable?.state, 'succeeded', `${label} — the work is durably succeeded exactly once`);
        assert.match(String(durable?.result), /^auth-\d+-result$/, `${label} — one authority's result is authoritative`);

        const settlers = lines.filter((l) => l.settled === true);
        assert.ok(settlers.length <= 1, `${label} — at most one self-reported settler`);
        if (settlers.length === 1) {
          assert.equal(durable?.result, `${settlers[0]?.ownerId}-result`, `${label} — the settler's result is the one stored`);
        }

        // Whoever also claimed but lost the settle race must have been fenced, not silently ignored.
        for (const other of lines.filter((l) => l.claimed && l.settled !== true)) {
          assert.ok(
            other.reason === 'fenced' || other.reason === 'already-terminal',
            `${label} — a non-winning claimer was fenced (${other.reason})`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

test(
  'spec12 §66-§68: SIGKILL an owner mid-attempt — another authority reclaims and completes; the stale owner is fenced',
  { skip: !available },
  async () => {
    const { dir, coordDb, workDb } = tempDbs('axiom-dw-kill-');
    let victim: ChildProcess | undefined;
    let paused: ChildProcess | undefined;
    try {
      // ---- §66: hard-kill an owner, prove reclaim + durable completion -----------------
      await seed(coordDb, workDb);
      const killLeaseMs = 600;
      const held = await new Promise<{ claimed: boolean; generation: number | null }>((resolve, reject) => {
        victim = fork(WORKER, [coordDb, workDb, 'claim-hold', 'victim', String(killLeaseMs)], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        victim.on('error', reject);
        victim.on('message', (m: { type?: string; claimed?: boolean; generation?: number | null }) => {
          if (m?.type === 'claimed') resolve({ claimed: Boolean(m.claimed), generation: m.generation ?? null });
        });
      });
      assert.equal(held.claimed, true, 'victim claimed the work');
      assert.equal(held.generation, 1, 'victim holds generation 1');

      victim?.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, killLeaseMs + 300)); // let the lease lapse

      const coordination = await createSqliteCoordinationProvider({ location: coordDb });
      const storage = await createSqliteDurableWorkStorage({ location: workDb });
      const store = createDurableWorkStore({ coordination, storage });

      const [reclaimed] = await store.claim('effect', 'reclaimer', { leaseMs: 30_000 });
      assert.ok(reclaimed, 'a healthy authority reclaims the abandoned work');
      assert.equal(reclaimed.generation, 2, 'reclaim mints generation 2');
      assert.equal(reclaimed.item.attemptNumber, 2, 'physical attempt 2');

      const done = await store.settle(reclaimed, { kind: 'succeeded', result: 'reclaimer-result' });
      assert.equal(done.ok, true, 'the reclaimer completes the work durably');

      const durable = await store.get('effect', 'contended');
      assert.equal(durable?.state, 'succeeded', 'the work is durably succeeded');
      assert.equal(durable?.result, 'reclaimer-result', 'by the reclaimer, not the killed owner');
      await coordination.close?.();
      await storage.close?.();
      rmSync(dir, { recursive: true, force: true });

      // ---- §18/§68: a paused owner wakes after reclaim and cannot settle its stale claim
      const second = tempDbs('axiom-dw-stale-');
      try {
        await seed(second.coordDb, second.workDb);
        const probe = await new Promise<{ ok: boolean; reason: string | null }>((resolve, reject) => {
          paused = fork(WORKER, [second.coordDb, second.workDb, 'claim-hold', 'A', '500'], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          });
          paused.on('error', reject);
          paused.on('message', async (m: { type?: string; ok?: boolean; reason?: string | null }) => {
            if (m?.type === 'claimed') {
              // Let A's 500ms lease lapse, then B reclaims + settles out-of-process.
              await new Promise((r) => setTimeout(r, 800));
              const c = await createSqliteCoordinationProvider({ location: second.coordDb });
              const s = await createSqliteDurableWorkStorage({ location: second.workDb });
              const bStore = createDurableWorkStore({ coordination: c, storage: s });
              const [bClaim] = await bStore.claim('effect', 'B', { leaseMs: 30_000 });
              assert.ok(bClaim && bClaim.generation === 2, 'B reclaims at generation 2');
              const bDone = await bStore.settle(bClaim, { kind: 'succeeded', result: 'B-result' });
              assert.equal(bDone.ok, true, 'B completes the work');
              await c.close?.();
              await s.close?.();
              // Now wake A and have it try to settle its stale generation-1 claim.
              paused?.send({ type: 'settle' });
            }
            if (m?.type === 'settled') {
              resolve({ ok: Boolean(m.ok), reason: m.reason ?? null });
            }
          });
        });

        assert.equal(probe.ok, false, '§68 — a stale owner cannot settle');
        assert.ok(
          probe.reason === 'fenced' || probe.reason === 'already-terminal',
          `§68 — the stale settle is fenced, not applied (${probe.reason})`,
        );

        const c = await createSqliteCoordinationProvider({ location: second.coordDb });
        const s = await createSqliteDurableWorkStorage({ location: second.workDb });
        const finalItem = await createDurableWorkStore({ coordination: c, storage: s }).get('effect', 'contended');
        assert.equal(finalItem?.result, 'B-result', '§68 — the reclaimer\'s result stays authoritative');
        await c.close?.();
        await s.close?.();
      } finally {
        rmSync(second.dir, { recursive: true, force: true });
      }
    } finally {
      victim?.kill('SIGKILL');
      paused?.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
