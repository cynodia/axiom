import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  PRINCIPAL,
  binary,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  unary,
} from '@cynodia/axiom-core';
import type { ActionDef, AuthorizationPolicyDef, EntityDef, StateDef, WorkflowDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { PrincipalRecord, ServerRequest } from '@cynodia/axiom-server';

/**
 * spec15pt3 F1-legacy — the legacy `ActionDef.authorization` expression now goes through the
 * **same** security-absence-aware evaluator as `AuthorizationPolicyDef.allow`. A deny-list
 * expression (`role != "banned"`, `NOT(role == "banned")`) must ALLOW a concrete non-banned
 * role and DENY when the role is absent / the caller is anonymous / the credential is
 * unresolvable — on every action path (direct and workflow step) — while `literal(true)`
 * still admits an anonymous caller and a positive `role == "admin"` rule is unchanged.
 */

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const S_COUNT = nodeId('state_count');
const POL_PUBLIC = nodeId('policy_public'); // literal(true)
const POL_DENY = nodeId('policy_deny'); // literal(false)
const A_NEQ = nodeId('action_neq'); // legacy: role != "banned"
const A_NOTEQ = nodeId('action_noteq'); // legacy: NOT(role == "banned")
const A_ADMIN = nodeId('action_admin'); // legacy: role == "admin"
const A_TRUE = nodeId('action_true'); // legacy: literal(true)
const A_NEQ_PLUS_PUBLIC = nodeId('action_neq_plus_public'); // legacy deny-list ∧ policy literal(true)
const A_ADMIN_PLUS_DENY = nodeId('action_admin_plus_deny'); // legacy role==admin ∧ policy literal(false)
const A_STEP = nodeId('action_step'); // workflow step, legacy: role != "banned"
const WF = nodeId('wf_step');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-pt3', 'Authz pt3');
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
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });

  g.addNode<AuthorizationPolicyDef>({ id: POL_PUBLIC, kind: 'authorization-policy', allow: literal(true) });
  g.addNode<AuthorizationPolicyDef>({ id: POL_DENY, kind: 'authorization-policy', allow: literal(false) });

  const bump = (): ActionDef['operations'] => [
    { kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) },
  ];
  const roleNeqBanned = binary('neq', field(ref(PRINCIPAL), F_ROLE), literal('banned'));
  const notRoleEqBanned = unary('not', binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('banned')));
  const roleEqAdmin = binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('admin'));

  g.addNode<ActionDef>({ id: A_NEQ, kind: 'action', authorization: roleNeqBanned, operations: bump() });
  g.addNode<ActionDef>({ id: A_NOTEQ, kind: 'action', authorization: notRoleEqBanned, operations: bump() });
  g.addNode<ActionDef>({ id: A_ADMIN, kind: 'action', authorization: roleEqAdmin, operations: bump() });
  g.addNode<ActionDef>({ id: A_TRUE, kind: 'action', authorization: literal(true), operations: bump() });
  g.addNode<ActionDef>({
    id: A_NEQ_PLUS_PUBLIC,
    kind: 'action',
    authorization: roleNeqBanned,
    authorizationPolicy: POL_PUBLIC,
    operations: bump(),
  } as ActionDef);
  g.addNode<ActionDef>({
    id: A_ADMIN_PLUS_DENY,
    kind: 'action',
    authorization: roleEqAdmin,
    authorizationPolicy: POL_DENY,
    operations: bump(),
  } as ActionDef);
  g.addNode<ActionDef>({
    id: A_STEP,
    kind: 'action',
    authorization: roleNeqBanned,
    invocation: { allowedSources: ['system'] },
    operations: bump(),
  } as ActionDef);

  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    inputs: [],
    entry: nodeId('s_do'),
    steps: [
      { type: 'action', id: nodeId('s_do'), action: A_STEP, arguments: {}, next: nodeId('s_ok') },
      { type: 'complete', id: nodeId('s_ok') },
    ],
  });
  return g;
}

