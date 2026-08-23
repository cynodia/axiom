import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  find,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  InputNode,
  FormNode,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';
import { compileToIR } from '@cynodia/axiom-compiler';
import { createAxiomRuntime, createMemoryHost, findAll, textOf } from '@cynodia/axiom-runtime';
import { PatternExpansionError, axiomUi } from '@cynodia/axiom-ui';

/**
 * The four pattern limitations the Phase 2 blind agent named, and what 0.7 does about them:
 * a title that is a caption rather than the record, a metric label duplicated from a state
 * name, a form that covers create and not edit, and a choice drawn from application data
 * that no pattern input could carry.
 */
const E_PRODUCT = nodeId('entity_product');
const F_CODE = fieldId('field_product_code');
const F_NAME = fieldId('field_product_name');
const F_STOCK = fieldId('field_product_stock');
const F_SUPPLIER = fieldId('field_product_supplier');

const E_SUPPLIER = nodeId('entity_supplier');
const F_SUPPLIER_ID = fieldId('field_supplier_id');
const F_SUPPLIER_NAME = fieldId('field_supplier_name');

const S_PRODUCTS = nodeId('state_products');
const S_SUPPLIERS = nodeId('state_suppliers');
const S_DRAFT = nodeId('state_draft_product');
const S_COUNT = nodeId('state_product_count');
const A_SAVE = nodeId('action_save');
const A_ADD = nodeId('action_add');
const P_CODE = nodeId('route_param_code');
const ROUTE_EDIT = nodeId('route_edit');

