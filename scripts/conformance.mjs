import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the portable conformance fixtures.
 *
 * A fixture is **pure data**: a Server IR, the state it starts from, the invocations to
 * perform, and the results expected. Nothing in it is TypeScript, and running it needs no
 * part of this implementation — which is the point. A conforming runtime in another
 * language should be able to take these files and nothing else.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const compiler = await import(path.join(repoRoot, 'packages/compiler/dist/index.js'));

const {
  ApplicationGraph, PRINCIPAL, binary, call, collectionType, entityType, field, fieldId,
  fieldLocation, find, forEach, identitySelector, itemLocation, literal, nodeId, object,
  primitiveType, ref, stateLocation, validateGraph,
} = core;

const E_USER = nodeId('entity_user');
const F_USER_ID = fieldId('field_user_id');
const F_USER_ROLE = fieldId('field_user_role');
const E_PART = nodeId('entity_part');
const F_PART_ID = fieldId('field_part_id');
const F_PART_STOCK = fieldId('field_part_stock');
const E_LINE = nodeId('entity_line');
const F_LINE_ID = fieldId('field_line_id');
const F_LINE_PART = fieldId('field_line_part');
const F_LINE_QTY = fieldId('field_line_qty');

const S_PARTS = nodeId('state_parts');
const S_LEDGER = nodeId('state_ledger');
const S_TOTAL = nodeId('state_total');
const A_TAKE = nodeId('action_take');
const A_TAKE_MANY = nodeId('action_take_many');
const A_SET = nodeId('action_set_stock');
const P_PART = nodeId('param_part');
const P_QTY = nodeId('param_qty');
const P_LINES = nodeId('param_lines');
const P_STOCK = nodeId('param_stock');
const SC_PART = nodeId('scope_part');
const SC_LINE = nodeId('scope_line');
const SC_TOTAL = nodeId('scope_total');
const C_STOCK = nodeId('constraint_stock');
const T_FALLS = nodeId('transition_falls');
const SC_PREV = nodeId('scope_previous');
const SC_NEXT = nodeId('scope_proposed');

const stockOf = (part) =>
  field(find(ref(S_PARTS), SC_PART, binary('eq', field(ref(SC_PART), F_PART_ID), part)), F_PART_STOCK);

