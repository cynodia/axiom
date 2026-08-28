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
  createMemoryRowStore,
  executeMigration,
  migrationAuthority,
  planMigration,
  runMigration,
} from '@cynodia/axiom-server';
import type { MigrationDataset, MigrationMetadataStore } from '@cynodia/axiom-server';

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_LEGACY = fieldId('field_order_legacy');

const M_1_2: MigrationDef = {
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
  ],
};

function ir(schemaVersion = 2, migrations: MigrationDef[] = [M_1_2], extraFields: EntityDef['fields'] = [
  { id: F_STATUS, valueType: primitiveType('string'), required: true },
]) {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.setSchemaVersion(schemaVersion);
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
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  for (const migration of migrations) graph.addNode<MigrationDef>(migration);
  return compileToServerIR(graph, { validate: false });
}

function rows(n: number): Array<Record<string, LiteralValue>> {
  return Array.from({ length: n }, (_, i) => ({ [String(F_ID)]: `o${i}`, [String(F_TOTAL)]: i }));
}
function dataset(n: number): MigrationDataset {
  return { rows: new Map([[String(E), rows(n)]]) };
}
function seededAt(version: number, fingerprint = `fp-${version}`) {
  return createMemoryMigrationStore({
    seed: { schemaVersion: version, schemaFingerprint: fingerprint, history: [], updatedAt: 0 },
    now: () => 0,
  });
}
async function migrate(document = ir(), metadata: MigrationMetadataStore = seededAt(1), data = dataset(10), extra = {}) {
  return executeMigration({
    ir: document,
    metadata,
    rows: data,
    principal: migrationAuthority('op'),
    ...extra,
  });
}

// ------------------------------------------------------------------ concurrency (§102)

test('two concurrent runners: only one executes, the other gets MIGRATION_IN_PROGRESS', async () => {
  const document = ir();
  const planned = planMigration(document, { fromVersion: 1 });
  assert.ok(planned.ok);
  const metadata = seededAt(1);
  const dataA = dataset(200);
  const dataB = dataset(200);

  const [a, b] = await Promise.all([
    runMigration(document, planned.plan, metadata, createMemoryRowStore(dataA), { holder: 'A', batchSize: 10 }),
    runMigration(document, planned.plan, metadata, createMemoryRowStore(dataB), { holder: 'B', batchSize: 10 }),
  ]);
  const outcomes = [a, b];
  assert.equal(outcomes.filter((o) => o.ok).length, 1, 'exactly one succeeded');
  const failed = outcomes.find((o) => !o.ok);
  assert.ok(failed && !failed.ok && failed.code === 'MIGRATION_IN_PROGRESS');
  assert.equal((await metadata.readSchema())?.schemaVersion, 2);
});

test('a crashed owner does not brick the migration: an expired lease is reclaimed (spec11 §67)', async () => {
  const document = ir();
  const planned = planMigration(document, { fromVersion: 1 });
  assert.ok(planned.ok);
  let clock = 0;
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
    now: () => clock,
  });
  const data = dataset(80);

  // Owner A takes the lock (short lease) and "crashes" — its finally still runs in this
  // model, so simulate a hard crash by taking the lock directly and never releasing it.
  await metadata.acquireLock('A-crashed', 1000);
  clock = 5000; // A's lease has long expired

  const b = await runMigration(document, planned.plan, metadata, createMemoryRowStore(data), {
    holder: 'B',
    leaseMs: 30_000,
    batchSize: 10,
  });
  assert.equal(b.ok, true);
  assert.equal((await metadata.readSchema())?.schemaVersion, 2);
  assert.ok(data.rows.get(String(E))!.every((row) => row[String(F_STATUS)] === 'draft'));
});

test('two authority hosts against one provider: both see migration-required, only one migrates (spec11 §102)', async () => {
  const document = ir();
  const metadata = seededAt(1);
  const hostA = createAxiomServer({ ir: document, migrationMetadata: metadata });
  const hostB = createAxiomServer({ ir: document, migrationMetadata: metadata });

  await assert.rejects(hostA.start(), /SCHEMA_MIGRATION_REQUIRED/);
  await assert.rejects(hostB.start(), /SCHEMA_MIGRATION_REQUIRED/);

  const data = dataset(20);
  const first = await migrate(document, metadata, data);
  assert.equal(first.ok, true);
  // A second execute is an idempotent no-op — not a second migration.
  const second = await migrate(document, metadata, data);
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.run.alreadyAtTarget, true);
  assert.equal((await metadata.readSchema())?.history.length, 1, 'the migration ran exactly once');
});

