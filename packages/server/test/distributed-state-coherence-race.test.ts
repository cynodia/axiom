import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isSqliteAvailable } from '@cynodia/axiom-server';

/**
 * spec12.1 §57, §58, §61, §94: distributed `StateDef` coherence with **real OS processes**
 * against one shared SQLite persistence file. Cross-process is the release gate for F1.
 */

const available = await isSqliteAvailable();
const WORKER = fileURLToPath(new URL('./helpers/ledger-authority-worker.js', import.meta.url));
// Routine local run keeps the process count modest; the pre-release run sets
// AXIOM_AUTHORITIES=8 and AXIOM_EVENT_TOPOLOGIES=1,2,8 for the full spec12.1 §58/§107 counts.
const N = Math.max(2, Number(process.env.AXIOM_AUTHORITIES ?? 4));
const ROUTED_ACTIONS = Math.max(10, Number(process.env.AXIOM_COHERENCE_STEPS ?? 16));
const EVENT_TOPOLOGIES = (process.env.AXIOM_EVENT_TOPOLOGIES ?? '1,2,4')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => n >= 1);

interface Authority {
  child: ChildProcess;
  send(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): void;
}

function spawnAuthority(stateDb: string, id: string): Promise<Authority> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [stateDb, id], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    const pending: Array<{ resolve: (m: Record<string, unknown>) => void; want: string }> = [];
    child.on('message', (m: Record<string, unknown>) => {
      if (m?.type === 'ready') {
        resolve({
          child,
          send: (msg) =>
            new Promise((res) => {
              const want = msg.type === 'snapshot' ? 'snapshot' : 'result';
              pending.push({ resolve: res, want });
              child.send(msg);
            }),
          stop: () => child.send({ type: 'stop' }),
        });
        return;
      }
      const next = pending.shift();
      if (!next) throw new Error(`authority ${id} sent an unsolicited message: ${JSON.stringify(m)}`);
      if (m?.type !== 'error' && m?.type !== next.want) {
        throw new Error(`authority ${id} reply desync: wanted ${next.want}, got ${JSON.stringify(m)}`);
      }
      next.resolve(m);
    });
    child.on('exit', (code, signal) => {
      if (stderr.includes('SQLITE') || stderr.includes('ERR_SQLITE_ERROR') || stderr.includes('database is locked')) {
        reject(new Error(`authority ${id} leaked a raw SQLite error (code=${code} signal=${signal}): ${stderr.slice(0, 400)}`));
      }
    });
  });
}

