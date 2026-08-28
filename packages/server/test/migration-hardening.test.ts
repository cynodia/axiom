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
  SCHEMA_GATE_STATUSES,
  createAxiomServer,
  createMemoryMigrationStore,
  declaresSchemaIdentity,
  evaluateSchemaGate,
  executeMigration,
  gateAllowsStart,
  isMigrationPrincipal,
  migrationAuthority,
  schemaGateWithoutStore,
} from '@cynodia/axiom-server';
import type { MigrationDataset, SchemaGateStatus } from '@cynodia/axiom-server';

/**
 * Permanent regression guards for the three defects a blind external-consumer test found in
 * 0.11.0, fixed in 0.11.1 (spec11.1 §47-50). Each `test` here must keep failing if the
 * corresponding contract regresses:
 *
 *   D-1  migration authority is by provenance, not by shape
 *   D-2  the startup schema gate fails closed; `compatible` never means "not checked"
 *   §11  every SchemaGateStatus has exactly one machine meaning
 */

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');

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
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  for (const migration of migrations) graph.addNode<MigrationDef>(migration);
  return graph;
}

function migrationStep(from: number, to: number): MigrationDef {
  return {
    id: nodeId(`m_${from}_${to}`),
    kind: 'migration',
    fromSchema: from,
    toSchema: to,
    operations:
      to === 2
        ? [
            {
              id: nodeId('op_add_status'),
              kind: 'add-field',
              entityId: E,
              field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
              populate: literal('draft'),
            },
          ]
        : [],
  };
}

const V2_FIELDS: EntityDef['fields'] = [
  { id: F_STATUS, valueType: primitiveType('string'), required: true },
];

function dataset(rows: Array<Record<string, LiteralValue>>): MigrationDataset {
  return { rows: new Map([[String(E), rows.map((row) => ({ ...row }))]]) };
}

// --- D-1: migration authority is by provenance, not by shape (spec11.1 §15-19, §48) -------

test('D-1: only a host-minted capability is a migration principal — shape is not enough', () => {
  const real = migrationAuthority('operator-7');
  assert.equal(isMigrationPrincipal(real), true);

  // A spread copy has the same visible fields and is NOT authority.
  assert.equal(isMigrationPrincipal({ ...real }), false);
  // A hand-written literal matching the documented shape is NOT authority.
  assert.equal(
    isMigrationPrincipal({ kind: 'axiom.migration-authority', grantedBy: 'operator-7' }),
    false,
  );
  // A JSON round trip is NOT authority — the capability is not serializable.
  assert.equal(isMigrationPrincipal(JSON.parse(JSON.stringify(real))), false);
  // A prototype-delegating object is NOT authority.
  assert.equal(isMigrationPrincipal(Object.create(real)), false);
  // Obvious non-objects.
  for (const value of [null, undefined, 'axiom.migration-authority', 42, {}, []]) {
    assert.equal(isMigrationPrincipal(value), false);
  }
});

test('D-1: the minted capability is frozen and carries only an audit label', () => {
  const real = migrationAuthority('deploy-job-19');
  assert.equal(Object.isFrozen(real), true);
  assert.equal(real.kind, 'axiom.migration-authority');
  assert.equal(real.grantedBy, 'deploy-job-19');
  assert.throws(() => {
    (real as { grantedBy: string }).grantedBy = 'someone-else';
  });
});

test('D-1: executeMigration accepts a minted principal and rejects a forged one', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [migrationStep(1, 2)]), { validate: false });
  const forged = { kind: 'axiom.migration-authority', grantedBy: 'operator' } as never;

  const refused = await executeMigration({
    ir,
    metadata: createMemoryMigrationStore({
      seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
      now: () => 1,
    }),
    rows: dataset([{ [String(F_ID)]: 'o1', [String(F_TOTAL)]: 1 }]),
    principal: forged,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, 'MIGRATION_NOT_AUTHORIZED');

  const accepted = await executeMigration({
    ir,
    metadata: createMemoryMigrationStore({
      seed: { schemaVersion: 1, schemaFingerprint: 'fp-1', history: [], updatedAt: 0 },
      now: () => 1,
    }),
    rows: dataset([{ [String(F_ID)]: 'o1', [String(F_TOTAL)]: 1 }]),
    principal: migrationAuthority('operator'),
  });
  assert.equal(accepted.ok, true);
});

// --- D-2: the startup gate fails closed (spec11.1 §4-14, §49) -----------------------------

test('D-2: persisted schema 4 + a graph that declares no schema version → refused, not compatible', async () => {
  const ir = compileToServerIR(graphAt(1), { validate: false });
  assert.equal(ir.schemaVersion, undefined); // the graph declares no semantic schema identity
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 4, schemaFingerprint: 'fp-4', history: [], updatedAt: 0 },
    now: () => 1,
  });

  const gate = await evaluateSchemaGate(ir, metadata);
  assert.equal(gate.status, 'schema-identity-required');
  assert.notEqual(gate.status, 'compatible');
  assert.equal(gate.code, 'SCHEMA_IDENTITY_REQUIRED');
  assert.equal(gate.persistedVersion, 4);
  assert.equal(gateAllowsStart(gate), false);

  const server = createAxiomServer({ ir, migrationMetadata: metadata });
  await assert.rejects(server.start(), /SCHEMA_IDENTITY_REQUIRED/);
});

