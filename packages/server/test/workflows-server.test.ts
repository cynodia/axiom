import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, EventDef, StateDef, WorkflowDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import { PROTOCOL_VERSION, createAxiomServer, createDeterministicServerHost } from '@cynodia/axiom-server';
import type { ServerRequest } from '@cynodia/axiom-server';

/**
 * spec14 — durable workflows wired through `createAxiomServer`: `startWorkflow` /
 * `getWorkflow` / `cancelWorkflow` / `workflowHistory`, the poll loop driving an
 * action-only workflow to completion, and an event delivered through the ordinary event
 * pipeline unblocking a `wait-event` step.
 */

const S_LOG = nodeId('state_provisioned');

const A_PROVISION = nodeId('action_provision');
const A_NOTIFY = nodeId('action_notify');
const EV_APPROVED = nodeId('event_approved');
const WF_PROVISION = nodeId('wf_provision');
const WF_APPROVAL = nodeId('wf_approval');
const P_NAME = nodeId('input_name');
const E_APPROVAL = nodeId('entity_approval');
const F_A_NAME = fieldId('field_approval_name');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('wf', 'Workflows');
  g.addNode<StateDef>({
    id: S_LOG,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  g.addNode<EntityDef>({
    id: E_APPROVAL,
    kind: 'entity',
    fields: [{ id: F_A_NAME, valueType: primitiveType('string'), required: true }],
  });
  g.addNode<EventDef>({ id: EV_APPROVED, kind: 'event', payloadType: entityType(E_APPROVAL) });
  g.addNode<ActionDef>({
    id: A_PROVISION,
    kind: 'action',
    parameters: [{ id: P_NAME, valueType: primitiveType('string'), required: false }],
    invocation: { allowedSources: ['system'] },
    operations: [{ kind: 'set', target: stateLocation(S_LOG), value: binary('add', ref(S_LOG), literal(1)) }],
  });
  g.addNode<ActionDef>({
    id: A_NOTIFY,
    kind: 'action',
    parameters: [{ id: P_NAME, valueType: primitiveType('string'), required: false }],
    invocation: { allowedSources: ['system'] },
    operations: [{ kind: 'set', target: stateLocation(S_LOG), value: binary('add', ref(S_LOG), literal(10)) }],
  });
  g.addNode<WorkflowDef>({
    id: WF_PROVISION,
    kind: 'workflow',
    inputs: [{ id: P_NAME, valueType: primitiveType('string'), required: true }],
    entry: nodeId('step_provision'),
    steps: [
      { type: 'action', id: nodeId('step_provision'), action: A_PROVISION, arguments: { [String(P_NAME)]: ref(P_NAME) }, next: nodeId('step_done') },
      { type: 'complete', id: nodeId('step_done'), output: { name: ref(P_NAME) } },
    ],
  });
  g.addNode<WorkflowDef>({
    id: WF_APPROVAL,
    kind: 'workflow',
    inputs: [{ id: P_NAME, valueType: primitiveType('string'), required: true }],
    entry: nodeId('await_approval'),
    steps: [
      {
        type: 'wait-event',
        id: nodeId('await_approval'),
        event: EV_APPROVED,
        where: binary('eq', field(ref('EVENT' as never), F_A_NAME), ref(P_NAME)),
        next: nodeId('notify'),
      },
      { type: 'action', id: nodeId('notify'), action: A_NOTIFY, arguments: {}, next: nodeId('ok') },
      { type: 'complete', id: nodeId('ok') },
    ],
  });
  return g;
}

const IR = compileToServerIR(graph());

async function server() {
  const s = createAxiomServer({
    ir: IR,
    host: createDeterministicServerHost({}),
    // no workflowStore -> the in-memory reference; poll loop runs on real timers.
  });
  await s.start();
  return s;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ok: (v: T) => boolean, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined && ok(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

test('the Server IR labels a workflow document axiom.server.v8', () => {
  assert.equal(IR.contract, 'axiom.server.v8');
  assert.equal(IR.workflows?.length, 2);
});

test('an action-only workflow runs to completion through the poll loop, under a system principal', async () => {
  const s = await server();
  try {
    const started = await s.startWorkflow({ workflowId: String(WF_PROVISION), arguments: { [String(P_NAME)]: 'svc-1' } });
    assert.ok('instanceId' in started, JSON.stringify(started));
    const id = started.instanceId;

    const done = await waitFor(() => s.getWorkflow(id), (w) => w.status === 'completed');
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.output, { name: 'svc-1' });
    assert.equal(s.getState(S_LOG), 1, 'the ActionDef ran exactly once');

    const history = (await s.workflowHistory(id)).map((h) => h.kind);
    assert.deepEqual(history, ['started', 'step-activated', 'step-succeeded', 'completed']);
  } finally {
    await s.stop();
  }
});

test('start is idempotent through the server (spec14 §19-§21)', async () => {
  const s = await server();
  try {
    const a = await s.startWorkflow({ workflowId: String(WF_PROVISION), arguments: { [String(P_NAME)]: 'x' }, idempotencyKey: 'k' });
    const b = await s.startWorkflow({ workflowId: String(WF_PROVISION), arguments: { [String(P_NAME)]: 'x' }, idempotencyKey: 'k' });
    assert.equal((a as { instanceId: string }).instanceId, (b as { instanceId: string }).instanceId);
    await waitFor(() => s.getWorkflow((a as { instanceId: string }).instanceId), (w) => w.status === 'completed');
    assert.equal(s.getState(S_LOG), 1, 'a retried start did not run the action twice');
  } finally {
    await s.stop();
  }
});

test('a wait-event step is unblocked by an event delivered through the ordinary pipeline (spec14 §51, §54)', async () => {
  const s = await server();
  try {
    const started = await s.startWorkflow({ workflowId: String(WF_APPROVAL), arguments: { [String(P_NAME)]: 'req-7' } });
    const id = (started as { instanceId: string }).instanceId;
    const waiting = await waitFor(() => s.getWorkflow(id), (w) => w.status === 'waiting');
    assert.match(waiting.waitingReason ?? '', /waiting for event/);

    // A non-matching event does not move it.
    await s.handle({ kind: 'event', protocol: PROTOCOL_VERSION, eventId: EV_APPROVED, payload: { [String(F_A_NAME)]: 'other' } } as ServerRequest);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await s.getWorkflow(id))?.status, 'waiting');

    // The matching event drives it to completion.
    await s.handle({ kind: 'event', protocol: PROTOCOL_VERSION, eventId: EV_APPROVED, payload: { [String(F_A_NAME)]: 'req-7' } } as ServerRequest);
    const done = await waitFor(() => s.getWorkflow(id), (w) => w.status === 'completed');
    assert.equal(done.status, 'completed');
    assert.equal(s.getState(S_LOG), 10);
  } finally {
    await s.stop();
  }
});

test('cancelWorkflow is idempotent and stops future progress (spec14 §75, §79)', async () => {
  const s = await server();
  try {
    const started = await s.startWorkflow({ workflowId: String(WF_APPROVAL), arguments: { [String(P_NAME)]: 'c' } });
    const id = (started as { instanceId: string }).instanceId;
    await waitFor(() => s.getWorkflow(id), (w) => w.status === 'waiting');

    assert.deepEqual(await s.cancelWorkflow(id), { ok: true, status: 'cancelled' });
    assert.deepEqual(await s.cancelWorkflow(id), { ok: true, status: 'cancelled' });

    await s.handle({ kind: 'event', protocol: PROTOCOL_VERSION, eventId: EV_APPROVED, payload: { [String(F_A_NAME)]: 'c' } } as ServerRequest);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await s.getWorkflow(id))?.status, 'cancelled');
    assert.equal(s.getState(S_LOG), 0, 'the notify action never ran');
  } finally {
    await s.stop();
  }
});
