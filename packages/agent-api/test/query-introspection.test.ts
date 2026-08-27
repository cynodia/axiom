import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  enumType,
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
  EntityDef,
  QueryDef,
  ReadPolicyDef,
  RelationshipDef,
  StateDef,
} from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';

const ENTITY_ORDER = nodeId('entity_order');
const ENTITY_ACCOUNT = nodeId('entity_account');
const ENTITY_SUMMARY = nodeId('entity_order_summary');

const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_ACCOUNT_ID = fieldId('field_order_account_id');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ACC_ID = fieldId('field_account_id');
const F_ACC_NAME = fieldId('field_account_name');
const F_SUM_ID = fieldId('field_summary_id');
const F_SUM_ACCOUNT = fieldId('field_summary_account');

const STATE_ORDERS = nodeId('state_orders');
const STATE_ACCOUNTS = nodeId('state_accounts');
const REL_ORDER_ACCOUNT = nodeId('rel_order_account');
const POLICY_ORDER = nodeId('policy_order');
const QUERY_ORDERS = nodeId('query_orders');
const ACTION_CONFIRM = nodeId('action_confirm');
const ACTION_RENAME_ACCOUNT = nodeId('action_rename_account');
const ACTION_TOUCH_ORDERS_STATE = nodeId('action_touch_orders');
const ROW = nodeId('scope_row');
const ACC = nodeId('scope_acc');
const PROW = nodeId('scope_policy');
const P_STATUS = nodeId('param_status');
const P_ORDER = nodeId('param_order');
const P_NAME = nodeId('param_name');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('orders', 'Orders');
  g.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_ACCOUNT_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_STATUS, valueType: enumType(['pending', 'confirmed']), required: true },
      { id: F_ORDER_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: ENTITY_ACCOUNT,
    kind: 'entity',
    identityFieldId: F_ACC_ID,
    fields: [
      { id: F_ACC_ID, valueType: primitiveType('string'), required: true },
      { id: F_ACC_NAME, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: ENTITY_SUMMARY,
    kind: 'entity',
    identityFieldId: F_SUM_ID,
    fields: [
      { id: F_SUM_ID, valueType: primitiveType('string'), required: true },
      { id: F_SUM_ACCOUNT, valueType: primitiveType('string') },
    ],
  });
  g.addNode<StateDef>({ id: STATE_ORDERS, kind: 'state', valueType: collectionType(entityType(ENTITY_ORDER)) });
  g.addNode<StateDef>({ id: STATE_ACCOUNTS, kind: 'state', valueType: collectionType(entityType(ENTITY_ACCOUNT)) });
  g.addNode<RelationshipDef>({
    id: REL_ORDER_ACCOUNT,
    kind: 'relationship',
    cardinality: 'to-one',
    from: { entityId: ENTITY_ORDER, fieldId: F_ORDER_ACCOUNT_ID },
    to: { entityId: ENTITY_ACCOUNT, fieldId: F_ACC_ID },
  });
  g.addNode<ReadPolicyDef>({
    id: POLICY_ORDER,
    kind: 'read-policy',
    entityId: ENTITY_ORDER,
    rowScopeId: PROW,
    predicate: binary('eq', field(ref(PROW), F_ORDER_STATUS), field(ref(PROW), F_ORDER_STATUS)),
  });
  g.addNode<QueryDef>({
    id: QUERY_ORDERS,
    kind: 'query',
    source: ENTITY_ORDER,
    rowScopeId: ROW,
    parameters: [{ id: P_STATUS, valueType: enumType(['pending', 'confirmed']), required: false }],
    filter: binary('eq', field(ref(ROW), F_ORDER_STATUS), ref(P_STATUS)),
    sort: [{ key: field(ref(ROW), F_ORDER_TOTAL), direction: 'desc' }],
    relationships: [{ relationshipId: REL_ORDER_ACCOUNT, bindAs: ACC }],
    projection: {
      entityId: ENTITY_SUMMARY,
      fields: [
        { id: F_SUM_ID, value: field(ref(ROW), F_ORDER_ID) },
        { id: F_SUM_ACCOUNT, value: field(ref(ACC), F_ACC_NAME) },
      ],
    },
    pagination: { strategy: 'cursor', maxPageSize: 25 },
    readPolicyId: POLICY_ORDER,
  });
  // Mutates an Order row → should invalidate the query.
  g.addNode<ActionDef>({
    id: ACTION_CONFIRM,
    kind: 'action',
    parameters: [{ id: P_ORDER, valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(ENTITY_ORDER, F_ORDER_ID, ref(P_ORDER), F_ORDER_STATUS), value: literal('confirmed') },
    ],
  });
  // Writes the accounts state, which holds an entity the query traverses → should invalidate.
  g.addNode<ActionDef>({
    id: ACTION_RENAME_ACCOUNT,
    kind: 'action',
    parameters: [{ id: P_NAME, valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'set',
        target: {
          kind: 'field',
          target: {
            kind: 'collection-item',
            collection: stateLocation(STATE_ACCOUNTS),
            selector: { kind: 'identity', fieldId: F_ACC_ID, value: literal('a1') },
          },
          fieldId: F_ACC_NAME,
        },
        value: ref(P_NAME),
      },
    ],
  });
  return g;
}

