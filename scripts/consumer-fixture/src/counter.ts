/**
 * A Counter application, built entirely through the public `@cynodia/axiom` API.
 *
 * It shares nothing with the framework's own demo applications: if this compiles and
 * runs from an installed package, the published API is genuinely self-sufficient.
 */
import {
  ApplicationGraph,
  binary,
  call,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  synchronizeEdges,
} from '@cynodia/axiom';
import type {
  ActionDef,
  ButtonNode,
  ConstraintDef,
  ContainerNode,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom';

export const STATE_COUNT = nodeId('state_count');
export const ACTION_INCREMENT = nodeId('action_increment');
export const ACTION_DECREMENT = nodeId('action_decrement');
export const UI_DISPLAY = nodeId('ui_display');
export const UI_INCREMENT = nodeId('ui_increment');
export const UI_DECREMENT = nodeId('ui_decrement');
export const UI_CONTROLS = nodeId('ui_controls');
export const UI_VIEW = nodeId('ui_view');
export const ROUTE_ROOT = nodeId('route_root');
export const CONSTRAINT_NON_NEGATIVE = nodeId('constraint_non_negative');

export function createCounterGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('counter', 'Counter');

  graph.addNode<StateDef>({
    id: STATE_COUNT,
    kind: 'state',
    name: 'count',
    valueType: primitiveType('number'),
    initialValue: 0,
  });

  // A value is an expression; the position it is written to is a location.
  graph.addNode<ActionDef>({
    id: ACTION_INCREMENT,
    kind: 'action',
    name: 'increment',
    operations: [
      { kind: 'set', target: stateLocation(STATE_COUNT), value: binary('add', ref(STATE_COUNT), literal(1)) },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_DECREMENT,
    kind: 'action',
    name: 'decrement',
    operations: [
      {
        kind: 'set',
        target: stateLocation(STATE_COUNT),
        value: binary('subtract', ref(STATE_COUNT), literal(1)),
      },
    ],
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_NON_NEGATIVE,
    kind: 'constraint',
    name: 'The count never goes below zero',
    message: 'The count never goes below zero.',
    expression: binary('gte', ref(STATE_COUNT), literal(0)),
  });

  graph.addNode<TextNode>({
    id: UI_DISPLAY,
    kind: 'text',
    value: call('concat', literal('Count: '), call('to-string', ref(STATE_COUNT))),
    presentation: { emphasis: 'strong' },
  });

  graph.addNode<ButtonNode>({
    id: UI_INCREMENT,
    kind: 'button',
    label: 'Add one',
    actionId: ACTION_INCREMENT,
  });

  graph.addNode<ButtonNode>({
    id: UI_DECREMENT,
    kind: 'button',
    label: 'Take one',
    actionId: ACTION_DECREMENT,
  });

  graph.addNode<ContainerNode>({
    id: UI_CONTROLS,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_INCREMENT, UI_DECREMENT],
  });

  graph.addNode<ViewNode>({
    id: UI_VIEW,
    kind: 'view',
    name: 'CounterView',
    children: [UI_DISPLAY, UI_CONTROLS],
  });

  graph.addNode<RouteDef>({ id: ROUTE_ROOT, kind: 'route', path: '/', viewId: UI_VIEW });

  synchronizeEdges(graph);
  return graph;
}
