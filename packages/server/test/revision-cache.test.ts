import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CACHE_COHERENCE,
  createRevisionObservingCache,
  createMemoryPersistence,
  createSqlitePersistence,
} from '@cynodia/axiom-server';
import { nodeId } from '@cynodia/axiom-core';

/**
 * Spec12 §32-§34, §76-§77: cache coherence by durable revision observation.
 */

test('CACHE_COHERENCE is the machine-readable contract: durable revision, bound 0, no broadcast needed', () => {
  assert.deepEqual(CACHE_COHERENCE, {
    mechanism: 'durable-revision-observation',
    stalenessBoundRevisions: 0,
    requiresBroadcast: false,
    checkPerRead: true,
  });
});

test('an entry is served while the persisted revision is unchanged, and dropped once it advances', () => {
  const cache = createRevisionObservingCache<{ rows: number[] }>();
  cache.set('q1', { rows: [1, 2, 3] }, 5);

  assert.deepEqual(cache.get('q1', 5), { rows: [1, 2, 3] }, 'served at the revision it was computed at');
  assert.deepEqual(cache.get('q1', 5), { rows: [1, 2, 3] }, 'still served — nothing committed');

  // Another authority committed: persisted revision is now 6.
  assert.equal(cache.get('q1', 6), undefined, 'a behind entry is not served');
  assert.equal(cache.stats().staleEvictions, 1);
  assert.equal(cache.get('q1', 6), undefined, 'and it was evicted, not left to rot');
});

test('lost invalidation: correctness does not depend on invalidate() ever being called (spec12 §77)', () => {
  const cache = createRevisionObservingCache<number>();
  cache.set('k', 42, 10);
  // Simulate a dropped invalidation notification: we never call cache.invalidate().
  // The persisted revision still advanced because some other authority committed.
  assert.equal(cache.get('k', 10), 42);
  assert.equal(cache.get('k', 11), undefined, 'stale detected purely from the durable revision');
});

test('returned values are copies — a caller mutating the result cannot poison the cache', () => {
  const cache = createRevisionObservingCache<{ rows: number[] }>();
  cache.set('q', { rows: [1] }, 1);
  const first = cache.get('q', 1)!;
  first.rows.push(999);
  assert.deepEqual(cache.get('q', 1), { rows: [1] }, 'the cached value is untouched');
});

test('LRU bound is enforced', () => {
  const cache = createRevisionObservingCache<number>({ maxEntries: 2 });
  cache.set('a', 1, 1);
  cache.set('b', 2, 1);
  cache.get('a', 1); // touch a → b is now least-recently-used
  cache.set('c', 3, 1); // evicts b
  assert.equal(cache.get('a', 1), 1);
  assert.equal(cache.get('b', 1), undefined);
  assert.equal(cache.get('c', 1), 3);
});

test('cross-instance read-after-write: a cache over a shared persistence sees B\'s commit (spec12 §34, §76)', async () => {
  const runWith = async (revisionOf: () => Promise<number>, commit: () => Promise<void>) => {
    const cacheA = createRevisionObservingCache<string>();
    // A computes and caches a result at the current revision.
    cacheA.set('ownOrders', 'A-computed', await revisionOf());
    assert.equal(cacheA.get('ownOrders', await revisionOf()), 'A-computed', 'fresh right after caching');

    // B commits a mutation through the same persistence.
    await commit();

    // A serves the next read: the durable revision advanced, so the cache misses and A
    // must recompute against authoritative data — no stale-read mode from topology.
    assert.equal(cacheA.get('ownOrders', await revisionOf()), undefined, 'A no longer serves the stale entry');
  };

  // memory persistence
  const mem = createMemoryPersistence([{ stateId: nodeId('state_orders'), value: [], revision: 0 }]);
  await runWith(
    () => mem.revision(),
    async () => {
      const r = await mem.revision();
      await mem.commit({
        writes: [{ stateId: nodeId('state_orders'), value: [{ id: 1 }] }],
        expected: { [nodeId('state_orders')]: r },
      });
    },
  );

  // sqlite persistence, two independent connections to one file (stand-ins for two authorities)
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-revcache-'));
  try {
    const seedA = await createSqlitePersistence({ location: path.join(dir, 'state.db') });
    // seed a state row so there is something to commit against
    await seedA.commit({
      writes: [{ stateId: nodeId('state_orders'), value: [] }],
      expected: { [nodeId('state_orders')]: 0 },
    });
    const authorityB = await createSqlitePersistence({ location: path.join(dir, 'state.db') });
    await runWith(
      () => seedA.revision(),
      async () => {
        const r = await authorityB.revision();
        const outcome = await authorityB.commit({
          writes: [{ stateId: nodeId('state_orders'), value: [{ id: 7 }] }],
          expected: { [nodeId('state_orders')]: r },
        });
        assert.ok(outcome.committed, 'B committed through its own connection');
      },
    );
    await seedA.close?.();
    await authorityB.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
