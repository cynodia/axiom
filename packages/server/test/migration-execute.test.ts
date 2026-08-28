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
import type { EntityDef, LiteralValue, MigrationDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createMemoryMigrationStore,
  executeMigration,
  getMigrationStatus,
  migrationAuthority,
} from '@cynodia/axiom-server';
import type { MigrationDataset } from '@cynodia/axiom-server';

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_LEGACY = fieldId('field_order_legacy');

function ir(targetFields: EntityDef['fields'], migrations: MigrationDef[]) {
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

function dataset(rows: Array<Record<string, LiteralValue>>): MigrationDataset {
  return { rows: new Map([[String(E), rows.map((row) => ({ ...row }))]]) };
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
const V2: EntityDef['fields'] = [
  { id: F_ID, valueType: primitiveType('string') },
  { id: F_TOTAL, valueType: primitiveType('number') },
  { id: F_STATUS, valueType: primitiveType('string'), required: true },
];

test('executeMigration refuses without host-minted migration authority (spec11 §73)', async () => {
  const document = ir(V2, [ADD_STATUS]);
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const result = await executeMigration({
    ir: document,
    metadata,
    rows: dataset([{ [String(F_ID)]: 'o1', [String(F_TOTAL)]: 1 }]),
    // deliberately not a MigrationPrincipal
    principal: { role: 'admin' } as never,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'MIGRATION_NOT_AUTHORIZED');
});

test('executeMigration plans and runs, and the gate then reports compatible', async () => {
  const document = ir(V2, [ADD_STATUS]);
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const data = dataset(
    Array.from({ length: 20 }, (_, i) => ({ [String(F_ID)]: `o${i}`, [String(F_TOTAL)]: i })),
  );
  const result = await executeMigration({
    ir: document,
    metadata,
    rows: data,
    principal: migrationAuthority('operator-42'),
    batchSize: 5,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.run.rowsTransformed, 20);
  assert.equal(result.gate.status, 'compatible');
  assert.ok(data.rows.get(String(E))!.every((row) => row[String(F_STATUS)] === 'draft'));
  assert.equal((await metadata.readSchema())?.schemaVersion, 2);
});

test('executeMigration refuses a destructive plan without approval, then runs with it', async () => {
  const migration: MigrationDef = {
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      { id: nodeId('op_drop'), kind: 'remove-field', entityId: E, fieldId: F_LEGACY, destructive: true },
    ],
  };
  const document = ir(
    [
      { id: F_ID, valueType: primitiveType('string') },
      { id: F_TOTAL, valueType: primitiveType('number') },
    ],
    [migration],
  );
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const rows = [{ [String(F_ID)]: 'o1', [String(F_TOTAL)]: 1, [String(F_LEGACY)]: 'keep-me' }];
  const data = dataset(rows);

  const refused = await executeMigration({
    ir: document,
    metadata,
    rows: data,
    principal: migrationAuthority('op'),
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, 'MIGRATION_APPROVAL_REQUIRED');
  assert.equal(data.rows.get(String(E))![0][String(F_LEGACY)], 'keep-me');
  assert.equal((await metadata.readSchema())?.schemaVersion, 1);

  const approved = await executeMigration({
    ir: document,
    metadata,
    rows: data,
    principal: migrationAuthority('op'),
    approveDestructive: [String(nodeId('op_drop'))],
  });
  assert.equal(approved.ok, true);
  assert.equal(String(F_LEGACY) in data.rows.get(String(E))![0], false);
});

test('executeMigration on an already-current provider is a success no-op', async () => {
  const document = ir(V2, [ADD_STATUS]);
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: document.schemaFingerprint ?? '', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const result = await executeMigration({
    ir: document,
    metadata,
    rows: dataset([]),
    principal: migrationAuthority('op'),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.run.alreadyAtTarget, true);
    assert.equal(result.gate.status, 'compatible');
  }
});

test('getMigrationStatus reports version, history, lock and checkpoint', async () => {
  const metadata = createMemoryMigrationStore({ now: () => 100 });
  let status = await getMigrationStatus(metadata);
  assert.equal(status.schemaVersion, null);
  assert.equal(status.phase, 'idle');

  await metadata.writeSchema(2, 'fp-2');
  await metadata.appendHistory({
    migrationId: 'm_1_2',
    fromSchema: 1,
    toSchema: 2,
    operationIds: ['op1'],
    completedAt: 100,
  });
  await metadata.acquireLock('server-A', 60_000);
  status = await getMigrationStatus(metadata);
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.history.length, 1);
  assert.equal(status.lock?.holder, 'server-A');
  assert.equal(status.phase, 'in-progress');
});

test('a running server exposes getMigrationStatus()', async () => {
  const document = ir(V2, [ADD_STATUS]);
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: document.schemaFingerprint ?? '', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const server = createAxiomServer({ ir: document, migrationMetadata: metadata });
  await server.start();
  const status = await server.getMigrationStatus();
  assert.equal(status?.schemaVersion, 2);
  assert.equal(status?.phase, 'idle');
});
