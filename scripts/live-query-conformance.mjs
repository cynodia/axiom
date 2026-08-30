import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the portable **live-query conformance** fixtures (`axiom.conformance.v7`, spec13
 * §152, §194). Each file is pure data: a compiled `axiom.server.v7` Server IR, a dataset of
 * provider rows, the live query to open, its required initial result, and a script of
 * committed mutations each paired with the live message that must follow — a canonical
 * `update`, a whole `reset`, or `none`. Running one needs nothing from this repository but a
 * `DataProvider` and the semantics in `docs/LIVE_QUERIES.md`.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const compiler = await import(path.join(repoRoot, 'packages/compiler/dist/index.js'));

const {
  ApplicationGraph, binary, call, collectionType, entityType, enumType, field, fieldId,
  literal, nodeId, primitiveType, providerRecordFieldLocation, providerRecordLocation, ref,
} = core;

const E_ORDER = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_STATUS = fieldId('field_order_status');
const F_TOTAL = fieldId('field_order_total');
const F_AGG = fieldId('field_total');

const S_SEED = nodeId('state_orders_seed');
const ROW = nodeId('scope_row');

const Q_OPEN = nodeId('query_open_orders');
const Q_LIMIT = nodeId('query_open_top2');
const Q_SUM = nodeId('query_open_total');
const Q_NOW = nodeId('query_recent');

const A_STATUS = nodeId('action_set_status');
const A_TOTAL = nodeId('action_set_total');
const A_REMOVE = nodeId('action_remove');
const P_ID = nodeId('param_id');
const P_STATUS = nodeId('param_status');
const P_TOTAL = nodeId('param_total');

const STATUS = ['open', 'closed'];

function buildGraph() {
  const g = new ApplicationGraph('live-query-conformance', 'Live Query Conformance', version);
  g.addNode({
    id: E_ORDER, kind: 'entity', identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_STATUS, valueType: enumType(STATUS), required: true },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode({ id: S_SEED, kind: 'state', valueType: collectionType(entityType(E_ORDER)) });

  g.addNode({
    id: Q_OPEN, kind: 'query', source: E_ORDER, rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  });
  g.addNode({
    id: Q_LIMIT, kind: 'query', source: E_ORDER, rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 2 },
  });
  g.addNode({
    id: Q_SUM, kind: 'query', source: E_ORDER, rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    aggregate: [{ function: 'sum', key: field(ref(ROW), F_TOTAL), as: F_AGG }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  });
  g.addNode({
    id: Q_NOW, kind: 'query', source: E_ORDER, rowScopeId: ROW,
    filter: binary('gte', field(ref(ROW), F_TOTAL), call('now')),
    pagination: { strategy: 'offset', maxPageSize: 100 },
  });

  g.addNode({
    id: A_STATUS, kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_STATUS, valueType: enumType(STATUS), required: true },
    ],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ID, ref(P_ID), F_STATUS), value: ref(P_STATUS) },
    ],
  });
  g.addNode({
    id: A_TOTAL, kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_TOTAL, valueType: primitiveType('number'), required: true },
    ],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ID, ref(P_ID), F_TOTAL), value: ref(P_TOTAL) },
    ],
  });
  g.addNode({
    id: A_REMOVE, kind: 'action',
    parameters: [{ id: P_ID, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'remove', target: providerRecordLocation(E_ORDER, F_ID, ref(P_ID)) }],
  });

  const result = core.validateGraph(g);
  if (!result.valid) {
    throw new Error(`live-query-conformance graph invalid:\n${JSON.stringify(result.errors, null, 2)}`);
  }
  return g;
}

const serverIR = compiler.compileToServerIR(buildGraph());

const dataset = {
  [E_ORDER]: [
    { [F_ID]: 'a', [F_STATUS]: 'open', [F_TOTAL]: 30 },
    { [F_ID]: 'b', [F_STATUS]: 'closed', [F_TOTAL]: 10 },
    { [F_ID]: 'c', [F_STATUS]: 'open', [F_TOTAL]: 20 },
    { [F_ID]: 'd', [F_STATUS]: 'closed', [F_TOTAL]: 99 },
  ],
};

const row = (id, status, total) => ({ [F_ID]: id, [F_STATUS]: status, [F_TOTAL]: total });

