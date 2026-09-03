import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  AUTHORIZATION_OPERATIONS,
  AUTHORIZATION_SCOPE_IDS,
  authorizationPolicyExpressions,
  authorizationPolicyProblems,
  binary,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
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
    allow: binary('eq', field(ref('RESOURCE' as never), F_OWNER), field(ref('PRINCIPAL' as never), P_ID)),
  };
}

test('spec15: operation identity and policy scope are closed enumerations', () => {
  assert.ok(AUTHORIZATION_OPERATIONS.includes('action.invoke'));
  assert.ok(AUTHORIZATION_OPERATIONS.includes('workflow.cancel'));
  assert.ok(AUTHORIZATION_OPERATIONS.includes('live.resume'));
  assert.deepEqual([...AUTHORIZATION_SCOPE_IDS], ['PRINCIPAL', 'RESOURCE', 'OPERATION']);
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
