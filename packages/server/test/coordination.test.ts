import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COORDINATION_CAPABILITIES,
  COORDINATION_DIAGNOSTIC_CODES,
  DEFAULT_COORDINATION_CONFIG,
  coordinationResourceId,
  createMemoryCoordinationProvider,
  coordinationProviderSupports,
  resolveCoordinationConfig,
  validateCoordinationConfig,
} from '@cynodia/axiom-server';

/**
 * Spec12 §7-§10, §48-§50, §90: the reusable coordination primitive. Leases are exclusive
 * and leased; expiry only makes a claim *reclaimable*; a reclaim mints a strictly higher
 * fencing `generation`; renewal and release are owner-specific; a stale `generation` is
 * never "current". Plus host-config safety (§90): a renew cadence that cannot beat the
 * lease is rejected.
 */

/** A controllable clock so lease expiry is deterministic. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test('memory provider advertises full semantic support but not physical durability', () => {
  const provider = createMemoryCoordinationProvider();
  assert.equal(provider.capabilities.provider, 'memory');
  assert.equal(provider.capabilities.physicalDurability, false);
  for (const capability of COORDINATION_CAPABILITIES) {
    assert.ok(coordinationProviderSupports(provider.capabilities, capability), `supports ${capability}`);
  }
});

test('acquire grants a free resource and blocks a second live claimant', async () => {
  const clock = fakeClock();
  const provider = createMemoryCoordinationProvider({ now: clock.now });
  const r = coordinationResourceId('effect', 'e1');

  const a = await provider.acquire(r, 'A', 30_000);
  assert.ok(a.ok && a.lease);
  assert.equal(a.lease.generation, 1);
  assert.equal(a.lease.ownerId, 'A');

  const b = await provider.acquire(r, 'B', 30_000);
  assert.equal(b.ok, false);
  assert.equal(b.heldBy?.ownerId, 'A');
  assert.equal(b.heldBy?.generation, 1);
});

test('an expired lease is reclaimable and the reclaim bumps generation', async () => {
  const clock = fakeClock();
  const provider = createMemoryCoordinationProvider({ now: clock.now });
  const r = coordinationResourceId('schedule', 's1', 42);

  const a = await provider.acquire(r, 'A', 10_000);
  assert.ok(a.ok && a.lease);
  assert.equal(a.lease.generation, 1);

  clock.advance(10_001);
  assert.equal(await provider.inspect(r), null, 'expired lease reads as unclaimed');

  const b = await provider.acquire(r, 'B', 10_000);
  assert.ok(b.ok && b.lease);
  assert.equal(b.lease.ownerId, 'B');
  assert.equal(b.lease.generation, 2, 'generation is strictly increasing across a reclaim');
});

test('renew is owner-specific and cannot revive an expired lease', async () => {
  const clock = fakeClock();
  const provider = createMemoryCoordinationProvider({ now: clock.now });
  const r = coordinationResourceId('effect', 'e2');

  const a = await provider.acquire(r, 'A', 10_000);
  assert.ok(a.ok && a.lease);

  assert.equal(await provider.renew(r, 'not-the-token', 10_000), false);
  clock.advance(5_000); // t = start + 5_000
  assert.equal(await provider.renew(r, a.lease.token, 10_000), true); // now expires at start + 15_000

  clock.advance(9_999); // t = start + 14_999 — still inside the window
  assert.notEqual(await provider.inspect(r), null);
  clock.advance(2); // t = start + 15_001 — past it
  assert.equal(await provider.inspect(r), null);
  assert.equal(await provider.renew(r, a.lease.token, 10_000), false, 'no reviving an expired lease');
});

test('release frees the claim but never rewinds generation', async () => {
  const provider = createMemoryCoordinationProvider({ now: fakeClock().now });
  const r = coordinationResourceId('effect', 'e3');

  const a = await provider.acquire(r, 'A', 30_000);
  assert.ok(a.ok && a.lease);
  await provider.release(r, 'stale-token'); // no-op
  assert.notEqual(await provider.inspect(r), null);

  await provider.release(r, a.lease.token);
  assert.equal(await provider.inspect(r), null);

  const b = await provider.acquire(r, 'B', 30_000);
  assert.ok(b.ok && b.lease);
  assert.equal(b.lease.generation, 2, 'generation keeps climbing across release + re-acquire');
});

test('checkOwnership distinguishes current / fenced / expired / not-owner / unknown', async () => {
  const clock = fakeClock();
  const provider = createMemoryCoordinationProvider({ now: clock.now });
  const r = coordinationResourceId('subscription', 'sub1');

  assert.deepEqual(
    (await provider.checkOwnership(r, 'A', 1)).reason,
    'unknown-resource',
    'nothing ever claimed here',
  );

  const a = await provider.acquire(r, 'A', 10_000);
  assert.ok(a.ok && a.lease);
  const current = await provider.checkOwnership(r, 'A', a.lease.generation);
  assert.equal(current.current, true);

  const wrongOwner = await provider.checkOwnership(r, 'B', a.lease.generation);
  assert.equal(wrongOwner.current, false);
  assert.equal(wrongOwner.reason, 'not-owner');

  // A stalls, B reclaims → A's generation is now stale/fenced.
  clock.advance(10_001);
  const b = await provider.acquire(r, 'B', 10_000);
  assert.ok(b.ok && b.lease);
  const fenced = await provider.checkOwnership(r, 'A', a.lease.generation);
  assert.equal(fenced.current, false);
  assert.equal(fenced.reason, 'fenced', 'a newer generation exists — the old owner is fenced');
  assert.equal(fenced.lease?.ownerId, 'B');

  // B lets its lease lapse without anyone reclaiming.
  clock.advance(10_001);
  const expired = await provider.checkOwnership(r, 'B', b.lease.generation);
  assert.equal(expired.current, false);
  assert.equal(expired.reason, 'expired');
});

test('list is prefix-scoped and reports liveness', async () => {
  const clock = fakeClock();
  const provider = createMemoryCoordinationProvider({ now: clock.now });
  await provider.acquire(coordinationResourceId('effect', 'e1'), 'A', 10_000);
  await provider.acquire(coordinationResourceId('effect', 'e2'), 'B', 10_000);
  await provider.acquire(coordinationResourceId('schedule', 's1'), 'A', 10_000);

  const effects = await provider.list('effect:');
  assert.deepEqual(
    effects.map((v) => v.resourceId),
    ['effect:e1', 'effect:e2'],
  );
  assert.ok(effects.every((v) => v.live));

  clock.advance(10_001);
  const stale = await provider.list('effect:');
  assert.ok(stale.every((v) => !v.live), 'expired claims still list, marked not live');

  assert.equal((await provider.list()).length, 3, 'no prefix → every known claim');
});

test('multiple simulated authorities share one provider and race a single resource', async () => {
  const provider = createMemoryCoordinationProvider({ now: fakeClock().now });
  const r = coordinationResourceId('effect', 'contended');

  const results = await Promise.all(
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => provider.acquire(r, id, 30_000)),
  );
  const winners = results.filter((res) => res.ok);
  assert.equal(winners.length, 1, 'exactly one authority wins the claim');
  assert.equal(winners[0]?.lease?.generation, 1);
});

test('validateCoordinationConfig rejects an unsafe renew cadence (§90)', () => {
  assert.deepEqual(validateCoordinationConfig({}), [], 'defaults are safe');

  const equal = validateCoordinationConfig({ leaseDurationMs: 10_000, renewIntervalMs: 10_000 });
  assert.ok(equal.some((p) => p.includes('must be < leaseDurationMs')));

  const tooClose = validateCoordinationConfig({ leaseDurationMs: 10_000, renewIntervalMs: 6_000 });
  assert.ok(tooClose.some((p) => p.includes('tolerate one lost renewal')));

  assert.deepEqual(
    validateCoordinationConfig({ leaseDurationMs: 30_000, renewIntervalMs: 10_000 }),
    [],
  );

  assert.throws(
    () => resolveCoordinationConfig({ renewIntervalMs: 999_999 }),
    /Unsafe coordination configuration/,
  );
  assert.equal(resolveCoordinationConfig().leaseDurationMs, DEFAULT_COORDINATION_CONFIG.leaseDurationMs);
});

test('coordination diagnostic codes are the spec12 §87 set and carry no provider vocabulary', () => {
  assert.deepEqual(
    [...COORDINATION_DIAGNOSTIC_CODES].sort(),
    ['EVENT_ID_CONFLICT', 'INCOMPATIBLE_AUTHORITY', 'WORK_FENCED', 'WORK_IN_PROGRESS', 'WORK_NOT_CLAIMABLE'],
  );
  for (const code of COORDINATION_DIAGNOSTIC_CODES) {
    assert.doesNotMatch(code, /SQLITE|REDIS|LOCK_LOST|CONDITIONAL/i);
  }
});
