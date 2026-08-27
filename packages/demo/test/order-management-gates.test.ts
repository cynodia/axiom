import assert from 'node:assert/strict';
import test from 'node:test';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  SERVER_DIAGNOSTIC_CODES,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
} from '@cynodia/axiom-server';
import type { QueryResponse, ServerRequest } from '@cynodia/axiom-server';
import {
  createOrderManagementGraph,
  generateOrderManagementDataset,
  orderManagementIds as id,
} from '@cynodia/axiom-demo';

/**
 * The spec §100-105 gates, run against the reference application at a scale large enough
 * that accidental materialization or an N+1 traversal would show up.
 */
const ir = compileToServerIR(createOrderManagementGraph());
const ORDERS = 15_000;
const dataset = generateOrderManagementDataset({ customers: 200, products: 40, orders: ORDERS, linesPerOrder: 3 });

let calls: string[] = [];
function authority() {
  calls = [];
  const server = createAxiomServer({
    ir,
    host: createDeterministicServerHost({
      authenticate: (credential) =>
        credential === 'admin'
          ? { [id.F_PRINCIPAL_ROLE]: 'admin', [id.F_PRINCIPAL_CUSTOMER]: 'root' }
          : credential?.startsWith('cust:')
            ? { [id.F_PRINCIPAL_ROLE]: 'customer', [id.F_PRINCIPAL_CUSTOMER]: credential.slice(5) }
            : null,
    }),
    cursorSecret: 'gates',
    dataProvider: createMemoryDataProvider({
      rows: dataset as never,
      maxPageSize: 50,
      onProviderCall: (kind) => calls.push(kind),
    }),
  });
  return server;
}
function req(body: Record<string, unknown>): ServerRequest {
  return { protocol: PROTOCOL_VERSION, ...body } as ServerRequest;
}
function query(queryId: string, args: Record<string, unknown>, credential: string, extra: Record<string, unknown> = {}) {
  return req({ kind: 'query', queryId, arguments: args, credential, ...extra });
}

// ----------------------------------------------------------- §100/§101 bounded materialization

test('§101: requesting the first 50 matching orders never materializes all matches', async () => {
  const s = authority();
  await s.start();
  let totalItemsSeen = 0;
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const response = (await s.handle(
      query(id.Q_ORDERS, { [id.P_STATUS]: 'confirmed' }, 'admin', { pageSize: 50, ...(cursor ? { cursor } : {}) }),
    )) as QueryResponse;
    assert.equal(response.ok, true);
    assert.ok(response.page!.items.length <= 50, 'a page is bounded by the request');
    totalItemsSeen += response.page!.items.length;
    cursor = response.page!.nextCursor;
    if (!cursor) break;
  }
  assert.ok(totalItemsSeen <= 250, 'only the pages actually requested were returned');
  // No Order collection is anywhere in observable authority state.
  for (const stateId of ir.observableStateIds) {
    const value = s.getState(stateId);
    assert.ok(!Array.isArray(value) || value.length < 100, 'no large collection lives in authority state');
  }
});

// -------------------------------------------------------------------------- §102 N+1 gate

test('§102: a page of 50 orders + Customer.name is not 51 provider calls', async () => {
  const s = authority();
  await s.start();
  calls = [];
  const response = (await s.handle(query(id.Q_ORDERS, {}, 'admin', { pageSize: 50 }))) as QueryResponse;
  assert.equal(response.page!.items.length, 50);
  assert.ok(response.page!.items.every((row) => typeof row[id.F_SUMMARY_CUSTOMER_NAME] === 'string'));
  const relationshipCalls = calls.filter((call) => call === 'relationship').length;
  assert.ok(relationshipCalls <= 4, `expected batched traversal, saw ${relationshipCalls}`);
  assert.ok(calls.length < 50, `total provider calls ${calls.length} must be far below the page size`);
});

// -------------------------------------------------------------------- §103 aggregate gate

test('§103: count/sum over 15k orders is provider aggregation, not row enumeration', async () => {
  const s = authority();
  await s.start();
  calls = [];
  const total = (await s.handle(query(id.Q_TOTAL_ORDERS, {}, 'admin'))) as QueryResponse;
  const revenue = (await s.handle(query(id.Q_REVENUE, {}, 'admin'))) as QueryResponse;
  assert.equal(total.aggregate!.rows[0].values[id.F_METRIC_COUNT], ORDERS);
  assert.ok((revenue.aggregate!.rows[0].values[id.F_METRIC_REVENUE] as number) > 0);
  assert.ok(calls.every((call) => call === 'aggregate'), `only aggregate calls, saw: ${[...new Set(calls)].join(',')}`);
  assert.ok(calls.length <= 4, 'a bounded number of aggregate calls');
});

// ----------------------------------------------------------------- §104 hostile client suite

