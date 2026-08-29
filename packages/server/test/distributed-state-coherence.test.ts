import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createMemoryPersistence,
  createSqlitePersistence,
  isSqliteAvailable,
} from '@cynodia/axiom-server';
import type { AxiomServer, ServerRequest } from '@cynodia/axiom-server';
import { A_DEPOSIT, LEDGER_IR, P_AMOUNT, S_LEDGER } from './helpers/ledger-graph.js';

/**
 * spec12.1 F1 (§91): the permanent named regression for the Phase 20 blind finding —
 * "running AxiomServer instances do not re-observe StateDef state committed by another
 * authority". Never allow this to be replaced by cache-unit tests alone.
 */

const sqliteAvailable = await isSqliteAvailable();

function deposit(amount: number): ServerRequest {
  return {
    protocol: PROTOCOL_VERSION,
    kind: 'invoke',
    actionId: A_DEPOSIT,
    arguments: { [P_AMOUNT]: amount },
  } as ServerRequest;
}
function snapshotRequest(): ServerRequest {
  return { protocol: PROTOCOL_VERSION, kind: 'snapshot' } as ServerRequest;
}
async function protocolLedger(server: AxiomServer): Promise<{ ledger: number; revision: number }> {
  const res = (await server.handle(snapshotRequest())) as {
    kind: string;
    snapshot: { states: Record<string, unknown>; revision: number };
  };
  assert.equal(res.kind, 'snapshot');
  return { ledger: res.snapshot.states[S_LEDGER] as number, revision: res.snapshot.revision };
}

async function withServers(
  makePersistence: () => Promise<{ a: unknown; b: unknown; c?: unknown }>,
  body: (a: AxiomServer, b: AxiomServer, mkC: () => Promise<AxiomServer>) => Promise<void>,
): Promise<void> {
  const p = await makePersistence();
  const a = createAxiomServer({ ir: LEDGER_IR, persistence: p.a as never });
  const b = createAxiomServer({ ir: LEDGER_IR, persistence: p.b as never });
  await a.start();
  await b.start();
  const mkC = async (): Promise<AxiomServer> => {
    const c = createAxiomServer({ ir: LEDGER_IR, persistence: (p.c ?? p.a) as never });
    await c.start();
    return c;
  };
  try {
    await body(a, b, mkC);
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
  }
}

