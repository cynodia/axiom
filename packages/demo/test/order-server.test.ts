import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isUINode, validateGraph } from '@cynodia/axiom-core';
import type { ApplicationGraph } from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';
import { compileToHtml, compileToIR, compileToServerIR } from '@cynodia/axiom-compiler';
import {
  RUNTIME_DIAGNOSTIC_CODES,
  createAxiomRuntime,
  createMemoryHost,
  findAll,
  findByNodeId,
  findByTag,
  textOf,
} from '@cynodia/axiom-runtime';
import {
  SERVER_DIAGNOSTIC_CODES,
  createAxiomServer,
  createDeterministicServerHost,
  createServerHost,
  createDirectTransport,
  createHttpTransport,
  createMemoryPersistence,
  createRemoteGateway,
  createSqlitePersistence,
  isSqliteAvailable,
  serveOverHttp,
} from '@cynodia/axiom-server';
import type { PersistenceAdapter } from '@cynodia/axiom-server';
import { createOrderServerGraph, orderServerIds as ids } from '@cynodia/axiom-demo/order-server';

/**
 * The 0.6 end-to-end demonstration.
 *
 * A browser-shaped client, a generic authority and durable state, with every business rule
 * living in the graph: no application route, handler, controller or SQL anywhere.
 */

const CLERK = { [ids.F_USER_ID]: 'u1', [ids.F_USER_ROLE]: 'clerk' };
const ADMIN = { [ids.F_USER_ID]: 'u2', [ids.F_USER_ROLE]: 'admin' };

async function authority(persistence?: PersistenceAdapter, graph: ApplicationGraph = createOrderServerGraph()) {
  const server = createAxiomServer({
    ir: compileToServerIR(graph),
    persistence: persistence ?? createMemoryPersistence(),
    // A real host: identifiers must not repeat across a restart, or a new record would
    // collide with an existing one — see the identity test below.
    host: createServerHost({
      authenticate: (credential) =>
        credential === 'admin' ? ADMIN : credential === 'clerk' ? CLERK : null,
    }),
  });
  await server.start();
  return server;
}

/** A client runtime reaching that authority, as a browser would. */
async function client(
  server: Awaited<ReturnType<typeof authority>>,
  graph: ApplicationGraph = createOrderServerGraph(),
) {
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({
    ir: compileToIR(graph),
    rootElement: host.root,
    host,
    remote: createRemoteGateway(createDirectTransport(server, { credential: () => 'clerk' })),
  });
  app.start();
  await app.syncAuthoritativeState();
  return { app, host };
}

const stockOf = (state: unknown, productId: string): number =>
  (state as Array<Record<string, number>>).find(
    (product) => (product[ids.F_PRODUCT_ID] as unknown as string) === productId,
  )?.[ids.F_PRODUCT_STOCK] as number;

async function place(
  app: Awaited<ReturnType<typeof client>>['app'],
  productId: string,
  quantity: number,
) {
  app.hydrateState(ids.STATE_DRAFT_PRODUCT, productId);
  app.hydrateState(ids.STATE_DRAFT_QUANTITY, quantity);
  return app.invokeActionAsync(ids.ACTION_PLACE_ORDER, {
    [ids.PARAM_PRODUCT]: productId,
    [ids.PARAM_QUANTITY]: quantity,
  });
}

// ------------------------------------------------------------------- the graph

