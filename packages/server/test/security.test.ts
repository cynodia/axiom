import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeId, validateGraph } from '@cynodia/axiom-core';
import { compileToIR, compileToServerIR } from '@cynodia/axiom-compiler';
import {
  RUNTIME_DIAGNOSTIC_CODES,
  createAxiomRuntime,
  createMemoryHost,
} from '@cynodia/axiom-runtime';
import {
  PROTOCOL_VERSION,
  SERVER_DIAGNOSTIC_CODES,
  createAxiomServer,
  createDeterministicServerHost,
  createDirectTransport,
  createRemoteGateway,
  serveOverHttp,
} from '@cynodia/axiom-server';
import type { InvokeResponse, SnapshotResponse } from '@cynodia/axiom-server';
import { createOrderServerGraph, orderServerIds as ids } from '@cynodia/axiom-demo/order-server';

/**
 * The client is untrusted.
 *
 * Every attempt below is one a hostile client can actually make, and each must fail at the
 * boundary rather than at a convention. None of these protections lives in the UI.
 */

const CLERK = { [ids.F_USER_ID]: 'u1', [ids.F_USER_ROLE]: 'clerk' };
const ADMIN = { [ids.F_USER_ID]: 'u2', [ids.F_USER_ROLE]: 'admin' };

async function authority(options: { anonymous?: boolean } = {}) {
  const server = createAxiomServer({
    ir: compileToServerIR(createOrderServerGraph()),
    host: createDeterministicServerHost({
      authenticate: (credential) =>
        options.anonymous
          ? null
          : credential === 'admin'
            ? ADMIN
            : credential === 'clerk'
              ? CLERK
              : null,
    }),
  });
  await server.start();
  return server;
}

function stockOf(server: Awaited<ReturnType<typeof authority>>, productId: string): number {
  return (server.getState(ids.STATE_PRODUCTS) as Array<Record<string, number>>).find(
    (product) => (product[ids.F_PRODUCT_ID] as unknown as string) === productId,
  )?.[ids.F_PRODUCT_STOCK] as number;
}

async function invoke(
  server: Awaited<ReturnType<typeof authority>>,
  actionId: string,
  args: Record<string, unknown> = {},
  credential?: string,
): Promise<InvokeResponse> {
  return (await server.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: nodeId(actionId),
    arguments: args,
    ...(credential ? { credential } : {}),
  })) as InvokeResponse;
}

// -------------------------------------------------- writing authoritative state

test('the graph itself refuses to bind an input to server-authoritative state', () => {
  const graph = createOrderServerGraph();
  const input = graph.getNode(ids.UI_QUANTITY_INPUT);
  assert.ok(input);
  // Rebinding the quantity input straight into authoritative stock.
  graph.updateNode({
    ...input,
    binding: { location: { kind: 'state', stateId: ids.STATE_PRODUCTS } },
  } as never);

  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((problem) => problem.code === 'CLIENT_WRITE_TO_SERVER_STATE'),
    true,
  );
});

test('a client runtime refuses to write server-authoritative state, however it is asked', async () => {
  const graph = createOrderServerGraph();
  const host = createMemoryHost();
  const client = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  client.start();

  // The administrative escape hatch is not an escape hatch across the authority boundary.
  client.hydrateState(ids.STATE_PRODUCTS, [{ [ids.F_PRODUCT_ID]: 'bolt', [ids.F_PRODUCT_STOCK]: 9999 }]);

  assert.equal(
    client.diagnostics().some((d) => d.code === RUNTIME_DIAGNOSTIC_CODES.SERVER_STATE_WRITE),
    true,
  );
  assert.deepEqual(client.getState(ids.STATE_PRODUCTS), [], 'the value never moved');
});

test('a client cannot execute a server action locally, because it has no operations', () => {
  const ir = compileToIR(createOrderServerGraph());
  assert.deepEqual(ir.actions[ids.ACTION_PLACE_ORDER].operations, []);
  assert.equal(ir.actions[ids.ACTION_PLACE_ORDER].preconditions, undefined);
  assert.equal(ir.actions[ids.ACTION_PLACE_ORDER].authorization, undefined);
  assert.ok(ir.remoteActionIds.includes(ids.ACTION_PLACE_ORDER));
});

