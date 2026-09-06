/**
 * A graph that loads successfully but fails `validateGraph`: the action's `set` targets a
 * state that does not exist. Used to exercise the "invalid graph" JSON error case
 * (spec16pt4 §3) — the file itself loads fine; what it describes does not validate.
 */
import { ApplicationGraph, literal, nodeId, stateLocation } from '@cynodia/axiom-core';
import type { ActionDef } from '@cynodia/axiom-core';

export function createGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('cli-invalid-fixture', 'CLI Invalid Fixture');

  graph.addNode<ActionDef>({
    id: nodeId('action_broken'),
    kind: 'action',
    name: 'broken',
    operations: [
      { kind: 'set', target: stateLocation(nodeId('state_does_not_exist')), value: literal(1) },
    ],
  });

  return graph;
}
