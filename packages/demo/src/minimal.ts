/**
 * The minimal application from the repository README, compiled and executed.
 *
 * The region between the markers below is character-identical to the README's fenced
 * example; `packages/demo/test/documentation.test.ts` fails if the two drift apart, and
 * runs this file to prove the example works.
 */
// readme-example:start
import {
  ApplicationGraph,
  binary,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom';
import type {
  ActionDef,
  ButtonNode,
  ConstraintDef,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom';

// Ids are branded strings. Nothing ever resolves by name.
export const COUNT = nodeId('state_count');
export const INCREMENT = nodeId('action_increment');
const LIMIT = nodeId('constraint_limit');
const DISPLAY = nodeId('ui_display');
const BUTTON = nodeId('ui_increment');
const VIEW = nodeId('ui_view');
const ROUTE = nodeId('route_root');

export function createMinimalGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('counter', 'Counter');

  graph.addNode<StateDef>({
    id: COUNT,
    kind: 'state',
    name: 'count',
    valueType: primitiveType('number'),
    initialValue: 0,
  });

  // A value is an Expression. The position written to is a Location.
  graph.addNode<ActionDef>({
    id: INCREMENT,
    kind: 'action',
    name: 'increment',
    operations: [
      { kind: 'set', target: stateLocation(COUNT), value: binary('add', ref(COUNT), literal(1)) },
    ],
  });

  // An invariant over proposed state. Breaking it rolls the whole action back.
  graph.addNode<ConstraintDef>({
    id: LIMIT,
    kind: 'constraint',
    name: 'The count never exceeds three',
    message: 'The count never exceeds three.',
    expression: binary('lte', ref(COUNT), literal(3)),
  });

  // Presentation is intent: a text role and a value format, not a font size.
  graph.addNode<TextNode>({
    id: DISPLAY,
    kind: 'text',
    value: ref(COUNT),
    presentation: { textRole: 'title', format: { kind: 'number' } },
  });
  graph.addNode<ButtonNode>({
    id: BUTTON,
    kind: 'button',
    label: 'Add one',
    actionId: INCREMENT,
    presentation: { uxRole: 'primary-action', icon: 'add' },
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', name: 'Counter', children: [DISPLAY, BUTTON] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });

  return graph;
}

export function runMinimalExample(): number {
  const graph = createMinimalGraph();

  const validation = validateGraph(graph);
  if (!validation.valid) {
    throw new Error(
      validation.errors.map((problem) => `[${problem.code}] ${problem.message}`).join('\n'),
    );
  }

  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    app.invokeAction(INCREMENT);
  }

  // Three succeeded; the fourth broke the invariant and was rolled back entirely.
  return app.getState(COUNT) as number;
}
// readme-example:end
