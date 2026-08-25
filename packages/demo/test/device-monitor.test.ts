import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateGraph } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createDeterministicServerHost,
  createFakeIntegrationAdapter,
  createMemoryBlobStore,
  createMemoryPersistence,
  createScriptedSubscriptionAdapter,
  createServerHost,
  serveOverHttp,
} from '@cynodia/axiom-server';
import type {
  BlobStorageAdapter,
  DeterministicServerHost,
  SubscriptionAdapter,
  SubscriptionScript,
  WebhookConfig,
  WebhookRequestInfo,
} from '@cynodia/axiom-server';
import { createDeviceMonitorGraph, deviceMonitorIds as ids } from '@cynodia/axiom-demo/device-monitor';

/**
 * The 0.8 reference application, spec §144's definition of done, demonstrated literally:
 *
 * - "Every five seconds, refresh device status from an external provider."
 * - "When the user asks to reboot the device, record the intent and execute an external
 *   reboot effect safely."
 * - "When the provider sends a verified status-change event, invoke the ordinary semantic
 *   update action."
 *
 * — with no application-specific timer, fetch call, HTTP handler, callback event code or
 * external SDK logic anywhere in the graph.
 */

/**
 * Moves the virtual clock forward in steps until the condition holds, letting the
 * microtasks each step queues settle in between. An `activate → schedule the next attempt`
 * chain is asynchronous, so one big `advance()` fires only the timers already due — this
 * is how a multi-step reconnect sequence is driven deterministically.
 */
async function advanceUntil(
  host: DeterministicServerHost,
  predicate: () => boolean,
  step = 1000,
  steps = 20,
): Promise<void> {
  for (let index = 0; index < steps && !predicate(); index += 1) {
    host.advance(step);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!predicate()) {
    throw new Error('the condition never held while the clock advanced');
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Every subscription and store the reference graph declares must have an adapter, or
 * `start()` refuses — which is exactly the gate spec 0.9 §17/§79 asks for. These build the
 * deterministic ones the tests below use.
 */
function subscriptionAdapters(
  host: Pick<DeterministicServerHost, 'scheduleOnce'>,
  script: SubscriptionScript = { entries: [] },
): Record<string, SubscriptionAdapter> {
  return {
    [ids.INTEGRATION_DEVICE_PROVIDER]: createScriptedSubscriptionAdapter(
      { [String(ids.SUBSCRIPTION_DEVICE_STATUS)]: script },
      host,
    ),
  };
}

function blobStores(store: BlobStorageAdapter = createMemoryBlobStore()): Record<string, BlobStorageAdapter> {
  return { [ids.STORAGE_DIAGNOSTICS]: store };
}

test('the reference graph validates with zero errors and zero warnings', () => {
  const result = validateGraph(createDeviceMonitorGraph());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('zero escape pressure: no timer, transport, client, filesystem or SDK call in the graph source', () => {
  // Spec 0.8 §69 and spec 0.9 §69, enforced against the file rather than asserted in prose.
  // Every one of these is infrastructure an adapter or the host supplies; a graph that names
  // one has stopped being portable, analyzable and deterministically testable.
  const here = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
  // Comments are stripped first: this file *names* the escapes it does not use, in the
  // header and beside the subscription, and a scan that could not tell prose from code
  // would forbid explaining the rule.
  const source = readFileSync(path.join(here, '../src/device-monitor.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const forbidden = [
    'setInterval(', 'setTimeout(', 'fetch(', "kind: 'native'", 'http.createServer',
    'new WebSocket', 'mqtt.', 'net.', 'fs.', 'readFile', 'writeFile', 'exec(', 'spawn(',
    'require(', 'node:', '.listen(', 'onmessage', 'addEventListener',
  ];
  for (const escape of forbidden) {
    assert.ok(!source.includes(escape), `device-monitor.ts must not contain ${escape}`);
  }
  // And nothing that looks like a transport address or a filesystem path.
  for (const pattern of [
    /wss?:\/\//,
    /mqtts?:\/\//,
    /https?:\/\//,
    /['"]\/(var|tmp|home|etc)\//,
    /\bexpress\b/,
  ]) {
    assert.ok(!pattern.test(source), `device-monitor.ts must not contain ${String(pattern)}`);
  }
});

test('"every five seconds, refresh device status from an external provider"', async () => {
  const statuses = new Map([
    ['dev-1', 'online'],
    ['dev-2', 'offline'],
  ]);
  let queries = 0;
  const adapter = createFakeIntegrationAdapter({
    query: () => {
      queries += 1;
      return {
        ok: true,
        value: [...statuses.entries()].map(([externalId, status]) => ({
          [ids.F_RESULT_EXTERNAL_ID]: externalId,
          [ids.F_RESULT_STATUS]: status,
        })),
      };
    },
  });
  const host = createDeterministicServerHost();
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
    subscriptions: subscriptionAdapters(host),
    blobStores: blobStores(),
  });
  await server.start();

  const before = server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>;
  assert.ok(before.every((device) => device[ids.F_DEVICE_STATUS] === 'unknown'));

  const statusOf = (externalId: string): unknown =>
    (server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>).find(
      (d) => d[ids.F_DEVICE_EXTERNAL_ID] === externalId,
    )?.[ids.F_DEVICE_STATUS];

  host.advance(5000);
  await waitUntil(() => statusOf('dev-1') === 'online' && statusOf('dev-2') === 'offline');
  assert.equal(queries, 1);

  statuses.set('dev-2', 'online');
  host.advance(5000);
  await waitUntil(() => statusOf('dev-2') === 'online');
  assert.equal(queries, 2);

  await server.stop();
});

test('"when the user asks to reboot the device, record the intent and execute an external reboot effect safely"', async () => {
  const rebooted: string[] = [];
  const adapter = createFakeIntegrationAdapter({
    effect: (operation, args) => {
      rebooted.push(String(args[ids.PARAM_OP_EXTERNAL_ID]));
      return { ok: true, value: `rebooted ${String(args[ids.PARAM_OP_EXTERNAL_ID])}` };
    },
  });
  const host = createDeterministicServerHost({
    authenticate: () => ({ [ids.F_OPERATOR_ID]: 'op-1', [ids.F_OPERATOR_ROLE]: 'operator' }),
  });
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
    subscriptions: subscriptionAdapters(host),
    blobStores: blobStores(),
  });
  await server.start();

  const response = await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_REBOOT_DEVICE,
    arguments: { [ids.PARAM_EXTERNAL_ID]: 'dev-1' },
    credential: 'op-1',
  });
  // Committed, effect pending: the response never waits for the adapter.
  assert.equal((response as { ok: boolean }).ok, true);

  await waitUntil(() => rebooted.includes('dev-1'));
  await waitUntil(() => server.getState(ids.STATE_LAST_EFFECT_MESSAGE) === 'Rebooted: rebooted dev-1');
  await server.stop();
});

