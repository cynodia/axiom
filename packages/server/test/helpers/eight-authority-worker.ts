import {
  createDurableWorkStore,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
} from '@cynodia/axiom-server';

/**
 * One authority process in the spec12 §81 eight-authority chaos test.
 *
 *   node eight-authority-worker.js <coordDb> <workDb> <ownerId>
 *
 * Repeatedly claims small batches across THREE work classes — `effect`, `schedule-firing`,
 * `generic` — and settles each succeeded, until every class has been idle for several rounds.
 * Prints `{ ownerId, settled: { effect, "schedule-firing", generic } }`. A raw SQLite error
 * must never escape.
 */

const CLASSES = ['effect', 'schedule-firing', 'generic'] as const;
const BATCH = 16;
const LEASE = 10_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const [coordDb, workDb, ownerId] = process.argv.slice(2);
  const coordination = await createSqliteCoordinationProvider({ location: coordDb });
  const storage = await createSqliteDurableWorkStorage({ location: workDb });
  const store = createDurableWorkStore({ coordination, storage });
  const settled: Record<string, number> = { effect: 0, 'schedule-firing': 0, generic: 0 };

  try {
    let idleRounds = 0;
    while (idleRounds < 6) {
      let didSomething = false;
      for (const workClass of CLASSES) {
        const claimed = await store.claim(workClass, ownerId ?? 'anon', { batchSize: BATCH, leaseMs: LEASE });
        if (claimed.length > 0) didSomething = true;
        for (const claim of claimed) {
          const res = await store.settle(claim, { kind: 'succeeded', result: null });
          if (res.ok) settled[workClass] = (settled[workClass] ?? 0) + 1;
        }
      }
      idleRounds = didSomething ? 0 : idleRounds + 1;
      await sleep(15);
    }
    process.stdout.write(JSON.stringify({ ownerId, settled }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ownerId, thrown: true, errorCode: (error as { code?: string })?.code }));
  } finally {
    await coordination.close?.();
    await storage.close?.();
  }
}

void main();
