import assert from 'node:assert/strict';
import test from 'node:test';
import { binary, field as coreField, literal, nodeId, primitiveType, ref as coreRef } from '@cynodia/axiom-core';
import type { Expression } from '@cynodia/axiom-core';

const ref = (id: string): Expression => coreRef(id as never);
const field = (source: Expression, f: string): Expression => coreField(source, f as never);
import type { WorkflowDef } from '@cynodia/axiom-core';
import {
  createMemoryWorkflowStore,
  createWorkflowEngine,
  evaluateWorkflowExpression,
} from '@cynodia/axiom-server';
import type { WorkflowInvokeAction } from '@cynodia/axiom-server';

/**
 * spec14 — the durable-workflow engine over the memory `WorkflowStore`. Deterministic: a
 * controllable clock, a scripted `invokeAction`, and `advance` / `onEventAccepted` driven by
 * hand (the real poll loop is exercised by the server + cross-process tests).
 */

const A_RESERVE = nodeId('action_reserve');
const A_SHIP = nodeId('action_ship');
const A_RELEASE = nodeId('action_release');
const A_PROVISION = nodeId('action_provision');
const EV_PAID = nodeId('event_payment_confirmed');
const P_ORDER = nodeId('input_order_id');
const B_TXN = nodeId('binding_txn');

function orderFulfillment(): WorkflowDef {
  return {
    id: nodeId('wf_order_fulfillment'),
    kind: 'workflow',
    inputs: [{ id: P_ORDER, valueType: primitiveType('string'), required: true }],
    bindings: [{ id: B_TXN, valueType: primitiveType('string'), producedBy: nodeId('wait_payment') }],
    entry: nodeId('reserve'),
    steps: [
      { type: 'action', id: nodeId('reserve'), action: A_RESERVE, arguments: { orderId: ref(P_ORDER) }, next: nodeId('wait_payment') },
      {
        type: 'wait-event',
        id: nodeId('wait_payment'),
        event: EV_PAID,
        where: binary('eq', field(ref('EVENT'), 'orderId'), ref(P_ORDER)),
        bind: { [String(B_TXN)]: field(ref('EVENT'), 'txn') },
        next: nodeId('ship'),
        timeout: { seconds: 7 * 24 * 3600 },
        onTimeout: nodeId('release'),
      },
      { type: 'action', id: nodeId('ship'), action: A_SHIP, arguments: { orderId: ref(P_ORDER), txn: ref(B_TXN) }, next: nodeId('done') },
      { type: 'action', id: nodeId('release'), action: A_RELEASE, arguments: { orderId: ref(P_ORDER) }, next: nodeId('aborted') },
      { type: 'complete', id: nodeId('done'), output: { orderId: ref(P_ORDER), txn: ref(B_TXN) } },
      { type: 'fail', id: nodeId('aborted'), error: { reason: literal('payment-timeout') } },
    ],
  };
}

function timerWorkflow(): WorkflowDef {
  return {
    id: nodeId('wf_trial'),
    kind: 'workflow',
    inputs: [{ id: nodeId('input_account'), valueType: primitiveType('string'), required: true }],
    entry: nodeId('wait_30d'),
    steps: [
      { type: 'timer', id: nodeId('wait_30d'), after: { seconds: 30 * 24 * 3600 }, next: nodeId('expire') },
      { type: 'action', id: nodeId('expire'), action: A_PROVISION, arguments: {}, next: nodeId('done') },
      { type: 'complete', id: nodeId('done') },
    ],
  };
}

function retryWorkflow(): WorkflowDef {
  return {
    id: nodeId('wf_provision'),
    kind: 'workflow',
    entry: nodeId('provision'),
    steps: [
      {
        type: 'action',
        id: nodeId('provision'),
        action: A_PROVISION,
        arguments: {},
        next: nodeId('done'),
        retry: { maxAttempts: 5, initialDelaySeconds: 1, backoffMultiplier: 2, maxDelaySeconds: 30 },
      },
      { type: 'complete', id: nodeId('done') },
    ],
  };
}

function engineOver(workflows: WorkflowDef[], invoke: WorkflowInvokeAction, clock: { t: number }) {
  const store = createMemoryWorkflowStore();
  const engine = createWorkflowEngine({
    workflows,
    store,
    invokeAction: invoke,
    compatibilityFingerprint: 'test-build',
    instanceId: 'authority-1',
    now: () => clock.t,
    resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
  });
  return { store, engine };
}

const okInvoke: WorkflowInvokeAction = async () => ({ ok: true, retryable: false });

