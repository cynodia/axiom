import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDurableWorkStore,
  createMemoryCoordinationProvider,
  createMemoryDurableWorkStorage,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
  isSqliteDurableWorkAvailable,
  isTerminalWorkState,
  DURABLE_WORK_STATES,
  type CoordinationProvider,
  type DurableWorkStorage,
} from '@cynodia/axiom-server';

/**
 * Spec12 §7, §14, §18: the durable work-identity + claim state machine.
 *
 * The memory storage is the semantic reference; the SQLite storage must be a faithful
 * implementation of the same contract (spec12 §63). Every behavioural test runs against both
 * via `bothStorages`, so parity is asserted by construction. Genuine cross-process fencing —
 * real OS processes, SIGKILL — lives in `durable-work-race.test.ts`.
 */

const sqliteAvailable = await isSqliteDurableWorkAvailable();

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

interface Harness {
  coordination: CoordinationProvider;
  storage: DurableWorkStorage;
  cleanup: () => Promise<void>;
}

async function bothStorages(
  clock: ReturnType<typeof fakeClock>,
  body: (harness: Harness, label: string) => Promise<void>,
): Promise<void> {
  const memory: Harness = {
    coordination: createMemoryCoordinationProvider({ now: clock.now }),
    storage: createMemoryDurableWorkStorage(),
    cleanup: async () => {},
  };
  await body(memory, 'memory');

  if (!sqliteAvailable) return;
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-durable-'));
  const coordination = await createSqliteCoordinationProvider({
    location: path.join(dir, 'coord.db'),
    now: clock.now,
  });
  const storage = await createSqliteDurableWorkStorage({ location: path.join(dir, 'work.db') });
  await body({ coordination, storage, cleanup: async () => {} }, 'sqlite');
  await coordination.close?.();
  await storage.close?.();
  rmSync(dir, { recursive: true, force: true });
}

test('vocabulary: DURABLE_WORK_STATES and isTerminalWorkState', () => {
  assert.deepEqual([...DURABLE_WORK_STATES], ['pending', 'claimed', 'retry', 'succeeded', 'failed']);
  assert.equal(isTerminalWorkState('succeeded'), true);
  assert.equal(isTerminalWorkState('failed'), true);
  assert.equal(isTerminalWorkState('claimed'), false);
  assert.equal(isTerminalWorkState('retry'), false);
  assert.equal(isTerminalWorkState('pending'), false);
});

test('enqueue is exactly-once logical creation, keyed by (workClass, workId)', async () => {
  const clock = fakeClock();
  await bothStorages(clock, async ({ coordination, storage }, label) => {
    const store = createDurableWorkStore({ coordination, storage, now: clock.now });

    const first = await store.enqueue({ workClass: 'effect', workId: 'e1', payload: { n: 1 } });
    assert.equal(first.created, true, `${label}: first enqueue creates`);

    const again = await store.enqueue({ workClass: 'effect', workId: 'e1', payload: { n: 999 } });
    assert.equal(again.created, false, `${label}: second enqueue is a no-op`);
    assert.deepEqual(again.item.payload, { n: 1 }, `${label}: original payload is untouched`);
    assert.equal(again.item.attemptNumber, 0, `${label}: still pending`);
  });
});

test('claim increments attemptNumber, mints a fencing generation, and is exclusive', async () => {
  const clock = fakeClock();
  await bothStorages(clock, async ({ coordination, storage }, label) => {
    const store = createDurableWorkStore({ coordination, storage, now: clock.now });
    await store.enqueue({ workClass: 'effect', workId: 'e1', payload: { to: 'x' } });

    const claimedByA = await store.claim('effect', 'A', { leaseMs: 10_000 });
    assert.equal(claimedByA.length, 1, `${label}: A claims the one pending item`);
    assert.equal(claimedByA[0]?.generation, 1, `${label}: first generation is 1`);
    assert.equal(claimedByA[0]?.item.attemptNumber, 1, `${label}: physical attempt 1`);
    assert.equal(claimedByA[0]?.item.state, 'claimed', `${label}: state is claimed`);

    const claimedByB = await store.claim('effect', 'B', { leaseMs: 10_000 });
    assert.equal(claimedByB.length, 0, `${label}: B cannot claim work A holds (WORK_IN_PROGRESS)`);
  });
});

test('settle by the current owner commits the terminal state and releases the lease', async () => {
  const clock = fakeClock();
  await bothStorages(clock, async ({ coordination, storage }, label) => {
    const store = createDurableWorkStore({ coordination, storage, now: clock.now });
    await store.enqueue({ workClass: 'effect', workId: 'e1', payload: {} });
    const [claim] = await store.claim('effect', 'A', { leaseMs: 10_000 });
    assert.ok(claim, `${label}: claimed`);

    const settled = await store.settle(claim, { kind: 'succeeded', result: { id: 'ext-1' } });
    assert.equal(settled.ok, true, `${label}: owner settles`);
    assert.equal(settled.ok && settled.item.state, 'succeeded');
    assert.deepEqual(settled.ok && settled.item.result, { id: 'ext-1' });

    // The coordination lease is gone, but the fencing generation is not rewound.
    assert.equal(await coordination.inspect(`effect:e1`), null, `${label}: lease released`);
    const check = await coordination.checkOwnership('effect:e1', 'A', 1);
    assert.equal(check.current, false, `${label}: A is no longer current`);
  });
});

