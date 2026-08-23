import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  VALIDATION_CODES,
  binary,
  collectionType,
  entityType,
  expressionRef,
  field,
  fieldId,
  filter,
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
import type { ExpressionDef, StateDef } from '@cynodia/axiom-core';

/**
 * Named, reusable expressions: what a definition may see, what a reference must supply,
 * and what the graph then knows about the dependency.
 *
 * The point of the mechanism is that a calculation exists **once**. So the properties worth
 * pinning are the ones a TypeScript variable holding an `Expression` would not have: scope
 * isolation, graph-visible dependencies, and a serialization round trip.
 */
const E_PRODUCT = nodeId('entity_product');
const F_ID = fieldId('field_product_id');
const F_STOCK = fieldId('field_product_stock');
const F_ACTIVE = fieldId('field_product_active');
const S_PRODUCTS = nodeId('state_products');
const S_THRESHOLD = nodeId('state_threshold');

const X_LOW_STOCK = nodeId('expression_low_stock');
const P_PRODUCTS = nodeId('param_products');
const SC_LOW = nodeId('scope_low_stock');

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('reuse', 'Reuse');
  graph.addNode({
    id: E_PRODUCT,
    kind: 'entity',
    name: 'Product',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_STOCK, name: 'On hand', valueType: primitiveType('number'), required: true },
      { id: F_ACTIVE, name: 'Active', valueType: primitiveType('boolean'), required: true },
    ],
  });
  graph.addNode({
    id: S_PRODUCTS,
    kind: 'state',
    name: 'products',
    valueType: collectionType(entityType(E_PRODUCT)),
    initialValue: [],
  });
  graph.addNode({
    id: S_THRESHOLD,
    kind: 'state',
    name: 'threshold',
    valueType: primitiveType('number'),
    initialValue: 5,
  });
  graph.addNode({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

/** "the products below the threshold", once, over whatever collection it is given. */
function lowStock(): ExpressionDef {
  return {
    id: X_LOW_STOCK,
    kind: 'expression',
    name: 'low stock',
    description: 'Products whose stock is below the reorder threshold.',
    parameters: [
      { id: P_PRODUCTS, name: 'products', valueType: collectionType(entityType(E_PRODUCT)) },
    ],
    expression: filter(
      ref(P_PRODUCTS),
      SC_LOW,
      binary('lt', field(ref(SC_LOW), F_STOCK), ref(S_THRESHOLD)),
    ),
  };
}

test('a definition can be used from several places without repeating itself', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(lowStock());
  const use = expressionRef(X_LOW_STOCK, { [P_PRODUCTS]: ref(S_PRODUCTS) });

  graph.addNode<StateDef>({
    id: nodeId('state_low'),
    kind: 'state',
    valueType: collectionType(entityType(E_PRODUCT)),
    derivation: use,
  });
  graph.addNode<StateDef>({
    id: nodeId('state_low_count'),
    kind: 'state',
    valueType: primitiveType('number'),
    derivation: {
      kind: 'call',
      function: 'count',
      arguments: [use],
    },
  });
  graph.addNode({
    id: nodeId('ui_warning'),
    kind: 'text',
    value: literal('Restock needed'),
    visibleWhen: { kind: 'call', function: 'non-empty', arguments: [use] },
  });
  graph.updateNode({ id: nodeId('ui_view'), kind: 'view', children: [nodeId('ui_warning')] });

  const result = validateGraph(graph);
  assert.deepEqual(result.errors, []);

  // One scope id, three consumers — which is exactly what building the filter three times
  // over would have made impossible.
  const occurrences = JSON.stringify(graph.toJSON()).split(String(SC_LOW)).length - 1;
  assert.equal(occurrences, 2, 'the scope id exists once, in the definition');
});

test('the type of a reference follows the definition body', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(lowStock());
  const context = semanticContextFromGraph(graph);

  assert.deepEqual(
    inferExpressionType(expressionRef(X_LOW_STOCK, { [P_PRODUCTS]: ref(S_PRODUCTS) }), context),
    collectionType(entityType(E_PRODUCT)),
  );
  // And composes, so an aggregation over a reused filter typechecks.
  assert.deepEqual(
    inferExpressionType(
      sum(
        map(
          expressionRef(X_LOW_STOCK, { [P_PRODUCTS]: ref(S_PRODUCTS) }),
          nodeId('scope_sum'),
          field(ref(nodeId('scope_sum')), F_STOCK),
        ),
      ),
      context,
    ),
    primitiveType('number'),
  );
});

test('a declared valueType is the definition’s own statement about itself', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>({
    id: nodeId('expression_declared'),
    kind: 'expression',
    valueType: primitiveType('number'),
    expression: literal(1),
  });
  assert.deepEqual(
    inferExpressionType(expressionRef(nodeId('expression_declared')), semanticContextFromGraph(graph)),
    primitiveType('number'),
  );
});

test('a definition sees its parameters and state, and nothing of its caller', () => {
  const graph = buildGraph();
  // The body reaches for a scope its caller happens to have. That must not resolve, or the
  // definition would mean something different in every place it is used.
  graph.addNode<ExpressionDef>({
    id: nodeId('expression_leaky'),
    kind: 'expression',
    expression: field(ref(nodeId('scope_caller')), F_STOCK),
  });
  graph.addNode<StateDef>({
    id: nodeId('state_leaky'),
    kind: 'state',
    valueType: collectionType(primitiveType('number')),
    derivation: map(ref(S_PRODUCTS), nodeId('scope_caller'), expressionRef(nodeId('expression_leaky'))),
  });

  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.code === VALIDATION_CODES.invalidExpressionRef &&
        error.nodeId === nodeId('expression_leaky'),
    ),
    'the caller’s iteration scope is not in the definition’s scope',
  );
});

