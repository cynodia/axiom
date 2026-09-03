import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  AUTHORIZATION_OPERATIONS,
  AUTHORIZATION_SCOPE_IDS,
  OPERATION,
  PRINCIPAL,
  RESOURCE,
  authorizationPolicyExpressions,
  authorizationPolicyProblems,
  binary,
  call,
  decideAuthorization,
  evaluateAuthorizationPolicyAllow,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  unary,
  usesAuthorizationVocabulary,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  AuthorizationPolicyDef,
  EntityDef,
  QueryDef,
  StateDef,
  WorkflowDef,
} from '@cynodia/axiom-core';

/**
 * spec15 Phase B — the canonical authorization policy vocabulary: validation, closed scope,
 * determinism, reference resolution, and totality over malformed input. No enforcement yet
 * (Phase C+).
 */

const E_DOC = nodeId('entity_doc');
const F_OWNER = fieldId('field_doc_owner');
const F_TENANT = fieldId('field_doc_tenant');
const P_ID = fieldId('field_principal_id');
const P_TENANT = fieldId('field_principal_tenant');
const E_PRINCIPAL = nodeId('entity_principal');
const S_COUNT = nodeId('state_count');
const A_DO = nodeId('action_do');
const POL_OWNER = nodeId('policy_owner');

function base(): ApplicationGraph {
  const g = new ApplicationGraph('authz', 'Authz');
  g.addNode<EntityDef>({
    id: E_PRINCIPAL,
    kind: 'entity',
    fields: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_TENANT, valueType: primitiveType('string'), required: true },
    ],
  });
  g.setPrincipalEntity(E_PRINCIPAL);
  g.addNode<EntityDef>({
    id: E_DOC,
    kind: 'entity',
    fields: [
      { id: F_OWNER, valueType: primitiveType('string'), required: true },
      { id: F_TENANT, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  return g;
}

/** `RESOURCE.owner == PRINCIPAL.id` — the canonical owner rule. */
function ownerPolicy(): AuthorizationPolicyDef {
  return {
    id: POL_OWNER,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(RESOURCE), F_OWNER), field(ref(PRINCIPAL), P_ID)),
  };
}

test('spec15: operation identity and policy scope are closed enumerations', () => {
  assert.ok(AUTHORIZATION_OPERATIONS.includes('action.invoke'));
  assert.ok(AUTHORIZATION_OPERATIONS.includes('workflow.cancel'));
  assert.ok(AUTHORIZATION_OPERATIONS.includes('live.resume'));
  // The closed policy scope is the same reserved ids `ActionDef.authorization` already uses.
  assert.deepEqual([...AUTHORIZATION_SCOPE_IDS], [PRINCIPAL, RESOURCE, OPERATION]);
});

test('spec15 §8: decideAuthorization is fail-closed and conjunctive', () => {
  assert.deepEqual(decideAuthorization({}), { decision: 'ALLOW', reason: 'no-policy' });
  assert.deepEqual(decideAuthorization({ policy: { ok: true, value: true } }), {
    decision: 'ALLOW',
    reason: 'allowed',
  });
  // Not exactly `true` ⇒ DENY.
  assert.equal(decideAuthorization({ policy: { ok: true, value: 1 } }).decision, 'DENY');
  assert.equal(decideAuthorization({ policy: { ok: true, value: 'yes' } }).decision, 'DENY');
  // An evaluation error never allows.
  assert.deepEqual(decideAuthorization({ policy: { ok: false } }), {
    decision: 'DENY',
    reason: 'policy-error',
  });
  // Conjunction: policy allows but the legacy expression denies.
  assert.equal(
    decideAuthorization({ policy: { ok: true, value: true }, legacy: { ok: true, value: false } })
      .decision,
    'DENY',
  );
  // Legacy truthiness rule preserved: a non-empty array allows.
  assert.equal(decideAuthorization({ legacy: { ok: true, value: [1] } }).decision, 'ALLOW');
  assert.equal(decideAuthorization({ legacy: { ok: true, value: [] } }).decision, 'DENY');
});

test('spec15: a valid owner policy referenced by an action validates', () => {
  const g = base();
  g.addNode<AuthorizationPolicyDef>(ownerPolicy());
  g.addNode<ActionDef>({
    id: A_DO,
    kind: 'action',
    authorizationPolicy: POL_OWNER,
    operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) }],
  });
  const result = validateGraph(g);
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  assert.equal(usesAuthorizationVocabulary({ authorizationPolicies: [ownerPolicy()] }), true);
});

test('spec15: an out-of-scope ref in a policy is AUTHORIZATION_INVALID_SCOPE', () => {
  const g = base();
  g.addNode<AuthorizationPolicyDef>({
    id: POL_OWNER,
    kind: 'authorization-policy',
    allow: binary('eq', ref(S_COUNT), literal(1)), // StateDef ref — not in scope
  });
  const codes = validateGraph(g).errors.map((e) => e.code);
  assert.ok(codes.includes('AUTHORIZATION_INVALID_SCOPE'), codes.join(','));
});

