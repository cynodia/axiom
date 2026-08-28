import { createSqliteCoordinationProvider } from '@cynodia/axiom-server';

/**
 * One authority process in the spec12 §67-§68, §71 cross-process coordination tests.
 *
 *   node coordination-race-worker.js <dbPath> <mode> <ownerId> <barrierEpochMs> <leaseMs>
 *
 * Modes:
 *  - `race` — spin until the barrier, `acquire` the contended resource once, print a single
 *    JSON line, exit. Used to prove exactly one winner among N racers.
 *  - `hold` — `acquire`, send `{ type: 'acquired', ... }` over IPC, then wait. On IPC
 *    `{ type: 'probe' }` it attempts `renew` + `checkOwnership` and reports them (the
 *    stale-owner-resumes scenario, §68). It never renews on its own, so its lease lapses —
 *    and the parent may `SIGKILL` it at any point (§67).
 *
 * It must never let a raw `SQLITE_BUSY` / `ERR_SQLITE_ERROR` escape.
 */

const RESOURCE = 'effect:contended';

async function main(): Promise<void> {
  const [dbPath, mode, ownerId, barrierRaw, leaseRaw] = process.argv.slice(2);
  const barrierAt = Number(barrierRaw ?? 0);
  const leaseMs = Number(leaseRaw ?? 1_000);
  const send = (message: unknown): void => {
    process.send?.(message);
  };

  const provider = await createSqliteCoordinationProvider({ location: dbPath });

  // Align the processes on the barrier without starving the scheduler: sleep until just
  // before it, then a short final spin. A tight spin for the whole window pegs every core
  // and, with many peers, can get a process OOM/SIGKILLed before it ever calls `acquire`.
  const coarse = barrierAt - Date.now() - 5;
  if (coarse > 0) {
    await new Promise((resolve) => setTimeout(resolve, coarse));
  }
  while (Date.now() < barrierAt) {
    /* short final spin to tighten alignment */
  }

  try {
    const result = await provider.acquire(RESOURCE, ownerId, leaseMs);
    if (mode === 'race') {
      process.stdout.write(
        JSON.stringify({
          ownerId,
          ok: result.ok,
          generation: result.lease?.generation ?? null,
          heldBy: result.heldBy?.ownerId ?? null,
        }),
      );
      await provider.close?.();
      return;
    }

    // hold mode
    send({ type: 'acquired', ok: result.ok, token: result.lease?.token ?? null, generation: result.lease?.generation ?? null });
    process.on('message', (message: { type?: string }) => {
      if (message?.type !== 'probe') return;
      void (async () => {
        const renewed = result.lease
          ? await provider.renew(RESOURCE, result.lease.token, leaseMs)
          : false;
        const check = await provider.checkOwnership(RESOURCE, ownerId, result.lease?.generation ?? -1);
        send({ type: 'probed', renewed, current: check.current, reason: check.reason ?? null });
        await provider.close?.();
        process.exit(0);
      })();
    });
    // keep the event loop alive until probed or killed
    setInterval(() => {}, 1 << 30);
  } catch (error) {
    const structured = error as { name?: string; code?: string; message?: string };
    if (mode === 'race') {
      process.stdout.write(
        JSON.stringify({ ownerId, ok: false, thrown: true, errorName: structured?.name, errorCode: structured?.code }),
      );
    } else {
      send({ type: 'acquired', ok: false, thrown: true, errorCode: structured?.code });
    }
    await provider.close?.();
  }
}

void main();