/** A domain with two entities, a collection, a draft and a route parameter. */
function buildDomain(): ApplicationGraph {
  const graph = new ApplicationGraph('patterns', 'Patterns');
  graph.addNode<EntityDef>({
    id: E_SUPPLIER,
    kind: 'entity',
    name: 'Supplier',
    identityFieldId: F_SUPPLIER_ID,
    fields: [
      { id: F_SUPPLIER_ID, name: 'Reference', valueType: primitiveType('string'), required: true },
      { id: F_SUPPLIER_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: E_PRODUCT,
    kind: 'entity',
    name: 'Product',
    identityFieldId: F_CODE,
    fields: [
      { id: F_CODE, name: 'Code', valueType: primitiveType('string'), required: true },
      { id: F_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_STOCK, name: 'On hand', valueType: primitiveType('number'), required: true },
      { id: F_SUPPLIER, name: 'Supplier', valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: S_SUPPLIERS,
    kind: 'state',
    name: 'Suppliers',
    valueType: collectionType(entityType(E_SUPPLIER)),
    initialValue: [
      { [F_SUPPLIER_ID]: 's1', [F_SUPPLIER_NAME]: 'Nordvik' },
      { [F_SUPPLIER_ID]: 's2', [F_SUPPLIER_NAME]: 'Fjell' },
    ],
  });
  graph.addNode<StateDef>({
    id: S_PRODUCTS,
    kind: 'state',
    name: 'Products',
    valueType: collectionType(entityType(E_PRODUCT)),
    initialValue: [
      { [F_CODE]: 'bolt', [F_NAME]: 'Hex bolt', [F_STOCK]: 40, [F_SUPPLIER]: 's1' },
      { [F_CODE]: 'nut', [F_NAME]: 'Hex nut', [F_STOCK]: 5, [F_SUPPLIER]: 's2' },
    ],
  });
  graph.addNode<StateDef>({
    id: S_DRAFT,
    kind: 'state',
    name: 'New product',
    draft: true,
    valueType: entityType(E_PRODUCT),
    initialValue: { [F_CODE]: '', [F_NAME]: '', [F_STOCK]: 0, [F_SUPPLIER]: '' },
  });
  graph.addNode<StateDef>({
    id: S_COUNT,
    kind: 'state',
    name: 'Products on file',
    valueType: primitiveType('number'),
    derivation: call('count', ref(S_PRODUCTS)),
  });
  graph.addNode<ActionDef>({
    id: A_SAVE,
    kind: 'action',
    name: 'Save',
    operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: literal(0) }],
  });
  // A no-op the forms can submit: what the submit action *does* is not what these tests are about.
  graph.updateNode({
    id: A_SAVE,
    kind: 'action',
    name: 'Save',
    operations: [],
  } as ActionDef);
  graph.addNode<ActionDef>({
    id: A_ADD,
    kind: 'action',
    name: 'Add product',
    operations: [{ kind: 'insert', target: stateLocation(S_PRODUCTS), value: ref(S_DRAFT) }],
  });
  graph.addNode<ConstraintDef>({
    id: nodeId('constraint_stock'),
    kind: 'constraint',
    name: 'Stock is never negative',
    entityId: E_PRODUCT,
    message: 'Stock can never fall below zero.',
    expression: binary('gte', field(ref(E_PRODUCT), F_STOCK), literal(0)),
  });
  return graph;
}

/** Wires a page into a route so the graph is renderable. */
function route(graph: ApplicationGraph, pageId: string, path: string, parameters?: RouteDef['parameters']): void {
  const viewId = nodeId(`ui_view_${path.replace(/[^a-z]/g, '') || 'root'}`);
  graph.addNode<ViewNode>({ id: viewId, kind: 'view', children: [nodeId(pageId)] });
  graph.addNode<RouteDef>({
    id: nodeId(`route_${path.replace(/[^a-z]/g, '') || 'root'}`),
    kind: 'route',
    path,
    viewId,
    ...(parameters ? { parameters } : {}),
  });
}

function render(graph: ApplicationGraph, path = '/') {
  const host = createMemoryHost({ path });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  return { app, host };
}

// --------------------------------------------------------------- page title

test('a page title may be an expression, so a detail page is titled by its record', () => {
  const graph = buildDomain();
  const product = find(ref(S_PRODUCTS), nodeId('scope_title'), binary('eq', field(ref(nodeId('scope_title')), F_CODE), ref(P_CODE)));
  const page = axiomUi.expand(graph, {
    pattern: 'page',
    instance: 'product_detail',
    title: field(product, F_NAME),
    description: field(product, F_CODE),
  });
  graph.addNode<ViewNode>({ id: nodeId('ui_view_detail'), kind: 'view', children: [page] });
  graph.addNode<RouteDef>({
    id: ROUTE_EDIT,
    kind: 'route',
    path: '/products/:code',
    viewId: nodeId('ui_view_detail'),
    parameters: [{ id: P_CODE, name: 'code', valueType: primitiveType('string') }],
  });

  assert.deepEqual(validateGraph(graph).errors, []);
  const title = graph.getNode<TextNode>(nodeId('ui_product_detail_title'));
  assert.notEqual(typeof title?.value, 'string', 'the title reaches the record, not a caption');
  assert.equal(title?.presentation?.headingLevel, 1, 'and it is still the document’s h1');

  const { host } = render(graph, '/products/nut');
  assert.equal(textOf(findAll(host.root, (element) => element.getAttribute('data-node') === 'ui_product_detail_title')[0]), 'Hex nut');
});

// --------------------------------------------------------- metric grid labels

test('a metric is labelled by the state it reads, unless the author says otherwise', () => {
  const graph = buildDomain();
  const page = axiomUi.expand(graph, {
    pattern: 'page',
    instance: 'dash',
    title: 'Dashboard',
    content: [
      {
        pattern: 'metric-grid',
        instance: 'dash_metrics',
        metrics: [{ value: ref(S_COUNT) }, { label: 'Stocked lines', value: ref(S_COUNT) }],
      },
    ],
  });
  route(graph, String(page), '/');

  assert.deepEqual(validateGraph(graph).errors, []);
  assert.equal(graph.getNode<TextNode>(nodeId('ui_dash_metrics_label_0'))?.value, 'Products on file');
  assert.equal(graph.getNode<TextNode>(nodeId('ui_dash_metrics_label_1'))?.value, 'Stocked lines');
  assert.match(
    axiomUi.inspect(graph, 'dash_metrics')?.explanations.join('\n') ?? '',
    /labelled "Products on file" from the name of the state it reads/,
  );
});

test('a metric whose value is a computation still needs a label, and says so', () => {
  const graph = buildDomain();
  assert.throws(
    () =>
      axiomUi.expand(graph, {
        pattern: 'metric-grid',
        instance: 'dash_metrics',
        metrics: [{ value: binary('add', ref(S_COUNT), literal(1)) }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof PatternExpansionError);
      assert.equal(error.findings[0].code, 'METRIC_LABEL_REQUIRED');
      assert.equal(error.findings[0].path, 'dash_metrics.metrics[0].label');
      return true;
    },
  );
});

// ------------------------------------------------------------ entity form: edit

test('an edit form addresses an existing member by expression and writes into it', () => {
  const graph = buildDomain();
  const page = axiomUi.expand(graph, {
    pattern: 'page',
    instance: 'edit',
    title: 'Edit product',
    content: [
      {
        pattern: 'entity-form',
        instance: 'edit_product',
        target: { state: S_PRODUCTS, identity: ref(P_CODE) },
        submit: A_SAVE,
      },
    ],
  });
  graph.addNode<ViewNode>({ id: nodeId('ui_view_edit'), kind: 'view', children: [page] });
  graph.addNode<RouteDef>({
    id: ROUTE_EDIT,
    kind: 'route',
    path: '/products/:code',
    viewId: nodeId('ui_view_edit'),
    parameters: [{ id: P_CODE, name: 'code', valueType: primitiveType('string') }],
  });

  assert.deepEqual(validateGraph(graph).errors, []);

  // Every control writes the addressed member of the collection, not a draft.
  const inputs = graph
    .listNodes()
    .filter((node): node is InputNode => node.kind === 'input')
    .filter((node) => String(node.id).startsWith('ui_edit_product_input'));
  assert.equal(inputs.length, 3, 'the identity field is not offered for editing');
  for (const input of inputs) {
    const location = input.binding.location;
    assert.equal(location.kind, 'field');
    assert.equal(JSON.stringify(location).includes(String(S_PRODUCTS)), true);
    assert.match(JSON.stringify(location), /"kind":"identity"/);
  }
  // And the form is *about* the record it edits.
  assert.match(
    JSON.stringify(graph.getNode<FormNode>(nodeId('ui_edit_product_root'))?.target),
    /"kind":"find"/,
  );

  const { app, host } = render(graph, '/products/nut');
  const nameInput = findAll(host.root, (element) => element.getAttribute('data-control') === 'ui_edit_product_input_0')[0];
  assert.equal(nameInput.getAttribute('value'), 'Hex nut', 'the control shows the stored value');

  // A write goes through the mutation engine into canonical state.
  nameInput.value = 'Hex nut M8';
  nameInput.dispatch('input');
  assert.equal(
    (app.getState(S_PRODUCTS) as Array<Record<string, unknown>>)[1][F_NAME],
    'Hex nut M8',
  );
  assert.equal(
    (app.getState(S_PRODUCTS) as Array<Record<string, unknown>>)[0][F_NAME],
    'Hex bolt',
    'and only the addressed member changed',
  );
});

test('an edit form writes canonical state, so a hard invariant rolls the keystroke back', () => {
  const graph = buildDomain();
  const page = axiomUi.expand(graph, {
    pattern: 'page',
    instance: 'edit',
    title: 'Edit product',
    content: [
      {
        pattern: 'entity-form',
        instance: 'edit_product',
        target: { state: S_PRODUCTS, identity: ref(P_CODE) },
        fields: [F_STOCK],
        submit: A_SAVE,
      },
    ],
  });
  graph.addNode<ViewNode>({ id: nodeId('ui_view_edit'), kind: 'view', children: [page] });
  graph.addNode<RouteDef>({
    id: ROUTE_EDIT,
    kind: 'route',
    path: '/products/:code',
    viewId: nodeId('ui_view_edit'),
    parameters: [{ id: P_CODE, name: 'code', valueType: primitiveType('string') }],
  });

  const { app, host } = render(graph, '/products/nut');
  const stock = findAll(host.root, (element) => element.getAttribute('data-control') === 'ui_edit_product_input_0')[0];
  stock.value = '-1';
  stock.dispatch('input');

  assert.equal((app.getState(S_PRODUCTS) as Array<Record<string, number>>)[1][F_STOCK], 5);
  assert.ok(
    app.diagnostics().some((diagnostic) => diagnostic.code === 'CONSTRAINT_VIOLATION'),
    'the invariant refused the value, and the control re-rendered with what is stored',
  );
});

test('a form declares one place to write, and the mode follows from which', () => {
  const graph = buildDomain();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, 'FORM_TARGET_AMBIGUOUS'],
    [{ draft: S_DRAFT, target: { state: S_PRODUCTS, identity: ref(P_CODE) } }, 'FORM_TARGET_AMBIGUOUS'],
    [{ target: { state: S_PRODUCTS, identity: ref(P_CODE) }, mode: 'create' }, 'MODE_CONTRADICTS_TARGET'],
    [{ target: { state: S_COUNT, identity: ref(P_CODE) } }, 'TARGET_NOT_A_COLLECTION'],
  ];
  for (const [extra, code] of cases) {
    assert.throws(
      () => axiomUi.expand(graph, { pattern: 'entity-form', instance: 'f', submit: A_SAVE, ...extra }),
      (error: unknown) => {
        assert.ok(error instanceof PatternExpansionError, `${code}: expected a refusal`);
        assert.ok(
          error.findings.some((finding) => finding.code === code),
          `expected ${code}, got ${error.findings.map((finding) => finding.code).join(', ')}`,
        );
        return true;
      },
    );
  }
});

test('editing an entity with no identity field is refused, because nothing could address it', () => {
  const graph = buildDomain();
  const entity = graph.getNode<EntityDef>(E_PRODUCT) as EntityDef;
  delete entity.identityFieldId;
  graph.updateNode(entity);

  assert.throws(
    () =>
      axiomUi.expand(graph, {
        pattern: 'entity-form',
        instance: 'edit_product',
        target: { state: S_PRODUCTS, identity: ref(P_CODE) },
        submit: A_SAVE,
      }),
    (error: unknown) => {
      assert.ok(error instanceof PatternExpansionError);
      assert.equal(error.findings[0].code, 'NO_IDENTITY_FIELD');
      assert.equal(error.findings[0].path, 'edit_product.target.identity');
      return true;
    },
  );
});

test('a create form is unchanged: a draft, every field, identity included', () => {
  const graph = buildDomain();
  const page = axiomUi.expand(graph, {
    pattern: 'page',
    instance: 'new',
    title: 'New product',
    content: [{ pattern: 'entity-form', instance: 'new_product', draft: S_DRAFT, submit: A_ADD }],
  });
  route(graph, String(page), '/');

  assert.deepEqual(validateGraph(graph).errors, []);
  const inputs = graph
    .listNodes()
    .filter((node): node is InputNode => node.kind === 'input')
    .filter((node) => String(node.id).startsWith('ui_new_product_input'));
  assert.equal(inputs.length, 4, 'a create form offers the identity field');
  assert.match(JSON.stringify(inputs[0].binding.location), new RegExp(String(S_DRAFT)));
});

// --------------------------------------------------- entity form: options source

test('a form field can offer a choice drawn from application data', () => {
  const graph = buildDomain();
  const page = axiomUi.expand(graph, {
    pattern: 'page',
    instance: 'new',
    title: 'New product',
    content: [
      {
        pattern: 'entity-form',
        instance: 'new_product',
        draft: S_DRAFT,
        submit: A_ADD,
        options: {
          [F_SUPPLIER]: {
            source: ref(S_SUPPLIERS),
            scopeId: nodeId('scope_supplier_option'),
            valueFieldId: F_SUPPLIER_ID,
            labelFieldId: F_SUPPLIER_NAME,
          },
        },
      },
    ],
  });
  route(graph, String(page), '/');

  assert.deepEqual(validateGraph(graph).errors, []);
  const input = graph
    .listNodes()
    .filter((node): node is InputNode => node.kind === 'input')
    .find((node) => JSON.stringify(node.binding.location).includes(String(F_SUPPLIER)));
  assert.equal(input?.options?.valueFieldId, F_SUPPLIER_ID, 'the canonical options source is carried through');
  assert.equal(input?.presentation?.control, 'select', 'and the control follows from it');

  // It renders as a choice, labelled by the referenced record and valued by its identity.
  const { app, host } = render(graph, '/');
  const control = findAll(host.root, (element) => element.getAttribute('data-control') === String(input?.id))[0];
  assert.equal(control.tagName, 'select');
  assert.deepEqual(
    control.children.map((option) => [option.getAttribute('value'), textOf(option)]),
    [
      ['s1', 'Nordvik'],
      ['s2', 'Fjell'],
    ],
  );

  control.value = 's2';
  control.dispatch('change');
  assert.equal((app.getState(S_DRAFT) as Record<string, unknown>)[F_SUPPLIER], 's2');
});

test('an options source for a field the entity does not have is refused at the declaration', () => {
  const graph = buildDomain();
  assert.throws(
    () =>
      axiomUi.expand(graph, {
        pattern: 'entity-form',
        instance: 'new_product',
        draft: S_DRAFT,
        submit: A_ADD,
        options: {
          [F_SUPPLIER_NAME]: {
            source: ref(S_SUPPLIERS),
            scopeId: nodeId('scope_option'),
            valueFieldId: F_SUPPLIER_ID,
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof PatternExpansionError);
      assert.equal(error.findings[0].code, 'FIELD_NOT_ON_ENTITY');
      assert.match(error.findings[0].path, /new_product\.options\./);
      return true;
    },
  );
});