test('a retry settle returns the item to the queue after nextEligibleAt, keeping attemptNumber', async () => {
  const clock = fakeClock();
  await bothStorages(clock, async ({ coordination, storage }, label) => {
    const store = createDurableWorkStore({ coordination, storage, now: clock.now });
    await store.enqueue({ workClass: 'effect', workId: 'e1', payload: {} });

    const [first] = await store.claim('effect', 'A', { leaseMs: 5_000 });
    assert.ok(first);
    const retried = await store.settle(first, {
      kind: 'retry',
      error: { code: 'HTTP_503', message: 'unavailable', retryable: true },
      nextEligibleAt: clock.now() + 1_000,
    });
    assert.equal(retried.ok, true, `${label}: retry settle applied`);
    assert.equal(retried.ok && retried.item.state, 'retry');

    // Not yet eligible.
    assert.equal((await store.claim('effect', 'B', { leaseMs: 5_000 })).length, 0, `${label}: backoff respected`);

    clock.advance(1_000);
    const [second] = await store.claim('effect', 'B', { leaseMs: 5_000 });
    assert.ok(second, `${label}: eligible again after backoff`);
    assert.equal(second.generation, 2, `${label}: reclaim mints generation 2`);
    assert.equal(second.item.attemptNumber, 2, `${label}: physical attempt 2`);
    assert.equal(second.item.lastError?.code, 'HTTP_503', `${label}: last failure carried forward`);
  });
});

test('a stale owner cannot settle after its lease moved on — reason: fenced (spec12 §18)', async () => {
  const clock = fakeClock();
  await bothStorages(clock, async ({ coordination, storage }, label) => {
    const store = createDurableWorkStore({ coordination, storage, now: clock.now });
    await store.enqueue({ workClass: 'effect', workId: 'e1', payload: {} });

    const [staleClaim] = await store.claim('effect', 'A', { leaseMs: 1_000 });
    assert.ok(staleClaim, `${label}: A claims generation 1`);
    assert.equal(staleClaim.generation, 1);

    // A pauses. Its lease lapses; B reclaims under a strictly greater generation.
    clock.advance(1_001);
    const [freshClaim] = await store.claim('effect', 'B', { leaseMs: 10_000 });
    assert.ok(freshClaim, `${label}: B reclaims`);
    assert.equal(freshClaim.generation, 2, `${label}: generation advanced to 2`);

    // A wakes and tries to finish its old attempt. It must be fenced.
    const staleSettle = await store.settle(staleClaim, { kind: 'succeeded', result: 'A-result' });
    assert.equal(staleSettle.ok, false, `${label}: stale settle rejected`);
    assert.equal(staleSettle.ok === false && staleSettle.reason, 'fenced', `${label}: reason is fencing`);

    // B's completion still wins.
    const bSettle = await store.settle(freshClaim, { kind: 'succeeded', result: 'B-result' });
    assert.equal(bSettle.ok, true, `${label}: B settles`);
    assert.equal(bSettle.ok && bSettle.item.result, 'B-result', `${label}: B's result is authoritative`);

    // And a re-attempt by A is now "already-terminal", never a silent overwrite.
    const late = await store.settle(staleClaim, { kind: 'failed', error: { code: 'X', message: 'x' } });
    assert.equal(late.ok === false && late.reason, 'already-terminal', `${label}: terminal, not overwritten`);
  });
});

test('release hands a held claim back to the queue (graceful shutdown)', async () => {
  const clock = fakeClock();
  await bothStorages(clock, async ({ coordination, storage }, label) => {
    const store = createDurableWorkStore({ coordination, storage, now: clock.now });
    await store.enqueue({ workClass: 'schedule-firing', workId: 's1:100', payload: {} });

    const [claim] = await store.claim('schedule-firing', 'A', { leaseMs: 30_000 });
    assert.ok(claim);
    assert.equal(await store.release(claim), true, `${label}: released`);

    const [reclaimed] = await store.claim('schedule-firing', 'B', { leaseMs: 30_000 });
    assert.ok(reclaimed, `${label}: immediately claimable by another authority`);
    assert.equal(reclaimed.item.attemptNumber, 2, `${label}: the release counts its attempt`);
  });
});

test('list joins durable rows with live-lease observation', async () => {
  const clock = fakeClock();
  await bothStorages(clock, async ({ coordination, storage }, label) => {
    const store = createDurableWorkStore({ coordination, storage, now: clock.now });
    await store.enqueue({ workClass: 'effect', workId: 'held', payload: {} });
    await store.enqueue({ workClass: 'effect', workId: 'idle', payload: {} });
    await store.claim('effect', 'A', { leaseMs: 30_000, batchSize: 1 });

    const listed = await store.list('effect');
    const held = listed.find((row) => row.workId === 'held');
    const idle = listed.find((row) => row.workId === 'idle');
    assert.equal(held?.leaseLive, true, `${label}: claimed item shows a live lease`);
    assert.equal(idle?.leaseLive, false, `${label}: pending item shows no lease`);
    assert.equal(idle?.state, 'pending');
  });
});

test('claim is FIFO by createdAt then workId (spec12 §50 fairness)', async () => {
  const clock = fakeClock();
  await bothStorages(clock, async ({ coordination, storage }, label) => {
    const store = createDurableWorkStore({ coordination, storage, now: clock.now });
    await store.enqueue({ workClass: 'effect', workId: 'c', payload: {} });
    clock.advance(1);
    await store.enqueue({ workClass: 'effect', workId: 'a', payload: {} });
    clock.advance(1);
    await store.enqueue({ workClass: 'effect', workId: 'b', payload: {} });

    const claimed = await store.claim('effect', 'W', { leaseMs: 10_000, batchSize: 10 });
    assert.deepEqual(
      claimed.map((entry) => entry.item.workId),
      ['c', 'a', 'b'],
      `${label}: oldest first, not id-sorted`,
    );
  });
});