test(
  `spec12.1 §57/§58: ${N} OS-process authorities against one SQLite DB — read-after-write holds, all converge`,
  { skip: !available },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-coh-race-'));
    const stateDb = path.join(dir, 'state.db');
    const authorities: Authority[] = [];
    try {
      for (let i = 0; i < N; i += 1) authorities.push(await spawnAuthority(stateDb, `auth-${i}`));

      let expected = 0;
      let staleReads = 0;
      for (let step = 0; step < ROUTED_ACTIONS; step += 1) {
        const writer = authorities[step % N]!;
        const amount = (step % 7) + 1;
        const res = await writer.send({ type: 'deposit', amount });
        assert.equal(res.ok, true, `step ${step}: deposit committed (code=${String(res.code)})`);
        expected += amount;

        // Read from a different, randomly chosen authority — it MUST observe the commit.
        const reader = authorities[(step + 1 + Math.floor(Math.random() * (N - 1))) % N]!;
        const snap = await reader.send({ type: 'snapshot' });
        if (snap.ledger !== expected) staleReads += 1;
        assert.equal(snap.ledger, expected, `step ${step}: read-after-write on a different authority`);
      }

      // Every authority converges to the same value.
      for (const a of authorities) {
        const snap = await a.send({ type: 'snapshot' });
        assert.equal(snap.ledger, expected, 'all authorities converge');
      }
      assert.equal(staleReads, 0, 'no stale authoritative read after a known remote commit');
    } finally {
      for (const a of authorities) a.stop();
      await new Promise((r) => setTimeout(r, 200));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'spec12.1 §61/§107: six events across 1/2/N authorities — eventsSeen converges to 6 in every topology',
  { skip: !available },
  async () => {
    for (const topology of EVENT_TOPOLOGIES) {
      const dir = mkdtempSync(path.join(tmpdir(), `axiom-evt-${topology}-`));
      const stateDb = path.join(dir, 'state.db');
      const authorities: Authority[] = [];
      try {
        for (let i = 0; i < topology; i += 1) authorities.push(await spawnAuthority(stateDb, `a${i}`));
        for (let e = 0; e < 6; e += 1) {
          const res = await authorities[e % topology]!.send({ type: 'event', amount: 1 });
          assert.equal(res.ok, true, `topology ${topology}: event ${e}`);
        }
        for (const a of authorities) {
          const snap = await a.send({ type: 'snapshot' });
          assert.equal(snap.eventsSeen, 6, `topology ${topology}: every authority observes eventsSeen == 6`);
        }
      } finally {
        for (const a of authorities) a.stop();
        await new Promise((r) => setTimeout(r, 200));
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

test(
  'spec12.1 §60: a true concurrent write race across processes — one wins, the loser recovers',
  { skip: !available },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-race-'));
    const stateDb = path.join(dir, 'state.db');
    const authorities: Authority[] = [];
    try {
      for (let i = 0; i < 4; i += 1) authorities.push(await spawnAuthority(stateDb, `a${i}`));

      // Release four deposits from four processes as simultaneously as IPC allows.
      const results = await Promise.all(
        authorities.map((a, i) => a.send({ type: 'deposit', amount: (i + 1) * 10 })),
      );
      const wins = results.filter((r) => r.ok === true).length;
      for (const r of results) {
        assert.notEqual(r.type, 'error', 'no raw error surfaced');
        assert.ok(r.ok === true || r.code === 'CONCURRENCY_CONFLICT', 'a clean outcome, not a leaked error');
      }
      assert.ok(wins >= 1, 'at least one commit wins the simultaneous race');

      // Every losing authority recovers: retrying (after its own automatic reconciliation)
      // succeeds, and its committed amount is then observed everywhere. No permanent wedge.
      // Each of the four deposits lands exactly once — a winner in the race above, a loser
      // through its retry here — so the converged total is the deterministic sum of all four
      // amounts, independent of who won. (Deriving it from a post-race snapshot instead is
      // racy: that snapshot need not yet equal the sum of the race winners.)
      for (let i = 0; i < authorities.length; i += 1) {
        if (results[i]?.ok === true) continue; // this one already committed in the race
        let ok = false;
        for (let attempt = 0; attempt < 8 && !ok; attempt += 1) {
          const retry = await authorities[i]!.send({ type: 'deposit', amount: (i + 1) * 10 });
          ok = retry.ok === true;
        }
        assert.ok(ok, `authority ${i} recovered and committed its deposit after losing the race`);
      }
      const expectedTotal = authorities.reduce((sum, _a, i) => sum + (i + 1) * 10, 0);

      // All authorities converge to the same total.
      for (const a of authorities) {
        assert.equal((await a.send({ type: 'snapshot' })).ledger, expectedTotal, 'all converge');
      }
      // And every authority still accepts a fresh write.
      for (let i = 0; i < authorities.length; i += 1) {
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt += 1) {
          ok = (await authorities[i]!.send({ type: 'deposit', amount: 1 })).ok === true;
        }
        assert.ok(ok, `authority ${i} accepts a subsequent write`);
      }
      assert.equal(
        (await authorities[3]!.send({ type: 'snapshot' })).ledger,
        expectedTotal + authorities.length,
        'the follow-up writes are all observed',
      );
    } finally {
      for (const a of authorities) a.stop();
      await new Promise((r) => setTimeout(r, 200));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
