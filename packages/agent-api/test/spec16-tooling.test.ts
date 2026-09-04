import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
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
  EventDef,
  QueryDef,
  StateDef,
  TriggerDef,
  WorkflowDef,
} from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';

/**
 * spec16 — tooling, explainability and AI authoring. One fixture graph exercising
 * inventory, dependency analysis, per-node explanation, capability analysis, NativeOperation
 * discovery, authorization decision explanation, semantic diff and candidate graph edits.
 */

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const S_COUNT = nodeId('state_count');
const A_BUMP = nodeId('action_bump');
const A_NATIVE = nodeId('action_native');
const Q_USERS = nodeId('query_users');
const P_ADMIN = nodeId('policy_admin');
const P_BANNED = nodeId('policy_not_banned');
const WF = nodeId('workflow_thing');
const EV_DONE = nodeId('event_done');
const TR_ON_DONE = nodeId('trigger_on_done');
const ROW = nodeId('scope_row');

function fixture(): ApplicationGraph {
  const g = new ApplicationGraph('spec16-g', 'Spec16 Fixture');
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
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });

  g.addNode<AuthorizationPolicyDef>({
    id: P_ADMIN,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(nodeId('axiom_principal')), F_ROLE), literal('admin')),
  });
  g.addNode<AuthorizationPolicyDef>({
    id: P_BANNED,
    kind: 'authorization-policy',
    allow: binary('neq', field(ref(nodeId('axiom_principal')), F_ROLE), literal('banned')),
  });

  g.addNode<ActionDef>({
    id: A_BUMP,
    kind: 'action',
    authorizationPolicy: P_ADMIN,
    operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) }],
  });
  g.addNode<ActionDef>({
    id: A_NATIVE,
    kind: 'action',
    operations: [{ kind: 'native', implementationId: 'legacy.import' }],
  });

  g.addNode<QueryDef>({
    id: Q_USERS,
    kind: 'query',
    source: E_USER,
    rowScopeId: ROW,
    authorizationPolicy: P_BANNED,
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);

  g.addNode<EventDef>({ id: EV_DONE, kind: 'event', payloadType: primitiveType('string') });
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    startPolicy: P_ADMIN,
    entry: nodeId('s1'),
    steps: [
      { type: 'action', id: nodeId('s1'), action: A_BUMP, arguments: {}, next: nodeId('s2') },
      { type: 'wait-event', id: nodeId('s2'), event: EV_DONE, next: nodeId('done') },
      { type: 'complete', id: nodeId('done') },
    ],
  });
  g.addNode<TriggerDef>({ id: TR_ON_DONE, kind: 'trigger', actionId: A_BUMP, when: { kind: 'event', eventId: EV_DONE } });

  return g;
}

// ------------------------------------------------------------------------------- inventory

test('inventory() enumerates every node with dependency/dependent counts (spec16 §9-11)', () => {
  const agent = new AgentAPI(fixture());
  const inventory = agent.inventory();
  assert.equal(inventory.countsByKind.action, 2);
  assert.equal(inventory.countsByKind['authorization-policy'], 2);
  const bump = inventory.entries.find((e) => e.id === String(A_BUMP));
  assert.ok(bump);
  assert.ok(bump!.dependencyCount > 0);
});

