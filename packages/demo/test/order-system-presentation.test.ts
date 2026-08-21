import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_THEME,
  isUINode,
  resolvePresentationMap,
  validateGraph,
} from '@cynodia/axiom-core';
import type { ApplicationGraph, DeviceClass, UINode } from '@cynodia/axiom-core';
import { compileToHtml, compileToIR } from '@cynodia/axiom-compiler';
import { AgentAPI } from '@cynodia/axiom-agent-api';
import {
  createAxiomRuntime,
  createMemoryHost,
  findAll,
  findByNodeId,
  findByTag,
  textOf,
} from '@cynodia/axiom-runtime';
import type { MemoryElement } from '@cynodia/axiom-runtime';
import { createOrderSystemGraph, orderSystemIds as ids } from '@cynodia/axiom-demo/order-system';

/**
 * The Order System as the 0.5 presentation acceptance fixture, sections 56–61.
 *
 * Its business semantics are the 0.4 ones and are covered by `order-system.test.ts`. What
 * is asserted here is that a polished, responsive, accessible interface was produced
 * entirely by presentation and UX intent: no application CSS, no DOM manipulation, no
 * callbacks and no renderer-specific escape hatch anywhere in the graph.
 */

function run(path = '/orders/order-1', graph: ApplicationGraph = createOrderSystemGraph()) {
  const host = createMemoryHost({ path });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  return { app, host, graph };
}

function element(root: MemoryElement, id: string, skipLabel = true): MemoryElement {
  const found = findByNodeId(root, id).find((node) => !skipLabel || node.tagName !== 'label');
  assert.ok(found, `nothing rendered for ${id}`);
  return found;
}

function classesOf(root: MemoryElement, id: string): string[] {
  return (element(root, id).getAttribute('class') ?? '').split(/\s+/);
}

function uiNodes(graph: ApplicationGraph): UINode[] {
  return graph.listNodes().filter((node): node is UINode => isUINode(node));
}

// ------------------------------------------------------------------ the fixture

test('the fixture is a valid graph with no findings of any kind', () => {
  const result = validateGraph(createOrderSystemGraph());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

/** Section 85: the fixture needs no CSS, no callbacks and no escape hatch. */
test('the fixture uses no escape hatch and no application CSS', () => {
  const graph = createOrderSystemGraph();

  for (const node of uiNodes(graph)) {
    assert.equal(
      node.presentation?.rendererOverrides,
      undefined,
      `${node.id} reaches for a renderer-specific override`,
    );
  }
  assert.deepEqual(new AgentAPI(graph).getOpaquePresentationNodes(), []);

  // The whole graph is data: a JSON round trip loses nothing.
  const serialized = graph.serialize();
  // The whole graph survives a JSON round trip, which no stored closure could.
  assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(graph.toJSON())));
  assert.doesNotMatch(serialized, /=>|\bformatter\b|\bvalidator\b/, 'no callback reached the graph');

  // Not one selector, property or value in the emitted stylesheet comes from the
  // application: no identifier it declares appears anywhere in it.
  const style = /<style>([\s\S]*?)<\/style>/.exec(compileToHtml(graph))?.[1];
  assert.ok(style);
  const identifiers = new Set<string>();
  for (const node of graph.listNodes()) {
    identifiers.add(String(node.id));
    if (node.name) {
      identifiers.add(node.name);
    }
  }
  for (const entry of graph.listFields()) {
    identifiers.add(String(entry.field.id));
  }
  assert.ok(identifiers.size > 50, 'the fixture has plenty of identifiers to leak');
  for (const identifier of identifiers) {
    assert.ok(!style.includes(identifier), `the stylesheet names "${identifier}"`);
  }
  // And none of the fixture's domain vocabulary either.
  for (const word of ['order', 'customer', 'product', 'stock']) {
    assert.doesNotMatch(style, new RegExp(`\\b${word}\\b`, 'i'), `the stylesheet names "${word}"`);
  }
});

