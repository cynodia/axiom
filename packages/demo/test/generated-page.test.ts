import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { compileToHtml, compileToServerIR } from '@cynodia/axiom-compiler';
import { MemoryDocument, MemoryElement, findAll, textOf } from '@cynodia/axiom-runtime';
import { createSqlitePersistence, serveAxiomApplication } from '@cynodia/axiom-server';
import { createOrderServerGraph, orderServerIds as ids } from '@cynodia/axiom-demo/order-server';

/**
 * The generated page, end to end, with no application JavaScript anywhere.
 *
 * This is the acceptance test for 0.6.1's headline defect: in 0.6.0 `compileToHtml` produced
 * a page that could render a server-authoritative application but could never talk to its
 * authority, so the application was inert. Everything below runs the emitted script exactly
 * as a browser would — real HTTP, real authority, real persistence — and the only code the
 * application author wrote is a graph.
 */

/** Enough of a browser for the emitted bootstrap: a root element and somewhere to put it. */
function browserGlobals(baseUrl: string) {
  const root = new MemoryElement('div');
  const document = Object.assign(new MemoryDocument(), {
    getElementById: (id: string) => (id === 'app' ? root : null),
  });
  return {
    root,
    globals: {
      document,
      location: { pathname: '/' },
      history: { pushState: () => undefined },
      addEventListener: () => undefined,
      confirm: () => true,
      console,
      // Relative URLs are the whole point of the same-origin default; a browser resolves
      // them against the page's origin, so the shim does the same.
      fetch: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
      setTimeout,
      clearTimeout,
      AbortController,
      // Browsers have these; a bare vm context does not.
      structuredClone,
      URL,
      Response,
      Headers,
    },
  };
}

/** Runs the page's module script and hands back what it left on the global object. */
function runPage(html: string, baseUrl: string) {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, 'the page carries exactly one module script');
  const { root, globals } = browserGlobals(baseUrl);
  const context = vm.createContext(globals);
  (context as { globalThis?: unknown }).globalThis = context;
  vm.runInContext(script[1], context);
  const app = (context as { __AXIOM_APP__?: Record<string, (...args: never[]) => never> })
    .__AXIOM_APP__ as unknown as {
    start(): Promise<void>;
    settled(): Promise<void>;
    authoritativeStateLoaded(): boolean;
    getState(id: string): unknown;
    invokeActionAsync(id: string, args: Record<string, unknown>): Promise<{ ok: boolean }>;
  };
  assert.ok(app, 'the page exposes its runtime');
  return { app, root };
}

/** Somewhere to keep a database file that outlives one authority. */
const scratch =
  process.env.CLAUDE_SCRATCHPAD ?? process.env.TMPDIR ?? '/tmp';

async function running(location = ':memory:') {
  const graph = createOrderServerGraph();
  const host = await serveAxiomApplication({
    serverIR: compileToServerIR(graph),
    page: compileToHtml(graph),
    persistence: await createSqlitePersistence({ location }),
    // The generated page carries no credential, because a credential is not part of a
    // graph. How a deployment establishes one is the host's business; this one treats every
    // caller as the same clerk, which is enough to exercise the wiring.
    authenticate: () => ({ [ids.F_USER_ID]: 'u1', [ids.F_USER_ROLE]: 'clerk' }),
  });
  return host;
}

test('the generated page is served, and its script wires itself to the authority', async () => {
  const host = await running();
  try {
    const page = await (await fetch(host.pageUrl)).text();
    assert.match(page, /<script type="module">/, 'the page came from the same process');
    assert.match(page, /createHttpRemoteGateway\(\{"endpoint":"\/axiom"\}\)/);
    assert.match(page, /remote: __axiomRemote/, 'the runtime is given the gateway');
  } finally {
    await host.close();
  }
});

test('the page loads authoritative state over HTTP before anyone touches it', async () => {
  const host = await running();
  try {
    const { app } = runPage(await (await fetch(host.pageUrl)).text(), host.pageUrl);

    // Before the authority answers, the client holds nothing: server state has no client
    // seed, and `start()` says so rather than pretending an empty collection is the truth.
    assert.equal(app.authoritativeStateLoaded(), false);
    assert.deepEqual(app.getState(ids.STATE_PRODUCTS), []);

    await app.start();

    assert.equal(app.authoritativeStateLoaded(), true);
    const products = app.getState(ids.STATE_PRODUCTS) as Array<Record<string, unknown>>;
    assert.equal(products.length, 2, 'the authority`s products, fetched by the generated page');
    assert.equal(products[0][ids.F_PRODUCT_STOCK], 10);
  } finally {
    await host.close();
  }
});

test('an action invoked from the page commits on the authority and comes back', async () => {
  const host = await running();
  try {
    const { app } = runPage(await (await fetch(host.pageUrl)).text(), host.pageUrl);
    await app.start();

    const result = await app.invokeActionAsync(ids.ACTION_PLACE_ORDER, {
      [ids.PARAM_PRODUCT]: 'bolt',
      [ids.PARAM_QUANTITY]: 3,
    });
    assert.equal(result.ok, true);

    // The authority is where it happened...
    const stock = (host.server.getState(ids.STATE_PRODUCTS) as Array<Record<string, number>>).find(
      (product) => (product[ids.F_PRODUCT_ID] as unknown as string) === 'bolt',
    );
    assert.equal(stock?.[ids.F_PRODUCT_STOCK], 7);

    // ...and the page shows it, because the response carried the changed states back.
    const client = (app.getState(ids.STATE_PRODUCTS) as Array<Record<string, number>>).find(
      (product) => (product[ids.F_PRODUCT_ID] as unknown as string) === 'bolt',
    );
    assert.equal(client?.[ids.F_PRODUCT_STOCK], 7);
  } finally {
    await host.close();
  }
});