test('inventory() pagination is deterministic keyset paging (spec16 §114-115)', () => {
  const agent = new AgentAPI(fixture());
  const first = agent.inventory({ limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.ok(first.nextCursor);
  const second = agent.inventory({ limit: 2, cursor: first.nextCursor });
  assert.notDeepEqual(first.entries, second.entries);
});

// ---------------------------------------------------------------------------- dependencies

test('getTransitiveDependencies / getTransitiveDependents are cycle-safe and canonically ordered (spec16 §12-13)', () => {
  const agent = new AgentAPI(fixture());
  const deps = agent.getTransitiveDependencies(WF);
  assert.ok(deps.ids.includes(String(A_BUMP)));
  assert.ok(deps.ids.includes(String(EV_DONE)));
  assert.deepEqual([...deps.ids].sort(), deps.ids);

  const dependents = agent.getTransitiveDependents(A_BUMP);
  assert.ok(dependents.ids.includes(String(WF)));
  assert.ok(dependents.ids.includes(String(TR_ON_DONE)));
});

test('explainDependency renders structural provenance, not fabricated prose (spec16 §14)', () => {
  const agent = new AgentAPI(fixture());
  const provenance = agent.explainDependency(WF, A_BUMP);
  assert.ok(provenance);
  assert.ok(provenance!.reasons[0].includes('invokes'));
  assert.equal(agent.explainDependency(A_BUMP, WF), undefined);
});

// -------------------------------------------------------------------------------- explain

test('explainAction reports reads/writes/authorization/invokers (spec16 §17)', () => {
  const agent = new AgentAPI(fixture());
  const explanation = agent.explainAction(A_BUMP);
  assert.ok(explanation);
  assert.deepEqual(explanation!.writes.stateIds, [String(S_COUNT)]);
  assert.equal(explanation!.authorization.kind, 'policy');
  assert.ok(explanation!.invokedBy.triggers.includes(String(TR_ON_DONE)));
  assert.ok(explanation!.invokedBy.workflowSteps.includes(String(WF)));
  assert.equal(explanation!.analysisComplete, true);
});

test('explainAction reports a NativeOperation as an incomplete-analysis boundary (spec16 §29, §102, §173)', () => {
  const agent = new AgentAPI(fixture());
  const explanation = agent.explainAction(A_NATIVE);
  assert.ok(explanation);
  assert.equal(explanation!.analysisComplete, false);
  assert.equal(explanation!.nativeOperations.length, 1);
  assert.ok(explanation!.analysisGaps[0].includes('legacy.import'));
});

test('explainAction returns undefined for a non-action id, never throws', () => {
  const agent = new AgentAPI(fixture());
  assert.equal(agent.explainAction(S_COUNT), undefined);
});

test('explainState reports type, authority, readers and writers (spec16 §21)', () => {
  const agent = new AgentAPI(fixture());
  const explanation = agent.explainState(S_COUNT);
  assert.ok(explanation);
  assert.equal(explanation!.authority, 'server');
  assert.ok(explanation!.writers.includes(String(A_BUMP)));
});

test('explainQuery composes authorization and live capability (spec16 §18)', () => {
  const agent = new AgentAPI(fixture());
  const explanation = agent.explainQuery(Q_USERS);
  assert.ok(explanation);
  assert.equal(explanation!.authorization.kind, 'policy');
  assert.ok(['live-capable', 'live-capable-reset-only', 'not-live-capable'].includes(explanation!.liveCapability));
});

test('explainWorkflow composes step analysis and authorization surface (spec16 §19-20)', () => {
  const agent = new AgentAPI(fixture());
  const explanation = agent.explainWorkflow(WF);
  assert.equal(explanation.startPolicyId, String(P_ADMIN));
  assert.ok(explanation.steps.some((s) => s.type === 'wait-event'));
  assert.ok(explanation.privilegeReviewActions.includes(String(A_BUMP)));
});

test('explainGraph is structural — counts and roots, never invented business prose (spec16 §161)', () => {
  const agent = new AgentAPI(fixture());
  const summary = agent.explainGraph();
  assert.equal(summary.nodeCountsByKind.action, 2);
  assert.equal(summary.opaqueBoundaries, 1);
  assert.ok(summary.executableRoots.workflows.includes(String(WF)));
});

// ----------------------------------------------------------------------------- capabilities

test('analyzeCapabilities derives requirements with provenance (spec16 §30-31)', () => {
  const agent = new AgentAPI(fixture());
  const analysis = agent.analyzeCapabilities();
  const workflowStore = analysis.requirements.find((r) => r.capability === 'workflow-store')!;
  assert.equal(workflowStore.required, true);
  assert.ok(workflowStore.reasons[0].includes(String(WF)));
  const eventJournal = analysis.requirements.find((r) => r.capability === 'event-journal')!;
  assert.equal(eventJournal.required, true);
  const blobStorage = analysis.requirements.find((r) => r.capability === 'blob-storage')!;
  assert.equal(blobStorage.required, false);
  assert.deepEqual(blobStorage.reasons, []);
});

// ------------------------------------------------------------------------ native operations

test('listNativeOperations / summarizeNativeOperations make every opaque boundary discoverable (spec16 §46-49)', () => {
  const agent = new AgentAPI(fixture());
  const occurrences = agent.listNativeOperations();
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].opaque, true);
  const summary = agent.summarizeNativeOperations();
  assert.equal(summary.count, 1);
  assert.equal(summary.opaqueCount, 1);
});

// ------------------------------------------------------------------- authorization decision

test('explainAuthorizationDecision agrees with the runtime evaluator: admin allowed, other denied', () => {
  const agent = new AgentAPI(fixture());
  const allowed = agent.explainAuthorizationDecision({ actionId: A_BUMP, principal: { [F_ROLE]: 'admin' } });
  assert.equal(allowed?.decision, 'ALLOW');
  const denied = agent.explainAuthorizationDecision({ actionId: A_BUMP, principal: { [F_ROLE]: 'user' } });
  assert.equal(denied?.decision, 'DENY');
  assert.equal(denied?.reason, 'policy-denied');
});

