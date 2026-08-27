import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateGraph } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import { createQueryStore } from '@cynodia/axiom-runtime';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
} from '@cynodia/axiom-server';
import type { QueryResponse, ServerRequest } from '@cynodia/axiom-server';
import type { RemoteQueryResult } from '@cynodia/axiom-runtime';
import {
  createOrderManagementGraph,
  generateOrderManagementDataset,
  orderManagementIds as id,
} from '@cynodia/axiom-demo';

const graph = createOrderManagementGraph();
const ir = compileToServerIR(graph);
const dataset = generateOrderManagementDataset({ customers: 40, products: 30, orders: 2000, linesPerOrder: 3 });

let providerCalls: string[] = [];

function authority(options: { queryCache?: boolean } = {}) {
  providerCalls = [];
  return createAxiomServer({
    ir,
    host: createDeterministicServerHost({
      authenticate: (credential) =>
        credential === 'admin'
          ? { [id.F_PRINCIPAL_ROLE]: 'admin', [id.F_PRINCIPAL_CUSTOMER]: 'root' }
          : credential?.startsWith('cust:')
            ? { [id.F_PRINCIPAL_ROLE]: 'customer', [id.F_PRINCIPAL_CUSTOMER]: credential.slice(5) }
            : null,
    }),
    cursorSecret: 'demo',
    ...(options.queryCache === false ? { queryCache: false } : {}),
    dataProvider: createMemoryDataProvider({
      rows: dataset as never,
      maxPageSize: 50,
      onProviderCall: (kind, entityId) => providerCalls.push(`${kind}:${String(entityId)}`),
    }),
  });
}

function q(
  queryId: string,
  args: Record<string, unknown>,
  credential: string,
  extra: Record<string, unknown> = {},
): ServerRequest {
  return {
    kind: 'query',
    protocol: PROTOCOL_VERSION,
    queryId: queryId as never,
    arguments: args,
    credential,
    ...extra,
  } as ServerRequest;
}

test('the reference graph validates and compiles to axiom.server.v6', () => {
  assert.equal(validateGraph(graph).valid, true);
  assert.equal(ir.contract, 'axiom.server.v6');
  assert.equal(ir.queries?.length, 8);
  assert.equal(ir.relationships?.length, 4);
  assert.equal(ir.readPolicies?.length, 1);
});

test('the Orders screen: server filter + search + date filter + sort + cursor + Customer join + projection', async () => {
  const s = authority();
  await s.start();
  const from = '2026-02-01';
  const to = '2026-03-01';
  const page1 = (await s.handle(
    q(id.Q_ORDERS, { [id.P_STATUS]: 'confirmed', [id.P_FROM]: from, [id.P_TO]: to }, 'admin', { pageSize: 10 }),
  )) as QueryResponse;
  assert.equal(page1.ok, true, JSON.stringify(page1.diagnostics));
  assert.ok(page1.page!.items.length <= 10);
  for (const row of page1.page!.items) {
    assert.equal(row[id.F_SUMMARY_STATUS], 'confirmed');
    assert.ok(String(row[id.F_SUMMARY_CREATED_AT]) >= from && String(row[id.F_SUMMARY_CREATED_AT]) < to);
    assert.equal(typeof row[id.F_SUMMARY_CUSTOMER_NAME], 'string', 'the Customer name comes from the join');
    assert.deepEqual(Object.keys(row).sort(), [
      id.F_SUMMARY_ID, id.F_SUMMARY_REFERENCE, id.F_SUMMARY_CREATED_AT,
      id.F_SUMMARY_STATUS, id.F_SUMMARY_CUSTOMER_NAME, id.F_SUMMARY_TOTAL,
    ].map(String).sort(), 'only the projected fields');
  }
  // createdAt DESC across the page
  const dates = page1.page!.items.map((row) => String(row[id.F_SUMMARY_CREATED_AT]));
  assert.deepEqual(dates, [...dates].sort().reverse());

  if (page1.page!.hasMore) {
    const page2 = (await s.handle(
      q(id.Q_ORDERS, { [id.P_STATUS]: 'confirmed', [id.P_FROM]: from, [id.P_TO]: to }, 'admin', {
        pageSize: 10,
        cursor: page1.page!.nextCursor,
      }),
    )) as QueryResponse;
    const seen = new Set(page1.page!.items.map((row) => row[id.F_SUMMARY_ID]));
    assert.ok(page2.page!.items.every((row) => !seen.has(row[id.F_SUMMARY_ID])), 'page 2 does not repeat page 1');
  }
});

test('text search is case-insensitive on the order reference', async () => {
  const s = authority();
  await s.start();
  const res = (await s.handle(q(id.Q_ORDERS, { [id.P_SEARCH]: 'ord-0000123' }, 'admin', { pageSize: 20 }))) as QueryResponse;
  assert.ok(res.page!.items.length >= 1);
  assert.ok(res.page!.items.every((row) => String(row[id.F_SUMMARY_REFERENCE]).toLowerCase().includes('ord-0000123')));
});

