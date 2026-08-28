import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the portable **migration conformance** fixtures (`axiom.conformance.v5`, spec11
 * §84-86). Each file is pure data: a compiled `axiom.server.v7` target Server IR (with its
 * MigrationDef chain), the schema version the persisted data starts at, the source rows,
 * any destructive approvals, and the exact expected outcome. Running one needs nothing from
 * this repository but a row store and the semantics in docs/MIGRATIONS.md + docs/AUTHORITY.md.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const compiler = await import(path.join(repoRoot, 'packages/compiler/dist/index.js'));

const {
  ApplicationGraph,
  MIGRATION_OLD_SCOPE,
  binary,
  call,
  collectionType,
  entityType,
  fieldId,
  field,
  literal,
  nodeId,
  object,
  optionalType,
  primitiveType,
  ref,
} = core;
const { compileToServerIR } = compiler;

const E_ORDER = nodeId('entity_order');
const E_ACCOUNT = nodeId('entity_account');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_NOTE = fieldId('field_order_note');
const F_LEGACY = fieldId('field_order_legacy');
const F_GROSS = fieldId('field_order_gross');
const F_ACCOUNT_ID = fieldId('field_order_account_id');
const F_ACC_ID = fieldId('field_account_id');
const F_ACC_NAME = fieldId('field_account_name');

/** Compile a target graph: entities (+ a backing collection state each) + a migration chain. */
function buildIr({ schemaVersion, entities, migrations, relationships = [] }) {
  const graph = new ApplicationGraph('migration-conformance', 'Migration Conformance', version);
  graph.setSchemaVersion(schemaVersion);
  for (const entity of entities) {
    graph.addNode({ kind: 'entity', ...entity });
    graph.addNode({
      id: nodeId(`state_${String(entity.id)}`),
      kind: 'state',
      valueType: collectionType(entityType(entity.id)),
      authority: 'server',
    });
  }
  for (const relationship of relationships) {
    graph.addNode({ kind: 'relationship', ...relationship });
  }
  for (const migration of migrations) {
    graph.addNode({ kind: 'migration', ...migration });
  }
  return compileToServerIR(graph, { validate: false });
}

const ORDER_V1 = {
  id: E_ORDER,
  identityFieldId: F_ID,
  fields: [
    { id: F_ID, valueType: primitiveType('string') },
    { id: F_TOTAL, valueType: primitiveType('number') },
  ],
};
const ACCOUNT = {
  id: E_ACCOUNT,
  identityFieldId: F_ACC_ID,
  fields: [
    { id: F_ACC_ID, valueType: primitiveType('string') },
    { id: F_ACC_NAME, valueType: primitiveType('string') },
  ],
};

function orderRows(n, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    [String(F_ID)]: `order-${String(i).padStart(4, '0')}`,
    [String(F_TOTAL)]: i,
    ...extra(i),
  }));
}

const fixtures = [];

// 1 — metadata-only change (an empty migration; a label changed in the graph).
fixtures.push({
  name: 'metadata-only-change',
  covers: ['spec11 §16', 'metadata-only change'],
  description: 'A schema version bump whose migration has no operations — a label or description changed, no data moves.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [ORDER_V1],
    migrations: [{ id: nodeId('m_1_2'), fromSchema: 1, toSchema: 2, operations: [] }],
  }),
  fromVersion: 1,
  sourceData: { [String(E_ORDER)]: orderRows(3) },
  expect: { ok: true, status: 'completed', targetData: { [String(E_ORDER)]: orderRows(3) } },
});

// 2 — add optional field.
fixtures.push({
  name: 'add-optional-field',
  covers: ['spec11 §17', 'add optional field'],
  description: 'Order.note is added as optional; existing rows stay valid without a rewrite.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [{ ...ORDER_V1, fields: [...ORDER_V1.fields, { id: F_NOTE, valueType: optionalType(primitiveType('string')) }] }],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [{ id: nodeId('op_add_note'), kind: 'add-field', entityId: E_ORDER, field: { id: F_NOTE, valueType: optionalType(primitiveType('string')) } }],
      },
    ],
  }),
  fromVersion: 1,
  sourceData: { [String(E_ORDER)]: orderRows(3) },
  expect: { ok: true, status: 'completed', targetData: { [String(E_ORDER)]: orderRows(3) } },
});

