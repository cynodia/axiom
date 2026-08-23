import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  expressionRef,
  field,
  fieldId,
  filter,
  group,
  groupItems,
  literal,
  map,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  sum,
} from '@cynodia/axiom-core';
import type { ExpressionDef, StateDef } from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';

/**
 * What an agent can find out about a named expression.
 *
 * A reuse mechanism is only worth having if the reuse is visible: which calculations exist,
 * what uses each one, what each one reads, and what an edit to a state would reach through
 * them. Answered from the graph, with no knowledge of how the calculation was authored.
 */
const E_LINE = nodeId('entity_line');
const F_ID = fieldId('field_line_id');
const F_CATEGORY = fieldId('field_line_category');
const F_AMOUNT = fieldId('field_line_amount');
const S_LINES = nodeId('state_lines');
const S_LIMIT = nodeId('state_limit');
const X_LARGE = nodeId('expression_large_lines');
const P_LINES = nodeId('param_lines');

function buildGraph(): { graph: ApplicationGraph; api: AgentAPI } {
  const graph = new ApplicationGraph('reuse', 'Reuse');
  graph.addNode({
    id: E_LINE,
    kind: 'entity',
    name: 'Line',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_CATEGORY, name: 'Category', valueType: primitiveType('string'), required: true },
      { id: F_AMOUNT, name: 'Amount', valueType: primitiveType('number'), required: true },
    ],
  });
  graph.addNode({
    id: S_LINES,
    kind: 'state',
    name: 'lines',
    valueType: collectionType(entityType(E_LINE)),
    initialValue: [],
  });
  graph.addNode({
    id: S_LIMIT,
    kind: 'state',
    name: 'limit',
    valueType: primitiveType('number'),
    initialValue: 5,
  });
  graph.addNode<ExpressionDef>({
    id: X_LARGE,
    kind: 'expression',
    name: 'large lines',
    description: 'Lines whose amount is above the limit.',
    parameters: [{ id: P_LINES, name: 'lines', valueType: collectionType(entityType(E_LINE)) }],
    expression: filter(
      ref(P_LINES),
      nodeId('scope_large'),
      binary('gt', field(ref(nodeId('scope_large')), F_AMOUNT), ref(S_LIMIT)),
    ),
  });
  graph.addNode<StateDef>({
    id: nodeId('state_large'),
    kind: 'state',
    name: 'large lines',
    valueType: collectionType(entityType(E_LINE)),
    derivation: expressionRef(X_LARGE, { [P_LINES]: ref(S_LINES) }),
  });
  graph.addNode({
    id: nodeId('constraint_not_too_many'),
    kind: 'constraint',
    message: 'At most three lines may exceed the limit.',
    expression: binary(
      'lte',
      { kind: 'call', function: 'count', arguments: [expressionRef(X_LARGE, { [P_LINES]: ref(S_LINES) })] },
      literal(3),
    ),
  });
  graph.addNode({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return { graph, api: new AgentAPI(graph) };
}

test('an agent can list the named expressions and read what each one is for', () => {
  const { api } = buildGraph();
  const definitions = api.listExpressionDefinitions();
  assert.deepEqual(
    definitions.map((definition) => [definition.id, definition.name]),
    [[X_LARGE, 'large lines']],
  );
  assert.equal(
    api.getExpressionDefinition(X_LARGE)?.description,
    'Lines whose amount is above the limit.',
  );
});

test('consumers of a calculation are answerable, which is the point of naming it', () => {
  const { api } = buildGraph();
  assert.deepEqual(
    api
      .getExpressionConsumers(X_LARGE)
      .map((node) => node.id)
      .sort(),
    [nodeId('constraint_not_too_many'), nodeId('state_large')].sort(),
  );
  assert.deepEqual(
    api.getExpressionDependencies(X_LARGE).map((state) => state.id),
    [S_LIMIT],
    'the definition reads the limit; the collection arrives as an argument',
  );
});

test('a definition’s reads reach the impact analysis of the state it reads', () => {
  const { api } = buildGraph();
  const impact = api.getMutationImpact(stateLocation(S_LIMIT));

  assert.equal(impact.analysisComplete, true);
  assert.ok(
    impact.dependentDerivedStates.some((state) => state.id === nodeId('state_large')),
    'a derived state that reaches the limit through a named expression still depends on it',
  );
  assert.ok(
    impact.affectedConstraints.some((constraint) => constraint.id === nodeId('constraint_not_too_many')),
    'and so does a constraint',
  );
});

test('referenced ids follow a named expression, so the answer does not depend on style', () => {
  const { api } = buildGraph();
  const named = expressionRef(X_LARGE, { [P_LINES]: ref(S_LINES) });
  const inlined = filter(
    ref(S_LINES),
    nodeId('scope_inline'),
    binary('gt', field(ref(nodeId('scope_inline')), F_AMOUNT), ref(S_LIMIT)),
  );

  // The scope and parameter ids differ by construction; the *state* dependencies must not.
  const states = (ids: readonly ReturnType<typeof nodeId>[]): string[] =>
    ids.filter((id) => api.getNode(id)?.kind === 'state').map(String).sort();
  assert.deepEqual(states(api.referencedBy(named)), states(api.referencedBy(inlined)));
  assert.deepEqual(states(api.referencedBy(named)), [String(S_LIMIT), String(S_LINES)]);
});

test('a grouped aggregation is analyzed as a read of the collection it groups', () => {
  const { graph, api } = buildGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_by_category'),
    kind: 'state',
    name: 'category subtotals',
    valueType: collectionType(primitiveType('number')),
    derivation: map(
      group(ref(S_LINES), nodeId('scope_group'), field(ref(nodeId('scope_group')), F_CATEGORY)),
      nodeId('scope_member'),
      sum(
        map(
          groupItems(ref(nodeId('scope_member'))),
          nodeId('scope_amount'),
          field(ref(nodeId('scope_amount')), F_AMOUNT),
        ),
      ),
    ),
  });

  const readers = api.getReaders(S_LINES).map((node) => node.id);
  assert.ok(readers.includes(nodeId('state_by_category')));
  assert.ok(
    api.getFieldReaders(F_CATEGORY).some((node) => node.id === nodeId('state_by_category')),
    'the field a group key projects is a read of that field',
  );
});
