import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  VALIDATION_CODES,
  collectionType,
  entityType,
  fieldId,
  fieldLocation,
  identitySelector,
  indexSelector,
  inferLocationType,
  itemFieldLocation,
  itemLocation,
  literal,
  locationCapabilities,
  locationExpressions,
  locationFieldIds,
  locationRootStateId,
  locationsEqual,
  nodeId,
  optionalType,
  primitiveType,
  ref,
  semanticContextFromGraph,
  stateLocation,
  validateGraph,
  validateLocation,
} from '@axiom/core';
import type { ActionDef, EntityDef, InputNode, RouteDef, StateDef, ViewNode } from '@axiom/core';

const ENTITY = nodeId('entity_record');
const OTHER_ENTITY = nodeId('entity_other');
const F_ID = fieldId('field_record_id');
const F_LABEL = fieldId('field_record_label');
const F_SIZE = fieldId('field_record_size');
const F_OTHER = fieldId('field_other_label');
const STATE_RECORDS = nodeId('state_records');
const STATE_DRAFT = nodeId('state_draft');
const STATE_CURRENT = nodeId('state_current');
const STATE_COUNT = nodeId('state_count');
const PARAM_ID = nodeId('param_id');
const VIEW = nodeId('ui_view');
const ROUTE = nodeId('route_root');
const SCOPE = nodeId('scope_lookup');

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('locations', 'Locations');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LABEL, name: 'Label', valueType: primitiveType('string'), required: true },
      { id: F_SIZE, name: 'Size', valueType: primitiveType('number') },
    ],
  });
  graph.addNode<EntityDef>({
    id: OTHER_ENTITY,
    kind: 'entity',
    name: 'Other',
    fields: [{ id: F_OTHER, name: 'Label', valueType: primitiveType('string') }],
  });
  graph.addNode<StateDef>({
    id: STATE_RECORDS,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<StateDef>({
    id: STATE_DRAFT,
    kind: 'state',
    name: 'draft',
    valueType: entityType(ENTITY),
    draft: true,
    initialValue: {},
  });
  graph.addNode<StateDef>({
    id: STATE_COUNT,
    kind: 'state',
    name: 'count',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  graph.addNode<StateDef>({
    id: STATE_CURRENT,
    kind: 'state',
    name: 'current',
    valueType: optionalType(entityType(ENTITY)),
    derivation: {
      kind: 'find',
      source: ref(STATE_RECORDS),
      scopeId: SCOPE,
      predicate: { kind: 'binary', operator: 'eq', left: { kind: 'field', source: ref(SCOPE), fieldId: F_ID }, right: ref(PARAM_ID) },
    },
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [] });
  graph.addNode<RouteDef>({
    id: ROUTE,
    kind: 'route',
    path: '/records/:id',
    viewId: VIEW,
    parameters: [{ id: PARAM_ID, name: 'id', valueType: primitiveType('string') }],
  });
  return graph;
}

const routedRecord = itemLocation(stateLocation(STATE_RECORDS), identitySelector(F_ID, ref(PARAM_ID)));

test('a location is structurally traceable back to its state root', () => {
  const location = fieldLocation(routedRecord, F_LABEL);
  assert.equal(locationRootStateId(location), STATE_RECORDS);
  assert.deepEqual(locationFieldIds(location), [F_LABEL]);
  assert.deepEqual(locationExpressions(location), [ref(PARAM_ID)]);
});

test('itemFieldLocation builds the same address as the long form', () => {
  assert.ok(
    locationsEqual(
      itemFieldLocation(STATE_RECORDS, F_ID, ref(PARAM_ID), F_LABEL),
      fieldLocation(routedRecord, F_LABEL),
    ),
  );
});

test('locations compare structurally, independent of what a selector resolves to', () => {
  assert.equal(
    locationsEqual(
      itemFieldLocation(STATE_RECORDS, F_ID, ref(PARAM_ID), F_LABEL),
      itemFieldLocation(STATE_RECORDS, F_ID, ref(PARAM_ID), F_LABEL),
    ),
    true,
  );
  assert.equal(
    locationsEqual(
      itemFieldLocation(STATE_RECORDS, F_ID, ref(PARAM_ID), F_LABEL),
      itemFieldLocation(STATE_RECORDS, F_ID, literal('r1'), F_LABEL),
    ),
    false,
  );
});

test('the type a location addresses is inferred through every step', () => {
  const context = semanticContextFromGraph(buildGraph());
  assert.deepEqual(inferLocationType(stateLocation(STATE_RECORDS), context), collectionType(entityType(ENTITY)));
  assert.deepEqual(inferLocationType(routedRecord, context), entityType(ENTITY));
  assert.deepEqual(inferLocationType(fieldLocation(routedRecord, F_LABEL), context), primitiveType('string'));
  assert.deepEqual(inferLocationType(fieldLocation(routedRecord, F_SIZE), context), primitiveType('number'));
  assert.deepEqual(
    inferLocationType(fieldLocation(stateLocation(STATE_DRAFT), F_LABEL), context),
    primitiveType('string'),
  );
  assert.deepEqual(
    inferLocationType(itemLocation(stateLocation(STATE_RECORDS), indexSelector(literal(0))), context),
    entityType(ENTITY),
  );
});

test('derived state is readable but never writable', () => {
  const context = semanticContextFromGraph(buildGraph());
  assert.deepEqual(locationCapabilities(stateLocation(STATE_RECORDS), context), {
    readable: true,
    writable: true,
  });
  assert.deepEqual(locationCapabilities(stateLocation(STATE_CURRENT), context), {
    readable: true,
    writable: false,
  });

  const problems = validateLocation(fieldLocation(stateLocation(STATE_CURRENT), F_LABEL), context, {
    requireWritable: true,
  });
  assert.deepEqual(
    problems.map((problem) => problem.code),
    [VALIDATION_CODES.derivedStateWrite],
  );
});

test('a derived location is still valid when it is only read', () => {
  const context = semanticContextFromGraph(buildGraph());
  assert.deepEqual(validateLocation(stateLocation(STATE_CURRENT), context), []);
});

test('invalid locations are rejected', () => {
  const context = semanticContextFromGraph(buildGraph());
  const codes = (location: Parameters<typeof validateLocation>[0]): string[] =>
    validateLocation(location, context, { requireWritable: true }).map((problem) => problem.code);

  assert.deepEqual(codes(stateLocation(nodeId('state_missing'))), [VALIDATION_CODES.unknownStateRef]);
  assert.deepEqual(codes(fieldLocation(stateLocation(STATE_DRAFT), fieldId('field_missing'))), [
    VALIDATION_CODES.danglingFieldRef,
  ]);
  assert.deepEqual(codes(fieldLocation(stateLocation(STATE_DRAFT), F_OTHER)), [
    VALIDATION_CODES.fieldNotOnEntity,
  ]);
  assert.deepEqual(codes(fieldLocation(stateLocation(STATE_COUNT), F_LABEL)), [
    VALIDATION_CODES.fieldOnNonEntity,
  ]);
  assert.deepEqual(
    codes(itemLocation(stateLocation(STATE_COUNT), identitySelector(F_ID, literal('x')))),
    [VALIDATION_CODES.selectorOnNonCollection],
  );
  assert.deepEqual(
    codes(itemLocation(stateLocation(STATE_RECORDS), identitySelector(F_OTHER, literal('x')))),
    [VALIDATION_CODES.identityFieldMismatch],
  );
});

test('an input bound to derived state cannot be committed to the graph', () => {
  const graph = buildGraph();
  const input = graph.addNode<InputNode>({
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_CURRENT), F_LABEL) },
  });
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  view.children = [input];
  graph.updateNode(view);

  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((problem) => problem.code === VALIDATION_CODES.derivedStateWrite));
});

