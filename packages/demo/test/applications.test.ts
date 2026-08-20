import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGraph } from '@axiom/core';
import type { ApplicationGraph, NodeId } from '@axiom/core';
import { compileToHtml, compileToIR } from '@axiom/compiler';
import { createAxiomRuntime, createMemoryHost, findByNodeId, textOf } from '@axiom/runtime';
import type { MemoryElement, MemoryHostOptions } from '@axiom/runtime';
import { createIssueTrackerGraph, issueTrackerIds } from '@axiom/demo/issue-tracker';
import { createInventoryGraph, inventoryIds } from '@axiom/demo/inventory';
import { demoApplications } from '@axiom/demo';

function run(graph: ApplicationGraph, options: MemoryHostOptions = {}) {
  const host = createMemoryHost({ path: '/', ...options });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  return { app, host };
}

function control(root: MemoryElement, id: NodeId): MemoryElement {
  const found = findByNodeId(root, id).find((element) => element.tagName !== 'label');
  assert.ok(found, `no control rendered for ${id}`);
  return found;
}

function type(root: MemoryElement, id: NodeId, value: string): void {
  const element = control(root, id);
  element.value = value;
  element.dispatch('input');
}

test('both applications are valid graphs', () => {
  for (const application of demoApplications) {
    const result = validateGraph(application.createGraph());
    assert.deepEqual(result.errors, [], `${application.slug} has validation errors`);
  }
});

test('both applications compile to a page through the same compiler', () => {
  const pages = demoApplications.map((application) => compileToHtml(application.createGraph()));
  for (const page of pages) {
    assert.match(page, /createAxiomRuntime/);
  }
  const [first, second] = pages;
  assert.notEqual(first, second, 'the pages differ only because the graphs differ');
});

test('the two applications share one runtime and one compiler', () => {
  const irs = demoApplications.map((application) => compileToIR(application.createGraph()));
  assert.deepEqual(
    irs.map((ir) => ir.id),
    ['issue-tracker', 'inventory'],
  );
  for (const ir of irs) {
    assert.ok(ir.routes.length > 0);
    assert.ok(ir.entities.length > 0);
    assert.ok(Object.keys(ir.uiNodes).length > 0);
  }
});

// --------------------------------------------------------------- issue tracker

test('the issue tracker lists, filters and opens records', () => {
  const { host } = run(createIssueTrackerGraph());
  assert.match(textOf(host.root), /Describe the semantic UI vocabulary/);
  assert.match(textOf(host.root), /Validate every graph before execution/);

  type(host.root, issueTrackerIds.UI_FILTER_SEARCH, 'Validate');
  assert.doesNotMatch(textOf(host.root), /Describe the semantic UI vocabulary/);
  assert.match(textOf(host.root), /Validate every graph before execution/);

  type(host.root, issueTrackerIds.UI_FILTER_SEARCH, '');
  findByNodeId(host.root, issueTrackerIds.UI_ROW_OPEN)[0].dispatch('click');
  assert.equal(host.path, '/issues/issue-1');
  assert.match(textOf(host.root), /Comments/);
});

test('the issue tracker creates a record and returns to the list', () => {
  const { app, host } = run(createIssueTrackerGraph(), { path: '/issues/new' });

  const empty = app.invokeAction(issueTrackerIds.ACTION_CREATE_ISSUE);
  assert.equal(empty.ok, false, 'an issue without a title is refused');

  type(host.root, 'ui_create_title_input' as NodeId, 'Write the migration guide');
  findByNodeId(host.root, issueTrackerIds.UI_CREATE_FORM)[0].dispatch('submit');

  assert.equal(host.path, '/');
  const titles = (app.getState(issueTrackerIds.STATE_ISSUES) as Array<Record<string, unknown>>).map(
    (record) => record[issueTrackerIds.F_ISSUE_TITLE],
  );
  assert.deepEqual(titles[0], 'Write the migration guide');
  assert.match(textOf(host.root), /Write the migration guide/);
});