/** Section 56. */
test('the fixture has an application header and navigation', () => {
  const { host } = run('/');

  const header = element(host.root, ids.UI_APP_HEADER);
  assert.equal(header.tagName, 'header');
  assert.match(textOf(header), /Order System/);

  const nav = element(host.root, ids.UI_APP_NAV);
  assert.equal(nav.tagName, 'nav');
  assert.match(textOf(nav), /Orders/);

  assert.equal(element(host.root, ids.UI_APP_TITLE).tagName, 'h1');
  assert.equal(element(host.root, ids.UI_ORDERS_TITLE).tagName, 'h2');
});

test('the fixture organizes the order detail into sections on semantic surfaces', () => {
  const { host } = run();

  assert.equal(element(host.root, ids.UI_LINES_SECTION).tagName, 'section');
  assert.ok(classesOf(host.root, ids.UI_LINES_SECTION).includes('axiom-ux-form-section'));
  assert.ok(classesOf(host.root, ids.UI_LINES_SECTION).includes('axiom-surface-raised'));

  // Content hierarchy: a title above a section heading, both real headings.
  assert.equal(element(host.root, ids.UI_ORDER_TITLE).tagName, 'h2');
  assert.equal(element(host.root, ids.UI_LINES_HEADING).tagName, 'h3');

  // Each line is a card rather than a row of loose text.
  const rows = findByNodeId(host.root, ids.UI_LINE_ROW);
  assert.equal(rows.length, 0, 'no lines yet');
  assert.ok(classesOf(host.root, ids.UI_ORDER_FORMS).includes('axiom-layout-grid'));
});

test('the fixture presents primary, secondary and destructive actions distinctly', () => {
  const { app, host } = run();
  const agent = new AgentAPI(createOrderSystemGraph());

  assert.deepEqual(
    agent.getPrimaryActions(ids.UI_ORDER_VIEW).map((action) => action.name)?.sort(),
    ['addLine', 'confirmOrder', 'setCustomer'],
  );
  assert.deepEqual(
    agent.getDestructiveActions(ids.UI_ORDER_VIEW).map((action) => action.name),
    ['removeLine'],
  );

  assert.ok(classesOf(host.root, ids.UI_CONFIRM_BUTTON).includes('axiom-role-primary'));
  assert.ok(classesOf(host.root, ids.UI_CONFIRM_BUTTON).includes('axiom-ux-primary-action'));

  // The remove button declares no role: it is destructive because its action is.
  const graph = createOrderSystemGraph();
  const remove = graph.getNode(ids.UI_LINE_REMOVE);
  assert.ok(remove && isUINode(remove));
  assert.equal(remove.presentation?.role, undefined);

  app.hydrateState(ids.STATE_DRAFT_LINE, {
    [ids.F_LINE_ID]: '',
    [ids.F_LINE_PRODUCT]: 'product-a',
    [ids.F_LINE_QUANTITY]: 2,
    [ids.F_LINE_UNIT_PRICE]: 0,
  });
  assert.equal(app.invokeAction(ids.ACTION_ADD_LINE).ok, true);
  assert.ok(classesOf(host.root, ids.UI_LINE_REMOVE).includes('axiom-role-destructive'));
  assert.ok(classesOf(host.root, ids.UI_LINE_REMOVE).includes('axiom-ux-destructive-action'));
});

