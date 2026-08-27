import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  MIGRATION_OLD_SCOPE,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
} from '@cynodia/axiom-core';
import type { EntityDef, LiteralValue, MigrationDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  MIGRATION_DIAGNOSTIC_CODES,
  MigrationCrash,
  createMemoryMigrationStore,
  planMigration,
  runMigration,
} from '@cynodia/axiom-server';
import type { MigrationDataset } from '@cynodia/axiom-server';

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_NOTE = fieldId('field_order_note');
const F_LEGACY = fieldId('field_order_legacy');

function build(targetVersion: number, migrations: MigrationDef[], targetFields: EntityDef['fields']) {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.setSchemaVersion(targetVersion);
  graph.addNode<EntityDef>({
    id: E,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: targetFields,
  });
  graph.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  for (const migration of migrations) graph.addNode<MigrationDef>(migration);
  return compileToServerIR(graph, { validate: false });
}

function dataset(rows: Array<Record<string, LiteralValue>>): MigrationDataset {
  return { rows: new Map([[String(E), rows.map((row) => ({ ...row }))]]) };
}

function orderRows(n: number): Array<Record<string, LiteralValue>> {
  return Array.from({ length: n }, (_, i) => ({
    [String(F_ID)]: `order-${String(i).padStart(4, '0')}`,
    [String(F_TOTAL)]: i,
  }));
}

const ADD_STATUS: MigrationDef = {
  id: nodeId('m_1_2'),
  kind: 'migration',
  fromSchema: 1,
  toSchema: 2,
  operations: [
    {
      id: nodeId('op_add_status'),
      kind: 'add-field',
      entityId: E,
      field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
      populate: literal('draft'),
    },
  ],
};

const TARGET_V2: EntityDef['fields'] = [
  { id: F_ID, valueType: primitiveType('string') },
  { id: F_TOTAL, valueType: primitiveType('number') },
  { id: F_STATUS, valueType: primitiveType('string'), required: true },
];

test('a batched add-field+populate migration fills every row and commits the version', async () => {
  const ir = build(2, [ADD_STATUS], TARGET_V2);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const data = dataset(orderRows(1250));
  const store = createMemoryMigrationStore({ now: () => 1 });

  const result = await runMigration(ir, planned.plan, store, data, {
    holder: 'server-A',
    batchSize: 100,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.phase, 'completed');
  assert.equal(result.rowsTransformed, 1250);
  assert.equal(result.alreadyAtTarget, false);

  const rows = data.rows.get(String(E))!;
  assert.ok(rows.every((row) => row[String(F_STATUS)] === 'draft'));
  assert.equal((await store.readSchema())?.schemaVersion, 2);
  assert.equal((await store.readCheckpoint()), null);
  assert.equal((await store.readLock()), null);
  assert.equal((await store.readSchema())?.history.length, 1);
});

test('re-running a completed migration is a no-op (spec11 §35)', async () => {
  const ir = build(2, [ADD_STATUS], TARGET_V2);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const data = dataset(orderRows(10));
  const store = createMemoryMigrationStore({ now: () => 1 });
  await runMigration(ir, planned.plan, store, data, { holder: 'A' });

  const second = await runMigration(ir, planned.plan, store, data, { holder: 'A' });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.alreadyAtTarget, true);
    assert.equal(second.rowsTransformed, 0);
  }
});

test('a crash mid-transform resumes to the same target as an uninterrupted run (spec11 §32, §120)', async () => {
  const ir = build(2, [ADD_STATUS], TARGET_V2);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);

  // Reference: an uninterrupted run.
  const clean = dataset(orderRows(1000));
  const cleanStore = createMemoryMigrationStore({ now: () => 1 });
  await runMigration(ir, planned.plan, cleanStore, clean, { holder: 'A', batchSize: 100 });

  // Crash after the third batch (300 rows), then resume.
  const crashed = dataset(orderRows(1000));
  const store = createMemoryMigrationStore({ now: () => 1 });
  await assert.rejects(
    runMigration(ir, planned.plan, store, crashed, {
      holder: 'A',
      batchSize: 100,
      crashAfter: ({ rowsProcessed }) => rowsProcessed === 300,
    }),
    MigrationCrash,
  );
  // Checkpoint survived; version not committed.
  assert.notEqual(await store.readCheckpoint(), null);
  assert.equal(await store.readSchema(), null);

  const resume = await runMigration(ir, planned.plan, store, crashed, { holder: 'A', batchSize: 100 });
  assert.equal(resume.ok, true);
  if (resume.ok) assert.equal(resume.resumed, true);

  assert.deepEqual(
    crashed.rows.get(String(E)),
    clean.rows.get(String(E)),
    'resumed dataset equals the uninterrupted one',
  );
  assert.equal((await store.readSchema())?.schemaVersion, 2);
});