test('"when the provider sends a verified status-change event, invoke the ordinary semantic update action"', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const host = createDeterministicServerHost();
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
    subscriptions: subscriptionAdapters(host),
    blobStores: blobStores(),
  });
  await server.start();

  // "Verified" happens at the host/webhook boundary (see docs/EVENTS.md); by the time an
  // EventRequest reaches the semantic layer, verification has already happened.
  const response = await server.handle({
    kind: 'event',
    protocol: 'axiom.protocol.v1',
    eventId: ids.EVENT_DEVICE_STATUS_CHANGED,
    payload: { [ids.F_CHANGE_EXTERNAL_ID]: 'dev-1', [ids.F_CHANGE_STATUS]: 'online' },
  });
  assert.equal((response as { ok: boolean }).ok, true);

  const devices = server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>;
  assert.equal(devices.find((d) => d[ids.F_DEVICE_EXTERNAL_ID] === 'dev-1')?.[ids.F_DEVICE_STATUS], 'online');
  await server.stop();
});

test('a malformed status-change payload never reaches the update action', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const host = createDeterministicServerHost();
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
    subscriptions: subscriptionAdapters(host),
    blobStores: blobStores(),
  });
  await server.start();

  const response = await server.handle({
    kind: 'event',
    protocol: 'axiom.protocol.v1',
    eventId: ids.EVENT_DEVICE_STATUS_CHANGED,
    payload: 'not-a-record',
  });
  assert.equal((response as { ok: boolean }).ok, false);

  const devices = server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>;
  assert.ok(devices.every((device) => device[ids.F_DEVICE_STATUS] === 'unknown'));
  await server.stop();
});

// --------------------------------------------- webhook delivery, over real HTTP (spec 8.1 §10)

const WEBHOOK_SECRET = 'shared-secret';
const WEBHOOK_PATH = '/webhooks/device-provider';

