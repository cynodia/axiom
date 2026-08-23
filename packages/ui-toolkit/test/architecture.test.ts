import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ApplicationGraph,
  DEFAULT_THEME,
  binary,
  field,
  literal,
  nodeId,
  ref,
  validateGraph,
} from '@cynodia/axiom-core';
import type { ConditionalNode, ContainerNode, NodeId, RouteDef, TextNode, ViewNode } from '@cynodia/axiom-core';
import { compileToIR, compileToHtml } from '@cynodia/axiom-compiler';
import { AgentAPI } from '@cynodia/axiom-agent-api';
import { createAxiomRuntime, createMemoryHost, findAll } from '@cynodia/axiom-runtime';
import {
  axiomUi,
  createToolkit,
  provenanceOf,
  definePattern,
  detectDrift,
  PatternExpansionError,
  describePattern,
  listPatterns,
  rowField,
  rowRef,
} from '@cynodia/axiom-ui';
import type { PatternFinding } from '@cynodia/axiom-ui';
import {
  ACTION_ADD_PRODUCT,
  ACTION_CONFIRM_ORDER,
  ACTION_DELETE_PRODUCT,
  ACTION_PLACE_ORDER,
  ENTITY_PRODUCT,
  F_ORDER_ID,
  F_ORDER_QUANTITY,
  F_ORDER_TOTAL,
  F_PRODUCT_NAME,
  F_PRODUCT_STOCK,
  PARAM_ORDER,
  STATE_CUSTOMERS,
  STATE_DRAFT_PRODUCT,
  STATE_LOW_STOCK,
  STATE_ORDERS,
  STATE_ORDER_COUNT,
  STATE_PRODUCTS,
  createOrderDomain,
  createToolkitApplication,
} from '@cynodia/axiom-ui/example';

/** Runs the expansion and returns the findings it was refused with. */
function refusal(run: () => unknown): PatternFinding[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PatternExpansionError, `expected a PatternExpansionError, got ${String(error)}`);
    return (error as PatternExpansionError).findings;
  }
  assert.fail('the declaration was accepted');
}

/** A graph with one route, so an expansion can be validated on its own. */
function screen(build: (graph: ApplicationGraph) => NodeId): ApplicationGraph {
  const graph = createOrderDomain();
  const root = build(graph);
  const view = nodeId('ui_view_test');
  graph.addNode<ViewNode>({ id: view, kind: 'view', name: 'Test', children: [root] });
  graph.addNode<RouteDef>({ id: nodeId('route_test'), kind: 'route', path: '/', viewId: view });
  return graph;
}

// ------------------------------------------------- §23: customization without ejecting

test('a requirement the pattern never anticipated is met by composition, not by ejecting', () => {
  // "Show low-stock products with additional emphasis." No pattern input says this, and none
  // should: it is application-specific UX. The row slot takes ordinary semantic UI.
  const graph = screen((target) => {
    const badge = nodeId('ui_low_badge');
    target.addNode<TextNode>({
      id: badge,
      kind: 'text',
      value: 'Low stock',
      presentation: { uxRole: 'warning-state', treatment: 'badge', textRole: 'label', headingLevel: 'none' },
    });
    const conditional = nodeId('ui_low_conditional');
    target.addNode<ConditionalNode>({
      id: conditional,
      kind: 'conditional',
      condition: binary('lt', rowField('products', F_PRODUCT_STOCK), literal(5)),
      whenTrue: [badge],
    });
    return axiomUi.expand(target, {
      pattern: 'entity-list',
      instance: 'products',
      source: STATE_PRODUCTS,
      fields: [F_PRODUCT_NAME, F_PRODUCT_STOCK],
      rowExtra: conditional,
    });
  });

  assert.deepEqual(validateGraph(graph).errors, []);
  // The customization is inside the generated row, and the row is still the pattern's.
  const row = graph.getNode('ui_products_row' as never) as ContainerNode;
  assert.ok(row.children.includes('ui_low_conditional' as never));
  // Nothing was copied: the whole structure is still one declaration plus two nodes.
  assert.equal(axiomUi.inspect(graph, 'products')?.nodeIds.length, 7);
});