/** One graph, exercising every semantic area the suite must cover. */
function buildGraph() {
  const graph = new ApplicationGraph('conformance', 'Conformance', '0.6.0');
  graph.setPrincipalEntity(E_USER);

  graph.addNode({ id: E_USER, kind: 'entity', identityFieldId: F_USER_ID, fields: [
    { id: F_USER_ID, valueType: primitiveType('string'), required: true },
    { id: F_USER_ROLE, valueType: primitiveType('string'), required: true }] });
  graph.addNode({ id: E_PART, kind: 'entity', identityFieldId: F_PART_ID, fields: [
    { id: F_PART_ID, valueType: primitiveType('string'), required: true },
    { id: F_PART_STOCK, valueType: primitiveType('number'), required: true }] });
  graph.addNode({ id: E_LINE, kind: 'entity', identityFieldId: F_LINE_ID, fields: [
    { id: F_LINE_ID, valueType: primitiveType('string'), required: true },
    { id: F_LINE_PART, valueType: primitiveType('string'), required: true },
    { id: F_LINE_QTY, valueType: primitiveType('number'), required: true }] });

  graph.addNode({ id: S_PARTS, kind: 'state', name: 'parts', authority: 'server',
    valueType: collectionType(entityType(E_PART)),
    initialValue: [{ [F_PART_ID]: 'bolt', [F_PART_STOCK]: 10 }, { [F_PART_ID]: 'nut', [F_PART_STOCK]: 5 }] });
  graph.addNode({ id: S_LEDGER, kind: 'state', name: 'ledger', authority: 'server',
    valueType: collectionType(primitiveType('number')), initialValue: [] });
  graph.addNode({ id: S_TOTAL, kind: 'state', name: 'total', authority: 'server',
    valueType: primitiveType('number'),
    derivation: call('sum', core.map(ref(S_PARTS), SC_TOTAL, field(ref(SC_TOTAL), F_PART_STOCK))) });

  graph.addNode({ id: A_TAKE, kind: 'action', name: 'take',
    parameters: [
      { id: P_PART, valueType: primitiveType('string'), required: true },
      { id: P_QTY, valueType: primitiveType('number'), required: true }],
    guards: [
      { condition: binary('gt', ref(P_QTY), literal(0)),
        failureMode: { code: 'invalid-quantity', message: 'A quantity must be above zero.' } },
      { condition: binary('gte', stockOf(ref(P_PART)), ref(P_QTY)),
        failureMode: { code: 'insufficient-stock', message: 'Not enough stock.' } }],
    operations: [
      { kind: 'set',
        target: fieldLocation(itemLocation(stateLocation(S_PARTS), identitySelector(F_PART_ID, ref(P_PART))), F_PART_STOCK),
        value: binary('subtract', stockOf(ref(P_PART)), ref(P_QTY)) },
      { kind: 'insert', target: stateLocation(S_LEDGER), value: ref(P_QTY) }] });

  graph.addNode({ id: A_TAKE_MANY, kind: 'action', name: 'takeMany',
    parameters: [{ id: P_LINES, valueType: collectionType(entityType(E_LINE)), required: true }],
    operations: [forEach(ref(P_LINES), SC_LINE, [
      { kind: 'set',
        target: fieldLocation(itemLocation(stateLocation(S_PARTS),
          identitySelector(F_PART_ID, field(ref(SC_LINE), F_LINE_PART))), F_PART_STOCK),
        value: binary('subtract', stockOf(field(ref(SC_LINE), F_LINE_PART)), field(ref(SC_LINE), F_LINE_QTY)) }])] });

  graph.addNode({ id: A_SET, kind: 'action', name: 'setStock',
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin')),
    parameters: [
      { id: P_PART, valueType: primitiveType('string'), required: true },
      { id: P_STOCK, valueType: primitiveType('number'), required: true }],
    operations: [
      { kind: 'set',
        target: fieldLocation(itemLocation(stateLocation(S_PARTS), identitySelector(F_PART_ID, ref(P_PART))), F_PART_STOCK),
        value: ref(P_STOCK) }] });

  graph.addNode({ id: C_STOCK, kind: 'constraint', name: 'Stock is never negative', entityId: E_PART,
    message: 'Stock can never fall below zero.',
    expression: binary('gte', field(ref(E_PART), F_PART_STOCK), literal(0)) });
  graph.addNode({ id: T_FALLS, kind: 'transition-constraint', name: 'Stock only falls', entityId: E_PART,
    previousScopeId: SC_PREV, proposedScopeId: SC_NEXT,
    message: 'Stock may not be raised.',
    expression: binary('lte', field(ref(SC_NEXT), F_PART_STOCK), field(ref(SC_PREV), F_PART_STOCK)) });

  graph.addNode({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

const graph = buildGraph();
const validation = validateGraph(graph);
if (!validation.valid) {
  console.error(validation.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  process.exit(1);
}
const serverIR = compiler.compileToServerIR(graph);

const principals = {
  clerk: { [F_USER_ID]: 'u1', [F_USER_ROLE]: 'clerk' },
  admin: { [F_USER_ID]: 'u2', [F_USER_ROLE]: 'admin' },
};
const parts = (bolt, nut) => [
  { [F_PART_ID]: 'bolt', [F_PART_STOCK]: bolt },
  { [F_PART_ID]: 'nut', [F_PART_STOCK]: nut },
];

const fixtures = [
  {
    name: 'mutation-commits',
    covers: ['expression evaluation', 'mutation', 'derived state'],
    description: 'An action within its guards commits every write, and derived state follows.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 3 },
        expect: { ok: true, changedStates: [S_PARTS, S_LEDGER, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(7, 5), [S_LEDGER]: [3], [S_TOTAL]: 12 },
  },
  {
    name: 'guard-refuses',
    covers: ['action guards', 'failure modes'],
    description: 'A guard that does not hold refuses the invocation, naming its failure mode.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 99 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['PRECONDITION_FAILED'], failureModes: ['insufficient-stock'] } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 0 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['PRECONDITION_FAILED'], failureModes: ['invalid-quantity'] } }],
    expectedState: { [S_PARTS]: parts(10, 5), [S_LEDGER]: [] },
  },
  {
    name: 'constraint-rolls-back',
    covers: ['constraints', 'rollback', 'for-each provisional writes'],
    description:
      'Iteration N sees the writes of iterations before it, so two lines for one part are counted together — and the invariant then rolls the whole action back.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE_MANY,
        arguments: { [P_LINES]: [
          { [F_LINE_ID]: 'l1', [F_LINE_PART]: 'nut', [F_LINE_QTY]: 3 },
          { [F_LINE_ID]: 'l2', [F_LINE_PART]: 'nut', [F_LINE_QTY]: 3 }] },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['CONSTRAINT_VIOLATION'] } }],
    expectedState: { [S_PARTS]: parts(10, 5) },
  },
  {
    name: 'for-each-provisional',
    covers: ['for-each provisional writes'],
    description: 'The same two-line shape, within stock: 10 − 4 − 4, not 10 − 4 twice.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE_MANY,
        arguments: { [P_LINES]: [
          { [F_LINE_ID]: 'l1', [F_LINE_PART]: 'bolt', [F_LINE_QTY]: 4 },
          { [F_LINE_ID]: 'l2', [F_LINE_PART]: 'bolt', [F_LINE_QTY]: 4 }] },
        expect: { ok: true, changedStates: [S_PARTS, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(2, 5) },
  },
  {
    name: 'transition-constraint',
    covers: ['transition constraints'],
    description: 'A rule about how state may change refuses a raise, and permits a fall.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_SET, credential: 'admin', arguments: { [P_PART]: 'bolt', [P_STOCK]: 50 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['TRANSITION_CONSTRAINT_VIOLATION'] } },
      { actionId: A_SET, credential: 'admin', arguments: { [P_PART]: 'bolt', [P_STOCK]: 4 },
        expect: { ok: true, changedStates: [S_PARTS, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(4, 5) },
  },
  {
    name: 'authorization',
    covers: ['authorization'],
    description: 'Authorization is evaluated on the authority, with the caller bound to PRINCIPAL.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_SET, credential: 'clerk', arguments: { [P_PART]: 'bolt', [P_STOCK]: 1 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['AUTHORIZATION_DENIED'] } },
      { actionId: A_SET, arguments: { [P_PART]: 'bolt', [P_STOCK]: 1 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['AUTHORIZATION_DENIED'] } },
      { actionId: A_SET, credential: 'admin', arguments: { [P_PART]: 'bolt', [P_STOCK]: 1 },
        expect: { ok: true, changedStates: [S_PARTS, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(1, 5) },
  },
  {
    name: 'argument-validation',
    covers: ['argument validation'],
    description: 'Untrusted arguments are checked against declared parameter types.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 'three' },
        expect: { ok: false, diagnosticCodes: ['ARGUMENT_TYPE_MISMATCH'] } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt' },
        expect: { ok: false, diagnosticCodes: ['ARGUMENT_TYPE_MISMATCH'] } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 1, extra: true },
        expect: { ok: false, diagnosticCodes: ['ARGUMENT_TYPE_MISMATCH'] } },
      { actionId: nodeId('action_not_here'), arguments: {},
        expect: { ok: false, diagnosticCodes: ['UNKNOWN_SERVER_ACTION'] } }],
    expectedState: { [S_PARTS]: parts(10, 5) },
  },
  {
    name: 'idempotent-retry',
    covers: ['persistence', 'idempotency'],
    description: 'A repeated request id is answered from the record, not executed again.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, requestId: 'r-1', arguments: { [P_PART]: 'bolt', [P_QTY]: 3 },
        expect: { ok: true, changedStates: [S_PARTS, S_LEDGER, S_TOTAL] } },
      { actionId: A_TAKE, requestId: 'r-1', arguments: { [P_PART]: 'bolt', [P_QTY]: 3 },
        expect: { ok: true, replayed: true, changedStates: [S_PARTS, S_LEDGER, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(7, 5), [S_LEDGER]: [3] },
  },
  {
    name: 'concurrent-invocations',
    covers: ['concurrent mutation'],
    description:
      'Three callers each want four of a stock of five. Exactly one may commit; the rest are refused by the guard against authoritative state.',
    initialState: [{ stateId: S_PARTS, value: parts(5, 5), revision: 1 }],
    concurrent: true,
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 4 } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 4 } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 4 } }],
    expect: { committedCount: 1 },
    expectedState: { [S_PARTS]: parts(1, 5) },
  },
  {
    name: 'restart',
    covers: ['persistence', 'restart'],
    description:
      'Committed state is restored exactly on restart, and a rolled-back write never reappears.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 3 },
        expect: { ok: true, changedStates: [S_PARTS, S_LEDGER, S_TOTAL] } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 99 },
        expect: { ok: false, changedStates: [] } }],
    restartAndReassert: true,
    expectedState: { [S_PARTS]: parts(7, 5), [S_LEDGER]: [3] },
  },
];

