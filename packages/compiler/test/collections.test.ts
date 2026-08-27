import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  BUILTIN_FUNCTIONS,
  conditional,
  every,
  flatten,
  EXPRESSION_KINDS,
  OPERATION_KINDS,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  filter,
  blobRefEntity,
  expressionRef,
  find,
  forEach,
  group,
  identitySelector,
  itemLocation,
  literal,
  map,
  nodeId,
  object,
  primitiveType,
  ref,
  some,
  sort,
  stateLocation,
  sum,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  Expression,
  IntegrationDef,
  IntegrationOperationDef,
  QueryDef,
  RouteDef,
  StateDef,
  StorageDef,
  ViewNode,
} from '@cynodia/axiom-core';
import { compileToIR } from '@cynodia/axiom-compiler';
import { RUNTIME_DIAGNOSTIC_CODES, createAxiomRuntime, createMemoryHost } from '@cynodia/axiom-runtime';

/**
 * Collection semantics end to end: projection, aggregation, ordering and transactional
 * iteration, plus the guarantee that nothing the public model declares is unimplemented.
 */
const ENTITY_LINE = nodeId('entity_line');
const ENTITY_GROUP = nodeId('entity_group');
const F_LINE_ID = fieldId('field_line_id');
const F_LINE_QUANTITY = fieldId('field_line_quantity');
const F_LINE_PRICE = fieldId('field_line_price');
const F_GROUP_ID = fieldId('field_group_id');
const F_GROUP_LINES = fieldId('field_group_lines');

const EXPRESSION_TOTAL = nodeId('expression_line_total');
const PARAM_LINES = nodeId('param_lines');
const SCOPE_TOTAL = nodeId('scope_line_total');

const STATE_LINES = nodeId('state_lines');
const STATE_GROUPS = nodeId('state_groups');
const STATE_TOTAL = nodeId('state_total');
const STATE_BIG_TOTAL = nodeId('state_big_total');
const STATE_SORTED = nodeId('state_sorted');
const STATE_EMPTY_TOTAL = nodeId('state_empty_total');
const STATE_EMPTY = nodeId('state_empty');
const STATE_COUNTER = nodeId('state_counter');

const ACTION_DOUBLE = nodeId('action_double');
const ACTION_DRAIN = nodeId('action_drain');
const VIEW = nodeId('ui_view');
const CONSTRAINT_QUANTITY = nodeId('constraint_quantity');
const SCOPE = nodeId('scope_line');

const lineTotal: Expression = binary(
  'multiply',
  field(ref(SCOPE), F_LINE_QUANTITY),
  field(ref(SCOPE), F_LINE_PRICE),
);