// ---------------------------------------------------------------- §24: composition

test('patterns compose without a bespoke component per combination', () => {
  const graph = screen((target) =>
    axiomUi.expand(target, {
      pattern: 'page',
      instance: 'overview',
      title: 'Overview',
      actions: [
        { pattern: 'action-bar', instance: 'overview_actions', actions: [ACTION_PLACE_ORDER] },
      ],
      content: [
        {
          pattern: 'metric-grid',
          instance: 'overview_metrics',
          metrics: [{ label: 'Orders', value: ref(STATE_ORDER_COUNT) }],
        },
        { pattern: 'entity-list', instance: 'overview_list', source: STATE_ORDERS },
      ],
    }),
  );

  assert.deepEqual(validateGraph(graph).errors, []);
  // Page ▸ (ActionBar, MetricGrid, EntityList) — three patterns nested in a fourth, and each
  // records the instance that enclosed it.
  for (const instance of ['overview_actions', 'overview_metrics', 'overview_list']) {
    assert.equal(axiomUi.inspect(graph, instance)?.parent, 'overview', `${instance} lost its parent`);
  }
});

// ------------------------------------------------- §25–26: no pattern exists for this

test('a UI concept with no pattern is built from patterns plus canonical primitives', () => {
  // "An order-review area: customer summary, grouped line items, totals, confirmation."
  // There is no OrderReviewPattern and there should not be one. What the toolkit contributes
  // is the parts it does know; the rest is ordinary Axiom UI, and no DOM or CSS is involved.
  const graph = screen((target) => {
    const summary = nodeId('ui_review_summary');
    target.addNode<TextNode>({
      id: summary,
      kind: 'text',
      value: 'Review before confirming.',
      presentation: { textRole: 'body', headingLevel: 'none' },
    });
    const lines = axiomUi.expand(target, {
      pattern: 'entity-list',
      instance: 'review_lines',
      source: STATE_ORDERS,
      fields: [F_ORDER_QUANTITY, F_ORDER_TOTAL],
      rowActions: [ACTION_CONFIRM_ORDER],
      rowArguments: { [ACTION_CONFIRM_ORDER]: { [PARAM_ORDER]: rowField('review_lines', F_ORDER_ID) } },
      emptyAction: ACTION_PLACE_ORDER,
    });
    const totals = axiomUi.expand(target, {
      pattern: 'metric-grid',
      instance: 'review_totals',
      metrics: [{ label: 'Order total', value: ref(STATE_ORDER_COUNT) }],
    });
    const region = nodeId('ui_review_region');
    target.addNode<ContainerNode>({
      id: region,
      kind: 'container',
      name: 'Order review',
      children: [summary, lines, totals],
      presentation: { surface: 'raised', padding: 'large', layout: { kind: 'vertical', gap: 'medium' } },
    });
    return axiomUi.expand(target, {
      pattern: 'page',
      instance: 'review',
      title: 'Order review',
      content: [region],
    });
  });

  assert.deepEqual(validateGraph(graph).errors, []);
  assert.deepEqual(validateGraph(graph).warnings.map((warning) => warning.code), []);
  const html = compileToHtml(graph);
  assert.doesNotMatch(html.split('<style>')[1] ?? '', /order-review/, 'no application-specific CSS was needed');
});

// ------------------------------------------------------ §44–46: a third-party pattern

test('the published package depends on core and on nothing else', () => {
  // §4: the dependency direction is axiom-ui → axiom-core. The tests here use the compiler and
  // the runtime, and they are deliberately not dependencies: an authoring package that pulled
  // the runtime in would be shipping the thing it exists to stay out of.
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { private?: boolean; dependencies?: Record<string, string>; devDependencies?: unknown };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@cynodia/axiom-core']);
  assert.equal(manifest.devDependencies, undefined, 'a published manifest ships no devDependencies');
  assert.notEqual(manifest.private, true, 'the toolkit is public as of 0.7');
});

