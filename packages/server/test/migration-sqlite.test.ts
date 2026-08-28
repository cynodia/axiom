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
  MigrationCrash,
  createMemoryMigrationStore,
  createMemoryRowStore,
  createSqliteMigrationStore,
  createSqliteRowStore,
  isSqliteMigrationAvailable,
  planMigration,
  runMigration,
} from '@cynodia/axiom-server';
import type { MigrationDataset } from '@cynodia/axiom-server';

const available = await isSqliteMigrationAvailable();

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_GROSS = fieldId('field_order_gross');

function buildIr(targetFields: EntityDef['fields'], migrations: MigrationDef[]) {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.setSchemaVersion(2);
  graph.addNode<EntityDef>({ id: E, kind: 'entity', identityFieldId: F_ID, fields: targetFields });
  graph.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  for (const migration of migrations) graph.addNode<MigrationDef>(migration);
  return compileToServerIR(graph, { validate: false });
}

function seedRows(n: number): Array<Record<string, LiteralValue>> {
  return Array.from({ length: n }, (_, i) => ({
    [String(F_ID)]: `order-${String(i).padStart(4, '0')}`,
    [String(F_TOTAL)]: i * 2,
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
const V2_FIELDS: EntityDef['fields'] = [
  { id: F_ID, valueType: primitiveType('string') },
  { id: F_TOTAL, valueType: primitiveType('number') },
  { id: F_STATUS, valueType: primitiveType('string'), required: true },
];

test('SQLite migration: add-field+populate over a real ALTER TABLE, batched', { skip: !available }, async () => {
  const ir = buildIr(V2_FIELDS, [ADD_STATUS]);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);

  const rowStore = await createSqliteRowStore({ location: ':memory:', ir, seed: { [String(E)]: seedRows(700) } });
  const meta = await createSqliteMigrationStore({ location: ':memory:', now: () => 1 });

  const result = await runMigration(ir, planned.plan, meta, rowStore, { holder: 'A', batchSize: 100 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.rowsTransformed, 700);

  const rows = rowStore.snapshot(String(E));
  assert.equal(rows.length, 700);
  assert.ok(rows.every((row) => row[String(F_STATUS)] === 'draft'));
  assert.equal((await meta.readSchema())?.schemaVersion, 2);
  assert.equal(await meta.readCheckpoint(), null);
});

test('memory and SQLite derive equivalent target data from the same plan (spec11 §83, §121)', { skip: !available }, async () => {
  const ir = buildIr(V2_FIELDS, [ADD_STATUS]);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const seed = seedRows(450);

  // memory
  const dataset: MigrationDataset = { rows: new Map([[String(E), seed.map((row) => ({ ...row }))]]) };
  const memMeta = createMemoryMigrationStore({ now: () => 1 });
  await runMigration(ir, planned.plan, memMeta, createMemoryRowStore(dataset), { holder: 'A', batchSize: 64 });

  // SQLite
  const rowStore = await createSqliteRowStore({ location: ':memory:', ir, seed: { [String(E)]: seed } });
  const sqlMeta = await createSqliteMigrationStore({ location: ':memory:', now: () => 1 });
  await runMigration(ir, planned.plan, sqlMeta, rowStore, { holder: 'A', batchSize: 64 });

  const memRows = [...(dataset.rows.get(String(E)) ?? [])].sort((a, b) =>
    String(a[String(F_ID)]).localeCompare(String(b[String(F_ID)])),
  );
  const sqlRows = rowStore.snapshot(String(E)).sort((a, b) =>
    String(a[String(F_ID)]).localeCompare(String(b[String(F_ID)])),
  );
  assert.deepEqual(sqlRows, memRows);
  assert.equal((await memMeta.readSchema())?.schemaVersion, (await sqlMeta.readSchema())?.schemaVersion);
});

test('SQLite migration: a record transform adds and drops real columns', { skip: !available }, async () => {
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
              value: binary('multiply', field(ref(MIGRATION_OLD_SCOPE), F_TOTAL), literal(1.5)),
            },
          ],
        },
        addsFields: [F_GROSS],
        removesFields: [F_TOTAL],
      },
    ],
  };
  const ir = buildIr(
    [
      { id: F_ID, valueType: primitiveType('string') },
      { id: F_GROSS, valueType: primitiveType('number') },
    ],
    [migration],
  );
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);

  const rowStore = await createSqliteRowStore({
    location: ':memory:',
    ir,
    seed: { [String(E)]: [{ [String(F_ID)]: 'o1', [String(F_TOTAL)]: 10 }] },
  });
  const meta = await createSqliteMigrationStore({ location: ':memory:', now: () => 1 });
  const result = await runMigration(ir, planned.plan, meta, rowStore, {
    holder: 'A',
    approveDestructive: [String(nodeId('op_reshape'))],
  });
  assert.equal(result.ok, true);

  const [row] = rowStore.snapshot(String(E));
  assert.equal(row[String(F_GROSS)], 15);
  assert.equal(String(F_TOTAL) in row, false, 'the total column was dropped');
});

test('SQLite migration: crash mid-transform resumes to the uninterrupted result', { skip: !available }, async () => {
  const ir = buildIr(V2_FIELDS, [ADD_STATUS]);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);

  const cleanStore = await createSqliteRowStore({ location: ':memory:', ir, seed: { [String(E)]: seedRows(500) } });
  const cleanMeta = await createSqliteMigrationStore({ location: ':memory:', now: () => 1 });
  await runMigration(ir, planned.plan, cleanMeta, cleanStore, { holder: 'A', batchSize: 100 });

  const store = await createSqliteRowStore({ location: ':memory:', ir, seed: { [String(E)]: seedRows(500) } });
  const meta = await createSqliteMigrationStore({ location: ':memory:', now: () => 1 });
  await assert.rejects(
    runMigration(ir, planned.plan, meta, store, {
      holder: 'A',
      batchSize: 100,
      crashAfter: ({ rowsProcessed }) => rowsProcessed === 200,
    }),
    MigrationCrash,
  );
  assert.notEqual(await meta.readCheckpoint(), null);
  assert.equal(await meta.readSchema(), null);

  const resume = await runMigration(ir, planned.plan, meta, store, { holder: 'A', batchSize: 100 });
  assert.equal(resume.ok, true);
  if (resume.ok) assert.equal(resume.resumed, true);

  assert.deepEqual(store.snapshot(String(E)), cleanStore.snapshot(String(E)));
  assert.equal((await meta.readSchema())?.schemaVersion, 2);
});

test('SQLite migration lock: a second concurrent runner is refused', { skip: !available }, async () => {
  const ir = buildIr(V2_FIELDS, [ADD_STATUS]);
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const meta = await createSqliteMigrationStore({ location: ':memory:', now: () => 0 });
  const rowStore = await createSqliteRowStore({ location: ':memory:', ir, seed: { [String(E)]: seedRows(3) } });

  const held = await meta.acquireLock('server-A', 60_000);
  assert.equal(held.ok, true);
  const b = await runMigration(ir, planned.plan, meta, rowStore, { holder: 'server-B' });
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.code, 'MIGRATION_IN_PROGRESS');
});
