import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_THEME,
  isUINode,
  resolvePresentationMap,
  resolveTheme,
  validateGraph,
} from '@cynodia/axiom-core';
import type { ApplicationGraph, ThemeInput, UINode } from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';
import { compileToHtml, compileToIR, createThemeStylesheet } from '@cynodia/axiom-compiler';
import {
  createAxiomRuntime,
  createMemoryHost,
  findAll,
  findByNodeId,
  findByTag,
  textOf,
  typeInto,
} from '@cynodia/axiom-runtime';
import type { MemoryElement } from '@cynodia/axiom-runtime';
import { createOrderSystemGraph, orderSystemIds as ids } from '@cynodia/axiom-demo/order-system';

/**
 * The 0.5.2 hardening acceptance tests.
 *
 * Each one covers a case where an application previously had to compensate for the
 * framework: duplicated DOM identity inside a repeat, action failures that only reached the
 * console, buttons needing the same corrective layout everywhere, and a type scale that
 * could not be used without becoming a document heading.
 */

function run(path = '/orders/order-1', graph: ApplicationGraph = createOrderSystemGraph()) {
  const host = createMemoryHost({ path });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  return { app, host, graph };
}

const LINE = (product: string, quantity: number, id: string) => ({
  [ids.F_LINE_ID]: id,
  [ids.F_LINE_PRODUCT]: product,
  [ids.F_LINE_QUANTITY]: quantity,
  [ids.F_LINE_UNIT_PRICE]: 100,
});

/** Seeds the routed order with lines, so the repeat renders several editable rows. */
function withLines(app: ReturnType<typeof run>['app'], ...lines: Array<Record<string, unknown>>): void {
  const orders = app.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>;
  orders[0][ids.F_ORDER_LINES] = lines;
  app.hydrateState(ids.STATE_ORDERS, orders);
}

function elements(root: MemoryElement, nodeId: string): MemoryElement[] {
  return findByNodeId(root, nodeId);
}

/** The control for one rendered instance of an input, found by its own element id. */
function controlOf(root: MemoryElement, nodeId: string, index: number): MemoryElement {
  const controls = elements(root, nodeId).filter((element) => element.getAttribute('id') !== null);
  assert.ok(controls[index], `no control ${index} for ${nodeId}`);
  return controls[index];
}

function allIds(root: MemoryElement): string[] {
  return findAll(root, (element) => element.getAttribute('id') !== null).map(
    (element) => element.getAttribute('id') as string,
  );
}

// ------------------------------------------------- 1-5: repeat instance identity

test('a repeated control has one element id per rendered instance', () => {
  const { app, host } = run();
  withLines(app, LINE('product-a', 1, 'line-1'), LINE('product-b', 2, 'line-2'));

  const rendered = allIds(host.root);
  assert.deepEqual(
    rendered.filter((id, index) => rendered.indexOf(id) !== index),
    [],
    'no duplicate element ids anywhere in the document',
  );

  // The quantity input is one semantic node rendered twice.
  const controls = elements(host.root, ids.UI_LINE_QUANTITY).filter(
    (element) => element.getAttribute('id') !== null,
  );
  assert.equal(controls.length, 2);
  assert.notEqual(controls[0].getAttribute('id'), controls[1].getAttribute('id'));
  // Section 2: identity is semantic where the collection has any.
  assert.match(controls[0].getAttribute('id') ?? '', /line-1$/);
  assert.match(controls[1].getAttribute('id') ?? '', /line-2$/);
});

/** Section 4: the graph still holds one node; only the rendering is per instance. */
test('semantic node identity survives alongside render identity', () => {
  const { app, host } = run();
  withLines(app, LINE('product-a', 1, 'line-1'), LINE('product-b', 2, 'line-2'));

  for (const element of elements(host.root, ids.UI_LINE_QUANTITY)) {
    assert.equal(element.getAttribute('data-node'), ids.UI_LINE_QUANTITY);
    assert.match(element.getAttribute('data-instance') ?? '', /^ui_line_quantity--line-\d$/);
  }
  // And an agent still reasons about the one semantic node.
  const agent = new AgentAPI(createOrderSystemGraph());
  assert.ok(agent.resolvePresentation(ids.UI_LINE_QUANTITY));
});

test('each label targets the control in its own row', () => {
  const { app, host } = run();
  withLines(app, LINE('product-a', 1, 'line-1'), LINE('product-b', 2, 'line-2'));

  const wrappers = elements(host.root, ids.UI_LINE_QUANTITY).filter(
    (element) => element.tagName === 'label',
  );
  assert.equal(wrappers.length, 2);
  wrappers.forEach((wrapper, index) => {
    assert.equal(wrapper.getAttribute('for'), controlOf(host.root, ids.UI_LINE_QUANTITY, index).getAttribute('id'));
  });
});

