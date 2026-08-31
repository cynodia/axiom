import {
  createAxiomServer,
  createSqliteCoordinationProvider,
  createSqlitePersistence,
  createSqliteWorkflowStore,
} from '@cynodia/axiom-server';
import type { AxiomServer, ServerRequest, WorkflowStore, WorkflowTransition } from '@cynodia/axiom-server';
import { PROTOCOL_VERSION } from '@cynodia/axiom-server';
import { EV_GO, F_SIGNAL_KEY, S_COUNT, WF_CRASH_IR } from './workflow-crash-graph.js';

/**
 * One real OS-process authority for the spec14pt2 F1/F2 crash matrix.
 *
 *   node workflow-crash-worker.js <stateDb> <wfDb> <coordDb> <label> [crashMode]
 *
 * `crashMode`:
 *   f1  — SIGKILL self the instant the engine goes to record a workflow action outcome,
 *         i.e. after the ActionDef has durably committed (state + atomic idempotency record)
 *         but before the workflow's `step-succeeded` transition. The narrowest F1 boundary.
 *   f2  — SIGKILL self the instant the engine goes to commit an `event-matched` transition,
 *         i.e. after the accepted event is durably journalled but before the workflow moves.
 *   ''  — never crash; the recovery authority.
 */

const [stateDb, wfDb, coordDb, label, crashMode = ''] = process.argv.slice(2);

let armed = true;
function crashOnce(): void {
  if (!armed) return;
  armed = false;
  process.kill(process.pid, 'SIGKILL');
}

function wrapStore(store: WorkflowStore): WorkflowStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'recordActionOutcome' && crashMode === 'f1') {
        return async (...args: unknown[]) => {
          crashOnce();
          return (target.recordActionOutcome as (...a: unknown[]) => Promise<void>)(...args);
        };
      }
      if (prop === 'transition' && crashMode === 'f2') {
        return async (cas: Parameters<WorkflowStore['transition']>[0]) => {
          if (cas?.next?.history?.kind === 'event-matched') crashOnce();
          return target.transition(cas);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as WorkflowStore;
}

async function main(): Promise<void> {
  const persistence = await createSqlitePersistence({ location: stateDb });
  const coordination = await createSqliteCoordinationProvider({ location: coordDb });
  const workflowStore = wrapStore(await createSqliteWorkflowStore({ location: wfDb }));

  const server: AxiomServer = createAxiomServer({
    ir: WF_CRASH_IR,
    persistence,
    coordination,
    workflowStore,
    // A short lease so a crashed lease-holder's per-instance claim lapses quickly and a
    // recovery authority can take over within the test window.
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
            const started = await server.startWorkflow({
              workflowId: String(msg.workflowId),
              arguments: { input_key: String(msg.key) },
              ...(msg.idempotencyKey ? { idempotencyKey: String(msg.idempotencyKey) } : {}),
            });
            send({ type: 'started', result: started });
            break;
          }
          case 'list': {
            send({ type: 'list', items: await server.inspectWorkflows(50) });
            break;
          }
          case 'get': {
            send({ type: 'workflow', value: (await server.getWorkflow(String(msg.instanceId))) ?? null });
            break;
          }
          case 'history': {
            const h = await server.workflowHistory(String(msg.instanceId));
            send({ type: 'history', value: h.map((e) => String((e as { kind: string }).kind)) });
            break;
          }
          case 'count': {
            // Durably truthful on *any* authority: reconcile to the persisted revision first,
            // so this reflects logical ActionDef commits, not this process's local view.
            const snap = await server.coherentSnapshot();
            send({ type: 'count', value: Number((snap.states as Record<string, unknown>)[String(S_COUNT)] ?? 0) });
            break;
          }
          case 'event': {
            const res = (await server.handle({
              kind: 'event',
              protocol: PROTOCOL_VERSION,
              eventId: EV_GO,
              payload: { [String(F_SIGNAL_KEY)]: String(msg.key) },
            } as ServerRequest)) as { ok?: boolean };
            send({ type: 'event-ack', ok: res.ok === true });
            break;
          }
          case 'cancel': {
            send({ type: 'cancelled', value: await server.cancelWorkflow(String(msg.instanceId)) });
            break;
          }
          case 'holdAndStaleTransition': {
            // Stale-owner (SIGSTOP) probe: take the per-instance coordination lease, snapshot
            // the revision, then — after a delay during which the parent freezes this
            // process and lets the lease lapse while another authority advances the instance
            // — attempt a fenced transition with the now-stale generation. It MUST be
            // refused (spec14pt2 §3, "stale successful commits == 0").
            const id = String(msg.instanceId);
            const leaseMs = Number(msg.leaseMs ?? 600);
            const delayMs = Number(msg.delayMs ?? 2000);
            const acquired = await coordination.acquire(`workflow:${id}`, label as never, leaseMs);
            const generation = acquired.ok && acquired.lease ? Number(acquired.lease.generation) : -1;
            const snapshot = await workflowStore.load(id);
            send({ type: 'held', generation, revision: snapshot?.instanceRevision ?? -1 });
            setTimeout(() => {
              void (async () => {
                const fresh = await workflowStore.load(id);
                const next: WorkflowTransition = {
                  status: 'cancelled',
                  currentStepId: fresh?.currentStepId ?? 'x',
                  activationId: fresh?.activationId ?? 'x',
                  attempt: 0,
                  pendingAction: null,
                  nextEligibleAt: null,
                  history: { kind: 'cancelled', stepId: fresh?.currentStepId ?? 'x' },
                };
                const result = await workflowStore.transition({
                  instanceId: id,
                  expectedRevision: snapshot?.instanceRevision ?? 0,
                  fence: generation,
                  next,
                });
                send({
                  type: 'staleResult',
                  ok: result.ok,
                  reason: result.ok ? null : (result as { reason: string }).reason,
                });
              })();
            }, delayMs);
            break;
          }
          case 'stop': {
            await server.stop().catch(() => {});
            process.exit(0);
            break;
          }
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