test('F1: after A commits, B\'s protocol snapshot and next write observe the committed state (spec12.1 §91)', async () => {
  const dir = sqliteAvailable ? mkdtempSync(path.join(tmpdir(), 'axiom-coh-')) : undefined;
  const location = dir ? path.join(dir, 'state.db') : ':memory:';

  const makePersistence = async () => {
    if (sqliteAvailable) {
      return {
        a: await createSqlitePersistence({ location }),
        b: await createSqlitePersistence({ location }),
        c: await createSqlitePersistence({ location }),
      };
    }
    // No SQLite: a single shared in-memory adapter still exercises the coherence path,
    // because both servers read/commit through the same object.
    const shared = createMemoryPersistence();
    return { a: shared, b: shared, c: shared };
  };

  try {
    await withServers(makePersistence, async (a, b, mkC) => {
      assert.equal((await protocolLedger(a)).ledger, 0);
      assert.equal((await protocolLedger(b)).ledger, 0);

      // A commits ledger = 5.
      const r1 = (await a.handle(deposit(5))) as { kind: string; ok?: boolean };
      assert.equal(r1.ok, true);
      const afterA = await protocolLedger(a);
      assert.equal(afterA.ledger, 5);

      // B protocol SnapshotRequest MUST return 5 at a revision >= A's committed revision.
      const bSnap = await protocolLedger(b);
      assert.equal(bSnap.ledger, 5, 'B is not serving stale state after A\'s committed commit');
      assert.ok(bSnap.revision >= afterA.revision, 'B observes a revision at least as new as the commit');

      // B commits +7 — succeeds (no concurrent race), from the reconciled base.
      const r2 = (await b.handle(deposit(7))) as { kind: string; ok?: boolean };
      assert.equal(r2.ok, true, 'B is not permanently wedged on CONCURRENCY_CONFLICT');

      // Both A and B snapshots return 12.
      assert.equal((await protocolLedger(a)).ledger, 12);
      assert.equal((await protocolLedger(b)).ledger, 12);

      // A fresh C also loads 12 — persistence held the correct state all along.
      const c = await mkC();
      try {
        assert.equal((await protocolLedger(c)).ledger, 12);
      } finally {
        await c.stop().catch(() => {});
      }
    });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: sequential deposits routed alternately to A and B converge (spec12.1 §14, §57)', async () => {
  const dir = sqliteAvailable ? mkdtempSync(path.join(tmpdir(), 'axiom-coh-')) : undefined;
  const location = dir ? path.join(dir, 'state.db') : ':memory:';
  const makePersistence = async () => {
    if (sqliteAvailable) {
      return {
        a: await createSqlitePersistence({ location }),
        b: await createSqlitePersistence({ location }),
      };
    }
    const shared = createMemoryPersistence();
    return { a: shared, b: shared };
  };

  try {
    await withServers(makePersistence, async (a, b) => {
      const amounts = [3, 1, 4, 1, 5, 9, 2, 6];
      let expected = 0;
      for (let i = 0; i < amounts.length; i += 1) {
        const server = i % 2 === 0 ? a : b;
        const res = (await server.handle(deposit(amounts[i]!))) as { ok?: boolean };
        assert.equal(res.ok, true, `deposit ${i} on ${i % 2 === 0 ? 'A' : 'B'} committed`);
        expected += amounts[i]!;
        // read from the *other* authority
        const reader = i % 2 === 0 ? b : a;
        assert.equal((await protocolLedger(reader)).ledger, expected, `read-after-write at step ${i}`);
      }
      assert.equal((await protocolLedger(a)).ledger, expected);
      assert.equal((await protocolLedger(b)).ledger, expected);
    });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('a true concurrent write race: one wins, the loser gets CONCURRENCY_CONFLICT then recovers (spec12.1 §11, §15, §60)', async () => {
  // A shared in-memory adapter makes the race deterministic: both invokes read the same
  // base revision, then commit; the second sees the conflict.
  const shared = createMemoryPersistence();
  const a = createAxiomServer({ ir: LEDGER_IR, persistence: shared });
  const b = createAxiomServer({ ir: LEDGER_IR, persistence: shared });
  await a.start();
  await b.start();
  try {
    // Fire both without awaiting between — they race from revision 0.
    const [ra, rb] = await Promise.all([a.handle(deposit(5)), b.handle(deposit(7))]);
    const results = [ra, rb] as Array<{ ok?: boolean; diagnostics?: Array<{ code: string }> }>;
    const wins = results.filter((r) => r.ok === true);
    const losses = results.filter((r) => r.ok !== true);
    assert.equal(wins.length, 1, 'exactly one commit wins');
    assert.equal(losses.length, 1, 'exactly one loses');
    assert.equal(losses[0]?.diagnostics?.[0]?.code, 'CONCURRENCY_CONFLICT');

    // Both authorities converge, and the loser is NOT wedged — its next deposit succeeds.
    const winnerLedger = (await protocolLedger(a)).ledger;
    assert.ok(winnerLedger === 5 || winnerLedger === 7);
    assert.equal((await protocolLedger(b)).ledger, winnerLedger, 'both converge to the winner');

    const recover = (await b.handle(deposit(10))) as { ok?: boolean };
    assert.equal(recover.ok, true, 'the losing authority recovered for its next request');
    assert.equal((await protocolLedger(a)).ledger, winnerLedger + 10);
    assert.equal((await protocolLedger(b)).ledger, winnerLedger + 10);
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
  }
});

test('single-authority semantics are unchanged (spec12.1 §24)', async () => {
  const server = createAxiomServer({ ir: LEDGER_IR, persistence: createMemoryPersistence() });
  await server.start();
  try {
    assert.equal((await protocolLedger(server)).ledger, 0);
    await server.handle(deposit(5));
    await server.handle(deposit(7));
    assert.equal((await protocolLedger(server)).ledger, 12);
    assert.equal(server.snapshot().states[S_LEDGER], 12, 'the local view tracks committed state');
    assert.equal(server.revision(), 2);
  } finally {
    await server.stop().catch(() => {});
  }
});