test('the issue tracker edits through bindings and deletes with confirmation', () => {
  const { app, host } = run(createIssueTrackerGraph(), { path: '/issues/issue-2', confirm: true });

  type(host.root, issueTrackerIds.UI_DETAIL_TITLE_INPUT, 'Renamed in place');
  const stored = app.getState(issueTrackerIds.STATE_ISSUES) as Array<Record<string, unknown>>;
  assert.equal(stored[1][issueTrackerIds.F_ISSUE_TITLE], 'Renamed in place');

  findByNodeId(host.root, issueTrackerIds.UI_DETAIL_DELETE)[0].dispatch('click');
  assert.deepEqual(host.confirmations, ['Delete this issue permanently?']);
  assert.equal((app.getState(issueTrackerIds.STATE_ISSUES) as unknown[]).length, 1);
  assert.equal(host.path, '/');
});

test('the issue tracker adds comments only when they have a body', () => {
  const { app, host } = run(createIssueTrackerGraph(), { path: '/issues/issue-1' });

  assert.equal(app.invokeAction(issueTrackerIds.ACTION_ADD_COMMENT).ok, false);
  type(host.root, 'ui_comment_body_input' as NodeId, 'Looks right to me.');
  assert.equal(app.invokeAction(issueTrackerIds.ACTION_ADD_COMMENT).ok, true);

  const comments = app.getState(issueTrackerIds.STATE_COMMENTS) as Array<Record<string, unknown>>;
  assert.equal(comments.length, 2);
  assert.equal(comments[1][issueTrackerIds.F_COMMENT_BODY], 'Looks right to me.');
  assert.match(textOf(host.root), /Looks right to me\./);
});

// -------------------------------------------------------------------- inventory

test('the inventory application searches and navigates', () => {
  const { host } = run(createInventoryGraph());
  assert.match(textOf(host.root), /Graph analyser/);

  type(host.root, inventoryIds.UI_PRODUCTS_SEARCH, 'AX-1002');
  assert.doesNotMatch(textOf(host.root), /Graph analyser/);
  assert.match(textOf(host.root), /Semantic inspector/);

  type(host.root, inventoryIds.UI_PRODUCTS_SEARCH, '');
  findByNodeId(host.root, inventoryIds.UI_ROW_OPEN)[0].dispatch('click');
  assert.equal(host.path, '/products/product-1');
});

test('receiving and issuing stock changes quantities through generic operations', () => {
  const { app, host } = run(createInventoryGraph(), { path: '/products/product-2' });
  const quantity = () =>
    (app.getState(inventoryIds.STATE_CURRENT_PRODUCT) as Record<string, unknown>)[
      inventoryIds.F_PRODUCT_QUANTITY
    ];

  assert.equal(quantity(), 3);

  type(host.root, inventoryIds.UI_STOCK_QUANTITY_INPUT, '4');
  findByNodeId(host.root, inventoryIds.UI_STOCK_FORM)[0].dispatch('submit');
  assert.equal(quantity(), 7);
  assert.equal((app.getState(inventoryIds.STATE_MOVEMENTS) as unknown[]).length, 1);

  type(host.root, inventoryIds.UI_STOCK_QUANTITY_INPUT, '2');
  findByNodeId(host.root, inventoryIds.UI_STOCK_ISSUE_BUTTON)[0].dispatch('click');
  assert.equal(quantity(), 5);
  assert.equal((app.getState(inventoryIds.STATE_MOVEMENTS) as unknown[]).length, 2);
});

test('a precondition prevents issuing more stock than is on hand', () => {
  const { app, host } = run(createInventoryGraph(), { path: '/products/product-2' });

  type(host.root, inventoryIds.UI_STOCK_QUANTITY_INPUT, '99');
  const result = app.invokeAction(inventoryIds.ACTION_ISSUE_STOCK);

  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0]?.message ?? '', /not enough stock/i);
  assert.equal(
    (app.getState(inventoryIds.STATE_CURRENT_PRODUCT) as Record<string, unknown>)[
      inventoryIds.F_PRODUCT_QUANTITY
    ],
    3,
  );
  assert.equal((app.getState(inventoryIds.STATE_MOVEMENTS) as unknown[]).length, 0);
});

