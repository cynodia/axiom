import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  optionalType,
  primitiveType,
  ref,
  stateLocation,
  synchronizeEdges,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ConstraintDef,
  ContainerNode,
  EntityDef,
  FieldDisplayNode,
  InputNode,
  RepeatNode,
  RouteDef,
  StateDef,
  ViewNode,
} from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';

/**
 * "What can change this field, and what is affected if it does?" — answered from graph
 * relationships alone, which is the point of field-level dependency metadata.
 */
const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_record_id');
const F_LABEL = fieldId('field_record_label');
const F_PRICE = fieldId('field_record_price');

const STATE_RECORDS = nodeId('state_records');
const STATE_CURRENT = nodeId('state_current');
const STATE_TOTAL = nodeId('state_total');

const ACTION_SET_PRICE = nodeId('action_set_price');
const PARAM_PRICE = nodeId('param_price');
const ACTION_RENAME = nodeId('action_rename');
const PARAM_LABEL = nodeId('param_label');

const ROUTE = nodeId('route_record');
const PARAM_ROUTE_ID = nodeId('param_route_id');
const ROUTE_LIST = nodeId('route_list');

const UI_DETAIL_VIEW = nodeId('ui_detail_view');
const UI_PRICE_INPUT = nodeId('ui_price_input');
const UI_LABEL_INPUT = nodeId('ui_label_input');
const UI_LIST_VIEW = nodeId('ui_list_view');
const UI_LIST_REPEAT = nodeId('ui_list_repeat');
const UI_LIST_ROW = nodeId('ui_list_row');
const UI_ROW_PRICE = nodeId('ui_row_price');

const CONSTRAINT_PRICE = nodeId('constraint_price');
const CONSTRAINT_LABEL = nodeId('constraint_label');
const SCOPE = nodeId('scope_lookup');

const routedRecord = itemLocation(
  stateLocation(STATE_RECORDS),
  identitySelector(F_ID, ref(PARAM_ROUTE_ID)),
);

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('impact', 'Impact');

  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LABEL, name: 'Label', valueType: primitiveType('string'), required: true },
      { id: F_PRICE, name: 'Price', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_RECORDS,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
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
      predicate: binary('eq', field(ref(SCOPE), F_ID), ref(PARAM_ROUTE_ID)),
    },
  });
  graph.addNode<StateDef>({
    id: STATE_TOTAL,
    kind: 'state',
    name: 'total',
    valueType: primitiveType('number'),
    derivation: call('count', ref(STATE_RECORDS)),
  });

  graph.addNode<ActionDef>({
    id: ACTION_SET_PRICE,
    kind: 'action',
    name: 'setPrice',
    parameters: [{ id: PARAM_PRICE, name: 'price', valueType: primitiveType('number') }],
    operations: [{ kind: 'set', target: fieldLocation(routedRecord, F_PRICE), value: ref(PARAM_PRICE) }],
  });
  graph.addNode<ActionDef>({
    id: ACTION_RENAME,
    kind: 'action',
    name: 'rename',
    parameters: [{ id: PARAM_LABEL, name: 'label', valueType: primitiveType('string') }],
    operations: [{ kind: 'set', target: fieldLocation(routedRecord, F_LABEL), value: ref(PARAM_LABEL) }],
  });

  graph.addNode<InputNode>({
    id: UI_PRICE_INPUT,
    kind: 'input',
    binding: { location: fieldLocation(routedRecord, F_PRICE) },
  });
  graph.addNode<InputNode>({
    id: UI_LABEL_INPUT,
    kind: 'input',
    binding: { location: fieldLocation(routedRecord, F_LABEL) },
  });
  graph.addNode<ViewNode>({
    id: UI_DETAIL_VIEW,
    kind: 'view',
    name: 'Detail',
    children: [UI_PRICE_INPUT, UI_LABEL_INPUT],
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_PRICE,
    kind: 'field-display',
    source: ref(UI_LIST_REPEAT),
    fieldId: F_PRICE,
  });
  graph.addNode<ContainerNode>({ id: UI_LIST_ROW, kind: 'container', children: [UI_ROW_PRICE] });
  graph.addNode<RepeatNode>({
    id: UI_LIST_REPEAT,
    kind: 'repeat',
    source: ref(STATE_RECORDS),
    templateId: UI_LIST_ROW,
  });
  graph.addNode<ViewNode>({ id: UI_LIST_VIEW, kind: 'view', name: 'List', children: [UI_LIST_REPEAT] });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_PRICE,
    kind: 'constraint',
    name: 'Price is never negative',
    entityId: ENTITY,
    expression: binary('gte', field(ref(ENTITY), F_PRICE), literal(0)),
  });
  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_LABEL,
    kind: 'constraint',
    name: 'Label present',
    entityId: ENTITY,
    expression: call('required', field(ref(ENTITY), F_LABEL)),
  });

  graph.addNode<RouteDef>({ id: ROUTE_LIST, kind: 'route', path: '/', viewId: UI_LIST_VIEW });
  graph.addNode<RouteDef>({
    id: ROUTE,
    kind: 'route',
    path: '/records/:id',
    viewId: UI_DETAIL_VIEW,
    parameters: [{ id: PARAM_ROUTE_ID, name: 'id', valueType: primitiveType('string') }],
  });

  synchronizeEdges(graph);
  return graph;
}

