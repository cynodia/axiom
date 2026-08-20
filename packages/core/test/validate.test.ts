import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  VALIDATION_CODES,
  binary,
  call,
  collectionType,
  entityType,
  enumType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  validateGraph,
} from '@axiom/core';
import type {
  ActionDef,
  ButtonNode,
  ConstraintDef,
  EntityDef,
  InputNode,
  RouteDef,
  StateDef,
  ViewNode,
} from '@axiom/core';

const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_record_id');
const F_LABEL = fieldId('field_record_label');
const STATE = nodeId('state_records');
const VIEW = nodeId('ui_root_view');
const ACTION = nodeId('action_clear');
const ROUTE = nodeId('route_root');

/** A minimal but complete application used as the starting point for each failure. */
function validGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('valid', 'Valid');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_LABEL, valueType: primitiveType('string') },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<ActionDef>({
    id: ACTION,
    kind: 'action',
    operations: [{ kind: 'set-state', stateId: STATE, value: literal([]) }],
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

function codes(graph: ApplicationGraph): string[] {
  return validateGraph(graph).errors.map((issue) => issue.code);
}

test('a complete graph validates', () => {
  const result = validateGraph(validGraph());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('a dangling field reference is rejected', () => {
  const graph = validGraph();
  graph.addNode<InputNode>({
    id: nodeId('ui_input'),
    kind: 'input',
    binding: { target: ref(STATE), fieldId: fieldId('field_missing') },
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.danglingFieldRef));
});

test('a dangling action reference is rejected', () => {
  const graph = validGraph();
  graph.addNode<ButtonNode>({
    id: nodeId('ui_button'),
    kind: 'button',
    label: 'Go',
    actionId: nodeId('action_missing'),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidActionRef));
});

test('duplicate field ids across entities are rejected', () => {
  const graph = validGraph();
  graph.addNode<EntityDef>({
    id: nodeId('entity_other'),
    kind: 'entity',
    fields: [{ id: F_LABEL, valueType: primitiveType('string') }],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.duplicateFieldId));
});

test('an unknown edge kind is rejected', () => {
  const graph = validGraph();
  graph.addEdge(STATE, ENTITY, 'owns' as never);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidEdgeKind));
});

test('a UI child that is not a UI node is rejected', () => {
  const graph = validGraph();
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  view.children = [ACTION];
  graph.updateNode(view);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidUiChild));
});

test('a route without a view target is rejected', () => {
  const graph = validGraph();
  graph.addNode<RouteDef>({
    id: nodeId('route_broken'),
    kind: 'route',
    path: '/broken',
    viewId: nodeId('ui_missing'),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidRouteView));
});

test('an undeclared route parameter is rejected', () => {
  const graph = validGraph();
  graph.addNode<RouteDef>({
    id: nodeId('route_detail'),
    kind: 'route',
    path: '/records/:id',
    viewId: VIEW,
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidRouteParameter));
});

test('duplicate route paths are rejected', () => {
  const graph = validGraph();
  graph.addNode<RouteDef>({ id: nodeId('route_copy'), kind: 'route', path: '/', viewId: VIEW });
  assert.ok(codes(graph).includes(VALIDATION_CODES.duplicateRoutePath));
});

test('an expression referencing an unknown id is rejected', () => {
  const graph = validGraph();
  graph.addNode<ConstraintDef>({
    id: nodeId('constraint_broken'),
    kind: 'constraint',
    expression: call('required', ref(nodeId('state_missing'))),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidExpressionRef));
});

test('an expression may reference a scope introduced by filter', () => {
  const graph = validGraph();
  const scope = nodeId('scope_item');
  graph.addNode<StateDef>({
    id: nodeId('state_filtered'),
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    derivation: {
      kind: 'filter',
      source: ref(STATE),
      scopeId: scope,
      predicate: binary('eq', field(ref(scope), F_LABEL), literal('x')),
    },
  });
  assert.equal(validateGraph(graph).valid, true);
});

test('a type reference to a non-entity is rejected', () => {
  const graph = validGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_bad_type'),
    kind: 'state',
    valueType: entityType(ACTION),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidTypeRef));
});

test('an empty enum type is rejected', () => {
  const graph = validGraph();
  graph.addNode<EntityDef>({
    id: nodeId('entity_empty_enum'),
    kind: 'entity',
    fields: [{ id: fieldId('field_empty_enum'), valueType: enumType([]) }],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidTypeRef));
});

test('an operation on a non-state node is rejected', () => {
  const graph = validGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_bad'),
    kind: 'action',
    operations: [{ kind: 'add-item', collectionId: ENTITY, value: literal(null) }],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidStateRef));
});

test('unreachable UI nodes are reported as warnings, not errors', () => {
  const graph = validGraph();
  graph.addNode<ViewNode>({ id: nodeId('ui_orphan'), kind: 'view', children: [] });
  const result = validateGraph(graph);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((issue) => issue.code === VALIDATION_CODES.unreachableUiNode));
});