// ------------------------------------------------------------------ hostile requests (§75)

test('hostile: skipping a migration (a gap in the chain) is refused', async () => {
  const document = ir(3, [M_1_2]); // requires 1->2->3, only 1->2 exists
  const result = await migrate(document, seededAt(1), dataset(3));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'MIGRATION_PATH_NOT_FOUND');
});

test('hostile: executing a migration twice does not double-apply', async () => {
  const document = ir();
  const metadata = seededAt(1);
  const data = dataset(5);
  await migrate(document, metadata, data);
  const again = await migrate(document, metadata, data);
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.run.alreadyAtTarget, true);
  assert.ok(data.rows.get(String(E))!.every((row) => row[String(F_STATUS)] === 'draft'));
});

test('hostile: a downgrade with no reverse path is refused', async () => {
  const document = ir();
  const result = await migrate(document, seededAt(1), dataset(3), { fromVersion: 5 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'SCHEMA_INCOMPATIBLE');
});

test('hostile: a destructive migration without approval writes nothing (spec11 §106)', async () => {
  const document = ir(2, [
    {
      id: nodeId('m_1_2'),
      kind: 'migration',
      fromSchema: 1,
      toSchema: 2,
      operations: [
        { id: nodeId('op_drop'), kind: 'remove-field', entityId: E, fieldId: F_LEGACY, destructive: true },
      ],
    },
  ], []);
  const data: MigrationDataset = {
    rows: new Map([[String(E), rows(4).map((r) => ({ ...r, [String(F_LEGACY)]: 'secret' }))]]),
  };
  const metadata = seededAt(1);
  const result = await migrate(document, metadata, data);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'MIGRATION_APPROVAL_REQUIRED');
  assert.ok(data.rows.get(String(E))!.every((row) => row[String(F_LEGACY)] === 'secret'));
  assert.equal((await metadata.readSchema())?.schemaVersion, 1);
});

test('hostile: a forged schema fingerprint at the same version is caught by the gate', async () => {
  const document = ir();
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: 'forged', history: [], updatedAt: 0 },
    now: () => 0,
  });
  const host = createAxiomServer({ ir: document, migrationMetadata: metadata });
  await assert.rejects(host.start(), /MIGRATION_FINGERPRINT_MISMATCH/);
});

test('hostile: resuming against a checkpoint from a different plan is refused', async () => {
  const document = ir();
  const planned = planMigration(document, { fromVersion: 1 });
  assert.ok(planned.ok);
  const metadata = seededAt(1);
  await metadata.writeCheckpoint({
    planId: 'some-other-plan',
    targetFingerprint: 'x',
    operationIndex: 0,
    batchCursor: null,
    rowsProcessed: 0,
    updatedAt: 0,
  });
  const result = await runMigration(document, planned.plan, metadata, createMemoryRowStore(dataset(3)), {
    holder: 'A',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'MIGRATION_CHECKPOINT_INVALID');
});

test('hostile: a client cannot invoke a migration through the semantic protocol (spec11 §73)', async () => {
  const document = ir();
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: document.schemaFingerprint ?? '', history: [], updatedAt: 0 },
    now: () => 0,
  });
  const server = createAxiomServer({ ir: document, migrationMetadata: metadata });
  await server.start();
  // There is no migration request kind; naming the migration id as an action does nothing.
  const response = (await server.handle({
    protocol: 'axiom.protocol.v1',
    kind: 'invoke',
    actionId: String(nodeId('m_1_2')),
    arguments: {},
  } as never)) as { ok?: boolean; diagnostics: Array<{ code: string }> };
  assert.equal(response.ok ?? false, false, 'invoking a migration id as an action does not succeed');
  assert.ok(
    response.diagnostics.some((d) => d.code === 'UNKNOWN_SERVER_ACTION'),
    'a migration is not an action the authority executes',
  );
  // And executeMigration itself refuses without host authority.
  const forged = await executeMigration({
    ir: document,
    metadata,
    rows: dataset(1),
    principal: { grantedBy: 'me', kind: 'not-really' } as never,
  });
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.code, 'MIGRATION_NOT_AUTHORIZED');
});
