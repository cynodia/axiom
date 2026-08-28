import { appendFileSync } from 'node:fs';
import {
  EFFECT_WORK_CLASS,
  createDistributedEffectRunner,
  createDurableWorkStore,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
} from '@cynodia/axiom-server';
import type { IntegrationAdapter, IntegrationResult } from '@cynodia/axiom-server';

/**
 * One authority process in the spec12 §17, §66, §83 distributed-outbox tests.
 *
 *   node distributed-effects-race-worker.js <coordDb> <workDb> <sideEffectFile> <mode> <instanceId> [leaseMs]
 *
 * Modes:
 *  - `seed`     — dispatch the single contended effect intent, print `ok`, exit.
 *  - `run`      — poll until the effect is terminal (or a bounded number of rounds), print
 *                 `{ instanceId, terminals, finalState, calls }`, exit. Fast adapter.
 *  - `run-slow` — same, but the adapter sleeps `SLOW_MS` before recording its side effect,
 *                 so the parent can `SIGKILL` this process mid-attempt.
 *
 * The adapter's *only* side effect is appending `<instanceId>\n` to `<sideEffectFile>` — the
 * physical-execution ledger the test inspects. A raw SQLite error must never escape.
 */

const EFFECT_ID = 'e-cross';
const SLOW_MS = 4_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function build(coordDb: string, workDb: string, sideEffectFile: string, slow: boolean) {
  const coordination = await createSqliteCoordinationProvider({ location: coordDb });
  const storage = await createSqliteDurableWorkStorage({ location: workDb });
  const store = createDurableWorkStore({ coordination, storage });
  let calls = 0;
  const adapter: IntegrationAdapter = {
    async query(): Promise<IntegrationResult> {
      return { ok: false, code: 'NOPE', message: 'n/a' };
    },
    async effect(_operation, _args, context): Promise<IntegrationResult> {
      calls += 1;
      if (slow) await sleep(SLOW_MS);
      appendFileSync(sideEffectFile, `${context.idempotencyKey ?? 'no-key'}\n`);
      return { ok: true, value: context.idempotencyKey };
    },
  };
  const runner = createDistributedEffectRunner({
    store,
    execution: {
      adapters: { int_x: adapter } as never,
      integrationOperations: {
        op_x: {
          id: 'op_x',
          kind: 'integration-operation',
          integrationId: 'int_x',
          mode: 'effect',
          resultType: { kind: 'primitive', primitive: 'string' },
        },
      } as never,
    },
    host: {
      now: () => new Date().toISOString(),
      uuid: () => Math.random().toString(16).slice(2),
      schedule: () => ({ cancel() {} }),
      scheduleOnce: (ms: number, cb: () => void) => {
        const t = setTimeout(cb, ms);
        return { cancel: () => clearTimeout(t) };
      },
    } as never,
    instanceId: process.argv[6] ?? 'anon',
    config: { leaseDurationMs: Number(process.argv[7] ?? 30_000), renewIntervalMs: 400 },
    onTerminal: async () => {},
  });
  return { coordination, storage, store, runner, calls: () => calls };
}

async function main(): Promise<void> {
  const [coordDb, workDb, sideEffectFile, mode] = process.argv.slice(2);
  const { coordination, storage, store, runner, calls } = await build(
    coordDb,
    workDb,
    sideEffectFile,
    mode === 'run-slow',
  );

  try {
    if (mode === 'seed') {
      runner.dispatch([
        {
          id: EFFECT_ID,
          operationId: 'op_x',
          arguments: {},
          outcome: 'committed',
          status: 'pending',
          attempts: 0,
        } as never,
      ]);
      await new Promise((r) => setTimeout(r, 50));
      process.stdout.write('ok');
      await coordination.close?.();
      await storage.close?.();
      return;
    }

    let terminals = 0;
    for (let round = 0; round < 40; round += 1) {
      terminals += await runner.poll();
      const item = await store.get(EFFECT_WORK_CLASS, EFFECT_ID);
      if (item && (item.state === 'succeeded' || item.state === 'failed')) break;
      await sleep(50);
    }
    const finalItem = await store.get(EFFECT_WORK_CLASS, EFFECT_ID);
    process.stdout.write(
      JSON.stringify({
        instanceId: process.argv[6] ?? 'anon',
        terminals,
        finalState: finalItem?.state ?? null,
        uncertainAttempts: finalItem?.uncertainAttempts ?? 0,
        calls: calls(),
      }),
    );
    await coordination.close?.();
    await storage.close?.();
  } catch (error) {
    const structured = error as { code?: string; name?: string };
    process.stdout.write(JSON.stringify({ thrown: true, errorCode: structured?.code, name: structured?.name }));
    await coordination.close?.();
    await storage.close?.();
  }
}

void main();
