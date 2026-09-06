/**
 * A minimal valid graph for exercising the CLI as a subprocess. Not a demo application —
 * just enough vocabulary (one state, one action) for explain/analyze/diff/validate to have
 * something real to render.
 */
import {
  ApplicationGraph,
  binary,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, StateDef } from '@cynodia/axiom-core';

export const COUNT = nodeId('state_count');
export const INCREMENT = nodeId('action_increment');

export function createGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('cli-fixture', 'CLI Fixture');

  graph.addNode<StateDef>({
    id: COUNT,
    kind: 'state',
    name: 'count',
    valueType: primitiveType('number'),
    initialValue: 0,
  });

  graph.addNode<ActionDef>({
    id: INCREMENT,
    kind: 'action',
    name: 'increment',
    operations: [
      { kind: 'set', target: stateLocation(COUNT), value: binary('add', ref(COUNT), literal(1)) },
    ],
  });

  return graph;
}