// 3 — add required field + default.
fixtures.push({
  name: 'add-required-field-with-default',
  covers: ['spec11 §18', 'add required field + default'],
  description: 'Order.status is added as required; every existing row is populated with "draft".',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [{ ...ORDER_V1, fields: [...ORDER_V1.fields, { id: F_STATUS, valueType: primitiveType('string'), required: true }] }],
    migrations: [
      {
        id: nodeId('m_1_2'),
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
    ],
  }),
  fromVersion: 1,
  sourceData: { [String(E_ORDER)]: orderRows(4) },
  expect: {
    ok: true,
    status: 'completed',
    targetData: { [String(E_ORDER)]: orderRows(4, () => ({ [String(F_STATUS)]: 'draft' })) },
  },
});

// 4 — transform field.
fixtures.push({
  name: 'transform-field',
  covers: ['spec11 §24', 'transform field'],
  description: 'Order.total is scaled by 100 through a typed, deterministic expression over the old record.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [ORDER_V1],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [
          {
            id: nodeId('op_scale'),
            kind: 'transform-field',
            entityId: E_ORDER,
            fieldId: F_TOTAL,
            fromType: primitiveType('number'),
            toType: primitiveType('number'),
            expression: binary('multiply', field(ref(MIGRATION_OLD_SCOPE), F_TOTAL), literal(100)),
          },
        ],
      },
    ],
  }),
  fromVersion: 1,
  sourceData: { [String(E_ORDER)]: orderRows(3) },
  expect: {
    ok: true,
    status: 'completed',
    targetData: { [String(E_ORDER)]: orderRows(3).map((row) => ({ ...row, [String(F_TOTAL)]: row[String(F_TOTAL)] * 100 })) },
  },
});

// 5 — remove empty field (marked destructive, approved; the column holds no values).
fixtures.push({
  name: 'remove-empty-field',
  covers: ['spec11 §19', 'remove empty field'],
  description: 'A legacy field that never held a value is removed. Marked destructive and approved; nothing is lost.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [ORDER_V1],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [{ id: nodeId('op_drop_legacy'), kind: 'remove-field', entityId: E_ORDER, fieldId: F_LEGACY, destructive: true }],
      },
    ],
  }),
  fromVersion: 1,
  approvals: [String(nodeId('op_drop_legacy'))],
  sourceData: { [String(E_ORDER)]: orderRows(3) },
  expect: { ok: true, status: 'completed', targetData: { [String(E_ORDER)]: orderRows(3) } },
});

// 6 — destructive populated-field removal, refused without approval.
fixtures.push({
  name: 'destructive-removal-refused',
  covers: ['spec11 §20', 'spec11 §21', 'spec11 §106', 'destructive populated-field removal'],
  description: 'Removing a populated field without approval performs zero writes and does not advance the schema version.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [ORDER_V1],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [{ id: nodeId('op_drop_legacy'), kind: 'remove-field', entityId: E_ORDER, fieldId: F_LEGACY, destructive: true }],
      },
    ],
  }),
  fromVersion: 1,
  sourceData: { [String(E_ORDER)]: orderRows(3, () => ({ [String(F_LEGACY)]: 'keep' })) },
  expect: { ok: false, status: 'refused', code: 'MIGRATION_APPROVAL_REQUIRED' },
});

// 7 — destructive populated-field removal, approved.
fixtures.push({
  name: 'destructive-removal-approved',
  covers: ['spec11 §21', 'destructive populated-field removal'],
  description: 'The same removal with explicit approval drops the field.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [ORDER_V1],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [{ id: nodeId('op_drop_legacy'), kind: 'remove-field', entityId: E_ORDER, fieldId: F_LEGACY, destructive: true }],
      },
    ],
  }),
  fromVersion: 1,
  approvals: [String(nodeId('op_drop_legacy'))],
  sourceData: { [String(E_ORDER)]: orderRows(3, () => ({ [String(F_LEGACY)]: 'keep' })) },
  expect: { ok: true, status: 'completed', targetData: { [String(E_ORDER)]: orderRows(3) } },
});