test('an obviously incompatible assignment is rejected', () => {
  const graph = buildGraph();
  graph.addNode<ActionDef>({
    kind: 'action',
    name: 'breakIt',
    operations: [
      {
        kind: 'set',
        target: fieldLocation(stateLocation(STATE_DRAFT), F_SIZE),
        value: ref(STATE_RECORDS),
      },
    ],
  });

  const result = validateGraph(graph);
  assert.ok(result.errors.some((problem) => problem.code === VALIDATION_CODES.assignmentTypeMismatch));
});

test('a compatible assignment is accepted', () => {
  const graph = buildGraph();
  graph.addNode<ActionDef>({
    kind: 'action',
    name: 'setLabel',
    operations: [
      {
        kind: 'set',
        target: fieldLocation(stateLocation(STATE_DRAFT), F_LABEL),
        value: literal('hello'),
      },
      { kind: 'set', target: stateLocation(STATE_COUNT), value: literal(3) },
    ],
  });
  assert.deepEqual(validateGraph(graph).errors, []);
});

test('inserting into something that is not a collection is rejected', () => {
  const graph = buildGraph();
  graph.addNode<ActionDef>({
    kind: 'action',
    name: 'insertWrongly',
    operations: [{ kind: 'insert', target: stateLocation(STATE_DRAFT), value: literal({}) }],
  });
  assert.ok(
    validateGraph(graph).errors.some(
      (problem) => problem.code === VALIDATION_CODES.selectorOnNonCollection,
    ),
  );
});
