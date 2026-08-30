import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  call,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
} from '@cynodia/axiom-core';
import type { EntityDef, QueryDef, ReadPolicyDef, RelationshipDef, StateDef } from '@cynodia/axiom-core';
import { AgentAPI, analyzeLiveQuery } from '@cynodia/axiom-agent-api';

/**
 * spec13 §38, §148, §149, §189 Q37/Q38 — static live-query analysis over the graph.
 */

const E_ORDER = nodeId('entity_order');
const E_ACCOUNT = nodeId('entity_account');
const F_ID = fieldId('field_order_id');
const F_ACCOUNT = fieldId('field_order_account');
const F_STATUS = fieldId('field_order_status');
const F_TOTAL = fieldId('field_order_total');
const F_ACC_ID = fieldId('field_account_id');

const S_LIMIT = nodeId('state_min_total');
const REL_ACC = nodeId('rel_order_account');
const POLICY = nodeId('policy_order');
const Q_LIVE = nodeId('query_open_orders');
const Q_AGG = nodeId('query_open_total');
const Q_NOW = nodeId('query_recent');
const Q_STATE = nodeId('query_state_ref');
const P_MIN = nodeId('param_min_total');
const ROW = nodeId('scope_row');
const PROW = nodeId('scope_policy');
const ACC = nodeId('scope_acc');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('orders', 'Orders');
  g.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_ACCOUNT, valueType: primitiveType('string'), required: true },
      { id: F_STATUS, valueType: primitiveType('string'), required: true },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: E_ACCOUNT,
    kind: 'entity',
    identityFieldId: F_ACC_ID,
    fields: [
      { id: F_ACC_ID, valueType: primitiveType('string'), required: true },
      
    ],
  });
  g.addNode<StateDef>({ id: S_LIMIT, kind: 'state', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<RelationshipDef>({
    id: REL_ACC,
    kind: 'relationship',
    cardinality: 'to-one',
    from: { entityId: E_ORDER, fieldId: F_ACCOUNT },
    to: { entityId: E_ACCOUNT, fieldId: F_ACC_ID },
  });
  g.addNode<ReadPolicyDef>({
    id: POLICY,
    kind: 'read-policy',
    entityId: E_ORDER,
    rowScopeId: PROW,
    predicate: binary('eq', field(ref(PROW), F_STATUS), field(ref(PROW), F_STATUS)),
  });
  // live-capable: filtered by status, ordered by total, threshold as a query parameter
  // (the correct way to bind a runtime-varying value — a StateDef ref would not execute).
  g.addNode<QueryDef>({
    id: Q_LIVE,
    kind: 'query',
    source: E_ORDER,
    rowScopeId: ROW,
    parameters: [{ id: P_MIN, valueType: primitiveType('number'), required: false }],
    filter: binary(
      'and',
      binary('eq', field(ref(ROW), F_STATUS), literal('open')),
      binary('gte', field(ref(ROW), F_TOTAL), ref(P_MIN)),
    ),
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc' }],
    relationships: [{ relationshipId: REL_ACC, bindAs: ACC }],
    readPolicyId: POLICY,
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);
  // F2: a query clause that references a StateDef — not validly executable.
  g.addNode<QueryDef>({
    id: Q_STATE,
    kind: 'query',
    source: E_ORDER,
    rowScopeId: ROW,
    filter: binary('gte', field(ref(ROW), F_TOTAL), ref(S_LIMIT)),
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);
  // reset-only: aggregate.
  g.addNode<QueryDef>({
    id: Q_AGG,
    kind: 'query',
    source: E_ORDER,
    rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    aggregate: [{ function: 'sum', key: field(ref(ROW), F_TOTAL), as: fieldId('field_total') }],
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);
  // not-live-capable: reads `now`.
  g.addNode<QueryDef>({
    id: Q_NOW,
    kind: 'query',
    source: E_ORDER,
    rowScopeId: ROW,
    filter: binary('gte', field(ref(ROW), F_TOTAL), call('now')),
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);
  return g;
}

test('a filtered, ordered query is live-capable with an identity field and a dependency set', () => {
  const analysis = analyzeLiveQuery(graph(), String(Q_LIVE));
  assert.equal(analysis.capability.capability, 'live-capable');
  assert.equal(analysis.ordered, true);
  assert.equal(analysis.aggregate, false);
  assert.equal(analysis.identityFieldId, String(F_ID));
  // source entity + the relationship target + the policy entity.
  assert.ok(analysis.dependencies.entityIds.includes(String(E_ORDER)));
  assert.ok(analysis.dependencies.entityIds.includes(String(E_ACCOUNT)));
  assert.deepEqual(analysis.dependencies.stateIds, [], 'a QueryDef has no valid StateDef dependency');
  assert.deepEqual(analysis.dependencies.unsupportedStateRefs, []);
  assert.equal(analysis.dependencies.broad, false);
  assert.equal(analysis.dependencies.readPolicyId, String(POLICY));
  assert.ok(analysis.cursorBinding.includes('principalFingerprint'));
  assert.equal(analysis.delivery.guarantee, 'at-least-once-logical');
  assert.equal(analysis.reason, undefined);
});

test('a query that references a StateDef is not-live-capable and reports the unsupported ref (spec13.1 F2)', () => {
  const analysis = analyzeLiveQuery(graph(), String(Q_STATE));
  assert.equal(analysis.capability.capability, 'not-live-capable');
  assert.match(analysis.reason ?? '', /StateDef/);
  assert.deepEqual(analysis.dependencies.unsupportedStateRefs, [String(S_LIMIT)]);
  assert.deepEqual(analysis.dependencies.stateIds, [], 'never advertised as a real dependency');
  assert.equal(analysis.identityFieldId, null);
});

test('an aggregate query is live-capable-reset-only with no identity field', () => {
  const analysis = analyzeLiveQuery(graph(), String(Q_AGG));
  assert.equal(analysis.capability.capability, 'live-capable-reset-only');
  assert.equal(analysis.aggregate, true);
  assert.equal(analysis.identityFieldId, null);
  assert.match(analysis.reason ?? '', /aggregate/);
});

test('a query that reads `now` is not-live-capable, explicitly', () => {
  const analysis = analyzeLiveQuery(graph(), String(Q_NOW));
  assert.equal(analysis.capability.capability, 'not-live-capable');
  assert.match(analysis.reason ?? '', /nondeterministic/);
});

test('AgentAPI.analyzeLiveQuery is the class entry point and rejects a non-query id', () => {
  const api = new AgentAPI(graph());
  assert.equal(api.analyzeLiveQuery(String(Q_LIVE)).capability.capability, 'live-capable');
  assert.throws(() => api.analyzeLiveQuery(String(E_ORDER)), /no query node/);
});