// 8 — relationship addition (metadata only).
fixtures.push({
  name: 'relationship-addition',
  covers: ['spec11 §41', 'relationship addition'],
  description: 'A relationship between Order and Account is added; the foreign key already exists, so no row is rewritten.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [
      { ...ORDER_V1, fields: [...ORDER_V1.fields, { id: F_ACCOUNT_ID, valueType: primitiveType('string') }] },
      ACCOUNT,
    ],
    relationships: [
      {
        id: nodeId('rel_order_account'),
        cardinality: 'to-one',
        from: { entityId: E_ORDER, fieldId: F_ACCOUNT_ID },
        to: { entityId: E_ACCOUNT, fieldId: F_ACC_ID },
      },
    ],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [
          {
            id: nodeId('op_add_rel'),
            kind: 'add-relationship',
            relationship: {
              id: nodeId('rel_order_account'),
              kind: 'relationship',
              cardinality: 'to-one',
              from: { entityId: E_ORDER, fieldId: F_ACCOUNT_ID },
              to: { entityId: E_ACCOUNT, fieldId: F_ACC_ID },
            },
          },
        ],
      },
    ],
  }),
  fromVersion: 1,
  sourceData: {
    [String(E_ORDER)]: orderRows(3, (i) => ({ [String(F_ACCOUNT_ID)]: `acc-${i % 2}` })),
    [String(E_ACCOUNT)]: [
      { [String(F_ACC_ID)]: 'acc-0', [String(F_ACC_NAME)]: 'Acme' },
      { [String(F_ACC_ID)]: 'acc-1', [String(F_ACC_NAME)]: 'Globex' },
    ],
  },
  expect: {
    ok: true,
    status: 'completed',
    targetData: {
      [String(E_ORDER)]: orderRows(3, (i) => ({ [String(F_ACCOUNT_ID)]: `acc-${i % 2}` })),
      [String(E_ACCOUNT)]: [
        { [String(F_ACC_ID)]: 'acc-0', [String(F_ACC_NAME)]: 'Acme' },
        { [String(F_ACC_ID)]: 'acc-1', [String(F_ACC_NAME)]: 'Globex' },
      ],
    },
  },
});

// 9 — record transformation (split / discard).
fixtures.push({
  name: 'record-transformation',
  covers: ['spec11 §27', 'spec11 §28', 'record transformation'],
  description: 'Every Order record is rewritten: gross = total * 1.25, and total is dropped (destructive, approved).',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [{ id: E_ORDER, identityFieldId: F_ID, fields: [{ id: F_ID, valueType: primitiveType('string') }, { id: F_GROSS, valueType: primitiveType('number') }] }],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [
          {
            id: nodeId('op_reshape'),
            kind: 'transform-record',
            entityId: E_ORDER,
            produce: object([{ fieldId: F_GROSS, value: binary('multiply', field(ref(MIGRATION_OLD_SCOPE), F_TOTAL), literal(1.25)) }]),
            addsFields: [F_GROSS],
            removesFields: [F_TOTAL],
          },
        ],
      },
    ],
  }),
  fromVersion: 1,
  approvals: [String(nodeId('op_reshape'))],
  sourceData: { [String(E_ORDER)]: orderRows(4).map((row) => ({ ...row, [String(F_TOTAL)]: 80 })) },
  expect: {
    ok: true,
    status: 'completed',
    targetData: { [String(E_ORDER)]: orderRows(4).map((row) => ({ [String(F_ID)]: row[String(F_ID)], [String(F_GROSS)]: 100 })) },
  },
});

// 10 — large batched transformation.
fixtures.push({
  name: 'large-batched-transformation',
  covers: ['spec11 §29', 'spec11 §30', 'large batched transformation'],
  description: 'A required field is populated over 2000 rows in batches of 100; bounded memory, one deterministic result.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [{ ...ORDER_V1, fields: [...ORDER_V1.fields, { id: F_STATUS, valueType: primitiveType('string'), required: true }] }],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [
          {
            id: nodeId('op_fill'),
            kind: 'add-field',
            entityId: E_ORDER,
            field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
            populate: call('concat', literal('order:'), field(ref(MIGRATION_OLD_SCOPE), F_ID)),
          },
        ],
      },
    ],
  }),
  fromVersion: 1,
  batchSize: 100,
  sourceData: { [String(E_ORDER)]: orderRows(2000) },
  expect: {
    ok: true,
    status: 'completed',
    targetData: { [String(E_ORDER)]: orderRows(2000, (i) => ({ [String(F_STATUS)]: `order:order-${String(i).padStart(4, '0')}` })) },
  },
});

// 11 — crash / resume.
fixtures.push({
  name: 'crash-and-resume',
  covers: ['spec11 §31', 'spec11 §32', 'spec11 §120', 'crash/resume'],
  description: 'A crash after 40 rows of a batched transform resumes to the same target as an uninterrupted run.',
  serverIR: fixtures[2].serverIR,
  fromVersion: 1,
  batchSize: 25,
  crashAfterRows: 40,
  sourceData: { [String(E_ORDER)]: orderRows(200) },
  expect: {
    ok: true,
    status: 'completed',
    targetData: { [String(E_ORDER)]: orderRows(200, () => ({ [String(F_STATUS)]: 'draft' })) },
  },
});