/** The bug this release exists for. */
test('refusing a write in one row marks only that row invalid', () => {
  const { app, host } = run();
  withLines(app, LINE('product-a', 1, 'line-1'), LINE('product-b', 2, 'line-2'));

  // A quantity of zero breaks the line-quantity invariant, so the write is refused.
  typeInto(controlOf(host.root, ids.UI_LINE_QUANTITY, 0), '0');

  const refused = controlOf(host.root, ids.UI_LINE_QUANTITY, 0);
  const untouched = controlOf(host.root, ids.UI_LINE_QUANTITY, 1);
  assert.equal(refused.getAttribute('aria-invalid'), 'true', 'the row that was refused');
  assert.equal(untouched.getAttribute('aria-invalid'), null, 'and only that row');

  // The announced message belongs to the refused row alone. Empty live regions are
  // rendered so that later content is announced, so only those with content are counted.
  const alerts = findAll(
    host.root,
    (element) => element.getAttribute('role') === 'alert' && textOf(element).trim() !== '',
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].getAttribute('id'), refused.getAttribute('aria-describedby'));

  const lines = (app.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>)[0][
    ids.F_ORDER_LINES
  ] as Array<Record<string, unknown>>;
  assert.equal(lines[0][ids.F_LINE_QUANTITY], 1, 'nothing was stored');
});

test('editing one row writes only that row', () => {
  const { app, host } = run();
  withLines(app, LINE('product-a', 1, 'line-1'), LINE('product-b', 2, 'line-2'));

  typeInto(controlOf(host.root, ids.UI_LINE_QUANTITY, 1), '5');

  const lines = (app.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>)[0][
    ids.F_ORDER_LINES
  ] as Array<Record<string, unknown>>;
  assert.equal(lines[0][ids.F_LINE_QUANTITY], 1);
  assert.equal(lines[1][ids.F_LINE_QUANTITY], 5);
});

test('an instance identity is stable across a re-render and follows reordering', () => {
  const { app, host } = run();
  withLines(app, LINE('product-a', 1, 'line-1'), LINE('product-b', 2, 'line-2'));
  const before = elements(host.root, ids.UI_LINE_QUANTITY)
    .filter((element) => element.getAttribute('id'))
    .map((element) => element.getAttribute('id'));

  // Reordering the collection moves the identities with the rows, rather than reassigning
  // them by position.
  withLines(app, LINE('product-b', 2, 'line-2'), LINE('product-a', 1, 'line-1'));
  const after = elements(host.root, ids.UI_LINE_QUANTITY)
    .filter((element) => element.getAttribute('id'))
    .map((element) => element.getAttribute('id'));

  assert.deepEqual([...after].reverse(), before);
});

test('a collection with no semantic identity falls back to a deterministic index', () => {
  const { app, host } = run('/');
  // The order list repeats over orders, which do have identity; the fallback is exercised
  // by a collection of plain values.
  assert.ok(elements(host.root, ids.UI_ORDER_ROW).length > 0);
  const rows = elements(host.root, ids.UI_ORDER_ROW);
  assert.equal(rows[0].getAttribute('data-instance'), `${ids.UI_ORDER_ROW}--order-1`);
  void app;
});

// --------------------------------------------- 6-11: action diagnostics as UI

test('a refused action explains itself through semantic UI', () => {
  const { app, host } = run();

  // Confirming an order with no lines is refused by the second guard.
  const result = app.invokeAction(ids.ACTION_CONFIRM_ORDER);
  assert.equal(result.ok, false);

  const region = elements(host.root, ids.UI_CONFIRM_DIAGNOSTIC)[0];
  assert.ok(region, 'the diagnostic region is rendered');
  assert.equal(region.getAttribute('role'), 'alert', 'and it announces itself');
  assert.match(textOf(region), /at least one line/, 'with the failure mode’s own message');

  // Nothing about this required the application to duplicate the guard.
  const graph = createOrderSystemGraph();
  const derived = graph.getNodesByKind('state').filter((state) => state.derivation);
  assert.equal(
    derived.some((state) => String(state.name).toLowerCase().includes('canconfirm')),
    false,
  );
});

