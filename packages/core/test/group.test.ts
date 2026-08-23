import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  GROUP_ITEMS_FIELD,
  GROUP_KEY_FIELD,
  VALIDATION_CODES,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  filter,
  group,
  groupItems,
  groupKey,
  inferExpressionType,
  literal,
  map,
  nodeId,
  primitiveType,
  ref,
  semanticContextFromGraph,
  sum,
  validateGraph,
} from '@cynodia/axiom-core';
import type { StateDef } from '@cynodia/axiom-core';

/**
 * Grouping as a semantic operation: what it is typed as, what may read it, and what
 * validation refuses. Its ordering and evaluation contract is executed in
 * `packages/compiler/test/expressions.test.ts`, which is the lowest package that can see
 * both the IR and the runtime.
 */
const E_LINE = nodeId('entity_line');
const F_LINE_ID = fieldId('field_line_id');
const F_LINE_CATEGORY = fieldId('field_line_category');
const F_LINE_AMOUNT = fieldId('field_line_amount');
const S_LINES = nodeId('state_lines');
const SC_GROUP = nodeId('scope_group');
const SC_MEMBER = nodeId('scope_member');

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('grouping', 'Grouping');
  graph.addNode({
    id: E_LINE,
    kind: 'entity',
    name: 'Line',
    identityFieldId: F_LINE_ID,
    fields: [
      { id: F_LINE_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LINE_CATEGORY, name: 'Category', valueType: primitiveType('string'), required: true },
      { id: F_LINE_AMOUNT, name: 'Amount', valueType: primitiveType('number'), required: true },
    ],
  });
  graph.addNode({
    id: S_LINES,
    kind: 'state',
    name: 'lines',
    valueType: collectionType(entityType(E_LINE)),
    initialValue: [],
  });
  graph.addNode({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

test('grouping a collection is typed as a collection of groups', () => {
  const graph = buildGraph();
  const context = semanticContextFromGraph(graph);
  const grouped = group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_LINE_CATEGORY));

  assert.deepEqual(inferExpressionType(grouped, context), {
    kind: 'collection',
    itemType: {
      kind: 'group',
      keyType: primitiveType('string'),
      itemType: entityType(E_LINE),
    },
  });
});

test('a group key is typed by the key expression and its items by the source members', () => {
  const graph = buildGraph();
  const context = semanticContextFromGraph(graph);
  const grouped = group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_LINE_CATEGORY));
  const scope = new Map([[SC_MEMBER, { kind: 'group' as const, keyType: primitiveType('string'), itemType: entityType(E_LINE) }]]);

  assert.deepEqual(inferExpressionType(groupKey(ref(SC_MEMBER)), context, scope), primitiveType('string'));
  assert.deepEqual(
    inferExpressionType(groupItems(ref(SC_MEMBER)), context, scope),
    collectionType(entityType(E_LINE)),
  );
  // And the composition an aggregate rule is written as typechecks end to end.
  assert.deepEqual(
    inferExpressionType(
      map(grouped, SC_MEMBER, sum(map(groupItems(ref(SC_MEMBER)), nodeId('scope_amount'), field(ref(nodeId('scope_amount')), F_LINE_AMOUNT)))),
      context,
    ),
    collectionType(primitiveType('number')),
  );
});

test('a derived state may hold groups, and a stored one may not', () => {
  const graph = buildGraph();
  const type = collectionType({
    kind: 'group',
    keyType: primitiveType('string'),
    itemType: entityType(E_LINE),
  });
  graph.addNode<StateDef>({
    id: nodeId('state_by_category'),
    kind: 'state',
    name: 'by category',
    valueType: type,
    derivation: group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_LINE_CATEGORY)),
  });
  assert.equal(validateGraph(graph).valid, true);

  graph.addNode<StateDef>({ id: nodeId('state_stored'), kind: 'state', valueType: type });
  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.code === VALIDATION_CODES.invalidTypeRef && error.nodeId === nodeId('state_stored'),
    ),
    'nothing can construct a group, so a stored state of that type could never be written',
  );
});

test('the group field ids are reserved: an entity may not declare one', () => {
  const graph = buildGraph();
  graph.addNode({
    id: nodeId('entity_collides'),
    kind: 'entity',
    fields: [{ id: GROUP_KEY_FIELD, valueType: primitiveType('string') }],
  });

  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  const problem = result.errors.find((error) => error.code === VALIDATION_CODES.reservedFieldId);
  assert.ok(problem, 'RESERVED_FIELD_ID is reachable');
  assert.deepEqual(problem?.details?.reserved, [String(GROUP_KEY_FIELD), String(GROUP_ITEMS_FIELD)]);
});