test('a pattern defined outside the core toolkit uses the same mechanism', () => {
  // The proof that Axiom core needs no change per pattern: this one lives here, in a test.
  const inventoryStatusPanel = definePattern<{
    pattern: 'inventory-status-panel';
    instance: string;
    threshold: number;
  }>({
    name: 'inventory-status-panel',
    purpose: 'A domain-specific panel reporting stock health.',
    inputs: { threshold: { kind: 'token', required: true, purpose: 'Below this, stock counts as low.' } },
    slots: [],
    produces: ['container', 'text'],
    expansion: [
      { part: 'root', kind: 'container', role: 'the panel' },
      { part: 'caption', kind: 'text', role: 'heading' },
      { part: 'value', kind: 'text', role: 'the count' },
    ],
    expand(declaration, context) {
      const caption = context.add<TextNode>(
        {
          id: context.id('caption'),
          kind: 'text',
          value: 'Stock health',
          presentation: { textRole: 'heading', headingLevel: 2 },
        },
        'caption',
      );
      const value = context.add<TextNode>(
        {
          id: context.id('value'),
          kind: 'text',
          value: ref(STATE_LOW_STOCK),
          presentation: { textRole: 'display', headingLevel: 'none', format: { kind: 'number' } },
        },
        'value',
      );
      context.explain(`low stock counted below ${declaration.threshold}`);
      return context.add<ContainerNode>(
        {
          id: context.id('root'),
          kind: 'container',
          children: [caption, value],
          presentation: { surface: 'raised', padding: 'medium', layout: { kind: 'vertical', gap: 'small' } },
        },
        'root',
      );
    },
  });

  const thirdParty = createToolkit([inventoryStatusPanel as never]);
  const graph = screen((target) =>
    thirdParty.expand(target, { pattern: 'inventory-status-panel', instance: 'stock_panel', threshold: 5 }),
  );

  assert.deepEqual(validateGraph(graph).errors, []);
  assert.equal(thirdParty.inspect(graph, 'stock_panel')?.explanations[0], 'low stock counted below 5');
  // Provenance names the pattern, so a mixed-toolkit graph stays attributable.
  const root = graph.getNode('ui_stock_panel_root' as never) as { metadata?: Record<string, unknown> };
  assert.equal(provenanceOf(root)?.pattern, 'inventory-status-panel');
});

// --------------------------------------------- §58–60: diagnostics before expansion

test('a bad declaration is refused before expansion, pointing at the declaration', () => {
  const graph = createOrderDomain();
  const findings = refusal(() =>
      axiomUi.expand(graph, {
        pattern: 'entity-list',
        instance: 'broken',
        source: STATE_LOW_STOCK, // a number, not a collection
      }),
  );
  assert.equal(findings[0].code, 'SOURCE_NOT_A_COLLECTION');
  assert.equal(findings[0].path, 'broken.source');
  // Nothing was created: a refused expansion leaves no half-built structure behind.
  assert.equal(graph.listNodes().filter((node) => String(node.id).startsWith('ui_broken')).length, 0);
});

test('an unknown field is reported against its position in the declaration', () => {
  const graph = createOrderDomain();
  const findings = refusal(() =>
      axiomUi.expand(graph, {
        pattern: 'entity-list',
        instance: 'products',
        source: STATE_PRODUCTS,
        fields: [F_PRODUCT_NAME, F_ORDER_TOTAL],
      }),
  );
  assert.equal(findings[0].path, 'products.fields[1]', 'the index of the offending field');
});

test('a form over server-owned or derived state is refused with the reason', () => {
  const graph = createOrderDomain();
  const findings = refusal(() =>
      axiomUi.expand(graph, {
        pattern: 'entity-form',
        instance: 'bad_form',
        draft: STATE_ORDER_COUNT,
        submit: ACTION_PLACE_ORDER,
      }),
  );
  assert.equal(findings[0].code, 'DRAFT_IS_DERIVED');
});