function deviceProviderWebhook(): WebhookConfig {
  return {
    verify: (request: WebhookRequestInfo) => request.headers['x-webhook-secret'] === WEBHOOK_SECRET,
    decode: (request: WebhookRequestInfo) => {
      const body = JSON.parse(request.rawBody.toString('utf8')) as { externalId: string; status: string };
      return {
        eventId: ids.EVENT_DEVICE_STATUS_CHANGED,
        payload: { [ids.F_CHANGE_EXTERNAL_ID]: body.externalId, [ids.F_CHANGE_STATUS]: body.status },
      };
    },
  };
}

test('a valid signed webhook is accepted, dispatches the event and updates state (spec §10.A)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const host = createServerHost();
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
    subscriptions: subscriptionAdapters(host),
    blobStores: blobStores(),
  });
  const running = await serveOverHttp({ server, port: 0, webhooks: { [WEBHOOK_PATH]: deviceProviderWebhook() } });
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify({ externalId: 'dev-1', status: 'online' }),
    });
    assert.equal(response.status, 200);

    const devices = server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>;
    assert.equal(devices.find((d) => d[ids.F_DEVICE_EXTERNAL_ID] === 'dev-1')?.[ids.F_DEVICE_STATUS], 'online');
  } finally {
    await running.close();
  }
});

test('an invalid webhook is rejected before any event is dispatched (spec §10.B)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const host = createServerHost();
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
    subscriptions: subscriptionAdapters(host),
    blobStores: blobStores(),
  });
  const running = await serveOverHttp({ server, port: 0, webhooks: { [WEBHOOK_PATH]: deviceProviderWebhook() } });
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'wrong-secret' },
      body: JSON.stringify({ externalId: 'dev-1', status: 'online' }),
    });
    assert.equal(response.status, 401);

    const devices = server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>;
    assert.ok(devices.every((device) => device[ids.F_DEVICE_STATUS] === 'unknown'), 'the forged delivery never reached the event pipeline');
  } finally {
    await running.close();
  }
});

test('an anonymous client cannot invoke the webhook-only action directly, over real HTTP (spec §10.C)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const host = createServerHost();
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
    subscriptions: subscriptionAdapters(host),
    blobStores: blobStores(),
  });
  const running = await serveOverHttp({ server, port: 0 });
  try {
    const response = await fetch(running.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'invoke',
        protocol: 'axiom.protocol.v1',
        actionId: ids.ACTION_APPLY_STATUS_CHANGE,
        arguments: { [ids.PARAM_CHANGE_EXTERNAL_ID]: 'dev-1', [ids.PARAM_CHANGE_STATUS]: 'online' },
      }),
    });
    const body = (await response.json()) as { ok: boolean; diagnostics: Array<{ code: string }> };
    assert.equal(body.ok, false);
    assert.equal(body.diagnostics[0]?.code, 'INVOCATION_SOURCE_NOT_ALLOWED');

    const devices = server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>;
    assert.ok(devices.every((device) => device[ids.F_DEVICE_STATUS] === 'unknown'), 'the forged request never committed');
  } finally {
    await running.close();
  }
});

// ====================================================================== 0.9: subscriptions
//
// Spec 0.9 §68: the third external-interaction direction, demonstrated on the same graph
// that already demonstrates query and effect. Every scenario below runs against a scripted
// adapter and a virtual clock — no network, no broker, no wall-clock wait.

function statusOf(server: { getState(id: string): unknown }, externalId: string): unknown {
  return (server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>).find(
    (device) => device[ids.F_DEVICE_EXTERNAL_ID] === externalId,
  )?.[ids.F_DEVICE_STATUS];
}

function change(externalId: string, status: string, deliveryId?: string): Record<string, unknown> {
  return {
    [ids.F_CHANGE_EXTERNAL_ID]: externalId,
    [ids.F_CHANGE_STATUS]: status,
    ...(deliveryId !== undefined ? { [ids.F_CHANGE_DELIVERY_ID]: deliveryId } : {}),
  };
}

