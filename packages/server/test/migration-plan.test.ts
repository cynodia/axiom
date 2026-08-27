import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  collectionType,
  entityType,
  fieldId,
  literal,
  nodeId,
  primitiveType,
} from '@cynodia/axiom-core';
import type { EntityDef, MigrationDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  MIGRATION_DIAGNOSTIC_CODES,
  MIGRATION_PHASES,
  MIGRATION_PROVIDER_CAPABILITIES,
  explainMigration,
  migrationProviderCapabilitiesRequired,
  planMigration,
} from '@cynodia/axiom-server';

const E_ORDER = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_LEGACY = fieldId('field_order_legacy');

function irAtVersion(version: number, migrations: MigrationDef[], extraFields: EntityDef['fields'] = []) {
  const graph = new ApplicationGraph('app', 'App', '0.11.0');
  graph.setSchemaVersion(version);
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string') },
      { id: F_TOTAL, valueType: primitiveType('number') },
      ...extraFields,
    ],
  });
  graph.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType(entityType(E_ORDER)),
    authority: 'server',
  });
  for (const migration of migrations) {
    graph.addNode<MigrationDef>(migration);
  }
  return compileToServerIR(graph, { validate: false });
}

test('MIGRATION_PHASES and MIGRATION_PROVIDER_CAPABILITIES enumerate the vocabulary', () => {
  assert.deepEqual([...MIGRATION_PHASES], [
    'planned',
    'approved',
    'running',
    'checkpointed',
    'validating',
    'completed',
    'failed',
  ]);
  assert.equal(MIGRATION_PROVIDER_CAPABILITIES.length, 6);
});

test('planMigration on an equal version yields an empty plan', () => {
  const ir = irAtVersion(1, []);
  const result = planMigration(ir, { fromVersion: 1 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.steps.length, 0);
    assert.equal(result.plan.hasDataLoss, false);
  }
});

test('planMigration resolves a contiguous chain and reports affected entities/fields', () => {
  const migrations: MigrationDef[] = [
    {
      id: nodeId('m_1_2'),
      kind: 'migration',
      fromSchema: 1,
      toSchema: 2,
      operations: [
        {
          id: nodeId('op_add_status'),
          kind: 'add-field',
          entityId: E_ORDER,
          field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
          populate: literal('draft'),
        },
      ],
    },
  ];
  const ir = irAtVersion(2, migrations, [
    { id: F_STATUS, valueType: primitiveType('string'), required: true },
  ]);
  const result = planMigration(ir, { fromVersion: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.fromVersion, 1);
  assert.equal(result.plan.toVersion, 2);
  assert.equal(result.plan.steps.length, 1);
  assert.equal(result.plan.operationCount, 1);
  assert.deepEqual(result.plan.affectedEntities, [String(E_ORDER)]);
  assert.deepEqual(result.plan.affectedFields, [String(F_STATUS)]);
  assert.equal(result.plan.hasDataLoss, false);
  assert.equal(result.plan.transformations.length, 1);
  assert.ok(result.plan.providerCapabilitiesRequired.includes('batched-transform'));
  assert.ok(result.plan.providerCapabilitiesRequired.includes('checkpointing'));
});

test('planMigration flags destructive operations and sets hasDataLoss', () => {
  const migrations: MigrationDef[] = [
    {
      id: nodeId('m_1_2'),
      kind: 'migration',
      fromSchema: 1,
      toSchema: 2,
      operations: [
        {
          id: nodeId('op_drop_legacy'),
          kind: 'remove-field',
          entityId: E_ORDER,
          fieldId: F_LEGACY,
          destructive: true,
        },
      ],
    },
  ];
  const ir = irAtVersion(2, migrations);
  const result = planMigration(ir, { fromVersion: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.hasDataLoss, true);
  assert.equal(result.plan.destructive.length, 1);
  assert.equal(result.plan.destructive[0].operationId, String(nodeId('op_drop_legacy')));
  assert.equal(result.plan.providerCapabilitiesRequired.includes('atomic-schema-change'), true);
});

test('planMigration refuses a gap with MIGRATION_PATH_NOT_FOUND', () => {
  const migrations: MigrationDef[] = [
    { id: nodeId('m_1_2'), kind: 'migration', fromSchema: 1, toSchema: 2, operations: [] },
    { id: nodeId('m_3_4'), kind: 'migration', fromSchema: 3, toSchema: 4, operations: [] },
  ];
  const ir = irAtVersion(4, migrations);
  const result = planMigration(ir, { fromVersion: 1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.diagnostics[0].code, MIGRATION_DIAGNOSTIC_CODES.MIGRATION_PATH_NOT_FOUND);
});

test('planMigration refuses a persisted version ahead of the graph with SCHEMA_INCOMPATIBLE', () => {
  const ir = irAtVersion(2, [
    { id: nodeId('m_1_2'), kind: 'migration', fromSchema: 1, toSchema: 2, operations: [] },
  ]);
  const result = planMigration(ir, { fromVersion: 5 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.diagnostics[0].code, MIGRATION_DIAGNOSTIC_CODES.SCHEMA_INCOMPATIBLE);
});

test('explainMigration renders a step-by-step account naming destructive steps', () => {
  const migrations: MigrationDef[] = [
    {
      id: nodeId('m_1_2'),
      kind: 'migration',
      fromSchema: 1,
      toSchema: 2,
      operations: [
        {
          id: nodeId('op_add_status'),
          kind: 'add-field',
          entityId: E_ORDER,
          field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
          populate: literal('draft'),
        },
      ],
    },
    {
      id: nodeId('m_2_3'),
      kind: 'migration',
      fromSchema: 2,
      toSchema: 3,
      operations: [
        { id: nodeId('op_drop'), kind: 'remove-field', entityId: E_ORDER, fieldId: F_LEGACY, destructive: true },
      ],
    },
  ];
  const ir = irAtVersion(3, migrations, [
    { id: F_STATUS, valueType: primitiveType('string'), required: true },
  ]);
  const result = planMigration(ir, { fromVersion: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = explainMigration(result.plan);
  assert.match(text, /Current schema: 1/);
  assert.match(text, /Target schema:  3/);
  assert.match(text, /1 → 2/);
  assert.match(text, /2 → 3/);
  assert.match(text, /DESTRUCTIVE — explicit approval required/);
  assert.match(text, /Non-destructive/);
});

test('migrationProviderCapabilitiesRequired separates transforms from schema changes', () => {
  assert.deepEqual(
    migrationProviderCapabilitiesRequired([
      { id: nodeId('a'), kind: 'add-field', entityId: E_ORDER, field: { id: F_STATUS, valueType: primitiveType('string') } },
    ]),
    ['atomic-schema-change'],
  );
  assert.deepEqual(
    migrationProviderCapabilitiesRequired([
      {
        id: nodeId('b'),
        kind: 'transform-field',
        entityId: E_ORDER,
        fieldId: F_TOTAL,
        fromType: primitiveType('string'),
        toType: primitiveType('number'),
        expression: literal(0),
      },
    ]).sort(),
    ['batched-transform', 'checkpointing'],
  );
});