test('a control that cannot supply a required argument is refused at the declaration', () => {
  const graph = createOrderDomain();
  const findings = refusal(() =>
      axiomUi.expand(graph, {
        pattern: 'action-bar',
        instance: 'bar',
        actions: [ACTION_DELETE_PRODUCT], // needs param_product
      }),
  );
  assert.equal(findings[0].code, 'MISSING_ACTION_ARGUMENT');
  assert.equal(findings[0].path, 'bar.actions[0]');
});

test('toolkit validation does not replace canonical validation', () => {
  // §59. The check pass is an early, better-located diagnostic — not an authority.
  const graph = createToolkitApplication();
  assert.deepEqual(validateGraph(graph).errors, []);
  const findings: PatternFinding[] = axiomUi.expansions(graph).flatMap((expansion) => expansion.findings);
  assert.deepEqual(findings, [], 'the research application produces no toolkit findings either');
});

// -------------------------------------------------------------- §38: staleness

test('drift names the node and the property, not merely that something changed', () => {
  const graph = createToolkitApplication();
  const expansion = axiomUi.inspect(graph, 'product_list');
  assert.ok(expansion);
  assert.deepEqual(detectDrift(graph, expansion), [], 'a freshly expanded graph has not drifted');

  // Someone edits a generated node by hand.
  const row = graph.getNode('ui_product_list_row' as never) as ContainerNode;
  graph.updateNode({ ...row, children: row.children.slice(0, 1) } as never);
  const edited = detectDrift(graph, expansion);
  assert.equal(edited.length, 1);
  assert.equal(edited[0].code, 'TOOLKIT_EXPANSION_DRIFT');
  assert.equal(edited[0].nodeId, 'ui_product_list_row');
  assert.equal(edited[0].property, 'children');
  assert.equal((edited[0].expected as unknown[]).length, 4);
  assert.equal((edited[0].actual as unknown[]).length, 1);

  // And deletes another outright.
  graph.removeNode('ui_product_list_empty_caption' as never);
  const removed = detectDrift(graph, expansion).find((entry) => entry.property === 'removed');
  assert.equal(removed?.nodeId, 'ui_product_list_empty_caption');
});

// ------------------------------------------------------------- §27–29: themes

test('two deliberately different themes change presentation and nothing else', () => {
  const saas = createToolkitApplication();
  const enterprise = createToolkitApplication();
  // A deliberately different visual system: denser spacing, smaller type, tighter radii.
  enterprise.setTheme({
    id: 'dense-enterprise',
    name: 'Dense Enterprise',
    appearance: 'light',
    defaults: { density: 'compact', gap: 'xsmall' },
    spacing: { none: 0, xsmall: 2, small: 4, medium: 8, large: 12, xlarge: 18 },
    radius: { none: 0, small: 2, medium: 3, large: 4, pill: 999 },
  });

  const a = compileToIR(saas);
  const b = compileToIR(enterprise);

  // Behaviour, byte for byte.
  assert.deepEqual(b.actions, a.actions);
  assert.deepEqual(b.uiNodes, a.uiNodes);
  assert.deepEqual(b.locationTypes, a.locationTypes);
  assert.deepEqual(b.routes, a.routes);
  // Appearance, not.
  assert.notDeepEqual(b.theme, a.theme);
  assert.notEqual(b.presentation, a.presentation);
  assert.equal(a.theme.id, DEFAULT_THEME.id);
  assert.equal(b.theme.id, 'dense-enterprise');

  // And both render.
  for (const graph of [saas, enterprise]) {
    const host = createMemoryHost({ path: '/products' });
    const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
    app.start();
    assert.ok(host.root.children.length > 0);
  }
});

