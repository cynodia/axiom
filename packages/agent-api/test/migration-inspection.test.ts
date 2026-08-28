import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  diffSchema,
  entityType,
  field,
  fieldId,
  fieldLocation,
  itemFieldLocation,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  MigrationDef,
  QueryDef,
  StateDef,
} from '@cynodia/axiom-core';
import { AgentAPI, explainSchemaDiff, inspectSchema, migrationImpact } from '@cynodia/axiom-agent-api';

const E_ORDER = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_LEGACY = fieldId('field_order_legacy');
const S_ORDERS = nodeId('state_orders');
const SCOPE_ROW = nodeId('scope_order_row');

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string') },
      { id: F_TOTAL, valueType: primitiveType('number') },
      { id: F_LEGACY, valueType: primitiveType('string') },
    ],
  });
  graph.addNode<StateDef>({
    id: S_ORDERS,
    kind: 'state',
    valueType: collectionType(entityType(E_ORDER)),
    authority: 'server',
  });
  return graph;
}

test('inspectSchema summarises version, fingerprint, entities and the migration chain', () => {
  const graph = baseGraph();
  graph.setSchemaVersion(2);
  graph.addNode<MigrationDef>({
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      {
        id: nodeId('op1'),
        kind: 'add-field',
        entityId: E_ORDER,
        field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
        populate: literal('draft'),
      },
      { id: nodeId('op2'), kind: 'remove-field', entityId: E_ORDER, fieldId: F_LEGACY, destructive: true },
    ],
  });

  const inspection = inspectSchema(graph);
  assert.equal(inspection.schemaVersion, 2);
  assert.match(inspection.schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(inspection.chainComplete, true);
  assert.equal(inspection.entities[0].id, String(E_ORDER));
  assert.equal(inspection.migrations.length, 1);
  assert.equal(inspection.migrations[0].operationCount, 2);
  assert.equal(inspection.migrations[0].destructiveOperationCount, 1);
});

test('inspectSchema reports an incomplete chain', () => {
  const graph = baseGraph();
  graph.setSchemaVersion(3); // needs 1->2->3, has none
  assert.equal(inspectSchema(graph).chainComplete, false);
});

test('explainSchemaDiff renders + / ~ / - lines, never a JSON dump (spec11 §58)', () => {
  const before = baseGraph();
  const after = baseGraph();
  const order = after.getNode<EntityDef>(E_ORDER)!;
  order.fields = [
    ...order.fields.filter((f) => f.id !== F_LEGACY),
    { id: F_STATUS, valueType: primitiveType('string'), required: true },
  ];
  after.updateNode(order);

  const text = explainSchemaDiff(diffSchema(before, after));
  assert.match(text, /\+ .*field_order_status/);
  assert.match(text, /- .*field_order_legacy/);
  assert.doesNotMatch(text, /[{}]/);
});

test('migrationImpact names the queries, actions, constraints and UI that reference a changed field (spec11 §57)', () => {
  const before = baseGraph();

  const after = baseGraph();
  after.setSchemaVersion(2);
  // The migration changes field_order_total's type.
  const order = after.getNode<EntityDef>(E_ORDER)!;
  order.fields = order.fields.map((f) =>
    f.id === F_TOTAL ? { ...f, valueType: primitiveType('string') } : f,
  );
  after.updateNode(order);
  after.addNode<MigrationDef>({
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      {
        id: nodeId('op_x'),
        kind: 'transform-field',
        entityId: E_ORDER,
        fieldId: F_TOTAL,
        fromType: primitiveType('number'),
        toType: primitiveType('string'),
        expression: literal('0'),
      },
    ],
  });
  // A query that reads total, a constraint on the entity, an action that writes total, a UI display.
  after.addNode<QueryDef>({
    id: nodeId('query_big_orders'),
    kind: 'query',
    source: E_ORDER,
    rowScopeId: SCOPE_ROW,
    filter: binary('gt', field(ref(SCOPE_ROW), F_TOTAL), literal(100)),
    pagination: { strategy: 'cursor', maxPageSize: 50 },
  });
  after.addNode<ConstraintDef>({
    id: nodeId('constraint_total_nonneg'),
    kind: 'constraint',
    entityId: E_ORDER,
    expression: binary('gte', field(ref(E_ORDER), F_TOTAL), literal(0)),
  });
  after.addNode<ActionDef>({
    id: nodeId('action_set_total'),
    kind: 'action',
    parameters: [{ id: nodeId('p_total'), valueType: primitiveType('number') }],
    operations: [
      {
        kind: 'set',
        target: itemFieldLocation(S_ORDERS, F_ID, literal('x'), F_TOTAL),
        value: ref(nodeId('p_total')),
      },
    ],
  });
  after.addNode({
    id: nodeId('ui_total'),
    kind: 'field-display',
    source: ref(nodeId('state_orders')),
    fieldId: F_TOTAL,
  } as never);

  const impact = migrationImpact(before, after);
  assert.equal(impact.dataLossPossible, false);
  assert.deepEqual(impact.affectedFields, [String(F_TOTAL)]);
  assert.ok(impact.affectedQueries.includes(String(nodeId('query_big_orders'))));
  assert.ok(impact.affectedConstraints.includes(String(nodeId('constraint_total_nonneg'))));
  assert.ok(impact.affectedActions.includes(String(nodeId('action_set_total'))));
  assert.ok(impact.affectedUiNodes.includes(String(nodeId('ui_total'))));
  assert.equal(impact.covered, true, 'the transform-field operation covers the diff');
});

test('migrationImpact flags data loss and an uncovered change', () => {
  const before = baseGraph();
  const after = baseGraph();
  after.setSchemaVersion(2);
  const order = after.getNode<EntityDef>(E_ORDER)!;
  order.fields = order.fields.filter((f) => f.id !== F_LEGACY); // removed, no migration op
  after.updateNode(order);
  after.addNode<MigrationDef>({
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [],
  });

  const impact = migrationImpact(before, after);
  assert.equal(impact.dataLossPossible, true);
  assert.equal(impact.covered, false);
  assert.equal(impact.uncovered[0].fieldId, String(F_LEGACY));
});

test('migrationImpact reports a read-policy change as an authorization change, not data loss (spec11 §42)', () => {
  const before = baseGraph();
  const after = baseGraph();
  after.setSchemaVersion(1);
  after.addNode({
    id: nodeId('policy_order'),
    kind: 'read-policy',
    entityId: E_ORDER,
    rowScopeId: nodeId('scope_policy'),
    predicate: literal(true),
  } as never);

  const impact = migrationImpact(before, after);
  assert.equal(impact.dataLossPossible, false);
  assert.deepEqual(impact.authorizationChanges, [String(nodeId('policy_order'))]);
});

test('AgentAPI exposes inspectSchema / diffSchema / migrationImpact', () => {
  const before = baseGraph();
  const after = baseGraph();
  after.setSchemaVersion(2);
  after.addNode<MigrationDef>({ id: nodeId('m_1_2'), kind: 'migration', fromSchema: 1, toSchema: 2, operations: [] });
  const api = new AgentAPI(after);
  assert.equal(api.inspectSchema().schemaVersion, 2);
  assert.equal(api.diffSchema(before).toVersion, 2);
  assert.equal(api.migrationImpact(before).fromVersion, 1);
  void fieldLocation;
  void stateLocation;
});
