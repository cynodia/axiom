import { createSqliteExternalEventDedupStore } from '@cynodia/axiom-server';

/**
 * One authority process in the spec12 §73 external-event dedup race test.
 *
 *   node external-event-dedup-race-worker.js <dedupDb> <source> <externalEventId> <payloadJson> <barrierEpochMs>
 *
 * It spins to the barrier, calls `admit` once, prints `{ status, code? }`, exits. A raw
 * SQLite error must never escape.
 */

async function main(): Promise<void> {
  const [dedupDb, source, externalEventId, payloadJson, barrierRaw] = process.argv.slice(2);
  const store = await createSqliteExternalEventDedupStore({ location: dedupDb });
  try {
    const barrierAt = Number(barrierRaw ?? 0);
    const coarse = barrierAt - Date.now() - 3;
    if (coarse > 0) await new Promise((r) => setTimeout(r, coarse));
    while (Date.now() < barrierAt) {
      /* short final spin */
    }
    const outcome = await store.admit({
      source,
      externalEventId,
      payload: JSON.parse(payloadJson),
    });
    process.stdout.write(
      JSON.stringify({
        status: outcome.status,
        code: outcome.status === 'conflict' ? outcome.code : undefined,
      }),
    );
  } catch (error) {
    process.stdout.write(JSON.stringify({ thrown: true, errorCode: (error as { code?: string })?.code }));
  } finally {
    await store.close?.();
  }
}

void main();
