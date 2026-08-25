import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationGraph, binary, literal, nodeId, primitiveType, ref, stateLocation } from '@cynodia/axiom-core';
import type { ActionDef, IntegrationDef, IntegrationOperationDef, StateDef, TriggerDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createDeterministicServerHost,
  createFakeIntegrationAdapter,
  createMemoryPersistence,
  createServerHost,
} from '@cynodia/axiom-server';
import type { AxiomServer, IntegrationResult, ServerEvent } from '@cynodia/axiom-server';

/**
 * Spec 8.1 §15-25: a non-cooperating adapter must not wedge the semantic invocation, or by
 * extension a polling trigger, forever — the runtime enforces `timeoutMs` itself.
 *
 * Spec 8.1 §26-30: the deterministic host must agree with the real host for simultaneous
 * same-period triggers, not merely tolerate them differently.
 */

const STATE_STATUS = nodeId('state_status_08_1_timeout');
const INTEGRATION = nodeId('integration_provider_08_1_timeout');
const OP_FETCH = nodeId('integration_operation_fetch_08_1_timeout');
const ACTION_REFRESH = nodeId('action_refresh_08_1_timeout');
const SCOPE_QUERY = nodeId('scope_query_08_1_timeout');
const TRIGGER_INTERVAL = nodeId('trigger_interval_08_1_timeout');

function buildGraph(timeoutMs: number | undefined, everyMs = 5000): ApplicationGraph {
  const graph = new ApplicationGraph('timeout', 'Timeout');
  graph.addNode<StateDef>({
    id: STATE_STATUS,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('string'),
    initialValue: 'unknown',
  });
  graph.addNode<IntegrationDef>({ id: INTEGRATION, kind: 'integration', name: 'Provider' });
  graph.addNode<IntegrationOperationDef>({
    id: OP_FETCH,
    kind: 'integration-operation',
    integrationId: INTEGRATION,
    name: 'fetchStatus',
    mode: 'query',
    resultType: primitiveType('string'),
  });
  graph.addNode<ActionDef>({
    id: ACTION_REFRESH,
    kind: 'action',
    operations: [
      {
        kind: 'integration-query',
        operationId: OP_FETCH,
        bindAs: SCOPE_QUERY,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      { kind: 'set', target: stateLocation(STATE_STATUS), value: ref(SCOPE_QUERY) },
    ],
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_INTERVAL,
    kind: 'trigger',
    actionId: ACTION_REFRESH,
    when: { kind: 'interval', everyMs, overlap: 'skip' },
  });
  return graph;
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
 * Yields one real macrotask turn, which drains every pending microtask first. Calling
 * `server.handle(...)` (or a host timer firing) only *queues* its body as a microtask via
 * `serialize`; nothing inside it touches a real timer before it registers its own
 * `host.scheduleOnce` deadline, so one macrotask turn is always enough for that
 * registration to have happened before the next `host.advance(...)` call — without this,
 * `advance` would run before the deadline it is meant to trigger even exists.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hangingAdapter(): ReturnType<typeof createFakeIntegrationAdapter> {
  return createFakeIntegrationAdapter({ query: () => new Promise<IntegrationResult>(() => undefined) });
}

// ------------------------------------------------------------------- timeout

test('a hung query times out on the deterministic clock, with no real wait', async () => {
  const ir = compileToServerIR(buildGraph(1000));
  const host = createDeterministicServerHost();
  const server = createAxiomServer({
    ir,
    host,
    persistence: createMemoryPersistence(),
    integrations: { [INTEGRATION]: hangingAdapter() },
  });
  await server.start();

  const invocation = server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_REFRESH });
  await settle();
  host.advance(1000);
  const response = (await invocation) as { ok: boolean; diagnostics: Array<{ code: string }> };

  assert.equal(response.ok, false);
  assert.equal(response.diagnostics[0]?.code, 'INTEGRATION_TIMEOUT');
  assert.equal(server.getState(STATE_STATUS), 'unknown');
  await server.stop();
});

test('a late adapter result does not mutate state or fire twice', async () => {
  let resolveLate: ((result: IntegrationResult) => void) | undefined;
  const adapter = createFakeIntegrationAdapter({
    query: () => new Promise<IntegrationResult>((resolve) => (resolveLate = resolve)),
  });
  const ir = compileToServerIR(buildGraph(1000));
  const host = createDeterministicServerHost();
  const server = createAxiomServer({
    ir,
    host,
    persistence: createMemoryPersistence(),
    integrations: { [INTEGRATION]: adapter },
  });
  await server.start();

  const invocation = server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_REFRESH });
  await settle();
  host.advance(1000);
  const response = (await invocation) as { ok: boolean };
  assert.equal(response.ok, false, 'the invocation already settled as a timeout');

  // The adapter resolves long after the deadline answered. Its value must never reach state.
  resolveLate?.({ ok: true, value: 'online' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.getState(STATE_STATUS), 'unknown', 'a late result never commits');
  await server.stop();
});

