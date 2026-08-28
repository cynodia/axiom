import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDurableWorkStore,
  createMemoryCoordinationProvider,
  createMemoryDurableWorkStorage,
} from '@cynodia/axiom-server';

/**
 * spec12 §80: the large-queue boundedness / correctness test.
 *
 * Several authorities drain a large pending queue, each polling in bounded batches.
 * Verifies: claim batches never exceed the configured size; every item completes exactly
 * once (no duplicate completion); no item is starved by a stale lease; peak in-memory
 * claimed set per authority stays bounded (= batch size). Not a benchmark.
 *
 * The routine run uses 50_000 items (~3.5s); the pre-release run sets
 * `AXIOM_LARGE_QUEUE=100000` for the full spec12 §80 count.
 */

const TOTAL = Math.max(1_000, Number(process.env.AXIOM_LARGE_QUEUE ?? 50_000));
const AUTHORITIES = 4;
const BATCH = 64;
const LEASE = 5_000;

test(
  `${TOTAL} pending items drained by ${AUTHORITIES} authorities — bounded batches, exactly-once completion, no starvation`,
  async () => {
    let t = 1_000;
    const now = () => t;
    const coordination = createMemoryCoordinationProvider({ now });
    const storage = createMemoryDurableWorkStorage();
    const store = createDurableWorkStore({ coordination, storage, now, defaultLeaseMs: LEASE });

    // Enqueue TOTAL pending items.
    for (let i = 0; i < TOTAL; i += 1) {
      await store.enqueue({ workClass: 'effect', workId: `w${i}`, payload: { i } });
    }

    const settledBy = new Map<string, string>(); // workId -> authority that settled it
    let doubleSettles = 0;
    let maxBatchObserved = 0;

    // Round-robin the authorities; a stale lease (an authority that "pauses") must not strand
    // work — periodically advance the clock past a lease so any unrenewed claim is reclaimed.
    let round = 0;
    const maxRounds = Math.ceil(TOTAL / BATCH) * 4 + 100;
    while (settledBy.size < TOTAL) {
      round += 1;
      for (let a = 0; a < AUTHORITIES; a += 1) {
        const owner = `auth-${a}`;
        const claimed = await store.claim('effect', owner, { batchSize: BATCH, leaseMs: LEASE });
        maxBatchObserved = Math.max(maxBatchObserved, claimed.length);
        assert.ok(claimed.length <= BATCH, `claim batch ${claimed.length} exceeded ${BATCH}`);

        // Authority 3 "pauses" every few rounds: it claims but does not settle, so its lease
        // must lapse and another authority reclaims — no starvation.
        const paused = a === 3 && round % 5 === 0;
        if (paused) continue;

        for (const claim of claimed) {
          const res = await store.settle(claim, { kind: 'succeeded', result: null });
          if (res.ok) {
            if (settledBy.has(claim.item.workId)) doubleSettles += 1;
            settledBy.set(claim.item.workId, owner);
          }
          // A fenced settle (someone reclaimed a paused claim) is expected and fine.
        }
      }
      // Move time forward each round so paused claims become reclaimable.
      t += 2_000;
      assert.ok(round < maxRounds, `made progress: ${settledBy.size}/${TOTAL} after ${round} rounds`);
    }

    assert.equal(settledBy.size, TOTAL, 'every item completed');
    assert.equal(doubleSettles, 0, 'no item was completed twice');
    assert.ok(maxBatchObserved <= BATCH, 'claim batches stayed bounded');

    // Every item is durably terminal.
    let nonTerminal = 0;
    for (let i = 0; i < TOTAL; i += 1) {
      const item = await store.get('effect', `w${i}`);
      if (!item || item.state !== 'succeeded') nonTerminal += 1;
    }
    assert.equal(nonTerminal, 0, 'no item left non-terminal (no starvation)');
  },
);
