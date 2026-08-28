import {
  createSqliteCoordinationProvider,
  createSqliteCursorPositionStore,
  createSubscriptionCursorStore,
} from '@cynodia/axiom-server';

/**
 * One authority process in the spec12 §75 cursor-fencing test.
 *
 *   node subscription-cursor-race-worker.js <coordDb> <cursorDb> <mode> <ownerId> <leaseMs>
 *
 * Modes:
 *  - `hold`  — acquire `sub`, advance the cursor to 10, send `{ type: 'acquired', generation }`,
 *              then wait. It never renews, so its lease lapses. On IPC `{ type: 'advance', to }`
 *              it attempts `advance` with its (now stale) generation and reports
 *              `{ type: 'advanced', ok, reason }`.
 *  - `take`  — acquire `sub` (reclaiming an expired lease), advance to 25, print
 *              `{ generation, resumeFrom }`, exit.
 *
 * A raw SQLite error must never escape.
 */

const SUB = 'sub';

async function build(coordDb: string, cursorDb: string) {
  const coordination = await createSqliteCoordinationProvider({ location: coordDb });
  const positions = await createSqliteCursorPositionStore({ location: cursorDb });
  return { coordination, positions, store: createSubscriptionCursorStore({ coordination, positions }) };
}

async function main(): Promise<void> {
  const [coordDb, cursorDb, mode, ownerId, leaseRaw] = process.argv.slice(2);
  const leaseMs = Number(leaseRaw ?? 1_000);
  const send = (m: unknown): void => void process.send?.(m);
  const { coordination, positions, store } = await build(coordDb, cursorDb);

  try {
    const acquired = await store.acquire(SUB, ownerId, leaseMs);
    if (!acquired.ok) {
      if (mode === 'take') process.stdout.write(JSON.stringify({ blocked: true }));
      else send({ type: 'acquired', ok: false });
      await coordination.close?.();
      await positions.close?.();
      return;
    }
    const generation = acquired.ownership.generation;

    if (mode === 'take') {
      await store.advance(SUB, ownerId, generation, 25);
      process.stdout.write(JSON.stringify({ generation, resumeFrom: acquired.ownership.resumeFrom }));
      await coordination.close?.();
      await positions.close?.();
      return;
    }

    // hold
    await store.advance(SUB, ownerId, generation, 10);
    send({ type: 'acquired', ok: true, generation });
    process.on('message', (message: { type?: string; to?: number }) => {
      if (message?.type !== 'advance') return;
      void (async () => {
        const result = await store.advance(SUB, ownerId, generation, message.to ?? 11);
        send({ type: 'advanced', ok: result.ok, reason: result.ok ? null : result.reason });
        await coordination.close?.();
        await positions.close?.();
        process.exit(0);
      })();
    });
    setInterval(() => {}, 1 << 30);
  } catch (error) {
    const structured = error as { code?: string };
    if (mode === 'take') process.stdout.write(JSON.stringify({ thrown: true, errorCode: structured?.code }));
    else send({ type: 'acquired', ok: false, thrown: true, errorCode: structured?.code });
    await coordination.close?.();
    await positions.close?.();
  }
}

void main();