test('a client with no gateway cannot invoke a remote action at all', () => {
  const host = createMemoryHost();
  const client = createAxiomRuntime({
    ir: compileToIR(createOrderServerGraph()),
    rootElement: host.root,
    host,
  });
  client.start();

  const result = client.invokeAction(ids.ACTION_PLACE_ORDER, {
    [ids.PARAM_PRODUCT]: 'bolt',
    [ids.PARAM_QUANTITY]: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, RUNTIME_DIAGNOSTIC_CODES.REMOTE_ACTION_UNAVAILABLE);
});

// ---------------------------------------------------------------- the protocol

test('the protocol carries no way to send mutation operations', async () => {
  const server = await authority();
  // What a hostile client would like to send.
  const forged = await server.handle({
    kind: 'mutate',
    protocol: PROTOCOL_VERSION,
    operations: [{ kind: 'set', target: { kind: 'state', stateId: ids.STATE_PRODUCTS }, value: 9999 }],
  } as never);

  assert.equal(forged.kind, 'error');
  assert.equal(stockOf(server, 'bolt'), 10);
});

test('a forged action id is refused', async () => {
  const server = await authority();
  const answer = await invoke(server, 'action_grant_me_everything', {}, 'admin');
  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.UNKNOWN_SERVER_ACTION);
});

test('an action the authority does not own cannot be invoked through it', async () => {
  const server = await authority();
  // A client-authoritative action is not in the Server IR, so the authority will not run it.
  const answer = await invoke(server, 'action_place_order_client_side', {}, 'admin');
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.UNKNOWN_SERVER_ACTION);
});

// ------------------------------------------------------------- forged claims

test('a client claiming its own validation passed changes nothing', async () => {
  const server = await authority();
  // Extra fields asserting the client already checked everything.
  const answer = await invoke(
    server,
    ids.ACTION_PLACE_ORDER,
    {
      [ids.PARAM_PRODUCT]: 'bolt',
      [ids.PARAM_QUANTITY]: 99,
      validated: true,
      guardsPassed: true,
      authorized: true,
    },
    'clerk',
  );

  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.ARGUMENT_TYPE_MISMATCH);
  assert.equal(stockOf(server, 'bolt'), 10);
});

test('a guard is evaluated against authoritative state, not against what the client says', async () => {
  const server = await authority();
  const answer = await invoke(
    server,
    ids.ACTION_PLACE_ORDER,
    { [ids.PARAM_PRODUCT]: 'bolt', [ids.PARAM_QUANTITY]: 99 },
    'clerk',
  );
  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].details?.failureMode, 'insufficient-stock');
  assert.equal(stockOf(server, 'bolt'), 10);
});

test('an argument of the wrong type is refused before anything runs', async () => {
  const server = await authority();
  for (const quantity of ['3', null, {}, [], Number.NaN]) {
    const answer = await invoke(
      server,
      ids.ACTION_PLACE_ORDER,
      { [ids.PARAM_PRODUCT]: 'bolt', [ids.PARAM_QUANTITY]: quantity },
      'clerk',
    );
    assert.equal(answer.ok, false, `quantity ${JSON.stringify(quantity)} should be refused`);
  }
  assert.equal(stockOf(server, 'bolt'), 10);
});

test('a negative quantity is refused by the guard, not by the type', async () => {
  const server = await authority();
  const answer = await invoke(
    server,
    ids.ACTION_PLACE_ORDER,
    { [ids.PARAM_PRODUCT]: 'bolt', [ids.PARAM_QUANTITY]: -5 },
    'clerk',
  );
  assert.equal(answer.diagnostics[0].details?.failureMode, 'invalid-quantity');
});

// ------------------------------------------------------------- authorization

test('an unauthorized caller cannot invoke an administrative action', async () => {
  const server = await authority();
  const answer = await invoke(
    server,
    ids.ACTION_ADJUST_STOCK,
    { [ids.PARAM_ADJUST_PRODUCT]: 'bolt', [ids.PARAM_ADJUST_STOCK]: 9999 },
    'clerk',
  );
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_DENIED);
  assert.equal(stockOf(server, 'bolt'), 10);
});

test('an unauthenticated caller cannot invoke an action that requires anyone', async () => {
  const server = await authority({ anonymous: true });
  const answer = await invoke(server, ids.ACTION_PLACE_ORDER, {
    [ids.PARAM_PRODUCT]: 'bolt',
    [ids.PARAM_QUANTITY]: 1,
  });
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_DENIED);
});

test('a forged credential resolves to nobody', async () => {
  const server = await authority();
  const answer = await invoke(
    server,
    ids.ACTION_ADJUST_STOCK,
    { [ids.PARAM_ADJUST_PRODUCT]: 'bolt', [ids.PARAM_ADJUST_STOCK]: 1 },
    'i-am-the-admin-really',
  );
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_DENIED);
});

