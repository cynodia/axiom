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
  planMigration,
  runMigration,
} from '@cynodia/axiom-server';
import type { MigrationDataset } from '@cynodia/axiom-server';

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_GROSS = fieldId('field_order_gross');
const F_NOTE = fieldId('field_order_note');

// A three-operation migration: a populated add-field (batched), a field transform (batched),
// and a bare add-field (schema only) — so a resume can be interrupted at many boundaries.
const MIGRATION: MigrationDef = {
  id: nodeId('m_1_2'),
  kind: 'migration',
  fromSchema: 1,
  toSchema: 2,
  operations: [
    {
      id: nodeId('op_status'),
      kind: 'add-field',
      entityId: E,
      field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
      populate: literal('draft'),
    },
    {
      id: nodeId('op_gross'),
      kind: 'transform-field',
      entityId: E,
      fieldId: F_TOTAL,
      fromType: primitiveType('number'),
      toType: primitiveType('number'),
      expression: binary('multiply', field(ref(MIGRATION_OLD_SCOPE), F_TOTAL), literal(2)),
    },
    { id: nodeId('op_note'), kind: 'add-field', entityId: E, field: { id: F_NOTE, valueType: primitiveType('string') } },
  ],
};

function ir() {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.setSchemaVersion(2);
  graph.addNode<EntityDef>({
    id: E,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string') },
      { id: F_TOTAL, valueType: primitiveType('number') },
      { id: F_STATUS, valueType: primitiveType('string'), required: true },
      { id: F_NOTE, valueType: primitiveType('string') },
    ],
  });
  graph.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  graph.addNode<MigrationDef>(MIGRATION);
  return compileToServerIR(graph, { validate: false });
}

function makeRows(n: number): Array<Record<string, LiteralValue>> {
  return Array.from({ length: n }, (_, i) => ({
    [String(F_ID)]: `order-${String(i).padStart(3, '0')}`,
    [String(F_TOTAL)]: i,
  }));
}
function dataset(n: number): MigrationDataset {
  return { rows: new Map([[String(E), makeRows(n)]]) };
}

test('crash matrix: a crash at every checkpoint boundary resumes to the uninterrupted result (spec11 §101)', async () => {
  const document = ir();
  const planned = planMigration(document, { fromVersion: 1 });
  assert.ok(planned.ok);
  const ROWS = 100;
  const BATCH = 15;

  // 1. A recorder run: never crash, but capture every checkpoint boundary the executor hits.
  const boundaries: Array<{ operationIndex: number; rowsProcessed: number; phase: string }> = [];
  const cleanData = dataset(ROWS);
  const cleanStore = createMemoryMigrationStore({ now: () => 1 });
  const cleanResult = await runMigration(document, planned.plan, cleanStore, createMemoryRowStore(cleanData), {
    holder: 'A',
    batchSize: BATCH,
    crashAfter: (info) => {
      boundaries.push({ ...info });
      return false;
    },
  });
  assert.equal(cleanResult.ok, true);
  const expected = JSON.stringify(cleanData.rows.get(String(E)));
  assert.ok(boundaries.length >= 10, `expected many checkpoint boundaries, got ${boundaries.length}`);

  // 2. For each boundary: fresh state, crash exactly there, then resume, assert equality.
  for (const boundary of boundaries) {
    const data = dataset(ROWS);
    const store = createMemoryMigrationStore({ now: () => 1 });
    let sawCrash = 0;

    await assert.rejects(
      runMigration(document, planned.plan, store, createMemoryRowStore(data), {
        holder: 'A',
        batchSize: BATCH,
        crashAfter: (info) =>
          info.operationIndex === boundary.operationIndex &&
          info.rowsProcessed === boundary.rowsProcessed &&
          info.phase === boundary.phase &&
          ++sawCrash === 1,
      }),
      MigrationCrash,
      `crash at ${JSON.stringify(boundary)}`,
    );
    assert.equal(await store.readSchema().then((r) => r?.schemaVersion ?? null), null, 'version not committed at crash');

    // Restart: a fresh runMigration call resumes from the durable checkpoint.
    const resumed = await runMigration(document, planned.plan, store, createMemoryRowStore(data), {
      holder: 'A',
      batchSize: BATCH,
    });
    assert.equal(resumed.ok, true, `resume after ${JSON.stringify(boundary)}`);
    if (resumed.ok) assert.equal(resumed.resumed, true);
    assert.equal(
      JSON.stringify(data.rows.get(String(E))),
      expected,
      `resumed data after crash at ${JSON.stringify(boundary)} equals the uninterrupted run`,
    );
    assert.equal((await store.readSchema())?.schemaVersion, 2);
  }
});

test('crash matrix: repeated crash-and-resume still converges (double interruption)', async () => {
  const document = ir();
  const planned = planMigration(document, { fromVersion: 1 });
  assert.ok(planned.ok);
  const data = dataset(60);
  const store = createMemoryMigrationStore({ now: () => 1 });

  // Crash on the first transform batch.
  await assert.rejects(
    runMigration(document, planned.plan, store, createMemoryRowStore(data), {
      holder: 'A',
      batchSize: 10,
      crashAfter: ({ operationIndex, rowsProcessed }) => operationIndex === 0 && rowsProcessed === 20,
    }),
    MigrationCrash,
  );
  // Crash again mid-resume, on the second operation this time.
  await assert.rejects(
    runMigration(document, planned.plan, store, createMemoryRowStore(data), {
      holder: 'A',
      batchSize: 10,
      crashAfter: ({ operationIndex, rowsProcessed }) => operationIndex === 1 && rowsProcessed === 30,
    }),
    MigrationCrash,
  );
  // Finally let it finish.
  const done = await runMigration(document, planned.plan, store, createMemoryRowStore(data), {
    holder: 'A',
    batchSize: 10,
  });
  assert.equal(done.ok, true);
  const rows = data.rows.get(String(E))!;
  assert.equal(rows.length, 60);
  assert.ok(rows.every((row) => row[String(F_STATUS)] === 'draft'));
  rows.forEach((row, i) => assert.equal(row[String(F_TOTAL)], i * 2, `row ${i} transformed exactly once`));
  assert.equal((await store.readSchema())?.schemaVersion, 2);
});
