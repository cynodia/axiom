import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  PRINCIPAL,
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
import type {
  ActionDef,
  AuthorizationPolicyDef,
  EntityDef,
  EventDef,
  StateDef,
  WorkflowDef,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryWorkflowStore,
} from '@cynodia/axiom-server';
import type { PrincipalRecord } from '@cynodia/axiom-server';

/**
 * spec15 Phase E — workflow instance access. `WorkflowDef.startPolicy` decides
 * `workflow.start` (discovering a workflow ≠ starting it, §100); `instanceAccessPolicy`
 * decides `workflow.cancel` / `.inspect` / `.history` when declared, otherwise the 0.14 /
 * spec14pt6 owner-fingerprint baseline holds for cancel and inspection stays an operator
 * trust boundary (§13, §14, §15, §112-§113). Unauthorized inspection is answered like a
 * missing instance (§39). Terminal cancellation stays idempotent for any caller (§110).
 */

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');

const S_LOG = nodeId('state_log');
const A_STEP = nodeId('action_step');
const EV_GO = nodeId('event_go');
const E_EV = nodeId('entity_ev');
const F_EV_TAG = fieldId('field_ev_tag');

const WF_OPEN = nodeId('wf_open'); // startPolicy: role == 'operator'; no instanceAccessPolicy
const WF_MANAGED = nodeId('wf_managed'); // instanceAccessPolicy: role == 'manager'
const P_TAG = nodeId('input_tag');