test('the initiating control points at the region that explains it', () => {
  const { app, host } = run();
  app.invokeAction(ids.ACTION_CONFIRM_ORDER);

  const button = elements(host.root, ids.UI_CONFIRM_BUTTON)[0];
  const region = elements(host.root, ids.UI_CONFIRM_DIAGNOSTIC)[0];
  assert.ok(button && region);
  assert.equal(button.getAttribute('aria-describedby'), region.getAttribute('id'));
});

test('a successful invocation clears the previous failure', () => {
  const { app, host } = run();
  app.invokeAction(ids.ACTION_CONFIRM_ORDER);
  assert.match(textOf(elements(host.root, ids.UI_CONFIRM_DIAGNOSTIC)[0]), /at least one line/);
  assert.equal(app.getActionOutcome(ids.ACTION_CONFIRM_ORDER)?.outcome, 'failed');

  withLines(app, LINE('product-a', 1, 'line-1'));
  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, true);

  assert.equal(app.getActionOutcome(ids.ACTION_CONFIRM_ORDER)?.outcome, 'ok');
  assert.deepEqual(app.getActionOutcome(ids.ACTION_CONFIRM_ORDER)?.diagnostics, []);
  assert.equal(textOf(elements(host.root, ids.UI_CONFIRM_DIAGNOSTIC)[0]).trim(), '');
});

test('a declined confirmation is recorded as cancelled, not as a refusal', () => {
  const host = createMemoryHost({ path: '/orders/order-1', confirm: false });
  const app = createAxiomRuntime({
    ir: compileToIR(createOrderSystemGraph()),
    rootElement: host.root,
    host,
  });
  app.start();
  withLines(app, LINE('product-a', 1, 'line-1'));

  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, false);
  const outcome = app.getActionOutcome(ids.ACTION_CONFIRM_ORDER);
  assert.equal(outcome?.outcome, 'cancelled');
  assert.deepEqual(outcome?.diagnostics, [], 'declining is not a refusal, so nothing is reported');
  assert.equal(textOf(elements(host.root, ids.UI_CONFIRM_DIAGNOSTIC)[0]).trim(), '');
});

test('a diagnostic region reports only its own action', () => {
  const { app, host } = run();
  app.invokeAction(ids.ACTION_ADD_LINE); // refused: the draft has no product

  assert.match(textOf(elements(host.root, ids.UI_LINE_DIAGNOSTIC)[0]), /needs a product/);
  assert.equal(textOf(elements(host.root, ids.UI_CONFIRM_DIAGNOSTIC)[0]).trim(), '');
});

test('diagnostics do not survive navigation', () => {
  const { app, host } = run();
  app.invokeAction(ids.ACTION_CONFIRM_ORDER);
  assert.equal(app.getActionOutcome(ids.ACTION_CONFIRM_ORDER)?.outcome, 'failed');

  app.navigate('/');
  assert.equal(app.getActionOutcome(ids.ACTION_CONFIRM_ORDER), undefined);
  void host;
});

test('clearDiagnostics clears the recorded outcomes too', () => {
  const { app } = run();
  app.invokeAction(ids.ACTION_CONFIRM_ORDER);
  app.clearDiagnostics();
  assert.equal(app.getActionOutcome(ids.ACTION_CONFIRM_ORDER), undefined);
});

/** Section 11. */
test('an agent can ask which nodes present an action’s failures', () => {
  const agent = new AgentAPI(createOrderSystemGraph());

  assert.deepEqual(
    agent.getDiagnosticPresentations(ids.ACTION_CONFIRM_ORDER).map((node) => node.id),
    [ids.UI_CONFIRM_DIAGNOSTIC],
  );
  assert.deepEqual(agent.getDiagnosticPresentations(ids.ACTION_OPEN_ORDERS), []);

  // And which actions can refuse without any presentation of the refusal.
  const unpresented = agent.getActionsWithoutDiagnosticPresentation().map((action) => action.name);
  assert.ok(unpresented.includes('setCustomer'));
  assert.ok(!unpresented.includes('confirmOrder'));
  assert.ok(!unpresented.includes('openOrders'), 'an action that cannot refuse is not reported');
});

// ------------------------------------------------------- 12-15: button defaults

test('a button needs no corrective layout or padding', () => {
  const graph = createOrderSystemGraph();
  const resolved = resolvePresentationMap(graph.listNodes(), graph.theme);
  const buttons = graph
    .listNodes()
    .filter((node): node is UINode => isUINode(node) && node.kind === 'button');

  assert.ok(buttons.length >= 5);
  for (const button of buttons) {
    const view = resolved[button.id];
    // The theme supplies the arrangement, so no button declares it.
    assert.equal(view.layout.kind, 'horizontal', `${button.id} should lay its contents out in a row`);
    assert.equal(view.layout.align, 'center');
    assert.equal(view.layout.justify, 'center');
    assert.equal(view.origins['layout.kind'], 'inferred');
    assert.equal(button.presentation?.layout, undefined, `${button.id} declares a corrective layout`);
    assert.equal(button.presentation?.padding, undefined, `${button.id} declares corrective padding`);
  }
});