async function runningMonitor(options: {
  script?: SubscriptionScript;
  persistence?: ReturnType<typeof createMemoryPersistence>;
  store?: BlobStorageAdapter;
} = {}) {
  const host = createDeterministicServerHost({
    // Credential-sensitive, so a test can present an operator, a viewer or nobody and get
    // three genuinely different callers rather than the same one three times.
    authenticate: (credential) =>
      credential === 'op-1'
        ? { [ids.F_OPERATOR_ID]: 'op-1', [ids.F_OPERATOR_ROLE]: 'operator' }
        : credential === 'viewer'
          ? { [ids.F_OPERATOR_ID]: 'v-1', [ids.F_OPERATOR_ROLE]: 'viewer' }
          : null,
  });
  const subscriptions = subscriptionAdapters(host, options.script ?? { entries: [] });
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: options.persistence ?? createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: createFakeIntegrationAdapter({}) },
    subscriptions,
    blobStores: blobStores(options.store ?? createMemoryBlobStore()),
  });
  await server.start();
  return { host, server, subscriptions };
}

test('a subscription becomes active at startup, with no application code starting it', async () => {
  const { server } = await runningMonitor();
  const status = server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS);
  assert.equal(status?.state, 'active');
  assert.equal(status?.source, 'device-status');
  assert.equal(status?.received, 0);
  await server.stop();
});

test('a live delivery becomes an event, a system action and authoritative state', async () => {
  const { host, server } = await runningMonitor({
    script: { entries: [{ kind: 'deliver', payload: change('dev-1', 'online', 'd1') }] },
  });
  host.advance(1);
  await waitUntil(() => statusOf(server, 'dev-1') === 'online');

  const status = server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS);
  assert.equal(status?.applied, 1);
  assert.equal(status?.rejected, 0);
  await server.stop();
});

test('the same external event delivered twice mutates state once', async () => {
  const { host, server } = await runningMonitor({
    script: {
      entries: [
        { kind: 'deliver', payload: change('dev-1', 'online', 'delivery-7') },
        { kind: 'deliver', afterMs: 10, payload: change('dev-1', 'offline', 'delivery-7') },
      ],
    },
  });
  host.advance(20);
  await waitUntil(() => statusOf(server, 'dev-1') === 'online');
  await waitUntil(() => (server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.rejected ?? 0) > 0);

  // The second delivery carried a different status. Deduplication is what keeps it from
  // being applied — not ordering, and not luck.
  assert.equal(statusOf(server, 'dev-1'), 'online');
  assert.equal(server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.applied, 1);
  await server.stop();
});

test('deduplication survives a restart, because the delivery record is durable', async () => {
  const persistence = createMemoryPersistence();
  const first = await runningMonitor({
    persistence,
    script: { entries: [{ kind: 'deliver', payload: change('dev-1', 'online', 'delivery-9') }] },
  });
  first.host.advance(1);
  await waitUntil(() => statusOf(first.server, 'dev-1') === 'online');
  await first.server.stop();

  // A new process, the same durable store, and the provider redelivering what it still
  // holds. An in-memory-only window would have forgotten it.
  const second = await runningMonitor({
    persistence,
    script: { entries: [{ kind: 'deliver', payload: change('dev-1', 'offline', 'delivery-9') }] },
  });
  second.host.advance(1);
  await waitUntil(() => (second.server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.rejected ?? 0) > 0);
  assert.equal(statusOf(second.server, 'dev-1'), 'online', 'the redelivery was not applied a second time');
  assert.equal(second.server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.applied, 0);
  await second.server.stop();
});

test('deliveries of one subscription are applied sequentially, in accepted order', async () => {
  const { host, server } = await runningMonitor({
    script: {
      entries: [
        { kind: 'deliver', afterMs: 1, payload: change('dev-1', 'online', 'a') },
        { kind: 'deliver', afterMs: 2, payload: change('dev-1', 'offline', 'b') },
        { kind: 'deliver', afterMs: 3, payload: change('dev-1', 'online', 'c') },
      ],
    },
  });
  host.advance(10);
  await waitUntil(() => (server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.applied ?? 0) === 3);

  // Last write wins because they were applied in order, one transaction each.
  assert.equal(statusOf(server, 'dev-1'), 'online');
  const transactions = new Set(
    server.mutationLog().filter((entry) => entry.outcome === 'committed').map((entry) => entry.transactionId),
  );
  assert.ok(transactions.size >= 3, 'each delivery committed in a transaction of its own');
  await server.stop();
});

test('a malformed live payload is rejected before any mutation, and reported', async () => {
  const { host, server } = await runningMonitor({
    script: {
      entries: [
        { kind: 'deliver', payload: 'not-a-record' },
        { kind: 'deliver', afterMs: 5, payload: change('dev-1', 'online', 'ok') },
      ],
    },
  });
  host.advance(10);
  await waitUntil(() => statusOf(server, 'dev-1') === 'online');

  const status = server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS);
  assert.equal(status?.rejected, 1, 'the malformed payload was refused');
  assert.equal(status?.applied, 1, 'and the valid one that followed still applied');
  assert.equal(status?.lastFailure?.code, 'EVENT_PAYLOAD_INVALID');
  await server.stop();
});

