import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the portable **query conformance** fixtures (`axiom.conformance.v4`, spec 0.10
 * §89-91). Each file is pure data: a compiled `axiom.server.v6` Server IR, a dataset of
 * provider rows, the principals, and a sequence of query/invoke steps with the exact
 * results required. Running them needs nothing from this repository but a `DataProvider`.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const compiler = await import(path.join(repoRoot, 'packages/compiler/dist/index.js'));

const {
  ApplicationGraph, binary, call, collectionType, entityType, enumType, field, fieldId,
  literal, nodeId, primitiveType, providerRecordFieldLocation, ref,
} = core;

const E_ORDER = nodeId('entity_order');
const E_ACCOUNT = nodeId('entity_account');
const E_SUMMARY = nodeId('entity_order_summary');
const E_PRINCIPAL = nodeId('entity_principal');

const F_ID = fieldId('field_order_id');
const F_ACC = fieldId('field_order_account_id');
const F_STATUS = fieldId('field_order_status');
const F_CREATED = fieldId('field_order_created_at');
const F_TOTAL = fieldId('field_order_total');
const F_NOTE = fieldId('field_order_note');
const F_A_ID = fieldId('field_account_id');
const F_A_NAME = fieldId('field_account_name');
const F_S_ID = fieldId('field_summary_id');
const F_S_ACCOUNT = fieldId('field_summary_account');
const F_S_TOTAL = fieldId('field_summary_total');
const F_S_COUNT = fieldId('field_summary_count');
const F_S_REVENUE = fieldId('field_summary_revenue');
const F_P_ROLE = fieldId('field_principal_role');
const F_P_ACC = fieldId('field_principal_account_id');

const S_SEED = nodeId('state_orders_seed');
const REL = nodeId('rel_order_account');
const POLICY = nodeId('policy_order');
const ROW = nodeId('scope_row');
const ACC = nodeId('scope_acc');
const PROW = nodeId('scope_policy_row');

const Q_LIST = nodeId('query_orders');
const Q_COUNT = nodeId('query_order_count');
const Q_REVENUE = nodeId('query_revenue_by_status');
const P_STATUS = nodeId('param_status');
const P_SEARCH = nodeId('param_search');

const A_CONFIRM = nodeId('action_confirm');
const P_ORDER = nodeId('param_order');

const STATUS = ['pending', 'confirmed', 'cancelled'];
const PRINCIPAL = 'axiom_principal';