/** Addresses the line each member of an iteration refers to, in canonical state. */
const lineByScope = itemLocation(
  stateLocation(STATE_LINES),
  identitySelector(F_LINE_ID, field(ref(SCOPE), F_LINE_ID)),
);

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('collections', 'Collections');

  graph.addNode<EntityDef>({
    id: ENTITY_LINE,
    kind: 'entity',
    name: 'Line',
    identityFieldId: F_LINE_ID,
    fields: [
      { id: F_LINE_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LINE_QUANTITY, name: 'Quantity', valueType: primitiveType('number'), required: true },
      { id: F_LINE_PRICE, name: 'Price', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_GROUP,
    kind: 'entity',
    name: 'Group',
    identityFieldId: F_GROUP_ID,
    fields: [
      { id: F_GROUP_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      {
        id: F_GROUP_LINES,
        name: 'Lines',
        valueType: collectionType(entityType(ENTITY_LINE)),
        required: true,
      },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_LINES,
    kind: 'state',
    name: 'lines',
    valueType: collectionType(entityType(ENTITY_LINE)),
    initialValue: [
      { [F_LINE_ID]: 'l1', [F_LINE_QUANTITY]: 2, [F_LINE_PRICE]: 100 },
      { [F_LINE_ID]: 'l2', [F_LINE_QUANTITY]: 3, [F_LINE_PRICE]: 50 },
      { [F_LINE_ID]: 'l3', [F_LINE_QUANTITY]: 1, [F_LINE_PRICE]: 75 },
    ],
  });

  // A collection of entities nested inside another entity.
  graph.addNode<StateDef>({
    id: STATE_GROUPS,
    kind: 'state',
    name: 'groups',
    valueType: collectionType(entityType(ENTITY_GROUP)),
    initialValue: [
      {
        [F_GROUP_ID]: 'g1',
        [F_GROUP_LINES]: [{ [F_LINE_ID]: 'n1', [F_LINE_QUANTITY]: 4, [F_LINE_PRICE]: 10 }],
      },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_EMPTY,
    kind: 'state',
    name: 'empty',
    valueType: collectionType(entityType(ENTITY_LINE)),
    initialValue: [],
  });

  graph.addNode<StateDef>({
    id: STATE_COUNTER,
    kind: 'state',
    name: 'counter',
    valueType: primitiveType('number'),
    initialValue: 0,
  });

  graph.addNode<StateDef>({
    id: STATE_TOTAL,
    kind: 'state',
    name: 'total',
    valueType: primitiveType('number'),
    derivation: sum(map(ref(STATE_LINES), SCOPE, lineTotal)),
  });

  // filter → map → sum, the composition 0.4 exists to make possible.
  graph.addNode<StateDef>({
    id: STATE_BIG_TOTAL,
    kind: 'state',
    name: 'bigTotal',
    valueType: primitiveType('number'),
    derivation: sum(
      map(
        filter(ref(STATE_LINES), SCOPE, binary('gte', field(ref(SCOPE), F_LINE_PRICE), literal(75))),
        SCOPE,
        lineTotal,
      ),
    ),
  });

  graph.addNode<StateDef>({
    id: STATE_EMPTY_TOTAL,
    kind: 'state',
    name: 'emptyTotal',
    valueType: primitiveType('number'),
    derivation: sum(map(ref(STATE_EMPTY), SCOPE, field(ref(SCOPE), F_LINE_QUANTITY))),
  });

  graph.addNode<StateDef>({
    id: STATE_SORTED,
    kind: 'state',
    name: 'sorted',
    valueType: collectionType(entityType(ENTITY_LINE)),
    derivation: sort(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_LINE_QUANTITY), 'desc'),
  });

  graph.addNode<ActionDef>({
    id: ACTION_DOUBLE,
    kind: 'action',
    name: 'doubleQuantities',
    operations: [
      forEach(ref(STATE_LINES), SCOPE, [
        {
          kind: 'set',
          target: fieldLocation(lineByScope, F_LINE_QUANTITY),
          value: binary('multiply', field(ref(SCOPE), F_LINE_QUANTITY), literal(2)),
        },
      ]),
    ],
  });

  // The third line has a quantity of 1, so draining by 3 breaks the invariant part way.
  graph.addNode<ActionDef>({
    id: ACTION_DRAIN,
    kind: 'action',
    name: 'drainQuantities',
    operations: [
      forEach(ref(STATE_LINES), SCOPE, [
        {
          kind: 'set',
          target: fieldLocation(lineByScope, F_LINE_QUANTITY),
          value: binary('subtract', field(ref(SCOPE), F_LINE_QUANTITY), literal(3)),
        },
      ]),
    ],
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_QUANTITY,
    kind: 'constraint',
    name: 'Quantity stays positive',
    entityId: ENTITY_LINE,
    message: 'A line quantity must stay above zero.',
    expression: binary('gt', field(ref(ENTITY_LINE), F_LINE_QUANTITY), literal(0)),
  });

  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

function createApp(graph: ApplicationGraph = buildGraph()) {
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({
    ir: compileToIR(graph),
    rootElement: host.root,
    host,
    nativeOperations: { 'test.echo': (inputs) => inputs.value },
  });
  app.start();
  return { app, host };
}

const lines = (app: ReturnType<typeof createApp>['app']): Array<Record<string, number>> =>
  app.getState(STATE_LINES) as Array<Record<string, number>>;

// ------------------------------------------------------------- aggregation

test('an aggregation over a projection produces a number', () => {
  const { app } = createApp();
  assert.equal(app.getState(STATE_TOTAL), 2 * 100 + 3 * 50 + 1 * 75);
});

test('filter, map and sum compose', () => {
  const { app } = createApp();
  assert.equal(app.getState(STATE_BIG_TOTAL), 2 * 100 + 1 * 75, 'only lines priced 75 or more');
});

test('an empty collection sums to zero', () => {
  const { app } = createApp();
  assert.equal(app.getState(STATE_EMPTY_TOTAL), 0);
});

test('an aggregation over non-numeric data fails rather than producing a number', () => {
  const { app } = createApp();
  const broken = lines(app);
  broken[0][F_LINE_QUANTITY] = 'lots' as unknown as number;
  app.hydrateState(STATE_LINES, broken);

  assert.equal(app.getState(STATE_TOTAL), null, 'the derivation has no value at all');
  const failure = app
    .diagnostics()
    .find((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.EXPRESSION_EVALUATION_FAILED);
  assert.ok(failure, 'and the failure is reported against the state that could not be computed');
  assert.equal(failure.stateId, STATE_TOTAL);
});

// ------------------------------------------------- presence and null policy

test('presence asks whether a value exists, not whether it is empty', () => {
  const graph = buildGraph();
  const probes: Array<[string, Expression, boolean]> = [
    ['required(null)', call('required', literal(null)), false],
    ['required([])', call('required', literal([])), true],
    ["required('')", call('required', literal('')), true],
    ['required(0)', call('required', literal(0)), true],
    ['required(false)', call('required', literal(false)), true],
    ['is-empty([])', call('is-empty', literal([])), true],
    ["is-empty('')", call('is-empty', literal('')), true],
    ['is-empty([1])', call('is-empty', literal([1])), false],
    ['non-empty([1])', call('non-empty', literal([1])), true],
    ['non-empty([])', call('non-empty', literal([])), false],
  ];

  const ids = probes.map(([label, expression], index) => {
    const id = nodeId(`state_presence_${index}`);
    graph.addNode<StateDef>({ id, kind: 'state', valueType: primitiveType('boolean'), derivation: expression });
    return { id, label };
  });

  const { app } = createApp(graph);
  for (const [index, { id, label }] of ids.entries()) {
    assert.equal(app.getState(id), probes[index][2], label);
  }
});

test('coalesce falls back on absence, so an empty collection can be the answer', () => {
  const graph = buildGraph();
  const probes: Array<[string, Expression, unknown]> = [
    ['coalesce(null, [])', call('coalesce', literal(null), literal([])), []],
    ['coalesce([], [1])', call('coalesce', literal([]), literal([1])), []],
    ["coalesce('', 'x')", call('coalesce', literal(''), literal('x')), ''],
    ['coalesce(0, 1)', call('coalesce', literal(0), literal(1)), 0],
    ['coalesce(false, true)', call('coalesce', literal(false), literal(true)), false],
    ['coalesce(null, null, 3)', call('coalesce', literal(null), literal(null), literal(3)), 3],
  ];

  const ids = probes.map(([, expression], index) => {
    const id = nodeId(`state_coalesce_${index}`);
    graph.addNode<StateDef>({
      id,
      kind: 'state',
      valueType: collectionType(primitiveType('number')),
      derivation: expression,
    });
    return id;
  });

  const { app } = createApp(graph);
  for (const [index, id] of ids.entries()) {
    assert.deepEqual(app.getState(id), probes[index][2], probes[index][0]);
  }
});

test('a collection operator applied to nothing fails, consistently', () => {
  const graph = buildGraph();
  const absent = call('coalesce', literal(null));
  const operators: Array<[string, Expression]> = [
    ['filter', filter(absent, SCOPE, literal(true))],
    ['map', map(absent, SCOPE, literal(1))],
    ['sort', sort(absent, SCOPE, literal(1))],
    ['find', find(absent, SCOPE, literal(true))],
    ['count', call('count', absent)],
    ['sum', sum(absent)],
  ];

  const ids = operators.map(([name, expression]) => {
    const id = nodeId(`state_null_${name}`);
    graph.addNode<StateDef>({
      id,
      kind: 'state',
      valueType: primitiveType('string'),
      derivation: call('to-string', expression),
    });
    return { id, name };
  });

  const { app } = createApp(graph);
  for (const { id, name } of ids) {
    assert.equal(app.getState(id), null, `${name} over nothing must not produce a value`);
    assert.ok(
      app
        .diagnostics()
        .some(
          (diagnostic) =>
            diagnostic.stateId === id &&
            diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.EXPRESSION_EVALUATION_FAILED,
        ),
      `${name} over nothing must report a failure`,
    );
  }
});

test('an empty collection is a perfectly good collection', () => {
  const graph = buildGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_empty_count'),
    kind: 'state',
    valueType: primitiveType('number'),
    derivation: call('count', ref(STATE_EMPTY)),
  });
  graph.addNode<StateDef>({
    id: nodeId('state_empty_map'),
    kind: 'state',
    valueType: collectionType(primitiveType('number')),
    derivation: map(ref(STATE_EMPTY), SCOPE, field(ref(SCOPE), F_LINE_QUANTITY)),
  });

  const { app } = createApp(graph);
  assert.equal(app.getState(nodeId('state_empty_count')), 0);
  assert.deepEqual(app.getState(nodeId('state_empty_map')), []);
  assert.equal(app.getState(STATE_EMPTY_TOTAL), 0);
});

test('sorting is by a projected key and honours direction', () => {
  const { app } = createApp();
  assert.deepEqual(
    (app.getState(STATE_SORTED) as Array<Record<string, string>>).map((line) => line[F_LINE_ID]),
    ['l2', 'l1', 'l3'],
    'descending by quantity',
  );
});

// --------------------------------------------------------------- iteration

test('an iteration mutates every member of a collection', () => {
  const { app } = createApp();
  const result = app.invokeAction(ACTION_DOUBLE);

  assert.equal(result.ok, true);
  assert.deepEqual(
    lines(app).map((line) => line[F_LINE_QUANTITY]),
    [4, 6, 2],
  );
  assert.equal(app.getState(STATE_TOTAL), 4 * 100 + 6 * 50 + 2 * 75, 'derived values follow');
});

test('a failure in any iteration rolls back every iteration', () => {
  const { app } = createApp();
  const before = lines(app).map((line) => line[F_LINE_QUANTITY]);

  const result = app.invokeAction(ACTION_DRAIN);

  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.CONSTRAINT_VIOLATION,
    ),
  );
  assert.deepEqual(
    lines(app).map((line) => line[F_LINE_QUANTITY]),
    before,
    'the first two iterations did not survive the third one failing',
  );
});

test('the mutation log does not imply that earlier iterations committed', () => {
  const { app } = createApp();
  app.invokeAction(ACTION_DRAIN);

  const entries = app.getMutationLog();
  assert.equal(entries.length, 3, 'every attempted write is visible');
  assert.deepEqual(
    [...new Set(entries.map((entry) => entry.outcome))],
    ['rolled-back'],
    'and all of them are marked rolled back',
  );
  assert.equal(
    new Set(entries.map((entry) => entry.transactionId)).size,
    1,
    'the iteration ran in one transaction, not one per member',
  );
});

// ----------------------------------------------------- nested entity values

test('entity constraints apply to instances nested inside other entities', () => {
  const { app } = createApp();
  const groups = app.getState(STATE_GROUPS) as Array<Record<string, Array<Record<string, number>>>>;
  groups[0][F_GROUP_LINES][0][F_LINE_QUANTITY] = 0;
  app.hydrateState(STATE_GROUPS, groups);

  // Any action now has to fail: a nested Line breaks the Line constraint.
  const result = app.invokeAction(ACTION_DOUBLE);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.CONSTRAINT_VIOLATION,
    ),
    'a constraint on a nested entity is enforced where the entity actually lives',
  );
});

