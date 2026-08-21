import assert from 'node:assert/strict';
import test from 'node:test';
import { fieldLocation, identitySelector, itemLocation, stateLocation, validateGraph } from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';
import type { ApplicationGraph, NodeId } from '@cynodia/axiom-core';
import { compileToIR } from '@cynodia/axiom-compiler';
import {
  RUNTIME_DIAGNOSTIC_CODES,
  createAxiomRuntime,
  createMemoryHost,
  findAll,
  textOf,
} from '@cynodia/axiom-runtime';
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
  app.hydrateState(ids.STATE_PRODUCTS, products);
}

function addLine(app: AxiomRuntime, productId: string, quantity: number) {
  const draft = app.getState(ids.STATE_DRAFT_LINE) as Record_;
  app.hydrateState(ids.STATE_DRAFT_LINE, {
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
  // Section 60: the value stays a number; only what is shown is formatted.
  assert.match(textOf(host.root), /Order total NOK\s?200\.00/);

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
  app.hydrateState(ids.STATE_PRODUCTS, products);

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
  app.hydrateState(ids.STATE_DRAFT_CUSTOMER, 'customer-2');
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

/** Section 43 — a direct input into confirmed state must be refused by the framework. */
test('an input bound straight into a confirmed order is rejected', () => {
  const { app, host } = run();
  addLine(app, 'product-a', 2);
  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, true);

  const control = findAll(
    host.root,
    (element) => element.getAttribute('data-node') === ids.UI_LINE_QUANTITY && element.tagName !== 'label',
  )[0];
  assert.ok(control, 'the quantity input is rendered — nothing is hidden');

  control.value = '7';
  control.dispatch('input');

  assert.equal(linesOf(app)[0][ids.F_LINE_QUANTITY], 2, 'the write did not land');
  const rejection = app
    .diagnostics()
    .find((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.TRANSITION_CONSTRAINT_VIOLATION);
  assert.ok(rejection, 'and it was refused as a transition, not as a value problem');
  assert.equal(rejection.details?.entityId, ids.ENTITY_ORDER);
  assert.equal(rejection.details?.source, 'input');
  assert.equal(app.getMutationLog().at(-1)?.outcome, 'rolled-back');
});

/** Section 45 — the same input on a draft order still works. */
test('the same input works while the order is a draft', () => {
  const { app, host } = run();
  addLine(app, 'product-a', 2);

  const control = findAll(
    host.root,
    (element) => element.getAttribute('data-node') === ids.UI_LINE_QUANTITY && element.tagName !== 'label',
  )[0];
  assert.ok(control);
  control.value = '5';
  control.dispatch('input');

  assert.equal(linesOf(app)[0][ids.F_LINE_QUANTITY], 5, 'the rule is about transitions, not read-only fields');
});

/** Section 44 — the action path stays closed too. */
test('a confirmed order refuses changes through actions as well as inputs', () => {
  const { app } = run();
  addLine(app, 'product-a', 1);
  app.invokeAction(ids.ACTION_CONFIRM_ORDER);
  const before = JSON.stringify(app.getState(ids.STATE_ORDERS));

  assert.equal(addLine(app, 'product-b', 1).ok, false);
  assert.equal(JSON.stringify(app.getState(ids.STATE_ORDERS)), before);
});

/** Section 49 — each iteration sees what the previous ones proposed. */
test('an iteration reads the provisional state the previous iterations left', () => {
  const { app } = run();
  setStock(app, 'product-a', 5);
  addLine(app, 'product-a', 3);
  addLine(app, 'product-a', 1);

  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, true);

  const stockWrites = app
    .getMutationLog()
    .filter((entry) => entry.source === 'action' && entry.description.endsWith(String(ids.F_PRODUCT_STOCK)));
  assert.deepEqual(
    stockWrites.map((entry) => [entry.oldValue, entry.newValue]),
    [
      [5, 2],
      [2, 1],
    ],
    'the second iteration debits the value the first one left, not the value it started from',
  );
  assert.equal(stockOf(app, 'product-a'), 1);
});

test('the same sequence rolls back completely when it ends below zero', () => {
  const { app } = run();
  setStock(app, 'product-a', 5);
  addLine(app, 'product-a', 3);
  addLine(app, 'product-a', 3);

  // The aggregate guard refuses first; without it the invariant would still catch it.
  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, false);
  assert.equal(stockOf(app, 'product-a'), 5);
  assert.equal(order(app)[ids.F_ORDER_STATUS], 'draft');
});

// ------------------------------------------------- agent dependency answers

/** Section 25. */
test('every semantic consumer of a line quantity is discoverable', () => {
  const agent = new AgentAPI(createOrderSystemGraph());
  const readers = agent.getFieldReaders(ids.F_LINE_QUANTITY).map((node) => node.name ?? node.id);

  assert.ok(readers.includes('currentOrderTotal'), 'the order total projects it');
  assert.ok(readers.includes('confirmOrder'), 'the aggregate stock check sums it');
  assert.ok(readers.includes('A line quantity is always positive'), 'the constraint validates it');
  assert.ok(readers.some((name) => String(name).startsWith('ui_')), 'the UI shows it');
});

/** Section 26. */
test('reading a price to copy it is not reported as writing it', () => {
  const agent = new AgentAPI(createOrderSystemGraph());

  assert.deepEqual(
    agent.getFieldWriters(ids.F_PRODUCT_PRICE).map((node) => node.name ?? node.id),
    [],
    'nothing writes Product.unitPrice',
  );
  assert.deepEqual(
    agent.getFieldReaders(ids.F_PRODUCT_PRICE).map((node) => node.name ?? node.id),
    ['addLine'],
    'but adding a line reads it, to capture the price',
  );
  assert.deepEqual(
    agent.getFieldWriters(ids.F_LINE_UNIT_PRICE).map((node) => node.name ?? node.id),
    ['addLine'],
    'and writes the captured price onto the line',
  );
});

/** Section 33 — the rules protecting a location are answerable. */
test('an agent can ask what protects a location', () => {
  const agent = new AgentAPI(createOrderSystemGraph());
  const rules = agent.getRulesProtecting(
    fieldLocation(
      itemLocation(
        stateLocation(ids.STATE_ORDERS),
        identitySelector(ids.F_ORDER_ID, { kind: 'literal', value: 'order-1' }),
      ),
      ids.F_ORDER_STATUS,
    ),
  );

  assert.deepEqual(
    rules.transitionConstraints.map((constraint) => constraint.id),
    [ids.TRANSITION_ORDER_SEALED],
  );
});

test('an agent is told when dependency analysis is incomplete', () => {
  const agent = new AgentAPI(createOrderSystemGraph());
  const impact = agent.getMutationImpact(stateLocation(ids.STATE_PRODUCTS));

  assert.equal(impact.analysisComplete, true, 'the order system has no unanalyzable operations');
  assert.deepEqual(impact.analysisGaps, []);
});
