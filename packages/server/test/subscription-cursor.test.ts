import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMemoryCoordinationProvider,
  createMemoryCursorPositionStore,
  createSqliteCoordinationProvider,
  createSqliteCursorPositionStore,
  createSubscriptionCursorStore,
  isSqliteSubscriptionCursorAvailable,
  subscriptionOrderingGuarantee,
} from '@cynodia/axiom-server';
import type { SubscriptionCursorStore } from '@cynodia/axiom-server';

/**
 * Spec12 §27-§31, §75: subscription ownership + cursor fencing.
 *
 * The memory position store is the semantic reference; the SQLite one must implement the
 * same contract (spec12 §63). Behavioural tests run against both. Real cross-process fencing
 * lives in `subscription-cursor-race.test.ts`.
 */

const available = await isSqliteSubscriptionCursorAvailable();

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

async function bothStores(
  clock: ReturnType<typeof fakeClock>,
  body: (store: SubscriptionCursorStore, label: string) => Promise<void>,
): Promise<void> {
  await body(
    createSubscriptionCursorStore({
      coordination: createMemoryCoordinationProvider({ now: clock.now }),
      positions: createMemoryCursorPositionStore(),
      now: clock.now,
    }),
    'memory',
  );
  if (!available) return;
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-subcursor-'));
  const coordination = await createSqliteCoordinationProvider({
    location: path.join(dir, 'coord.db'),
    now: clock.now,
  });
  const positions = await createSqliteCursorPositionStore({ location: path.join(dir, 'cursor.db') });
  await body(createSubscriptionCursorStore({ coordination, positions, now: clock.now }), 'sqlite');
  await coordination.close?.();
  await positions.close?.();
  rmSync(dir, { recursive: true, force: true });
}

test('the ordering guarantee is per-subscription and machine-readable (spec12 §29)', () => {
  assert.deepEqual(subscriptionOrderingGuarantee(), {
    scope: 'per-subscription',
    monotonicField: 'sequence',
    acrossSubscriptions: 'none',
    acrossEventSources: 'none',
    deliveryGuarantee: 'at-least-once',
    duplicateDeliveryPossible: true,
  });
});

test('acquire grants ownership + the durable resume position; a live foreign lease blocks', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    const a = await store.acquire('sub_orders', 'A', 10_000);
    assert.ok(a.ok, `${label}: A acquires`);
    assert.equal(a.ok && a.ownership.generation, 1);
    assert.equal(a.ok && a.ownership.resumeFrom, 0, `${label}: resume from 0 on a fresh subscription`);

    const b = await store.acquire('sub_orders', 'B', 10_000);
    assert.equal(b.ok, false, `${label}: B cannot take a live subscription`);
    assert.equal(b.ok === false && b.heldBy.ownerId, 'A');
  });
});

test('the current owner advances the cursor forward; a backward move is rejected (spec12 §28)', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    const a = await store.acquire('sub', 'A', 10_000);
    assert.ok(a.ok);
    const g = a.ok ? a.ownership.generation : 0;

    assert.deepEqual(await store.advance('sub', 'A', g, 5), { ok: true, sequence: 5 }, label);
    assert.deepEqual(await store.advance('sub', 'A', g, 12), { ok: true, sequence: 12 }, label);
    assert.deepEqual(await store.advance('sub', 'A', g, 12), { ok: true, sequence: 12 }, `${label}: idempotent re-write of the same position`);

    const backward = await store.advance('sub', 'A', g, 4);
    assert.equal(backward.ok, false, `${label}: no cursor regression`);
    assert.equal(backward.ok === false && backward.reason, 'stale-sequence');
    assert.equal((await store.read('sub'))?.sequence, 12, `${label}: cursor unchanged`);
  });
});

test('a stalled owner cannot advance the cursor after another authority takes over — fenced (spec12 §75)', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    const a = await store.acquire('sub', 'A', 1_000);
    assert.ok(a.ok);
    const gA = a.ok ? a.ownership.generation : 0;
    await store.advance('sub', 'A', gA, 10);

    // A stalls; its lease lapses; B takes over under a higher generation.
    clock.advance(1_001);
    const b = await store.acquire('sub', 'B', 10_000);
    assert.ok(b.ok, `${label}: B reclaims`);
    const gB = b.ok ? b.ownership.generation : 0;
    assert.ok(gB > gA, `${label}: B's generation is higher`);
    assert.equal(b.ok && b.ownership.resumeFrom, 10, `${label}: B resumes from the durable cursor`);

    await store.advance('sub', 'B', gB, 25);

    // A resumes and tries to write its old cursor state — must be fenced.
    const stale = await store.advance('sub', 'A', gA, 11);
    assert.equal(stale.ok, false, `${label}: stale owner rejected`);
    assert.equal(stale.ok === false && stale.reason, 'fenced', `${label}: reason is fencing`);
    assert.equal((await store.read('sub'))?.sequence, 25, `${label}: B's cursor stands`);

    // even a forward-looking write from A is fenced — generation, not sequence, decides.
    const staleForward = await store.advance('sub', 'A', gA, 999);
    assert.equal(staleForward.ok === false && staleForward.reason, 'fenced', `${label}`);
    assert.equal((await store.read('sub'))?.sequence, 25);
  });
});

test('reconnect through a different authority follows the durable cursor, not process memory (spec12 §31)', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    const a = await store.acquire('sub', 'A', 10_000);
    assert.ok(a.ok);
    await store.advance('sub', 'A', a.ok ? a.ownership.generation : 0, 42);
    await store.release('sub', a.ok ? a.ownership.token : '');

    // A different authority, no shared memory — only the durable store.
    const b = await store.acquire('sub', 'B', 10_000);
    assert.ok(b.ok);
    assert.equal(b.ok && b.ownership.resumeFrom, 42, `${label}: resume exactly where A left off`);
    assert.ok(b.ok && b.ownership.generation > (a.ok ? a.ownership.generation : 0), `${label}: generation moved forward`);
  });
});

test('renew keeps ownership; release frees it without rewinding the cursor or generation', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    const a = await store.acquire('sub', 'A', 10_000);
    assert.ok(a.ok);
    const token = a.ok ? a.ownership.token : '';
    await store.advance('sub', 'A', a.ok ? a.ownership.generation : 0, 7);

    assert.equal(await store.renew('sub', 'wrong-token', 10_000), false, `${label}: foreign renew rejected`);
    assert.equal(await store.renew('sub', token, 10_000), true, `${label}: owner renews`);

    await store.release('sub', token);
    const b = await store.acquire('sub', 'B', 10_000);
    assert.ok(b.ok);
    assert.equal(b.ok && b.ownership.resumeFrom, 7, `${label}: cursor survived the release`);
    assert.ok(b.ok && b.ownership.generation >= 2, `${label}: generation never rewinds`);
  });
});