test('explainAuthorizationDecision: an absent security field cannot manufacture ALLOW (spec16 §25, §170)', () => {
  const agent = new AgentAPI(fixture());
  // P_BANNED is `PRINCIPAL.role != "banned"` — an anonymous caller supplies no role.
  const anonymous = agent.explainAuthorizationDecision({ queryId: Q_USERS, principal: null });
  assert.equal(anonymous?.decision, 'DENY');
});

test('explainAuthorizationDecision performs no mutation and no effect (spec16 §136)', () => {
  const graph = fixture();
  const agent = new AgentAPI(graph);
  const before = graph.toJSON();
  agent.explainAuthorizationDecision({ actionId: A_BUMP, principal: { [F_ROLE]: 'admin' } });
  assert.deepEqual(graph.toJSON(), before);
});

test('explainAuthorizationDecision returns undefined for an unknown action/query id', () => {
  const agent = new AgentAPI(fixture());
  assert.equal(agent.explainAuthorizationDecision({ actionId: nodeId('nope') }), undefined);
  assert.equal(agent.explainAuthorizationDecision({}), undefined);
});

// -------------------------------------------------------------------------- semantic diff

test('AgentAPI.semanticDiff and requiredServerContract are available and agree with core (spec16 §32-38)', () => {
  const agent = new AgentAPI(fixture());
  assert.equal(agent.requiredServerContract(), 'axiom.server.v9');
  const smaller = new ApplicationGraph('smaller', 'Smaller');
  smaller.addNode<StateDef>({ id: S_COUNT, kind: 'state', valueType: primitiveType('number') });
  const diff = agent.semanticDiff(smaller);
  assert.equal(diff.isNoOp, false);
  assert.ok(diff.compatibility.semanticFingerprintChanged);
});

// ------------------------------------------------------------------------------ graph edit

test('proposeEdit validates a candidate without touching the live graph (spec16 §81-82)', () => {
  const graph = fixture();
  const agent = new AgentAPI(graph);
  const before = graph.toJSON();
  const newActionId = nodeId('action_new');
  const result = agent.proposeEdit({
    changes: [
      {
        kind: 'add-node',
        nodeId: newActionId,
        node: { id: newActionId, kind: 'action', operations: [] } as ActionDef,
      },
    ],
  });
  assert.equal(result.applied, true);
  assert.equal(result.validation?.valid, true);
  assert.ok(result.diff!.entries.some((e) => e.nodeId === String(newActionId) && e.changeKind === 'added'));
  assert.deepEqual(graph.toJSON(), before);
});

test('proposeEdit rejects a candidate with an unresolved reference, with a structured diagnostic (spec16 §151, §174)', () => {
  const agent = new AgentAPI(fixture());
  const result = agent.proposeEdit({ changes: [{ kind: 'remove-node', nodeId: S_COUNT, node: {} as StateDef }] });
  assert.equal(result.applied, false);
  assert.equal(result.validation?.valid, false);
  assert.ok(result.validation!.errors.length > 0);
});

test('proposeEdit reports a stale precondition as an explicit conflict, never a silent overwrite (spec16 §85-86, §176)', () => {
  const agent = new AgentAPI(fixture());
  const result = agent.proposeEdit({
    changes: [],
    preconditions: [{ nodeId: A_BUMP, expect: { field: 'authorizationPolicy', equals: String(P_BANNED) } }],
  });
  assert.equal(result.applied, false);
  assert.ok(result.conflict);
  assert.equal(result.conflict!.preconditionIndex, 0);
});

test('proposeEdit accepts an atomic edit set whose intermediate state is invalid but final candidate is valid (spec16 §84, §175)', () => {
  const agent = new AgentAPI(fixture());
  const policyId = nodeId('policy_new');
  const actionId = nodeId('action_needs_policy');
  const result = agent.proposeEdit({
    changes: [
      { kind: 'add-node', nodeId: actionId, node: { id: actionId, kind: 'action', authorizationPolicy: policyId, operations: [] } as ActionDef },
      {
        kind: 'add-node',
        nodeId: policyId,
        node: { id: policyId, kind: 'authorization-policy', allow: literal(true) } as AuthorizationPolicyDef,
      },
    ],
  });
  assert.equal(result.applied, true);
});

test('acceptEdit commits a validated candidate and refuses an unvalidated one', () => {
  const graph = fixture();
  const agent = new AgentAPI(graph);
  const newActionId = nodeId('action_new2');
  const result = agent.proposeEdit({
    changes: [{ kind: 'add-node', nodeId: newActionId, node: { id: newActionId, kind: 'action', operations: [] } as ActionDef }],
  });
  agent.acceptEdit(result, { reason: 'add a new action' });
  assert.ok(graph.getNode(newActionId));

  const invalid = agent.proposeEdit({ changes: [{ kind: 'remove-node', nodeId: S_COUNT, node: {} as StateDef }] });
  assert.throws(() => agent.acceptEdit(invalid));
});