// 12 — idempotent rerun.
fixtures.push({
  name: 'idempotent-rerun',
  covers: ['spec11 §35', 'idempotent rerun'],
  description: 'Running a completed migration a second time is a no-op; the data is unchanged.',
  serverIR: fixtures[2].serverIR,
  fromVersion: 1,
  rerun: true,
  sourceData: { [String(E_ORDER)]: orderRows(5) },
  expect: {
    ok: true,
    status: 'completed',
    targetData: { [String(E_ORDER)]: orderRows(5, () => ({ [String(F_STATUS)]: 'draft' })) },
  },
});

// 13 — missing migration path.
fixtures.push({
  name: 'missing-migration-path',
  covers: ['spec11 §13', 'missing migration path'],
  description: 'The graph requires schema 3 but only the 1 -> 2 migration exists; execution is refused.',
  serverIR: buildIr({
    schemaVersion: 3,
    entities: [ORDER_V1],
    migrations: [{ id: nodeId('m_1_2'), fromSchema: 1, toSchema: 2, operations: [] }],
  }),
  fromVersion: 1,
  sourceData: { [String(E_ORDER)]: orderRows(2) },
  expect: { ok: false, status: 'refused', code: 'MIGRATION_PATH_NOT_FOUND' },
});

// 14 — invalid target record.
fixtures.push({
  name: 'invalid-target-record',
  covers: ['spec11 §37', 'spec11 §105', 'invalid target record'],
  description: 'A transform that produces null for a required field fails; the target schema version is not committed.',
  serverIR: buildIr({
    schemaVersion: 2,
    entities: [{ ...ORDER_V1, fields: [...ORDER_V1.fields, { id: F_STATUS, valueType: primitiveType('string'), required: true }] }],
    migrations: [
      {
        id: nodeId('m_1_2'),
        fromSchema: 1,
        toSchema: 2,
        operations: [
          {
            id: nodeId('op_bad'),
            kind: 'add-field',
            entityId: E_ORDER,
            field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
            populate: call('coalesce', literal(null), literal(null)),
          },
        ],
      },
    ],
  }),
  fromVersion: 1,
  sourceData: { [String(E_ORDER)]: orderRows(3) },
  expect: { ok: false, status: 'failed', code: 'MIGRATION_VALIDATION_FAILED' },
});

// 15 — migration lock contention.
fixtures.push({
  name: 'migration-lock',
  covers: ['spec11 §66', 'spec11 §102', 'migration lock'],
  description: 'A second runner is refused while another instance holds the migration lock.',
  serverIR: fixtures[2].serverIR,
  fromVersion: 1,
  preHeldLockHolder: 'other-instance',
  sourceData: { [String(E_ORDER)]: orderRows(3) },
  expect: { ok: false, status: 'refused', code: 'MIGRATION_IN_PROGRESS' },
});

// 16 — schema fingerprint mismatch (gate).
fixtures.push({
  name: 'schema-fingerprint-mismatch',
  covers: ['spec11 §9', 'spec11 §11', 'schema fingerprint mismatch'],
  description: 'The provider records the target version but a fingerprint that does not match this build; startup is refused.',
  serverIR: fixtures[2].serverIR,
  fromVersion: 2,
  seededFingerprint: 'not-the-real-fingerprint',
  sourceData: { [String(E_ORDER)]: orderRows(3, () => ({ [String(F_STATUS)]: 'draft' })) },
  expect: { ok: false, status: 'refused', code: 'MIGRATION_FINGERPRINT_MISMATCH' },
});

const dir = path.join(repoRoot, 'packages/server/conformance/migrations');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const manifest = {
  conformance: 'axiom.conformance.v5',
  baseContract: 'axiom.server.v7',
  release: version,
  description:
    'Portable migration conformance fixtures (spec11 §84-86). Each file carries a compiled axiom.server.v7 target Server IR with its MigrationDef chain, the schema version the persisted data starts at, the source rows, any destructive approvals, and the exact expected outcome. Running one needs only a row store and the semantics in docs/MIGRATIONS.md + docs/AUTHORITY.md. Every fixture must produce equivalent target data on the memory and SQLite providers (spec11 §83).',
  fixtures: [],
};

for (const fixture of fixtures) {
  const document = { conformance: 'axiom.conformance.v5', ...fixture };
  await writeFile(path.join(dir, `${fixture.name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  manifest.fixtures.push({ name: fixture.name, covers: fixture.covers });
}
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${fixtures.length} migration conformance fixtures to ${path.relative(repoRoot, dir)}`);