test('a lost connection reconnects under the graph-declared policy, and reports it', async () => {
  const { host, server, subscriptions } = await runningMonitor({
    script: {
      entries: [
        // Only on the first connection; the reconnect that follows is a clean one.
        { kind: 'disconnect', afterMs: 1, attempt: 1 },
        { kind: 'deliver', afterMs: 5, attempt: 2, payload: change('dev-2', 'offline', 'after-reconnect') },
      ],
    },
  });
  assert.equal(server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.state, 'active');

  host.advance(1);
  await waitUntil(() => server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.state === 'reconnecting');
  // 500ms is the graph's declared first backoff; reconnect policy is Axiom's, not the
  // adapter's, so the adapter never chose this delay.
  host.advance(500);
  await waitUntil(() => server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.state === 'active');

  const adapter = subscriptions[ids.INTEGRATION_DEVICE_PROVIDER] as ReturnType<
    typeof createScriptedSubscriptionAdapter
  >;
  assert.equal(adapter.attempts(ids.SUBSCRIPTION_DEVICE_STATUS), 2);

  host.advance(10);
  await waitUntil(() => statusOf(server, 'dev-2') === 'offline');
  await server.stop();
});

test('a source that never connects leaves the application running and the subscription failed', async () => {
  const { host, server } = await runningMonitor({
    script: {
      entries: [
        { kind: 'connect-failure' },
        { kind: 'connect-failure' },
        { kind: 'connect-failure' },
        { kind: 'connect-failure' },
      ],
    },
  });
  // `lifecycle.required` is false, so startup succeeded. Degraded, and observably so.
  await advanceUntil(host, () => server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.state === 'failed');

  const status = server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS);
  assert.equal(status?.lastFailure?.code, 'SUBSCRIPTION_START_FAILED');
  // The rest of the application is unaffected: the polling trigger still commits.
  const response = await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_REBOOT_DEVICE,
    arguments: { [ids.PARAM_EXTERNAL_ID]: 'dev-1' },
    credential: 'op-1',
  });
  assert.equal((response as { ok: boolean }).ok, true);
  await server.stop();
});

test('no delivery reaches application state after the server has closed', async () => {
  const { host, server } = await runningMonitor({
    script: {
      entries: [
        { kind: 'deliver', afterMs: 1, payload: change('dev-1', 'online', 'before') },
        { kind: 'deliver', afterMs: 1000, payload: change('dev-2', 'offline', 'after') },
      ],
    },
  });
  host.advance(1);
  await waitUntil(() => statusOf(server, 'dev-1') === 'online');

  await server.stop();
  assert.equal(server.subscriptionStatus(ids.SUBSCRIPTION_DEVICE_STATUS)?.state, 'stopped');

  // The scripted delivery that was still due now fires against a stopped runtime.
  host.advance(2000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(statusOf(server, 'dev-2'), 'unknown', 'a post-close delivery changed nothing');
});

test('a client cannot forge a subscription delivery or invoke the subscription-only action', async () => {
  const { server } = await runningMonitor();
  const forged = await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_APPLY_STATUS_CHANGE,
    arguments: { [ids.PARAM_CHANGE_EXTERNAL_ID]: 'dev-1', [ids.PARAM_CHANGE_STATUS]: 'online' },
  });
  const body = forged as { ok: boolean; diagnostics: Array<{ code: string }> };
  assert.equal(body.ok, false);
  assert.equal(body.diagnostics[0]?.code, 'INVOCATION_SOURCE_NOT_ALLOWED');
  assert.equal(statusOf(server, 'dev-1'), 'unknown');
  await server.stop();
});

// ========================================================================= 0.9: blobs

const LOG_BYTES = new TextEncoder().encode('boot ok\nsensor calibrated\n');

async function upload(
  server: Awaited<ReturnType<typeof runningMonitor>>['server'],
  principal: Record<string, unknown> | null,
) {
  return server.stageBlob(ids.STORAGE_DIAGNOSTICS, principal as never, {
    data: LOG_BYTES,
    mediaType: 'text/plain',
    filename: 'dev-1.log',
  });
}

