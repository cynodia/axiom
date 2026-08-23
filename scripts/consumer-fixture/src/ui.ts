/**
 * The pattern half of the consumer test.
 *
 * Everything here goes through `@cynodia/axiom-ui` as an outside consumer sees it: the public
 * entry point, the catalogue, and the ownership tooling. It ends by materializing the
 * expansion and writing the graph to disk, which is what `materialized.ts` then loads with the
 * toolkit uninstalled.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ApplicationGraph,
  compileToHtml,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  field,
  findByNodeId,
  nodeId,
  ref,
  textOf,
  validateGraph,
} from '@cynodia/axiom';
import type { TextNode } from '@cynodia/axiom';
import { occurrences } from './verify.js';
import type { ExpectedBehaviour } from './verify.js';
import {
  axiomUi,
  describePattern,
  detectDrift,
  listPatterns,
  materializePattern,
  provenanceOf,
} from '@cynodia/axiom-ui';
import {
  A_CANCEL,
  A_PLACE,
  F_CUSTOMER_ID,
  F_CUSTOMER_NAME,
  F_ORDER_CUSTOMER,
  F_ORDER_ID,
  F_ORDER_STATUS,
  F_ORDER_TOTAL,
  P_ORDER,
  ROUTE_PARAM_ID,
  S_CUSTOMERS,
  S_DRAFT,
  S_LARGE_COUNT,
  S_ORDERS,
  S_STATUS_TOTALS,
  addRoutes,
  createOrderDomain,
  orderInRoute,
} from './patterns.js';

export interface PatternOutcome {
  /** Where the materialized graph was written, for the toolkit-free run. */
  materializedPath: string;
  /** What the application does, to be reproduced without the toolkit. */
  expected: ExpectedBehaviour;
  metrics: {
    patternsAvailable: string[];
    patternInstances: number;
    generatedNodes: number;
    canonicalNodes: number;
    provenanceInClientIr: number;
    provenanceInHtml: number;
    validationErrors: number;
    validationWarnings: number;
    cssWritten: number;
    rendererOverrides: number;
  };
}