function buildGraph() {
  const g = new ApplicationGraph('query-conformance', 'Query Conformance', version);
  g.addNode({
    id: E_PRINCIPAL, kind: 'entity', identityFieldId: F_P_ACC,
    fields: [
      { id: F_P_ROLE, valueType: primitiveType('string'), required: true },
      { id: F_P_ACC, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode({
    id: E_ORDER, kind: 'entity', identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_ACC, valueType: primitiveType('string'), required: true },
      { id: F_STATUS, valueType: enumType(STATUS), required: true },
      { id: F_CREATED, valueType: primitiveType('datetime') },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
      { id: F_NOTE, valueType: primitiveType('string') },
    ],
  });
  g.addNode({
    id: E_ACCOUNT, kind: 'entity', identityFieldId: F_A_ID,
    fields: [
      { id: F_A_ID, valueType: primitiveType('string'), required: true },
      { id: F_A_NAME, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode({
    id: E_SUMMARY, kind: 'entity', identityFieldId: F_S_ID,
    fields: [
      { id: F_S_ID, valueType: primitiveType('string'), required: true },
      { id: F_S_ACCOUNT, valueType: primitiveType('string') },
      { id: F_S_TOTAL, valueType: primitiveType('number') },
      { id: F_S_COUNT, valueType: primitiveType('number') },
      { id: F_S_REVENUE, valueType: primitiveType('number') },
    ],
  });
  g.addNode({ id: S_SEED, kind: 'state', valueType: collectionType(entityType(E_ORDER)) });
  g.addNode({
    id: REL, kind: 'relationship', cardinality: 'to-one',
    from: { entityId: E_ORDER, fieldId: F_ACC },
    to: { entityId: E_ACCOUNT, fieldId: F_A_ID },
  });
  g.addNode({
    id: POLICY, kind: 'read-policy', entityId: E_ORDER, rowScopeId: PROW,
    predicate: binary('or',
      binary('eq', field(ref(nodeId(PRINCIPAL)), F_P_ROLE), literal('admin')),
      binary('eq', field(ref(PROW), F_ACC), field(ref(nodeId(PRINCIPAL)), F_P_ACC))),
  });
  g.addNode({
    id: Q_LIST, kind: 'query', source: E_ORDER, rowScopeId: ROW,
    parameters: [
      { id: P_STATUS, valueType: enumType(STATUS), required: false },
      { id: P_SEARCH, valueType: primitiveType('string'), required: false },
    ],
    filter: binary('and',
      binary('eq', field(ref(ROW), F_STATUS), ref(P_STATUS)),
      binary('or',
        call('is-empty', ref(P_SEARCH)),
        call('contains', call('coalesce', field(ref(ROW), F_NOTE), literal('')), ref(P_SEARCH)))),
    sort: [
      { key: field(ref(ROW), F_CREATED), direction: 'desc', nulls: 'last' },
      { key: field(ref(ROW), F_TOTAL), direction: 'asc', nulls: 'last' },
    ],
    relationships: [{ relationshipId: REL, bindAs: ACC }],
    projection: {
      entityId: E_SUMMARY,
      fields: [
        { id: F_S_ID, value: field(ref(ROW), F_ID) },
        { id: F_S_ACCOUNT, value: field(ref(ACC), F_A_NAME) },
        { id: F_S_TOTAL, value: field(ref(ROW), F_TOTAL) },
      ],
    },
    pagination: { strategy: 'cursor', maxPageSize: 50, defaultPageSize: 20 },
    readPolicyId: POLICY,
  });
  g.addNode({
    id: Q_COUNT, kind: 'query', source: E_ORDER, rowScopeId: ROW,
    aggregate: [{ function: 'count', as: F_S_COUNT }],
    pagination: { strategy: 'offset', maxPageSize: 1 },
    readPolicyId: POLICY,
  });
  g.addNode({
    id: Q_REVENUE, kind: 'query', source: E_ORDER, rowScopeId: ROW,
    groupBy: [field(ref(ROW), F_STATUS)],
    aggregate: [
      { function: 'count', as: F_S_COUNT },
      { function: 'sum', key: field(ref(ROW), F_TOTAL), as: F_S_REVENUE },
    ],
    pagination: { strategy: 'offset', maxPageSize: 10 },
    readPolicyId: POLICY,
  });
  g.addNode({
    id: A_CONFIRM, kind: 'action',
    parameters: [{ id: P_ORDER, valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ID, ref(P_ORDER), F_STATUS), value: literal('confirmed') },
    ],
  });
  g.setPrincipalEntity(E_PRINCIPAL);
  const result = core.validateGraph(g);
  if (!result.valid) {
    throw new Error(`query-conformance graph invalid:\n${JSON.stringify(result.errors, null, 2)}`);
  }
  return g;
}

const serverIR = compiler.compileToServerIR(buildGraph());

const dataset = {
  [E_ACCOUNT]: [
    { [F_A_ID]: 'a1', [F_A_NAME]: 'Acme' },
    { [F_A_ID]: 'a2', [F_A_NAME]: 'Globex' },
  ],
  [E_ORDER]: [
    { [F_ID]: 'o1', [F_ACC]: 'a1', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-05', [F_TOTAL]: 30, [F_NOTE]: 'rush order' },
    { [F_ID]: 'o2', [F_ACC]: 'a2', [F_STATUS]: 'pending', [F_CREATED]: '2026-01-01', [F_TOTAL]: 10, [F_NOTE]: null },
    { [F_ID]: 'o3', [F_ACC]: 'a1', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-03', [F_TOTAL]: 20, [F_NOTE]: 'gift wrap' },
    { [F_ID]: 'o4', [F_ACC]: 'a2', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-03', [F_TOTAL]: 40, [F_NOTE]: 'rush delivery' },
    { [F_ID]: 'o5', [F_ACC]: 'a1', [F_STATUS]: 'cancelled', [F_CREATED]: null, [F_TOTAL]: 5, [F_NOTE]: 'void' },
    { [F_ID]: 'o6', [F_ACC]: 'a2', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-04', [F_TOTAL]: 15, [F_NOTE]: null },
    { [F_ID]: 'o7', [F_ACC]: 'a1', [F_STATUS]: 'pending', [F_CREATED]: '2026-01-02', [F_TOTAL]: 25, [F_NOTE]: 'gift' },
    { [F_ID]: 'o8', [F_ACC]: 'a2', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-06', [F_TOTAL]: 35, [F_NOTE]: 'rush' },
  ],
};

const principals = {
  admin: { [F_P_ROLE]: 'admin', [F_P_ACC]: 'root' },
  a1: { [F_P_ROLE]: 'account', [F_P_ACC]: 'a1' },
  a2: { [F_P_ROLE]: 'account', [F_P_ACC]: 'a2' },
};

const summaryOf = {
  o1: { [F_S_ID]: 'o1', [F_S_ACCOUNT]: 'Acme', [F_S_TOTAL]: 30 },
  o2: { [F_S_ID]: 'o2', [F_S_ACCOUNT]: 'Globex', [F_S_TOTAL]: 10 },
  o3: { [F_S_ID]: 'o3', [F_S_ACCOUNT]: 'Acme', [F_S_TOTAL]: 20 },
  o4: { [F_S_ID]: 'o4', [F_S_ACCOUNT]: 'Globex', [F_S_TOTAL]: 40 },
  o5: { [F_S_ID]: 'o5', [F_S_ACCOUNT]: 'Acme', [F_S_TOTAL]: 5 },
  o6: { [F_S_ID]: 'o6', [F_S_ACCOUNT]: 'Globex', [F_S_TOTAL]: 15 },
  o7: { [F_S_ID]: 'o7', [F_S_ACCOUNT]: 'Acme', [F_S_TOTAL]: 25 },
  o8: { [F_S_ID]: 'o8', [F_S_ACCOUNT]: 'Globex', [F_S_TOTAL]: 35 },
};
const items = (...ids) => ids.map((id) => summaryOf[id]);

// createdAt: o1=01-05 o3=01-03 o4=01-03 o6=01-04 o8=01-06.
// Q_LIST sort is createdAt DESC, then total ASC, then id ASC.
const confirmedAll = ['o8', 'o1', 'o6', 'o3', 'o4']; // admin, status=confirmed
const confirmedA1 = ['o1', 'o3']; // a1's confirmed orders
const confirmedA2 = ['o8', 'o6', 'o4']; // a2's confirmed orders

const fixtures = [
  {
    name: 'filter-equality', covers: ['filter'],
    description: 'A single equality filter over an enum field, admin principal.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'pending' }, credential: 'admin',
      expect: { ok: true, items: items('o7', 'o2') } }],
  },
  {
    name: 'filter-compound', covers: ['filter', 'search'],
    description: 'A compound filter: status equality AND a substring match on a nullable note.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed', [P_SEARCH]: 'rush' }, credential: 'admin',
      expect: { ok: true, items: items('o8', 'o1', 'o4') } }],
  },
  {
    name: 'multi-key-sort', covers: ['sort'],
    description: 'Two sort keys of opposite direction: createdAt DESC then total ASC, then the id tie-breaker.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, credential: 'admin',
      expect: { ok: true, items: items(...confirmedAll) } }],
  },
  {
    name: 'stable-ordering', covers: ['sort', 'pagination'],
    description: 'o3 and o4 share createdAt; the identity tie-breaker makes the order deterministic across page boundaries.',
    steps: [
      { kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, pageSize: 2, credential: 'admin',
        expect: { ok: true, items: items('o8', 'o1'), hasMore: true, hasNextCursor: true } },
      { kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, pageSize: 2, cursor: '$prev', credential: 'admin',
        expect: { ok: true, items: items('o6', 'o3') } },
    ],
  },
  {
    name: 'null-ordering', covers: ['sort', 'null-semantics'],
    description: 'createdAt DESC nulls-last: the cancelled order with a null createdAt sorts last.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'cancelled' }, credential: 'admin',
      expect: { ok: true, items: items('o5') } }],
  },
  {
    name: 'projection-shape', covers: ['projection'],
    description: 'The result rows carry only the three projected fields, not the whole entity.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'pending' }, credential: 'admin',
      expect: { ok: true, items: items('o7', 'o2') } }],
  },
  {
    name: 'cursor-page-1', covers: ['pagination'],
    description: 'The first page of a cursor query is complete and signals more.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, pageSize: 3, credential: 'admin',
      expect: { ok: true, items: items('o8', 'o1', 'o6'), hasMore: true, hasNextCursor: true } }],
  },
  {
    name: 'cursor-page-2', covers: ['pagination'],
    description: 'The second page continues from the sealed cursor and does not repeat page 1.',
    steps: [
      { kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, pageSize: 3, credential: 'admin',
        expect: { ok: true, items: items('o8', 'o1', 'o6') } },
      { kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, pageSize: 3, cursor: '$prev', credential: 'admin',
        expect: { ok: true, items: items('o3', 'o4'), hasMore: false, hasNextCursor: false } },
    ],
  },
  {
    name: 'invalid-cursor', covers: ['pagination', 'hostile-client'],
    description: 'A tampered cursor string is rejected, not decoded.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, cursor: 'not-a-real.cursor', credential: 'admin',
      expect: { ok: false, diagnosticCodes: ['QUERY_CURSOR_INVALID'] } }],
  },
  {
    name: 'to-one-relationship', covers: ['relationship'],
    description: 'The projected account name comes from a to-one join, resolved in bounded provider work.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, pageSize: 1, credential: 'admin',
      expect: { ok: true, items: items('o8') } }],
  },
  {
    name: 'count-aggregate', covers: ['aggregate'],
    description: 'count over the whole table, admin principal.',
    steps: [{ kind: 'query', queryId: Q_COUNT, credential: 'admin',
      expect: { ok: true, aggregateRows: [{ values: { [F_S_COUNT]: 8 } }] } }],
  },
  {
    name: 'grouped-sum', covers: ['aggregate', 'group'],
    description: 'count and revenue by status, in first-seen key order (confirmed, pending, cancelled).',
    steps: [{ kind: 'query', queryId: Q_REVENUE, credential: 'admin',
      expect: { ok: true, aggregateRows: [
        { key: ['confirmed'], values: { [F_S_COUNT]: 5, [F_S_REVENUE]: 140 } },
        { key: ['pending'], values: { [F_S_COUNT]: 2, [F_S_REVENUE]: 35 } },
        { key: ['cancelled'], values: { [F_S_COUNT]: 1, [F_S_REVENUE]: 5 } },
      ] } }],
  },
  {
    name: 'row-read-policy', covers: ['read-policy'],
    description: 'account a1 sees only its own orders; the client cannot widen it.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, credential: 'a1',
      expect: { ok: true, items: items(...confirmedA1) } }],
  },
  {
    name: 'aggregate-under-policy', covers: ['read-policy', 'aggregate'],
    description: 'count is computed after the read policy: a1 sees 4 of 8 orders.',
    steps: [{ kind: 'query', queryId: Q_COUNT, credential: 'a1',
      expect: { ok: true, aggregateRows: [{ values: { [F_S_COUNT]: 4 } }] } }],
  },
  {
    name: 'relationship-under-policy', covers: ['read-policy', 'relationship'],
    description: 'a2 sees only a2 orders even though every one joins to a visible account.',
    steps: [{ kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, credential: 'a2',
      expect: { ok: true, items: items(...confirmedA2) } }],
  },
  {
    name: 'query-inside-transaction', covers: ['read-policy', 'mutation', 'transactional-reads'],
    description: 'confirmOrder mutates a provider-backed row by identity; a follow-up query observes the change and the read policy still applies.',
    steps: [
      { kind: 'invoke', actionId: A_CONFIRM, arguments: { [P_ORDER]: 'o7' }, credential: 'a1', expect: { ok: true } },
      { kind: 'query', queryId: Q_LIST, arguments: { [P_STATUS]: 'confirmed' }, credential: 'a1',
        expect: { ok: true, items: items('o1', 'o3', 'o7') } },
    ],
  },
];

const dir = path.join(repoRoot, 'packages/server/conformance/queries');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const manifest = {
  conformance: 'axiom.conformance.v4',
  baseContract: 'axiom.server.v6',
  protocol: 'axiom.protocol.v1',
  release: version,
  description:
    'Portable query conformance fixtures (spec 0.10 §89-91). Each file carries a compiled axiom.server.v6 Server IR, a dataset of provider rows, the principals, and a query/invoke step sequence with the exact results required. Running one needs only a DataProvider and the semantics in docs/QUERIES.md and docs/AUTHORITY.md.',
  fixtures: [],
};

for (const fixture of fixtures) {
  const document = {
    conformance: 'axiom.conformance.v4',
    name: fixture.name,
    covers: fixture.covers,
    description: fixture.description,
    serverIR,
    dataset,
    principals,
    steps: fixture.steps,
  };
  await writeFile(path.join(dir, `${fixture.name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  manifest.fixtures.push({ name: fixture.name, covers: fixture.covers });
}
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${fixtures.length} query conformance fixtures to ${path.relative(repoRoot, dir)}`);
