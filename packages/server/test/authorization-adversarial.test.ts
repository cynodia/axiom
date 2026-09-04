import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  OPERATION,
  PRINCIPAL,
  binary,
  entityType,
  every,
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
  ReadPolicyDef,
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
 * spec15 Phase I — the internal adversarial matrix (§74, §88, §136, §137). Every public
 * authority surface is probed with {owner, different principal, anonymous, role-equivalent
 * different identity, admin-like role, malformed credential}, across the asymmetric paths
 * where authorization bugs hide (server API vs engine, one-shot vs live, direct vs workflow,
 * open vs resume, idempotency reuse). The **forbidden counters** must all be zero.
 */

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const F_TENANT = fieldId('field_user_tenant');

const E_DOC = nodeId('entity_doc');
const F_DID = fieldId('field_doc_id');
const F_DTENANT = fieldId('field_doc_tenant');
const F_DFLAG = fieldId('field_doc_flag');
const E_NOTE = nodeId('entity_note');
const F_NID = fieldId('field_note_id');

const S_COUNT = nodeId('state_count');
const ROW = nodeId('scope_row');
const PROW = nodeId('scope_prow');

const POL_ADMIN = nodeId('policy_admin');
const POL_ANALYST = nodeId('policy_analyst');
const POL_MANAGER = nodeId('policy_manager');
const POL_DENY = nodeId('policy_deny');
const POL_THROW = nodeId('policy_throw');
const RP_TENANT = nodeId('rp_tenant');

const A_PUBLIC = nodeId('action_public');
const A_ADMIN = nodeId('action_admin');
const A_DENY = nodeId('action_deny');
const A_THROW = nodeId('action_throw');
const A_PROVIDER = nodeId('action_provider'); // admin-gated provider-record mutation
const A_STEP = nodeId('action_step'); // admin-gated, system-only — a workflow step
const A_LEG_DENYLIST = nodeId('action_legacy_denylist'); // legacy ActionDef.authorization: role != "banned" (spec15pt3)
const P_ID = nodeId('param_id');

const Q_DOCS = nodeId('query_docs');
const Q_NOTES = nodeId('query_notes');