test('a group position may only be read from a group, and a group has only those two', () => {
  const graph = buildGraph();
  // Reading a group position from an ordinary collection member.
  graph.addNode<StateDef>({
    id: nodeId('state_wrong_source'),
    kind: 'state',
    valueType: collectionType(primitiveType('string')),
    derivation: map(ref(S_LINES), SC_MEMBER, groupKey(ref(SC_MEMBER))),
  });
  // Reading an entity field from a group.
  graph.addNode<StateDef>({
    id: nodeId('state_wrong_field'),
    kind: 'state',
    valueType: collectionType(primitiveType('string')),
    derivation: map(
      group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_LINE_CATEGORY)),
      SC_MEMBER,
      field(ref(SC_MEMBER), F_LINE_CATEGORY),
    ),
  });

  const result = validateGraph(graph);
  const problems = result.errors.filter((error) => error.code === VALIDATION_CODES.invalidGroupField);
  assert.equal(problems.length, 2, 'both directions are rejected');
  assert.deepEqual(
    problems.map((problem) => problem.nodeId).sort(),
    [nodeId('state_wrong_field'), nodeId('state_wrong_source')].sort(),
  );
});

test('grouping something that is not a collection is rejected', () => {
  const graph = buildGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_count'),
    kind: 'state',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  graph.addNode<StateDef>({
    id: nodeId('state_bad_group'),
    kind: 'state',
    valueType: collectionType(primitiveType('string')),
    derivation: group(ref(nodeId('state_count')), SC_GROUP, literal('x')),
  });

  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === VALIDATION_CODES.notACollection));
});

test('a group scope cannot shadow an enclosing one', () => {
  const graph = buildGraph();
  // A group inside a predicate whose enclosing filter has already bound the same id.
  graph.addNode<StateDef>({
    id: nodeId('state_shadowed'),
    kind: 'state',
    valueType: collectionType(entityType(E_LINE)),
    derivation: filter(
      ref(S_LINES),
      SC_GROUP,
      binary(
        'gt',
        {
          kind: 'call',
          function: 'count',
          arguments: [group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_LINE_CATEGORY))],
        },
        literal(0),
      ),
    ),
  });

  const result = validateGraph(graph);
  assert.ok(
    result.errors.some((error) => error.code === VALIDATION_CODES.scopeShadowing),
    'reusing a bound scope id inside a group is caught the same way it is everywhere else',
  );
});

test('grouping composes with the aggregate rules it exists to make expressible', () => {
  const graph = buildGraph();
  // "the subtotal of every category" — one expression, no enum enumerated at authoring time.
  const subtotals = map(
    group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_LINE_CATEGORY)),
    SC_MEMBER,
    sum(map(groupItems(ref(SC_MEMBER)), nodeId('scope_amount'), field(ref(nodeId('scope_amount')), F_LINE_AMOUNT))),
  );
  graph.addNode<StateDef>({
    id: nodeId('state_subtotals'),
    kind: 'state',
    valueType: collectionType(primitiveType('number')),
    derivation: subtotals,
  });
  graph.addNode({
    id: nodeId('constraint_no_category_over_budget'),
    kind: 'constraint',
    message: 'No category may exceed the budget.',
    expression: {
      kind: 'every',
      source: subtotals,
      scopeId: nodeId('scope_subtotal'),
      predicate: binary('lte', ref(nodeId('scope_subtotal')), literal(1000)),
    },
  });

  const result = validateGraph(graph);
  assert.deepEqual(result.errors, []);

  // The constraint's reads are attributed to the state the members came from, through the
  // group and the projection.
  const edges = graph.getOutgoingEdges(nodeId('constraint_no_category_over_budget'), {
    kinds: ['reads'],
  });
  assert.deepEqual(
    edges.map((edge) => edge.to),
    [S_LINES],
  );
  assert.deepEqual(
    (edges[0].metadata?.fieldIds as string[]).sort(),
    [String(F_LINE_AMOUNT), String(F_LINE_CATEGORY)].sort(),
    'and the fields are the real ones, not the group positions',
  );
});
