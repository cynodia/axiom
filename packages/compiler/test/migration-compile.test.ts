import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTHORING_METADATA_KEY,
  ApplicationGraph,
  collectionType,
  entityType,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  schemaFingerprint,
} from '@cynodia/axiom-core';
import type { EntityDef, MigrationDef, StateDef } from '@cynodia/axiom-core';
import { compileToIR, compileToServerIR } from '@cynodia/axiom-compiler';

const E_ORDER = nodeId('entity_order');
const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ORDER_STATUS = fieldId('field_order_status');
const S_ORDERS = nodeId('state_orders');

function baseGraph(schemaVersion = 1): ApplicationGraph {
  const graph = new ApplicationGraph('app', 'App', '0.11.0');
  if (schemaVersion !== 1) graph.setSchemaVersion(schemaVersion);
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string') },
      { id: F_ORDER_TOTAL, valueType: primitiveType('number') },
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

test('a graph with no migration and schemaVersion 1 compiles to a pre-v7 contract with no schema fields', () => {
  const ir = compileToServerIR(baseGraph());
  assert.notEqual(ir.contract, 'axiom.server.v7');
  assert.equal(ir.schemaVersion, undefined);
  assert.equal(ir.schemaFingerprint, undefined);
  assert.equal(ir.migrations, undefined);
});

test('a graph with a MigrationDef compiles to axiom.server.v7 carrying migrations + schema identity', () => {
  const graph = baseGraph(2);
  graph.updateNode({
    ...graph.getNode<EntityDef>(E_ORDER)!,
    fields: [
      ...graph.getNode<EntityDef>(E_ORDER)!.fields,
      { id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<MigrationDef>({
    id: nodeId('migration_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      {
        id: nodeId('op_add_status'),
        kind: 'add-field',
        entityId: E_ORDER,
        field: { id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true },
        populate: literal('draft'),
      },
    ],
  });

  const ir = compileToServerIR(graph);
  assert.equal(ir.contract, 'axiom.server.v7');
  assert.equal(ir.schemaVersion, 2);
  assert.equal(ir.schemaFingerprint, schemaFingerprint(graph));
  assert.equal(ir.migrations?.length, 1);
  assert.equal(ir.migrations?.[0].fromSchema, 1);
  assert.equal(ir.migrations?.[0].operations[0].kind, 'add-field');
});

test('schemaVersion past 1 with no migrations still requires v7', () => {
  // Not a valid chain (validateGraph would reject), so compile without validation.
  const ir = compileToServerIR(baseGraph(3), { validate: false });
  assert.equal(ir.contract, 'axiom.server.v7');
  assert.equal(ir.schemaVersion, 3);
  assert.equal(ir.schemaFingerprint, schemaFingerprint(baseGraph(3)));
  assert.equal(ir.migrations, undefined);
});

test('migrations never reach the client IR', () => {
  const graph = baseGraph(2);
  graph.addNode<MigrationDef>({
    id: nodeId('migration_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      { id: nodeId('op1'), kind: 'remove-field', entityId: E_ORDER, fieldId: F_ORDER_TOTAL, destructive: true },
    ],
  });
  const clientIR = JSON.stringify(compileToIR(graph, { validate: false }));
  assert.equal(clientIR.includes('migration_1_2'), false);
  assert.equal(clientIR.includes('"migrations"'), false);
});

test('authoring metadata is stripped from a migration in the Server IR', () => {
  const graph = baseGraph(2);
  graph.addNode<MigrationDef>({
    id: nodeId('migration_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    metadata: { [AUTHORING_METADATA_KEY]: { generatedBy: 'a-tool' }, kept: true },
    operations: [
      {
        id: nodeId('op1'),
        kind: 'populate-field',
        entityId: E_ORDER,
        fieldId: F_ORDER_TOTAL,
        value: literal(0),
        metadata: { [AUTHORING_METADATA_KEY]: { note: 'x' } },
      },
    ],
  });
  const serialized = JSON.stringify(compileToServerIR(graph, { validate: false }));
  assert.equal(serialized.includes(AUTHORING_METADATA_KEY), false);
  assert.equal(serialized.includes('"kept":true'), true);
});

test('a plain query-layer graph still compiles to v6, unaffected by the v7 tier', () => {
  // baseGraph has server-authoritative state but no query/migration vocabulary.
  const ir = compileToServerIR(baseGraph());
  assert.ok(['axiom.server.v1', 'axiom.server.v2'].includes(ir.contract));
});
