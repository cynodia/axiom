import assert from 'node:assert/strict';
import test from 'node:test';
import { compileToIR, compileToServerIR } from '@cynodia/axiom-compiler';
import { createAxiomRuntime, createMemoryHost, findAll } from '@cynodia/axiom-runtime';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createDirectTransport,
  createRemoteGateway,
} from '@cynodia/axiom-server';
import type { InvokeRequest, InvokeResponse, TransportAdapter } from '@cynodia/axiom-server';

/** What a runtime hands its gateway — the semantic request, without the transport envelope. */
type GatewayRequest = Parameters<ReturnType<typeof createRemoteGateway>['invoke']>[0];
import { createOrderServerGraph, orderServerIds as ids } from '@cynodia/axiom-demo/order-server';

/**
 * Request identity.
 *
 * An idempotency record is what stops a retry from executing twice, which makes it a thing
 * one caller can be handed in place of another's answer if two callers can produce the same
 * key. Both halves are tested here: that a client generates a key nobody else will generate,
 * and that the authority files it where nobody else will read it.
 */

const CLERK = { [ids.F_USER_ID]: 'u1', [ids.F_USER_ROLE]: 'clerk' };
const OTHER = { [ids.F_USER_ID]: 'u9', [ids.F_USER_ROLE]: 'clerk' };

async function authority() {
  const server = createAxiomServer({
    ir: compileToServerIR(createOrderServerGraph()),
    host: createDeterministicServerHost({
      authenticate: (credential) =>
        credential === 'clerk' ? CLERK : credential === 'other' ? OTHER : null,
    }),
  });
  await server.start();
  return server;
}

function order(quantity: number, credential: string, requestId: string): InvokeRequest {
  return {
    kind: 'invoke' as const,
    protocol: PROTOCOL_VERSION,
    actionId: ids.ACTION_PLACE_ORDER,
    arguments: { [ids.PARAM_PRODUCT]: 'bolt', [ids.PARAM_QUANTITY]: quantity },
    credential,
    requestId,
  };
}

/**
 * A transport that attaches a credential, the way a real one attaches an auth header. The
 * gateway deliberately has no credential of its own: who the caller is belongs to the
 * transport, not to the semantic request.
 */
function transportAs(
  server: Awaited<ReturnType<typeof authority>>,
  credential: string,
): TransportAdapter {
  const direct = createDirectTransport(server);
  return { send: (request) => direct.send({ ...request, credential }) };
}

function stockOf(server: Awaited<ReturnType<typeof authority>>): number {
  return (server.getState(ids.STATE_PRODUCTS) as Array<Record<string, number>>).find(
    (product) => (product[ids.F_PRODUCT_ID] as unknown as string) === 'bolt',
  )?.[ids.F_PRODUCT_STOCK] as number;
}

// -------------------------------------------------- the client half

test('two clients on identical deterministic hosts never generate the same request id', async () => {
  // The memory host's uuid is a counter, so both clients see the very same sequence. That is
  // exactly the situation in which 0.6.0 collided: same IR, same action, same ordinal.
  const server = await authority();
  const gateway = createRemoteGateway(transportAs(server, 'clerk'));
  const seen: GatewayRequest[] = [];
  const recording = {
    invoke: async (request: GatewayRequest) => {
      seen.push(request);
      return gateway.invoke(request);
    },
  };

  const ir = compileToIR(createOrderServerGraph());
  const clients = [createMemoryHost(), createMemoryHost()].map((host) =>
    createAxiomRuntime({ ir, rootElement: host.root, host, remote: recording }),
  );
  for (const client of clients) {
    await client.start();
    await client.invokeActionAsync(ids.ACTION_PLACE_ORDER, {
      [ids.PARAM_PRODUCT]: 'bolt',
      [ids.PARAM_QUANTITY]: 1,
    });
  }

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].requestId, seen[1].requestId, 'each runtime has its own identity');
  assert.equal(stockOf(server), 8, 'both orders were executed; neither was mistaken for a replay');
});

