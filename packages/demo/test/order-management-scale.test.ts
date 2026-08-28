import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  MIGRATION_OLD_SCOPE,
  call,
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
import { createMemoryMigrationStore, planMigration, runMigration } from '@cynodia/axiom-server';
import type { MigrationRowStore } from '@cynodia/axiom-server';

const E_ORDER = nodeId('entity_order');
const E_LINE = nodeId('entity_order_line');
const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_TAG = fieldId('field_order_tag');
const F_LINE_ID = fieldId('field_line_id');
const F_LINE_TAG = fieldId('field_line_tag');

const ORDERS = 500_000;
const LINES = 2_000_000;
const BATCH = 1_000;

function scaleIr() {
  const graph = new ApplicationGraph('order-management', 'Order Management', '0.11.0');
  graph.setSchemaVersion(2);
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string') },
      { id: F_ORDER_TAG, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: E_LINE,
    kind: 'entity',
    identityFieldId: F_LINE_ID,
    fields: [
      { id: F_LINE_ID, valueType: primitiveType('string') },
      { id: F_LINE_TAG, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<StateDef>({ id: nodeId('s_o'), kind: 'state', valueType: collectionType(entityType(E_ORDER)), authority: 'server' });
  graph.addNode<StateDef>({ id: nodeId('s_l'), kind: 'state', valueType: collectionType(entityType(E_LINE)), authority: 'server' });
  graph.addNode<MigrationDef>({
    id: nodeId('migration_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      {
        id: nodeId('op_tag_orders'),
        kind: 'add-field',
        entityId: E_ORDER,
        field: { id: F_ORDER_TAG, valueType: primitiveType('string'), required: true },
        populate: call('concat', literal('tag:'), field(ref(MIGRATION_OLD_SCOPE), F_ORDER_ID)),
      },
      {
        id: nodeId('op_tag_lines'),
        kind: 'add-field',
        entityId: E_LINE,
        field: { id: F_LINE_TAG, valueType: primitiveType('string'), required: true },
        populate: call('concat', literal('tag:'), field(ref(MIGRATION_OLD_SCOPE), F_LINE_ID)),
      },
    ],
  });
  return compileToServerIR(graph, { validate: false });
}

/**
 * A row store that **generates** rows on demand and never keeps them — the only way a
 * migration over millions of rows can run in bounded memory (spec11 §29, §100). It records
 * the largest batch it was ever asked to hold and a checksum of what was written back, so
 * correctness and boundedness are both observable without materialising the table.
 */
function generatorRowStore(counts: Record<string, number>): MigrationRowStore & {
  peakBatch: number;
  writtenCount: number;
  taggedCorrectly: boolean;
} {
  const state = { peakBatch: 0, writtenCount: 0, taggedCorrectly: true };
  const indexOf = (identity: LiteralValue, entityId: string): number => {
    const prefix = entityId === String(E_ORDER) ? 'order-' : 'line-';
    return identity === null ? -1 : Number(String(identity).slice(prefix.length));
  };
  const idAt = (entityId: string, i: number): string =>
    `${entityId === String(E_ORDER) ? 'order-' : 'line-'}${String(i).padStart(9, '0')}`;
  const idField = (entityId: string): string =>
    entityId === String(E_ORDER) ? String(F_ORDER_ID) : String(F_LINE_ID);

  return {
    ...state,
    get peakBatch() {
      return state.peakBatch;
    },
    get writtenCount() {
      return state.writtenCount;
    },
    get taggedCorrectly() {
      return state.taggedCorrectly;
    },
    async addEntity() {},
    async removeEntity() {},
    async addColumn() {},
    async dropColumn() {},
    async countRows(entityId) {
      return counts[entityId] ?? 0;
    },
    async readBatch(entityId, identityField, afterIdentity, limit) {
      const total = counts[entityId] ?? 0;
      const start = afterIdentity === null ? 0 : indexOf(afterIdentity, entityId) + 1;
      const end = Math.min(start + limit, total);
      const rows: Array<Record<string, LiteralValue>> = [];
      for (let i = start; i < end; i += 1) {
        rows.push({ [identityField]: idAt(entityId, i) });
      }
      state.peakBatch = Math.max(state.peakBatch, rows.length);
      return rows;
    },
    async writeBatch(entityId, _identityField, updates) {
      const tagField = entityId === String(E_ORDER) ? String(F_ORDER_TAG) : String(F_LINE_TAG);
      for (const update of updates) {
        state.writtenCount += 1;
        if (update.values[tagField] !== `tag:${String(update.identity)}`) {
          state.taggedCorrectly = false;
        }
      }
    },
    async requiredFieldViolation() {
      // The generator's write path guarantees every row got a non-null tag.
      return null;
    },
  } as MigrationRowStore & { peakBatch: number; writtenCount: number; taggedCorrectly: boolean };
}

test('a migration over 500k orders / 2M lines runs in bounded memory (spec11 §100, M1)', async () => {
  const ir = scaleIr();
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const store = generatorRowStore({ [String(E_ORDER)]: ORDERS, [String(E_LINE)]: LINES });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 's1', history: [], updatedAt: 0 },
    now: () => 1,
  });

  const run = await runMigration(ir, planned.plan, metadata, store, { holder: 'scale', batchSize: BATCH });
  assert.equal(run.ok, true, run.ok ? '' : run.message);
  if (!run.ok) return;

  assert.equal(run.rowsTransformed, ORDERS + LINES);
  assert.equal(store.writtenCount, ORDERS + LINES, 'every row was written back exactly once');
  assert.equal(store.taggedCorrectly, true, 'every row got the derived tag');
  assert.equal(store.peakBatch, BATCH, 'the executor never held more than one batch of rows at a time');
  assert.equal((await metadata.readSchema())?.schemaVersion, 2);
});
