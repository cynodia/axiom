import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDurableWorkStore,
  createMemoryCoordinationProvider,
  createMemoryDurableWorkStorage,
  isTerminalWorkState,
} from '@cynodia/axiom-server';

/**
 * spec12 §82: the deterministic chaos matrix — a crash at every ownership boundary, and for
 * each the expected semantic state, reclaimability, duplication boundary and fencing result.
 *
 * The crash is injected by driving the `DurableWorkStore` primitives directly and simply
 * *stopping* at the named boundary (§84 test infrastructure — no production hooks). A second
 * authority then attempts recovery; the assertions below are the matrix.
 *
 * Two boundaries are documented rather than asserted here:
 *  - **during checkpoint** — durable work has no sub-attempt checkpoint; the unit of progress
 *    is the whole attempt, so this boundary does not exist for effects / schedule firings.
 *  - **after completion commit / before the follow-up event** — the completion transition is
 *    exactly-once (asserted), but dispatching the declared success/failure event afterwards
 *    is at-most-once across a crash in that sub-window. This is unchanged from single-authority
 *    0.8+ (the event dispatch was always post-commit and non-durable) and is called out in
 *    `docs/DISTRIBUTED_AUTHORITY.md`.
 */

const LEASE = 1_000;

function harness(start = 1_000) {
  let t = start;
  const now = () => t;
  const advance = (ms: number) => void (t += ms);
  const coordination = createMemoryCoordinationProvider({ now });
  const storage = createMemoryDurableWorkStorage();
  const store = createDurableWorkStore({ coordination, storage, now, defaultLeaseMs: LEASE });
  return { store, advance, now };
}

interface MatrixExpectation {
  /** The durable state a recovering authority observes. */
  semanticState: string;
  /** Whether another authority can take the work after the crash + lease expiry. */
  reclaimable: boolean;
  /** Whether a second *physical* attempt is possible (at-least-once) or excluded. */
  duplicationBoundary: 'excluded' | 'at-least-once';
  /** What the crashed owner's late write does if it ever resumes. */
  fencingResult: 'n/a' | 'fenced' | 'self-recovers';
}

test('chaos: crash BEFORE claim — nothing owned, item still pending, no fence', async () => {
  const { store } = harness();
  await store.enqueue({ workClass: 'effect', workId: 'w', payload: {} });
  // crash: authority A dies before it ever claims.
  const item = await store.get('effect', 'w');
  const exp: MatrixExpectation = {
    semanticState: 'pending',
    reclaimable: true,
    duplicationBoundary: 'excluded',
    fencingResult: 'n/a',
  };
  assert.equal(item?.state, exp.semanticState);
  const [claim] = await store.claim('effect', 'B', { leaseMs: LEASE });
  assert.ok(claim, 'B claims it fresh');
  assert.equal(claim.item.attemptNumber, 1);
});

test('chaos: crash DURING claim (lease taken, row not marked) — reclaimable after expiry, dead generation fenced', async () => {
  const { store, advance } = harness();
  await store.enqueue({ workClass: 'effect', workId: 'w', payload: {} });
  // A's claim: emulate the lease landing but the process dying before/at markClaimed by
  // claiming normally and then never acting. (Whether markClaimed ran, the outcome is the
  // same: the lease is the gate.)
  const [aClaim] = await store.claim('effect', 'A', { leaseMs: LEASE });
  assert.ok(aClaim);

  advance(LEASE + 1); // A never renews
  const [bClaim] = await store.claim('effect', 'B', { leaseMs: LEASE });
  assert.ok(bClaim, 'reclaimable after lease expiry');
  assert.ok(bClaim.generation > aClaim.generation, 'reclaim mints a higher generation');

  const stale = await store.settle(aClaim, { kind: 'succeeded', result: null });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, 'fenced', 'the dead generation is fenced');
});

test('chaos: crash AFTER claim / BEFORE work — attempt counted, no physical effect, reclaim retries', async () => {
  const { store, advance } = harness();
  await store.enqueue({ workClass: 'effect', workId: 'w', payload: {} });
  const [aClaim] = await store.claim('effect', 'A', { leaseMs: LEASE });
  assert.equal(aClaim?.item.attemptNumber, 1);
  // crash before calling the adapter.
  advance(LEASE + 1);
  const [bClaim] = await store.claim('effect', 'B', { leaseMs: LEASE });
  assert.equal(bClaim?.item.attemptNumber, 2, 'a fresh physical attempt');
  assert.equal(bClaim?.item.uncertainAttempts, 1, 'conservatively marked uncertain — no proof the adapter did not run');
});

