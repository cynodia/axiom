import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationGraph } from '@axiom/core';

test('ApplicationGraph adds, queries, and removes nodes', () => {
  const graph = new ApplicationGraph('graph-1', 'Test Graph');
  const entityId = graph.addNode({
    type: 'entity',
    name: 'Issue',
    fields: [{ name: 'title', fieldType: 'string', required: true }],
  });
  const stateId = graph.addNode({
    type: 'state',
    name: 'issues',
    stateType: 'Collection<Issue>',
    initialValue: [],
  });

  graph.addEdge(entityId, stateId, 'hydrates');

  assert.equal(graph.getNode(entityId)?.name, 'Issue');
  assert.equal(graph.getNodesByType('entity').length, 1);
  assert.equal(graph.getEdges(entityId).length, 1);

  graph.removeNode(stateId);
  assert.equal(graph.getNode(stateId), undefined);
  assert.equal(graph.getEdges(entityId).length, 0);
});

test('ApplicationGraph serializes and deserializes', () => {
  const graph = new ApplicationGraph('graph-2', 'Serialized Graph');
  const routeId = graph.addNode({
    type: 'route',
    name: 'Home',
    path: '/',
    viewId: 'view-1',
  });

  const copy = ApplicationGraph.deserialize(graph.serialize());
  assert.equal(copy.id, 'graph-2');
  assert.equal(copy.getNode(routeId)?.type, 'route');
  assert.deepEqual(copy.toJSON().edges, []);
});
