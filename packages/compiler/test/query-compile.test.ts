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
  nodeId,
  primitiveType,
  ref,
} from '@cynodia/axiom-core';
import type { EntityDef, QueryDef, ReadPolicyDef, RelationshipDef, StateDef } from '@cynodia/axiom-core';
import { compileToIR, compileToServerIR } from '@cynodia/axiom-compiler';

const ENTITY_ORDER = nodeId('entity_order');
const ENTITY_ACCOUNT = nodeId('entity_account');
const ENTITY_SUMMARY = nodeId('entity_order_summary');

const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_ACCOUNT_ID = fieldId('field_order_account_id');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_CREATED_AT = fieldId('field_order_created_at');
const F_ACCOUNT_ID = fieldId('field_account_id');
const F_ACCOUNT_NAME = fieldId('field_account_name');
const F_SUMMARY_ID = fieldId('field_summary_id');
const F_SUMMARY_ACCOUNT = fieldId('field_summary_account');

const STATE_ORDERS = nodeId('state_orders');
const REL_ORDER_ACCOUNT = nodeId('rel_order_account');
const POLICY_ORDER = nodeId('policy_order');
const QUERY_ORDERS = nodeId('query_orders');
const SCOPE_ROW = nodeId('scope_row');
const SCOPE_ACCOUNT = nodeId('scope_account');
const SCOPE_POLICY = nodeId('scope_policy');
const P_STATUS = nodeId('param_status');
const STATUS = ['pending', 'confirmed'];

function graphWithQuery(): ApplicationGraph {
  const graph = new ApplicationGraph('orders', 'Orders');
  graph.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_ACCOUNT_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_STATUS, valueType: enumType(STATUS), required: true },
      { id: F_ORDER_CREATED_AT, valueType: primitiveType('datetime'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_ACCOUNT,
    kind: 'entity',
    identityFieldId: F_ACCOUNT_ID,
    fields: [
      { id: F_ACCOUNT_ID, valueType: primitiveType('string'), required: true },
      { id: F_ACCOUNT_NAME, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_SUMMARY,
    kind: 'entity',
    identityFieldId: F_SUMMARY_ID,
    fields: [
      { id: F_SUMMARY_ID, valueType: primitiveType('string'), required: true },
      { id: F_SUMMARY_ACCOUNT, valueType: primitiveType('string') },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE_ORDERS,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY_ORDER)),
  });
  graph.addNode<RelationshipDef>({
    id: REL_ORDER_ACCOUNT,
    kind: 'relationship',
    cardinality: 'to-one',
    from: { entityId: ENTITY_ORDER, fieldId: F_ORDER_ACCOUNT_ID },
    to: { entityId: ENTITY_ACCOUNT, fieldId: F_ACCOUNT_ID },
  });
  graph.addNode<ReadPolicyDef>({
    id: POLICY_ORDER,
    kind: 'read-policy',
    entityId: ENTITY_ORDER,
    rowScopeId: SCOPE_POLICY,
    predicate: binary(
      'eq',
      field(ref(SCOPE_POLICY), F_ORDER_STATUS),
      field(ref(SCOPE_POLICY), F_ORDER_STATUS),
    ),
  });
  graph.addNode<QueryDef>({
    id: QUERY_ORDERS,
    kind: 'query',
    source: ENTITY_ORDER,
    rowScopeId: SCOPE_ROW,
    parameters: [{ id: P_STATUS, valueType: enumType(STATUS) }],
    filter: binary('eq', field(ref(SCOPE_ROW), F_ORDER_STATUS), ref(P_STATUS)),
    sort: [{ key: field(ref(SCOPE_ROW), F_ORDER_CREATED_AT), direction: 'desc' }],
    relationships: [{ relationshipId: REL_ORDER_ACCOUNT, bindAs: SCOPE_ACCOUNT }],
    projection: {
      entityId: ENTITY_SUMMARY,
      fields: [
        { id: F_SUMMARY_ID, value: field(ref(SCOPE_ROW), F_ORDER_ID) },
        { id: F_SUMMARY_ACCOUNT, value: field(ref(SCOPE_ACCOUNT), F_ACCOUNT_NAME) },
      ],
    },
    pagination: { strategy: 'cursor', maxPageSize: 100 },
    readPolicyId: POLICY_ORDER,
  });
  return graph;
}

test('a graph that uses query vocabulary compiles to axiom.server.v6', () => {
  const ir = compileToServerIR(graphWithQuery());
  assert.equal(ir.contract, 'axiom.server.v6');
  assert.equal(ir.queries?.length, 1);
  assert.equal(ir.relationships?.length, 1);
  assert.equal(ir.readPolicies?.length, 1);
  assert.equal(String(ir.queries?.[0].id), String(QUERY_ORDERS));
  assert.ok(ir.queries?.[0].filter, 'the query filter survives compilation');
});

test('the contract is computed from the document — no query vocabulary stays below v6', () => {
  const graph = new ApplicationGraph('plain', 'Plain');
  graph.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [{ id: F_ORDER_ID, valueType: primitiveType('string'), required: true }],
  });
  graph.addNode<StateDef>({
    id: STATE_ORDERS,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY_ORDER)),
  });
  assert.equal(compileToServerIR(graph).contract, 'axiom.server.v1');
});

test('the client IR carries no query, relationship or read-policy node', () => {
  const client = compileToIR(graphWithQuery());
  const kinds = Object.values(client.nodes).map((node) => node.kind);
  assert.ok(!kinds.includes('query' as never));
  assert.ok(!kinds.includes('relationship' as never));
  assert.ok(!kinds.includes('read-policy' as never));
  const serialized = JSON.stringify(client);
  assert.ok(!serialized.includes(String(QUERY_ORDERS)), 'the query id never reaches the client');
  assert.ok(!serialized.includes(String(POLICY_ORDER)), 'the read policy never reaches the client');
});