const IR = compileToServerIR(graph());
const USER: PrincipalRecord = { [F_UID]: 'u-user', [F_ROLE]: 'user' };
const ADMIN: PrincipalRecord = { [F_UID]: 'u-adm', [F_ROLE]: 'admin' };
const BANNED: PrincipalRecord = { [F_UID]: 'u-ban', [F_ROLE]: 'banned' };
const NOROLE: PrincipalRecord = { [F_UID]: 'u-nr' }; // role field absent

function server() {
  return createAxiomServer({
    ir: IR,
    persistence: createMemoryPersistence(),
    host: createDeterministicServerHost({
      authenticate: (c) =>
        (c === 'user' ? USER : c === 'admin' ? ADMIN : c === 'banned' ? BANNED : c === 'norole' ? NOROLE : null) as never,
    }),
  });
}

type Res = { ok?: boolean; diagnostics?: Array<{ code?: unknown; details?: Record<string, unknown> }>; replayed?: boolean };

const invoke = (
  s: ReturnType<typeof server>,
  action: ReturnType<typeof nodeId>,
  credential?: string,
  requestId?: string,
) =>
  s.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: action,
    arguments: {},
    ...(credential ? { credential } : {}),
    ...(requestId ? { requestId } : {}),
  } as ServerRequest) as Promise<Res>;

const denied = (r: Res) =>
  r.ok === false && (r.diagnostics ?? []).some((d) => String(d.code) === 'AUTHORIZATION_DENIED');
const legacyDeniedReason = (r: Res) =>
  (r.diagnostics ?? []).find((d) => String(d.code) === 'AUTHORIZATION_DENIED')?.details?.reason;

test('spec15pt3 §70/§35: a legacy-authorization graph still labels itself axiom.server.v9', () => {
  assert.equal(IR.contract, 'axiom.server.v9');
});

test('spec15pt3 §11: legacy `role != "banned"` — concrete allows; absent / anonymous / unresolvable deny', async () => {
  const s = server();
  try {
    assert.equal((await invoke(s, A_NEQ, 'user')).ok, true);
    assert.equal(denied(await invoke(s, A_NEQ, 'banned')), true);
    assert.equal(denied(await invoke(s, A_NEQ, 'norole')), true, 'role field absent ⇒ DENY');
    assert.equal(denied(await invoke(s, A_NEQ)), true, 'anonymous ⇒ DENY');
    assert.equal(denied(await invoke(s, A_NEQ, 'garbage')), true, 'unresolvable credential ⇒ DENY');
    assert.equal(legacyDeniedReason(await invoke(s, A_NEQ)), 'legacy-denied');
    assert.equal(s.getState(S_COUNT), 1, 'only the one authorized invoke mutated state (§59)');
  } finally {
    await s.stop();
  }
});

test('spec15pt3 §12: legacy `NOT(role == "banned")` — same matrix', async () => {
  const s = server();
  try {
    assert.equal((await invoke(s, A_NOTEQ, 'user')).ok, true);
    assert.equal(denied(await invoke(s, A_NOTEQ, 'banned')), true);
    assert.equal(denied(await invoke(s, A_NOTEQ, 'norole')), true);
    assert.equal(denied(await invoke(s, A_NOTEQ)), true);
    assert.equal(s.getState(S_COUNT), 1);
  } finally {
    await s.stop();
  }
});

test('spec15pt3 §17: legacy `literal(true)` still admits an anonymous caller (no overcorrection)', async () => {
  const s = server();
  try {
    assert.equal((await invoke(s, A_TRUE)).ok, true);
    assert.equal(s.getState(S_COUNT), 1);
  } finally {
    await s.stop();
  }
});