// ------------------------------------------------- no silent semantic failure

/** Plausible arguments for every built-in, so each one is actually evaluated. */
const BUILTIN_PROBES: Record<string, { expression: Expression; expected?: unknown }> = {
  required: { expression: call('required', literal('x')), expected: true },
  'is-empty': { expression: call('is-empty', literal('')), expected: true },
  'non-empty': { expression: call('non-empty', literal('x')), expected: true },
  length: { expression: call('length', literal('abc')), expected: 3 },
  contains: { expression: call('contains', literal('abc'), literal('b')), expected: true },
  concat: { expression: call('concat', literal('a'), literal('b')), expected: 'ab' },
  coalesce: { expression: call('coalesce', literal(null), literal('b')), expected: 'b' },
  'one-of': { expression: call('one-of', literal('a'), literal('a')), expected: true },
  count: { expression: call('count', ref(STATE_LINES)), expected: 3 },
  sum: { expression: sum(literal([1, 2, 3])), expected: 6 },
  lowercase: { expression: call('lowercase', literal('AB')), expected: 'ab' },
  'to-string': { expression: call('to-string', literal(12)), expected: '12' },
  now: { expression: call('now') },
  uuid: { expression: call('uuid') },
};

test('every declared built-in function is evaluated by the runtime', () => {
  assert.deepEqual(
    Object.keys(BUILTIN_PROBES).sort(),
    [...BUILTIN_FUNCTIONS].sort(),
    'this test must cover every function the public vocabulary declares',
  );

  const graph = buildGraph();
  const probes = Object.entries(BUILTIN_PROBES).map(([name, probe]) => {
    const id = nodeId(`state_probe_${name.replace('-', '_')}`);
    graph.addNode<StateDef>({
      id,
      kind: 'state',
      valueType: primitiveType('string'),
      derivation: call('to-string', probe.expression),
    });
    return { id, name, probe };
  });

  const { app } = createApp(graph);
  for (const { id, name, probe } of probes) {
    const value = app.getState(id);
    assert.notEqual(value, null, `${name} evaluated to nothing`);
    if (probe.expected !== undefined) {
      assert.equal(value, String(probe.expected), `${name} produced the wrong value`);
    }
  }
  assert.deepEqual(
    app
      .diagnostics()
      .filter((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.UNSUPPORTED_EXPRESSION),
    [],
    'no declared function fell through to "unsupported"',
  );
});

test('every declared expression kind is evaluated by the runtime', () => {
  const graph = buildGraph();
  const byKind: Record<string, Expression> = {
    literal: literal('x'),
    ref: ref(STATE_TOTAL),
    field: field(find(ref(STATE_LINES), SCOPE, literal(true)), F_LINE_QUANTITY),
    object: object([{ fieldId: F_LINE_QUANTITY, value: literal(1) }], ENTITY_LINE),
    binary: binary('add', literal(1), literal(2)),
    unary: { kind: 'unary', operator: 'not', operand: literal(false) },
    call: call('to-string', literal(1)),
    filter: filter(ref(STATE_LINES), SCOPE, literal(true)),
    find: find(ref(STATE_LINES), SCOPE, literal(true)),
    map: map(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_LINE_QUANTITY)),
    sort: sort(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_LINE_QUANTITY)),
    every: every(ref(STATE_LINES), SCOPE, binary('gt', field(ref(SCOPE), F_LINE_QUANTITY), literal(0))),
    some: some(ref(STATE_LINES), SCOPE, binary('gt', field(ref(SCOPE), F_LINE_QUANTITY), literal(2))),
    flatten: flatten(map(ref(STATE_LINES), SCOPE, ref(STATE_LINES))),
    conditional: conditional(literal(true), literal('yes'), literal('no')),
    group: group(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_LINE_QUANTITY)),
    'expression-ref': expressionRef(EXPRESSION_TOTAL, { [PARAM_LINES]: ref(STATE_LINES) }),
  };
  assert.deepEqual(Object.keys(byKind).sort(), [...EXPRESSION_KINDS].sort());

  // The reference above needs something to point at: a named calculation over whatever
  // collection it is given.
  graph.addNode({
    id: EXPRESSION_TOTAL,
    kind: 'expression',
    name: 'line total',
    parameters: [{ id: PARAM_LINES, name: 'lines', valueType: collectionType(entityType(ENTITY_LINE)) }],
    expression: sum(map(ref(PARAM_LINES), SCOPE_TOTAL, field(ref(SCOPE_TOTAL), F_LINE_QUANTITY))),
  });

  const probes = Object.entries(byKind).map(([kind, expression]) => {
    const id = nodeId(`state_kind_${kind}`);
    graph.addNode<StateDef>({
      id,
      kind: 'state',
      valueType: primitiveType('string'),
      derivation: call('to-string', expression),
    });
    return { id, kind };
  });

  const { app } = createApp(graph);
  for (const { id, kind } of probes) {
    assert.notEqual(app.getState(id), null, `${kind} evaluated to nothing`);
  }
  assert.deepEqual(
    app
      .diagnostics()
      .filter((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.UNSUPPORTED_EXPRESSION),
    [],
  );
});