/** Section 60. */
test('prices are formatted and the stored values are not', () => {
  const { app, host } = run();
  app.hydrateState(ids.STATE_DRAFT_LINE, {
    [ids.F_LINE_ID]: '',
    [ids.F_LINE_PRODUCT]: 'product-a',
    [ids.F_LINE_QUANTITY]: 2,
    [ids.F_LINE_UNIT_PRICE]: 0,
  });
  app.invokeAction(ids.ACTION_ADD_LINE);

  assert.match(textOf(element(host.root, ids.UI_LINE_PRICE)), /NOK\s?100\.00/);
  assert.match(textOf(element(host.root, ids.UI_ORDER_TOTAL)), /NOK\s?200\.00/);

  const lines = (app.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>)[0][
    ids.F_ORDER_LINES
  ] as Array<Record<string, unknown>>;
  assert.equal(lines[0][ids.F_LINE_UNIT_PRICE], 100, 'the stored value is still a number');
  assert.equal(app.getState(ids.STATE_ORDER_TOTAL), 200);
});

test('a status reads as a badge rather than a bare word', () => {
  const { host } = run();
  const classes = classesOf(host.root, ids.UI_ORDER_STATUS);
  assert.ok(classes.includes('axiom-treatment-pill'));
  assert.match(textOf(element(host.root, ids.UI_ORDER_STATUS)), /draft/);
});

/** Section 28. */
test('an empty collection has an empty state that offers something to do', () => {
  const { app, host } = run('/');
  app.hydrateState(ids.STATE_ORDERS, []);

  const empty = element(host.root, ids.UI_ORDERS_EMPTY_BOX);
  assert.ok((empty.getAttribute('class') ?? '').includes('axiom-ux-empty-state'));
  assert.match(textOf(empty), /no orders yet/);
  assert.ok(findByTag(empty, 'button').length > 0, 'and a way out of it');
});

test('an order with no lines has an empty state of its own', () => {
  const { host } = run();
  const empty = element(host.root, ids.UI_LINES_EMPTY_BOX);
  assert.ok((empty.getAttribute('class') ?? '').includes('axiom-ux-empty-state'));
  assert.ok(findByTag(empty, 'button').length > 0);
});

/** Section 29. */
test('a missing order is presented as an error state that announces itself', () => {
  const { host } = run('/orders/does-not-exist');
  const box = element(host.root, ids.UI_ORDER_MISSING_BOX);
  assert.equal(box.getAttribute('role'), 'alert');
  assert.ok((box.getAttribute('class') ?? '').includes('axiom-role-destructive'));
  assert.match(textOf(box), /no longer exists/);
});

/** Section 77. */
test('confirmation is described semantically, not drawn', () => {
  const { app, host } = run();
  app.hydrateState(ids.STATE_DRAFT_LINE, {
    [ids.F_LINE_ID]: '',
    [ids.F_LINE_PRODUCT]: 'product-a',
    [ids.F_LINE_QUANTITY]: 1,
    [ids.F_LINE_UNIT_PRICE]: 0,
  });
  app.invokeAction(ids.ACTION_ADD_LINE);
  app.invokeAction(ids.ACTION_CONFIRM_ORDER);

  const request = host.confirmationRequests.at(-1);
  assert.ok(request);
  assert.equal(request.actionId, ids.ACTION_CONFIRM_ORDER);
  assert.equal(request.title, 'Confirm this order?');
  assert.equal(request.confirmLabel, 'Confirm order');
  assert.equal(request.severity, 'warning');
});

test('a declined confirmation changes nothing', () => {
  const host = createMemoryHost({ path: '/orders/order-1', confirm: false });
  const app = createAxiomRuntime({
    ir: compileToIR(createOrderSystemGraph()),
    rootElement: host.root,
    host,
  });
  app.start();
  app.hydrateState(ids.STATE_DRAFT_LINE, {
    [ids.F_LINE_ID]: '',
    [ids.F_LINE_PRODUCT]: 'product-a',
    [ids.F_LINE_QUANTITY]: 1,
    [ids.F_LINE_UNIT_PRICE]: 0,
  });
  app.invokeAction(ids.ACTION_ADD_LINE);

  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, false);
  const order = (app.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>)[0];
  assert.equal(order[ids.F_ORDER_STATUS], 'draft', 'nothing was confirmed');
});

// -------------------------------------------------------------------- responsive