const OPERATOR = { [ids.F_OPERATOR_ID]: 'op-1', [ids.F_OPERATOR_ROLE]: 'operator' };
const VIEWER = { [ids.F_OPERATOR_ID]: 'v-1', [ids.F_OPERATOR_ROLE]: 'viewer' };

test('an upload becomes a BlobRef, an action argument and authoritative state', async () => {
  const { server } = await runningMonitor();
  const staged = await upload(server, OPERATOR);
  assert.equal(staged.ok, true);
  const ref = (staged as { ok: true; ref: Record<string, unknown> }).ref;

  // Exactly the public contract: key, media type, size, filename, checksum. No bucket, no
  // path, no provider identifier, no lifecycle bookkeeping.
  assert.deepEqual(
    Object.keys(ref).sort(),
    ['field_blob_checksum', 'field_blob_filename', 'field_blob_key', 'field_blob_media_type', 'field_blob_size'],
  );
  assert.equal(ref.field_blob_size, LOG_BYTES.byteLength);

  const response = await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_ATTACH_DIAGNOSTIC_LOG,
    arguments: { [ids.PARAM_LOG_DEVICE_ID]: 'dev-1', [ids.PARAM_LOG_BLOB]: ref },
    credential: 'op-1',
  });
  assert.equal((response as { ok: boolean }).ok, true);

  const device = (server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>).find(
    (d) => d[ids.F_DEVICE_EXTERNAL_ID] === 'dev-1',
  );
  assert.deepEqual(device?.[ids.F_DEVICE_LOG], ref);
  await waitUntil(() => server.blobLog().some((entry) => entry.status === 'succeeded'));
  await server.stop();
});

test('a stored blob is never bytes in state, the graph or the Server IR', async () => {
  // Structural proof, spec 0.9 §61: the reference is a fixed handful of scalars whatever
  // the object's size, so a large attachment cannot reach any of the three.
  const { server } = await runningMonitor();
  const huge = new Uint8Array(5 * 1024 * 1024);
  const staged = await server.stageBlob(ids.STORAGE_DIAGNOSTICS, OPERATOR as never, {
    data: huge,
    mediaType: 'text/plain',
    filename: 'big.log',
  });
  const ref = (staged as { ok: true; ref: Record<string, unknown> }).ref;
  await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_ATTACH_DIAGNOSTIC_LOG,
    arguments: { [ids.PARAM_LOG_DEVICE_ID]: 'dev-1', [ids.PARAM_LOG_BLOB]: ref },
    credential: 'op-1',
  });

  const stateSize = JSON.stringify(server.getState(ids.STATE_DEVICES)).length;
  assert.ok(stateSize < 2000, `state carrying a 5MB attachment is ${stateSize} bytes`);
  const irSize = JSON.stringify(compileToServerIR(createDeviceMonitorGraph())).length;
  assert.ok(irSize < 200_000 && !JSON.stringify(server.getState(ids.STATE_DEVICES)).includes('AAAA'));
  await server.stop();
});

test('possession of a BlobRef is not permission: a guessed key is refused', async () => {
  const { server } = await runningMonitor();
  const staged = await upload(server, OPERATOR);
  const ref = (staged as { ok: true; ref: Record<string, unknown> }).ref;

  // Never attached to any device, so the store's read rule finds nothing referencing it —
  // even though the caller holds the real key, and even for an operator.
  const denied = await server.authorizeBlobRead(ids.STORAGE_DIAGNOSTICS, String(ref.field_blob_key), OPERATOR as never);
  assert.equal(denied.ok, false);
  assert.equal((denied as { ok: false; diagnostic: { code: string } }).diagnostic.code, 'BLOB_ACCESS_DENIED');

  // A key that names nothing at all is answered identically, so the endpoint is not an
  // oracle for enumerating keys.
  const invented = await server.authorizeBlobRead(ids.STORAGE_DIAGNOSTICS, 'blob-guessed', OPERATOR as never);
  assert.equal(invented.ok, false);
  await server.stop();
});

