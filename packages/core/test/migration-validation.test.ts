import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  MIGRATION_OLD_SCOPE,
  VALIDATION_CODES,
  addField,
  call,
  changeField,
  field,
  fieldId,
  literal,
  nodeId,
  object,
  populateField,
  primitiveType,
  ref,
  removeField,
  transformField,
  transformRecord,
  validateGraph,
} from '@cynodia/axiom-core';
import type { EntityDef, MigrationDef, MigrationOperation, StateDef } from '@cynodia/axiom-core';

const E_ORDER = nodeId('entity_order');
const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_LEGACY = fieldId('field_order_legacy');

function graphAt(schemaVersion: number, migrations: MigrationDef[], extraFields: EntityDef['fields'] = []): ApplicationGraph {
  const graph = new ApplicationGraph('app', 'App', '0.11.0');
  graph.setSchemaVersion(schemaVersion);
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string') },
      { id: F_ORDER_TOTAL, valueType: primitiveType('number') },
      ...extraFields,
    ],
  });
  graph.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: { kind: 'collection', itemType: { kind: 'entity', entityId: E_ORDER } },
  });
  for (const migration of migrations) {
    graph.addNode<MigrationDef>(migration);
  }
  return graph;
}

function migration(from: number, operations: MigrationOperation[]): MigrationDef {
  return {
    id: nodeId(`migration_${from}_${from + 1}`),
    kind: 'migration',
    fromSchema: from,
    toSchema: from + 1,
    operations,
  };
}

function codes(graph: ApplicationGraph): string[] {
  return validateGraph(graph).errors.map((error) => error.code);
}

test('a well-formed chain to the declared schema version validates', () => {
  const graph = graphAt(
    2,
    [
      migration(1, [
        addField(nodeId('op1'), E_ORDER, { id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true }, {
          populate: literal('draft'),
        }),
      ]),
    ],
    [{ id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true }],
  );
  assert.deepEqual(validateGraph(graph).errors, []);
});

test('a gap in the chain is MIGRATION_PATH_NOT_FOUND', () => {
  const graph = graphAt(4, [migration(1, []), migration(3, [])]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.migrationPathNotFound));
});

test('two migrations from the same version is MIGRATION_CHAIN_FORK', () => {
  const graph = new ApplicationGraph('app', 'App', '0.11.0');
  graph.setSchemaVersion(3);
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [{ id: F_ORDER_ID, valueType: primitiveType('string') }],
  });
  graph.addNode<MigrationDef>({ id: nodeId('m_a'), kind: 'migration', fromSchema: 1, toSchema: 2, operations: [] });
  graph.addNode<MigrationDef>({ id: nodeId('m_b'), kind: 'migration', fromSchema: 1, toSchema: 2, operations: [] });
  graph.addNode<MigrationDef>({ id: nodeId('m_c'), kind: 'migration', fromSchema: 2, toSchema: 3, operations: [] });
  assert.ok(codes(graph).includes(VALIDATION_CODES.migrationChainFork));
});

test('from == to and downgrades are INVALID_MIGRATION_VERSION', () => {
  const graph = new ApplicationGraph('app', 'App', '0.11.0');
  graph.setSchemaVersion(3);
  graph.addNode<EntityDef>({ id: E_ORDER, kind: 'entity', identityFieldId: F_ORDER_ID, fields: [{ id: F_ORDER_ID, valueType: primitiveType('string') }] });
  graph.addNode<MigrationDef>({ id: nodeId('m1'), kind: 'migration', fromSchema: 2, toSchema: 2, operations: [] });
  graph.addNode<MigrationDef>({ id: nodeId('m2'), kind: 'migration', fromSchema: 3, toSchema: 2, operations: [] });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidMigrationVersion));
});

test('a migration beyond the declared schema version is INVALID_MIGRATION_VERSION', () => {
  const graph = graphAt(2, [migration(1, []), migration(5, [])]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidMigrationVersion));
});

test('add-field of a required field without populate is MIGRATION_REQUIRED_FIELD_WITHOUT_DEFAULT', () => {
  const graph = graphAt(2, [
    migration(1, [
      addField(nodeId('op1'), E_ORDER, { id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true }),
    ]),
  ]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.migrationRequiredFieldWithoutDefault));
});

