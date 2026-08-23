import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentAPI } from '@cynodia/axiom-agent-api';
import type { ButtonNode, FieldDisplayNode, FormNode, InputNode, RepeatNode } from '@cynodia/axiom-core';
import {
  ACTION_ASK_CANCEL,
  ACTION_CANCEL_ORDER,
  ACTION_DELETE_PRODUCT,
  ENTITY_PRODUCT,
  F_PRODUCT_NAME,
  F_PRODUCT_PRICE,
  F_PRODUCT_STOCK,
  STATE_PRODUCTS,
  createToolkitApplication,
} from '@cynodia/axiom-ui/example';
import {
  axiomUi,
  createToolkitQueries,
  describePattern,
  instancesOfPattern,
  listPatterns,
  nodesOfInstance,
  provenanceOf,
} from '@cynodia/axiom-ui';

/**
 * §20–21: can the expanded graph be understood?
 *
 * The first block asks the questions §20 lists using **only** `AgentAPI` — no toolkit import,
 * no provenance, nothing the toolkit put there. If those fail, the abstraction is opaque and
 * the architecture is wrong however convenient the authoring is.
 */

const graph = createToolkitApplication();
const agent = new AgentAPI(graph);

// -------------------------------------------- §20: canonical semantics alone

test('which forms edit Product?', () => {
  // Two, and the pair is the answer: one creates through a draft, one edits the record the
  // route names. Both are ordinary forms as far as AgentAPI is concerned.
  assert.deepEqual(
    agent.getFormsForEntity(ENTITY_PRODUCT).map((form) => String(form.id)).sort(),
    ['ui_edit_product_root', 'ui_new_product_root'],
  );
});

test('which fields are displayed in the product list?', () => {
  const displayed = graph
    .listNodes()
    .filter((node): node is FieldDisplayNode => node.kind === 'field-display')
    .filter((node) => JSON.stringify(node.source).includes('ui_product_list_rows'))
    .map((node) => node.fieldId);
  assert.deepEqual(displayed, [F_PRODUCT_NAME, F_PRODUCT_PRICE, F_PRODUCT_STOCK]);
});

test('which action is the primary action on the Products page?', () => {
  const primaries = agent.getPrimaryActions('ui_view_products' as never).map((action) => String(action.id));
  assert.ok(primaries.includes('action_add_product'), `got ${primaries.join(', ')}`);
});

test('which UI writes Product.name, and into what?', () => {
  const writers = graph
    .listNodes()
    .filter((node): node is InputNode => node.kind === 'input')
    .filter((node) => JSON.stringify(node.binding.location).includes(String(F_PRODUCT_NAME)));
  assert.deepEqual(writers.map((input) => String(input.id)).sort(), [
    'ui_edit_product_input_0',
    'ui_new_product_input_1',
  ]);
  // And what each write is *rooted in* is visible, which is what decides whether it is
  // governed per keystroke: a draft for the new record, the collection for the edit.
  const rooted = (id: string) =>
    JSON.stringify(writers.find((input) => String(input.id) === id)?.binding.location);
  assert.match(rooted('ui_new_product_input_1') ?? '', /state_draft_product/);
  assert.match(rooted('ui_edit_product_input_0') ?? '', /state_products/);
  assert.match(rooted('ui_edit_product_input_0') ?? '', /"kind":"identity"/);
});

test('which views expose cancelOrder?', () => {
  const buttons = graph
    .listNodes()
    .filter((node): node is ButtonNode => node.kind === 'button')
    .filter((node) => node.actionId === ACTION_CANCEL_ORDER);
  assert.equal(buttons.length, 1);
  const views = agent.getViewsForEntity('entity_order' as never).map((view) => String(view.id));
  assert.ok(views.includes('ui_view_orders'), `got ${views.join(', ')}`);
});

test('the destructive actions of a view are recoverable from the actions themselves', () => {
  const destructive = agent.getDestructiveActions('ui_view_products' as never).map((action) => String(action.id));
  assert.deepEqual(destructive, [String(ACTION_DELETE_PRODUCT)]);
});