const EV_GO = nodeId('event_go');
const E_EV = nodeId('entity_ev');
const F_EV_TAG = fieldId('field_ev_tag');
const WF_GUARDED = nodeId('wf_guarded');
const WF_ESCALATE = nodeId('wf_escalate'); // startable by analyst, step needs admin
const P_TAG = nodeId('input_tag');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-adv', 'Authz Adversarial');
  g.addNode<EntityDef>({
    id: E_USER,
    kind: 'entity',
    identityFieldId: F_UID,
    fields: [
      { id: F_UID, valueType: primitiveType('string'), required: true },
      { id: F_ROLE, valueType: primitiveType('string'), required: true },
      { id: F_TENANT, valueType: primitiveType('string'), required: true },
    ],
  });
  g.setPrincipalEntity(E_USER);
  g.addNode<EntityDef>({
    id: E_DOC,
    kind: 'entity',
    identityFieldId: F_DID,
    fields: [
      { id: F_DID, valueType: primitiveType('string'), required: true },
      { id: F_DTENANT, valueType: primitiveType('string'), required: true },
      { id: F_DFLAG, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: E_NOTE,
    kind: 'entity',
    identityFieldId: F_NID,
    fields: [{ id: F_NID, valueType: primitiveType('string'), required: true }],
  });
  g.addNode<EntityDef>({ id: E_EV, kind: 'entity', fields: [{ id: F_EV_TAG, valueType: primitiveType('string'), required: true }] });
  g.addNode<EventDef>({ id: EV_GO, kind: 'event', payloadType: entityType(E_EV) });
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });

  g.addNode<AuthorizationPolicyDef>({ id: POL_ADMIN, kind: 'authorization-policy', allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('admin')) });
  g.addNode<AuthorizationPolicyDef>({ id: POL_ANALYST, kind: 'authorization-policy', allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('analyst')) });
  g.addNode<AuthorizationPolicyDef>({ id: POL_MANAGER, kind: 'authorization-policy', allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('manager')) });
  g.addNode<AuthorizationPolicyDef>({ id: POL_DENY, kind: 'authorization-policy', allow: literal(false) });
  g.addNode<AuthorizationPolicyDef>({ id: POL_THROW, kind: 'authorization-policy', allow: every(ref(OPERATION), nodeId('x'), literal(true)) });
  g.addNode<ReadPolicyDef>({
    id: RP_TENANT,
    kind: 'read-policy',
    entityId: E_DOC,
    rowScopeId: PROW,
    predicate: binary('eq', field(ref(PROW), F_DTENANT), field(ref(PRINCIPAL), F_TENANT)),
  });

  const bump = (): ActionDef['operations'] => [
    { kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) },
  ];
  g.addNode<ActionDef>({ id: A_PUBLIC, kind: 'action', operations: bump() });
  g.addNode<ActionDef>({ id: A_ADMIN, kind: 'action', authorizationPolicy: POL_ADMIN, operations: bump() });
  g.addNode<ActionDef>({ id: A_DENY, kind: 'action', authorizationPolicy: POL_DENY, operations: bump() });
  g.addNode<ActionDef>({ id: A_THROW, kind: 'action', authorizationPolicy: POL_THROW, operations: bump() });
  g.addNode<ActionDef>({
    id: A_PROVIDER,
    kind: 'action',
    authorizationPolicy: POL_ADMIN,
    parameters: [{ id: P_ID, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: providerRecordFieldLocation(E_DOC, F_DID, ref(P_ID), F_DFLAG), value: literal('touched') }],
  } as ActionDef);
  g.addNode<ActionDef>({ id: A_STEP, kind: 'action', authorizationPolicy: POL_ADMIN, invocation: { allowedSources: ['system'] }, operations: bump() });
  g.addNode<ActionDef>({
    id: A_LEG_DENYLIST,
    kind: 'action',
    authorization: binary('neq', field(ref(PRINCIPAL), F_ROLE), literal('banned')),
    operations: bump(),
  } as ActionDef);

  g.addNode<QueryDef>({
    id: Q_DOCS,
    kind: 'query',
    source: E_DOC,
    rowScopeId: ROW,
    authorizationPolicy: POL_ANALYST,
    readPolicyId: RP_TENANT,
    sort: [{ key: field(ref(ROW), F_DID), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);
  g.addNode<QueryDef>({
    id: Q_NOTES,
    kind: 'query',
    source: E_NOTE,
    rowScopeId: ROW,
    sort: [{ key: field(ref(ROW), F_NID), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);

  const wait = (id: ReturnType<typeof nodeId>, next: ReturnType<typeof nodeId>) => ({
    type: 'wait-event' as const,
    id,
    event: EV_GO,
    where: binary('eq', field(ref('EVENT' as never), F_EV_TAG), ref(P_TAG)),
    next,
  });
  g.addNode<WorkflowDef>({
    id: WF_GUARDED,
    kind: 'workflow',
    startPolicy: POL_ADMIN,
    instanceAccessPolicy: POL_MANAGER,
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('g_wait'),
    steps: [wait(nodeId('g_wait'), nodeId('g_do')), { type: 'action', id: nodeId('g_do'), action: A_STEP, arguments: {}, next: nodeId('g_ok') }, { type: 'complete', id: nodeId('g_ok') }],
  });
  g.addNode<WorkflowDef>({
    id: WF_ESCALATE,
    kind: 'workflow',
    startPolicy: POL_ANALYST, // an analyst may start it…
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('e_do'),
    steps: [
      // …but the first step needs admin — the analyst gains no authority from starting it.
      { type: 'action', id: nodeId('e_do'), action: A_STEP, arguments: {}, next: nodeId('e_ok') },
      { type: 'complete', id: nodeId('e_ok') },
    ],
  });
  return g;
}

const IR = compileToServerIR(graph());
const DOCS = [
  { [F_DID]: 'a', [F_DTENANT]: 't1', [F_DFLAG]: 'clean' },
  { [F_DID]: 'b', [F_DTENANT]: 't2', [F_DFLAG]: 'clean' },
];
const NOTES = [{ [F_NID]: 'n1' }, { [F_NID]: 'n2' }];

// The adversarial principal set (spec15 §74).
const PRINCIPALS: Record<string, PrincipalRecord> = {
  owner: { [F_UID]: 'u-owner', [F_ROLE]: 'admin', [F_TENANT]: 't1' }, // owner / admin-like
  other: { [F_UID]: 'u-other', [F_ROLE]: 'viewer', [F_TENANT]: 't1' }, // different principal
  'admin-2': { [F_UID]: 'u-admin2', [F_ROLE]: 'admin', [F_TENANT]: 't1' }, // same role, different identity
  analyst: { [F_UID]: 'u-an', [F_ROLE]: 'analyst', [F_TENANT]: 't1' },
  'analyst-2': { [F_UID]: 'u-an2', [F_ROLE]: 'analyst', [F_TENANT]: 't2' }, // role-equivalent, different identity/tenant
  manager: { [F_UID]: 'u-mgr', [F_ROLE]: 'manager', [F_TENANT]: 't1' },
  banned: { [F_UID]: 'u-ban', [F_ROLE]: 'banned', [F_TENANT]: 't1' }, // on a legacy deny-list
  no_role: { [F_UID]: 'u-nr', [F_TENANT]: 't1' } as PrincipalRecord, // attribute-less named principal (spec15pt3 §29)
};

interface Counters {
  unauthorized_action_execution: number;
  unauthorized_state_mutation: number;
  unauthorized_provider_mutation: number;
  unauthorized_record_observation: number;
  unauthorized_workflow_start: number;
  unauthorized_workflow_inspection: number;
  unauthorized_workflow_cancellation: number;
  cross_principal_cursor_resume: number;
  cross_principal_idempotency_reuse: number;
  revoked_live_data_continues: number;
  revoked_workflow_privilege_continues: number;
  policy_fail_open: number;
  native_authorization_exception: number;
  legacy_missing_attribute_allow: number; // spec15pt3 §108 — legacy ActionDef.authorization fail-open
}

function zeroCounters(): Counters {
  return {
    unauthorized_action_execution: 0,
    unauthorized_state_mutation: 0,
    unauthorized_provider_mutation: 0,
    unauthorized_record_observation: 0,
    unauthorized_workflow_start: 0,
    unauthorized_workflow_inspection: 0,
    unauthorized_workflow_cancellation: 0,
    cross_principal_cursor_resume: 0,
    cross_principal_idempotency_reuse: 0,
    revoked_live_data_continues: 0,
    revoked_workflow_privilege_continues: 0,
    policy_fail_open: 0,
    native_authorization_exception: 0,
    legacy_missing_attribute_allow: 0,
  };
}

function makeServer() {
  const revoked = new Set<string>();
  const s = createAxiomServer({
    ir: IR,
    persistence: createMemoryPersistence(),
    dataProvider: createMemoryDataProvider({
      rows: { [E_DOC]: DOCS.map((r) => ({ ...r })), [E_NOTE]: NOTES.map((r) => ({ ...r })) } as never,
      maxPageSize: 100,
    }),
    host: createDeterministicServerHost({
      authenticate: (c) => (typeof c === 'string' && !revoked.has(c) ? (PRINCIPALS[c] ?? null) : null),
    }),
  });
  return { s, revoked };
}

async function nextMessage(it: AsyncIterator<LiveQueryMessage>): Promise<LiveQueryMessage> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no live message within 1s')), 1000);
  });
  try {
    const r = await Promise.race([it.next(), timeout]);
    return r.value as LiveQueryMessage;
  } finally {
    clearTimeout(timer!);
  }
}

const invoke = (s: ReturnType<typeof makeServer>['s'], action: ReturnType<typeof nodeId>, credential?: string, args: Record<string, unknown> = {}, requestId?: string) =>
  s.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: action,
    arguments: args,
    ...(credential ? { credential } : {}),
    ...(requestId ? { requestId } : {}),
  } as ServerRequest) as Promise<{ ok?: boolean; diagnostics?: Array<{ code?: unknown }> }>;