test('the pattern declarations are identical between the two themes', () => {
  // §28 requires that nothing but the theme selection differs. Both applications come from
  // the same builder, so this is true by construction — and asserting it keeps it true.
  const saas = createToolkitApplication();
  const enterprise = createToolkitApplication();
  enterprise.setTheme({ id: 'dense-enterprise', defaults: { density: 'compact' } });
  assert.deepEqual(
    axiomUi.expansions(enterprise).map((expansion) => expansion.declaration),
    axiomUi.expansions(saas).map((expansion) => expansion.declaration),
  );
});

void field;
void ENTITY_PRODUCT;
void STATE_CUSTOMERS;
void STATE_DRAFT_PRODUCT;
void rowRef;

// ------------------------------------------------- §89–90: create versus edit

test('a create form offers the identity field and an edit form does not', () => {
  const created = screen((target) =>
    axiomUi.expand(target, {
      pattern: 'entity-form',
      instance: 'create_product',
      draft: STATE_DRAFT_PRODUCT,
      submit: ACTION_ADD_PRODUCT,
    }),
  );
  const edited = screen((target) =>
    axiomUi.expand(target, {
      pattern: 'entity-form',
      instance: 'edit_product',
      draft: STATE_DRAFT_PRODUCT,
      submit: ACTION_ADD_PRODUCT,
      mode: 'edit',
    }),
  );

  const bindings = (graph: ApplicationGraph, instance: string) =>
    graph
      .listNodes()
      .filter((node) => node.kind === 'input' && String(node.id).startsWith(`ui_${instance}`))
      .map((node) => JSON.stringify((node as { binding: unknown }).binding));

  const createBindings = bindings(created, 'create_product');
  const editBindings = bindings(edited, 'edit_product');
  assert.equal(createBindings.length, 5, 'every field, identity included');
  assert.equal(editBindings.length, 4, 'identity omitted');
  assert.ok(createBindings.some((binding) => binding.includes('field_product_id')));
  assert.ok(!editBindings.some((binding) => binding.includes('field_product_id')));

  for (const graph of [created, edited]) {
    assert.deepEqual(validateGraph(graph).errors, []);
  }
});

test('the create default is the one whose mistake is visible', () => {
  // The regression guard for the Phase 1 bug: a create form must be able to supply every
  // value its submit action's guards require, or it renders and can never succeed.
  const graph = screen((target) =>
    axiomUi.expand(target, {
      pattern: 'entity-form',
      instance: 'default_mode',
      draft: STATE_DRAFT_PRODUCT,
      submit: ACTION_ADD_PRODUCT,
    }),
  );
  const required = new AgentAPI(graph).getFormStructure('ui_default_mode_root' as never).requiredInputIds;
  assert.equal(required.length, 4, 'every required field of Product has a control');
});

// ------------------------------------------- §87: everything at once, no copying

