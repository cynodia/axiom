import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  VALIDATION_CODES,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  filter,
  forEach,
  identitySelector,
  inferExpressionType,
  itemLocation,
  literal,
  map,
  nodeId,
  primitiveType,
  ref,
  semanticContextFromGraph,
  sort,
  stateLocation,
  sum,
  validateGraph,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, RouteDef, StateDef, ViewNode } from '@cynodia/axiom-core';

const ENTITY = nodeId('entity_line');
const F_ID = fieldId('field_line_id');
const F_LABEL = fieldId('field_line_label');
const F_QUANTITY = fieldId('field_line_quantity');
const F_PRICE = fieldId('field_line_price');

const STATE_LINES = nodeId('state_lines');
const STATE_LABELS = nodeId('state_labels');
const STATE_TOTAL = nodeId('state_total');
const VIEW = nodeId('ui_view');
const SCOPE = nodeId('scope_line');

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('collections', 'Collections');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Line',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_LABEL, valueType: primitiveType('string'), required: true },
      { id: F_QUANTITY, valueType: primitiveType('number'), required: true },
      { id: F_PRICE, valueType: primitiveType('number'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE_LINES,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<StateDef>({
    id: STATE_LABELS,
    kind: 'state',
    valueType: collectionType(primitiveType('string')),
    initialValue: [],
  });
  graph.addNode<StateDef>({
    id: STATE_TOTAL,
    kind: 'state',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

function codes(graph: ApplicationGraph): string[] {
  return validateGraph(graph).errors.map((problem) => problem.code);
}

// ------------------------------------------------------------ type inference

test('projecting a collection yields a collection of the projected type', () => {
  const context = semanticContextFromGraph(baseGraph());

  const quantities = map(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_QUANTITY));
  assert.deepEqual(
    inferExpressionType(quantities, context),
    collectionType(primitiveType('number')),
    'Collection<Line> projected by Line → number is Collection<number>',
  );

  const lineTotals = map(
    ref(STATE_LINES),
    SCOPE,
    binary('multiply', field(ref(SCOPE), F_QUANTITY), field(ref(SCOPE), F_PRICE)),
  );
  assert.deepEqual(inferExpressionType(lineTotals, context), collectionType(primitiveType('number')));
  assert.deepEqual(inferExpressionType(sum(lineTotals), context), primitiveType('number'));
});

test('sorting preserves the collection type', () => {
  const context = semanticContextFromGraph(baseGraph());
  assert.deepEqual(
    inferExpressionType(sort(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_LABEL)), context),
    collectionType(entityType(ENTITY)),
  );
});

// -------------------------------------------------------------- validation

test('a projection may only iterate a collection', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_bad_map'),
    kind: 'state',
    valueType: collectionType(primitiveType('number')),
    derivation: map(ref(STATE_TOTAL), SCOPE, ref(SCOPE)),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.notACollection));
});

test('a projection that references an unknown id is rejected', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_bad_scope'),
    kind: 'state',
    valueType: collectionType(primitiveType('number')),
    derivation: map(ref(STATE_LINES), SCOPE, field(ref(nodeId('scope_wrong')), F_QUANTITY)),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidExpressionRef));
});

test('an aggregation over a collection that is not numeric is rejected', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_bad_sum'),
    kind: 'state',
    valueType: primitiveType('number'),
    derivation: sum(ref(STATE_LABELS)),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidAggregation));
});

test('an aggregation over a projected numeric collection is accepted', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_good_sum'),
    kind: 'state',
    valueType: primitiveType('number'),
    derivation: sum(
      map(
        filter(ref(STATE_LINES), SCOPE, binary('gt', field(ref(SCOPE), F_QUANTITY), literal(0))),
        SCOPE,
        binary('multiply', field(ref(SCOPE), F_QUANTITY), field(ref(SCOPE), F_PRICE)),
      ),
    ),
  });
  assert.deepEqual(validateGraph(graph).errors, []);
});

test('an iteration may only walk a collection', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_bad_for_each'),
    kind: 'action',
    operations: [
      forEach(ref(STATE_TOTAL), SCOPE, [
        { kind: 'set', target: stateLocation(STATE_TOTAL), value: literal(1) },
      ]),
    ],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.notACollection));
});

test('a location inside an iteration is validated', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_bad_location'),
    kind: 'action',
    operations: [
      forEach(ref(STATE_LINES), SCOPE, [
        {
          kind: 'set',
          target: fieldLocation(
            itemLocation(stateLocation(STATE_LINES), identitySelector(F_ID, ref(SCOPE))),
            fieldId('field_missing'),
          ),
          value: literal(1),
        },
      ]),
    ],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.danglingFieldRef));
});

