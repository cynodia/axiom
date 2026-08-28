import {
  createDurableWorkStore,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
} from '@cynodia/axiom-server';

/**
 * One authority process in the spec12 §78 mixed-build test.
 *
 *   node mixed-build-worker.js <coordDb> <workDb> <mode> <authorityKey> <ownerId>
 *
 * Modes:
 *  - `seed`      — enqueue one `effect` work item stamped with this build's `authorityKey`.
 *  - `try-claim` — claim `effect` work for `ownerId`; print `{ claimed, incompatible }` where
 *                  `incompatible` is how many items this build sees stranded for it.
 *
 * A raw SQLite error must never escape.
 */

async function main(): Promise<void> {
  const [coordDb, workDb, mode, authorityKey, ownerId] = process.argv.slice(2);
  const coordination = await createSqliteCoordinationProvider({ location: coordDb });
  const storage = await createSqliteDurableWorkStorage({ location: workDb });
  const store = createDurableWorkStore({ coordination, storage, authorityKey });

  try {
    if (mode === 'seed') {
      const { item } = await store.enqueue({ workClass: 'effect', workId: 'mb1', payload: { to: 'x' } });
      process.stdout.write(JSON.stringify({ stampedKey: item.compatibilityKey }));
    } else {
      const claimed = await store.claim('effect', ownerId ?? 'anon', { leaseMs: 30_000 });
      const incompatible = await store.listIncompatible('effect');
      process.stdout.write(
        JSON.stringify({ claimed: claimed.map((c) => c.item.workId), incompatible: incompatible.map((r) => r.workId) }),
      );
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ thrown: true, errorCode: (error as { code?: string })?.code }));
  } finally {
    await coordination.close?.();
    await storage.close?.();
  }
}

void main();