test('a timeout does not wedge a polling trigger: the next tick still runs (spec §22)', async () => {
  const ir = compileToServerIR(buildGraph(1000, 5000));
  const events: ServerEvent[] = [];
  const host = createDeterministicServerHost({ report: (event) => events.push(event) });
  const server = createAxiomServer({
    ir,
    host,
    persistence: createMemoryPersistence(),
    integrations: { [INTEGRATION]: hangingAdapter() },
  });
  await server.start();

  host.advance(5000); // t=5000: first tick begins.
  await settle();
  host.advance(1000); // t=6000: it times out; `inFlight` clears.
  await waitUntil(() => events.some((event) => event.kind === 'trigger-invocation-failed'));

  host.advance(5000); // t=11000: the next tick is due, and must not be skipped as an overlap.
  await settle();
  host.advance(1000); // t=12000: its own hung query times out too.
  await waitUntil(
    () => events.filter((event) => event.kind === 'trigger-invocation-failed').length >= 2,
  );
  assert.deepEqual(
    events.filter((event) => event.kind === 'trigger-skipped-overlap'),
    [],
    'the trigger recovered instead of staying permanently wedged',
  );
  await server.stop();
});

test('a slow timed-out poll does not poison a queued concurrent ordinary action (spec §68)', async () => {
  const ir = compileToServerIR(buildGraph(1000, 5000));
  const host = createDeterministicServerHost();
  const server = createAxiomServer({
    ir,
    host,
    persistence: createMemoryPersistence(),
    integrations: { [INTEGRATION]: hangingAdapter() },
  });
  await server.start();

  // The poll's own query starts hanging.
  host.advance(5000);
  await settle();
  // An ordinary client request arrives while it is still in flight — serialized behind it
  // (spec 8.1 §26-30), not racing it.
  const ordinary = server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_REFRESH });
  // The poll's query times out, which is what lets the queued request start at all.
  host.advance(1000);
  await settle();
  // The ordinary request's own query is now hanging too; it times out the same way.
  host.advance(1000);
  const response = (await ordinary) as { ok: boolean };
  assert.equal(response.ok, false, 'the queued call also times out cleanly, not hangs or throws');
  await server.stop();
});

// ------------------------------------------------------ deterministic/real host parity

async function runThreeSimultaneousPolls(
  makeHost: () => ReturnType<typeof createDeterministicServerHost> | ReturnType<typeof createServerHost>,
  advance: (host: ReturnType<typeof createServerHost>, ms: number) => Promise<void>,
): Promise<{ server: AxiomServer; events: ServerEvent[] }> {
  const graph = new ApplicationGraph('parity', 'Parity');
  graph.addNode<StateDef>({
    id: STATE_STATUS,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  const bumpActionIds = [0, 1, 2].map((n) => nodeId(`action_bump_${n}_08_1_timeout`));
  for (const actionId of bumpActionIds) {
    graph.addNode<ActionDef>({
      id: actionId,
      kind: 'action',
      operations: [
        {
          kind: 'set',
          target: stateLocation(STATE_STATUS),
          value: binary('add', ref(STATE_STATUS), literal(1)),
        },
      ],
    });
    // A one-shot `delay` due at the same simulated instant models the collision spec 8.1
    // §29 asks for without a repeating interval's later ticks muddying how many times each
    // action actually ran.
    graph.addNode<TriggerDef>({
      id: nodeId(`trigger_${String(actionId)}`),
      kind: 'trigger',
      actionId,
      when: { kind: 'delay', afterMs: 10 },
    });
  }
  const ir = compileToServerIR(graph);
  const events: ServerEvent[] = [];
  const host = makeHost();
  (host as { report?: (event: ServerEvent) => void }).report = (event) => events.push(event);
  const server = createAxiomServer({ ir, host: host as never, persistence: createMemoryPersistence() });
  await server.start();
  await advance(host as never, 10);
  return { server, events };
}

test('three same-period triggers commit all three under the deterministic host, no spurious conflicts', async () => {
  const { server, events } = await runThreeSimultaneousPolls(
    () => createDeterministicServerHost(),
    async (host, ms) => {
      (host as ReturnType<typeof createDeterministicServerHost>).advance(ms);
      // Every serialized invocation from this one `advance()` must settle before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  );
  assert.equal(server.getState(STATE_STATUS), 3);
  assert.deepEqual(
    events.filter((event) => event.kind === 'conflict'),
    [],
  );
  await server.stop();
});

test('three same-period triggers commit all three under the real host too', async () => {
  const { server, events } = await runThreeSimultaneousPolls(
    () => createServerHost(),
    async (_host, ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms + 40));
    },
  );
  assert.equal(server.getState(STATE_STATUS), 3);
  assert.deepEqual(
    events.filter((event) => event.kind === 'conflict'),
    [],
  );
  await server.stop();
});
