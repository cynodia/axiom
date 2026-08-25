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
  createMemoryPersistence,
  createServerHost,
  serveOverHttp,
} from '@cynodia/axiom-server';
import type { WebhookConfig, WebhookRequestInfo } from '@cynodia/axiom-server';
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('the reference graph validates with zero errors and zero warnings', () => {
  const result = validateGraph(createDeviceMonitorGraph());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('zero escape pressure: no timer, fetch, HTTP handler or SDK call in the graph source', () => {
  const here = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
  const source = readFileSync(path.join(here, '../src/device-monitor.ts'), 'utf8');
  for (const forbidden of ['setInterval(', 'setTimeout(', 'fetch(', "kind: 'native'", 'http.createServer']) {
    assert.ok(!source.includes(forbidden), `device-monitor.ts must not contain ${forbidden}`);
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
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host: createDeterministicServerHost({
      authenticate: () => ({ [ids.F_OPERATOR_ID]: 'op-1', [ids.F_OPERATOR_ROLE]: 'operator' }),
    }),
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
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
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host: createDeterministicServerHost(),
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
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
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host: createDeterministicServerHost(),
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
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
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host: createServerHost(),
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
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
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host: createServerHost(),
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
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
  const server = createAxiomServer({
    ir: compileToServerIR(createDeviceMonitorGraph()),
    host: createServerHost(),
    persistence: createMemoryPersistence(),
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: adapter },
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