const POL_OPERATOR = nodeId('policy_operator');
const POL_MANAGER = nodeId('policy_manager');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-e', 'Authz Workflow');
  g.addNode<EntityDef>({
    id: E_USER,
    kind: 'entity',
    identityFieldId: F_UID,
    fields: [
      { id: F_UID, valueType: primitiveType('string'), required: true },
      { id: F_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });
  g.setPrincipalEntity(E_USER);
  g.addNode<StateDef>({ id: S_LOG, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<EntityDef>({
    id: E_EV,
    kind: 'entity',
    fields: [{ id: F_EV_TAG, valueType: primitiveType('string'), required: true }],
  });
  g.addNode<EventDef>({ id: EV_GO, kind: 'event', payloadType: entityType(E_EV) });
  g.addNode<ActionDef>({
    id: A_STEP,
    kind: 'action',
    invocation: { allowedSources: ['system'] },
    operations: [{ kind: 'set', target: stateLocation(S_LOG), value: binary('add', ref(S_LOG), literal(1)) }],
  });

  g.addNode<AuthorizationPolicyDef>({
    id: POL_OPERATOR,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('operator')),
  });
  g.addNode<AuthorizationPolicyDef>({
    id: POL_MANAGER,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('manager')),
  });

  // A wait-event workflow so an instance stays non-terminal for the cancel tests.
  g.addNode<WorkflowDef>({
    id: WF_OPEN,
    kind: 'workflow',
    startPolicy: POL_OPERATOR,
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('open_wait'),
    steps: [
      { type: 'wait-event', id: nodeId('open_wait'), event: EV_GO, where: binary('eq', field(ref('EVENT' as never), F_EV_TAG), ref(P_TAG)), next: nodeId('open_do') },
      { type: 'action', id: nodeId('open_do'), action: A_STEP, arguments: {}, next: nodeId('open_ok') },
      { type: 'complete', id: nodeId('open_ok') },
    ],
  });
  g.addNode<WorkflowDef>({
    id: WF_MANAGED,
    kind: 'workflow',
    instanceAccessPolicy: POL_MANAGER,
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('m_wait'),
    steps: [
      { type: 'wait-event', id: nodeId('m_wait'), event: EV_GO, where: binary('eq', field(ref('EVENT' as never), F_EV_TAG), ref(P_TAG)), next: nodeId('m_do') },
      { type: 'action', id: nodeId('m_do'), action: A_STEP, arguments: {}, next: nodeId('m_ok') },
      { type: 'complete', id: nodeId('m_ok') },
    ],
  });
  return g;
}

const IR = compileToServerIR(graph());

const OP: PrincipalRecord = { [F_UID]: 'u-op', [F_ROLE]: 'operator' };
const VIEWER: PrincipalRecord = { [F_UID]: 'u-v', [F_ROLE]: 'viewer' };
const MANAGER: PrincipalRecord = { [F_UID]: 'u-m', [F_ROLE]: 'manager' };

function host() {
  return createDeterministicServerHost({
    authenticate: (c) => (c === 'op' ? OP : c === 'viewer' ? VIEWER : c === 'manager' ? MANAGER : null),
  });
}

async function server(store?: ReturnType<typeof createMemoryWorkflowStore>) {
  const s = createAxiomServer({ ir: IR, host: host(), ...(store ? { workflowStore: store } : {}) });
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

const idOf = (r: unknown) => (r as { instanceId: string }).instanceId;
const errCode = (r: unknown) => (r as { error?: { code: string } }).error?.code;

test('spec15 §70: a workflow-policy graph labels itself axiom.server.v9 and admits', () => {
  assert.equal(IR.contract, 'axiom.server.v9');
});

test('spec15 §100: workflow.start allows the authorized principal, denies the rest, and creates no instance', async () => {
  const s = await server();
  const ok = await s.startWorkflow({ workflowId: String(WF_OPEN), arguments: { [String(P_TAG)]: 'x' }, credential: 'op' });
  assert.ok(!('error' in ok), JSON.stringify(ok));

  const denied = await s.startWorkflow({ workflowId: String(WF_OPEN), arguments: { [String(P_TAG)]: 'y' }, credential: 'viewer' });
  assert.equal(errCode(denied), 'AUTHORIZATION_DENIED');
  const anon = await s.startWorkflow({ workflowId: String(WF_OPEN), arguments: { [String(P_TAG)]: 'z' } });
  assert.equal(errCode(anon), 'AUTHORIZATION_DENIED');

  const all = await s.inspectWorkflows(100);
  assert.equal(all.length, 1, 'only the authorized start created an instance');
  await s.stop();
});

test('spec15 §13: with no instanceAccessPolicy, cancel keeps the owner-fingerprint baseline', async () => {
  const s = await server();
  const started = await s.startWorkflow({ workflowId: String(WF_OPEN), arguments: { [String(P_TAG)]: 'a' }, credential: 'op' });
  const id = idOf(started);
  await waitFor(() => s.getWorkflow(id, 'op'), (w) => w.status === 'waiting');

  // A different principal cannot cancel; the owner can.
  assert.equal(errCode(await s.cancelWorkflow(id, 'viewer')), 'AUTHORIZATION_DENIED');
  assert.deepEqual(await s.cancelWorkflow(id, 'op'), { ok: true, status: 'cancelled' });
  await s.stop();
});

test('spec15 §112-§113: with no instanceAccessPolicy, inspection stays an open operator API', async () => {
  const s = await server();
  const started = await s.startWorkflow({ workflowId: String(WF_OPEN), arguments: { [String(P_TAG)]: 'b' }, credential: 'op' });
  const id = idOf(started);
  await waitFor(() => s.getWorkflow(id), (w) => w.status === 'waiting');
  // No credential, non-owner — still readable (operator trust boundary, backward compatible).
  assert.equal((await s.getWorkflow(id))?.status, 'waiting');
  assert.ok((await s.workflowHistory(id)).length > 0);
  await s.stop();
});

test('spec15 §14: a declared instanceAccessPolicy decides cancel — explicit cross-principal, no implicit owner bypass', async () => {
  const s = await server();
  // Started by the operator; the policy requires role == manager.
  const started = await s.startWorkflow({ workflowId: String(WF_MANAGED), arguments: { [String(P_TAG)]: 'c' }, credential: 'op' });
  const id = idOf(started);
  await waitFor(() => s.getWorkflow(id, 'manager'), (w) => w.status === 'waiting');

  assert.equal(errCode(await s.cancelWorkflow(id, 'op')), 'AUTHORIZATION_DENIED', 'the starter is not a manager — no implicit owner bypass');
  assert.equal(errCode(await s.cancelWorkflow(id, 'viewer')), 'AUTHORIZATION_DENIED');
  assert.deepEqual(await s.cancelWorkflow(id, 'manager'), { ok: true, status: 'cancelled' });
  await s.stop();
});

test('spec15 §15/§39: a declared instanceAccessPolicy gates inspection — unauthorized is answered like a missing instance', async () => {
  const s = await server();
  const started = await s.startWorkflow({ workflowId: String(WF_MANAGED), arguments: { [String(P_TAG)]: 'd' }, credential: 'op' });
  const id = idOf(started);
  await waitFor(() => s.getWorkflow(id, 'manager'), (w) => w.status === 'waiting');

  assert.equal(await s.getWorkflow(id, 'op'), undefined, 'non-manager: indistinguishable from not-found');
  assert.equal(await s.getWorkflow(id), undefined, 'anonymous: indistinguishable from not-found');
  assert.deepEqual(await s.workflowHistory(id, 'viewer'), []);
  assert.equal((await s.getWorkflow(id, 'manager'))?.status, 'waiting');
  assert.ok((await s.workflowHistory(id, 'manager')).length > 0);

  // inspectWorkflows filters to what the caller may see.
  assert.equal((await s.inspectWorkflows(100, 'op')).length, 0);
  assert.equal((await s.inspectWorkflows(100, 'manager')).length, 1);
  await s.stop();
});

test('spec15 §110: cancelling an already-terminal instance stays idempotent for any caller', async () => {
  const s = await server();
  const started = await s.startWorkflow({ workflowId: String(WF_OPEN), arguments: { [String(P_TAG)]: 'e' }, credential: 'op' });
  const id = idOf(started);
  await waitFor(() => s.getWorkflow(id, 'op'), (w) => w.status === 'waiting');
  await s.handle({ kind: 'event', protocol: PROTOCOL_VERSION, eventId: EV_GO, payload: { [String(F_EV_TAG)]: 'e' } } as never);
  await waitFor(() => s.getWorkflow(id, 'op'), (w) => w.status === 'completed');

  assert.deepEqual(await s.cancelWorkflow(id, 'viewer'), { ok: true, status: 'completed' });
  assert.deepEqual(await s.cancelWorkflow(id), { ok: true, status: 'completed' });
  await s.stop();
});

test('spec15 §75: the instance-access decision is the same from a second authority (failover)', async () => {
  const shared = createMemoryWorkflowStore();
  const a = await server(shared);
  const b = await server(shared);
  const started = await a.startWorkflow({ workflowId: String(WF_MANAGED), arguments: { [String(P_TAG)]: 'f' }, credential: 'op' });
  const id = idOf(started);
  await waitFor(() => a.getWorkflow(id, 'manager'), (w) => w.status === 'waiting');

  assert.equal(errCode(await b.cancelWorkflow(id, 'op')), 'AUTHORIZATION_DENIED');
  assert.equal(await b.getWorkflow(id, 'viewer'), undefined);
  assert.deepEqual(await b.cancelWorkflow(id, 'manager'), { ok: true, status: 'cancelled' });
  assert.equal((await a.getWorkflow(id, 'manager'))?.status, 'cancelled');
  await a.stop();
  await b.stop();
});