/** Section 57. */
test('every horizontal arrangement is usable on a compact display', () => {
  const graph = createOrderSystemGraph();
  const resolved = resolvePresentationMap(graph.listNodes(), graph.theme);
  const children = new Map<string, number>();
  for (const node of uiNodes(graph)) {
    const ids_ = 'children' in node ? (node.children as string[]) : [];
    children.set(node.id, ids_.length);
  }

  for (const node of uiNodes(graph)) {
    const view = resolved[node.id];
    // A control arranges its own contents from the theme's metrics; the invariant is about
    // nodes that lay out children.
    if (view.layout.kind !== 'horizontal' || (children.get(node.id) ?? 0) === 0) {
      continue;
    }
    const collapses = view.responsive.compact?.layout?.kind === 'vertical';
    assert.ok(
      view.layout.wrap || collapses,
      `${node.id} lays out horizontally with neither wrapping nor compact behaviour`,
    );
  }
});

test('the rows that matter collapse to a column on a compact display', () => {
  const graph = createOrderSystemGraph();
  const resolved = resolvePresentationMap(graph.listNodes(), graph.theme);

  for (const id of [ids.UI_APP_HEADER, ids.UI_ORDER_HEADER, ids.UI_LINE_ROW, ids.UI_ORDER_ROW]) {
    assert.equal(
      resolved[id].responsive.compact?.layout?.kind,
      'vertical',
      `${id} does not collapse on a compact display`,
    );
  }
});

test('the line grid adapts rather than naming a column count', () => {
  const graph = createOrderSystemGraph();
  const resolved = resolvePresentationMap(graph.listNodes(), graph.theme);
  assert.deepEqual(resolved[ids.UI_ORDER_FORMS].layout.columns, {
    mode: 'adaptive',
    minimum: 'medium',
  });
});

test('the graph names no breakpoint anywhere', () => {
  const serialized = createOrderSystemGraph().serialize();
  assert.doesNotMatch(serialized, /@media/);
  assert.doesNotMatch(serialized, /\d+px/);
  assert.doesNotMatch(serialized, /min-width|max-width:/);
  // What it does name is device classes.
  for (const device of ['compact'] as DeviceClass[]) {
    assert.match(serialized, new RegExp(`"${device}"`));
  }
});

// ------------------------------------------------------------- accessibility

/** Sections 35 and 64. */
test('the generated document has landmarks, headings and labelled controls', () => {
  const { host } = run();

  assert.equal(findByTag(host.root, 'header').length >= 1, true);
  assert.equal(findByTag(host.root, 'nav').length >= 1, true);
  assert.equal(findByTag(host.root, 'main').length >= 1, true);
  assert.equal(findByTag(host.root, 'h1').length, 1, 'exactly one page title');

  for (const inputId of [ids.UI_CUSTOMER_INPUT, ids.UI_LINE_PRODUCT_INPUT, ids.UI_LINE_QUANTITY_INPUT]) {
    const wrapper = findByNodeId(host.root, inputId).find((node) => node.tagName === 'label');
    const control = element(host.root, inputId);
    assert.ok(wrapper, `${inputId} has no label wrapper`);
    assert.equal(wrapper.getAttribute('for'), control.getAttribute('id'), `${inputId} is not associated`);
  }

  // Every button is a real button, and every one of them has a name.
  for (const button of findByTag(host.root, 'button')) {
    assert.ok(
      (button.textContent ?? '').trim() || textOf(button).trim() || button.getAttribute('aria-label'),
      'a control with no accessible name reached the page',
    );
  }
});

test('a required field is marked as required', () => {
  const { host } = run();
  const quantity = element(host.root, ids.UI_LINE_QUANTITY_INPUT);
  assert.equal(quantity.getAttribute('aria-required'), 'true');
});

// -------------------------------------------------------- theme independence