test('the reference application is a valid graph with no findings', () => {
  const result = validateGraph(createOrderServerGraph());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

/** Section 81. */
test('the application contains no backend code of its own', () => {
  const graph = createOrderServerGraph();
  const serialized = graph.serialize();

  // The whole application is data.
  assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(graph.toJSON())));
  for (const forbidden of [/=>/, /\bfunction\s*\(/, /SELECT /i, /INSERT INTO/i, /\bapp\.(get|post|put)\(/, /https?:\/\//]) {
    assert.doesNotMatch(serialized, forbidden, `the graph contains ${String(forbidden)}`);
  }
  // Not one native operation: the behaviour is semantics, not an escape hatch.
  const native = graph
    .getNodesByKind('action')
    .flatMap((action) => (action.operations ?? []).filter((operation) => operation.kind === 'native'));
  assert.deepEqual(native, []);
  // And no renderer escape hatch either.
  for (const node of graph.listNodes()) {
    if (isUINode(node)) {
      assert.equal(node.presentation?.rendererOverrides, undefined);
    }
  }
});

test('an agent can reason about the authority boundary', () => {
  const agent = new AgentAPI(createOrderServerGraph());

  assert.equal(agent.getAuthority(ids.STATE_PRODUCTS), 'server');
  assert.equal(agent.getAuthority(ids.STATE_DRAFT_PRODUCT), 'client');
  assert.deepEqual(
    agent.getServerActions().map((action) => action.name).sort(),
    ['adjustStock', 'placeOrder'],
  );
  assert.deepEqual(
    agent.getServerWritableStates().map((state) => state.id).sort(),
    [ids.STATE_AUDIT, ids.STATE_ORDERS, ids.STATE_PRODUCTS].sort(),
  );
  assert.deepEqual(
    agent.getClientWritableStates().map((state) => state.id).sort(),
    [ids.STATE_DRAFT_PRODUCT, ids.STATE_DRAFT_QUANTITY].sort(),
  );
  assert.deepEqual(
    agent.getServerOnlyStates().map((state) => state.id),
    [ids.STATE_AUDIT],
  );
  assert.equal(agent.getActionAuthority(ids.ACTION_PLACE_ORDER), 'server');
  assert.ok(agent.getAuthorizationForAction(ids.ACTION_ADJUST_STOCK));
  assert.deepEqual(agent.getUnauthorizedServerActions(), [], 'both server actions are guarded');

  const affecting = agent.getActionsAffectingServerState();
  const placing = affecting.find((entry) => entry.action.id === ids.ACTION_PLACE_ORDER);
  assert.deepEqual(placing?.stateIds.sort(), [ids.STATE_AUDIT, ids.STATE_ORDERS, ids.STATE_PRODUCTS].sort());
});

test('the client half is still a self-contained local page', () => {
  // Section 55: server capability is additive; the page is emitted exactly as before.
  const html = compileToHtml(createOrderServerGraph());
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /createAxiomRuntime/);
  assert.doesNotMatch(html, /state_audit/);
  assert.doesNotMatch(html, /axiom_principal/);
});

// -------------------------------------------------------- the demonstration

/** Section 80, steps 1–10. */
test('a client observes authoritative state, drafts locally, and commits through the authority', async () => {
  const server = await authority();
  const { app, host } = await client(server);

  // 3. The client observes authoritative products and orders.
  assert.equal(stockOf(app.getState(ids.STATE_PRODUCTS), 'bolt'), 10);
  assert.deepEqual(app.getState(ids.STATE_ORDERS), []);
  assert.match(textOf(host.root), /Anchor bolt/);
  // A derivation over observed state is computed locally, not transferred.
  assert.equal(app.getState(ids.STATE_STOCK_TOTAL), 15);

  // 4. The client creates local draft data. 5. It invokes the server action.
  const result = await place(app, 'bolt', 3);

  // 6-9. The authority evaluated its own guards, committed, and answered.
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(stockOf(server.getState(ids.STATE_PRODUCTS), 'bolt'), 7);
  assert.equal((server.getState(ids.STATE_ORDERS) as unknown[]).length, 1);

  // 10. The client has the authoritative result, and the UI shows it.
  assert.equal(stockOf(app.getState(ids.STATE_PRODUCTS), 'bolt'), 7);
  assert.equal(app.getState(ids.STATE_STOCK_TOTAL), 12);
  assert.equal(app.getActionOutcome(ids.ACTION_PLACE_ORDER)?.outcome, 'ok');
  assert.equal(findByNodeId(host.root, ids.UI_ORDERS).length, 1);
  assert.match(textOf(host.root), /placed/);

  // The order records who placed it from the authority's own principal, not from anything
  // the client supplied.
  const order = (server.getState(ids.STATE_ORDERS) as Array<Record<string, string>>)[0];
  assert.equal(order[ids.F_ORDER_PLACED_BY], 'u1');
});

/** Section 80, steps 13–14. */
test('a refused order reaches the interface as a semantic diagnostic', async () => {
  const server = await authority();
  const { app, host } = await client(server);

  const result = await place(app, 'bolt', 99);

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].details?.failureMode, 'insufficient-stock');
  assert.equal(app.getActionOutcome(ids.ACTION_PLACE_ORDER)?.outcome, 'failed');

  // The message came from the graph's own failure mode, through the diagnostic node.
  const region = findByNodeId(host.root, ids.UI_REFUSAL)[0];
  assert.ok(region);
  assert.equal(region.getAttribute('role'), 'alert');
  assert.match(textOf(region), /not enough stock/i);
  assert.equal(stockOf(app.getState(ids.STATE_PRODUCTS), 'bolt'), 10, 'and nothing moved');

  // A later success clears it.
  await place(app, 'bolt', 1);
  assert.equal(textOf(findByNodeId(host.root, ids.UI_REFUSAL)[0]).trim(), '');
});