const query = (s: ReturnType<typeof makeServer>['s'], q: ReturnType<typeof nodeId>, credential?: string) =>
  s.handle({ kind: 'query', protocol: PROTOCOL_VERSION, queryId: q, arguments: {}, ...(credential ? { credential } : {}) } as ServerRequest) as Promise<{
    ok?: boolean;
    diagnostics?: Array<{ code?: unknown }>;
    page?: { items?: Array<Record<string, unknown>> };
  }>;

const denied = (r: { ok?: boolean; diagnostics?: Array<{ code?: unknown }> }) =>
  r.ok === false && (r.diagnostics ?? []).some((d) => String(d.code) === 'AUTHORIZATION_DENIED');

test('spec15 §88/§137: the adversarial matrix leaves every forbidden counter at zero', async () => {
  const c = zeroCounters();
  const { s, revoked } = makeServer();
  const nativeErrors: string[] = [];

  try {
    // ---- unauthorized action execution / state mutation (§74, direct path) --------------
    for (const cred of [undefined, 'other', 'analyst', 'analyst-2', 'garbage-credential']) {
      const before = s.getState(S_COUNT);
      let r: Awaited<ReturnType<typeof invoke>>;
      try {
        r = await invoke(s, A_ADMIN, cred);
      } catch (e) {
        nativeErrors.push(`invoke A_ADMIN as ${cred}: ${String(e)}`);
        continue;
      }
      if (r.ok === true) c.unauthorized_action_execution += 1;
      if (!denied(r)) c.unauthorized_action_execution += 1; // must be a *structured* denial
      if (s.getState(S_COUNT) !== before) c.unauthorized_state_mutation += 1;
    }
    // admin (owner) and a role-equivalent different admin identity both succeed — no confusion.
    assert.equal((await invoke(s, A_ADMIN, 'owner')).ok, true);
    assert.equal((await invoke(s, A_ADMIN, 'admin-2')).ok, true);

    // ---- policy fail-open: a policy that throws must DENY, never ALLOW (§88, §137) -------
    {
      const before = s.getState(S_COUNT);
      const r = await invoke(s, A_THROW, 'owner');
      if (r.ok === true) c.policy_fail_open += 1;
      if (!denied(r)) c.policy_fail_open += 1;
      if (s.getState(S_COUNT) !== before) c.unauthorized_state_mutation += 1;
    }
    // a constant-deny policy denies even the owner (mixed-build fail-closed shape).
    if ((await invoke(s, A_DENY, 'owner')).ok === true) c.policy_fail_open += 1;

    // ---- legacy ActionDef.authorization deny-list absent-value fail-open (spec15pt3) ------
    // `role != "banned"` must DENY a banned role, an attribute-less named principal, an
    // anonymous caller and an unresolvable credential — and ALLOW only a concrete non-banned
    // role. A missing `role` must never become authority through `neq`.
    {
      assert.equal((await invoke(s, A_LEG_DENYLIST, 'other')).ok, true, 'a concrete non-banned role still ALLOWs (no overcorrection)');
      for (const cred of ['banned', 'no_role', undefined, 'garbage-credential']) {
        const before = s.getState(S_COUNT);
        const r = await invoke(s, A_LEG_DENYLIST, cred);
        if (r.ok === true) c.legacy_missing_attribute_allow += 1;
        if (!denied(r)) c.legacy_missing_attribute_allow += 1; // a *structured* denial
        if (s.getState(S_COUNT) !== before) c.unauthorized_state_mutation += 1;
      }
    }

    // ---- unauthorized provider mutation (§88 provider bypass) ---------------------------
    {
      const r = await invoke(s, A_PROVIDER, 'other', { [String(P_ID)]: 'a' });
      if (r.ok === true) c.unauthorized_provider_mutation += 1;
      const rows = (await query(s, Q_DOCS, 'analyst')).page?.items ?? [];
      const doc = rows.find((x) => String(x[F_DID as unknown as string]) === 'a');
      if (doc && String(doc[F_DFLAG as unknown as string]) !== 'clean') c.unauthorized_provider_mutation += 1;
    }

    // ---- unauthorized record observation + tenant isolation (§88) ----------------------
    for (const cred of [undefined, 'other', 'garbage-credential']) {
      if (!denied(await query(s, Q_DOCS, cred))) c.unauthorized_record_observation += 1;
    }
    {
      const t1 = ((await query(s, Q_DOCS, 'analyst')).page?.items ?? []).map((x) => String(x[F_DID as unknown as string]));
      const t2 = ((await query(s, Q_DOCS, 'analyst-2')).page?.items ?? []).map((x) => String(x[F_DID as unknown as string]));
      if (t1.includes('b')) c.unauthorized_record_observation += 1; // t1 caller sees a t2 row
      if (t2.includes('a')) c.unauthorized_record_observation += 1;
    }
    // one-shot vs live: the same unauthorized caller is refused on both paths (§136 asymmetry).
    {
      const oneShot = denied(await query(s, Q_DOCS, 'other'));
      const live = await s.openLiveQuery({ queryId: String(Q_DOCS), credential: 'other' });
      const liveDenied = 'error' in live && String((live as { error: { code: string } }).error.code) === 'AUTHORIZATION_DENIED';
      if (oneShot !== liveDenied) c.unauthorized_record_observation += 1;
      if (!liveDenied) c.unauthorized_record_observation += 1;
    }

    // ---- cross-principal idempotency reuse (§118, §120) -------------------------------
    {
      const key = 'shared-key-K';
      const ok1 = await invoke(s, A_ADMIN, 'owner', {}, key); // owner succeeds under K
      assert.equal(ok1.ok, true);
      const before = s.getState(S_COUNT);
      const r2 = await invoke(s, A_ADMIN, 'other', {}, key); // a different principal reuses K
      if (r2.ok === true) c.cross_principal_idempotency_reuse += 1; // must NOT inherit owner's success
      if (!denied(r2)) c.cross_principal_idempotency_reuse += 1;
      if (s.getState(S_COUNT) !== before) c.cross_principal_idempotency_reuse += 1;
    }

    // ---- unauthorized workflow start (§88) -------------------------------------------
    for (const cred of [undefined, 'other', 'analyst', 'garbage-credential']) {
      const r = (await s.startWorkflow({ workflowId: String(WF_GUARDED), arguments: { [String(P_TAG)]: 't' }, ...(cred ? { credential: cred } : {}) })) as {
        instanceId?: string;
        error?: { code?: string };
      };
      if (typeof r.instanceId === 'string') c.unauthorized_workflow_start += 1;
      if (r.error?.code !== 'AUTHORIZATION_DENIED') c.unauthorized_workflow_start += 1;
    }

    // ---- workflow inspection + cancellation, owner vs other vs anon (§88) -------------
    {
      const started = (await s.startWorkflow({ workflowId: String(WF_GUARDED), arguments: { [String(P_TAG)]: 'wf' }, credential: 'owner' })) as { instanceId: string };
      const id = started.instanceId;
      // wait for it to park on the event
      for (let i = 0; i < 40; i += 1) {
        const w = await s.getWorkflow(id, 'manager');
        if (w?.status === 'waiting') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      for (const cred of [undefined, 'owner', 'other', 'analyst-2']) {
        if ((await s.getWorkflow(id, cred)) !== undefined) c.unauthorized_workflow_inspection += 1; // only 'manager' may see it
        if ((await s.workflowHistory(id, cred)).length > 0) c.unauthorized_workflow_inspection += 1;
      }
      assert.notEqual(await s.getWorkflow(id, 'manager'), undefined); // the authorized caller can
      for (const cred of [undefined, 'owner', 'other', 'analyst-2', 'garbage-credential']) {
        const r = (await s.cancelWorkflow(id, cred)) as { ok?: boolean; error?: { code?: string } };
        if (r.ok === true) c.unauthorized_workflow_cancellation += 1;
        if (r.error?.code !== 'AUTHORIZATION_DENIED') c.unauthorized_workflow_cancellation += 1;
      }
      if ((await s.getWorkflow(id, 'manager'))?.status !== 'waiting') c.unauthorized_workflow_cancellation += 1; // still intact
    }

    // ---- cross-principal cursor resume (§88, §136) ----------------------------------
    {
      const opened = await s.openLiveQuery({ queryId: String(Q_DOCS), credential: 'analyst' });
      if (!('error' in opened)) {
        const handle = opened as LiveQueryHandle;
        const it = handle[Symbol.asyncIterator]();
        await nextMessage(it); // consume initial
        for (const cred of ['analyst-2', 'other', 'garbage-credential']) {
          const resumed = await s.resumeLiveQuery(handle.cursor(), { queryId: String(Q_DOCS), credential: cred });
          if (!('error' in resumed)) c.cross_principal_cursor_resume += 1; // must never hand P2 P1's stream
        }
        handle.close();
      }
    }

    // ---- revoked live data must not continue (§88, §137) ---------------------------
    {
      const opened = await s.openLiveQuery({ queryId: String(Q_DOCS), credential: 'analyst' });
      if (!('error' in opened)) {
        const handle = opened as LiveQueryHandle;
        const it = handle[Symbol.asyncIterator]();
        await nextMessage(it);
        revoked.add('analyst');
        await invoke(s, A_PROVIDER, 'owner', { [String(P_ID)]: 'b' }); // a commit that forces re-evaluation
        const msg = await nextMessage(it);
        if (!(msg.kind === 'error' && String((msg as { code: string }).code) === 'AUTHORIZATION_DENIED')) {
          c.revoked_live_data_continues += 1;
        }
        handle.close();
        revoked.delete('analyst');
      }
    }

    // ---- a workflow grants no standing authority (§88, §101) ----------------------
    {
      const before = s.getState(S_COUNT);
      const started = (await s.startWorkflow({ workflowId: String(WF_ESCALATE), arguments: { [String(P_TAG)]: 'esc' }, credential: 'analyst' })) as { instanceId: string };
      const id = started.instanceId;
      let terminal: string | undefined;
      for (let i = 0; i < 60; i += 1) {
        terminal = (await s.getWorkflow(id, 'manager'))?.status;
        if (terminal === 'failed' || terminal === 'completed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (terminal !== 'failed') c.revoked_workflow_privilege_continues += 1; // the admin-only step must not run under an analyst
      if (s.getState(S_COUNT) !== before) c.revoked_workflow_privilege_continues += 1;
    }
  } catch (error) {
    nativeErrors.push(String(error));
  } finally {
    await s.stop().catch(() => {});
  }

  assert.deepEqual(nativeErrors, [], `native errors from the authorization path:\n${nativeErrors.join('\n')}`);
  for (const [name, value] of Object.entries(c)) {
    assert.equal(value, 0, `forbidden counter "${name}" = ${value}`);
  }
});