test('one client retrying the same invocation reuses nothing it should not', async () => {
  const server = await authority();
  const gateway = createRemoteGateway(transportAs(server, 'clerk'));
  const seen: GatewayRequest[] = [];
  const host = createMemoryHost();
  const client = createAxiomRuntime({
    ir: compileToIR(createOrderServerGraph()),
    rootElement: host.root,
    host,
    remote: {
      invoke: async (request: GatewayRequest) => {
        seen.push(request);
        return gateway.invoke(request);
      },
    },
  });
  await client.start();

  // Two separate user actions are two requests, not a retry of one.
  const args = { [ids.PARAM_PRODUCT]: 'bolt', [ids.PARAM_QUANTITY]: 1 };
  await client.invokeActionAsync(ids.ACTION_PLACE_ORDER, args);
  await client.invokeActionAsync(ids.ACTION_PLACE_ORDER, args);
  assert.notEqual(seen[0].requestId, seen[1].requestId);
  assert.equal(stockOf(server), 8);
});

// -------------------------------------------------- the authority half

test('a legitimate retry is answered from the record, and mutates nothing twice', async () => {
  const server = await authority();
  const first = (await server.handle(order(2, 'clerk', 'r-1'))) as InvokeResponse;
  const retry = (await server.handle(order(2, 'clerk', 'r-1'))) as InvokeResponse;

  assert.equal(first.ok, true);
  assert.equal(first.replayed ?? false, false);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.changes, first.changes, 'the same semantic result, not a new one');
  assert.equal(stockOf(server), 8, 'stock moved once, not twice');
});

test('a request id is scoped to its principal, so no caller replays another caller', async () => {
  // Request ids are chosen by clients and are not secrets. If they were the whole key, one
  // caller guessing another's would be handed that caller's answer.
  const server = await authority();
  const mine = (await server.handle(order(2, 'clerk', 'shared-id'))) as InvokeResponse;
  const theirs = (await server.handle(order(3, 'other', 'shared-id'))) as InvokeResponse;

  assert.equal(mine.ok, true);
  assert.equal(theirs.replayed ?? false, false, 'a different principal is a different record');
  assert.equal(stockOf(server), 5, 'both executed: 10 − 2 − 3');
});

test('a principal replaying their own id is still a replay after another caller used it', async () => {
  const server = await authority();
  await server.handle(order(2, 'clerk', 'shared-id'));
  await server.handle(order(3, 'other', 'shared-id'));
  const again = (await server.handle(order(2, 'clerk', 'shared-id'))) as InvokeResponse;

  assert.equal(again.replayed, true);
  assert.equal(stockOf(server), 5, 'still 10 − 2 − 3');
});

// -------------------------------------------------- pending presentation

test('a control whose action is with the authority says so, and refuses a second press', async () => {
  // Double submission is the ordinary way a person creates two transactions when they meant
  // one, and the client is where it has to be stopped: by the time a second request reaches
  // the authority it is a legitimately different request.
  const server = await authority();
  const gateway = createRemoteGateway(transportAs(server, 'clerk'));
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const host = createMemoryHost();
  const client = createAxiomRuntime({
    ir: compileToIR(createOrderServerGraph()),
    rootElement: host.root,
    host,
    remote: {
      invoke: async (request: GatewayRequest) => {
        await held;
        return gateway.invoke(request);
      },
    },
  });
  await client.start();
  // The draft the form fills in. Filling it through the inputs is tested elsewhere; here it
  // only has to name a real product so the authority has something to refuse or accept.
  client.hydrateState(ids.STATE_DRAFT_PRODUCT, 'bolt');
  client.hydrateState(ids.STATE_DRAFT_QUANTITY, 1);

  const submit = () => findAll(host.root, (element) => element.tagName === 'form')[0];
  const button = () =>
    findAll(host.root, (element) => element.getAttribute('data-control') === ids.UI_PLACE)[0];

  assert.equal(button().getAttribute('disabled'), null);
  submit().dispatch('submit');

  assert.equal(button().getAttribute('aria-busy'), 'true');
  assert.equal(button().getAttribute('data-pending'), 'true');
  assert.equal(button().getAttribute('disabled'), 'true');

  // Pressing again while the answer is outstanding must not start a second transaction.
  submit().dispatch('submit');
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(button().getAttribute('aria-busy'), null, 'the control is usable again');
  const stock = (server.getState(ids.STATE_PRODUCTS) as Array<Record<string, number>>).find(
    (product) => (product[ids.F_PRODUCT_ID] as unknown as string) === 'bolt',
  );
  assert.equal(stock?.[ids.F_PRODUCT_STOCK], 9, 'one order was placed, not two');
});