/** Sections 74 and 83. */
test('a different theme restyles the fixture without touching its semantics', () => {
  const light = compileToIR(createOrderSystemGraph());
  const dense = createOrderSystemGraph();
  dense.setTheme({ appearance: 'dark', defaults: { density: 'compact' }, spacing: { medium: 8 } });
  const dark = compileToIR(dense);

  assert.deepEqual(dark.actions, light.actions);
  assert.deepEqual(dark.constraints, light.constraints);
  assert.deepEqual(dark.transitionConstraints, light.transitionConstraints);
  assert.deepEqual(dark.routes, light.routes);
  assert.deepEqual(dark.uiNodes, light.uiNodes);
  assert.notDeepEqual(dark.presentation, light.presentation);

  // And the application still behaves identically under it.
  const { app } = run('/orders/order-1', dense);
  app.hydrateState(ids.STATE_DRAFT_LINE, {
    [ids.F_LINE_ID]: '',
    [ids.F_LINE_PRODUCT]: 'product-a',
    [ids.F_LINE_QUANTITY]: 2,
    [ids.F_LINE_UNIT_PRICE]: 0,
  });
  assert.equal(app.invokeAction(ids.ACTION_ADD_LINE).ok, true);
  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, true);
});

/** Sections 41 and 79: the same graph with every declaration stripped still works. */
test('stripping every presentation declaration leaves a working application', () => {
  const graph = createOrderSystemGraph();
  for (const node of uiNodes(graph)) {
    if (node.presentation) {
      const { presentation, ...bare } = node;
      void presentation;
      graph.updateNode(bare as UINode);
    }
  }
  graph.setTheme(undefined);

  const result = validateGraph(graph);
  assert.deepEqual(result.errors, []);

  const { app, host } = run('/orders/order-1', graph);
  assert.equal(compileToIR(graph).theme.id, DEFAULT_THEME.id);
  assert.ok(findByTag(host.root, 'button').length > 0, 'the controls are still there');
  assert.ok(findAll(host.root, (node) => node.tagName === 'form').length >= 2);

  app.hydrateState(ids.STATE_DRAFT_LINE, {
    [ids.F_LINE_ID]: '',
    [ids.F_LINE_PRODUCT]: 'product-a',
    [ids.F_LINE_QUANTITY]: 2,
    [ids.F_LINE_UNIT_PRICE]: 0,
  });
  assert.equal(app.invokeAction(ids.ACTION_ADD_LINE).ok, true);
  assert.equal(app.invokeAction(ids.ACTION_CONFIRM_ORDER).ok, true);

  // Every node still resolves to something usable, all of it from defaults.
  const resolved = resolvePresentationMap(graph.listNodes(), graph.theme);
  for (const node of uiNodes(graph)) {
    assert.ok(resolved[node.id].layout.kind);
    assert.equal(resolved[node.id].density, 'comfortable');
  }
});

test('the two 0.4 applications gain the new defaults without being changed', async () => {
  const { createIssueTrackerGraph } = await import('@cynodia/axiom-demo/issue-tracker');
  const { createInventoryGraph } = await import('@cynodia/axiom-demo/inventory');

  for (const build of [createIssueTrackerGraph, createInventoryGraph]) {
    const graph = build();
    assert.equal(validateGraph(graph).valid, true);

    const ir = compileToIR(graph);
    assert.equal(ir.theme.id, DEFAULT_THEME.id, 'a graph that declares no theme gets the default one');
    for (const node of uiNodes(graph)) {
      assert.ok(ir.presentation[node.id], `${node.id} has no resolved presentation`);
    }
    // The 0.2 spelling of the destructive role is still understood.
    const legacy = uiNodes(graph).filter((node) => node.presentation?.role === 'danger');
    for (const node of legacy) {
      assert.equal(ir.presentation[node.id].role, 'destructive');
    }
    assert.ok(legacy.length > 0, 'the fixtures still exercise the legacy spelling');
  }
});