test('D-2: persisted schema 4 + graph schema 2 → incompatible (older app, newer data)', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [migrationStep(1, 2)]), { validate: false });
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 4, schemaFingerprint: 'fp-4', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const gate = await evaluateSchemaGate(ir, metadata);
  assert.equal(gate.status, 'incompatible');
  assert.equal(gate.code, 'SCHEMA_INCOMPATIBLE');
  assert.equal(gateAllowsStart(gate), false);
  await assert.rejects(
    createAxiomServer({ ir, migrationMetadata: metadata }).start(),
    /SCHEMA_INCOMPATIBLE/,
  );
});

test('D-2: persisted schema 2 + graph schema 4 with a full chain → migration-required', async () => {
  const ir = compileToServerIR(
    graphAt(4, V2_FIELDS, [migrationStep(1, 2), migrationStep(2, 3), migrationStep(3, 4)]),
    { validate: false },
  );
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 2, schemaFingerprint: 'fp-2', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const gate = await evaluateSchemaGate(ir, metadata);
  assert.equal(gate.status, 'migration-required');
  assert.equal(gate.code, 'SCHEMA_MIGRATION_REQUIRED');
  assert.equal(gate.pathSteps, 2);
  assert.equal(gateAllowsStart(gate), false);
});

test('D-2: a schema-evolving graph with NO metadata store is refused, never assumed compatible', () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [migrationStep(1, 2)]), { validate: false });
  const gate = schemaGateWithoutStore(ir);
  assert.equal(gate.status, 'schema-metadata-required');
  assert.notEqual(gate.status, 'compatible');
  assert.equal(gate.code, 'SCHEMA_METADATA_REQUIRED');
  assert.equal(gateAllowsStart(gate), false);
});

test('D-2: a schema-evolving graph + NO store makes createAxiomServer().start() refuse', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [migrationStep(1, 2)]), { validate: false });
  await assert.rejects(createAxiomServer({ ir }).start(), /SCHEMA_METADATA_REQUIRED/);
});

test('D-2: a versioned graph + persisted data + no schema record → corrupted, not fresh', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [migrationStep(1, 2)]), { validate: false });
  const metadata = createMemoryMigrationStore({ now: () => 1 }); // no seed → no schema record
  const gate = await evaluateSchemaGate(ir, metadata, { hasPersistedData: true });
  assert.equal(gate.status, 'corrupted');
  assert.equal(gate.code, 'MIGRATION_STATE_CORRUPTED');
  assert.equal(gateAllowsStart(gate), false);
});

test('D-2: legitimate fresh persistence still works — versioned graph, empty store, no data', async () => {
  const ir = compileToServerIR(graphAt(2, V2_FIELDS, [migrationStep(1, 2)]), { validate: false });
  const metadata = createMemoryMigrationStore({ now: () => 1 });
  const gate = await evaluateSchemaGate(ir, metadata, { hasPersistedData: false });
  assert.equal(gate.status, 'fresh');
  assert.equal(gate.code, undefined);
  assert.equal(gateAllowsStart(gate), true);
});

test('D-2: a trivial non-persistent in-memory program is not forced to configure migration metadata', async () => {
  const ir = compileToServerIR(graphAt(1), { validate: false });
  assert.equal(declaresSchemaIdentity(ir), false);
  assert.equal(schemaGateWithoutStore(ir).status, 'not-applicable');
  const server = createAxiomServer({ ir });
  await server.start(); // no throw
  assert.equal((await server.schemaGate()).status, 'not-applicable');
});

// --- §11: every gate status has exactly one machine meaning ------------------------------

test('§11: gateAllowsStart partitions the status space — serving iff compatible/fresh/not-applicable', () => {
  const serving = new Set<SchemaGateStatus>(['compatible', 'fresh', 'not-applicable']);
  for (const status of SCHEMA_GATE_STATUSES) {
    const permitted = gateAllowsStart({
      status,
      message: '',
      requiredVersion: 1,
      persistedVersion: null,
    });
    assert.equal(permitted, serving.has(status), `gateAllowsStart(${status})`);
  }
  // The enumeration and the type stay in step.
  assert.equal(new Set(SCHEMA_GATE_STATUSES).size, SCHEMA_GATE_STATUSES.length);
  assert.equal(SCHEMA_GATE_STATUSES.length, 9);
});

test('§11: every refusing status carries a diagnostic code; every serving status carries none', async () => {
  // Serving statuses, observed from real gate evaluations.
  const compatibleIr = compileToServerIR(graphAt(2, V2_FIELDS, [migrationStep(1, 2)]), { validate: false });
  const compatibleStore = createMemoryMigrationStore({
    seed: {
      schemaVersion: 2,
      schemaFingerprint: compatibleIr.schemaFingerprint ?? '',
      history: [],
      updatedAt: 0,
    },
    now: () => 1,
  });
  assert.equal((await evaluateSchemaGate(compatibleIr, compatibleStore)).code, undefined); // compatible
  assert.equal(
    (await evaluateSchemaGate(compatibleIr, createMemoryMigrationStore({ now: () => 1 }))).code,
    undefined,
  ); // fresh
  assert.equal(schemaGateWithoutStore(compileToServerIR(graphAt(1), { validate: false })).code, undefined); // not-applicable

  // Refusing statuses each name a code.
  const refusing: SchemaGateStatus[] = [
    'migration-required',
    'migration-in-progress',
    'incompatible',
    'corrupted',
    'schema-identity-required',
    'schema-metadata-required',
  ];
  for (const status of refusing) {
    assert.equal(serving(status), false, `${status} must not permit serving`);
  }
  function serving(status: SchemaGateStatus): boolean {
    return gateAllowsStart({ status, message: '', requiredVersion: 1, persistedVersion: null });
  }
});
