import {
  createDurableWorkStore,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
} from '@cynodia/axiom-server';

/**
 * One authority process in the spec12 §18, §68, §69 durable-work fencing tests.
 *
 *   node durable-work-race-worker.js <coordDbPath> <workDbPath> <mode> <ownerId> <leaseMs>
 *
 * Modes:
 *  - `seed` — enqueue the single contended work item, print `ok`, exit.
 *  - `claim-hold` — claim the item, send `{ type: 'claimed', generation, attemptNumber }`,
 *    then wait. It never renews, so its lease lapses. On IPC `{ type: 'settle' }` it attempts
 *    `store.settle(...)` with its (possibly stale) claim and reports the outcome — the
 *    stale-owner-resumes scenario. The parent may `SIGKILL` it at any point.
 *  - `race-claim-settle` — claim whatever is eligible, immediately settle it succeeded, and
 *    print a single JSON line: `{ ownerId, claimed, generation, settled, reason }`.
 *
 * A raw `SQLITE_BUSY` / `ERR_SQLITE_ERROR` must never escape.
 */

const WORK_CLASS = 'effect';
const WORK_ID = 'contended';

async function build(coordDbPath: string, workDbPath: string) {
  const coordination = await createSqliteCoordinationProvider({ location: coordDbPath });
  const storage = await createSqliteDurableWorkStorage({ location: workDbPath });
  return { coordination, storage, store: createDurableWorkStore({ coordination, storage }) };
}

async function main(): Promise<void> {
  const [coordDbPath, workDbPath, mode, ownerId, leaseRaw] = process.argv.slice(2);
  const leaseMs = Number(leaseRaw ?? 1_000);
  const send = (message: unknown): void => void process.send?.(message);
  const { coordination, storage, store } = await build(coordDbPath, workDbPath);

  try {
    if (mode === 'seed') {
      await store.enqueue({ workClass: WORK_CLASS, workId: WORK_ID, payload: { to: 'x' } });
      process.stdout.write('ok');
      await coordination.close?.();
      await storage.close?.();
      return;
    }

    if (mode === 'race-claim-settle') {
      const [claim] = await store.claim(WORK_CLASS, ownerId, { leaseMs, batchSize: 1 });
      if (!claim) {
        process.stdout.write(JSON.stringify({ ownerId, claimed: false }));
        await coordination.close?.();
        await storage.close?.();
        return;
      }
      const settled = await store.settle(claim, { kind: 'succeeded', result: `${ownerId}-result` });
      process.stdout.write(
        JSON.stringify({
          ownerId,
          claimed: true,
          generation: claim.generation,
          settled: settled.ok,
          reason: settled.ok ? null : settled.reason,
        }),
      );
      await coordination.close?.();
      await storage.close?.();
      return;
    }

    // claim-hold
    const [claim] = await store.claim(WORK_CLASS, ownerId, { leaseMs, batchSize: 1 });
    send({
      type: 'claimed',
      claimed: Boolean(claim),
      generation: claim?.generation ?? null,
      attemptNumber: claim?.item.attemptNumber ?? null,
    });
    process.on('message', (message: { type?: string }) => {
      if (message?.type !== 'settle') return;
      void (async () => {
        try {
          const result = claim
            ? await store.settle(claim, { kind: 'succeeded', result: `${ownerId}-result` })
            : ({ ok: false, reason: 'not-claimed' } as const);
          send({ type: 'settled', ok: result.ok, reason: result.ok ? null : result.reason });
        } catch (error) {
          send({ type: 'settled', ok: false, reason: 'threw', code: (error as { code?: string })?.code });
        }
        await coordination.close?.();
        await storage.close?.();
        process.exit(0);
      })();
    });
    setInterval(() => {}, 1 << 30); // keep alive until settled or killed
  } catch (error) {
    const structured = error as { name?: string; code?: string };
    if (mode === 'race-claim-settle' || mode === 'seed') {
      process.stdout.write(JSON.stringify({ ownerId, thrown: true, errorCode: structured?.code }));
    } else {
      send({ type: 'claimed', claimed: false, thrown: true, errorCode: structured?.code });
    }
    await coordination.close?.();
    await storage.close?.();
  }
}

void main();