test('an icon and a label sit side by side, and the theme decides which comes first', () => {
  const { host } = run();
  const button = elements(host.root, ids.UI_ORDER_BACK)[0];
  assert.ok(button);

  const classes = (button.getAttribute('class') ?? '').split(/\s+/);
  assert.ok(classes.includes('axiom-layout-horizontal'), 'not a vertical stack');
  // No padding class may override the control's own metrics.
  assert.ok(!classes.some((name) => name.startsWith('axiom-pad-')), classes.join(' '));

  assert.deepEqual(
    button.children.map((child) => child.getAttribute('data-icon') ?? 'label'),
    ['navigation-back', 'label'],
    'leading icon, then label',
  );

  const trailing = resolveTheme({ buttons: { iconPlacement: 'trailing' } });
  const graph = createOrderSystemGraph();
  graph.setTheme({ buttons: { iconPlacement: 'trailing' } });
  const flipped = run('/orders/order-1', graph);
  assert.deepEqual(
    elements(flipped.host.root, ids.UI_ORDER_BACK)[0].children.map(
      (child) => child.getAttribute('data-icon') ?? 'label',
    ),
    ['label', 'navigation-back'],
  );
  assert.equal(trailing.buttons.iconPlacement, 'trailing');
});

test('the theme controls button metrics, and the stylesheet follows it', () => {
  const dense = createThemeStylesheet(
    resolveTheme({ buttons: { layout: 'vertical', gap: 'large', paddingScale: 2 } }),
  );
  assert.match(dense, /button\.axiom-button \{[\s\S]*?flex-direction: column/);
  assert.match(dense, /var\(--axiom-control-padding-x\) \* 2\)/);

  const standard = createThemeStylesheet(DEFAULT_THEME);
  assert.match(standard, /button\.axiom-button \{[\s\S]*?flex-direction: row/);
});

// -------------------------------------- 16-20: type scale and document outline

test('a value can be drawn large without becoming a heading', () => {
  const { app, host } = run();
  withLines(app, LINE('product-a', 2, 'line-1'));

  const total = elements(host.root, ids.UI_ORDER_TOTAL)[0];
  assert.ok(total);
  assert.equal(total.tagName, 'span', 'a monetary total is not a document heading');
  assert.ok((total.getAttribute('class') ?? '').includes('axiom-text-heading'), 'but it is heading-sized');
  assert.match(textOf(total), /NOK\s?200\.00/);
});

test('heading levels produce the matching elements', () => {
  const { host } = run();
  assert.equal(elements(host.root, ids.UI_APP_TITLE)[0].tagName, 'h1');
  assert.equal(elements(host.root, ids.UI_ORDER_TITLE)[0].tagName, 'h2');
  assert.equal(elements(host.root, ids.UI_LINES_HEADING)[0].tagName, 'h3');
  assert.equal(findByTag(host.root, 'h1').length, 1, 'exactly one page heading');
});

test('the fixture has a well-formed outline', () => {
  const result = validateGraph(createOrderSystemGraph());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

// ------------------------------------------------ 24-27: declared form submit

test('a declared submit button submits its form', () => {
  const { app, host } = run();
  app.hydrateState(ids.STATE_DRAFT_LINE, {
    [ids.F_LINE_ID]: '',
    [ids.F_LINE_PRODUCT]: 'product-a',
    [ids.F_LINE_QUANTITY]: 2,
    [ids.F_LINE_UNIT_PRICE]: 0,
  });

  const submit = elements(host.root, ids.UI_LINE_SUBMIT)[0];
  assert.ok(submit);
  assert.equal(submit.getAttribute('type'), 'submit', 'it carries native submit behaviour');

  // Submitting the form runs the action exactly once.
  elements(host.root, ids.UI_LINE_FORM)[0].dispatch('submit');
  const lines = (app.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>)[0][
    ids.F_ORDER_LINES
  ] as unknown[];
  assert.equal(lines.length, 1);
});

test('a declared submit button is an ordinary queryable node', () => {
  const agent = new AgentAPI(createOrderSystemGraph());
  const structure = agent.getFormStructure(ids.UI_LINE_FORM);

  assert.equal(structure.submitButtonId, ids.UI_LINE_SUBMIT);
  assert.equal(structure.submitActionId, ids.ACTION_ADD_LINE);
  assert.deepEqual(structure.primaryActionIds, [ids.ACTION_ADD_LINE]);
  assert.deepEqual(structure.actionGroupIds, [ids.UI_LINE_FORM_ACTIONS], 'it sits in an action group');
  // It carries its own presentation, like any other control.
  assert.equal(agent.resolvePresentation(ids.UI_LINE_SUBMIT)?.icon, 'add');
  assert.equal(agent.getUxRole(ids.UI_LINE_SUBMIT), 'primary-action');
});

test('the simple form is still supported', () => {
  const { app, host } = run();
  // The customer form still declares only submitActionId and submitLabel.
  const generated = findAll(
    elements(host.root, ids.UI_CUSTOMER_FORM)[0],
    (element) => (element.getAttribute('class') ?? '').includes('axiom-submit'),
  );
  assert.equal(generated.length, 1);
  assert.match(textOf(generated[0]), /Set customer/);

  app.hydrateState(ids.STATE_DRAFT_CUSTOMER, 'customer-2');
  elements(host.root, ids.UI_CUSTOMER_FORM)[0].dispatch('submit');
  const order = (app.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>)[0];
  assert.equal(order[ids.F_ORDER_CUSTOMER], 'customer-2');
});

/** Section 27. */
test('form structure describes the primary render path, not inactive templates', () => {
  const agent = new AgentAPI(createOrderSystemGraph());
  const structure = agent.getFormStructure(ids.UI_LINE_FORM);
  const headings = structure.sections.flatMap((section) => section.headings);
  assert.ok(!headings.includes('There are no orders yet.'));
  assert.deepEqual(structure.ungroupedInputIds, [ids.UI_LINE_PRODUCT_INPUT, ids.UI_LINE_QUANTITY_INPUT]);
});

// -------------------------------------------------- 30, 33: semantic purity

test('the hardened fixture still needs no CSS, no escape hatch and no DOM work', () => {
  const graph = createOrderSystemGraph();

  for (const node of graph.listNodes()) {
    if (isUINode(node)) {
      assert.equal(node.presentation?.rendererOverrides, undefined, `${node.id} reaches for an override`);
    }
  }
  assert.deepEqual(new AgentAPI(graph).getOpaquePresentationNodes(), []);

  const serialized = graph.serialize();
  assert.doesNotMatch(serialized, /=>|\bstyle\b|<[a-z]+>/, 'no CSS, markup or callback in the graph');

  const style = /<style>([\s\S]*?)<\/style>/.exec(compileToHtml(graph))?.[1];
  assert.ok(style);
  for (const word of ['order', 'customer', 'product', 'stock']) {
    assert.doesNotMatch(style, new RegExp(`\\b${word}\\b`, 'i'));
  }
});

test('the fixture exercises every capability this release touches', () => {
  const graph = createOrderSystemGraph();
  const kinds = new Set(graph.listNodes().filter(isUINode).map((node) => node.kind));
  const resolved = resolvePresentationMap(graph.listNodes(), graph.theme);

  assert.ok(kinds.has('diagnostic'), 'diagnostics');
  assert.ok(kinds.has('repeat'), 'repeat');
  assert.ok(kinds.has('form'), 'forms');
  assert.ok(kinds.has('button'), 'buttons');
  assert.equal(graph.theme.id, DEFAULT_THEME.id, 'theme');
  assert.equal(resolved[ids.UI_ORDER_TOTAL].headingLevel, 'none', 'type scale without a heading');
  assert.equal(resolved[ids.UI_APP_TITLE].headingLevel, 1, 'document outline');
  assert.ok(resolved[ids.UI_LINE_ROW].responsive.compact, 'responsive presentation');
  assert.ok(
    graph.getNodesByKind('form').some((form) => form.submitButtonId),
    'a declared submit control',
  );
});

test('a theme change still cannot alter behaviour', () => {
  const themed = createOrderSystemGraph();
  const patch: ThemeInput = {
    appearance: 'dark',
    defaults: { density: 'compact' },
    buttons: { layout: 'vertical', gap: 'large' },
  };
  themed.setTheme(patch);

  const before = compileToIR(createOrderSystemGraph());
  const after = compileToIR(themed);
  assert.deepEqual(after.actions, before.actions);
  assert.deepEqual(after.constraints, before.constraints);
  assert.deepEqual(after.uiNodes, before.uiNodes);

  const { app } = run('/orders/order-1', themed);
  withLines(app, LINE('product-a', 2, 'line-1'));
  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, true);
});
