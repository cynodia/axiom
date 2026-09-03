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
  providerRecordFieldLocation,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  AuthorizationPolicyDef,
  EntityDef,
  EventDef,
  QueryDef,
  StateDef,
  WorkflowDef,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { LiveQueryHandle, LiveQueryMessage, PrincipalRecord, ServerRequest } from '@cynodia/axiom-server';

/**
 * spec15pt2 F1 + F3 — absent-value safety and the `authenticate()` exception boundary,
 * end to end on every policy-bearing surface.
 *
 * F1: a deny-list policy `PRINCIPAL.role != "banned"` must ALLOW a concrete non-banned role
 * and DENY when the role is absent / anonymous — `neq` over a missing security field never
 * creates authority (§10, §19, §20). F3: a throwing `host.authenticate` fails closed with a
 * structured refusal, no native exception, no mutation, no secret disclosure (§42-§47).
 */

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const E_DOC = nodeId('entity_doc');
const F_DID = fieldId('field_doc_id');
const F_DFLAG = fieldId('field_doc_flag');
const S_COUNT = nodeId('state_count');
const ROW = nodeId('scope_row');
const POL_DENYLIST = nodeId('policy_denylist'); // role != "banned"
const POL_PUBLIC = nodeId('policy_public'); // literal(true)
const A_GUARDED = nodeId('action_guarded');
const A_PUBLIC = nodeId('action_public');
const Q_GUARDED = nodeId('query_guarded');
const WF_START = nodeId('wf_start'); // startPolicy: denylist
const WF_INSTANCE = nodeId('wf_instance'); // instanceAccessPolicy: denylist
const A_STEP = nodeId('action_step');
const A_TOUCH = nodeId('action_touch'); // public provider-record write, to force live re-eval
const P_ID = nodeId('param_id');
const EV = nodeId('event_go');
const E_EV = nodeId('entity_ev');
const F_TAG = fieldId('field_ev_tag');
const P_TAG = nodeId('input_tag');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-pt2', 'Authz pt2');
  g.addNode<EntityDef>({
    id: E_USER,
    kind: 'entity',
    identityFieldId: F_UID,
    fields: [
      { id: F_UID, valueType: primitiveType('string'), required: true },
      { id: F_ROLE, valueType: primitiveType('string'), required: false },
    ],
  });
  g.setPrincipalEntity(E_USER);
  g.addNode<EntityDef>({
    id: E_DOC,
    kind: 'entity',
    identityFieldId: F_DID,
    fields: [
      { id: F_DID, valueType: primitiveType('string'), required: true },
      { id: F_DFLAG, valueType: primitiveType('string'), required: false },
    ],
  });
  g.addNode<EntityDef>({ id: E_EV, kind: 'entity', fields: [{ id: F_TAG, valueType: primitiveType('string'), required: true }] });
  g.addNode<EventDef>({ id: EV, kind: 'event', payloadType: entityType(E_EV) });
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });

  g.addNode<AuthorizationPolicyDef>({
    id: POL_DENYLIST,
    kind: 'authorization-policy',
    allow: binary('neq', field(ref(PRINCIPAL), F_ROLE), literal('banned')),
  });
  g.addNode<AuthorizationPolicyDef>({ id: POL_PUBLIC, kind: 'authorization-policy', allow: literal(true) });

  const bump = (): ActionDef['operations'] => [
    { kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) },
  ];
  g.addNode<ActionDef>({ id: A_GUARDED, kind: 'action', authorizationPolicy: POL_DENYLIST, operations: bump() });
  g.addNode<ActionDef>({ id: A_PUBLIC, kind: 'action', authorizationPolicy: POL_PUBLIC, operations: bump() });
  g.addNode<ActionDef>({ id: A_STEP, kind: 'action', authorizationPolicy: POL_DENYLIST, invocation: { allowedSources: ['system'] }, operations: bump() });
  g.addNode<ActionDef>({
    id: A_TOUCH,
    kind: 'action',
    authorizationPolicy: POL_PUBLIC,
    parameters: [{ id: P_ID, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: providerRecordFieldLocation(E_DOC, F_DID, ref(P_ID), F_DFLAG), value: literal('x') }],
  } as ActionDef);

  g.addNode<QueryDef>({
    id: Q_GUARDED,
    kind: 'query',
    source: E_DOC,
    rowScopeId: ROW,
    authorizationPolicy: POL_DENYLIST,
    sort: [{ key: field(ref(ROW), F_DID), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);

  const wait = (id: ReturnType<typeof nodeId>, next: ReturnType<typeof nodeId>) => ({
    type: 'wait-event' as const,
    id,
    event: EV,
    where: binary('eq', field(ref('EVENT' as never), F_TAG), ref(P_TAG)),
    next,
  });
  g.addNode<WorkflowDef>({
    id: WF_START,
    kind: 'workflow',
    startPolicy: POL_DENYLIST,
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('ws_wait'),
    steps: [wait(nodeId('ws_wait'), nodeId('ws_done')), { type: 'complete', id: nodeId('ws_done') }],
  });
  g.addNode<WorkflowDef>({
    id: WF_INSTANCE,
    kind: 'workflow',
    instanceAccessPolicy: POL_DENYLIST,
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('wi_wait'),
    steps: [wait(nodeId('wi_wait'), nodeId('wi_done')), { type: 'complete', id: nodeId('wi_done') }],
  });
  return g;
}

const IR = compileToServerIR(graph());
const USER: PrincipalRecord = { [F_UID]: 'u-user', [F_ROLE]: 'user' };
const BANNED: PrincipalRecord = { [F_UID]: 'u-ban', [F_ROLE]: 'banned' };
const NOROLE: PrincipalRecord = { [F_UID]: 'u-nr' }; // role field absent

function server(authenticate?: (c: unknown) => PrincipalRecord | null) {
  return createAxiomServer({
    ir: IR,
    persistence: createMemoryPersistence(),
    dataProvider: createMemoryDataProvider({ rows: { [E_DOC]: [{ [F_DID]: 'd1' }] } as never, maxPageSize: 100 }),
    host: createDeterministicServerHost({
      authenticate:
        authenticate ??
        ((c) => (c === 'user' ? USER : c === 'banned' ? BANNED : c === 'norole' ? NOROLE : null)),
    }),
  });
}

const invoke = (s: ReturnType<typeof server>, action: ReturnType<typeof nodeId>, credential?: string) =>
  s.handle({ kind: 'invoke', protocol: PROTOCOL_VERSION, actionId: action, arguments: {}, ...(credential ? { credential } : {}) } as ServerRequest) as Promise<{
    ok?: boolean;
    diagnostics?: Array<{ code?: unknown }>;
  }>;
const query = (s: ReturnType<typeof server>, credential?: string) =>
  s.handle({ kind: 'query', protocol: PROTOCOL_VERSION, queryId: Q_GUARDED, arguments: {}, ...(credential ? { credential } : {}) } as ServerRequest) as Promise<{
    ok?: boolean;
    diagnostics?: Array<{ code?: unknown }>;
  }>;
const denied = (r: { ok?: boolean; diagnostics?: Array<{ code?: unknown }> }) =>
  r.ok === false && (r.diagnostics ?? []).some((d) => String(d.code) === 'AUTHORIZATION_DENIED');

async function nextMessage(it: AsyncIterator<LiveQueryMessage>): Promise<LiveQueryMessage> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no live message within 1s')), 1000);
  });
  try {
    return (await Promise.race([it.next(), timeout])).value as LiveQueryMessage;
  } finally {
    clearTimeout(timer!);
  }
}