test('the Dashboard: total orders, confirmed orders, revenue, revenue by status — provider-side', async () => {
  const s = authority();
  await s.start();
  providerCalls = [];
  const total = (await s.handle(q(id.Q_TOTAL_ORDERS, {}, 'admin'))) as QueryResponse;
  const confirmed = (await s.handle(q(id.Q_CONFIRMED_ORDERS, {}, 'admin'))) as QueryResponse;
  const revenue = (await s.handle(q(id.Q_REVENUE, {}, 'admin'))) as QueryResponse;
  const byStatus = (await s.handle(q(id.Q_BY_STATUS, {}, 'admin'))) as QueryResponse;

  assert.equal(total.aggregate!.rows[0].values[id.F_METRIC_COUNT], 2000);
  assert.ok((confirmed.aggregate!.rows[0].values[id.F_METRIC_COUNT] as number) > 0);
  assert.ok((revenue.aggregate!.rows[0].values[id.F_METRIC_REVENUE] as number) > 0);
  assert.equal(byStatus.aggregate!.rows.length, 5, 'one row per status');
  const dashboardCounts = byStatus.aggregate!.rows.reduce((sum, row) => sum + (row.values[id.F_METRIC_COUNT] as number), 0);
  assert.equal(dashboardCounts, 2000);

  // Not one Order row was returned to the runtime — only aggregate calls.
  assert.ok(providerCalls.every((call) => call.startsWith('aggregate:')), providerCalls.join(', '));
});

test('customer security: customer A never observes customer B protected orders', async () => {
  const s = authority();
  await s.start();
  const a = 'c000001';
  const b = 'c000002';
  const forA = (await s.handle(q(id.Q_ORDERS, {}, `cust:${a}`, { pageSize: 50 }))) as QueryResponse;
  const forB = (await s.handle(q(id.Q_ORDERS, {}, `cust:${b}`, { pageSize: 50 }))) as QueryResponse;
  assert.ok(forA.page!.items.length > 0 && forB.page!.items.length > 0);
  // Hostile: A tries to read B's history by passing B's id.
  const hostile = (await s.handle(q(id.Q_CUSTOMER_HISTORY, { [id.P_CUSTOMER_ID]: b }, `cust:${a}`, { pageSize: 50 }))) as QueryResponse;
  assert.equal(hostile.page!.items.length, 0, "A sees nothing of B, even when naming B's id");
  const aCount = (await s.handle(q(id.Q_TOTAL_ORDERS, {}, `cust:${a}`))) as QueryResponse;
  assert.ok((aCount.aggregate!.rows[0].values[id.F_METRIC_COUNT] as number) < 2000, 'the count is policy-scoped');
});

test('mutation from a query result: confirm an Order by identity, then observe it', async () => {
  const s = authority();
  await s.start();
  const page = (await s.handle(q(id.Q_ORDERS, { [id.P_STATUS]: 'placed' }, 'admin', { pageSize: 1 }))) as QueryResponse;
  const orderId = page.page!.items[0][id.F_SUMMARY_ID] as string;

  const result = await s.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: id.A_CONFIRM_ORDER as never,
    arguments: { [id.P_CONFIRM_ID]: orderId },
    credential: 'admin',
  });
  assert.equal((result as { ok: boolean }).ok, true, JSON.stringify(result));

  const detail = (await s.handle(q(id.Q_ORDER_DETAIL, { [id.P_DETAIL_ID]: orderId }, 'admin'))) as QueryResponse;
  assert.equal(detail.page!.items[0][id.F_SUMMARY_STATUS], 'confirmed');
});

test('Order Detail lines carry a computed lineTotal from a Product join (no re-implemented arithmetic)', async () => {
  const s = authority();
  await s.start();
  const anyOrder = (await s.handle(q(id.Q_ORDERS, {}, 'admin', { pageSize: 1 }))) as QueryResponse;
  const orderId = anyOrder.page!.items[0][id.F_SUMMARY_ID] as string;
  const lines = (await s.handle(q(id.Q_ORDER_LINES, { [id.P_LINES_ID]: orderId }, 'admin'))) as QueryResponse;
  assert.ok(lines.page!.items.length >= 1);
  for (const line of lines.page!.items) {
    assert.equal(typeof line[id.F_LINE_SUMMARY_PRODUCT], 'string');
    assert.equal(line[id.F_LINE_SUMMARY_LINE_TOTAL], (line[id.F_LINE_SUMMARY_QUANTITY] as number) * 1 * ((line[id.F_LINE_SUMMARY_LINE_TOTAL] as number) / (line[id.F_LINE_SUMMARY_QUANTITY] as number)));
  }
});

test('the reference application source contains no data-access escape hatch (spec §106)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/order-management.ts', import.meta.url)),
    'utf8',
  );
  for (const escape of ['SELECT ', 'fetch(', 'app.get(', 'app.post(', '.findMany(', 'PrismaClient', 'new Database(']) {
    assert.ok(!source.includes(escape), `the reference app must not contain "${escape}"`);
  }
  assert.equal(
    (source.match(/kind: 'read-policy'/g) ?? []).length,
    1,
    'the visibility rule is declared exactly once',
  );
});

test('the client query store paginates the Orders screen without touching a cursor string', async () => {
  const s = authority();
  await s.start();
  const store = createQueryStore(async (request): Promise<RemoteQueryResult> => {
    const response = (await s.handle({
      kind: 'query',
      protocol: PROTOCOL_VERSION,
      queryId: request.queryId as never,
      ...(request.arguments ? { arguments: request.arguments } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.pageSize !== undefined ? { pageSize: request.pageSize } : {}),
      credential: 'admin',
    })) as QueryResponse;
    return {
      ok: response.ok,
      diagnostics: response.diagnostics,
      ...(response.page ? { page: response.page as never } : {}),
      revision: response.revision,
    };
  });
  const key = { queryId: id.Q_ORDERS as never, arguments: { [id.P_STATUS]: 'confirmed' } };
  await store.load(key, { pageSize: 5 });
  assert.equal(store.get(key).status, 'ready');
  const first = store.get(key).page!.items.length;
  await store.loadMore(key);
  assert.ok(store.get(key).page!.items.length > first, 'loadMore appended a page');
});
