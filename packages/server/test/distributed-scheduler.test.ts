import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDistributedScheduler,
  createDurableWorkStore,
  createMemoryCoordinationProvider,
  createMemoryDurableWorkStorage,
  explainScheduleFiring,
  intervalDueInstants,
  parseScheduledFiringId,
  scheduledFiringId,
  SCHEDULE_FIRING_WORK_CLASS,
} from '@cynodia/axiom-server';

/**
 * Spec12 §21-§24, §71-§72: the multi-authority scheduler.
 *
 * Deterministic, in-process, memory coordination provider — one authority ≈ N authorities:
 * N pollers of one due schedule produce exactly one logical firing; a crashed owner's
 * firing is reclaimed under the *same* id; missed boundaries are caught up by one authority,
 * never N.
 */

function fakeClock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v), advance: (ms: number) => void (t += ms) };
}

interface Harness {
  store: ReturnType<typeof createDurableWorkStore>;
  coordination: ReturnType<typeof createMemoryCoordinationProvider>;
  fires: Array<{ scheduleId: string; dueInstant: number }>;
  make: (
    instanceId: string,
    opts?: { catchUp?: 'latest' | 'all' | number; fire?: (s: string, d: number) => Promise<{ ok: boolean }> },
  ) => ReturnType<typeof createDistributedScheduler>;
}

function harness(clock: ReturnType<typeof fakeClock>): Harness {
  const coordination = createMemoryCoordinationProvider({ now: clock.now });
  const storage = createMemoryDurableWorkStorage();
  const store = createDurableWorkStore({ coordination, storage, now: clock.now });
  const fires: Harness['fires'] = [];
  const make: Harness['make'] = (instanceId, opts) =>
    createDistributedScheduler({
      store,
      instanceId,
      epoch: 0,
      now: clock.now,
      config: { leaseDurationMs: 1_000, renewIntervalMs: 400 },
      ...(opts?.catchUp !== undefined ? { catchUp: opts.catchUp } : {}),
      fire:
        opts?.fire ??
        (async (scheduleId, dueInstant) => {
          fires.push({ scheduleId, dueInstant });
          return { ok: true };
        }),
    });
  return { store, coordination, fires, make };
}

// ------------------------------------------------------------------------------ units

test('firing identity is derived and reversible (spec12 §22)', () => {
  assert.equal(scheduledFiringId('trigger_report', 5000), 'trigger_report@5000');
  assert.deepEqual(parseScheduledFiringId('trigger_report@5000'), {
    scheduleId: 'trigger_report',
    dueInstant: 5000,
  });
  // A schedule id that itself contains '@' still round-trips (split on the last '@').
  assert.deepEqual(parseScheduledFiringId('a@b@7'), { scheduleId: 'a@b', dueInstant: 7 });
});

test('intervalDueInstants is epoch-aligned and half-open on the left', () => {
  assert.deepEqual(intervalDueInstants(1_000, 0, 3_000), [1_000, 2_000, 3_000]);
  assert.deepEqual(intervalDueInstants(1_000, 1_000, 3_000), [2_000, 3_000]);
  assert.deepEqual(intervalDueInstants(1_000, 2_500, 2_999), []);
  assert.deepEqual(intervalDueInstants(1_000, 999, 1_000), [1_000]);
});

// -------------------------------------------------------------------------- semantics

test('N authorities polling one due interval schedule cause exactly one firing (spec12 §21, §71)', async () => {
  const clock = fakeClock(2_000);
  const h = harness(clock);
  const a = h.make('A');
  const b = h.make('B');
  const c = h.make('C');
  for (const s of [a, b, c]) s.register({ scheduleId: 'trg', kind: 'interval', everyMs: 1_000 });

  const counts = await Promise.all([a.poll(), b.poll(), c.poll()]);
  assert.equal(
    counts.reduce((n, x) => n + x, 0),
    1,
    'exactly one authority ran the firing',
  );
  assert.deepEqual(h.fires, [{ scheduleId: 'trg', dueInstant: 2_000 }]);

  clock.set(3_000);
  await Promise.all([a.poll(), b.poll(), c.poll()]);
  assert.deepEqual(h.fires.map((f) => f.dueInstant), [2_000, 3_000], 'one firing per boundary');
});

test('a crashed firing owner is reclaimed under the same firing id — no second identity (spec12 §72)', async () => {
  const clock = fakeClock(5_000); // on an everyMs=5000 boundary
  const h = harness(clock);
  let releaseHang: () => void = () => {};
  const hang = new Promise<{ ok: boolean }>((r) => {
    releaseHang = () => r({ ok: true });
  });

  const a = h.make('A', { fire: () => hang });
  const b = h.make('B'); // default fire records + ok
  a.register({ scheduleId: 'trg', kind: 'interval', everyMs: 5_000 });
  b.register({ scheduleId: 'trg', kind: 'interval', everyMs: 5_000 });

  const aPoll = a.poll(); // A claims firing trg@5000, fire() hangs
  await new Promise((r) => setTimeout(r, 5));
  clock.advance(1_001); // A's lease lapses; next boundary (10_000) is not yet due

  const bCount = await b.poll(); // B reclaims trg@5000
  assert.equal(bCount, 1);
  assert.deepEqual(h.fires, [{ scheduleId: 'trg', dueInstant: 5_000 }], 'B ran the same firing');

  releaseHang();
  await aPoll;

  // exactly one durable firing row, and it is succeeded
  const all = await h.store.list(SCHEDULE_FIRING_WORK_CLASS, 100);
  assert.equal(all.length, 1, 'one logical firing identity');
  assert.equal(all[0]?.workId, 'trg@5000');
  assert.equal(all[0]?.state, 'succeeded');
  assert.equal(all[0]?.uncertainAttempts, 1, "A's abandoned attempt is recorded uncertain");
});

