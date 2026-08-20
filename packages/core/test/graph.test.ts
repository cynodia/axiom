import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  collectionType,
  entityType,
  fieldId,
  nodeId,
  optionalType,
  primitiveType,
  synchronizeEdges,
  unwrapOptional,
} from '@axiom/core';
import type { EntityDef, StateDef, ViewNode } from '@axiom/core';

const ENTITY = nodeId('entity_record');
const FIELD_ID = fieldId('field_record_id');
const FIELD_LABEL = fieldId('field_record_label');
const STATE = nodeId('state_records');

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('test', 'Test');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: FIELD_ID,
    fields: [
      { id: FIELD_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: FIELD_LABEL, name: 'Label', valueType: primitiveType('string') },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  return graph;
}

test('nodes keep their identity independently of their name', () => {
  const graph = buildGraph();
  const entity = graph.getNode<EntityDef>(ENTITY);
  assert.ok(entity);
  entity.name = 'Renamed';
  graph.updateNode(entity);

  assert.equal(graph.getNode<EntityDef>(ENTITY)?.name, 'Renamed');
  assert.equal(graph.getField(FIELD_LABEL)?.entityId, ENTITY);
});

test('reads are cloned, so mutation requires updateNode', () => {
  const graph = buildGraph();
  const entity = graph.getNode<EntityDef>(ENTITY);
  assert.ok(entity);
  entity.fields.push({ id: fieldId('field_ghost'), valueType: primitiveType('string') });

  assert.equal(graph.getNode<EntityDef>(ENTITY)?.fields.length, 2);
  assert.equal(graph.getField(fieldId('field_ghost')), undefined);
});

test('fields are addressable across the whole graph', () => {
  const graph = buildGraph();
  assert.equal(graph.getField(FIELD_ID)?.field.name, 'Id');
  assert.equal(graph.listFields().length, 2);
  assert.equal(graph.getField(fieldId('field_missing')), undefined);
});

test('edges are identified, indexed and removed with their nodes', () => {
  const graph = buildGraph();
  const edgeId = graph.addEdge(STATE, ENTITY, 'references');
  assert.equal(graph.addEdge(STATE, ENTITY, 'references'), edgeId, 'duplicate edges collapse');

  assert.equal(graph.getOutgoingEdges(STATE).length, 1);
  assert.equal(graph.getIncomingEdges(ENTITY).length, 1);
  assert.equal(graph.getEdges(STATE, { kinds: ['contains'] }).length, 0);

  graph.removeNode(ENTITY);
  assert.equal(graph.getEdges(STATE).length, 0);
  assert.equal(graph.getField(FIELD_ID), undefined);
});

test('edges are derived from node definitions', () => {
  const graph = buildGraph();
  const child = graph.addNode<ViewNode>({ kind: 'view', name: 'Root', children: [] });
  synchronizeEdges(graph);

  const kinds = graph.listEdges().map((edge) => edge.kind);
  assert.ok(kinds.includes('references'), 'state referencing an entity is linked');

  const view = graph.getNode<ViewNode>(child);
  assert.ok(view);
  assert.deepEqual(view.children, []);
});

test('a graph survives a serialization round trip', () => {
  const graph = buildGraph();
  graph.addEdge(STATE, ENTITY, 'references');
  const copy = ApplicationGraph.deserialize(graph.serialize());

  assert.equal(copy.id, 'test');
  assert.equal(copy.getNode<EntityDef>(ENTITY)?.name, 'Record');
  assert.equal(copy.getField(FIELD_LABEL)?.entityId, ENTITY);
  assert.equal(copy.listEdges().length, 1);
});

test('optional types unwrap to their inner type', () => {
  assert.deepEqual(unwrapOptional(optionalType(primitiveType('number'))), primitiveType('number'));
  assert.deepEqual(unwrapOptional(primitiveType('string')), primitiveType('string'));
});