test('an attached blob is readable, and a viewer may not upload one', async () => {
  const { server } = await runningMonitor();
  const staged = await upload(server, OPERATOR);
  const ref = (staged as { ok: true; ref: Record<string, unknown> }).ref;
  await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_ATTACH_DIAGNOSTIC_LOG,
    arguments: { [ids.PARAM_LOG_DEVICE_ID]: 'dev-1', [ids.PARAM_LOG_BLOB]: ref },
    credential: 'op-1',
  });

  const allowed = await server.authorizeBlobRead(
    ids.STORAGE_DIAGNOSTICS,
    String(ref.field_blob_key),
    VIEWER as never,
  );
  assert.equal(allowed.ok, true, 'a referenced object is readable');

  const refused = await server.authorizeBlobUpload(ids.STORAGE_DIAGNOSTICS, VIEWER as never, {
    mediaType: 'text/plain',
    size: 10,
  });
  assert.equal(refused.ok, false, 'a viewer may not upload');
  await server.stop();
});

test('an upload the store does not accept is refused before a byte is stored', async () => {
  const { server } = await runningMonitor();
  const wrongType = await server.authorizeBlobUpload(ids.STORAGE_DIAGNOSTICS, OPERATOR as never, {
    mediaType: 'image/png',
    size: 10,
  });
  assert.equal((wrongType as { ok: false; diagnostic: { code: string } }).diagnostic.code, 'BLOB_MEDIA_TYPE_REJECTED');

  const tooBig = await server.authorizeBlobUpload(ids.STORAGE_DIAGNOSTICS, OPERATOR as never, {
    mediaType: 'text/plain',
    size: 64 * 1024 * 1024,
  });
  assert.equal((tooBig as { ok: false; diagnostic: { code: string } }).diagnostic.code, 'BLOB_TOO_LARGE');
  await server.stop();
});

test('a refused transaction commits no blob, leaving the upload staged rather than orphaning state', async () => {
  const store = createMemoryBlobStore();
  const { server } = await runningMonitor({ store });
  const staged = await upload(server, OPERATOR);
  const ref = (staged as { ok: true; ref: Record<string, unknown> }).ref;

  // The action is refused — a viewer may not attach. The blob-commit intent is discarded
  // with every other effect of the rolled-back transaction.
  const refused = await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_ATTACH_DIAGNOSTIC_LOG,
    arguments: { [ids.PARAM_LOG_DEVICE_ID]: 'dev-1', [ids.PARAM_LOG_BLOB]: ref },
    credential: null,
  });
  assert.equal((refused as { ok: boolean }).ok, false);
  assert.deepEqual(server.blobLog(), [], 'no storage effect was dispatched');

  const stillStaged = await store.listStaged?.();
  assert.equal(stillStaged?.length, 1, 'the upload is a sweepable staged object, not a committed orphan');
  assert.equal(stillStaged?.[0]?.lifecycle, 'staged');
  await server.stop();
});

test('detaching removes the reference first and the object after, both observably', async () => {
  const store = createMemoryBlobStore();
  const { server } = await runningMonitor({ store });
  const staged = await upload(server, OPERATOR);
  const ref = (staged as { ok: true; ref: Record<string, unknown> }).ref;
  await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_ATTACH_DIAGNOSTIC_LOG,
    arguments: { [ids.PARAM_LOG_DEVICE_ID]: 'dev-1', [ids.PARAM_LOG_BLOB]: ref },
    credential: 'op-1',
  });
  await waitUntil(() => server.blobLog().some((entry) => entry.status === 'succeeded'));

  const detached = await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_DETACH_DIAGNOSTIC_LOG,
    arguments: { [ids.PARAM_DETACH_DEVICE_ID]: 'dev-1' },
    credential: 'op-1',
  });
  assert.equal((detached as { ok: boolean }).ok, true);

  const device = (server.getState(ids.STATE_DEVICES) as Array<Record<string, unknown>>).find(
    (d) => d[ids.F_DEVICE_EXTERNAL_ID] === 'dev-1',
  );
  assert.equal(device?.[ids.F_DEVICE_LOG], null, 'state is correct immediately');
  await waitUntil(() => server.blobLog().filter((entry) => entry.status === 'succeeded').length === 2);
  assert.equal((await store.metadata(String(ref.field_blob_key))).ok, false, 'and the object is gone after');
  await server.stop();
});