test('evaluateWorkflowExpression covers the deterministic workflow subset', () => {
  const scope = { input_x: 3, EVENT: { amount: 10 }, PRINCIPAL: { role: 'admin' } };
  assert.equal(evaluateWorkflowExpression(binary('add', ref('input_x'), literal(2)), scope), 5);
  assert.equal(evaluateWorkflowExpression(field(ref('EVENT'), 'amount'), scope), 10);
  assert.equal(
    evaluateWorkflowExpression(binary('eq', field(ref('PRINCIPAL'), 'role'), literal('admin')), scope),
    true,
  );
  assert.throws(() => evaluateWorkflowExpression(ref('nope'), scope), /not in scope/);
});

test('order fulfillment: action → wait-event (matched) → action → complete, with a bound event field', async () => {
  const clock = { t: 1_000 };
  const invoked: string[] = [];
  const invoke: WorkflowInvokeAction = async ({ actionId, arguments: args }) => {
    invoked.push(`${actionId}:${JSON.stringify(args)}`);
    return { ok: true, retryable: false };
  };
  const { store, engine } = engineOver([orderFulfillment()], invoke, clock);

  const started = await engine.startWorkflow({ workflowId: String(nodeId('wf_order_fulfillment')), arguments: { [String(P_ORDER)]: 'order-42' } });
  assert.ok('instanceId' in started);
  const id = started.instanceId;

  let record = await store.load(id);
  assert.equal(record?.status, 'waiting');
  assert.equal(record?.currentStepId, String(nodeId('wait_payment')));
  assert.deepEqual(invoked, [`${A_RESERVE}:{"orderId":"order-42"}`]);

  // A non-matching event does nothing.
  await engine.onEventAccepted(String(EV_PAID), { orderId: 'other', txn: 'tx-x' }, 1);
  assert.equal((await store.load(id))?.status, 'waiting');

  // The matching event unblocks it, binds `txn`, and drives it to completion.
  await engine.onEventAccepted(String(EV_PAID), { orderId: 'order-42', txn: 'tx-99' }, 2);
  record = await store.load(id);
  assert.equal(record?.status, 'completed');
  assert.equal(record?.bindings[String(B_TXN)], 'tx-99');
  assert.deepEqual(record?.output, { orderId: 'order-42', txn: 'tx-99' });
  assert.ok(invoked.includes(`${A_SHIP}:{"orderId":"order-42","txn":"tx-99"}`));

  const history = (await store.history(id)).map((h) => h.kind);
  assert.deepEqual(history, [
    'started',
    'step-activated',
    'step-succeeded',
    'step-activated',
    'event-matched',
    'step-activated',
    'step-succeeded',
    'completed',
  ]);
});

test('wait-event timeout routes to the onTimeout edge (spec14 §64, §65)', async () => {
  const clock = { t: 1_000 };
  const { store, engine } = engineOver([orderFulfillment()], okInvoke, clock);
  const started = await engine.startWorkflow({ workflowId: String(nodeId('wf_order_fulfillment')), arguments: { [String(P_ORDER)]: 'order-1' } });
  const id = (started as { instanceId: string }).instanceId;
  assert.equal((await store.load(id))?.status, 'waiting');

  // Advance past the 7-day timeout and poke the engine.
  clock.t += 8 * 24 * 3600 * 1000;
  await engine.advance(id);
  const record = await store.load(id);
  assert.equal(record?.status, 'failed');
  assert.equal(record?.failure?.reason, 'payment-timeout');
});

test('timer step captures its target once and does not re-extend on re-advance (spec14 §45)', async () => {
  const clock = { t: 10_000 };
  const { store, engine } = engineOver([timerWorkflow()], okInvoke, clock);
  const started = await engine.startWorkflow({ workflowId: String(nodeId('wf_trial')), arguments: { [String(nodeId('input_account'))]: 'acct-1' } });
  const id = (started as { instanceId: string }).instanceId;
  const target = (await store.load(id))?.wait as { kind: 'timer'; targetAt: number };
  assert.equal(target.kind, 'timer');
  assert.equal(target.targetAt, 10_000 + 30 * 24 * 3600 * 1000);

  // Re-advancing before the target must not move it.
  clock.t += 3600_000;
  await engine.advance(id);
  const stillWaiting = await store.load(id);
  assert.equal(stillWaiting?.status, 'waiting');
  assert.equal((stillWaiting?.wait as { targetAt: number }).targetAt, target.targetAt);

  // At/after the target it fires exactly once.
  clock.t = target.targetAt + 1;
  await engine.advance(id);
  assert.equal((await store.load(id))?.status, 'completed');
});

