import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  VALIDATION_CODES,
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
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  EntityDef,
  QueryDef,
  ReadPolicyDef,
  RelationshipDef,
  StateDef,
} from '@cynodia/axiom-core';

const ENTITY_ORDER = nodeId('entity_order');
const ENTITY_ACCOUNT = nodeId('entity_account');
const ENTITY_SUMMARY = nodeId('entity_order_summary');

const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_ACCOUNT_ID = fieldId('field_order_account_id');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_CREATED_AT = fieldId('field_order_created_at');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ORDER_TAGS = fieldId('field_order_tags');

const F_ACCOUNT_ID = fieldId('field_account_id');
const F_ACCOUNT_NAME = fieldId('field_account_name');

const F_SUMMARY_ID = fieldId('field_summary_id');
const F_SUMMARY_ACCOUNT = fieldId('field_summary_account');
const F_SUMMARY_TOTAL = fieldId('field_summary_total');
const F_SUMMARY_COUNT = fieldId('field_summary_count');

const STATE_ORDERS = nodeId('state_orders');
const STATE_ACCOUNTS = nodeId('state_accounts');

const REL_ORDER_ACCOUNT = nodeId('rel_order_account');
const POLICY_ORDER = nodeId('policy_order');
const QUERY_ORDERS = nodeId('query_orders');

const SCOPE_ROW = nodeId('scope_order_row');
const SCOPE_ACCOUNT = nodeId('scope_order_account');
const SCOPE_POLICY = nodeId('scope_policy_row');
const P_STATUS = nodeId('param_status');

const STATUS = ['pending', 'confirmed', 'cancelled'];

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('orders', 'Orders');
  graph.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_ACCOUNT_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_STATUS, valueType: enumType(STATUS), required: true },
      { id: F_ORDER_CREATED_AT, valueType: primitiveType('datetime'), required: true },
      { id: F_ORDER_TOTAL, valueType: primitiveType('number'), required: true },
      { id: F_ORDER_TAGS, valueType: collectionType(primitiveType('string')) },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_ACCOUNT,
    kind: 'entity',
    name: 'Account',
    identityFieldId: F_ACCOUNT_ID,
    fields: [
      { id: F_ACCOUNT_ID, valueType: primitiveType('string'), required: true },
      { id: F_ACCOUNT_NAME, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_SUMMARY,
    kind: 'entity',
    name: 'OrderSummary',
    identityFieldId: F_SUMMARY_ID,
    fields: [
      { id: F_SUMMARY_ID, valueType: primitiveType('string'), required: true },
      { id: F_SUMMARY_ACCOUNT, valueType: primitiveType('string') },
      { id: F_SUMMARY_TOTAL, valueType: primitiveType('number') },
      { id: F_SUMMARY_COUNT, valueType: primitiveType('number') },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE_ORDERS,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY_ORDER)),
  });
  graph.addNode<StateDef>({
    id: STATE_ACCOUNTS,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY_ACCOUNT)),
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
  return graph;
}

function withQuery(graph: ApplicationGraph, overrides: Partial<QueryDef> = {}): ApplicationGraph {
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
        { id: F_SUMMARY_TOTAL, value: field(ref(SCOPE_ROW), F_ORDER_TOTAL) },
      ],
    },
    pagination: { strategy: 'cursor', maxPageSize: 100, defaultPageSize: 50 },
    readPolicyId: POLICY_ORDER,
    ...overrides,
  });
  return graph;
}

function codes(graph: ApplicationGraph): string[] {
  return validateGraph(graph).errors.map((error) => error.code);
}

test('a well-formed query, relationship and read policy validate', () => {
  const result = validateGraph(withQuery(baseGraph()));
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});

test('a query over an unknown entity is rejected', () => {
  const graph = withQuery(baseGraph(), { source: nodeId('entity_missing') });
  assert.ok(codes(graph).includes(VALIDATION_CODES.unknownQueryEntity));
});

test('a non-boolean filter is rejected', () => {
  const graph = withQuery(baseGraph(), { filter: field(ref(SCOPE_ROW), F_ORDER_TOTAL) });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidQueryPredicate));
});

test('sorting by a collection field is rejected', () => {
  const graph = withQuery(baseGraph(), {
    sort: [{ key: field(ref(SCOPE_ROW), F_ORDER_TAGS) }],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidQuerySort));
});

test('projecting a field the projection entity does not have is rejected', () => {
  const graph = withQuery(baseGraph(), {
    projection: {
      entityId: ENTITY_SUMMARY,
      fields: [{ id: F_ACCOUNT_NAME, value: field(ref(SCOPE_ROW), F_ORDER_ID) }],
    },
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidQueryProjection));
});

test('a sum aggregate over a non-numeric key is rejected', () => {
  const graph = withQuery(baseGraph(), {
    projection: undefined,
    aggregate: [{ function: 'sum', key: field(ref(SCOPE_ROW), F_ORDER_STATUS), as: F_SUMMARY_TOTAL }],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidQueryAggregate));
});

test('a count aggregate carrying a key is rejected', () => {
  const graph = withQuery(baseGraph(), {
    projection: undefined,
    aggregate: [{ function: 'count', key: field(ref(SCOPE_ROW), F_ORDER_ID), as: F_SUMMARY_COUNT }],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidQueryAggregate));
});

test('groupBy with no aggregate is rejected', () => {
  const graph = withQuery(baseGraph(), {
    groupBy: [field(ref(SCOPE_ROW), F_ORDER_STATUS)],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidQueryGrouping));
});