test('every declared operation kind is executed by the runtime', () => {
  const graph = buildGraph();
  const route = nodeId('route_root');
  const integration = nodeId('integration_probe');
  const integrationQueryOp = nodeId('integration_operation_probe_query');
  const integrationEffectOp = nodeId('integration_operation_probe_effect');
  const scopeQuery = nodeId('scope_integration_query');
  const dataQuery = nodeId('query_probe');
  const scopeDataQuery = nodeId('scope_data_query');
  const storage = nodeId('storage_probe');
  const blobEntity = nodeId('entity_blob_ref');
  const scopeBlob = nodeId('scope_blob_metadata');
  graph.addNode<EntityDef>(blobRefEntity(blobEntity));
  graph.addNode<StorageDef>({ id: storage, kind: 'storage', name: 'probe store', blobEntityId: blobEntity });
  graph.addNode<IntegrationDef>({ id: integration, kind: 'integration', name: 'probe' });
  graph.addNode<IntegrationOperationDef>({
    id: integrationQueryOp,
    kind: 'integration-operation',
    integrationId: integration,
    mode: 'query',
    resultType: primitiveType('string'),
  });
  graph.addNode<IntegrationOperationDef>({
    id: integrationEffectOp,
    kind: 'integration-operation',
    integrationId: integration,
    mode: 'effect',
    resultType: primitiveType('string'),
  });
  graph.addNode<QueryDef>({
    id: dataQuery,
    kind: 'query',
    source: ENTITY_LINE,
    rowScopeId: scopeDataQuery,
    pagination: { strategy: 'offset', maxPageSize: 10 },
  });
  const actions: Record<string, ActionDef['operations']> = {
    set: [{ kind: 'set', target: stateLocation(STATE_COUNTER), value: literal(1) }],
    insert: [
      {
        kind: 'insert',
        target: stateLocation(STATE_EMPTY),
        value: object(
          [
            { fieldId: F_LINE_ID, value: literal('new') },
            { fieldId: F_LINE_QUANTITY, value: literal(1) },
            { fieldId: F_LINE_PRICE, value: literal(1) },
          ],
          ENTITY_LINE,
        ),
      },
    ],
    remove: [
      {
        kind: 'remove',
        target: itemLocation(stateLocation(STATE_LINES), identitySelector(F_LINE_ID, literal('l3'))),
      },
    ],
    'for-each': [
      forEach(ref(STATE_EMPTY), SCOPE, [
        { kind: 'set', target: fieldLocation(lineByScope, F_LINE_QUANTITY), value: literal(1) },
      ]),
    ],
    invoke: [{ kind: 'invoke', actionId: ACTION_DOUBLE }],
    navigate: [{ kind: 'navigate', routeId: route }],
    native: [{ kind: 'native', implementationId: 'test.echo', inputs: { value: literal(1) } }],
    'integration-query': [
      { kind: 'integration-query', operationId: integrationQueryOp, bindAs: scopeQuery },
    ],
    'integration-effect': [{ kind: 'integration-effect', operationId: integrationEffectOp }],
    'blob-metadata': [
      { kind: 'blob-metadata', storageId: storage, blobKey: literal('probe-key'), bindAs: scopeBlob },
    ],
    'blob-commit': [{ kind: 'blob-commit', storageId: storage, blobKey: literal('probe-key') }],
    'blob-delete': [{ kind: 'blob-delete', storageId: storage, blobKey: literal('probe-key') }],
    query: [{ kind: 'query', queryId: dataQuery, arguments: {}, bindAs: nodeId('scope_query_bind') }],
  };
  assert.deepEqual(Object.keys(actions).sort(), [...OPERATION_KINDS].sort());

  const probes = Object.entries(actions).map(([kind, operations]) => {
    const id = nodeId(`action_kind_${kind.replace('-', '_')}`);
    graph.addNode<ActionDef>({ id, kind: 'action', name: kind, operations });
    return { id, kind };
  });
  assert.deepEqual(validateGraph(graph).errors, [], 'the probe graph itself must be valid');

  const { app } = createApp(graph);
  for (const { id, kind } of probes) {
    const result = app.invokeAction(id);
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.UNSUPPORTED_OPERATION,
      ),
      false,
      `${kind} was declared but not executed`,
    );
  }
});

