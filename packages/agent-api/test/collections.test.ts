import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  filter,
  forEach,
  identitySelector,
  itemLocation,
  literal,
  map,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  sum,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';

/**
 * A new semantic primitive is incomplete until an agent can reason about it: iteration
 * and projection have to show up in dependency analysis like any other read or write.
 */
const ENTITY_PART = nodeId('entity_part');
const ENTITY_LINE = nodeId('entity_line');
const F_PART_ID = fieldId('field_part_id');
const F_PART_STOCK = fieldId('field_part_stock');
const F_PART_PRICE = fieldId('field_part_price');
const F_LINE_ID = fieldId('field_line_id');
const F_LINE_PART = fieldId('field_line_part');
const F_LINE_QUANTITY = fieldId('field_line_quantity');

const STATE_PARTS = nodeId('state_parts');
const STATE_LINES = nodeId('state_lines');
const STATE_TOTAL = nodeId('state_total');

const ACTION_CONFIRM = nodeId('action_confirm');
const VIEW = nodeId('ui_view');
const UI_TOTAL = nodeId('ui_total');
const CONSTRAINT_STOCK = nodeId('constraint_stock');
const SCOPE = nodeId('scope_line');

/** Deliberately never calls synchronizeEdges: queries must not depend on it. */
function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('agent-collections', 'Agent Collections');

  graph.addNode<EntityDef>({
    id: ENTITY_PART,
    kind: 'entity',
    name: 'Part',
    identityFieldId: F_PART_ID,
    fields: [
      { id: F_PART_ID, valueType: primitiveType('string'), required: true },
      { id: F_PART_STOCK, name: 'Stock', valueType: primitiveType('number'), required: true },
      { id: F_PART_PRICE, name: 'Price', valueType: primitiveType('number'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_LINE,
    kind: 'entity',
    name: 'Line',
    identityFieldId: F_LINE_ID,
    fields: [
      { id: F_LINE_ID, valueType: primitiveType('string'), required: true },
      { id: F_LINE_PART, valueType: primitiveType('string'), required: true },
      { id: F_LINE_QUANTITY, name: 'Quantity', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_PARTS,
    kind: 'state',
    name: 'parts',
    valueType: collectionType(entityType(ENTITY_PART)),
    initialValue: [],
  });
  graph.addNode<StateDef>({
    id: STATE_LINES,
    kind: 'state',
    name: 'lines',
    valueType: collectionType(entityType(ENTITY_LINE)),
    initialValue: [],
  });
  graph.addNode<StateDef>({
    id: STATE_TOTAL,
    kind: 'state',
    name: 'total',
    valueType: primitiveType('number'),
    derivation: sum(map(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_LINE_QUANTITY))),
  });

  graph.addNode<ActionDef>({
    id: ACTION_CONFIRM,
    kind: 'action',
    name: 'confirm',
    preconditions: [
      binary(
        'eq',
        sum(
          map(
            filter(ref(STATE_LINES), SCOPE, literal(true)),
            SCOPE,
            field(ref(SCOPE), F_LINE_QUANTITY),
          ),
        ),
        literal(0),
      ),
    ],
    operations: [
      forEach(ref(STATE_LINES), SCOPE, [
        {
          kind: 'set',
          target: fieldLocation(
            itemLocation(
              stateLocation(STATE_PARTS),
              identitySelector(F_PART_ID, field(ref(SCOPE), F_LINE_PART)),
            ),
            F_PART_STOCK,
          ),
          value: binary('subtract', literal(0), field(ref(SCOPE), F_LINE_QUANTITY)),
        },
      ]),
    ],
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_STOCK,
    kind: 'constraint',
    name: 'Stock is never negative',
    entityId: ENTITY_PART,
    expression: binary('gte', field(ref(ENTITY_PART), F_PART_STOCK), literal(0)),
  });

  graph.addNode<TextNode>({ id: UI_TOTAL, kind: 'text', value: ref(STATE_TOTAL) });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', name: 'Summary', children: [UI_TOTAL] });
  graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

test('an action that writes inside an iteration is found as a writer of that field', () => {
  const agent = new AgentAPI(buildGraph());

  assert.deepEqual(
    agent.getFieldWriters(F_PART_STOCK).map((node) => node.id),
    [ACTION_CONFIRM],
    'the write happens once per member, but it is still a write to Part.stock',
  );
  assert.deepEqual(
    agent.getWriters(STATE_PARTS).map((action) => action.id),
    [ACTION_CONFIRM],
  );
});

test('reads through a projection are attributed to the right field', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const readers = agent.getFieldReaders(F_LINE_QUANTITY).map((node) => node.id);
  assert.ok(readers.includes(STATE_TOTAL), 'the derived total projects the quantity');
  assert.ok(readers.includes(ACTION_CONFIRM), 'the action aggregates and subtracts it');

  const derivation = graph.getOutgoingEdges(STATE_TOTAL, { kinds: ['derives-from'] });
  assert.deepEqual(derivation.map((edge) => edge.to), [STATE_LINES]);
  assert.deepEqual(derivation[0].metadata?.fieldIds, [F_LINE_QUANTITY]);
});

test('addressing a record from inside an iteration is recorded as a read', () => {
  const graph = buildGraph();
  const reads = graph.getOutgoingEdges(ACTION_CONFIRM, { kinds: ['reads'] });

  assert.ok(
    reads.some((edge) => edge.to === STATE_LINES),
    'the collection being iterated is read',
  );
  assert.ok(
    reads.some((edge) => edge.to === STATE_PARTS && (edge.metadata?.fieldIds as string[])?.includes(F_PART_ID)),
    'the identity selector reads the field it matches on',
  );
});

test('the impact of a field written inside an iteration is answerable', () => {
  const agent = new AgentAPI(buildGraph());
  const impact = agent.getMutationImpact(
    fieldLocation(
      itemLocation(stateLocation(STATE_PARTS), identitySelector(F_PART_ID, literal('p1'))),
      F_PART_STOCK,
    ),
  );

  assert.equal(impact.rootStateId, STATE_PARTS);
  assert.deepEqual(
    impact.directWriters.map((node) => node.id),
    [ACTION_CONFIRM],
  );
  assert.deepEqual(
    impact.affectedConstraints.map((constraint) => constraint.id),
    [CONSTRAINT_STOCK],
  );
});

test('dependency answers stay correct without anyone synchronizing edges', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);
  assert.deepEqual(agent.getFieldWriters(F_PART_STOCK).map((node) => node.id), [ACTION_CONFIRM]);

  // Change what the action does; the answer has to change with it.
  const action = graph.getNode<ActionDef>(ACTION_CONFIRM);
  assert.ok(action);
  graph.updateNode({
    ...action,
    operations: [
      forEach(ref(STATE_LINES), SCOPE, [
        {
          kind: 'set',
          target: fieldLocation(
            itemLocation(
              stateLocation(STATE_PARTS),
              identitySelector(F_PART_ID, field(ref(SCOPE), F_LINE_PART)),
            ),
            F_PART_PRICE,
          ),
          value: literal(1),
        },
      ]),
    ],
  } as ActionDef);

  assert.deepEqual(
    agent.getFieldWriters(F_PART_STOCK).map((node) => node.id),
    [],
    'it no longer writes stock',
  );
  assert.deepEqual(
    agent.getFieldWriters(F_PART_PRICE).map((node) => node.id),
    [ACTION_CONFIRM],
    'and it does write price',
  );
});

test('removing a node removes the relationships it implied', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);
  assert.equal(agent.getWriters(STATE_PARTS).length, 1);

  graph.removeNode(ACTION_CONFIRM);
  assert.deepEqual(agent.getWriters(STATE_PARTS), []);
});