const directory = path.join(repoRoot, 'packages/server/conformance');
await mkdir(directory, { recursive: true });
for (const existing of await readdir(directory).catch(() => [])) {
  if (existing.endsWith('.json')) {
    await writeFile(path.join(directory, existing), '');
  }
}

const written = [];
const manifestEntries = [];
for (const fixture of fixtures) {
  const document = {
    conformance: 'axiom.conformance.v1',
    name: fixture.name,
    covers: fixture.covers,
    description: fixture.description,
    principals,
    serverIR,
    initialState: fixture.initialState,
    ...(fixture.concurrent ? { concurrent: true } : {}),
    ...(fixture.restartAndReassert ? { restartAndReassert: true } : {}),
    invocations: fixture.invocations,
    ...(fixture.expect ? { expect: fixture.expect } : {}),
    expectedState: fixture.expectedState,
  };
  const file = path.join(directory, `${fixture.name}.json`);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  written.push(`${fixture.name}.json`);
  manifestEntries.push({
    name: fixture.name,
    file: `${fixture.name}.json`,
    covers: fixture.covers,
    description: fixture.description,
    concurrent: Boolean(fixture.concurrent),
    restartAndReassert: Boolean(fixture.restartAndReassert),
    invocations: fixture.invocations.length,
  });
}

/**
 * The manifest is how an implementation in another language enumerates the suite without
 * listing a directory or knowing anything about npm. It names the contracts the fixtures
 * are written against, so a runtime can refuse a suite it does not implement rather than
 * discovering the mismatch one assertion at a time.
 */
const manifest = {
  conformance: 'axiom.conformance.v1',
  contract: 'axiom.server.v1',
  protocol: 'axiom.protocol.v1',
  release: version,
  description:
    'Portable conformance fixtures for the Axiom Server IR. Each entry is a self-contained ' +
    'JSON document: the Server IR, the state to start from, the principals, the invocations ' +
    'to perform and the results required. Running them needs no part of this implementation.',
  areas: [...new Set(fixtures.flatMap((fixture) => fixture.covers))].sort(),
  fixtures: manifestEntries,
};
await writeFile(
  path.join(directory, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
written.push('manifest.json');

console.log(`Wrote ${written.length} conformance fixtures:\n  ${written.join('\n  ')}`);