// ------------------------------------------------------ diagnostic lifetime

test('an invocation reports its own diagnostics without diffing history', () => {
  const { app } = createApp();
  app.invokeAction(ACTION_DRAIN);
  const first = app.invokeAction(ACTION_DRAIN);

  assert.ok(first.diagnostics.length > 0);
  assert.ok(
    first.diagnostics.every((diagnostic) => diagnostic.severity === 'error'),
    'only what this call produced',
  );
  assert.ok(app.diagnostics().length > first.diagnostics.length, 'history keeps everything');

  app.clearDiagnostics();
  assert.deepEqual(app.diagnostics(), []);
});

test('a constraint diagnostic identifies the constraint that failed', () => {
  const { app } = createApp();
  const failure = app
    .invokeAction(ACTION_DRAIN)
    .diagnostics.find((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.CONSTRAINT_VIOLATION);

  assert.ok(failure);
  assert.equal(failure.constraintId, CONSTRAINT_QUANTITY);
  assert.equal(failure.details?.entityId, ENTITY_LINE);
  assert.match(failure.message, /above zero/);
});

// -------------------------------------------------- quantifiers and branches

test('a quantifier says what a filter-and-count says, but directly', () => {
  const graph = buildGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_all_positive'),
    kind: 'state',
    valueType: primitiveType('boolean'),
    derivation: every(ref(STATE_LINES), SCOPE, binary('gt', field(ref(SCOPE), F_LINE_QUANTITY), literal(0))),
  });
  graph.addNode<StateDef>({
    id: nodeId('state_any_large'),
    kind: 'state',
    valueType: primitiveType('boolean'),
    derivation: some(ref(STATE_LINES), SCOPE, binary('gt', field(ref(SCOPE), F_LINE_QUANTITY), literal(2))),
  });
  graph.addNode<StateDef>({
    id: nodeId('state_every_empty'),
    kind: 'state',
    valueType: primitiveType('boolean'),
    derivation: every(ref(STATE_EMPTY), SCOPE, literal(false)),
  });
  graph.addNode<StateDef>({
    id: nodeId('state_some_empty'),
    kind: 'state',
    valueType: primitiveType('boolean'),
    derivation: some(ref(STATE_EMPTY), SCOPE, literal(true)),
  });

  const { app } = createApp(graph);
  assert.equal(app.getState(nodeId('state_all_positive')), true);
  assert.equal(app.getState(nodeId('state_any_large')), true);
  assert.equal(app.getState(nodeId('state_every_empty')), true, 'every([]) is true');
  assert.equal(app.getState(nodeId('state_some_empty')), false, 'some([]) is false');
});

