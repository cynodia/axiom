import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  itemFieldLocation,
  literal,
  nodeId,
  primitiveType,
  ref,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  EntityDef,
  EventDef,
  IntegrationDef,
  StateDef,
  SubscriptionDef,
  TriggerDef,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
  createScriptedSubscriptionAdapter,
} from '@cynodia/axiom-server';
import type {
  DeliveryOutcome,
  SubscriptionAdapter,
  SubscriptionContext,
  SubscriptionDelivery,
} from '@cynodia/axiom-server';

/**
 * The subscription semantics that are policy rather than plumbing: backpressure, loss,
 * poison deliveries and required-source startup. Each is a rule the graph declares and the
 * runtime is obliged to apply exactly as written — a mode that could quietly do something
 * else would make the declaration meaningless.
 */

const E_READING = nodeId('entity_reading');
const F_READING_VALUE = fieldId('field_reading_value');
const F_READING_ID = fieldId('field_reading_id');
const E_SENSOR = nodeId('entity_sensor');
const F_SENSOR_ID = fieldId('field_sensor_id');
const F_SENSOR_VALUE = fieldId('field_sensor_value');

const S_SENSORS = nodeId('state_sensors');
const INTEGRATION = nodeId('integration_sensors');
const EVENT_READING = nodeId('event_reading');
const SUBSCRIPTION = nodeId('subscription_readings');
const ACTION_APPLY = nodeId('action_apply_reading');
const P_VALUE = nodeId('param_value');
const TRIGGER = nodeId('trigger_reading');

interface FeedOptions {
  delivery?: SubscriptionDef['delivery'];
  lifecycle?: SubscriptionDef['lifecycle'];
  /** Makes the applying action refuse, to exercise the poison-delivery policy. */
  poison?: boolean;
}