const api = new AgentAPI(graph());

test('listQueries / listRelationships / listReadPolicies enumerate the vocabulary', () => {
  assert.deepEqual(api.listQueries().map((q) => String(q.id)), [String(QUERY_ORDERS)]);
  assert.deepEqual(api.listRelationships().map((r) => String(r.id)), [String(REL_ORDER_ACCOUNT)]);
  assert.deepEqual(api.listReadPolicies().map((p) => String(p.id)), [String(POLICY_ORDER)]);
});

test('a query names its return entity, parameters, entities read and relationships traversed', () => {
  assert.equal(String(api.getQueryResultEntity(QUERY_ORDERS)), String(ENTITY_SUMMARY));
  assert.deepEqual(api.getQueryParameters(QUERY_ORDERS).map((p) => String(p.id)), [String(P_STATUS)]);
  assert.deepEqual(
    api.getQueryEntities(QUERY_ORDERS).map((e) => String(e.id)).sort(),
    [String(ENTITY_ACCOUNT), String(ENTITY_ORDER)].sort(),
  );
  assert.deepEqual(api.getQueryRelationships(QUERY_ORDERS).map((r) => String(r.id)), [String(REL_ORDER_ACCOUNT)]);
  assert.equal(api.isAggregateQuery(QUERY_ORDERS), false);
});

test('getQueryFields reports every field the query reads across its clauses', () => {
  const fields = api.getQueryFields(QUERY_ORDERS).map(String).sort();
  assert.ok(fields.includes(String(F_ORDER_STATUS)), 'the filter field');
  assert.ok(fields.includes(String(F_ORDER_TOTAL)), 'the sort field');
  assert.ok(fields.includes(String(F_ORDER_ID)), 'a projected field');
  assert.ok(fields.includes(String(F_ACC_NAME)), 'a projected relationship field');
});

test('getReadPolicyForQuery resolves the governing policy', () => {
  assert.equal(String(api.getReadPolicyForQuery(QUERY_ORDERS)?.id), String(POLICY_ORDER));
});

test('getActionsInvalidatingQuery finds both a provider-record write and a related-state write', () => {
  const actions = api.getActionsInvalidatingQuery(QUERY_ORDERS).map((a) => String(a.id)).sort();
  assert.deepEqual(actions, [String(ACTION_CONFIRM), String(ACTION_RENAME_ACCOUNT)].sort());
});

test('getQueriesInvalidatedByAction is the inverse relation', () => {
  assert.deepEqual(
    api.getQueriesInvalidatedByAction(ACTION_CONFIRM).map((q) => String(q.id)),
    [String(QUERY_ORDERS)],
  );
});

test('explainQuery renders the structural account the spec §86 describes', () => {
  const explanation = api.explainQuery(QUERY_ORDERS);
  assert.ok(explanation);
  assert.equal(String(explanation!.source), String(ENTITY_ORDER));
  assert.ok(explanation!.filter, 'the requested predicate');
  assert.ok(explanation!.readPolicyPredicate, 'the policy conjunct is called out');
  assert.equal(String(explanation!.identityTieBreaker), String(F_ORDER_ID));
  assert.equal(explanation!.sort[0].direction, 'desc');
  assert.deepEqual(explanation!.projection?.fields.map(String), [String(F_SUM_ID), String(F_SUM_ACCOUNT)]);
  assert.equal(explanation!.pagination.strategy, 'cursor');
  assert.equal(explanation!.pagination.maxPageSize, 25);
  assert.deepEqual(explanation!.entities.map(String).sort(), [String(ENTITY_ACCOUNT), String(ENTITY_ORDER)].sort());
  assert.ok(explanation!.invalidatingActions.length >= 2);
});

test('getMutationImpact on an Order field includes the query it feeds', () => {
  const impact = api.getMutationImpact(
    providerRecordFieldLocation(ENTITY_ORDER, F_ORDER_ID, literal('o1'), F_ORDER_STATUS),
  );
  assert.deepEqual(impact.affectedQueries.map((q) => String(q.id)), [String(QUERY_ORDERS)]);
});