test('spec15: a nondeterministic policy expression is AUTHORIZATION_NONDETERMINISTIC', () => {
  const g = base();
  g.addNode<AuthorizationPolicyDef>({
    id: POL_OWNER,
    kind: 'authorization-policy',
    allow: { kind: 'call', function: 'uuid', arguments: [] } as never,
  });
  const codes = validateGraph(g).errors.map((e) => e.code);
  assert.ok(codes.includes('AUTHORIZATION_NONDETERMINISTIC'), codes.join(','));
});

test('spec15: a policy with no boolean allow is AUTHORIZATION_INVALID_POLICY', () => {
  const g = base();
  g.addNode<AuthorizationPolicyDef>({ id: POL_OWNER, kind: 'authorization-policy' } as never);
  const codes = validateGraph(g).errors.map((e) => e.code);
  assert.ok(codes.includes('AUTHORIZATION_INVALID_POLICY'), codes.join(','));
});

test('spec15: an authorizationPolicy / startPolicy id pointing at a non-policy is AUTHORIZATION_UNKNOWN_POLICY', () => {
  const g = base();
  g.addNode<ActionDef>({ id: A_DO, kind: 'action', authorizationPolicy: E_DOC, operations: [] });
  g.addNode<WorkflowDef>({
    id: nodeId('wf'),
    kind: 'workflow',
    startPolicy: nodeId('ghost_policy'),
    entry: nodeId('done'),
    steps: [{ type: 'complete', id: nodeId('done') }],
  });
  g.addNode<QueryDef>({
    id: nodeId('q'),
    kind: 'query',
    source: E_DOC,
    rowScopeId: nodeId('row'),
    authorizationPolicy: nodeId('nope'),
    pagination: { strategy: 'offset', maxPageSize: 10 },
  } as QueryDef);
  const codes = validateGraph(g).errors.map((e) => e.code);
  assert.equal(codes.filter((c) => c === 'AUTHORIZATION_UNKNOWN_POLICY').length, 3, codes.join(','));
});

test('spec15 §37: authorizationPolicyProblems is total over any malformed value', () => {
  const shapes: unknown[] = [null, undefined, 'x', 42, true, [], {}, { id: 'p' }, { id: 'p', allow: 'nope' }];
  for (const bad of shapes) {
    let threw = false;
    let problems: ReturnType<typeof authorizationPolicyProblems> = [];
    try {
      problems = authorizationPolicyProblems(bad);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, `authorizationPolicyProblems(${JSON.stringify(bad)}) must not throw`);
    assert.ok(problems.length > 0, `${JSON.stringify(bad)} → at least one structured problem`);
    assert.doesNotThrow(() => authorizationPolicyExpressions(bad));
  }
  assert.deepEqual(authorizationPolicyProblems(ownerPolicy()), []);
});

// ------------------------------------------------- spec15pt2 F1 — absent-value safety

/** Shorthand: evaluate an `allow` expression against a scope and return ALLOW/DENY. */
function decide(allow: unknown, scope: { principal?: Record<string, unknown> | null; resource?: Record<string, unknown> | null; operation?: string }): 'ALLOW' | 'DENY' {
  const part = evaluateAuthorizationPolicyAllow(allow, {
    principal: scope.principal ?? null,
    resource: scope.resource ?? null,
    operation: scope.operation ?? 'action.invoke',
  });
  return decideAuthorization({ policy: part }).decision;
}

const P_ROLE = fieldId('field_p_role');
const P_ID2 = fieldId('field_p_id');
const P_TEN = fieldId('field_p_tenant');
const R_OWNER = fieldId('field_r_owner');
const R_TEN = fieldId('field_r_tenant');
const pRole = () => field(ref(PRINCIPAL), P_ROLE);

test('spec15pt2 C1: RESOURCE.ownerId == PRINCIPAL.id with both absent ⇒ DENY', () => {
  const allow = binary('eq', field(ref(RESOURCE), R_OWNER), field(ref(PRINCIPAL), P_ID2));
  assert.equal(decide(allow, { principal: {}, resource: { id: 'x', kind: 'query' } }), 'DENY');
  assert.equal(decide(allow, { principal: null, resource: null }), 'DENY');
  // concrete match still allows
  assert.equal(decide(allow, { principal: { [P_ID2]: 'u1' }, resource: { [R_OWNER]: 'u1' } }), 'ALLOW');
  // concrete non-match denies
  assert.equal(decide(allow, { principal: { [P_ID2]: 'u1' }, resource: { [R_OWNER]: 'u2' } }), 'DENY');
});

test('spec15pt2 C2/§10: PRINCIPAL.role != "banned" with role absent ⇒ DENY', () => {
  const allow = binary('neq', pRole(), literal('banned'));
  assert.equal(decide(allow, { principal: { [P_ROLE]: 'user' } }), 'ALLOW');
  assert.equal(decide(allow, { principal: { [P_ROLE]: 'banned' } }), 'DENY');
  assert.equal(decide(allow, { principal: {} }), 'DENY', 'role absent');
  assert.equal(decide(allow, { principal: null }), 'DENY', 'anonymous');
});