test('a failed external deletion leaves state correct and the orphan visible', async () => {
  const store = createMemoryBlobStore({
    failOn: { delete: { ok: false, code: 'STORE_UNAVAILABLE', message: 'the store is down', retryable: false } },
  });
  const { server } = await runningMonitor({ store });
  const staged = await upload(server, OPERATOR);
  const ref = (staged as { ok: true; ref: Record<string, unknown> }).ref;
  await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_ATTACH_DIAGNOSTIC_LOG,
    arguments: { [ids.PARAM_LOG_DEVICE_ID]: 'dev-1', [ids.PARAM_LOG_BLOB]: ref },
    credential: 'op-1',
  });
  await waitUntil(() => server.blobLog().some((entry) => entry.status === 'succeeded'));

  const detached = await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ids.ACTION_DETACH_DIAGNOSTIC_LOG,
    arguments: { [ids.PARAM_DETACH_DEVICE_ID]: 'dev-1' },
    credential: 'op-1',
  });
  // State correctness and external cleanup are separate: the transaction committed.
  assert.equal((detached as { ok: boolean }).ok, true);
  await waitUntil(() => server.blobLog().some((entry) => entry.status === 'failed'));

  const failure = server.blobLog().find((entry) => entry.status === 'failed');
  assert.equal(failure?.storage?.operation, 'delete');
  assert.equal(failure?.lastError?.code, 'STORE_UNAVAILABLE');
  // Nothing pretended the deletion happened, and nothing rolled the state back to a device
  // still referencing an object the application has decided to be rid of.
  assert.equal((await store.metadata(String(ref.field_blob_key))).ok, true);
  await server.stop();
});

// ------------------------------------------- the blob transport, over real HTTP (spec 0.9 §50-51)
//
// The upload and download endpoints exist once, for every Axiom application. These run them
// over an actual socket rather than through the in-process API, because that is where a
// header, a status code and a body either behave or do not.

test('upload and download work over HTTP with no application-authored route', async () => {
  const store = createMemoryBlobStore();
  const host = createServerHost({
    authenticate: (credential) =>
      credential === 'op-1'
        ? { [ids.F_OPERATOR_ID]: 'op-1', [ids.F_OPERATOR_ROLE]: 'operator' }
        : credential === 'viewer'
          ? { [ids.F_OPERATOR_ID]: 'v-1', [ids.F_OPERATOR_ROLE]: 'viewer' }
          : null,
  });
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host,
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: createFakeIntegrationAdapter({}) },
    subscriptions: subscriptionAdapters(host as never),
    blobStores: blobStores(store),
  });
  const running = await serveOverHttp({
    server,
    port: 0,
    blobStores: blobStores(store),
    authenticate: (credential) =>
      credential === 'op-1'
        ? { [ids.F_OPERATOR_ID]: 'op-1', [ids.F_OPERATOR_ROLE]: 'operator' }
        : credential === 'viewer'
          ? { [ids.F_OPERATOR_ID]: 'v-1', [ids.F_OPERATOR_ROLE]: 'viewer' }
          : null,
  });
  const base = `http://127.0.0.1:${running.port}/axiom/blob/${ids.STORAGE_DIAGNOSTICS}`;
  try {
    // A viewer may not upload. Refused before a byte is stored, by the store's own rule.
    const refused = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: 'Bearer viewer' },
      body: 'boot ok\n',
    });
    assert.equal(refused.status, 403);

    const uploaded = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: 'Bearer op-1', 'x-axiom-filename': 'dev-1.log' },
      body: 'boot ok\n',
    });
    assert.equal(uploaded.status, 200);
    const { ref } = (await uploaded.json()) as { ref: Record<string, unknown> };
    const key = String(ref.field_blob_key);

    // Not attached yet, so nothing references it — a real key, and still refused.
    assert.equal((await fetch(`${base}/${key}`, { headers: { authorization: 'Bearer op-1' } })).status, 403);

    await server.handle({
      kind: 'invoke',
      protocol: 'axiom.protocol.v1',
      actionId: ids.ACTION_ATTACH_DIAGNOSTIC_LOG,
      arguments: { [ids.PARAM_LOG_DEVICE_ID]: 'dev-1', [ids.PARAM_LOG_BLOB]: ref },
      credential: 'op-1',
    });

    const download = await fetch(`${base}/${key}`, { headers: { authorization: 'Bearer op-1' } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'text/plain');
    assert.match(download.headers.get('content-disposition') ?? '', /filename="dev-1\.log"/);
    assert.equal(await download.text(), 'boot ok\n');

    // A guessed key is answered exactly as an unauthorized real one, so the endpoint is not
    // an oracle for discovering which keys exist.
    const guessed = await fetch(`${base}/blob-does-not-exist`, { headers: { authorization: 'Bearer op-1' } });
    assert.equal(guessed.status, 403);
  } finally {
    await running.close();
  }
});