test('cursor pagination over a source with no identity field is unstable', () => {
  const graph = baseGraph();
  const order = graph.getNode<EntityDef>(ENTITY_ORDER)!;
  delete order.identityFieldId;
  graph.updateNode(order);
  withQuery(graph);
  assert.ok(codes(graph).includes(VALIDATION_CODES.unstablePagination));
});

test('a read policy governing a different entity than the query source is rejected', () => {
  const graph = baseGraph();
  const policy = graph.getNode<ReadPolicyDef>(POLICY_ORDER)!;
  policy.entityId = ENTITY_ACCOUNT;
  policy.predicate = binary(
    'eq',
    field(ref(SCOPE_POLICY), F_ACCOUNT_ID),
    field(ref(SCOPE_POLICY), F_ACCOUNT_ID),
  );
  graph.updateNode(policy);
  withQuery(graph);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidReadPolicy));
});

test('two read policies over one entity are rejected', () => {
  const graph = baseGraph();
  graph.addNode<ReadPolicyDef>({
    id: nodeId('policy_order_two'),
    kind: 'read-policy',
    entityId: ENTITY_ORDER,
    rowScopeId: nodeId('scope_policy_two'),
    predicate: binary(
      'eq',
      field(ref(nodeId('scope_policy_two')), F_ORDER_ID),
      field(ref(nodeId('scope_policy_two')), F_ORDER_ID),
    ),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.duplicateReadPolicy));
});

test('a non-boolean read policy predicate is rejected', () => {
  const graph = baseGraph();
  const policy = graph.getNode<ReadPolicyDef>(POLICY_ORDER)!;
  policy.predicate = field(ref(SCOPE_POLICY), F_ORDER_TOTAL);
  graph.updateNode(policy);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidReadPolicy));
});

test('a to-one relationship not landing on the target identity is rejected', () => {
  const graph = baseGraph();
  const rel = graph.getNode<RelationshipDef>(REL_ORDER_ACCOUNT)!;
  rel.to = { entityId: ENTITY_ACCOUNT, fieldId: F_ACCOUNT_NAME };
  graph.updateNode(rel);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidRelationship));
});

test('a relationship endpoint field that is not on its entity is rejected', () => {
  const graph = baseGraph();
  const rel = graph.getNode<RelationshipDef>(REL_ORDER_ACCOUNT)!;
  rel.from = { entityId: ENTITY_ORDER, fieldId: F_ACCOUNT_NAME };
  graph.updateNode(rel);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidRelationship));
});

test('a query traversing a relationship that starts from another entity is rejected', () => {
  const graph = baseGraph();
  graph.addNode<RelationshipDef>({
    id: nodeId('rel_account_orders'),
    kind: 'relationship',
    cardinality: 'to-many',
    from: { entityId: ENTITY_ACCOUNT, fieldId: F_ACCOUNT_ID },
    to: { entityId: ENTITY_ORDER, fieldId: F_ORDER_ACCOUNT_ID },
  });
  withQuery(graph, {
    relationships: [{ relationshipId: nodeId('rel_account_orders'), bindAs: SCOPE_ACCOUNT }],
    projection: {
      entityId: ENTITY_SUMMARY,
      fields: [{ id: F_SUMMARY_ID, value: field(ref(SCOPE_ROW), F_ORDER_ID) }],
    },
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidRelationship));
});

test('a query relationship use naming a non-relationship node is rejected', () => {
  const graph = withQuery(baseGraph(), {
    relationships: [{ relationshipId: STATE_ORDERS, bindAs: SCOPE_ACCOUNT }],
    projection: {
      entityId: ENTITY_SUMMARY,
      fields: [{ id: F_SUMMARY_ID, value: field(ref(SCOPE_ROW), F_ORDER_ID) }],
    },
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.unknownRelationship));
});

test('a query parameter colliding with a node id is rejected', () => {
  const graph = withQuery(baseGraph(), {
    parameters: [{ id: STATE_ORDERS, valueType: primitiveType('string') }],
    filter: undefined,
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidQueryParameter));
});

const P_ORDER_ID = nodeId('param_order_id');
const ACTION_CONFIRM = nodeId('action_confirm_order');

function withConfirmAction(graph: ApplicationGraph, identityFieldId = F_ORDER_ID): ApplicationGraph {
  graph.addNode<ActionDef>({
    id: ACTION_CONFIRM,
    kind: 'action',
    parameters: [{ id: P_ORDER_ID, valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'set',
        target: providerRecordFieldLocation(ENTITY_ORDER, identityFieldId, ref(P_ORDER_ID), F_ORDER_STATUS),
        value: literal('confirmed'),
      },
    ],
  });
  return graph;
}

test('an action that sets a provider-record field by identity validates', () => {
  const result = validateGraph(withConfirmAction(baseGraph()));
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});

test('a provider-record location over a non-identity field is rejected', () => {
  const graph = withConfirmAction(baseGraph(), F_ORDER_ACCOUNT_ID);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidProviderRecordLocation));
});

test('a query derives read edges to the state holding its source, and references its parts', () => {
  const graph = withQuery(baseGraph());
  const edges = graph.getOutgoingEdges(QUERY_ORDERS);
  const to = (kind: string): string[] =>
    edges.filter((edge) => edge.kind === kind).map((edge) => String(edge.to));
  assert.ok(to('reads').includes(String(STATE_ORDERS)), 'reads the order state');
  assert.ok(to('references').includes(String(ENTITY_ORDER)), 'references its source entity');
  assert.ok(to('references').includes(String(REL_ORDER_ACCOUNT)), 'references the relationship');
  assert.ok(to('depends-on').includes(String(POLICY_ORDER)), 'depends on its read policy');
});