function feedGraph(options: FeedOptions = {}): ApplicationGraph {
  const graph = new ApplicationGraph('feed', 'Feed');
  graph.addNode<EntityDef>({
    id: E_SENSOR,
    kind: 'entity',
    identityFieldId: F_SENSOR_ID,
    fields: [
      { id: F_SENSOR_ID, valueType: primitiveType('string'), required: true },
      { id: F_SENSOR_VALUE, valueType: primitiveType('number'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: E_READING,
    kind: 'entity',
    fields: [
      { id: F_READING_ID, valueType: primitiveType('string') },
      { id: F_READING_VALUE, valueType: primitiveType('number'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: S_SENSORS,
    kind: 'state',
    name: 'sensors',
    authority: 'server',
    valueType: collectionType(entityType(E_SENSOR)),
    initialValue: [{ [F_SENSOR_ID]: 's-1', [F_SENSOR_VALUE]: 0 }],
  });
  graph.addNode<IntegrationDef>({ id: INTEGRATION, kind: 'integration', name: 'Sensors' });
  graph.addNode<EventDef>({ id: EVENT_READING, kind: 'event', payloadType: entityType(E_READING) });
  graph.addNode<ActionDef>({
    id: ACTION_APPLY,
    kind: 'action',
    name: 'apply reading',
    invocation: { allowedSources: ['system'] },
    parameters: [{ id: P_VALUE, valueType: primitiveType('number'), required: true }],
    ...(options.poison
      ? { guards: [{ condition: literal(false), failureMode: { code: 'always-refuses' } }] }
      : {}),
    operations: [
      {
        kind: 'set',
        target: itemFieldLocation(S_SENSORS, F_SENSOR_ID, literal('s-1'), F_SENSOR_VALUE),
        value: ref(P_VALUE),
      },
    ],
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER,
    kind: 'trigger',
    actionId: ACTION_APPLY,
    when: { kind: 'event', eventId: EVENT_READING },
    arguments: { [String(P_VALUE)]: field(ref(TRIGGER), F_READING_VALUE) },
  });
  graph.addNode<SubscriptionDef>({
    id: SUBSCRIPTION,
    kind: 'subscription',
    name: 'readings',
    integrationId: INTEGRATION,
    source: 'readings',
    eventId: EVENT_READING,
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
  });
  return graph;
}

/**
 * An adapter whose deliveries the test drives by hand, so backpressure is observable: the
 * promise `deliver` returns is exactly what a real adapter would await before pulling the
 * next message off its transport.
 */
function manualAdapter(): SubscriptionAdapter & { deliver(delivery: SubscriptionDelivery): Promise<DeliveryOutcome> } {
  let context: SubscriptionContext | undefined;
  return {
    async start(given: SubscriptionContext) {
      context = given;
      return { stop: () => undefined };
    },
    deliver(delivery: SubscriptionDelivery): Promise<DeliveryOutcome> {
      if (!context) {
        throw new Error('the subscription has not started');
      }
      return context.deliver(delivery);
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2));
}

function reading(value: number, id?: string): Record<string, unknown> {
  return { [F_READING_VALUE]: value, ...(id !== undefined ? { [F_READING_ID]: id } : {}) };
}

function startServer(graph: ApplicationGraph, adapter: SubscriptionAdapter) {
  return createAxiomServer({
    ir: compileToServerIR(graph),
    host: createDeterministicServerHost(),
    persistence: createMemoryPersistence(),
    subscriptions: { [INTEGRATION]: adapter },
  });
}

test('a graph declaring a subscription with no trigger on its event is refused', () => {
  const graph = feedGraph();
  graph.removeNode(TRIGGER);
  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => error.code === 'SUBSCRIPTION_EVENT_UNREACHABLE'),
    'a live source feeding nothing must not validate',
  );
});

test('a subscription in a graph with no authority is refused', () => {
  const graph = feedGraph();
  const sensors = graph.getNode<StateDef>(S_SENSORS) as StateDef;
  graph.updateNode({ ...sensors, authority: 'client' });
  const result = validateGraph(graph);
  assert.ok(result.errors.some((error) => error.code === 'SUBSCRIPTION_WITHOUT_AUTHORITY'));
});

test('a deduplication field that is not on the payload entity is refused', () => {
  const graph = feedGraph({ delivery: { deduplicateBy: F_SENSOR_ID } });
  const result = validateGraph(graph);
  assert.ok(result.errors.some((error) => error.code === 'SUBSCRIPTION_INVALID_POLICY'));
});

test('a queue that could hold no delivery is refused', () => {
  const graph = feedGraph({ delivery: { maxQueued: 0 } });
  assert.ok(validateGraph(graph).errors.some((error) => error.code === 'SUBSCRIPTION_INVALID_POLICY'));
});

test('a declared subscription with no registered adapter fails startup', async () => {
  const server = createAxiomServer({
    ir: compileToServerIR(feedGraph()),
    host: createDeterministicServerHost(),
    persistence: createMemoryPersistence(),
  });
  await assert.rejects(() => server.start(), /Missing subscription adapter/);
});

test("backpressure 'block' never loses an event: the adapter's own call waits", async () => {
  const adapter = manualAdapter();
  const server = startServer(feedGraph({ delivery: { maxQueued: 1, backpressure: 'block' } }), adapter);
  await server.start();

  // Three deliveries into a queue of one. None is answered "dropped" and none is lost: the
  // third simply does not resolve until the first two have been applied.
  const outcomes = await Promise.all([
    adapter.deliver({ payload: reading(1) }),
    adapter.deliver({ payload: reading(2) }),
    adapter.deliver({ payload: reading(3) }),
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['applied', 'applied', 'applied'],
  );
  const status = server.subscriptionStatus(SUBSCRIPTION);
  assert.equal(status?.applied, 3);
  assert.equal(status?.dropped, 0);
  await server.stop();
});

test("backpressure 'reject' refuses rather than dropping, so the source still holds it", async () => {
  const adapter = manualAdapter();
  const server = startServer(feedGraph({ delivery: { maxQueued: 1, backpressure: 'reject' } }), adapter);
  await server.start();

  const first = adapter.deliver({ payload: reading(1) });
  const second = adapter.deliver({ payload: reading(2) });
  const third = adapter.deliver({ payload: reading(3) });
  const outcomes = await Promise.all([first, second, third]);
  const refused = outcomes.filter((outcome) => outcome.status === 'refused');
  assert.ok(refused.length > 0, 'the full queue refused rather than silently accepting');
  assert.equal(refused[0]?.code, 'SUBSCRIPTION_QUEUE_FULL');
  assert.equal(server.subscriptionStatus(SUBSCRIPTION)?.dropped, 0, 'refusing is not losing');
  await server.stop();
});

test("backpressure 'drop-newest' loses an event, and says so every time", async () => {
  const adapter = manualAdapter();
  const server = startServer(feedGraph({ delivery: { maxQueued: 1, backpressure: 'drop-newest' } }), adapter);
  await server.start();

  const outcomes = await Promise.all([
    adapter.deliver({ payload: reading(1) }),
    adapter.deliver({ payload: reading(2) }),
    adapter.deliver({ payload: reading(3) }),
  ]);
  const dropped = outcomes.filter((outcome) => outcome.status === 'dropped');
  assert.ok(dropped.length > 0);
  assert.equal(dropped[0]?.code, 'SUBSCRIPTION_DELIVERY_DROPPED');
  // Loss is counted where an operator can see it. A dropping mode is a declaration, not an
  // accident, and it is never silent.
  assert.equal(server.subscriptionStatus(SUBSCRIPTION)?.dropped, dropped.length);
  await server.stop();
});

test("backpressure 'drop-oldest' evicts the queued delivery, not the arriving one", async () => {
  const adapter = manualAdapter();
  const server = startServer(feedGraph({ delivery: { maxQueued: 1, backpressure: 'drop-oldest' } }), adapter);
  await server.start();

  const outcomes = await Promise.all([
    adapter.deliver({ payload: reading(1) }),
    adapter.deliver({ payload: reading(2) }),
    adapter.deliver({ payload: reading(3) }),
  ]);
  assert.ok(outcomes.some((outcome) => outcome.status === 'dropped'));
  // The newest reading is what a lossy sensor feed is for: the last value applied is the
  // last one delivered.
  const sensors = server.getState(S_SENSORS) as Array<Record<string, unknown>>;
  assert.equal(sensors[0]?.[F_SENSOR_VALUE], 3);
  await server.stop();
});

test('the queue is bounded: a flood cannot grow it without limit', async () => {
  const adapter = manualAdapter();
  const server = startServer(feedGraph({ delivery: { maxQueued: 4, backpressure: 'drop-newest' } }), adapter);
  await server.start();

  const flood = Array.from({ length: 500 }, (_unused, index) => adapter.deliver({ payload: reading(index) }));
  const observed: number[] = [];
  const record = (): void => {
    observed.push(server.subscriptionStatus(SUBSCRIPTION)?.queued ?? 0);
  };
  record();
  await Promise.all(flood);
  record();
  assert.ok(Math.max(...observed) <= 4, 'the queue never exceeded its declared depth');
  const status = server.subscriptionStatus(SUBSCRIPTION);
  assert.equal((status?.applied ?? 0) + (status?.dropped ?? 0), 500, 'every delivery was accounted for');
  await server.stop();
});

test('a delivery whose action keeps failing is reported, bounded, and never spins', async () => {
  const adapter = manualAdapter();
  const server = startServer(
    feedGraph({ poison: true, delivery: { maxAttempts: 3, onFailure: 'report' } }),
    adapter,
  );
  await server.start();

  const outcome = await adapter.deliver({ payload: reading(1) });
  assert.equal(outcome.status, 'failed');
  const status = server.subscriptionStatus(SUBSCRIPTION);
  assert.equal(status?.failed, 1);
  assert.equal(status?.state, 'active', "'report' keeps the source running");

  // And the next delivery is still processed: one poison message does not wedge the feed.
  assert.equal((await adapter.deliver({ payload: reading(2) })).status, 'failed');
  await server.stop();
});

test("a poison delivery under 'pause' stops the subscription rather than retrying forever", async () => {
  const adapter = manualAdapter();
  const server = startServer(feedGraph({ poison: true, delivery: { onFailure: 'pause' } }), adapter);
  await server.start();

  await adapter.deliver({ payload: reading(1) });
  await settle();
  assert.equal(server.subscriptionStatus(SUBSCRIPTION)?.state, 'failed');
  assert.equal((await adapter.deliver({ payload: reading(2) })).status, 'stopped');
  await server.stop();
});

test('a required subscription that cannot start fails startup', async () => {
  const host = createDeterministicServerHost();
  const server = createAxiomServer({
    ir: compileToServerIR(feedGraph({ lifecycle: { required: true, reconnect: { policy: 'none' } } })),
    host,
    persistence: createMemoryPersistence(),
    subscriptions: {
      [INTEGRATION]: createScriptedSubscriptionAdapter(
        { [String(SUBSCRIPTION)]: { entries: [{ kind: 'connect-failure', message: 'no route to host' }] } },
        host,
      ),
    },
  });
  await assert.rejects(() => server.start(), /Required subscription/);
});

test('a subscription that does not auto-start stays inactive until nothing starts it', async () => {
  const adapter = manualAdapter();
  const server = startServer(feedGraph({ lifecycle: { autoStart: false } }), adapter);
  await server.start();
  assert.equal(server.subscriptionStatus(SUBSCRIPTION)?.state, 'inactive');
  assert.equal(server.subscriptionStatus(SUBSCRIPTION)?.received, 0);
  await server.stop();
});

test('two subscriptions are ordered against each other in no way at all', async () => {
  // Stated as a test because it is a promise *not* made: the runtime keeps one queue per
  // subscription, so nothing serializes two independent sources against each other, and a
  // consumer must not build on an accident of interleaving.
  const graph = feedGraph();
  const second = nodeId('subscription_second');
  const secondEvent = nodeId('event_second');
  graph.addNode<EventDef>({ id: secondEvent, kind: 'event', payloadType: entityType(E_READING) });
  graph.addNode<TriggerDef>({
    id: nodeId('trigger_second'),
    kind: 'trigger',
    actionId: ACTION_APPLY,
    when: { kind: 'event', eventId: secondEvent },
    arguments: { [String(P_VALUE)]: field(ref(nodeId('trigger_second')), F_READING_VALUE) },
  });
  graph.addNode<SubscriptionDef>({
    id: second,
    kind: 'subscription',
    integrationId: INTEGRATION,
    source: 'second',
    eventId: secondEvent,
  });
  assert.deepEqual(validateGraph(graph).errors, []);

  const adapter = manualAdapter();
  const server = startServer(graph, adapter);
  await server.start();
  const log = server.subscriptionLog();
  assert.equal(log.length, 2);
  assert.ok(log.every((entry) => entry.state === 'active'));
  await server.stop();
});

test('the subscription log answers every operational question without a health route', async () => {
  const adapter = manualAdapter();
  const server = startServer(feedGraph({ delivery: { deduplicateBy: F_READING_ID } }), adapter);
  await server.start();

  await adapter.deliver({ payload: reading(5, 'r-1') });
  await adapter.deliver({ payload: reading(6, 'r-1') });
  await adapter.deliver({ payload: 'malformed' });

  const status = server.subscriptionStatus(SUBSCRIPTION);
  assert.equal(status?.state, 'active');
  assert.equal(status?.source, 'readings');
  assert.equal(status?.applied, 1);
  assert.equal(status?.rejected, 2, 'one duplicate and one invalid payload');
  assert.ok(status?.lastDeliveryAt, 'the last delivery is timestamped');
  assert.equal(status?.lastFailure?.code, 'EVENT_PAYLOAD_INVALID');
  await server.stop();
});

test('a graph with no 0.9 vocabulary still compiles to the contract it always did', () => {
  const graph = feedGraph();
  graph.removeNode(SUBSCRIPTION);
  const ir = compileToServerIR(graph);
  assert.equal(ir.contract, 'axiom.server.v4');
  assert.equal(ir.subscriptions, undefined);
  assert.equal(ir.storages, undefined);
});

test('a graph that uses subscription vocabulary says so in its contract label', () => {
  const ir = compileToServerIR(feedGraph());
  assert.equal(ir.contract, 'axiom.server.v5');
  assert.equal(ir.subscriptions?.length, 1);
});

test('a v5 document labelled v4 is refused rather than executed', async () => {
  const ir = compileToServerIR(feedGraph());
  assert.throws(
    () =>
      createAxiomServer({
        ir: { ...ir, contract: 'axiom.server.v4' },
        persistence: createMemoryPersistence(),
      }),
    /uses axiom\.server\.v5 semantics/,
  );
});

test('nothing in a compiled subscription is a function, a promise or a host object', () => {
  const ir = compileToServerIR(feedGraph({ delivery: { maxQueued: 8, backpressure: 'block' } }));
  const round = JSON.parse(JSON.stringify(ir.subscriptions)) as unknown;
  assert.deepEqual(round, ir.subscriptions, 'the subscription survives a JSON round trip unchanged');
  const walk = (value: unknown): void => {
    if (typeof value === 'function') {
      assert.fail('a function reached the Server IR');
    }
    if (value && typeof value === 'object') {
      assert.ok(!(value instanceof Promise), 'a promise reached the Server IR');
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(ir.subscriptions);
});
