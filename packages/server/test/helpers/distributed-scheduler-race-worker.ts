import { appendFileSync } from 'node:fs';
import {
  SCHEDULE_FIRING_WORK_CLASS,
  createDistributedScheduler,
  createDurableWorkStore,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
} from '@cynodia/axiom-server';

/**
 * One authority process in the spec12 §21, §71, §72, §83 distributed-scheduler tests.
 *
 *   node distributed-scheduler-race-worker.js <coordDb> <workDb> <ledger> <mode> <instanceId> <nowMs> [leaseMs]
 *
 * The schedule is a fixed `interval` of `everyMs = 1000`; `<nowMs>` is the frozen wall clock
 * this worker uses (so a whole test run pins the same due instant across processes). The
 * scheduled action's only side effect is appending `<dueInstant>\n` to `<ledger>`.
 *
 * Modes: `run` — poll until the ledger has the boundary or a bounded number of rounds, print
 * `{ instanceId, fired, finalStates }`. `run-slow` — the fire callback sleeps SLOW_MS first,
 * so the parent can SIGKILL this process mid-firing.
 */

const EVERY_MS = 1_000;
const SLOW_MS = 4_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const [coordDb, workDb, ledger, mode, instanceId, nowRaw, leaseRaw] = process.argv.slice(2);
  const nowMs = Number(nowRaw);
  const coordination = await createSqliteCoordinationProvider({ location: coordDb });
  const storage = await createSqliteDurableWorkStorage({ location: workDb });
  const store = createDurableWorkStore({ coordination, storage, now: () => nowMs });

  const scheduler = createDistributedScheduler({
    store,
    instanceId: instanceId ?? 'anon',
    epoch: 0,
    now: () => nowMs,
    config: { leaseDurationMs: Number(leaseRaw ?? 30_000), renewIntervalMs: 400 },
    fire: async (_scheduleId, dueInstant) => {
      if (mode === 'run-slow') await sleep(SLOW_MS);
      appendFileSync(ledger, `${dueInstant}\n`);
      return { ok: true };
    },
  });
  scheduler.register({ scheduleId: 'trg', kind: 'interval', everyMs: EVERY_MS });

  try {
    let fired = 0;
    for (let round = 0; round < 40; round += 1) {
      fired += await scheduler.poll();
      const boundary = Math.floor(nowMs / EVERY_MS) * EVERY_MS;
      const item = await store.get(SCHEDULE_FIRING_WORK_CLASS, `trg@${boundary}`);
      if (item && (item.state === 'succeeded' || item.state === 'failed')) break;
      await sleep(40);
    }
    const boundary = Math.floor(nowMs / EVERY_MS) * EVERY_MS;
    const item = await store.get(SCHEDULE_FIRING_WORK_CLASS, `trg@${boundary}`);
    process.stdout.write(
      JSON.stringify({
        instanceId: instanceId ?? 'anon',
        fired,
        finalState: item?.state ?? null,
        attemptNumber: item?.attemptNumber ?? 0,
        uncertainAttempts: item?.uncertainAttempts ?? 0,
      }),
    );
  } catch (error) {
    process.stdout.write(JSON.stringify({ thrown: true, errorCode: (error as { code?: string })?.code }));
  } finally {
    await coordination.close?.();
    await storage.close?.();
  }
}

void main();