test('field writers are distinguishable from one another', () => {
  const agent = new AgentAPI(buildGraph());

  assert.deepEqual(
    agent.getFieldWriters(F_PRICE).map((node) => node.id).sort(),
    [ACTION_SET_PRICE, UI_PRICE_INPUT].sort(),
    'writes Record.price',
  );
  assert.deepEqual(
    agent.getFieldWriters(F_LABEL).map((node) => node.id).sort(),
    [ACTION_RENAME, UI_LABEL_INPUT].sort(),
    'writes Record.label',
  );
});

test('field readers include the UI that displays them', () => {
  const agent = new AgentAPI(buildGraph());
  const readers = agent.getFieldReaders(F_PRICE).map((node) => node.id);

  assert.ok(readers.includes(UI_ROW_PRICE), 'the list column reads the price');
  assert.ok(readers.includes(UI_PRICE_INPUT), 'a bound input reads it as well as writing it');
  assert.ok(!readers.includes(UI_LABEL_INPUT));
});

test('a selector expression is a read dependency, and the target is a write', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const writes = graph.getOutgoingEdges(ACTION_SET_PRICE, { kinds: ['writes'] });
  assert.deepEqual(
    writes.map((edge) => edge.to),
    [STATE_RECORDS],
  );
  assert.deepEqual(writes[0].metadata?.fieldIds, [F_PRICE], 'the write is recorded field by field');

  const reads = graph.getOutgoingEdges(ACTION_SET_PRICE, { kinds: ['reads'] });
  assert.deepEqual(
    reads.map((edge) => edge.to),
    [STATE_RECORDS],
  );
  assert.deepEqual(reads[0].metadata?.fieldIds, [F_ID], 'the identity selector reads the id field');

  assert.deepEqual(
    agent.getWriters(STATE_RECORDS).map((action) => action.id).sort(),
    [ACTION_RENAME, ACTION_SET_PRICE].sort(),
  );
});

test('the impact of changing one field is answerable from the graph', () => {
  const agent = new AgentAPI(buildGraph());
  const impact = agent.getMutationImpact(fieldLocation(routedRecord, F_PRICE));

  assert.equal(impact.rootStateId, STATE_RECORDS);
  assert.deepEqual(impact.fieldIds, [F_PRICE]);
  assert.deepEqual(
    impact.directWriters.map((node) => node.id).sort(),
    [ACTION_SET_PRICE, UI_PRICE_INPUT].sort(),
  );
  assert.deepEqual(
    impact.dependentDerivedStates.map((state) => state.id).sort(),
    [STATE_CURRENT, STATE_TOTAL].sort(),
  );
  assert.deepEqual(
    impact.affectedConstraints.map((constraint) => constraint.id),
    [CONSTRAINT_PRICE],
    'the label constraint does not observe the price',
  );
  assert.deepEqual(
    impact.affectedViews.map((view) => view.id).sort(),
    [UI_DETAIL_VIEW, UI_LIST_VIEW].sort(),
  );
});

test('the impact of replacing a whole state covers everything that touches it', () => {
  const agent = new AgentAPI(buildGraph());
  const impact = agent.getMutationImpact(stateLocation(STATE_RECORDS));

  assert.deepEqual(impact.fieldIds, []);
  assert.deepEqual(
    impact.affectedConstraints.map((constraint) => constraint.id).sort(),
    [CONSTRAINT_LABEL, CONSTRAINT_PRICE].sort(),
  );
});