test('spec15pt2 §70: a deny-list-policy graph still labels itself axiom.server.v9', () => {
  assert.equal(IR.contract, 'axiom.server.v9');
});

test('spec15pt2 §19/§21: `role != "banned"` on an action — concrete allows, absent / anonymous deny', async () => {
  const s = server();
  try {
    assert.equal((await invoke(s, A_GUARDED, 'user')).ok, true);
    assert.equal(denied(await invoke(s, A_GUARDED, 'banned')), true);
    assert.equal(denied(await invoke(s, A_GUARDED, 'norole')), true, 'role field absent ⇒ DENY');
    assert.equal(denied(await invoke(s, A_GUARDED)), true, 'anonymous ⇒ DENY');
    assert.equal(denied(await invoke(s, A_GUARDED, 'garbage')), true, 'unresolvable credential ⇒ DENY');
    assert.equal(s.getState(S_COUNT), 1, 'only the one authorized invoke committed');
  } finally {
    await s.stop();
  }
});

test('spec15pt2 §14/C5: an explicit `literal(true)` policy still admits an anonymous caller', async () => {
  const s = server();
  try {
    assert.equal((await invoke(s, A_PUBLIC)).ok, true);
  } finally {
    await s.stop();
  }
});

test('spec15pt2 §22: `query.read` deny-list — same absent-value semantics', async () => {
  const s = server();
  try {
    assert.equal((await query(s, 'user')).ok, true);
    assert.equal(denied(await query(s, 'norole')), true);
    assert.equal(denied(await query(s)), true);
  } finally {
    await s.stop();
  }
});