// -------------------------------------------------------------- state leakage

test('server-only state is never disclosed, by any request', async () => {
  const server = await authority();
  await invoke(server, ids.ACTION_PLACE_ORDER, {
    [ids.PARAM_PRODUCT]: 'bolt',
    [ids.PARAM_QUANTITY]: 1,
  }, 'clerk');

  const snapshot = (await server.handle({
    kind: 'snapshot',
    protocol: PROTOCOL_VERSION,
  })) as SnapshotResponse;
  assert.equal(ids.STATE_AUDIT in snapshot.snapshot.states, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /placed 1 of bolt/);

  const answer = await invoke(server, ids.ACTION_PLACE_ORDER, {
    [ids.PARAM_PRODUCT]: 'bolt',
    [ids.PARAM_QUANTITY]: 1,
  }, 'clerk');
  assert.equal(ids.STATE_AUDIT in answer.changes, false);
  // The authority did write it; it simply never leaves.
  assert.equal((server.getState(ids.STATE_AUDIT) as unknown[]).length, 2);
});

test('the client IR contains no server-only state and no authorization rule', () => {
  const serialized = JSON.stringify(compileToIR(createOrderServerGraph()));
  assert.doesNotMatch(serialized, /state_audit/);
  assert.doesNotMatch(serialized, /axiom_principal/);
  assert.doesNotMatch(serialized, /insufficient-stock/, 'nor the failure modes of a remote guard');
});

// ------------------------------------------------------------- transport edges

test('a malformed body over the real transport becomes a structured refusal', async () => {
  const server = await authority();
  const running = await serveOverHttp({ server, port: 0 });
  try {
    const notJson = await fetch(running.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    assert.equal(notJson.status, 400);

    const notAxiom = await fetch(running.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const answer = (await notAxiom.json()) as { kind: string; diagnostics: Array<{ code: string }> };
    assert.equal(answer.kind, 'error');
    assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.MALFORMED_REQUEST);

    const wrongPath = await fetch(`http://127.0.0.1:${running.port}/anything-else`, { method: 'POST' });
    assert.equal(wrongPath.status, 404);
    assert.equal(stockOf(server, 'bolt'), 10);
  } finally {
    await running.close();
  }
});

test('an unreachable authority becomes a diagnostic, not an exception', async () => {
  const server = await authority();
  const running = await serveOverHttp({ server, port: 0 });
  const url = running.url;
  await running.close();

  const { createHttpTransport } = await import('@cynodia/axiom-server');
  const gateway = createRemoteGateway(createHttpTransport({ url, timeoutMs: 250 }));
  const answer = await gateway.invoke({
    actionId: ids.ACTION_PLACE_ORDER,
    arguments: {},
    requestId: 'r-1',
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.AUTHORITY_UNREACHABLE);
});

test('the direct transport still copies the request, so no live reference crosses', async () => {
  const server = await authority();
  const transport = createDirectTransport(server);
  const args = { [ids.PARAM_PRODUCT]: 'bolt', [ids.PARAM_QUANTITY]: 1 };
  const answer = await transport.send({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: ids.ACTION_PLACE_ORDER,
    arguments: args,
    credential: 'clerk',
  });
  assert.equal(answer.kind, 'result');
  // Mutating the caller's object afterwards cannot affect what was executed.
  args[ids.PARAM_QUANTITY] = 999;
  assert.equal(stockOf(server, 'bolt'), 9);
});

test('PRINCIPAL resolves inside operations, not only inside authorization rules', async () => {
  // An authoritative record that says who caused it is the reason this matters: the client
  // passes no user id, so it cannot claim one. Binding the caller only while an
  // authorization rule is being checked would leave an unauthorized action writing whatever
  // the previous caller left behind.
  const server = await authority();
  await invoke(
    server,
    ids.ACTION_PLACE_ORDER,
    { [ids.PARAM_PRODUCT]: 'bolt', [ids.PARAM_QUANTITY]: 1 },
    'clerk',
  );
  await invoke(
    server,
    ids.ACTION_PLACE_ORDER,
    { [ids.PARAM_PRODUCT]: 'bolt', [ids.PARAM_QUANTITY]: 1 },
    'admin',
  );

  const orders = server.getState(ids.STATE_ORDERS) as Array<Record<string, unknown>>;
  assert.deepEqual(
    orders.map((order) => order[ids.F_ORDER_PLACED_BY]),
    ['u1', 'u2'],
    'each order records the caller who actually placed it',
  );
});