test('a low-stock warning is expressed in the graph, not in the renderer', () => {
  const { host } = run(createInventoryGraph(), { path: '/products/product-2' });
  assert.match(textOf(host.root), /Stock is running low/);

  const { host: healthy } = run(createInventoryGraph(), { path: '/products/product-1' });
  assert.doesNotMatch(textOf(healthy.root), /Stock is running low/);
});

test('the inventory application creates products and lists warehouses', () => {
  const { app, host } = run(createInventoryGraph(), { path: '/products/new' });

  assert.equal(app.invokeAction(inventoryIds.ACTION_CREATE_PRODUCT).ok, false);
  type(host.root, 'ui_create_product_sku' as NodeId, 'AX-2000');
  type(host.root, 'ui_create_product_name' as NodeId, 'Constraint checker');
  assert.equal(app.invokeAction(inventoryIds.ACTION_CREATE_PRODUCT).ok, true);

  assert.equal((app.getState(inventoryIds.STATE_PRODUCTS) as unknown[]).length, 3);
  assert.equal(host.path, '/');

  app.navigate('/warehouses');
  assert.match(textOf(host.root), /North depot/);
  assert.match(textOf(host.root), /Kristiansand/);
});

// ------------------------------------------------- the two editing patterns

test('editing a stored record directly cannot leave it invalid', () => {
  const { app, host } = run(createIssueTrackerGraph(), { path: '/issues/issue-1' });

  type(host.root, issueTrackerIds.UI_DETAIL_TITLE_INPUT, '');

  const stored = app.getState(issueTrackerIds.STATE_ISSUES) as Array<Record<string, unknown>>;
  assert.equal(
    stored[0][issueTrackerIds.F_ISSUE_TITLE],
    'Describe the semantic UI vocabulary',
    'the direct editor keeps canonical state valid',
  );
  assert.equal(control(host.root, issueTrackerIds.UI_DETAIL_TITLE_INPUT).value, 'Describe the semantic UI vocabulary');

  type(host.root, issueTrackerIds.UI_DETAIL_TITLE_INPUT, 'A better title');
  assert.equal(
    (app.getState(issueTrackerIds.STATE_ISSUES) as Array<Record<string, unknown>>)[0][
      issueTrackerIds.F_ISSUE_TITLE
    ],
    'A better title',
  );
});

test('filling in a draft may pass through invalid states', () => {
  const { app, host } = run(createIssueTrackerGraph(), { path: '/issues/new' });

  type(host.root, 'ui_create_title_input' as NodeId, 'Half');
  type(host.root, 'ui_create_title_input' as NodeId, '');

  assert.equal(
    (app.getState(issueTrackerIds.STATE_DRAFT_ISSUE) as Record<string, unknown>)[
      issueTrackerIds.F_ISSUE_TITLE
    ],
    '',
    'a draft is incomplete by definition while it is being filled in',
  );
  assert.equal(
    app.invokeAction(issueTrackerIds.ACTION_CREATE_ISSUE).ok,
    false,
    'the action is where the draft has to be valid',
  );

  type(host.root, 'ui_create_title_input' as NodeId, 'Complete now');
  assert.equal(app.invokeAction(issueTrackerIds.ACTION_CREATE_ISSUE).ok, true);
});

test('a required field of a stored product is equally protected', () => {
  const { app, host } = run(createInventoryGraph(), { path: '/products/product-1' });
  const skuInput = findByNodeId(host.root, 'ui_product_sku_input' as NodeId).find(
    (element) => element.tagName !== 'label',
  );
  assert.ok(skuInput);

  skuInput.value = '';
  skuInput.dispatch('input');

  assert.equal(
    (app.getState(inventoryIds.STATE_PRODUCTS) as Array<Record<string, unknown>>)[0][
      inventoryIds.F_PRODUCT_SKU
    ],
    'AX-1001',
  );
});