test('a destructive migration without approval performs zero writes (spec11 §21, §106)', async () => {
  const migration: MigrationDef = {
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      { id: nodeId('op_drop'), kind: 'remove-field', entityId: E, fieldId: F_LEGACY, destructive: true },
    ],
  };
  const ir = build(2, [migration], [
    { id: F_ID, valueType: primitiveType('string') },
    { id: F_TOTAL, valueType: primitiveType('number') },
  ]);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const rows = orderRows(5).map((row) => ({ ...row, [String(F_LEGACY)]: 'x' }));
  const data = dataset(rows);
  const store = createMemoryMigrationStore({ now: () => 1 });

  const refused = await runMigration(ir, planned.plan, store, data, { holder: 'A' });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, MIGRATION_DIAGNOSTIC_CODES.MIGRATION_APPROVAL_REQUIRED);
  assert.ok(data.rows.get(String(E))!.every((row) => row[String(F_LEGACY)] === 'x'), 'no field dropped');
  assert.equal(await store.readSchema(), null);
  assert.equal(await store.readLock(), null);

  const approved = await runMigration(ir, planned.plan, store, data, {
    holder: 'A',
    approveDestructive: [String(nodeId('op_drop'))],
  });
  assert.equal(approved.ok, true);
  assert.ok(data.rows.get(String(E))!.every((row) => !(String(F_LEGACY) in row)));
});

test('a transform producing an invalid target record fails without committing (spec11 §105)', async () => {
  const migration: MigrationDef = {
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      {
        id: nodeId('op_bad'),
        kind: 'add-field',
        entityId: E,
        field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
        // coalesce(null, null) -> null, which cannot satisfy a required field
        populate: { kind: 'call', function: 'coalesce', arguments: [literal(null), literal(null)] },
      },
    ],
  };
  const ir = build(2, [migration], TARGET_V2);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const data = dataset(orderRows(3));
  const store = createMemoryMigrationStore({ now: () => 1 });

  const result = await runMigration(ir, planned.plan, store, data, { holder: 'A' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, MIGRATION_DIAGNOSTIC_CODES.MIGRATION_VALIDATION_FAILED);
  assert.equal(await store.readSchema(), null, 'target version not committed');
});

test('the migration lock refuses a second concurrent runner (spec11 §66, §102)', async () => {
  const ir = build(2, [ADD_STATUS], TARGET_V2);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const store = createMemoryMigrationStore({ now: () => 0 });

  // Hold the lock as if instance A were mid-migration.
  const held = await store.acquireLock('server-A', 60_000);
  assert.equal(held.ok, true);

  const b = await runMigration(ir, planned.plan, store, dataset(orderRows(2)), { holder: 'server-B' });
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.code, MIGRATION_DIAGNOSTIC_CODES.MIGRATION_IN_PROGRESS);
});

test('a record transform reshapes each row deterministically', async () => {
  const F_GROSS = fieldId('field_order_gross');
  const migration: MigrationDef = {
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      {
        id: nodeId('op_reshape'),
        kind: 'transform-record',
        entityId: E,
        produce: {
          kind: 'object',
          entries: [
            {
              fieldId: F_GROSS,
              value: binary('multiply', field(ref(MIGRATION_OLD_SCOPE), F_TOTAL), literal(1.25)),
            },
          ],
        },
        removesFields: [F_TOTAL],
      },
    ],
  };
  const ir = build(2, [migration], [
    { id: F_ID, valueType: primitiveType('string') },
    { id: F_GROSS, valueType: primitiveType('number') },
  ]);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const data = dataset([{ [String(F_ID)]: 'o1', [String(F_TOTAL)]: 80 }]);
  const store = createMemoryMigrationStore({ now: () => 1 });

  // removesFields drops `total`, so the record transform is destructive and needs approval.
  assert.equal(planned.plan.hasDataLoss, true);
  const result = await runMigration(ir, planned.plan, store, data, {
    holder: 'A',
    approveDestructive: [String(nodeId('op_reshape'))],
  });
  assert.equal(result.ok, true);
  const row = data.rows.get(String(E))![0];
  assert.equal(row[String(F_GROSS)], 100);
  assert.equal(String(F_TOTAL) in row, false);
});
