import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  CONTROL_VARIANTS,
  UX_ROLES,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  filter,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import type { EntityDef, InputNode, RouteDef, StateDef, ViewNode } from '@cynodia/axiom-core';
import { compileToIR } from '@cynodia/axiom-compiler';
import { createAxiomRuntime, createMemoryHost, findAll } from '@cynodia/axiom-runtime';

/**
 * The second interaction probe: is Dialog exceptional, or representative?
 *
 * If Dialog were the only interaction concept that resists expression as a pattern, it would
 * be a special case and could be treated as one. If a second, unrelated primitive splits the
 * same way, the split is the rule — and that changes where interaction primitives belong.
 *
 * Combobox is chosen because it looks least like a dialog: no modality, no interruption, no
 * focus trap. It is a control.
 */

const E_PRODUCT = nodeId('entity_product');
const F_ID = fieldId('field_id');
const F_NAME = fieldId('field_name');
const S_PRODUCTS = nodeId('state_products');
const S_QUERY = nodeId('state_query');
const S_CHOSEN = nodeId('state_chosen');
const S_OPEN = nodeId('state_open');
const SCOPE = nodeId('scope_product');

function comboboxGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('combobox', 'Combobox');
  graph.addNode<EntityDef>({
    id: E_PRODUCT,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Code', valueType: primitiveType('string'), required: true },
      { id: F_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: S_PRODUCTS,
    kind: 'state',
    name: 'Products',
    valueType: collectionType(entityType(E_PRODUCT)),
    initialValue: [
      { [F_ID]: 'bolt', [F_NAME]: 'Hex bolt' },
      { [F_ID]: 'nut', [F_NAME]: 'Hex nut' },
    ],
  });
  graph.addNode<StateDef>({
    id: S_QUERY,
    kind: 'state',
    name: 'Query',
    ephemeral: true,
    valueType: primitiveType('string'),
    initialValue: '',
  });
  graph.addNode<StateDef>({
    id: S_OPEN,
    kind: 'state',
    name: 'List open',
    ephemeral: true,
    valueType: primitiveType('boolean'),
    initialValue: false,
  });
  graph.addNode<StateDef>({
    id: S_CHOSEN,
    kind: 'state',
    name: 'Chosen',
    draft: true,
    valueType: primitiveType('string'),
    initialValue: '',
  });

  // The whole data half of a combobox, in existing vocabulary.
  graph.addNode<InputNode>({
    id: nodeId('ui_combo'),
    kind: 'input',
    binding: { location: stateLocation(S_CHOSEN) },
    label: 'Product',
    presentation: { control: 'select' },
    options: {
      // Filtered by what has been typed: an ordinary expression over ordinary state.
      source: filter(
        ref(S_PRODUCTS),
        SCOPE,
        binary('eq', field(ref(SCOPE), F_ID), ref(S_CHOSEN)),
      ),
      scopeId: SCOPE,
      valueFieldId: F_ID,
      labelFieldId: F_NAME,
    },
  });
  graph.addNode<ViewNode>({ id: nodeId('ui_view'), kind: 'view', children: [nodeId('ui_combo')] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

test('the data half of a combobox is fully expressible today', () => {
  // Value, option source, option identity, option label and filtering are all ordinary
  // semantics. Nothing new is needed, and a pattern could compress the declaration.
  const graph = comboboxGraph();
  assert.deepEqual(validateGraph(graph).errors, []);

  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  const control = findAll(host.root, (element) => element.getAttribute('data-control') === 'ui_combo')[0];
  assert.ok(control, 'it renders as a real control');
  assert.equal(control.tagName, 'select');
});

test('the interaction half is missing in exactly the way Dialog’s was', () => {
  const graph = comboboxGraph();
  const ir = JSON.stringify(compileToIR(graph));

  // Nothing describes how the list is navigated, which option is active, or what is announced.
  for (const missing of [
    'activedescendant',
    'aria-expanded',
    'autocomplete',
    'typeahead',
    'listbox',
    'highlightedIndex',
  ]) {
    assert.doesNotMatch(ir, new RegExp(missing, 'i'), `${missing} unexpectedly present`);
  }

  // And there is no vocabulary to add it with: no control variant and no UX role names a
  // combobox, because naming one without implementing it is the failure mode the framework
  // forbids.
  assert.equal((CONTROL_VARIANTS as readonly string[]).includes('combobox'), false);
  assert.equal((UX_ROLES as readonly string[]).includes('combobox'), false);
});

test('so the split is the rule, not a property of dialogs', () => {
  // Dialog and Combobox share no shape — one interrupts and traps focus, the other is a
  // control in a form — and they divide at the same seam:
  //
  //   expressible: what exists, what it holds, what it is bound to, what is open
  //   missing:     keyboard navigation, focus behaviour, and what assistive technology hears
  //
  // A pattern can only emit nodes that already exist, so the second half is not reachable
  // from a toolkit at any level of cleverness. It is canonical semantics or it is nothing.
  const graph = comboboxGraph();
  const uiKinds = new Set(graph.listNodes().filter((node) => node.id.startsWith('ui_')).map((node) => node.kind));
  assert.deepEqual([...uiKinds].sort(), ['input', 'view'], 'the data half needed no new kind');

  // The evidence that the missing half is behaviour rather than structure: the rendered
  // control carries no relationship an assistive technology could follow to the option list.
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  const control = findAll(host.root, (element) => element.getAttribute('data-control') === 'ui_combo')[0];
  assert.equal(control.getAttribute('aria-expanded'), null);
  assert.equal(control.getAttribute('aria-activedescendant'), null);
});

void fieldLocation;
void literal;
void S_QUERY;
void S_OPEN;
