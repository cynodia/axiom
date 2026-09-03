import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  authorizationPolicyDependencies,
  binary,
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
  QueryDef,
  ReadPolicyDef,
  StateDef,
  WorkflowDef,
} from '@cynodia/axiom-core';
import { AgentAPI, analyzeAuthorization } from '@cynodia/axiom-agent-api';

/**
 * spec15 Phase G — static authorization analysis. Answers "what protects this surface",
 * "what does this policy depend on", "which surfaces have no boundary", "can a workflow
 * reach an action needing permissions its start principal may not hold" — without a running
 * authority and without claiming authorization it cannot prove.
 */

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const E_DOC = nodeId('entity_doc');
const F_DID = fieldId('field_doc_id');
const F_OWNER = fieldId('field_doc_owner');
const S_COUNT = nodeId('state_count');
const ROW = nodeId('scope_row');
const PROW = nodeId('scope_policy_row');

const POL_OWNER = nodeId('policy_owner');
const POL_ADMIN = nodeId('policy_admin');
const RP_OWNER = nodeId('readpolicy_owner');

const A_OPEN = nodeId('action_open'); // public
const A_EDIT = nodeId('action_edit'); // authorizationPolicy
const A_LEGACY = nodeId('action_legacy'); // legacy authorization only
const Q_GATED = nodeId('query_gated'); // authorizationPolicy + entity read-policy
const Q_PUBLIC = nodeId('query_public'); // nothing
const WF = nodeId('wf_thing');
const P_TAG = nodeId('input_tag');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-g', 'Authz Analysis');
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
  g.addNode<EntityDef>({
    id: E_DOC,
    kind: 'entity',
    identityFieldId: F_DID,
    fields: [
      { id: F_DID, valueType: primitiveType('string'), required: true },
      { id: F_OWNER, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });

  g.addNode<AuthorizationPolicyDef>({
    id: POL_OWNER,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(nodeId('axiom_resource')), F_OWNER), field(ref(nodeId('axiom_principal')), F_UID)),
  });
  g.addNode<AuthorizationPolicyDef>({
    id: POL_ADMIN,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(nodeId('axiom_principal')), F_ROLE), literal('admin')),
  });
  g.addNode<ReadPolicyDef>({
    id: RP_OWNER,
    kind: 'read-policy',
    entityId: E_DOC,
    rowScopeId: PROW,
    predicate: binary('eq', field(ref(PROW), F_OWNER), field(ref(nodeId('axiom_principal')), F_UID)),
  });

  const bump = (): ActionDef['operations'] => [
    { kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) },
  ];
  g.addNode<ActionDef>({ id: A_OPEN, kind: 'action', operations: bump() });
  g.addNode<ActionDef>({ id: A_EDIT, kind: 'action', authorizationPolicy: POL_ADMIN, operations: bump() });
  g.addNode<ActionDef>({
    id: A_LEGACY,
    kind: 'action',
    authorization: binary('eq', field(ref(nodeId('axiom_principal')), F_ROLE), literal('editor')),
    operations: bump(),
  });

  g.addNode<QueryDef>({
    id: Q_GATED,
    kind: 'query',
    source: E_DOC,
    rowScopeId: ROW,
    authorizationPolicy: POL_OWNER,
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);
  g.addNode<QueryDef>({
    id: Q_PUBLIC,
    kind: 'query',
    source: E_USER, // no read-policy on E_USER
    rowScopeId: ROW,
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);

  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    startPolicy: POL_ADMIN,
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('s1'),
    steps: [
      { type: 'action', id: nodeId('s1'), action: A_EDIT, arguments: {}, next: nodeId('s2') },
      { type: 'action', id: nodeId('s2'), action: A_OPEN, arguments: {}, next: nodeId('done') },
      { type: 'complete', id: nodeId('done') },
    ],
  });
  return g;
}

const G = graph();