test('retry: a retryable failure backs off with durable attempts, then succeeds (spec14 §38-§43)', async () => {
  const clock = { t: 0 };
  let calls = 0;
  const invoke: WorkflowInvokeAction = async () => {
    calls += 1;
    return calls < 3 ? { ok: false, retryable: true, diagnostics: [{ code: 'AUTHORITY_UNREACHABLE' }] } : { ok: true, retryable: false };
  };
  const { store, engine } = engineOver([retryWorkflow()], invoke, clock);
  const started = await engine.startWorkflow({ workflowId: String(nodeId('wf_provision')) });
  const id = (started as { instanceId: string }).instanceId;

  let record = await store.load(id);
  assert.equal(record?.status, 'waiting');
  assert.equal(record?.wait?.kind, 'retry');
  assert.equal((record?.wait as { attempt: number }).attempt, 2);

  // First backoff is 1s.
  clock.t = 1_001;
  await engine.advance(id);
  record = await store.load(id);
  assert.equal(record?.wait?.kind, 'retry');
  assert.equal((record?.wait as { attempt: number }).attempt, 3);

  // Second backoff is 2s.
  clock.t += 2_001;
  await engine.advance(id);
  record = await store.load(id);
  assert.equal(record?.status, 'completed');
  assert.equal(calls, 3);
});

test('a duplicate event delivery transitions the wait only once (spec14 §59)', async () => {
  const clock = { t: 0 };
  const { store, engine } = engineOver([orderFulfillment()], okInvoke, clock);
  const started = await engine.startWorkflow({ workflowId: String(nodeId('wf_order_fulfillment')), arguments: { [String(P_ORDER)]: 'o' } });
  const id = (started as { instanceId: string }).instanceId;

  await engine.onEventAccepted(String(EV_PAID), { orderId: 'o', txn: 't1' }, 5);
  await engine.onEventAccepted(String(EV_PAID), { orderId: 'o', txn: 't2' }, 5); // same seq — redelivery
  const record = await store.load(id);
  assert.equal(record?.status, 'completed');
  assert.equal(record?.bindings[String(B_TXN)], 't1', 'the first match won; the redelivery did not re-transition');
});

test('cancellation is durable and a later event does not resume a cancelled workflow (spec14 §79)', async () => {
  const clock = { t: 0 };
  const { store, engine } = engineOver([orderFulfillment()], okInvoke, clock);
  const started = await engine.startWorkflow({ workflowId: String(nodeId('wf_order_fulfillment')), arguments: { [String(P_ORDER)]: 'o' } });
  const id = (started as { instanceId: string }).instanceId;

  const cancelled = await engine.cancelWorkflow(id);
  assert.deepEqual(cancelled, { ok: true, status: 'cancelled' });
  assert.deepEqual(await engine.cancelWorkflow(id), { ok: true, status: 'cancelled' }, 'idempotent');

  await engine.onEventAccepted(String(EV_PAID), { orderId: 'o', txn: 't' }, 9);
  assert.equal((await store.load(id))?.status, 'cancelled');
});

test('start is idempotent on (workflow, principal, idempotencyKey) (spec14 §19-§21)', async () => {
  const clock = { t: 0 };
  const { engine } = engineOver([retryWorkflow()], okInvoke, clock);
  const a = await engine.startWorkflow({ workflowId: String(nodeId('wf_provision')), idempotencyKey: 'k1' });
  const b = await engine.startWorkflow({ workflowId: String(nodeId('wf_provision')), idempotencyKey: 'k1' });
  assert.equal((a as { instanceId: string }).instanceId, (b as { instanceId: string }).instanceId);
  const c = await engine.startWorkflow({ workflowId: String(nodeId('wf_provision')), idempotencyKey: 'k2' });
  assert.notEqual((a as { instanceId: string }).instanceId, (c as { instanceId: string }).instanceId);
});

test('an incompatible-build authority refuses to advance an existing instance (spec14 §116)', async () => {
  const clock = { t: 0 };
  const store = createMemoryWorkflowStore();
  const buildA = createWorkflowEngine({
    workflows: [orderFulfillment()],
    store,
    invokeAction: okInvoke,
    compatibilityFingerprint: 'build-A',
    instanceId: 'a',
    now: () => clock.t,
    resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
  });
  const started = await buildA.startWorkflow({ workflowId: String(nodeId('wf_order_fulfillment')), arguments: { [String(P_ORDER)]: 'o' } });
  const id = (started as { instanceId: string }).instanceId;

  const buildB = createWorkflowEngine({
    workflows: [orderFulfillment()],
    store,
    invokeAction: okInvoke,
    compatibilityFingerprint: 'build-B',
    instanceId: 'b',
    now: () => clock.t,
    resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
  });
  const before = await store.load(id);
  await buildB.advance(id);
  await buildB.onEventAccepted(String(EV_PAID), { orderId: 'o', txn: 't' }, 3);
  const after = await store.load(id);
  assert.equal(after?.instanceRevision, before?.instanceRevision, 'build B moved nothing');
  assert.equal(after?.status, 'waiting');
});