test('spec15pt2 §23/§24: workflow start & instance-access deny-list — absent role denies', async () => {
  const s = server();
  try {
    const okStart = (await s.startWorkflow({ workflowId: String(WF_START), arguments: { [String(P_TAG)]: 't' }, credential: 'user' })) as { instanceId?: string };
    assert.equal(typeof okStart.instanceId, 'string');
    const noStart = (await s.startWorkflow({ workflowId: String(WF_START), arguments: { [String(P_TAG)]: 't' }, credential: 'norole' })) as { error?: { code?: string } };
    assert.equal(noStart.error?.code, 'AUTHORIZATION_DENIED');

    const inst = (await s.startWorkflow({ workflowId: String(WF_INSTANCE), arguments: { [String(P_TAG)]: 'i' }, credential: 'user' })) as { instanceId: string };
    for (let i = 0; i < 40; i += 1) {
      if ((await s.getWorkflow(inst.instanceId, 'user'))?.status === 'waiting') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.notEqual(await s.getWorkflow(inst.instanceId, 'user'), undefined, 'a non-banned role may inspect');
    assert.equal(await s.getWorkflow(inst.instanceId, 'norole'), undefined, 'absent role ⇒ not visible');
    assert.equal(((await s.cancelWorkflow(inst.instanceId, 'norole')) as { error?: { code?: string } }).error?.code, 'AUTHORIZATION_DENIED');
  } finally {
    await s.stop();
  }
});

test('spec15pt2 §26/§27: live open & re-evaluation deny-list — absent role denies, revoked-to-absent stops the stream', async () => {
  let role: string | undefined = 'user';
  const s = server((c) => (c === 'live' ? ({ [F_UID]: 'u-l', ...(role ? { [F_ROLE]: role } : {}) } as PrincipalRecord) : null));
  try {
    assert.ok('error' in (await s.openLiveQuery({ queryId: String(Q_GUARDED), credential: 'nobody' })));
    const opened = await s.openLiveQuery({ queryId: String(Q_GUARDED), credential: 'live' });
    assert.ok(!('error' in opened), JSON.stringify((opened as { error?: unknown }).error));
    const it = (opened as LiveQueryHandle)[Symbol.asyncIterator]();
    await nextMessage(it); // initial

    role = undefined; // the caller's role attribute disappears
    await s.handle({ kind: 'invoke', protocol: PROTOCOL_VERSION, actionId: A_TOUCH, arguments: { [String(P_ID)]: 'd1' } } as ServerRequest); // provider-record commit forces re-evaluation
    const msg = await nextMessage(it);
    assert.equal(msg.kind, 'error');
    assert.equal(String((msg as { code: string }).code), 'AUTHORIZATION_DENIED');
    (opened as LiveQueryHandle).close();
  } finally {
    await s.stop();
  }
});

test('spec15pt2 F3 §42-§47: a throwing host.authenticate fails closed on every surface, secret-free, zero mutation', async () => {
  const s = server(() => {
    throw new Error('secret-token=XYZ internal stack frobnicator');
  });
  try {
    const leak = (v: unknown) => JSON.stringify(v).includes('XYZ') || JSON.stringify(v).includes('frobnicator');

    const inv = await invoke(s, A_PUBLIC, 'anything');
    assert.equal(inv.ok, false);
    assert.ok((inv.diagnostics ?? []).some((d) => String(d.code) === 'AUTHORIZATION_DENIED'));
    assert.ok(!leak(inv), 'no exception detail crosses the boundary');

    const q = await query(s, 'anything');
    assert.equal(q.ok, false);
    assert.ok(!leak(q));

    const start = await s.startWorkflow({ workflowId: String(WF_START), arguments: { [String(P_TAG)]: 't' }, credential: 'anything' });
    assert.ok('error' in start && String((start as { error: { code: string } }).error.code) === 'AUTHORIZATION_DENIED');
    assert.ok(!leak(start));

    const cancel = await s.cancelWorkflow('wf_nonexistent', 'anything');
    assert.ok('error' in cancel);
    assert.ok(!leak(cancel));

    const live = await s.openLiveQuery({ queryId: String(Q_GUARDED), credential: 'anything' });
    assert.ok('error' in live && String((live as { error: { code: string } }).error.code) === 'AUTHORIZATION_DENIED');
    assert.ok(!leak(live));

    // Nothing mutated and no workflow instance exists.
    assert.equal(s.getState(S_COUNT), 0);
    assert.deepEqual(await s.inspectWorkflows(100), []);
  } finally {
    await s.stop();
  }
});
