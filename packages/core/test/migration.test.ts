import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  MIGRATION_OLD_SCOPE,
  MIGRATION_OPERATION_KINDS,
  MIGRATION_REVERSIBILITIES,
  SEMANTIC_NODE_KINDS,
  addField,
  changeField,
  field,
  fieldId,
  literal,
  migrationExpressions,
  migrationOperationEntityId,
  migrationOperationExpressions,
  migrationOperationFieldIds,
  migrationOperationReadFieldIds,
  migrationPath,
  nodeId,
  object,
  populateField,
  primitiveType,
  ref,
  removeField,
  sortMigrations,
  transformRecord,
  validateGraph,
} from '@cynodia/axiom-core';
import type { EntityDef, MigrationDef, MigrationOperation, StateDef } from '@cynodia/axiom-core';

const E_ORDER = nodeId('entity_order');
const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_LEGACY = fieldId('field_order_legacy_code');
const E_CUSTOMER = nodeId('entity_customer');
const F_CUST_ID = fieldId('field_customer_id');
const F_CUST_NAME = fieldId('field_customer_name');
const F_CUST_GIVEN = fieldId('field_customer_given');
const F_CUST_FAMILY = fieldId('field_customer_family');

function graphWithOrder(): ApplicationGraph {
  const graph = new ApplicationGraph('app', 'App', '0.11.0');
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
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: { kind: 'collection', itemType: { kind: 'entity', entityId: E_ORDER } },
  });
  return graph;
}

test("'migration' is a semantic node kind", () => {
  assert.ok(SEMANTIC_NODE_KINDS.includes('migration'));
});

test('the migration operation vocabulary is exactly ten kinds', () => {
  assert.equal(MIGRATION_OPERATION_KINDS.length, 10);
  assert.deepEqual(
    [...MIGRATION_OPERATION_KINDS].sort(),
    [
      'add-entity',
      'add-field',
      'add-relationship',
      'change-field',
      'populate-field',
      'remove-entity',
      'remove-field',
      'remove-relationship',
      'transform-field',
      'transform-record',
    ],
  );
  assert.deepEqual([...MIGRATION_REVERSIBILITIES], [
    'reversible',
    'irreversible',
    'reverse-supplied',
  ]);
});

test('a MigrationDef is a first-class node that passes validateGraph structurally', () => {
  const graph = graphWithOrder();
  graph.setSchemaVersion(2);
  graph.addNode<MigrationDef>({
    id: nodeId('migration_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      addField(nodeId('op_add_status'), E_ORDER, {
        id: F_ORDER_STATUS,
        valueType: primitiveType('string'),
        required: true,
      }, { populate: literal('draft') }),
    ],
  });
  const result = validateGraph(graph);
  assert.deepEqual(result.errors, []);
});

test('migrationOperationExpressions collects transform leaves and nothing else', () => {
  const populate = populateField(nodeId('op1'), E_ORDER, F_ORDER_STATUS, literal('draft'));
  assert.deepEqual(migrationOperationExpressions(populate), [literal('draft')]);

  const drop = removeField(nodeId('op2'), E_ORDER, F_ORDER_LEGACY, { destructive: true });
  assert.deepEqual(migrationOperationExpressions(drop), []);

  const split = transformRecord(nodeId('op3'), E_CUSTOMER, {
    produce: object([
      { fieldId: F_CUST_GIVEN, value: field(ref(MIGRATION_OLD_SCOPE), F_CUST_NAME) },
      { fieldId: F_CUST_FAMILY, value: field(ref(MIGRATION_OLD_SCOPE), F_CUST_NAME) },
    ]),
    removesFields: [F_CUST_NAME],
    addsFields: [F_CUST_GIVEN, F_CUST_FAMILY],
  });
  assert.equal(migrationOperationExpressions(split).length, 1);
});

test('migrationOperationEntityId / FieldIds / ReadFieldIds describe an operation footprint', () => {
  const split = transformRecord(nodeId('op'), E_CUSTOMER, {
    produce: object([
      { fieldId: F_CUST_GIVEN, value: field(ref(MIGRATION_OLD_SCOPE), F_CUST_NAME) },
      { fieldId: F_CUST_FAMILY, value: field(ref(MIGRATION_OLD_SCOPE), F_CUST_NAME) },
    ]),
    removesFields: [F_CUST_NAME],
    addsFields: [F_CUST_GIVEN, F_CUST_FAMILY],
  });
  assert.equal(migrationOperationEntityId(split), E_CUSTOMER);
  assert.deepEqual(migrationOperationFieldIds(split).sort(), [
    F_CUST_FAMILY,
    F_CUST_GIVEN,
    F_CUST_NAME,
  ].sort());
  assert.deepEqual(migrationOperationReadFieldIds(split), [F_CUST_NAME]);

  const change = changeField(nodeId('op2'), E_ORDER, F_ORDER_TOTAL, { required: true });
  assert.equal(migrationOperationEntityId(change), E_ORDER);
  assert.deepEqual(migrationOperationFieldIds(change), [F_ORDER_TOTAL]);
  assert.deepEqual(migrationOperationReadFieldIds(change), []);
});

function step(from: number): MigrationDef {
  return {
    id: nodeId(`migration_${from}_${from + 1}`),
    kind: 'migration',
    fromSchema: from,
    toSchema: from + 1,
    operations: [] as MigrationOperation[],
  };
}

test('migrationPath resolves a contiguous chain', () => {
  const migrations = [step(3), step(1), step(2)];
  const path = migrationPath(migrations, 1, 4);
  assert.ok(path);
  assert.deepEqual(
    path.map((m) => [m.fromSchema, m.toSchema]),
    [
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  );
  assert.deepEqual(sortMigrations(migrations).map((m) => m.fromSchema), [1, 2, 3]);
});

test('migrationPath returns [] when already at the target and null on a gap or a fork', () => {
  assert.deepEqual(migrationPath([step(1), step(2)], 3, 3), []);
  assert.equal(migrationPath([step(1), step(3)], 1, 4), null); // missing 2→3
  assert.equal(migrationPath([step(1), step(1)], 1, 2), null); // two migrations from 1
  assert.equal(migrationPath([step(2)], 3, 2), null); // downgrade
});

test('migrationExpressions gathers leaves across operations and reverse operations', () => {
  const migration: MigrationDef = {
    id: nodeId('migration_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [populateField(nodeId('op_fwd'), E_ORDER, F_ORDER_STATUS, literal('draft'))],
    reversibility: 'reverse-supplied',
    reverseOperations: [
      populateField(nodeId('op_rev'), E_ORDER, F_ORDER_STATUS, literal('')),
    ],
  };
  assert.deepEqual(migrationExpressions(migration), [literal('draft'), literal('')]);
});
