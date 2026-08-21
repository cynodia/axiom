import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  BUILTIN_FUNCTIONS,
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
  find,
  forEach,
  identitySelector,
  itemLocation,
  literal,
  map,
  nodeId,
  object,
  primitiveType,
  ref,
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
  RouteDef,
  StateDef,
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

test('an aggregation over non-numeric data reports rather than quietly yielding nothing', () => {
  const { app } = createApp();
  const broken = lines(app);
  broken[0][F_LINE_QUANTITY] = 'lots' as unknown as number;
  app.setState(STATE_LINES, broken);

  const total = app.getState(STATE_TOTAL);
  assert.notEqual(total, null, 'a malformed aggregation must not look like an absent value');
  assert.ok(Number.isNaN(total as number), 'it yields a number no comparison will accept');
  assert.ok(
    app
      .diagnostics()
      .some((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.EXPRESSION_EVALUATION_FAILED),
  );
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
  app.setState(STATE_GROUPS, groups);

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
  };
  assert.deepEqual(Object.keys(byKind).sort(), [...EXPRESSION_KINDS].sort());

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
