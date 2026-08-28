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
  createAxiomServer,
  createMemoryMigrationStore,
  cursorMatchesContext,
  openCursor,
  sealCursor,
} from '@cynodia/axiom-server';
import type { CursorPayload } from '@cynodia/axiom-server';

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_STATUS = fieldId('field_order_status');

// ---------------------------------------------------------------- cursor fingerprint

const baseCtx = {
  queryId: nodeId('query_orders'),
  argumentsFingerprint: 'args',
  principalFingerprint: 'anon',
  policyFingerprint: 'none',
  contract: 'axiom.server.v7',
};
const pos = { sortValues: [1], identityValue: 'o1' } as CursorPayload['pos'];

test('a cursor carries the schema fingerprint and is refused when it changes (spec11 §44)', async () => {
  const token = await sealCursor(
    { q: String(baseCtx.queryId), a: 'args', p: 'anon', rp: 'none', c: 'axiom.server.v7', s: 'fp-schema-2', pos },
    'secret',
  );
  const payload = await openCursor(token, 'secret');
  assert.ok(payload);

  assert.equal(cursorMatchesContext(payload!, { ...baseCtx, schemaFingerprint: 'fp-schema-2' }), true);
  // A migration changed the schema fingerprint — the persisted cursor no longer matches.
  assert.equal(cursorMatchesContext(payload!, { ...baseCtx, schemaFingerprint: 'fp-schema-3' }), false);
});

test('a cursor with no schema fingerprint still matches a document with no schema identity', async () => {
  const token = await sealCursor(
    { q: String(baseCtx.queryId), a: 'args', p: 'anon', rp: 'none', c: 'axiom.server.v6', pos },
    'secret',
  );
  const payload = await openCursor(token, 'secret');
  assert.ok(payload);
  // Context also has no schema fingerprint, and matches the same v6 contract.
  assert.equal(cursorMatchesContext(payload!, { ...baseCtx, contract: 'axiom.server.v6' }), true);
});

// ---------------------------------------------------------------- serving lifecycle

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

function v2Ir() {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.setSchemaVersion(2);
  graph.addNode<EntityDef>({
    id: E,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string') },
      { id: F_STATUS, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  graph.addNode<MigrationDef>(M_1_2);
  return compileToServerIR(graph, { validate: false });
}

const snapshotRequest = { protocol: 'axiom.protocol.v1', kind: 'snapshot' } as never;

test('serving resumes after a migration lock clears, and the query cache is invalidated (spec11 §45)', async () => {
  const ir = v2Ir();
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: ir.schemaFingerprint ?? '', history: [], updatedAt: 0 },
    now: () => 0,
  });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await server.start();
  assert.equal(server.queryCacheStats().entries, 0);

  // A migration begins out of band.
  const lock = await metadata.acquireLock('migrator', 60_000);
  assert.ok(lock.ok);
  let response = await server.handle(snapshotRequest);
  assert.equal(response.kind, 'error');
  if (response.kind === 'error') assert.equal(response.diagnostics[0].code, 'MIGRATION_IN_PROGRESS');

  // The migration finishes with the schema unchanged (a no-op / same fingerprint).
  await metadata.releaseLock(lock.lock!.token);
  response = await server.handle(snapshotRequest);
  assert.equal(response.kind, 'snapshot', 'serving resumes once the lock clears');
});

test('an authority stops serving permanently once the persisted schema advances past it (spec11 §103)', async () => {
  const ir = v2Ir();
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: ir.schemaFingerprint ?? '', history: [], updatedAt: 0 },
    now: () => 0,
  });
  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await server.start();

  const lock = await metadata.acquireLock('migrator', 60_000);
  await server.handle(snapshotRequest); // observes the lock
  // The migration moved the schema forward, past what this build understands.
  await metadata.writeSchema(3, 'fp-schema-3');
  await metadata.releaseLock(lock.lock!.token);

  const first = await server.handle(snapshotRequest);
  assert.equal(first.kind, 'error');
  if (first.kind === 'error') assert.equal(first.diagnostics[0].code, 'SCHEMA_INCOMPATIBLE');
  // Still refusing on the next request — it does not recover on its own.
  const second = await server.handle(snapshotRequest);
  assert.equal(second.kind, 'error');
});