test('every parameter must be supplied, and nothing else may be', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(lowStock());
  graph.addNode<StateDef>({
    id: nodeId('state_missing'),
    kind: 'state',
    valueType: collectionType(entityType(E_PRODUCT)),
    derivation: expressionRef(X_LOW_STOCK),
  });
  graph.addNode<StateDef>({
    id: nodeId('state_extra'),
    kind: 'state',
    valueType: collectionType(entityType(E_PRODUCT)),
    derivation: expressionRef(X_LOW_STOCK, {
      [P_PRODUCTS]: ref(S_PRODUCTS),
      [String(nodeId('param_invented'))]: literal(1),
    }),
  });

  const result = validateGraph(graph);
  const codes = result.errors.map((error) => error.code);
  assert.ok(codes.includes(VALIDATION_CODES.missingExpressionArgument));
  assert.ok(codes.includes(VALIDATION_CODES.unknownExpressionArgument));
});

test('a reference to something that is not a definition is rejected', () => {
  const graph = buildGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_wrong'),
    kind: 'state',
    valueType: primitiveType('number'),
    derivation: expressionRef(S_PRODUCTS),
  });

  const result = validateGraph(graph);
  assert.ok(
    result.errors.some((error) => error.code === VALIDATION_CODES.unknownExpressionDef),
    'UNKNOWN_EXPRESSION_DEF is reachable',
  );
});

test('a definition that reaches itself is rejected, however long the chain', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>({
    id: nodeId('expression_a'),
    kind: 'expression',
    expression: expressionRef(nodeId('expression_b')),
  });
  graph.addNode<ExpressionDef>({
    id: nodeId('expression_b'),
    kind: 'expression',
    expression: expressionRef(nodeId('expression_a')),
  });

  const result = validateGraph(graph);
  const cycles = result.errors.filter((error) => error.code === VALIDATION_CODES.expressionDefCycle);
  assert.equal(cycles.length, 2, 'each definition in the loop says so');
  assert.deepEqual(cycles[0].details?.cycle, [
    String(nodeId('expression_a')),
    String(nodeId('expression_b')),
    String(nodeId('expression_a')),
  ]);
});

test('a definition’s reads are the graph’s reads: dependencies are visible', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(lowStock());
  graph.addNode<StateDef>({
    id: nodeId('state_low'),
    kind: 'state',
    name: 'low stock',
    valueType: collectionType(entityType(E_PRODUCT)),
    derivation: expressionRef(X_LOW_STOCK, { [P_PRODUCTS]: ref(S_PRODUCTS) }),
  });

  // The definition itself reads the threshold it mentions.
  assert.deepEqual(
    graph.getOutgoingEdges(X_LOW_STOCK, { kinds: ['reads'] }).map((edge) => edge.to),
    [S_THRESHOLD],
  );

  // The consumer reads both the collection it passed and everything the definition reads,
  // and records that it uses the definition.
  const consumer = graph.getOutgoingEdges(nodeId('state_low'), { kinds: ['derives-from'] });
  assert.deepEqual(consumer.map((edge) => edge.to).sort(), [S_PRODUCTS, S_THRESHOLD].sort());
  const products = consumer.find((edge) => edge.to === S_PRODUCTS);
  assert.deepEqual(products?.metadata?.fieldIds, [String(F_STOCK)], 'the field read through the definition');
  assert.ok(
    graph
      .getOutgoingEdges(nodeId('state_low'), { kinds: ['references'] })
      .some((edge) => edge.to === X_LOW_STOCK),
    'and that it uses the definition at all',
  );
});

test('a definition survives serialization, because it is data', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(lowStock());
  graph.addNode<StateDef>({
    id: nodeId('state_low'),
    kind: 'state',
    valueType: collectionType(entityType(E_PRODUCT)),
    derivation: expressionRef(X_LOW_STOCK, { [P_PRODUCTS]: ref(S_PRODUCTS) }),
  });

  const restored = ApplicationGraph.deserialize(graph.serialize());
  assert.deepEqual(restored.getNode(X_LOW_STOCK), graph.getNode(X_LOW_STOCK));
  assert.deepEqual(validateGraph(restored).errors, []);
  assert.deepEqual(
    restored.getOutgoingEdges(nodeId('state_low'), { kinds: ['derives-from'] }).map((edge) => edge.to).sort(),
    [S_PRODUCTS, S_THRESHOLD].sort(),
    'and the dependency analysis of a reloaded graph is the same analysis',
  );
});

test('a parameter may not take an id something else already has', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>({
    id: nodeId('expression_collides'),
    kind: 'expression',
    parameters: [{ id: S_PRODUCTS, valueType: collectionType(entityType(E_PRODUCT)) }],
    expression: ref(S_PRODUCTS),
  });

  const result = validateGraph(graph);
  assert.ok(result.errors.some((error) => error.code === VALIDATION_CODES.scopeCollidesWithNode));
});
