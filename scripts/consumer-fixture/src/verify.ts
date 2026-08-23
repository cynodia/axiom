/**
 * What a materialized application must still do — checked with nothing but the facade.
 *
 * It lives in its own module because `materialized.ts` runs it **after `@cynodia/axiom-ui`
 * has been uninstalled**: a module that imported the toolkit could not even be loaded, which
 * is the whole point of the gate.
 */
import assert from 'node:assert/strict';
import {
  ApplicationGraph,
  compileToHtml,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  findByNodeId,
  textOf,
  validateGraph,
} from '@cynodia/axiom';
import { S_LARGE_COUNT, S_ORDERS, S_STATUS_TOTALS } from './patterns.js';

export interface ExpectedBehaviour {
  title: string;
  statusTotals: number[];
  largeOrders: number;
  orderCount: number;
}

export function reproduceWithoutToolkit(serialized: string, expected: ExpectedBehaviour): void {
  const graph = ApplicationGraph.deserialize(serialized);
  const validation = validateGraph(graph);
  assert.deepEqual(validation.errors, [], 'the materialized graph validates');
  assert.deepEqual(validation.warnings, []);

  const ir = compileToIR(graph);
  const host = createMemoryHost({ path: '/orders/o-3' });
  const app = createAxiomRuntime({ ir, rootElement: host.root, host });
  app.start();

  assert.equal(textOf(findByNodeId(host.root, 'ui_order_detail_title')[0]), expected.title);
  assert.deepEqual(app.getState(S_STATUS_TOTALS), expected.statusTotals);
  assert.equal(app.getState(S_LARGE_COUNT), expected.largeOrders);
  assert.equal((app.getState(S_ORDERS) as unknown[]).length, expected.orderCount);
  assert.equal(occurrences(compileToHtml(graph), 'axiomAuthoring'), 0);
}

export function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}