test('a guard refused on the authority is refused for the page, and nothing moves', async () => {
  const host = await running();
  try {
    const { app } = runPage(await (await fetch(host.pageUrl)).text(), host.pageUrl);
    await app.start();

    const result = await app.invokeActionAsync(ids.ACTION_PLACE_ORDER, {
      [ids.PARAM_PRODUCT]: 'bolt',
      [ids.PARAM_QUANTITY]: 9999,
    });
    assert.equal(result.ok, false);
    const stock = (host.server.getState(ids.STATE_PRODUCTS) as Array<Record<string, number>>).find(
      (product) => (product[ids.F_PRODUCT_ID] as unknown as string) === 'bolt',
    );
    assert.equal(stock?.[ids.F_PRODUCT_STOCK], 10, 'the authority refused; nothing was written');
  } finally {
    await host.close();
  }
});

test('a parameterized form is filled and submitted from the page, and the authority executes it', async () => {
  const host = await running();
  try {
    const { app, root } = runPage(await (await fetch(host.pageUrl)).text(), host.pageUrl);
    await app.start();

    // Everything below is a person using the page: typing into controls the graph declared,
    // and submitting the form. No test-only invocation, no arguments assembled by hand.
    const control = (id: string) =>
      findAll(root, (element) => element.getAttribute('data-control') === id)[0];
    const product = control(ids.UI_PRODUCT_INPUT);
    product.value = 'bolt';
    product.dispatch('input');
    const quantity = control(ids.UI_QUANTITY_INPUT);
    quantity.value = '2';
    quantity.dispatch('input');

    findAll(root, (element) => element.tagName === 'form')[0].dispatch('submit');
    await app.settled();

    const stock = (host.server.getState(ids.STATE_PRODUCTS) as Array<Record<string, number>>).find(
      (entry) => (entry[ids.F_PRODUCT_ID] as unknown as string) === 'bolt',
    );
    assert.equal(stock?.[ids.F_PRODUCT_STOCK], 8, 'the authority applied the submitted order');
    const orders = host.server.getState(ids.STATE_ORDERS) as unknown[];
    assert.equal(orders.length, 1);
  } finally {
    await host.close();
  }
});

test('a refusal from the authority appears in the diagnostic node, and a success clears it', async () => {
  const host = await running();
  try {
    const { app, root } = runPage(await (await fetch(host.pageUrl)).text(), host.pageUrl);
    await app.start();

    const control = (id: string) =>
      findAll(root, (element) => element.getAttribute('data-control') === id)[0];
    const refusal = () =>
      findAll(root, (element) => element.getAttribute('data-node') === ids.UI_REFUSAL)[0];
    const submit = () => findAll(root, (element) => element.tagName === 'form')[0].dispatch('submit');

    control(ids.UI_PRODUCT_INPUT).value = 'bolt';
    control(ids.UI_PRODUCT_INPUT).dispatch('input');
    control(ids.UI_QUANTITY_INPUT).value = '9999';
    control(ids.UI_QUANTITY_INPUT).dispatch('input');
    submit();
    await app.settled();

    assert.equal(refusal().getAttribute('data-empty'), null, 'the region is not empty');
    assert.match(textOf(refusal()), /stock/i, "the authority's own words reach the page");

    // The same control, a quantity that is allowed: the refusal must not linger.
    control(ids.UI_QUANTITY_INPUT).value = '1';
    control(ids.UI_QUANTITY_INPUT).dispatch('input');
    submit();
    await app.settled();

    assert.equal(refusal().getAttribute('data-empty'), 'true', 'success cleared the refusal');
  } finally {
    await host.close();
  }
});

test('the authority restarts and the page loads exactly what was committed', async () => {
  const file = path.join(scratch, 'generated-page-restart.db');
  await rm(file, { force: true });
  const first = await running(file);
  try {
    const { app } = runPage(await (await fetch(first.pageUrl)).text(), first.pageUrl);
    await app.start();
    await app.invokeActionAsync(ids.ACTION_PLACE_ORDER, {
      [ids.PARAM_PRODUCT]: 'bolt',
      [ids.PARAM_QUANTITY]: 4,
    });
  } finally {
    await first.close();
  }

  const second = await running(file);
  try {
    const { app } = runPage(await (await fetch(second.pageUrl)).text(), second.pageUrl);
    await app.start();

    const stock = (app.getState(ids.STATE_PRODUCTS) as Array<Record<string, number>>).find(
      (entry) => (entry[ids.F_PRODUCT_ID] as unknown as string) === 'bolt',
    );
    assert.equal(stock?.[ids.F_PRODUCT_STOCK], 6, 'a new page, a new authority, the same state');
    assert.equal((app.getState(ids.STATE_ORDERS) as unknown[]).length, 1);
  } finally {
    await second.close();
    await rm(file, { force: true });
  }
});