test('remove-field without destructive:true is MIGRATION_DESTRUCTIVE_UNMARKED', () => {
  const unmarked = graphAt(2, [
    migration(1, [{ id: nodeId('op1'), kind: 'remove-field', entityId: E_ORDER, fieldId: F_ORDER_LEGACY }]),
  ]);
  assert.ok(codes(unmarked).includes(VALIDATION_CODES.migrationDestructiveUnmarked));

  const marked = graphAt(2, [
    migration(1, [removeField(nodeId('op1'), E_ORDER, F_ORDER_LEGACY, { destructive: true })]),
  ]);
  assert.ok(!codes(marked).includes(VALIDATION_CODES.migrationDestructiveUnmarked));
});

test('a transform expression that calls now() or uuid() is MIGRATION_TRANSFORM_IMPURE', () => {
  const graph = graphAt(2, [
    migration(1, [populateField(nodeId('op1'), E_ORDER, F_ORDER_TOTAL, call('now'))]),
  ]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.migrationTransformImpure));
});

test('a transform expression that reads a stray scope is MIGRATION_TRANSFORM_IMPURE', () => {
  const graph = graphAt(2, [
    migration(1, [
      populateField(nodeId('op1'), E_ORDER, F_ORDER_TOTAL, field(ref(nodeId('state_orders')), F_ORDER_TOTAL)),
    ]),
  ]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.migrationTransformImpure));
});

test('a transform reading the old record and a declared constant is pure', () => {
  const K = nodeId('const_factor');
  const graph = graphAt(2, [
    migration(1, [
      transformField(nodeId('op1'), E_ORDER, F_ORDER_TOTAL, {
        fromType: primitiveType('number'),
        toType: primitiveType('number'),
        expression: call('sum', field(ref(MIGRATION_OLD_SCOPE), F_ORDER_TOTAL), ref(K)),
        constants: [{ id: K, value: 100 }],
      }),
    ]),
  ]);
  assert.ok(!codes(graph).includes(VALIDATION_CODES.migrationTransformImpure));
});

test('transform-field toType mismatch with the target field type is MIGRATION_TRANSFORM_TYPE_MISMATCH', () => {
  const graph = graphAt(2, [
    migration(1, [
      transformField(nodeId('op1'), E_ORDER, F_ORDER_TOTAL, {
        fromType: primitiveType('string'),
        toType: primitiveType('string'), // field is number in the target graph
        expression: field(ref(MIGRATION_OLD_SCOPE), F_ORDER_TOTAL),
      }),
    ]),
  ]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.migrationTransformTypeMismatch));
});

test('transform-record.produce that is not an object expression is INVALID_MIGRATION_OPERATION', () => {
  const graph = graphAt(2, [
    migration(1, [
      { id: nodeId('op1'), kind: 'transform-record', entityId: E_ORDER, produce: literal('nope') } as MigrationOperation,
    ]),
  ]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidMigrationOperation));
});

test('change-field that changes nothing is INVALID_MIGRATION_OPERATION', () => {
  const graph = graphAt(2, [
    migration(1, [changeField(nodeId('op1'), E_ORDER, F_ORDER_TOTAL, {})]),
  ]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidMigrationOperation));
});

test('two operations with the same id is DUPLICATE_MIGRATION_OPERATION_ID', () => {
  const graph = graphAt(3, [
    migration(1, [changeField(nodeId('dup'), E_ORDER, F_ORDER_TOTAL, { required: true })]),
    migration(2, [changeField(nodeId('dup'), E_ORDER, F_ORDER_TOTAL, { required: false })]),
  ]);
  assert.ok(codes(graph).includes(VALIDATION_CODES.duplicateMigrationOperationId));
});

test('a graph that declares schemaVersion > 1 with no migrations is MIGRATION_PATH_NOT_FOUND', () => {
  const graph = graphAt(3, []);
  assert.ok(codes(graph).includes(VALIDATION_CODES.migrationPathNotFound));
});

test('the default schema-1 graph with no migrations still validates', () => {
  const graph = graphAt(1, []);
  assert.deepEqual(validateGraph(graph).errors, []);
});
