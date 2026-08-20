import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  collectionType,
  entityType,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
} from '@cynodia/axiom-core';
import type { EntityDef, RouteDef, StateDef, TextNode, ViewNode } from '@cynodia/axiom-core';
import { GraphValidationError, compileToHtml, compileToIR, serializeIR } from '@cynodia/axiom-compiler';

const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_record_id');
const STATE = nodeId('state_records');
const VIEW = nodeId('ui_root');
const TEXT = nodeId('ui_text');

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('sample', 'Sample');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [{ id: F_ID, valueType: primitiveType('string'), required: true }],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<TextNode>({ id: TEXT, kind: 'text', value: 'Hello' });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [TEXT] });
  graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

test('compilation indexes nodes, fields and UI separately', () => {
  const ir = compileToIR(buildGraph());
  assert.equal(ir.entities.length, 1);
  assert.equal(ir.states.length, 1);
  assert.equal(ir.fields[F_ID]?.entityId, ENTITY);
  assert.ok(ir.uiNodes[VIEW]);
  assert.ok(ir.uiNodes[TEXT]);
  assert.equal(ir.nodes[STATE]?.kind, 'state');
});

test('routes compile to segments ordered most specific first', () => {
  const graph = buildGraph();
  const param = nodeId('param_id');
  graph.addNode<RouteDef>({
    id: nodeId('route_detail'),
    kind: 'route',
    path: '/records/:id',
    viewId: VIEW,
    parameters: [{ id: param, name: 'id' }],
  });
  graph.addNode<RouteDef>({
    id: nodeId('route_new'),
    kind: 'route',
    path: '/records/new',
    viewId: VIEW,
  });

  const ir = compileToIR(graph);
  const paths = ir.routes.map((route) => route.path);
  assert.ok(paths.indexOf('/records/new') < paths.indexOf('/records/:id'), 'static wins over dynamic');

  const detail = ir.routes.find((route) => route.path === '/records/:id');
  assert.deepEqual(detail?.segments, [
    { kind: 'static', value: 'records' },
    { kind: 'parameter', value: 'id', parameterId: param },
  ]);
  assert.equal(detail?.specificity, 1);
});

test('an invalid graph is refused rather than compiled', () => {
  const graph = buildGraph();
  graph.addNode<TextNode>({
    id: nodeId('ui_broken'),
    kind: 'text',
    value: ref(nodeId('state_missing')),
  });
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  view.children = [...view.children, nodeId('ui_broken')];
  graph.updateNode(view);

  assert.throws(() => compileToIR(graph), GraphValidationError);
});

test('the emitted page carries the IR and the generic runtime, and nothing else', () => {
  const html = compileToHtml(buildGraph());
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /createAxiomRuntime/);
  assert.match(html, /__AXIOM_IR__/);
  assert.doesNotMatch(html, /\bimport\s|\brequire\(/, 'the inlined runtime resolves no modules');
  assert.doesNotMatch(html, /export function/, 'module syntax is stripped for the browser');
});

test('script-closing sequences in data cannot break out of the page', () => {
  const graph = buildGraph();
  graph.addNode<TextNode>({ id: nodeId('ui_escape'), kind: 'text', value: '</script><b>x</b>' });
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  view.children = [...view.children, nodeId('ui_escape')];
  graph.updateNode(view);

  const html = compileToHtml(graph);
  assert.ok(!html.includes('</script><b>'), 'the literal closing tag is escaped');
  assert.match(html, /<\\\/script>/);
});

test('the IR serializes to JSON', () => {
  const ir = compileToIR(buildGraph());
  const restored = JSON.parse(serializeIR(ir)) as typeof ir;
  assert.equal(restored.name, 'Sample');
  assert.equal(restored.routes.length, 1);
});

test('literal data may hold structured values', () => {
  const graph = buildGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_seeded'),
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    derivation: literal([{ [F_ID]: 'a' }]),
  });
  assert.doesNotThrow(() => compileToIR(graph));
});