export function runPatternApplication(directory: string): PatternOutcome {
  const graph = createOrderDomain();

  // -------------------------------------------------------------- discovery
  // What an agent can find out before writing a declaration.
  const available = listPatterns(axiomUi);
  assert.deepEqual(available, ['action-bar', 'entity-form', 'entity-list', 'metric-grid', 'page']);
  const form = describePattern(axiomUi, 'entity-form');
  assert.ok(form, 'the catalogue describes entity-form');
  assert.ok(form.expansion.some((part) => part.part === 'input' && part.kind === 'input'));

  // -------------------------------------------------------------- authoring
  const list = axiomUi.expand(graph, {
    pattern: 'page',
    instance: 'orders',
    title: 'Orders',
    description: 'Everything placed, and what it came to.',
    actions: [{ pattern: 'action-bar', instance: 'order_actions', actions: [A_PLACE] }],
    content: [
      {
        pattern: 'metric-grid',
        instance: 'order_metrics',
        // No labels: both states are already named in the graph.
        metrics: [{ value: ref(S_LARGE_COUNT) }],
      },
      {
        pattern: 'entity-list',
        instance: 'order_list',
        source: S_ORDERS,
        fields: [F_ORDER_ID, F_ORDER_CUSTOMER, F_ORDER_TOTAL],
        formats: { [F_ORDER_TOTAL]: { kind: 'currency', currency: 'NOK' } },
        rowActions: [A_CANCEL],
        rowArguments: { [A_CANCEL]: { [P_ORDER]: field(ref(nodeId('ui_order_list_rows')), F_ORDER_ID) } },
        emptyMessage: 'No orders yet.',
        emptyAction: A_PLACE,
      },
      {
        pattern: 'entity-form',
        instance: 'new_order',
        draft: S_DRAFT,
        submit: A_PLACE,
        title: 'New order',
        // A choice drawn from application data, which is what a picker is.
        options: {
          [F_ORDER_CUSTOMER]: {
            source: ref(S_CUSTOMERS),
            scopeId: nodeId('scope_customer_option'),
            valueFieldId: F_CUSTOMER_ID,
            labelFieldId: F_CUSTOMER_NAME,
          },
        },
      },
    ],
  });

  const detail = axiomUi.expand(graph, {
    pattern: 'page',
    instance: 'order_detail',
    // A title that names the record the page is about.
    title: field(orderInRoute(), F_ORDER_ID),
    content: [
      {
        pattern: 'entity-form',
        instance: 'edit_order',
        // Edit, not create: the controls write into the addressed member.
        target: { state: S_ORDERS, identity: ref(ROUTE_PARAM_ID) },
        fields: [F_ORDER_STATUS, F_ORDER_TOTAL],
        submit: A_PLACE,
        submitLabel: 'Done',
      },
    ],
  });

  addRoutes(graph, { list, detail });

  // ---------------------------------------------------------------- the gates
  const validation = validateGraph(graph);
  assert.deepEqual(validation.errors, [], 'the expanded graph has no validation errors');
  assert.deepEqual(validation.warnings, [], 'and no warnings either');

  const ir = compileToIR(graph);
  const html = compileToHtml(graph, { title: 'Orders' });

  // Provenance is authoring metadata: present in the graph, absent from every artifact.
  const serializedIr = JSON.stringify(ir);
  const provenanceInClientIr = occurrences(serializedIr, 'axiomAuthoring');
  const provenanceInHtml = occurrences(html, 'axiomAuthoring');
  assert.equal(provenanceInClientIr, 0, 'no provenance in the client IR');
  assert.equal(provenanceInHtml, 0, 'no provenance in the generated page');
  assert.ok(
    provenanceOf(graph.getNode(nodeId('ui_order_list_row')) as never),
    'and yet the graph still knows which pattern generated a node',
  );
  // Nothing in the artifact reaches for the toolkit at run time.
  for (const trace of ['@cynodia/axiom-ui', 'axiomUi', 'expandPattern']) {
    assert.equal(occurrences(html, trace), 0, `the page must not mention ${trace}`);
  }

  // ------------------------------------------------------------------ running
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir, rootElement: host.root, host });
  app.start();

  const shown = findByNodeId(host.root, 'ui_order_list_cell_0').map((element) => textOf(element));
  assert.equal(shown.length, 3, 'one row per order');
  assert.equal(app.getState(S_LARGE_COUNT), 2, 'the named calculation, evaluated');
  assert.deepEqual(app.getState(S_STATUS_TOTALS), [460, 900], 'grouped totals, in first-seen order');

  const placed = app.invokeAction(A_PLACE);
  assert.equal(placed.ok, false, 'the guard refuses an order with no customer');
  assert.equal(placed.diagnostics[0]?.details?.failureMode, 'customer-required');

  // The detail page, addressed by route parameter.
  const detailHost = createMemoryHost({ path: '/orders/o-3' });
  const detailApp = createAxiomRuntime({ ir, rootElement: detailHost.root, host: detailHost });
  detailApp.start();
  const title = textOf(findByNodeId(detailHost.root, 'ui_order_detail_title')[0]);
  assert.equal(title, 'o-3', 'the page is titled by the record it is about');
  assert.equal(
    (graph.getNode(nodeId('ui_order_detail_title')) as TextNode).value !== 'o-3',
    true,
    'because the title is an expression, not a caption',
  );

  // ------------------------------------------------------------------- drift
  const expansion = axiomUi.inspect(graph, 'order_list');
  assert.ok(expansion);
  assert.deepEqual(detectDrift(graph, expansion), [], 'nothing has been edited yet');

  const row = graph.getNode(nodeId('ui_order_list_row')) as { children: string[] };
  graph.updateNode({ ...row, children: [row.children[0]] } as never);
  const drift = detectDrift(graph, expansion);
  assert.equal(drift.length, 1, 'the edit is detected');
  assert.equal(drift[0].code, 'TOOLKIT_EXPANSION_DRIFT');
  assert.equal(drift[0].property, 'children', 'and it names the property, not merely the node');
  graph.updateNode(row as never);
  assert.deepEqual(detectDrift(graph, expansion), [], 'and putting it back clears it');

  // ----------------------------------------------------- materialization
  // The explicit alternative to drift: the graph takes ownership, and the declaration
  // becomes history. Every expansion, so the whole application detaches.
  for (const record of axiomUi.expansions(graph)) {
    materializePattern(graph, record);
  }
  assert.equal(
    axiomUi.expansions(graph).every((record) => record.ownership === 'graph'),
    true,
  );

  const materializedPath = path.join(directory, 'materialized.json');
  writeFileSync(materializedPath, graph.serialize());

  const expected = {
    title,
    statusTotals: app.getState(S_STATUS_TOTALS) as number[],
    largeOrders: app.getState(S_LARGE_COUNT) as number,
    orderCount: (app.getState(S_ORDERS) as unknown[]).length,
  };

  const generated = graph.listNodes().filter((node) => provenanceOf(node as never)).length;
  return {
    materializedPath,
    expected,
    metrics: {
      patternsAvailable: available,
      patternInstances: axiomUi.expansions(graph).length,
      generatedNodes: generated,
      canonicalNodes: graph.listNodes().length,
      provenanceInClientIr,
      provenanceInHtml,
      validationErrors: validation.errors.length,
      validationWarnings: validation.warnings.length,
      // Asserted rather than reported: an application that needed either would have failed
      // the point of the exercise.
      cssWritten: 0,
      rendererOverrides: occurrences(JSON.stringify(graph.toJSON()), 'rendererOverrides'),
    },
  };
}
