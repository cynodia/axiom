import {
  createAxiomServer,
  createSqliteCoordinationProvider,
  createSqlitePersistence,
  createSqliteWorkflowStore,
} from '@cynodia/axiom-server';
import type { AxiomServer, ServerRequest } from '@cynodia/axiom-server';
import { PROTOCOL_VERSION } from '@cynodia/axiom-server';
import { EV_GO, F_KEY, S_COUNT, WF, mixedIr, type MixedVariant } from './workflow-mixed-graph.js';

/**
 * One real OS-process authority for the spec14pt3 F3 mixed-build tests.
 *
 *   node workflow-mixed-worker.js <stateDb> <wfDb> <coordDb> <label> <variant>
 *
 * `variant` selects the workflow semantics this authority build carries (see
 * workflow-mixed-graph.ts). Authorities on the same shared stores but different
 * *semantic* variants must refuse to advance each other's instances; authorities that
 * differ only by presentation must not.
 */

const [stateDb, wfDb, coordDb, label, variant = 'a'] = process.argv.slice(2);

async function main(): Promise<void> {
  const persistence = await createSqlitePersistence({ location: stateDb });
  const coordination = await createSqliteCoordinationProvider({ location: coordDb });
  const workflowStore = await createSqliteWorkflowStore({ location: wfDb });
  const server: AxiomServer = createAxiomServer({
    ir: mixedIr(variant as MixedVariant),
    persistence,
    coordination,
    workflowStore,
    distributed: { leaseDurationMs: 900, renewIntervalMs: 300 },
  });
  await server.start();

  const send = (m: Record<string, unknown>): void => void process.send?.(m);
  send({ type: 'ready', label });

  process.on('message', (msg: Record<string, unknown>) => {
    void (async () => {
      try {
        switch (msg?.type) {
          case 'start': {
            send({
              type: 'started',
              result: await server.startWorkflow({
                workflowId: String(WF),
                arguments: { input_key: String(msg.key) },
                ...(msg.idempotencyKey ? { idempotencyKey: String(msg.idempotencyKey) } : {}),
              }),
            });
            break;
          }
          case 'list':
            send({ type: 'list', items: await server.inspectWorkflows(50) });
            break;
          case 'get':
            send({ type: 'workflow', value: (await server.getWorkflow(String(msg.instanceId))) ?? null });
            break;
          case 'history': {
            const h = await server.workflowHistory(String(msg.instanceId));
            send({ type: 'history', value: h.map((e) => String((e as { kind: string }).kind)) });
            break;
          }
          case 'count': {
            const snap = await server.coherentSnapshot();
            send({ type: 'count', value: Number((snap.states as Record<string, unknown>)[String(S_COUNT)] ?? 0) });
            break;
          }
          case 'event': {
            const res = (await server.handle({
              kind: 'event',
              protocol: PROTOCOL_VERSION,
              eventId: EV_GO,
              payload: { [String(F_KEY)]: String(msg.key) },
            } as ServerRequest)) as { ok?: boolean };
            send({ type: 'event-ack', ok: res.ok === true });
            break;
          }
          case 'cancel':
            send({ type: 'cancelled', value: await server.cancelWorkflow(String(msg.instanceId)) });
            break;
          case 'stop':
            await server.stop().catch(() => {});
            process.exit(0);
            break;
          default:
            send({ type: 'error', message: `unknown ${String(msg?.type)}` });
        }
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

void main().catch((error) => {
  process.send?.({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
