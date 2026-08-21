import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  VALIDATION_CODES,
  binary,
  collectionType,
  entityType,
  enumType,
  field,
  fieldId,
  filter,
  literal,
  map,
  nodeId,
  primitiveType,
  ref,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  EntityDef,
  RouteDef,
  StateDef,
  TransitionConstraintDef,
  ViewNode,
} from '@cynodia/axiom-core';

const ENTITY = nodeId('entity_record');
const ENTITY_LOOSE = nodeId('entity_loose');
const F_ID = fieldId('field_record_id');
const F_STATUS = fieldId('field_record_status');
const F_LOOSE = fieldId('field_loose_label');
const STATE = nodeId('state_records');
const VIEW = nodeId('ui_view');
const PREVIOUS = nodeId('scope_previous');
const PROPOSED = nodeId('scope_proposed');
const SCOPE = nodeId('scope_item');

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('transitions', 'Transitions');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_STATUS, valueType: enumType(['draft', 'sealed']), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_LOOSE,
    kind: 'entity',
    name: 'Loose',
    fields: [{ id: F_LOOSE, valueType: primitiveType('string') }],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

const sealedRule = (): Omit<TransitionConstraintDef, 'id'> => ({
  kind: 'transition-constraint',
  name: 'Sealed records never change',
  entityId: ENTITY,
  previousScopeId: PREVIOUS,
  proposedScopeId: PROPOSED,
  expression: binary(
    'or',
    binary('neq', field(ref(PREVIOUS), F_STATUS), literal('sealed')),
    binary('eq', ref(PROPOSED), ref(PREVIOUS)),
  ),
});

function codes(graph: ApplicationGraph): string[] {
  return validateGraph(graph).errors.map((problem) => problem.code);
}

test('a transition rule that compares previous and proposed validates', () => {
  const graph = baseGraph();
  graph.addNode<TransitionConstraintDef>({ id: nodeId('transition_sealed'), ...sealedRule() });
  assert.deepEqual(validateGraph(graph).errors, []);
});

test('a transition rule needs an entity that can be identified across states', () => {
  const graph = baseGraph();
  graph.addNode<TransitionConstraintDef>({
    id: nodeId('transition_loose'),
    ...sealedRule(),
    entityId: ENTITY_LOOSE,
    expression: literal(true),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.unsupportedConstraintScope));
});

test('a transition rule cannot use one scope for both instances', () => {
  const graph = baseGraph();
  graph.addNode<TransitionConstraintDef>({
    id: nodeId('transition_same_scope'),
    ...sealedRule(),
    proposedScopeId: PREVIOUS,
    expression: literal(true),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.unsupportedConstraintScope));
});

test('a transition expression may only reference its two scopes', () => {
  const graph = baseGraph();
  graph.addNode<TransitionConstraintDef>({
    id: nodeId('transition_bad_ref'),
    ...sealedRule(),
    expression: field(ref(nodeId('scope_elsewhere')), F_STATUS),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidExpressionRef));
});

test('an iteration may not reuse a scope its enclosing iteration already bound', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_shadowed'),
    kind: 'state',
    valueType: collectionType(collectionType(entityType(ENTITY))),
    derivation: map(
      ref(STATE),
      SCOPE,
      filter(ref(STATE), SCOPE, binary('eq', field(ref(SCOPE), F_ID), literal('x'))),
    ),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.scopeShadowing));
});

test('an iteration scope may not take the name of a graph node', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_colliding'),
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    derivation: filter(ref(STATE), STATE, literal(true)),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.scopeCollidesWithNode));
});

test('sibling iterations may reuse a scope id, because neither encloses the other', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_siblings'),
    kind: 'state',
    valueType: collectionType(primitiveType('string')),
    derivation: map(
      filter(ref(STATE), SCOPE, binary('eq', field(ref(SCOPE), F_STATUS), literal('draft'))),
      SCOPE,
      field(ref(SCOPE), F_ID),
    ),
  });
  assert.deepEqual(validateGraph(graph).errors, []);
});

test('an action cannot declare both guards and preconditions', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_both'),
    kind: 'action',
    guards: [{ condition: literal(true) }],
    preconditions: [literal(true)],
    operations: [],
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.unsupportedOperation));
});
