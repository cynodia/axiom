import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createSqliteDataProvider,
  createSqlitePersistence,
} from '@cynodia/axiom-server';
import type { AxiomServer, LiveQueryHandle, LiveQueryMessage } from '@cynodia/axiom-server';
import {
  A_SET_STATUS,
  A_SET_TOTAL,
  E_ORDER,
  LIVE_ORDERS_IR,
  P_ID,
  P_STATUS,
  P_TOTAL,
  Q_OPEN,
} from './live-orders-graph.js';

/**
 * One real OS-process authority for the spec13 §159 cross-process live-query trials.
 *
 *   node live-query-authority-worker.js <stateDb> <dataDb> <instanceId>
 *
 * IPC commands:
 *   { type: 'openLive' }             -> { type: 'opened' }         (starts draining a live query)
 *   { type: 'drain' }               -> { type: 'drained', messages }  (all messages seen so far)
 *   { type: 'invokeStatus', id, status } -> { type: 'result', ok }
 *   { type: 'invokeTotal', id, total }   -> { type: 'result', ok }
 *   { type: 'stop' }                -> exits
 */

async function main(): Promise<void> {
  const [stateDb, dataDb] = process.argv.slice(2);
  const persistence = await createSqlitePersistence({ location: stateDb });
  const dataProvider = await createSqliteDataProvider({
    location: dataDb,
    entities: LIVE_ORDERS_IR.entities ?? [],
    maxPageSize: 100,
  });
  const server: AxiomServer = createAxiomServer({
    ir: LIVE_ORDERS_IR,
    persistence,
    dataProvider,
    liveQueryPollMs: 40,
  });
  await server.start();

  const seen: LiveQueryMessage[] = [];
  let handle: LiveQueryHandle | undefined;

  process.send?.({ type: 'ready' });

  process.on('message', (msg: { type?: string; id?: string; status?: string; total?: number }) => {
    void (async () => {
      try {
        if (msg?.type === 'openLive') {
          const opened = await server.openLiveQuery({ queryId: String(Q_OPEN) });
          if ('error' in opened) {
            process.send?.({ type: 'error', message: JSON.stringify(opened.error) });
            return;
          }
          handle = opened;
          void (async () => {
            for await (const message of opened) seen.push(message);
          })();
          process.send?.({ type: 'opened' });
        } else if (msg?.type === 'drain') {
          process.send?.({ type: 'drained', messages: seen.slice() });
        } else if (msg?.type === 'invokeStatus') {
          const res = (await server.handle({
            protocol: PROTOCOL_VERSION,
            kind: 'invoke',
            actionId: A_SET_STATUS,
            arguments: { [P_ID]: msg.id, [P_STATUS]: msg.status },
          } as never)) as { ok?: boolean };
          process.send?.({ type: 'result', ok: res.ok === true });
        } else if (msg?.type === 'invokeTotal') {
          const res = (await server.handle({
            protocol: PROTOCOL_VERSION,
            kind: 'invoke',
            actionId: A_SET_TOTAL,
            arguments: { [P_ID]: msg.id, [P_TOTAL]: msg.total },
          } as never)) as { ok?: boolean };
          process.send?.({ type: 'result', ok: res.ok === true });
        } else if (msg?.type === 'stop') {
          handle?.close();
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