test('spec15pt2 C3/§9: NOT(PRINCIPAL.role == "banned") with role absent ⇒ DENY', () => {
  const allow = unary('not', binary('eq', pRole(), literal('banned')));
  assert.equal(decide(allow, { principal: { [P_ROLE]: 'user' } }), 'ALLOW');
  assert.equal(decide(allow, { principal: { [P_ROLE]: 'banned' } }), 'DENY');
  assert.equal(decide(allow, { principal: {} }), 'DENY');
  assert.equal(decide(allow, { principal: null }), 'DENY');
});

test('spec15pt2 C5/§13-§14: constant and operation-only policies are unaffected by absence', () => {
  assert.equal(decide(literal(true), { principal: null }), 'ALLOW', 'explicit public allows anonymous');
  assert.equal(decide(literal(false), { principal: { [P_ROLE]: 'admin' } }), 'DENY');
  const opOnly = binary('eq', ref(OPERATION), literal('workflow.inspect'));
  assert.equal(decide(opOnly, { principal: null, operation: 'workflow.inspect' }), 'ALLOW', 'anonymous is not a blanket deny');
  assert.equal(decide(opOnly, { principal: null, operation: 'action.invoke' }), 'DENY');
});

test('spec15pt2 §11: absence composes through OR and AND', () => {
  const A = binary('eq', field(ref(RESOURCE), R_OWNER), field(ref(PRINCIPAL), P_ID2));
  const B = binary('eq', field(ref(RESOURCE), R_TEN), field(ref(PRINCIPAL), P_TEN));
  const or = binary('or', A, B);
  assert.equal(decide(or, { principal: {}, resource: {} }), 'DENY', 'both branches absent-dependent');
  // one branch concretely true ⇒ ALLOW even though the other is absent-dependent
  assert.equal(decide(or, { principal: { [P_TEN]: 't1' }, resource: { [R_TEN]: 't1' } }), 'ALLOW');
  const and = binary('and', A, B);
  assert.equal(decide(and, { principal: { [P_ID2]: 'u1', [P_TEN]: 't1' }, resource: { [R_OWNER]: 'u1' } }), 'DENY', 'true AND absent ⇒ DENY');
  assert.equal(decide(and, { principal: { [P_ID2]: 'x' }, resource: { [R_OWNER]: 'y' } }), 'DENY', 'false AND absent ⇒ DENY');
});

test('spec15pt2 §57: a builtin call over an absent security field is non-satisfied', () => {
  const allow = call('one-of', pRole(), literal('admin'), literal('editor'));
  assert.equal(decide(allow, { principal: { [P_ROLE]: 'admin' } }), 'ALLOW');
  assert.equal(decide(allow, { principal: {} }), 'DENY');
});

test('spec15pt2 §63: a literal undefined is concrete, not security-absence', () => {
  // eq(literal(undefined), literal(undefined)) is a concrete comparison (true), so a genuinely
  // constant policy is unaffected — absence tracking is about *field provenance*, not undefined.
  assert.equal(decide(binary("eq", literal(undefined as never), literal(undefined as never)), {}), 'ALLOW');
});

test('spec15pt2 §64/§65: a missing scope object and a missing nested field both deny', () => {
  const allow = binary('eq', pRole(), literal('admin'));
  assert.equal(decide(allow, { principal: undefined }), 'DENY', 'no principal object');
  assert.equal(decide(allow, { principal: { [P_ROLE]: undefined } }), 'DENY', 'field present but undefined');
});

test('spec15pt2 §66: evaluateAuthorizationPolicyAllow is total and fails closed on a malformed tree', () => {
  for (const bad of [null, 42, { kind: 'nonsense' }, { kind: 'binary' }, { kind: 'field' }]) {
    const part = evaluateAuthorizationPolicyAllow(bad, { principal: {}, resource: {}, operation: 'action.invoke' });
    assert.equal(decideAuthorization({ policy: part }).decision, 'DENY', `${JSON.stringify(bad)} ⇒ DENY`);
  }
});

test('spec15pt2 F2/§79: validateGraph rejects a malformed AuthorizationPolicyDef.allow', () => {
  const corpus: unknown[] = [
    { a: 1 },
    { kind: 'literal' },
    { kind: 'nonsense' },
    { kind: 'binary', operator: 'eq', left: { kind: 'literal', value: 1 } }, // missing right
    { kind: 'field', source: { kind: 'ref' } }, // ref has no targetId, field has no fieldId
    { kind: 'call', arguments: [{ kind: 'bogus' }] },
  ];
  for (const allow of corpus) {
    const g = base();
    g.addNode({ id: nodeId('pol_bad'), kind: 'authorization-policy', allow } as never);
    const codes = validateGraph(g).errors.map((e) => e.code);
    assert.ok(codes.includes('AUTHORIZATION_INVALID_POLICY'), `${JSON.stringify(allow)} → codes ${codes.join(',')}`);
  }
});