test('the form structure is readable without knowing a pattern produced it', () => {
  const structure = agent.getFormStructure('ui_new_product_root' as never);
  assert.equal(String(structure.submitActionId), 'action_add_product');
  assert.equal(String(structure.submitButtonId), 'ui_new_product_submit');
  assert.equal(structure.requiredInputIds.length, 4, 'required comes from the model, not the pattern');
  assert.deepEqual(structure.primaryActionIds.map(String), ['action_add_product']);
});

test('no AgentAPI answer depends on toolkit metadata', () => {
  // The same questions, against a graph expanded with provenance switched off entirely.
  const plain = new AgentAPI(createToolkitApplication('macro'));
  assert.equal(plain.getFormsForEntity(ENTITY_PRODUCT).length, 2);
  assert.deepEqual(
    plain.getDestructiveActions('ui_view_products' as never).map((action) => String(action.id)),
    [String(ACTION_DELETE_PRODUCT)],
  );
  assert.equal(
    plain.getFormStructure('ui_new_product_root' as never).requiredInputIds.length,
    4,
  );
});

// ------------------------------------------ §21: what provenance adds on top

test('which pattern generated this node?', () => {
  const node = graph.getNode('ui_product_list_row' as never);
  const provenance = provenanceOf(node as never);
  assert.equal(provenance?.pattern, 'entity-list');
  assert.equal(provenance?.instance, 'product_list');
  assert.equal(provenance?.part, 'row');
  assert.equal(provenance?.parent, 'products', 'nested patterns record their enclosing instance');
});

test('which entity-list instances exist?', () => {
  assert.deepEqual(instancesOfPattern(graph, 'entity-list').sort(), [
    'customer_list',
    'low_stock_list',
    'order_list',
    'product_list',
  ]);
});

test('which nodes belong to the product list?', () => {
  const owned = nodesOfInstance(graph, 'product_list');
  assert.ok(owned.length >= 8, `expected a group, got ${owned.length}`);
  assert.ok(owned.includes('ui_product_list_rows' as never));
  assert.ok(owned.includes('ui_product_list_row_action_0' as never));
  // And nothing from a different instance leaked in.
  assert.ok(!owned.some((id) => String(id).startsWith('ui_order_list')));
});

test('which pattern instance owns this action control, and which owns none?', () => {
  const ask = graph
    .listNodes()
    .find((node) => node.kind === 'button' && (node as ButtonNode).actionId === ACTION_ASK_CANCEL);
  assert.equal(provenanceOf(ask as never)?.instance, 'order_list');

  // The confirmation itself is canonical, hand-composed UI inside a dialog. It has no
  // provenance because no pattern generated it — which is the honest answer, not a gap.
  const confirm = graph
    .listNodes()
    .find((node) => node.kind === 'button' && (node as ButtonNode).actionId === ACTION_CANCEL_ORDER);
  assert.equal(provenanceOf(confirm as never), undefined);
});

test('the expansion explains the choices it made', () => {
  const expansion = axiomUi.inspect(graph, 'product_list');
  assert.ok(expansion, 'the expansion was recorded');
  assert.equal(expansion.pattern, 'entity-list');
  assert.deepEqual(expansion.declaration.instance, 'product_list');
  const explanation = expansion.explanations.join('\n');
  assert.match(explanation, /field_product_stock formatted as number, from its declared type/);
  assert.match(explanation, /destructive because the action declares it/);
  assert.match(explanation, /empty state/);
});

// --------------------------------------- §48–49: machine-readable discovery

