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
  schemaFingerprint,
} from '@cynodia/axiom-core';
import type { EntityDef, MigrationDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createMemoryMigrationStore,
  evaluateSchemaGate,
} from '@cynodia/axiom-server';

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const S = nodeId('state_orders');

function graphAt(version: number, extraFields: EntityDef['fields'] = [], migrations: MigrationDef[] = []) {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.setSchemaVersion(version);
  graph.addNode<EntityDef>({
    id: E,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string') },
      { id: F_TOTAL, valueType: primitiveType('number') },
      ...extraFields,
    ],
  });
  graph.addNode<StateDef>({
    id: S,
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  for (const migration of migrations) graph.addNode<MigrationDef>(migration);
  return graph;
}

const M_1_2: MigrationDef = {
  id: nodeId('m_1_2'),
  kind: 'migration',
  fromSchema: 1,
  toSchema: 2,
  operations: [
    {
      id: nodeId('op1'),
      kind: 'add-field',
      entityId: E,
      field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
      populate: literal('draft'),
    },
  ],
};
const V2_FIELDS: EntityDef['fields'] = [{ id: F_STATUS, valueType: primitiveType('string'), required: true }];

test('a fresh provider is stamped and start() proceeds', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [M_1_2]), { validate: false });
  const metadata = createMemoryMigrationStore({ now: () => 1 });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await server.start();
  const record = await metadata.readSchema();
  assert.equal(record?.schemaVersion, 2);
  assert.equal(record?.schemaFingerprint, ir.schemaFingerprint);
});

test('a compatible provider passes the gate', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [M_1_2]), { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: ir.schemaFingerprint ?? '', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await server.start();
  const gate = await server.schemaGate();
  assert.equal(gate.status, 'compatible');
});

test('start() refuses when a migration is required (spec11 §12)', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [M_1_2]), { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await assert.rejects(server.start(), /SCHEMA_MIGRATION_REQUIRED/);
  const gate = await server.schemaGate();
  assert.equal(gate.status, 'migration-required');
  assert.equal(gate.pathSteps, 1);
});

test('start() refuses an older application against newer persisted data (spec11 §103)', async () => {
  const ir = compileToServerIR(graphAt(1), { validate: false });
  // v1 graph has no schema identity → gate disabled; force one by seeding a newer version
  // against a v7 graph.
  const irV7 = compileToServerIR(graphAt(2, V2_FIELDS, [M_1_2]), { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 5, schemaFingerprint: 'fp-5', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const server = createAxiomServer({ ir: irV7, migrationMetadata: metadata });
  await assert.rejects(server.start(), /SCHEMA_INCOMPATIBLE/);
  void ir;
});

test('start() refuses a fingerprint mismatch at the same version (corrupted)', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [M_1_2]), { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: 'not-the-real-fingerprint', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await assert.rejects(server.start(), /MIGRATION_FINGERPRINT_MISMATCH/);
});

test('start() refuses a gap in the migration chain (incompatible)', async () => {
  const graph = graphAt(4, V2_FIELDS, [M_1_2]); // needs 1->2->3->4, only 1->2 exists
  const ir = compileToServerIR(graph, { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await assert.rejects(server.start(), /MIGRATION_PATH_NOT_FOUND/);
});

test('a held migration lock makes the gate migration-in-progress and start() refuse (spec11 §66)', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [M_1_2]), { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: ir.schemaFingerprint ?? '', history: [], updatedAt: 0 },
    now: () => 0,
  });
  await metadata.acquireLock('another-instance', 60_000);
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await assert.rejects(server.start(), /MIGRATION_IN_PROGRESS/);
});

test('a pre-v7 document skips the gate entirely', async () => {
  const graph = graphAt(1); // schemaVersion 1, no migrations
  const ir = compileToServerIR(graph, { validate: false });
  assert.equal(ir.schemaVersion, undefined);
  const metadata = createMemoryMigrationStore({ now: () => 1 });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await server.start(); // must not throw
  const gate = await server.schemaGate();
  assert.equal(gate.status, 'compatible');
  // Nothing was stamped, because the document declares no schema version.
  assert.equal(await metadata.readSchema(), null);
});

test('evaluateSchemaGate is pure and reports the persisted vs required versions', async () => {
  const ir = compileToServerIR(graphAt(3, V2_FIELDS, [
    M_1_2,
    { id: nodeId('m_2_3'), kind: 'migration', fromSchema: 2, toSchema: 3, operations: [] },
  ]), { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const result = await evaluateSchemaGate(ir, metadata);
  assert.equal(result.status, 'migration-required');
  assert.equal(result.persistedVersion, 1);
  assert.equal(result.requiredVersion, 3);
  assert.equal(result.pathSteps, 2);
  // Still nothing written — the gate only reads.
  assert.equal((await metadata.readSchema())?.schemaVersion, 1);
});

test('serving is refused while a migration lock is held (spec11 §68)', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [M_1_2]), { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: ir.schemaFingerprint ?? '', history: [], updatedAt: 0 },
    now: () => 0,
  });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await server.start();
  // A migration begins out of band.
  await metadata.acquireLock('migrator', 60_000);
  const response = await server.handle({ protocol: 'axiom.protocol.v1', kind: 'snapshot' } as never);
  assert.equal(response.kind, 'error');
  if (response.kind === 'error') {
    assert.equal(response.diagnostics[0].code, 'MIGRATION_IN_PROGRESS');
  }
});