test('spec15pt3 §19: legacy positive `role == "admin"` — admin allows, everyone else denies', async () => {
  const s = server();
  try {
    assert.equal((await invoke(s, A_ADMIN, 'admin')).ok, true);
    assert.equal(denied(await invoke(s, A_ADMIN, 'user')), true);
    assert.equal(denied(await invoke(s, A_ADMIN, 'norole')), true);
    assert.equal(denied(await invoke(s, A_ADMIN)), true);
    assert.equal(s.getState(S_COUNT), 1);
  } finally {
    await s.stop();
  }
});

test('spec15pt3 §23/§24/§25: legacy deny-list ∧ policy `literal(true)` — anonymous still DENY (policy cannot mask legacy)', async () => {
  const s = server();
  try {
    assert.equal((await invoke(s, A_NEQ_PLUS_PUBLIC, 'user')).ok, true, 'legacy allow ∧ policy allow ⇒ ALLOW');
    assert.equal(denied(await invoke(s, A_NEQ_PLUS_PUBLIC)), true, 'legacy deny ∧ policy allow ⇒ DENY');
    assert.equal(denied(await invoke(s, A_NEQ_PLUS_PUBLIC, 'norole')), true);
    assert.equal(legacyDeniedReason(await invoke(s, A_NEQ_PLUS_PUBLIC)), 'legacy-denied', 'the legacy side denies independently');
    assert.equal(s.getState(S_COUNT), 1);
  } finally {
    await s.stop();
  }
});

test('spec15pt3 §26: legacy ALLOW ∧ policy DENY ⇒ DENY (pt2 policy semantics unchanged)', async () => {
  const s = server();
  try {
    const r = await invoke(s, A_ADMIN_PLUS_DENY, 'admin');
    assert.equal(denied(r), true);
    assert.equal(legacyDeniedReason(r), 'policy-denied');
    assert.equal(s.getState(S_COUNT), 0);
  } finally {
    await s.stop();
  }
});

test('spec15pt3 §60: idempotency isolation — an anonymous caller reusing an authorized key is denied, no response inheritance', async () => {
  const s = server();
  try {
    const first = await invoke(s, A_NEQ, 'user', 'req-K');
    assert.equal(first.ok, true);
    assert.equal(s.getState(S_COUNT), 1);

    const anon = await invoke(s, A_NEQ, undefined, 'req-K');
    assert.equal(denied(anon), true, 'anonymous is denied on the corrected legacy path');
    assert.notEqual(anon.replayed, true, 'anonymous does not inherit the authorized caller’s response');
    assert.equal(s.getState(S_COUNT), 1, 'no second mutation');
  } finally {
    await s.stop();
  }
});

test('spec15pt3 §61/§62/§63: a workflow started by a principal lacking `role` cannot run the legacy-protected action step', async () => {
  const s = server();
  try {
    const bad = (await s.startWorkflow({ workflowId: String(WF), arguments: {}, credential: 'norole' })) as {
      instanceId?: string;
      error?: { code?: string };
    };
    assert.equal(typeof bad.instanceId, 'string', 'workflow start itself does not evaluate the step authorization');
    const id = bad.instanceId as string;
    for (let i = 0; i < 60; i += 1) {
      const v = await s.getWorkflow(id, 'norole');
      if (v?.status === 'failed' || v?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await s.getWorkflow(id, 'norole'))?.status, 'failed', 'the action step is denied at execution time');
    assert.equal(s.getState(S_COUNT), 0, 'the protected action executed 0 times (§62)');

    // A non-banned principal runs the same workflow to completion.
    const ok = (await s.startWorkflow({ workflowId: String(WF), arguments: {}, credential: 'user' })) as { instanceId: string };
    for (let i = 0; i < 60; i += 1) {
      const v = await s.getWorkflow(ok.instanceId, 'user');
      if (v?.status === 'failed' || v?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await s.getWorkflow(ok.instanceId, 'user'))?.status, 'completed');
    assert.equal(s.getState(S_COUNT), 1, 'the authorized run mutated once');
  } finally {
    await s.stop();
  }
});