test('an agent can enumerate the patterns and their inputs without reading code', () => {
  assert.deepEqual(listPatterns(axiomUi), ['action-bar', 'entity-form', 'entity-list', 'metric-grid', 'page']);

  const list = describePattern(axiomUi, 'entity-list');
  assert.ok(list);
  assert.deepEqual(list.required, ['source']);
  assert.ok(list.optional.includes('fields'));
  assert.ok(list.slots.includes('rowExtra'));
  assert.equal(list.inputs.source.kind, 'state');
  // The catalogue states what is inferred, so an agent knows what it may leave out.
  assert.match(list.inferred.fields, /except its identity field/);
  assert.match(list.inferred.formats, /currency and percentage are never guessed/);

  const form = describePattern(axiomUi, 'entity-form');
  // `draft` and `target` are each optional and exactly one is given, which the catalogue
  // says rather than leaving an agent to discover it by being refused.
  assert.deepEqual(form?.required.sort(), ['submit']);
  assert.match(form?.inferred.draft ?? '', /exactly one of the two/);
  assert.match(form?.inferred.target ?? '', /exactly one of the two/);
  assert.match(form?.inputs.target.purpose ?? '', /identity is an expression/);
  assert.match(form?.inputs.options.purpose ?? '', /InputOptionsSource/);
  assert.match(form?.inferred.fields ?? '', /identity included/);
});

test('every pattern declares what it produces, in canonical node kinds', () => {
  for (const name of listPatterns(axiomUi)) {
    const description = describePattern(axiomUi, name);
    assert.ok((description?.produces.length ?? 0) > 0, `${name} declares no output`);
    for (const kind of description?.produces ?? []) {
      assert.ok(
        ['view', 'container', 'text', 'repeat', 'field-display', 'form', 'input', 'button', 'conditional', 'diagnostic'].includes(kind),
        `${name} claims to produce ${kind}, which is not a canonical UI node kind`,
      );
    }
  }
});

void ((): RepeatNode | FormNode | undefined => undefined);
void STATE_PRODUCTS;

// -------------------------------------------------- §79–80: toolkit-aware queries

test('toolkit-aware queries are additive, and canonical AgentAPI needs none of them', () => {
  const queries = createToolkitQueries(graph, axiomUi);

  const instances = queries.getPatternInstances();
  assert.equal(instances.length, 18, 'every pattern instance, from provenance alone');
  assert.ok(instances.every((entry) => entry.nodeIds.length > 0));

  assert.equal(queries.getPatternForNode('ui_product_list_row' as never)?.pattern, 'entity-list');
  assert.deepEqual(queries.getInstancesOfPattern('entity-form').sort(), [
    'edit_product',
    'new_customer',
    'new_order',
    'new_product',
  ]);
  assert.equal(queries.getPatternDeclaration('product_list')?.instance, 'product_list');
  assert.match(queries.explainInstance('product_list').join('\n'), /formatted as number/);

  // Without the toolkit instance the graph still answers everything the graph can answer;
  // only the declaration and the explanation are unavailable, because neither is in the graph.
  const graphOnly = createToolkitQueries(graph);
  assert.equal(graphOnly.getPatternInstances().length, 18);
  assert.equal(graphOnly.getPatternForNode('ui_product_list_row' as never)?.pattern, 'entity-list');
  assert.equal(graphOnly.getPatternDeclaration('product_list'), undefined, 'not stored in the graph');
});

test('the catalogue describes the generated tree, not only the inputs', () => {
  // A blind agent read five pattern implementations because the catalogue said what a pattern
  // takes and not what it builds — and composing against a generated tree, or addressing one
  // of its nodes, requires the shape. Every declared part must be a part the pattern actually
  // produces, or the description is a new way to be wrong.
  const expansion = createToolkitApplication();
  for (const name of listPatterns(axiomUi)) {
    const description = describePattern(axiomUi, name);
    assert.ok((description?.expansion.length ?? 0) > 0, `${name} does not describe its expansion`);
    assert.match(description?.generatedIdFormat ?? '', /ui_<instance>_<part>/);
  }

  // Every part the catalogue promises for entity-list is a part the expansion really stamped.
  const stamped = new Set(
    expansion
      .listNodes()
      .map((node) => provenanceOf(node as never))
      .filter((provenance) => provenance?.pattern === 'entity-list')
      .map((provenance) => provenance?.part),
  );
  const promised = describePattern(axiomUi, 'entity-list')?.expansion.map((entry) => entry.part) ?? [];
  for (const part of ['root', 'rows', 'row', 'cell', 'empty-state']) {
    assert.ok(promised.includes(part), `the catalogue omits the ${part} part`);
    assert.ok(stamped.has(part), `entity-list never actually produces a ${part}`);
  }
});