const fixtures = [
  {
    name: 'initial-result', covers: ['initial'],
    description: 'The initial message is the filtered, ordered result at the current revision.',
    open: { queryId: Q_OPEN },
    expectInitial: [row('c', 'open', 20), row('a', 'open', 30)],
    steps: [],
  },
  {
    name: 'insert-on-filter-entry', covers: ['insert', 'filter-membership'],
    description: 'A closed order flipped to open enters the result as an insert.',
    open: { queryId: Q_OPEN },
    expectInitial: [row('c', 'open', 20), row('a', 'open', 30)],
    steps: [
      { invoke: { actionId: A_STATUS, arguments: { [P_ID]: 'b', [P_STATUS]: 'open' } },
        expect: { kind: 'update', changes: [{ kind: 'insert', key: 'b' }] } },
    ],
  },
  {
    name: 'remove-on-filter-exit', covers: ['remove', 'filter-membership'],
    description: 'An open order flipped to closed leaves the result as a remove.',
    open: { queryId: Q_OPEN },
    expectInitial: [row('c', 'open', 20), row('a', 'open', 30)],
    steps: [
      { invoke: { actionId: A_STATUS, arguments: { [P_ID]: 'a', [P_STATUS]: 'closed' } },
        expect: { kind: 'update', changes: [{ kind: 'remove', key: 'a' }] } },
    ],
  },
  {
    name: 'update-without-move', covers: ['update'],
    description: 'A sort-key change that does not reorder the result is a single update.',
    open: { queryId: Q_OPEN },
    expectInitial: [row('c', 'open', 20), row('a', 'open', 30)],
    steps: [
      { invoke: { actionId: A_TOTAL, arguments: { [P_ID]: 'c', [P_TOTAL]: 25 } },
        expect: { kind: 'update', changes: [{ kind: 'update', key: 'c' }] } },
    ],
  },
  {
    name: 'update-with-move', covers: ['update', 'ordering-move'],
    description: 'A sort-key change that reorders the result is an update plus an explicit move.',
    open: { queryId: Q_OPEN },
    expectInitial: [row('c', 'open', 20), row('a', 'open', 30)],
    steps: [
      { invoke: { actionId: A_TOTAL, arguments: { [P_ID]: 'c', [P_TOTAL]: 50 } },
        expect: { kind: 'update', changes: [{ kind: 'update', key: 'c' }, { kind: 'move', key: 'c' }] } },
    ],
  },
  {
    name: 'provider-record-remove', covers: ['remove'],
    description: 'Deleting a member row from the provider is a remove change.',
    open: { queryId: Q_OPEN },
    expectInitial: [row('c', 'open', 20), row('a', 'open', 30)],
    steps: [
      { invoke: { actionId: A_REMOVE, arguments: { [P_ID]: 'c' } },
        expect: { kind: 'update', changes: [{ kind: 'remove', key: 'c' }] } },
    ],
  },
  {
    name: 'dependency-commit-no-change', covers: ['no-op', 'dependency-analysis'],
    description: 'A commit to the same entity that does not move the result produces no client message.',
    open: { queryId: Q_OPEN },
    expectInitial: [row('c', 'open', 20), row('a', 'open', 30)],
    steps: [
      { invoke: { actionId: A_TOTAL, arguments: { [P_ID]: 'd', [P_TOTAL]: 7 } }, expect: { kind: 'none' } },
      { invoke: { actionId: A_STATUS, arguments: { [P_ID]: 'b', [P_STATUS]: 'open' } },
        expect: { kind: 'update', changes: [{ kind: 'insert', key: 'b' }] } },
    ],
  },
  {
    name: 'limit-boundary', covers: ['limit-boundary'],
    description:
      'A 2-row cap: a new lowest-total open row displaces the previous last row of the window; removing a member then pulls the next row in.',
    open: { queryId: Q_LIMIT },
    expectInitial: [row('c', 'open', 20), row('a', 'open', 30)],
    steps: [
      { invoke: { actionId: A_STATUS, arguments: { [P_ID]: 'b', [P_STATUS]: 'open' } },
        expect: { kind: 'update', changes: [{ kind: 'insert', key: 'b' }, { kind: 'remove', key: 'a' }] } },
      { invoke: { actionId: A_REMOVE, arguments: { [P_ID]: 'c' } },
        expect: { kind: 'update', changes: [{ kind: 'remove', key: 'c' }, { kind: 'insert', key: 'a' }] } },
    ],
  },
  {
    name: 'aggregate-reset', covers: ['aggregate', 'reset'],
    description: 'An aggregate query is reset-only: a dependency change delivers a whole reset.',
    open: { queryId: Q_SUM },
    expectInitial: [{ [F_AGG]: 50 }],
    steps: [
      { invoke: { actionId: A_TOTAL, arguments: { [P_ID]: 'a', [P_TOTAL]: 130 } },
        expect: { kind: 'reset', rows: [{ [F_AGG]: 150 }] } },
    ],
  },
  {
    name: 'not-live-capable', covers: ['capability', 'nondeterministic'],
    description: 'A QueryDef whose filter reads `now` is refused for live observation.',
    open: { queryId: Q_NOW },
    expectInitial: { errorCode: 'LIVE_QUERY_NOT_CAPABLE' },
    steps: [],
  },
];

const dir = path.join(repoRoot, 'packages/server/conformance/live');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const manifest = {
  conformance: 'axiom.conformance.v7',
  baseContract: 'axiom.server.v7',
  protocol: 'axiom.protocol.v1',
  release: version,
  description:
    'Portable live-query conformance fixtures (spec13 §152, §194). Each file carries a compiled axiom.server.v7 Server IR, a dataset of provider rows, the live query to open, its required initial result, and a script of committed mutations each paired with the live message that must follow (canonical update / whole reset / none). The runner also checks the primary invariant: folding the delivered stream must equal a fresh one-shot execution of the same QueryDef. Running one needs only a DataProvider and the semantics in docs/LIVE_QUERIES.md.',
  fixtures: [],
};

for (const fixture of fixtures) {
  const document = {
    conformance: 'axiom.conformance.v7',
    name: fixture.name,
    covers: fixture.covers,
    description: fixture.description,
    serverIR,
    dataset,
    open: fixture.open,
    expectInitial: fixture.expectInitial,
    steps: fixture.steps,
  };
  await writeFile(path.join(dir, `${fixture.name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  manifest.fixtures.push({ name: fixture.name, covers: fixture.covers });
}
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${fixtures.length} live-query conformance fixtures to ${path.relative(repoRoot, dir)}`);