test('an invocation is pending until the authority answers', async () => {
  const server = await authority();
  const { app } = await client(server);

  app.hydrateState(ids.STATE_DRAFT_PRODUCT, 'bolt');
  app.hydrateState(ids.STATE_DRAFT_QUANTITY, 2);
  const immediate = app.invokeAction(ids.ACTION_PLACE_ORDER, {
    [ids.PARAM_PRODUCT]: 'bolt',
    [ids.PARAM_QUANTITY]: 2,
  });

  assert.equal(immediate.pending, true, 'the UI is never blocked on the network');
  assert.equal(app.getActionOutcome(ids.ACTION_PLACE_ORDER)?.outcome, 'pending');

  await app.invokeActionAsync(ids.ACTION_PLACE_ORDER, {
    [ids.PARAM_PRODUCT]: 'bolt',
    [ids.PARAM_QUANTITY]: 1,
  });
  assert.equal(app.getActionOutcome(ids.ACTION_PLACE_ORDER)?.outcome, 'ok');
});

/** Section 80, steps 15–16. */
test('the client cannot mutate authoritative stock directly', async () => {
  const server = await authority();
  const { app } = await client(server);

  app.hydrateState(ids.STATE_PRODUCTS, [{ [ids.F_PRODUCT_ID]: 'bolt', [ids.F_PRODUCT_STOCK]: 9999 }]);

  assert.equal(
    app.diagnostics().some((d) => d.code === RUNTIME_DIAGNOSTIC_CODES.SERVER_STATE_WRITE),
    true,
  );
  assert.equal(stockOf(app.getState(ids.STATE_PRODUCTS), 'bolt'), 10);
  assert.equal(stockOf(server.getState(ids.STATE_PRODUCTS), 'bolt'), 10);
});

/** Section 46 and 80, steps 17–18. */
test('two conflicting orders cannot both commit', async () => {
  const server = await authority();
  const { app } = await client(server);
  // Bring stock to five, as an administrator.
  const adminApp = await client(server);
  void adminApp;

  const admin = createRemoteGateway(createDirectTransport(server, { credential: () => 'admin' }));
  await admin.invoke({
    actionId: ids.ACTION_ADJUST_STOCK,
    arguments: { [ids.PARAM_ADJUST_PRODUCT]: 'bolt', [ids.PARAM_ADJUST_STOCK]: 5 },
    requestId: 'seed',
  });

  const [a, b] = await Promise.all([place(app, 'bolt', 4), place(app, 'bolt', 4)]);
  assert.equal([a, b].filter((result) => result.ok).length, 1, 'exactly one commits');
  assert.equal(stockOf(server.getState(ids.STATE_PRODUCTS), 'bolt'), 1);
});