test('§104: the hostile client suite', async () => {
  const s = authority();
  await s.start();
  const admin = 'admin';

  // unknown QueryDef
  const unknown = (await s.handle(query('query_does_not_exist', {}, admin))) as QueryResponse;
  assert.equal(unknown.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_NOT_FOUND);

  // arbitrary customer id — a customer naming another's id sees nothing
  const otherId = (await s.handle(
    query(id.Q_CUSTOMER_HISTORY, { [id.P_CUSTOMER_ID]: 'c000002' }, 'cust:c000001', { pageSize: 50 }),
  )) as QueryResponse;
  assert.equal(otherId.page!.items.length, 0);

  // malformed cursor
  const badCursor = (await s.handle(
    query(id.Q_ORDERS, {}, admin, { pageSize: 10, cursor: 'garbage.value' }),
  )) as QueryResponse;
  assert.equal(badCursor.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_CURSOR_INVALID);

  // cursor from another principal
  const p1 = (await s.handle(query(id.Q_ORDERS, {}, 'cust:c000001', { pageSize: 2 }))) as QueryResponse;
  const crossPrincipal = (await s.handle(
    query(id.Q_ORDERS, {}, 'cust:c000002', { pageSize: 2, cursor: p1.page!.nextCursor }),
  )) as QueryResponse;
  assert.equal(crossPrincipal.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_CURSOR_INVALID);

  // cursor from another QueryDef
  const crossQuery = (await s.handle(
    query(id.Q_CUSTOMER_HISTORY, { [id.P_CUSTOMER_ID]: 'c000001' }, 'cust:c000001', {
      pageSize: 2,
      cursor: p1.page!.nextCursor,
    }),
  )) as QueryResponse;
  assert.equal(crossQuery.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_CURSOR_INVALID);

  // oversized page
  const oversized = (await s.handle(query(id.Q_ORDERS, {}, admin, { pageSize: 10_000_000 }))) as QueryResponse;
  assert.equal(oversized.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_PAGE_SIZE_EXCEEDED);

  // malformed parameter types
  const badType = (await s.handle(query(id.Q_ORDERS, { [id.P_STATUS]: 42 }, admin))) as QueryResponse;
  assert.equal(badType.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_ARGUMENT_TYPE_MISMATCH);

  // unknown argument name
  const badArg = (await s.handle(query(id.Q_ORDERS, { nope: 1 }, admin))) as QueryResponse;
  assert.equal(badArg.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_ARGUMENT_TYPE_MISMATCH);

  // forged principal: an unauthenticated caller gets the anonymous (empty) view
  const anon = (await s.handle(query(id.Q_ORDERS, {}, 'no-such-credential', { pageSize: 50 }))) as QueryResponse;
  assert.equal(anon.ok, true);
  assert.equal(anon.page!.items.length, 0, 'an unauthenticated caller matches no rows');
});

// ---------------------------------------------------------------- §105 valid-but-wrong suite

test('§105: the read policy applies to aggregates, not only rows', async () => {
  const s = authority();
  await s.start();
  const adminCount = (await s.handle(query(id.Q_TOTAL_ORDERS, {}, 'admin'))) as QueryResponse;
  const custCount = (await s.handle(query(id.Q_TOTAL_ORDERS, {}, 'cust:c000001'))) as QueryResponse;
  assert.equal(adminCount.aggregate!.rows[0].values[id.F_METRIC_COUNT], ORDERS);
  const scoped = custCount.aggregate!.rows[0].values[id.F_METRIC_COUNT] as number;
  assert.ok(scoped > 0 && scoped < ORDERS, `a customer's count (${scoped}) is policy-scoped`);
});

test('§105: a cache entry never leaks across principals', async () => {
  const s = authority();
  await s.start();
  const a = (await s.handle(query(id.Q_ORDERS, {}, 'cust:c000001', { pageSize: 5 }))) as QueryResponse;
  const b = (await s.handle(query(id.Q_ORDERS, {}, 'cust:c000002', { pageSize: 5 }))) as QueryResponse;
  assert.notDeepEqual(a.page!.items, b.page!.items);
});

test('§105: a query result is a view, not mutable canonical state', async () => {
  const s = authority();
  await s.start();
  const first = (await s.handle(query(id.Q_ORDERS, {}, 'admin', { pageSize: 3 }))) as QueryResponse;
  const orderId = first.page!.items[0][id.F_SUMMARY_ID];
  // Mutate the returned object.
  first.page!.items[0][id.F_SUMMARY_STATUS] = 'tampered';
  // Re-query: the authority is unchanged.
  const again = (await s.handle(query(id.Q_ORDERS, {}, 'admin', { pageSize: 3 }))) as QueryResponse;
  const same = again.page!.items.find((row) => row[id.F_SUMMARY_ID] === orderId);
  assert.notEqual(same![id.F_SUMMARY_STATUS], 'tampered', 'editing the returned view did not reach canonical data');
});

test('§105: an unstable cursor query is rejected at validation, not at runtime', async () => {
  // A cursor query over a source with no identity field cannot paginate deterministically.
  const { ApplicationGraph, primitiveType, collectionType, entityType, fieldId, nodeId } = await import(
    '@cynodia/axiom-core'
  );
  const { validateGraph } = await import('@cynodia/axiom-core');
  const g = new ApplicationGraph('unstable', 'Unstable');
  const E = nodeId('entity_e');
  const F = fieldId('field_f');
  g.addNode({ id: E, kind: 'entity', fields: [{ id: F, valueType: primitiveType('string'), required: true }] } as never);
  g.addNode({ id: nodeId('state_e'), kind: 'state', valueType: collectionType(entityType(E)) } as never);
  g.addNode({
    id: nodeId('query_unstable'),
    kind: 'query',
    source: E,
    rowScopeId: nodeId('scope_r'),
    pagination: { strategy: 'cursor', maxPageSize: 10 },
  } as never);
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'UNSTABLE_PAGINATION'));
});
