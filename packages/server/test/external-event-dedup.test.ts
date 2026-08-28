import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalJson,
  createMemoryExternalEventDedupStore,
  createSqliteExternalEventDedupStore,
  isSqliteExternalEventDedupAvailable,
  payloadFingerprint,
} from '@cynodia/axiom-server';
import type { ExternalEventDedupStore } from '@cynodia/axiom-server';

/**
 * Spec12 §25, §26, §73: external-event ingestion deduplication.
 *
 * The memory store is the semantic reference; the SQLite store must implement the same
 * contract (spec12 §63). Every behavioural test runs against both via `bothStores`. The
 * real cross-process race lives in `external-event-dedup-race.test.ts`.
 */

const available = await isSqliteExternalEventDedupAvailable();

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

async function bothStores(
  clock: ReturnType<typeof fakeClock>,
  body: (store: ExternalEventDedupStore, label: string) => Promise<void>,
  options: { windowPerSource?: number } = {},
): Promise<void> {
  await body(createMemoryExternalEventDedupStore({ now: clock.now, ...options }), 'memory');
  if (!available) return;
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-dedup-'));
  const store = await createSqliteExternalEventDedupStore({
    location: path.join(dir, 'dedup.db'),
    now: clock.now,
    ...options,
  });
  await body(store, 'sqlite');
  await store.close?.();
  rmSync(dir, { recursive: true, force: true });
}

test('canonicalJson sorts keys recursively; fingerprint is order-independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(
    payloadFingerprint({ x: 1, y: [{ b: 2, a: 1 }] }),
    payloadFingerprint({ y: [{ a: 1, b: 2 }], x: 1 }),
    'key order does not change the fingerprint',
  );
  assert.notEqual(payloadFingerprint({ x: 1 }), payloadFingerprint({ x: 2 }));
});

test('first delivery is accepted, a byte-equal repeat is a duplicate (spec12 §25)', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    const first = await store.admit({ source: 'stripe', externalEventId: 'evt_1', payload: { amount: 100 } });
    assert.equal(first.status, 'accepted', `${label}: first is accepted`);

    const again = await store.admit({ source: 'stripe', externalEventId: 'evt_1', payload: { amount: 100 } });
    assert.equal(again.status, 'duplicate', `${label}: exact repeat is a duplicate`);

    // key-reordered payload is still the same event
    const reordered = await store.admit({ source: 'stripe', externalEventId: 'evt_1', payload: { amount: 100 } });
    assert.equal(reordered.status, 'duplicate', `${label}: canonicalized payload still deduplicates`);
  });
});

test('same id with a different payload is an explicit EVENT_ID_CONFLICT (spec12 §73)', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    await store.admit({ source: 'stripe', externalEventId: 'evt_9', payload: { amount: 100 } });
    const conflict = await store.admit({
      source: 'stripe',
      externalEventId: 'evt_9',
      payload: { amount: 999 },
    });
    assert.equal(conflict.status, 'conflict', `${label}: not silently accepted as a second event`);
    assert.equal(conflict.status === 'conflict' && conflict.code, 'EVENT_ID_CONFLICT', `${label}`);
    assert.notEqual(
      conflict.status === 'conflict' && conflict.storedFingerprint,
      conflict.status === 'conflict' && conflict.incomingFingerprint,
      `${label}: the diagnostic carries both fingerprints`,
    );
  });
});

test('a delivery with no stable external id is unidentified — at-least-once, never synthesized (spec12 §26)', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    const a = await store.admit({ source: 'legacy-hook', payload: { n: 1 } });
    const b = await store.admit({ source: 'legacy-hook', payload: { n: 1 } });
    assert.equal(a.status, 'unidentified', `${label}: no id => unidentified`);
    assert.equal(b.status, 'unidentified', `${label}: still unidentified — no false uniqueness from a repeat`);
    assert.equal((await store.list('legacy-hook')).length, 0, `${label}: nothing is recorded for an unidentified source`);
  });
});

test('deduplication is scoped per source — the same id from two sources is two events', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    assert.equal(
      (await store.admit({ source: 'stripe', externalEventId: 'x', payload: {} })).status,
      'accepted',
      label,
    );
    assert.equal(
      (await store.admit({ source: 'github', externalEventId: 'x', payload: {} })).status,
      'accepted',
      `${label}: a different source with the same id is a different event`,
    );
  });
});

test('the per-source window is bounded — an id that fell out is treated as new (spec12 §26)', async () => {
  const clock = fakeClock();
  await bothStores(
    clock,
    async (store, label) => {
      for (const id of ['a', 'b', 'c']) {
        clock.advance(1);
        await store.admit({ source: 's', externalEventId: id, payload: { id } });
      }
      // window is 2 → 'a' has fallen out
      assert.equal((await store.list('s')).length, 2, `${label}: window bounded to 2`);
      const readmitA = await store.admit({ source: 's', externalEventId: 'a', payload: { id: 'a' } });
      assert.equal(readmitA.status, 'accepted', `${label}: an evicted id is admitted fresh (bounded, not exactly-once)`);
    },
    { windowPerSource: 2 },
  );
});

test('list is newest-first and source-scoped', async () => {
  const clock = fakeClock();
  await bothStores(clock, async (store, label) => {
    clock.advance(1);
    await store.admit({ source: 's1', externalEventId: 'old', payload: {} });
    clock.advance(1);
    await store.admit({ source: 's1', externalEventId: 'new', payload: {} });
    clock.advance(1);
    await store.admit({ source: 's2', externalEventId: 'other', payload: {} });

    assert.deepEqual(
      (await store.list('s1')).map((r) => r.externalEventId),
      ['new', 'old'],
      `${label}: newest first, only s1`,
    );
    assert.equal((await store.list()).length, 3, `${label}: unscoped list sees all sources`);
  });
});