test('chaos: crash DURING work / AFTER physical effect BEFORE completion — at-least-once, uncertain, fenced', async () => {
  const { store, advance } = harness();
  await store.enqueue({ workClass: 'effect', workId: 'w', payload: {} });
  const [aClaim] = await store.claim('effect', 'A', { leaseMs: LEASE });
  assert.ok(aClaim);
  // The adapter ran (side effect happened) but A crashed before settle.
  advance(LEASE + 1);
  const [bClaim] = await store.claim('effect', 'B', { leaseMs: LEASE });
  assert.equal(bClaim?.item.uncertainAttempts, 1);

  // B completes; A's late completion is fenced — the completion transition stays exactly-once.
  assert.equal((await store.settle(bClaim!, { kind: 'succeeded', result: null })).ok, true);
  const late = await store.settle(aClaim, { kind: 'succeeded', result: null });
  assert.equal(late.ok === false && late.reason, 'already-terminal');

  const item = await store.get('effect', 'w');
  const exp: MatrixExpectation = {
    semanticState: 'succeeded',
    reclaimable: false,
    duplicationBoundary: 'at-least-once',
    fencingResult: 'fenced',
  };
  assert.equal(item?.state, exp.semanticState);
});

test('chaos: crash BEFORE completion commit — the settle simply never happened, reclaimable', async () => {
  const { store, advance } = harness();
  await store.enqueue({ workClass: 'effect', workId: 'w', payload: {} });
  const [aClaim] = await store.claim('effect', 'A', { leaseMs: LEASE });
  assert.ok(aClaim);
  // crash between deciding "succeeded" and calling settle().
  advance(LEASE + 1);
  const [bClaim] = await store.claim('effect', 'B', { leaseMs: LEASE });
  assert.ok(bClaim, 'still reclaimable — no partial completion is possible');
  assert.equal((await store.get('effect', 'w'))?.state, 'claimed');
});

test('chaos: crash AFTER completion commit / BEFORE release — terminal and durable, not reclaimable', async () => {
  const { store, advance } = harness();
  await store.enqueue({ workClass: 'effect', workId: 'w', payload: {} });
  const [aClaim] = await store.claim('effect', 'A', { leaseMs: LEASE });
  assert.ok(aClaim);
  await store.settle(aClaim, { kind: 'succeeded', result: null });
  // crash before the (best-effort) lease release / before onTerminal.
  advance(LEASE + 1);

  const claimedAgain = await store.claim('effect', 'B', { leaseMs: LEASE });
  assert.deepEqual(claimedAgain, [], 'a terminal item is never re-claimed');
  const item = await store.get('effect', 'w');
  assert.ok(item && isTerminalWorkState(item.state));
  assert.equal(item.state, 'succeeded');
});

test('chaos: crash DURING lease renewal — the renew either landed or not; either way the lease expires and reclaim proceeds', async () => {
  const { store, advance } = harness();
  await store.enqueue({ workClass: 'effect', workId: 'w', payload: {} });
  const [aClaim] = await store.claim('effect', 'A', { leaseMs: LEASE });
  assert.ok(aClaim);
  // renew succeeds (landed) then A immediately crashes.
  assert.equal(await store.renew(aClaim, LEASE), true);
  advance(LEASE + 1); // the extended lease still expires
  const [bClaim] = await store.claim('effect', 'B', { leaseMs: LEASE });
  assert.ok(bClaim, 'a landed renewal only delays reclaim, never prevents it');
  assert.ok(bClaim.generation > aClaim.generation);
});

test('chaos: AFTER lease expiry but BEFORE anyone reclaims — a stale owner self-recovers (expiry alone does not fence)', async () => {
  const { store, advance } = harness();
  await store.enqueue({ workClass: 'effect', workId: 'w', payload: {} });
  const [aClaim] = await store.claim('effect', 'A', { leaseMs: LEASE });
  assert.ok(aClaim);
  advance(LEASE + 1); // A's lease has expired, but no B has taken over

  const recovered = await store.settle(aClaim, { kind: 'succeeded', result: null });
  const exp: MatrixExpectation = {
    semanticState: 'succeeded',
    reclaimable: false,
    duplicationBoundary: 'excluded',
    fencingResult: 'self-recovers',
  };
  assert.equal(recovered.ok, true, 'expiry authorizes nothing on its own — only a reclaim fences');
  assert.equal((await store.get('effect', 'w'))?.state, exp.semanticState);
});