test('flatten collapses exactly one level', () => {
  const graph = buildGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_flat'),
    kind: 'state',
    valueType: collectionType(entityType(ENTITY_LINE)),
    derivation: flatten(
      map(ref(STATE_GROUPS), SCOPE, field(ref(SCOPE), F_GROUP_LINES)),
    ),
  });

  const { app } = createApp(graph);
  assert.deepEqual(
    (app.getState(nodeId('state_flat')) as Array<Record<string, unknown>>).map((line) => line[F_LINE_ID]),
    ['n1'],
  );
});

test('a conditional chooses a value without a callback', () => {
  const graph = buildGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_label'),
    kind: 'state',
    valueType: primitiveType('string'),
    derivation: conditional(
      binary('gt', call('count', ref(STATE_LINES)), literal(2)),
      literal('many'),
      literal('few'),
    ),
  });

  const { app } = createApp(graph);
  assert.equal(app.getState(nodeId('state_label')), 'many');
});

test('paired guards report the failure that belongs to the condition', () => {
  const graph = buildGraph();
  const guarded = nodeId('action_guarded');
  graph.addNode<ActionDef>({
    id: guarded,
    kind: 'action',
    name: 'guarded',
    guards: [
      { condition: literal(true), failureMode: { code: 'never', message: 'This never fires.' } },
      {
        condition: binary('lt', call('count', ref(STATE_LINES)), literal(2)),
        failureMode: { code: 'too-many', message: 'There are too many lines.' },
      },
    ],
    operations: [{ kind: 'set', target: stateLocation(STATE_COUNTER), value: literal(1) }],
  });
  assert.deepEqual(validateGraph(graph).errors, []);

  const { app } = createApp(graph);
  const result = app.invokeAction(guarded);

  assert.equal(result.ok, false);
  const failure = result.diagnostics.find(
    (diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED,
  );
  assert.equal(failure?.message, 'There are too many lines.');
  assert.equal(failure?.details?.failureMode, 'too-many');
});