test('missed boundaries: catchUp "latest" fires once, "all" fires every missed one (spec12 §23)', async () => {
  const latestClock = fakeClock(1_000);
  const latest = harness(latestClock);
  const sL = latest.make('A', { catchUp: 'latest' });
  sL.register({ scheduleId: 'trg', kind: 'interval', everyMs: 1_000 });
  await sL.poll(); // establishes scannedThrough at 1_000
  latestClock.set(10_000); // a long outage: boundaries 2_000..10_000 missed
  await sL.poll();
  assert.deepEqual(latest.fires.map((f) => f.dueInstant), [1_000, 10_000], 'only the most recent missed boundary');

  const allClock = fakeClock(1_000);
  const all = harness(allClock);
  const sA = all.make('A', { catchUp: 'all' });
  sA.register({ scheduleId: 'trg', kind: 'interval', everyMs: 1_000 });
  await sA.poll();
  allClock.set(5_000);
  await sA.poll();
  assert.deepEqual(all.fires.map((f) => f.dueInstant), [1_000, 2_000, 3_000, 4_000, 5_000], 'every missed boundary');
});

test('a missed firing is caught up by only one authority (spec12 §23)', async () => {
  const clock = fakeClock(1_000);
  const h = harness(clock);
  const a = h.make('A', { catchUp: 'all' });
  const b = h.make('B', { catchUp: 'all' });
  a.register({ scheduleId: 'trg', kind: 'interval', everyMs: 1_000 });
  b.register({ scheduleId: 'trg', kind: 'interval', everyMs: 1_000 });
  await Promise.all([a.poll(), b.poll()]);

  clock.set(6_000);
  // Boundaries 2_000..6_000 are missed. Poll a few times (batch size bounds each poll) with
  // both authorities racing every round — the durable claim must still fire each exactly once.
  let total = 0;
  for (let round = 0; round < 4; round += 1) {
    const counts = await Promise.all([a.poll(), b.poll()]);
    total += counts.reduce((n, x) => n + x, 0);
  }
  assert.equal(total, 5, 'exactly five catch-up firings across both authorities — no double-catch-up');
  const instants = h.fires.map((f) => f.dueInstant).sort((x, y) => x - y);
  assert.deepEqual(instants, [1_000, 2_000, 3_000, 4_000, 5_000, 6_000]);
  assert.equal(new Set(instants).size, instants.length, 'no boundary fired twice');
});

test('a delay schedule fires exactly once at epoch + afterMs', async () => {
  const clock = fakeClock(0);
  const h = harness(clock);
  const s = h.make('A');
  s.register({ scheduleId: 'trg_delay', kind: 'delay', afterMs: 5_000 });

  await s.poll(); // t=0, not due
  assert.deepEqual(h.fires, []);
  clock.set(5_000);
  await s.poll();
  await s.poll(); // idempotent — already fired
  assert.deepEqual(h.fires, [{ scheduleId: 'trg_delay', dueInstant: 5_000 }]);
});

test('explainScheduleFiring reports the spec12 §23 state vocabulary', async () => {
  const clock = fakeClock(1_000);
  const h = harness(clock);
  const rid = (d: number) => `${SCHEDULE_FIRING_WORK_CLASS}:${scheduledFiringId('trg', d)}`;

  // due: enqueued, not yet run, now == dueInstant
  await h.store.enqueue({
    workClass: SCHEDULE_FIRING_WORK_CLASS,
    workId: scheduledFiringId('trg', 1_000),
    payload: { scheduleId: 'trg', dueInstant: 1_000 },
  });
  let item = (await h.store.get(SCHEDULE_FIRING_WORK_CLASS, scheduledFiringId('trg', 1_000)))!;
  assert.equal(explainScheduleFiring(item, await h.coordination.inspect(rid(1_000)), 1_000).state, 'due');
  assert.equal(explainScheduleFiring(item, null, 4_000).state, 'late');
  assert.equal(explainScheduleFiring(item, null, 4_000).latenessMs, 3_000);

  // currently-owned: claimed with a live lease
  const [claim] = await h.store.claim(SCHEDULE_FIRING_WORK_CLASS, 'A', { leaseMs: 1_000 });
  item = (await h.store.get(SCHEDULE_FIRING_WORK_CLASS, scheduledFiringId('trg', 1_000)))!;
  let x = explainScheduleFiring(item, await h.coordination.inspect(rid(1_000)), clock.now());
  assert.equal(x.state, 'currently-owned');
  assert.equal(x.owner?.ownerId, 'A');
  assert.equal(x.reclaimable, false);

  // expired-owner: lease lapsed, not settled
  clock.advance(1_001);
  x = explainScheduleFiring(item, await h.coordination.inspect(rid(1_000)), clock.now());
  assert.equal(x.state, 'expired-owner');
  assert.equal(x.reclaimable, true);

  // already-fired / terminally-completed
  await h.store.settle(claim!, { kind: 'succeeded', result: null });
  item = (await h.store.get(SCHEDULE_FIRING_WORK_CLASS, scheduledFiringId('trg', 1_000)))!;
  assert.equal(explainScheduleFiring(item, null, clock.now()).state, 'already-fired');
});
