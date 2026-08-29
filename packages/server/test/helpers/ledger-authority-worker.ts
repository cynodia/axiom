import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createSqlitePersistence,
} from '@cynodia/axiom-server';
import type { AxiomServer } from '@cynodia/axiom-server';
import {
  A_DEPOSIT,
  EV_THING,
  LEDGER_IR,
  P_AMOUNT,
  S_EVENTS_SEEN,
  S_LEDGER,
} from './ledger-graph.js';

/**
 * One real OS-process authority for the spec12.1 §57, §58, §61, §94 distributed-state tests.
 *
 *   node ledger-authority-worker.js <stateDb> <instanceId>
 *
 * Starts an `AxiomServer` over the shared ledger Server IR + a shared SQLite persistence DB,
 * then serves IPC commands:
 *   { type: 'deposit', amount }   -> { type: 'result', ok, code? }
 *   { type: 'event',   amount }   -> { type: 'result', ok, code? }
 *   { type: 'snapshot' }          -> { type: 'snapshot', ledger, eventsSeen, revision }
 *   { type: 'stop' }              -> exits
 *
 * A raw SQLite lock error must never escape (it would exit non-zero / print to stderr).
 */

async function main(): Promise<void> {
  const [stateDb, instanceId] = process.argv.slice(2);
  const persistence = await createSqlitePersistence({ location: stateDb });
  const server: AxiomServer = createAxiomServer({ ir: LEDGER_IR, persistence });
  await server.start();
  process.send?.({ type: 'ready', instanceId });

  process.on('message', (msg: { type?: string; amount?: number }) => {
    void (async () => {
      try {
        if (msg?.type === 'deposit') {
          const res = (await server.handle({
            protocol: PROTOCOL_VERSION,
            kind: 'invoke',
            actionId: A_DEPOSIT,
            arguments: { [P_AMOUNT]: msg.amount ?? 0 },
          } as never)) as { ok?: boolean; diagnostics?: Array<{ code: string }> };
          process.send?.({ type: 'result', ok: res.ok === true, code: res.diagnostics?.[0]?.code });
        } else if (msg?.type === 'event') {
          const res = (await server.handle({
            protocol: PROTOCOL_VERSION,
            kind: 'event',
            eventId: EV_THING,
            payload: msg.amount ?? 1,
          } as never)) as { ok?: boolean; diagnostics?: Array<{ code: string }> };
          process.send?.({ type: 'result', ok: res.ok !== false, code: res.diagnostics?.[0]?.code });
        } else if (msg?.type === 'snapshot') {
          const res = (await server.handle({
            protocol: PROTOCOL_VERSION,
            kind: 'snapshot',
          } as never)) as { snapshot: { states: Record<string, unknown>; revision: number } };
          process.send?.({
            type: 'snapshot',
            ledger: res.snapshot.states[S_LEDGER] as number,
            eventsSeen: res.snapshot.states[S_EVENTS_SEEN] as number,
            revision: res.snapshot.revision,
          });
        } else if (msg?.type === 'stop') {
          // `server.stop()` already closes the persistence adapter.
          await server.stop().catch(() => {});
          process.exit(0);
        }
      } catch (error) {
        process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

void main();