/** Section 80, steps 11–12. */
test('committed orders and stock survive a restart', async () => {
  if (!(await isSqliteAvailable())) {
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'axiom-desk-'));
  try {
    const file = path.join(directory, 'desk.db');
    const first = await authority(await createSqlitePersistence({ location: file }));
    const clientOne = await client(first);
    assert.equal((await place(clientOne.app, 'bolt', 4)).ok, true);
    assert.equal((await place(clientOne.app, 'bolt', 99)).ok, false);
    await first.stop();

    // A fresh authority over the same durable store.
    const second = await authority(await createSqlitePersistence({ location: file }));
    const clientTwo = await client(second);
    assert.equal(stockOf(clientTwo.app.getState(ids.STATE_PRODUCTS), 'bolt'), 6);
    assert.equal((clientTwo.app.getState(ids.STATE_ORDERS) as unknown[]).length, 1, 'one order, not two');
    assert.equal((await place(clientTwo.app, 'bolt', 1)).ok, true);
    assert.equal(stockOf(second.getState(ids.STATE_PRODUCTS), 'bolt'), 5);
    await second.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * The transition rule is what protects identity, and it does so without being asked to.
 *
 * A host whose identifiers repeat — a deterministic one restarted, say — would have a new
 * order collide with a committed one. The authority refuses the write rather than
 * overwriting a placed order.
 */
test('an identifier that collides with committed state is refused, not overwritten', async () => {
  const persistence = createMemoryPersistence();
  const server = createAxiomServer({
    ir: compileToServerIR(createOrderServerGraph()),
    persistence,
    // Deliberately repeating: `uuid()` starts from the same counter each time.
    host: createDeterministicServerHost({ authenticate: () => CLERK }),
  });
  await server.start();
  const { app } = await client(server);

  assert.equal((await place(app, 'bolt', 4)).ok, true);

  const restarted = createAxiomServer({
    ir: compileToServerIR(createOrderServerGraph()),
    persistence,
    host: createDeterministicServerHost({ authenticate: () => CLERK }),
  });
  await restarted.start();
  const second = await client(restarted);

  const collided = await place(second.app, 'bolt', 1);
  assert.equal(collided.ok, false);
  assert.equal(collided.diagnostics[0].code, 'TRANSITION_CONSTRAINT_VIOLATION');
  // The committed order is exactly as it was.
  const orders = restarted.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>;
  assert.equal(orders.length, 1);
  assert.equal(orders[0][ids.F_ORDER_QUANTITY], 4);
});

// -------------------------------------------------------------- real transport

test('the whole flow works over the reference network transport', async () => {
  const server = await authority();
  const running = await serveOverHttp({ server, port: 0 });
  try {
    const host = createMemoryHost({ path: '/' });
    const app = createAxiomRuntime({
      ir: compileToIR(createOrderServerGraph()),
      rootElement: host.root,
      host,
      remote: createRemoteGateway(
        createHttpTransport({ url: running.url, credential: () => 'clerk', timeoutMs: 2000 }),
      ),
    });
    app.start();
    await app.syncAuthoritativeState();
    assert.equal(stockOf(app.getState(ids.STATE_PRODUCTS), 'bolt'), 10);

    const result = await app.invokeActionAsync(ids.ACTION_PLACE_ORDER, {
      [ids.PARAM_PRODUCT]: 'bolt',
      [ids.PARAM_QUANTITY]: 2,
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(stockOf(app.getState(ids.STATE_PRODUCTS), 'bolt'), 8);
    assert.match(textOf(host.root), /placed/);

    // The principal came from the credential the transport presented.
    const order = (server.getState(ids.STATE_ORDERS) as Array<Record<string, string>>)[0];
    assert.equal(order[ids.F_ORDER_PLACED_BY], 'u1');

    // And an unauthorized action is still refused over the wire.
    const denied = await app.invokeActionAsync(ids.ACTION_ADJUST_STOCK, {
      [ids.PARAM_ADJUST_PRODUCT]: 'bolt',
      [ids.PARAM_ADJUST_STOCK]: 500,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_DENIED);
  } finally {
    await running.close();
  }
});

test('the interface renders authoritative state accessibly', async () => {
  const server = await authority();
  const { app, host } = await client(server);
  await place(app, 'bolt', 1);

  assert.equal(findByTag(host.root, 'h1').length, 1);
  assert.ok(findByTag(host.root, 'main').length >= 1);
  for (const button of findByTag(host.root, 'button')) {
    assert.ok(textOf(button).trim() || button.getAttribute('aria-label'));
  }
  const controls = findAll(host.root, (element) => element.getAttribute('id') !== null).map((element) =>
    element.getAttribute('id'),
  );
  assert.deepEqual(
    controls.filter((id, index) => controls.indexOf(id) !== index),
    [],
    'no duplicate element ids',
  );
});
