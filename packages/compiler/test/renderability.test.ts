import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  UI_NODE_KINDS,
  collectionType,
  entityType,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import { BROWSER_RENDERER_CAPABILITIES, createAxiomRuntime, createMemoryHost } from '@cynodia/axiom-runtime';
import { compileToIR } from '@cynodia/axiom-compiler';

/**
 * A UI node kind must be renderable by the target it is compiled for.
 *
 * Until 0.6.3 a kind could be added to `UI_NODE_KINDS` and pass `validateGraph` while no
 * renderer could draw it: no compile error, no validation error, and the failure surfaced as
 * a runtime `UNSUPPORTED_UI_NODE` diagnostic on a blank element. That is a runtime discovery
 * of an authoring mistake, which "no silent semantic failure" exists to prevent.
 */

/** One node of every kind, in one renderable application. */
function everyKind(): ApplicationGraph {
  const graph = new ApplicationGraph('capabilities', 'Capabilities');
  graph.addNode({
    id: nodeId('entity_item'),
    kind: 'entity',
    identityFieldId: fieldId('field_item_id'),
    fields: [{ id: fieldId('field_item_id'), valueType: primitiveType('string'), required: true }],
  } as never);
  graph.addNode({
    id: nodeId('state_items'),
    kind: 'state',
    name: 'items',
    valueType: collectionType(entityType(nodeId('entity_item'))),
    initialValue: [],
  } as never);
  graph.addNode({
    id: nodeId('state_draft'),
    kind: 'state',
    name: 'draft',
    draft: true,
    valueType: primitiveType('string'),
    initialValue: '',
  } as never);
  graph.addNode({
    id: nodeId('action_noop'),
    kind: 'action',
    name: 'noop',
    operations: [{ kind: 'set', target: stateLocation(nodeId('state_draft')), value: literal('x') }],
  } as never);

  graph.addNode({ id: nodeId('ui_text'), kind: 'text', value: 'hello' } as never);
  graph.addNode({ id: nodeId('ui_container'), kind: 'container', children: [] } as never);
  graph.addNode({
    id: nodeId('ui_field-display'),
    kind: 'field-display',
    source: ref(nodeId('state_items')),
    fieldId: fieldId('field_item_id'),
  } as never);
  graph.addNode({
    id: nodeId('ui_repeat'),
    kind: 'repeat',
    source: ref(nodeId('state_items')),
    templateId: nodeId('ui_text'),
  } as never);
  graph.addNode({
    id: nodeId('ui_input'),
    kind: 'input',
    binding: { location: stateLocation(nodeId('state_draft')) },
  } as never);
  graph.addNode({ id: nodeId('ui_button'), kind: 'button', label: 'Go', actionId: nodeId('action_noop') } as never);
  graph.addNode({
    id: nodeId('ui_form'),
    kind: 'form',
    target: ref(nodeId('state_draft')),
    children: [],
    submitActionId: nodeId('action_noop'),
  } as never);
  graph.addNode({
    id: nodeId('ui_conditional'),
    kind: 'conditional',
    condition: literal(true),
    whenTrue: [nodeId('ui_text')],
  } as never);
  graph.addNode({ id: nodeId('ui_diagnostic'), kind: 'diagnostic', actionId: nodeId('action_noop') } as never);
  graph.addNode({
    id: nodeId('ui_dialog'),
    kind: 'dialog',
    openWhen: literal(false),
    title: 'Confirm',
    children: [],
    closeActionId: nodeId('action_noop'),
  } as never);

  graph.addNode({
    id: nodeId('ui_view'),
    kind: 'view',
    children: UI_NODE_KINDS.filter((kind) => kind !== 'view').map((kind) => nodeId(`ui_${kind}`)),
  } as never);
  graph.addNode({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') } as never);
  return graph;
}

test('the published browser capabilities are exactly the kinds the renderer implements', () => {
  // The capability list is what validation trusts, so a kind listed without a `case` in the
  // renderer would be a lie validation repeats. Every published kind is rendered here.
  assert.deepEqual(
    [...BROWSER_RENDERER_CAPABILITIES.supportedUiKinds].sort(),
    [...UI_NODE_KINDS].sort(),
    'the browser renderer publishes every canonical kind',
  );

  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(everyKind()), rootElement: host.root, host });
  app.start();
  assert.deepEqual(
    app.diagnostics().filter((diagnostic) => diagnostic.code === 'UNSUPPORTED_UI_NODE'),
    [],
    'the renderer handled every kind it publishes',
  );
});

test('a renderer that cannot draw a kind rejects the graph at authoring time', () => {
  // A second target — signage, a terminal, a native shell — that has not implemented every
  // kind. The graph is fine; it is fine *for the browser*. Compiling it for this target is
  // an error, and it is one an author sees before anything renders.
  const signage = { target: 'signage', supportedUiKinds: ['view', 'container', 'text', 'repeat', 'field-display'] as const };
  const result = validateGraph(everyKind(), { renderer: signage });

  const unsupported = result.errors.filter((error) => error.code === 'UNSUPPORTED_UI_NODE_KIND');
  assert.deepEqual(
    unsupported.map((error) => error.details?.kind).sort(),
    ['button', 'conditional', 'dialog', 'diagnostic', 'form', 'input'].sort(),
  );
  assert.equal(unsupported[0].details?.target, 'signage');
  assert.match(unsupported[0].message, /signage renderer cannot render/);
});

test('validation with no named renderer accepts every kind', () => {
  // A graph is not rejected for a target nobody named: the check exists to catch compiling
  // for a renderer that cannot cope, not to make `validateGraph` refuse work in the abstract.
  assert.deepEqual(
    validateGraph(everyKind()).errors.filter((error) => error.code === 'UNSUPPORTED_UI_NODE_KIND'),
    [],
  );
});

test('compileToIR applies the browser capabilities by default', () => {
  const graph = everyKind();
  assert.doesNotThrow(() => compileToIR(graph));
  // And an explicitly restricted target refuses.
  assert.throws(
    () => compileToIR(graph, { renderer: { target: 'signage', supportedUiKinds: ['view', 'container', 'text'] } }),
    /GraphValidationError|signage/,
  );
});