test('an assignment inside an iteration is type checked', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_bad_assignment'),
    kind: 'action',
    operations: [
      forEach(ref(STATE_LINES), SCOPE, [
        {
          kind: 'set',
          target: fieldLocation(
            itemLocation(stateLocation(STATE_LINES), identitySelector(F_ID, field(ref(SCOPE), F_ID))),
            F_LABEL,
          ),
          value: field(ref(SCOPE), F_QUANTITY),
        },
      ]),
    ],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.assignmentTypeMismatch));
});

test('an iteration can address the record each member points at', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_good_for_each'),
    kind: 'action',
    operations: [
      forEach(ref(STATE_LINES), SCOPE, [
        {
          kind: 'set',
          target: fieldLocation(
            itemLocation(stateLocation(STATE_LINES), identitySelector(F_ID, field(ref(SCOPE), F_ID))),
            F_QUANTITY,
          ),
          value: binary('add', field(ref(SCOPE), F_QUANTITY), literal(1)),
        },
      ]),
    ],
  });
  assert.deepEqual(validateGraph(graph).errors, []);
});

test('an iteration may only contain mutations', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_nested_navigate'),
    kind: 'action',
    operations: [
      {
        kind: 'for-each',
        collection: ref(STATE_LINES),
        scopeId: SCOPE,
        operations: [{ kind: 'navigate', path: '/' } as never],
      },
    ],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.unsupportedOperation));
});

// -------------------------------------------------------- initial state data

test('entity seed data keyed by field name is rejected, not silently accepted', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_named_keys'),
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    // The mistake this exists to catch: keys are field names, not field ids.
    initialValue: [{ id: 'l1', label: 'One', quantity: 1, price: 2 }],
  });

  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((problem) => problem.code === VALIDATION_CODES.initialValueUnknownField));
  assert.ok(
    result.errors.some((problem) => problem.code === VALIDATION_CODES.initialValueMissingRequiredField),
  );
});

test('initial value diagnostics carry the path to the offending value', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_wrong_type'),
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [
      { [F_ID]: 'l1', [F_LABEL]: 'One', [F_QUANTITY]: 1, [F_PRICE]: 2 },
      { [F_ID]: 'l2', [F_LABEL]: 'Two', [F_QUANTITY]: 'many', [F_PRICE]: 2 },
    ],
  });

  const problem = validateGraph(graph).errors.find(
    (candidate) => candidate.code === VALIDATION_CODES.initialValueTypeMismatch,
  );
  assert.ok(problem);
  assert.equal(problem.path, `state_wrong_type[1].${F_QUANTITY}`);
  assert.deepEqual(problem.details, { expected: 'number', actual: 'string', value: 'many' });
});

test('nested entity seed data is checked recursively', () => {
  const graph = baseGraph();
  const ENTITY_GROUP = nodeId('entity_group');
  const F_GROUP_ID = fieldId('field_group_id');
  const F_GROUP_LINES = fieldId('field_group_lines');
  graph.addNode<EntityDef>({
    id: ENTITY_GROUP,
    kind: 'entity',
    identityFieldId: F_GROUP_ID,
    fields: [
      { id: F_GROUP_ID, valueType: primitiveType('string'), required: true },
      { id: F_GROUP_LINES, valueType: collectionType(entityType(ENTITY)), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: nodeId('state_groups'),
    kind: 'state',
    valueType: collectionType(entityType(ENTITY_GROUP)),
    initialValue: [
      {
        [F_GROUP_ID]: 'g1',
        [F_GROUP_LINES]: [{ [F_ID]: 'l1', [F_LABEL]: 'One', [F_QUANTITY]: 1 }],
      },
    ],
  });

  const problem = validateGraph(graph).errors.find(
    (candidate) => candidate.code === VALIDATION_CODES.initialValueMissingRequiredField,
  );
  assert.ok(problem, 'a missing field two levels down is still found');
  assert.equal(problem.path, `state_groups[0].${F_GROUP_LINES}[0]`);
  assert.equal(problem.fieldId, F_PRICE);
});

test('a valid graph with collection semantics passes cleanly', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_sorted'),
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    derivation: sort(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_LABEL), 'desc'),
  });
  const result = validateGraph(graph);
  assert.deepEqual(result.errors, []);
});