test('spec15 §35: policy dependency analysis reports scope reads and constants', () => {
  const owner = authorizationPolicyDependencies(G.getNode(POL_OWNER));
  assert.deepEqual(owner.principalFields, ['field_user_id']);
  assert.deepEqual(owner.resourceFields, ['field_doc_owner']);
  assert.equal(owner.readsOperation, false);
  assert.equal(owner.constant, null);

  assert.equal(authorizationPolicyDependencies({ allow: literal(true) }).constant, 'always-allow');
  assert.equal(authorizationPolicyDependencies({ allow: literal(false) }).constant, 'always-deny');
  // total over junk
  assert.doesNotThrow(() => authorizationPolicyDependencies(null));
  assert.doesNotThrow(() => authorizationPolicyDependencies({ allow: 42 }));
});

test('spec15 §42/§43: analyzeAuthorization classifies every surface and its protection', () => {
  const a = analyzeAuthorization(G);
  assert.equal(a.usesAuthorizationVocabulary, true);

  const byNode = new Map(a.operations.map((o) => [`${o.operation}:${o.nodeId}`, o]));
  assert.equal(byNode.get(`action.invoke:${A_OPEN}`)?.protection.kind, 'public');
  assert.equal(byNode.get(`action.invoke:${A_EDIT}`)?.protection.kind, 'policy');
  assert.equal(byNode.get(`action.invoke:${A_LEGACY}`)?.protection.kind, 'legacy-expression');
  // Q_GATED carries both an authorizationPolicy and (via its E_DOC entity) a ReadPolicyDef.
  assert.equal(byNode.get(`query.read:${Q_GATED}`)?.protection.kind, 'policy+read-policy');
  assert.equal(byNode.get(`query.read:${Q_PUBLIC}`)?.protection.kind, 'public');
  assert.equal(byNode.get(`workflow.start:${WF}`)?.protection.kind, 'policy');
  assert.equal(byNode.get(`workflow.cancel:${WF}`)?.protection.kind, 'owner-fingerprint');
});

test('spec15 §43: the audit flags every surface with no explicit authorization boundary', () => {
  const a = analyzeAuthorization(G);
  const keys = a.unprotected.map((u) => `${u.operation}:${u.nodeId}`).sort();
  assert.deepEqual(keys, [`action.invoke:${A_OPEN}`, `query.read:${Q_PUBLIC}`].sort());
  // A workflow instance op is *not* unresolved — owner-fingerprint is a defined default.
  assert.ok(!a.unprotected.some((u) => u.operation.startsWith('workflow.cancel')));
});

test('spec15 §44/§83: policy summaries are secret-free structural renderings', () => {
  const a = analyzeAuthorization(G);
  const owner = a.policies.find((p) => p.policyId === String(POL_OWNER));
  assert.equal(owner?.summary, 'requires RESOURCE.field_doc_owner == PRINCIPAL.field_user_id');
  const admin = a.policies.find((p) => p.policyId === String(POL_ADMIN));
  assert.equal(admin?.summary, 'requires PRINCIPAL.field_user_role == "admin"');
});

test('spec15 §101: a workflow lists action steps whose policy the start principal is not proven to satisfy', () => {
  const a = analyzeAuthorization(G);
  const wf = a.workflows.find((w) => w.workflowId === String(WF));
  assert.equal(wf?.start, 'policy');
  assert.deepEqual(wf?.actionDependencies.map((d) => d.actionId).sort(), [String(A_EDIT), String(A_OPEN)].sort());
  // A_EDIT carries a policy; A_OPEN does not.
  assert.deepEqual(wf?.privilegeReviewActions, [String(A_EDIT)]);
});

test('spec15: analyzeAuthorization is available on AgentAPI and total over a graph with no vocabulary', () => {
  const plain = new ApplicationGraph('plain', 'Plain');
  plain.addNode<StateDef>({ id: S_COUNT, kind: 'state', valueType: primitiveType('number'), initialValue: 0 });
  const a = new AgentAPI(plain).analyzeAuthorization();
  assert.equal(a.usesAuthorizationVocabulary, false);
  assert.deepEqual(a.policies, []);
  assert.deepEqual(a.unprotected, []);
});
