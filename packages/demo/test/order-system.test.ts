import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGraph } from '@cynodia/axiom-core';
import type { ApplicationGraph, NodeId } from '@cynodia/axiom-core';
import { compileToIR } from '@cynodia/axiom-compiler';
import { RUNTIME_DIAGNOSTIC_CODES, createAxiomRuntime, createMemoryHost, textOf } from '@cynodia/axiom-runtime';
import type { AxiomRuntime } from '@cynodia/axiom-runtime';
import { createOrderSystemGraph, orderSystemIds as ids } from '@cynodia/axiom-demo/order-system';

/**
 * The 0.4 acceptance fixture. Everything here is graph semantics: there is no native
 * operation and no application-specific JavaScript in the framework or the fixture.
 */
function run(graph: ApplicationGraph = createOrderSystemGraph()) {
  const host = createMemoryHost({ path: '/orders/order-1' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  return { app, host };
}

type Record_ = Record<string, unknown>;

const order = (app: AxiomRuntime): Record_ =>
  (app.getState(ids.STATE_ORDERS) as Record_[])[0];
const linesOf = (app: AxiomRuntime): Record_[] => order(app)[ids.F_ORDER_LINES] as Record_[];
const stockOf = (app: AxiomRuntime, productId: string): number =>
  (app.getState(ids.STATE_PRODUCTS) as Record_[]).find(
    (product) => product[ids.F_PRODUCT_ID] === productId,
  )?.[ids.F_PRODUCT_STOCK] as number;

function setStock(app: AxiomRuntime, productId: string, stock: number): void {
  const products = app.getState(ids.STATE_PRODUCTS) as Record_[];
  const product = products.find((candidate) => candidate[ids.F_PRODUCT_ID] === productId);
  assert.ok(product);
  product[ids.F_PRODUCT_STOCK] = stock;
  app.setState(ids.STATE_PRODUCTS, products);
}

function addLine(app: AxiomRuntime, productId: string, quantity: number) {
  const draft = app.getState(ids.STATE_DRAFT_LINE) as Record_;
  app.setState(ids.STATE_DRAFT_LINE, {
    ...draft,
    [ids.F_LINE_PRODUCT]: productId,
    [ids.F_LINE_QUANTITY]: quantity,
  });
  return app.invokeAction(ids.ACTION_ADD_LINE);
}

test('the order system is a valid graph with no warnings', () => {
  const result = validateGraph(createOrderSystemGraph());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('the order system uses no native operations', () => {
  const ir = compileToIR(createOrderSystemGraph());
  const native = Object.values(ir.actions).flatMap((action) =>
    (action.operations ?? []).filter((operation) => operation.kind === 'native'),
  );
  assert.deepEqual(native, [], 'business logic is semantics, not an escape hatch');
});

test('a line captures the unit price at the moment it is added', () => {
  const { app } = run();
  assert.equal(addLine(app, 'product-a', 2).ok, true);

  const [line] = linesOf(app);
  assert.equal(line[ids.F_LINE_UNIT_PRICE], 100, 'the product price is copied into the line');
  assert.equal(app.getState(ids.STATE_ORDER_TOTAL), 200, 'the total is a projection summed');
});

/** Section 31. */
test('confirming an order reduces stock, sets the status and keeps the total', () => {
  const { app, host } = run();
  addLine(app, 'product-a', 2);

  const result = app.invokeAction(ids.ACTION_CONFIRM_ORDER);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(stockOf(app, 'product-a'), 8);
  assert.equal(order(app)[ids.F_ORDER_STATUS], 'confirmed');
  assert.equal(app.getState(ids.STATE_ORDER_TOTAL), 200);
  assert.match(textOf(host.root), /Order total: 200/);

  const committed = app.getMutationLog().filter((entry) => entry.outcome === 'committed');
  assert.ok(
    committed.some((entry) => entry.description.includes(String(ids.STATE_PRODUCTS))),
    'the log identifies the stock write',
  );
  assert.ok(committed.some((entry) => entry.description.includes(String(ids.STATE_ORDERS))));
});

/** Section 32. */
test('a confirmation that cannot be covered leaves every product untouched', () => {
  const { app } = run();
  addLine(app, 'product-a', 2);
  addLine(app, 'product-b', 5);

  const result = app.invokeAction(ids.ACTION_CONFIRM_ORDER);

  assert.equal(result.ok, false);
  assert.match(
    result.diagnostics.find((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED)
      ?.message ?? '',
    /not enough stock/i,
  );
  assert.equal(stockOf(app, 'product-a'), 10, 'the covered product was not reduced either');
  assert.equal(stockOf(app, 'product-b'), 3);
  assert.equal(order(app)[ids.F_ORDER_STATUS], 'draft');
});

/** Section 33 — the aggregate case, across two lines for one product. */
test('two lines for one product are counted together against its stock', () => {
  const { app } = run();
  setStock(app, 'product-a', 5);
  addLine(app, 'product-a', 3);
  addLine(app, 'product-a', 3);

  const result = app.invokeAction(ids.ACTION_CONFIRM_ORDER);

  assert.equal(result.ok, false, 'six requested against five in stock');
  assert.equal(stockOf(app, 'product-a'), 5);
  assert.equal(order(app)[ids.F_ORDER_STATUS], 'draft');
});

test('the same two lines succeed once the stock covers their sum', () => {
  const { app } = run();
  setStock(app, 'product-a', 6);
  addLine(app, 'product-a', 3);
  addLine(app, 'product-a', 3);

  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, true);
  assert.equal(stockOf(app, 'product-a'), 0, 'both iterations applied');
});

/** Section 34. */
test('a confirmed order keeps the price it was placed at', () => {
  const { app } = run();
  addLine(app, 'product-a', 2);
  app.invokeAction(ids.ACTION_CONFIRM_ORDER);
  assert.equal(app.getState(ids.STATE_ORDER_TOTAL), 200);

  const products = app.getState(ids.STATE_PRODUCTS) as Record_[];
  products[0][ids.F_PRODUCT_PRICE] = 150;
  app.setState(ids.STATE_PRODUCTS, products);

  assert.equal(app.getState(ids.STATE_ORDER_TOTAL), 200, 'history is a snapshot, not a live lookup');
});

/** Section 35. */
test('a confirmed order refuses every change, and changes nothing when it does', () => {
  const { app } = run();
  addLine(app, 'product-a', 1);
  app.invokeAction(ids.ACTION_CONFIRM_ORDER);

  const before = JSON.stringify(app.getState(ids.STATE_ORDERS));
  const lineId = linesOf(app)[0][ids.F_LINE_ID] as string;

  assert.equal(addLine(app, 'product-b', 1).ok, false, 'cannot add a line');
  assert.equal(
    app.invokeAction(ids.ACTION_REMOVE_LINE, { [ids.PARAM_REMOVE_LINE]: lineId }).ok,
    false,
    'cannot remove a line',
  );
  app.setState(ids.STATE_DRAFT_CUSTOMER, 'customer-2');
  assert.equal(app.invokeAction(ids.ACTION_SET_CUSTOMER).ok, false, 'cannot change the customer');
  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, false, 'cannot confirm twice');

  assert.equal(JSON.stringify(app.getState(ids.STATE_ORDERS)), before, 'nothing moved');
});

test('an empty order cannot be confirmed', () => {
  const { app } = run();
  const result = app.invokeAction(ids.ACTION_CONFIRM_ORDER);

  assert.equal(result.ok, false);
  assert.match(
    result.diagnostics.find((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED)
      ?.message ?? '',
    /at least one line/,
  );
});

test('a refusal names the condition that failed, not merely the first one', () => {
  const { app } = run();
  addLine(app, 'product-b', 5);

  const failure = app
    .invokeAction(ids.ACTION_CONFIRM_ORDER)
    .diagnostics.find((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED);

  assert.equal(failure?.details?.failureMode, 'insufficient-stock');
  assert.equal(failure?.details?.preconditionIndex, 2);
  assert.equal(failure?.actionId, ids.ACTION_CONFIRM_ORDER);
});

test('the line form drives the whole flow through the UI', () => {
  const { app, host } = run();

  const control = (id: NodeId) => {
    const found = host.root && [...findAll(host.root)].find(
      (element) => element.getAttribute('data-node') === id && element.tagName !== 'label',
    );
    assert.ok(found, `no control for ${id}`);
    return found;
  };
  function* findAll(element: ReturnType<typeof createMemoryHost>['root']): Generator<typeof element> {
    yield element;
    for (const child of element.children) {
      yield* findAll(child);
    }
  }

  const product = control(ids.UI_LINE_PRODUCT_INPUT);
  product.value = 'product-a';
  product.dispatch('input');
  const quantity = control(ids.UI_LINE_QUANTITY_INPUT);
  quantity.value = '2';
  quantity.dispatch('input');
  control(ids.UI_LINE_FORM).dispatch('submit');

  assert.equal(linesOf(app).length, 1);
  control(ids.UI_CONFIRM_BUTTON).dispatch('click');

  assert.equal(order(app)[ids.F_ORDER_STATUS], 'confirmed');
  assert.equal(stockOf(app, 'product-a'), 8);
});