test('four unanticipated requirements are met without reproducing the expansion', () => {
  // Low-stock rows get a warning marker, the first cell pairs two fields, the row gains a
  // custom action, and compact devices stack the record. None of it is a pattern input, and
  // none of it requires knowing how entity-list builds a row.
  const graph = screen((target) => {
    const marker = nodeId('ui_low_marker');
    target.addNode<TextNode>({
      id: marker,
      kind: 'text',
      value: 'Low',
      presentation: { uxRole: 'warning-state', treatment: 'badge', textRole: 'label', headingLevel: 'none' },
    });
    const lowStock = nodeId('ui_low_conditional');
    target.addNode<ConditionalNode>({
      id: lowStock,
      kind: 'conditional',
      condition: binary('lt', rowField('stock', F_PRODUCT_STOCK), literal(5)),
      whenTrue: [marker],
    });

    // Two semantic fields presented as one column.
    const name = nodeId('ui_pair_name');
    const code = nodeId('ui_pair_code');
    target.addNode({ id: name, kind: 'field-display', source: rowRef('stock'), fieldId: F_PRODUCT_NAME } as never);
    target.addNode({
      id: code,
      kind: 'field-display',
      source: rowRef('stock'),
      fieldId: nodeId('field_product_id') as never,
      presentation: { textRole: 'caption', emphasis: 'subtle' },
    } as never);
    const pair = nodeId('ui_pair');
    target.addNode<ContainerNode>({
      id: pair,
      kind: 'container',
      children: [name, code],
      presentation: { layout: { kind: 'vertical', gap: 'none' } },
    });

    const custom = nodeId('ui_custom_action');
    target.addNode({
      id: custom,
      kind: 'button',
      label: 'Restock',
      actionId: nodeId('action_restock') as never,
      arguments: {
        [nodeId('param_product')]: rowField('stock', nodeId('field_product_id') as never),
        [nodeId('param_amount')]: literal(10),
      },
      presentation: { uxRole: 'secondary-action' },
    } as never);

    return axiomUi.expand(target, {
      pattern: 'entity-list',
      instance: 'stock',
      source: STATE_PRODUCTS,
      fields: [F_PRODUCT_STOCK],
      rowExtra: [pair, lowStock, custom],
      emptyAction: ACTION_ADD_PRODUCT,
    });
  });

  assert.deepEqual(validateGraph(graph).errors, []);
  assert.deepEqual(validateGraph(graph).warnings.map((warning) => warning.code), []);

  // Still one declaration. The row is the pattern's, and the additions sit inside it.
  const row = graph.getNode('ui_stock_row' as never) as ContainerNode;
  for (const added of ['ui_pair', 'ui_low_conditional', 'ui_custom_action']) {
    assert.ok(row.children.includes(added as never), `${added} is in the generated row`);
  }
  // The compact stacking came from the pattern; nobody asked for it.
  const presentation = (row as { presentation?: { responsive?: Record<string, unknown> } }).presentation;
  assert.ok(presentation?.responsive?.compact, 'responsive intent is still the pattern’s');
});

// -------------------------------------------- §88: the over-inference regression

test('no pattern input promises per-row behaviour it can only express statically', () => {
  // The Phase 1 bug: `emphasizeWhen` implied a per-row condition and applied static emphasis
  // to one shared template. Presentation on a row template is per-template by construction,
  // so any input suggesting otherwise is a lie the type system cannot catch.
  for (const name of listPatterns(axiomUi)) {
    const description = describePattern(axiomUi, name);
    for (const [input, definition] of Object.entries(description?.inputs ?? {})) {
      const perRowSounding = /^(emphasi[sz]e|highlight|mark|colou?r|style)/i.test(input);
      assert.equal(
        perRowSounding,
        false,
        `${name}.${input} sounds like per-row presentation; express it as a conditional node in a slot instead`,
      );
      void definition;
    }
  }
});

test('a per-row condition is expressible, and it is a node rather than a token', () => {
  // The correct mechanism, asserted so it cannot quietly disappear: a `conditional` inside the
  // row, whose condition is evaluated in the row scope.
  const graph = screen((target) => {
    const badge = nodeId('ui_badge');
    target.addNode<TextNode>({ id: badge, kind: 'text', value: 'Low', presentation: { headingLevel: 'none' } });
    const conditional = nodeId('ui_cond');
    target.addNode<ConditionalNode>({
      id: conditional,
      kind: 'conditional',
      condition: binary('lt', rowField('rows', F_PRODUCT_STOCK), literal(5)),
      whenTrue: [badge],
    });
    return axiomUi.expand(target, {
      pattern: 'entity-list',
      instance: 'rows',
      source: STATE_PRODUCTS,
      fields: [F_PRODUCT_NAME],
      rowExtra: conditional,
    });
  });

  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  // Three products, one of which is below the threshold: the badge renders once, not thrice.
  const badges = findAll(host.root, (element) => element.getAttribute('data-node') === 'ui_badge');
  assert.equal(badges.length, 1, 'the condition is genuinely evaluated per row');
});
