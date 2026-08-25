import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  EFFECT_ID_FIELD,
  EFFECT_INTEGRATION_ID_FIELD,
  EFFECT_MESSAGE_FIELD,
  EFFECT_OPERATION_ID_FIELD,
  EFFECT_RESULT_FIELD,
  PRINCIPAL,
  binary,
  call,
  effectOutcomeEntity,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  EventDef,
  IntegrationDef,
  IntegrationOperationDef,
  StateDef,
  TriggerDef,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  MAX_EVENT_DISPATCH_DEPTH,
  SERVER_DIAGNOSTIC_CODES,
  createAxiomServer,
  createDeterministicServerHost,
  createFakeIntegrationAdapter,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { AxiomServer, EffectRecord, IntegrationResult, ServerEvent } from '@cynodia/axiom-server';

/**
 * Integrations, effects and triggers (spec 0.8) end to end, on a deterministic clock so
 * nothing here waits on a real second (spec §85,141).
 */

const ENTITY_USER = nodeId('entity_user_08');
const F_USER_ID = fieldId('field_user_id_08');
const F_USER_ROLE = fieldId('field_user_role_08');

const STATE_STATUS = nodeId('state_status_08');
const STATE_LAST_MESSAGE = nodeId('state_last_message_08');

const INTEGRATION = nodeId('integration_provider_08');
const OP_FETCH = nodeId('integration_operation_fetch_08');
const OP_REBOOT = nodeId('integration_operation_reboot_08');

const ACTION_REFRESH = nodeId('action_refresh_08');
const ACTION_REBOOT = nodeId('action_reboot_08');
const ACTION_REBOOT_LOOP = nodeId('action_reboot_loop_08');
const ACTION_APPLY_MESSAGE = nodeId('action_apply_message_08');
const ACTION_APPLY_STATUS = nodeId('action_apply_status_08');
const ACTION_ADMIN_ONLY = nodeId('action_admin_only_08');
const PARAM_MESSAGE = nodeId('param_message_08');
const PARAM_STATUS = nodeId('param_status_08');

const SCOPE_QUERY = nodeId('scope_query_08');

const EVENT_REBOOTED = nodeId('event_rebooted_08');
const EVENT_REBOOT_FAILED = nodeId('event_reboot_failed_08');
// The reserved effect-outcome field ids are graph-global (like GROUP_KEY_FIELD/
// GROUP_ITEMS_FIELD), so one shared outcome entity covers every effect's succeeded and
// failed event in this graph, rather than a bespoke entity per event.
const ENTITY_EFFECT_OUTCOME = nodeId('entity_effect_outcome_08');
const EVENT_STATUS_CHANGED = nodeId('event_status_changed_08');
const EVENT_SELF = nodeId('event_self_08');

const TRIGGER_INTERVAL = nodeId('trigger_interval_08');
const TRIGGER_REBOOTED = nodeId('trigger_rebooted_08');
const TRIGGER_REBOOT_FAILED = nodeId('trigger_reboot_failed_08');
const TRIGGER_STATUS_CHANGED = nodeId('trigger_status_changed_08');
const TRIGGER_ADMIN_DELAY = nodeId('trigger_admin_delay_08');
const TRIGGER_SELF = nodeId('trigger_self_08');

const CONSTRAINT_STATUS = nodeId('constraint_status_08');

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('device-monitor-08', 'Device monitor');
  graph.setPrincipalEntity(ENTITY_USER);

  graph.addNode<EntityDef>({
    id: ENTITY_USER,
    kind: 'entity',
    identityFieldId: F_USER_ID,
    fields: [
      { id: F_USER_ID, valueType: primitiveType('string'), required: true },
      { id: F_USER_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_STATUS,
    kind: 'state',
    name: 'status',
    authority: 'server',
    valueType: primitiveType('string'),
    initialValue: 'unknown',
  });
  graph.addNode<StateDef>({
    id: STATE_LAST_MESSAGE,
    kind: 'state',
    name: 'last message',
    authority: 'server',
    valueType: primitiveType('string'),
    initialValue: '',
  });

  graph.addNode<IntegrationDef>({ id: INTEGRATION, kind: 'integration', name: 'Device provider' });
  graph.addNode<IntegrationOperationDef>({
    id: OP_FETCH,
    kind: 'integration-operation',
    integrationId: INTEGRATION,
    name: 'fetchStatus',
    mode: 'query',
    resultType: primitiveType('string'),
  });
  graph.addNode<IntegrationOperationDef>({
    id: OP_REBOOT,
    kind: 'integration-operation',
    integrationId: INTEGRATION,
    name: 'rebootDevice',
    mode: 'effect',
    idempotent: true,
    resultType: primitiveType('string'),
  });

  graph.addNode<ActionDef>({
    id: ACTION_REFRESH,
    kind: 'action',
    name: 'refresh status',
    operations: [
      { kind: 'integration-query', operationId: OP_FETCH, bindAs: SCOPE_QUERY },
      { kind: 'set', target: stateLocation(STATE_STATUS), value: ref(SCOPE_QUERY) },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_REBOOT,
    kind: 'action',
    name: 'reboot device',
    operations: [
      {
        kind: 'integration-effect',
        operationId: OP_REBOOT,
        succeededEventId: EVENT_REBOOTED,
        failedEventId: EVENT_REBOOT_FAILED,
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_APPLY_MESSAGE,
    kind: 'action',
    name: 'apply message',
    // Only the reboot effect's own succeeded/failed event should ever reach this (spec
    // 8.1 §3-9, §11) — a client that guessed this action id could otherwise forge a fake
    // effect outcome.
    invocation: { allowedSources: ['system'] },
    parameters: [{ id: PARAM_MESSAGE, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(STATE_LAST_MESSAGE), value: ref(PARAM_MESSAGE) }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_APPLY_STATUS,
    kind: 'action',
    name: 'apply status',
    // Only the verified `EVENT_STATUS_CHANGED` webhook event should ever reach this (spec
    // 8.1 §3-9, §10).
    invocation: { allowedSources: ['system'] },
    parameters: [{ id: PARAM_STATUS, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(STATE_STATUS), value: ref(PARAM_STATUS) }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_ADMIN_ONLY,
    kind: 'action',
    name: 'admin only',
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin')),
    operations: [{ kind: 'set', target: stateLocation(STATE_LAST_MESSAGE), value: literal('admin ran it') }],
  });

  graph.addNode(effectOutcomeEntity(ENTITY_EFFECT_OUTCOME, primitiveType('string')));
  graph.addNode<EventDef>({
    id: EVENT_REBOOTED,
    kind: 'event',
    payloadType: entityType(ENTITY_EFFECT_OUTCOME),
  });
  graph.addNode<EventDef>({
    id: EVENT_REBOOT_FAILED,
    kind: 'event',
    payloadType: entityType(ENTITY_EFFECT_OUTCOME),
  });
  graph.addNode<EventDef>({ id: EVENT_STATUS_CHANGED, kind: 'event', payloadType: primitiveType('string') });
  // The same shared outcome entity: this is also an effect-success outcome, of the same
  // OP_REBOOT operation, just re-dispatched deliberately to form the depth-guard cycle.
  graph.addNode<EventDef>({ id: EVENT_SELF, kind: 'event', payloadType: entityType(ENTITY_EFFECT_OUTCOME) });

  graph.addNode<ActionDef>({
    id: ACTION_REBOOT_LOOP,
    kind: 'action',
    name: 'reboot loop',
    // A deliberate cycle: this effect's own success re-fires the event that triggers it.
    operations: [{ kind: 'integration-effect', operationId: OP_REBOOT, succeededEventId: EVENT_SELF }],
  });

  graph.addNode<TriggerDef>({
    id: TRIGGER_INTERVAL,
    kind: 'trigger',
    actionId: ACTION_REFRESH,
    when: { kind: 'interval', everyMs: 5000 },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_REBOOTED,
    kind: 'trigger',
    actionId: ACTION_APPLY_MESSAGE,
    when: { kind: 'event', eventId: EVENT_REBOOTED },
    arguments: { [String(PARAM_MESSAGE)]: field(ref(TRIGGER_REBOOTED), EFFECT_RESULT_FIELD) },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_REBOOT_FAILED,
    kind: 'trigger',
    actionId: ACTION_APPLY_MESSAGE,
    when: { kind: 'event', eventId: EVENT_REBOOT_FAILED },
    arguments: { [String(PARAM_MESSAGE)]: field(ref(TRIGGER_REBOOT_FAILED), EFFECT_MESSAGE_FIELD) },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_STATUS_CHANGED,
    kind: 'trigger',
    actionId: ACTION_APPLY_STATUS,
    when: { kind: 'event', eventId: EVENT_STATUS_CHANGED },
    arguments: { [String(PARAM_STATUS)]: ref(TRIGGER_STATUS_CHANGED) },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_ADMIN_DELAY,
    kind: 'trigger',
    actionId: ACTION_ADMIN_ONLY,
    when: { kind: 'delay', afterMs: 1000 },
  });
  // A deliberate cycle: firing EVENT_SELF invokes an action that requests an effect whose
  // success re-fires EVENT_SELF — the event-dispatch depth guard is what stops this.
  graph.addNode<TriggerDef>({
    id: TRIGGER_SELF,
    kind: 'trigger',
    actionId: ACTION_REBOOT_LOOP,
    when: { kind: 'event', eventId: EVENT_SELF },
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_STATUS,
    kind: 'constraint',
    expression: call('one-of', ref(STATE_STATUS), literal('unknown'), literal('online'), literal('offline')),
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

function buildServer(
  adapter: ReturnType<typeof createFakeIntegrationAdapter>,
  overrides: Parameters<typeof createDeterministicServerHost>[0] = {},
): { server: AxiomServer; events: ServerEvent[]; host: ReturnType<typeof createDeterministicServerHost> } {
  const events: ServerEvent[] = [];
  const host = createDeterministicServerHost({ report: (event) => events.push(event), ...overrides });
  const ir = compileToServerIR(buildGraph());
  const server = createAxiomServer({
    ir,
    host,
    persistence: createMemoryPersistence(),
    integrations: { [INTEGRATION]: adapter },
  });
  return { server, events, host };
}

// ---------------------------------------------------------------- polling

test('an interval trigger polls a query and writes its result (spec §90-91)', async () => {
  const statuses = ['online', 'offline'];
  const adapter = createFakeIntegrationAdapter({
    query: () => ({ ok: true, value: statuses.shift() ?? 'online' }),
  });
  const { server, host } = buildServer(adapter);
  await server.start();

  assert.equal(server.getState(STATE_STATUS), 'unknown');
  host.advance(5000);
  await waitUntil(() => server.getState(STATE_STATUS) === 'online');
  host.advance(5000);
  await waitUntil(() => server.getState(STATE_STATUS) === 'offline');
  await server.stop();
});

test('an overlapping tick is skipped by default, never run concurrently (spec §92)', async () => {
  let resolveFirst: ((result: IntegrationResult) => void) | undefined;
  let calls = 0;
  const adapter = createFakeIntegrationAdapter({
    query: () =>
      new Promise<IntegrationResult>((resolve) => {
        calls += 1;
        if (calls === 1) {
          resolveFirst = resolve;
        } else {
          resolve({ ok: true, value: 'online' });
        }
      }),
  });
  const { server, host, events } = buildServer(adapter);
  await server.start();

  host.advance(5000);
  // The first query is still in flight; a second tick firing now must be skipped, not queued.
  host.advance(5000);
  await waitUntil(() => calls === 1);
  assert.ok(events.some((event) => event.kind === 'trigger-skipped-overlap'));

  resolveFirst?.({ ok: true, value: 'online' });
  await waitUntil(() => server.getState(STATE_STATUS) === 'online');
  await server.stop();
});

test('a failed query reports a diagnostic and leaves the next tick runnable (spec §93)', async () => {
  let fail = true;
  const adapter = createFakeIntegrationAdapter({
    query: () =>
      fail
        ? { ok: false, code: 'INTEGRATION_UNAVAILABLE', message: 'provider is down' }
        : { ok: true, value: 'online' },
  });
  const { server, host, events } = buildServer(adapter);
  await server.start();

  host.advance(5000);
  await waitUntil(() => events.some((event) => event.kind === 'trigger-invocation-failed'));
  assert.equal(server.getState(STATE_STATUS), 'unknown', 'a failed query never fakes a default success');

  fail = false;
  host.advance(5000);
  await waitUntil(() => server.getState(STATE_STATUS) === 'online');
  await server.stop();
});

// ------------------------------------------------------------------ effects

test('a succeeded effect dispatches its declared event to a follow-up action (spec §22,94)', async () => {
  const adapter = createFakeIntegrationAdapter({
    effect: () => ({ ok: true, value: 'rebooted at t=1' }),
  });
  const { server } = buildServer(adapter);
  await server.start();

  const response = await server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_REBOOT });
  assert.equal((response as { ok: boolean }).ok, true);
  await waitUntil(() => server.getState(STATE_LAST_MESSAGE) === 'rebooted at t=1');
  await server.stop();
});

test('a failed effect dispatches its failure event, and committed state stays consistent (spec §23,95)', async () => {
  const adapter = createFakeIntegrationAdapter({
    effect: () => ({ ok: false, code: 'DEVICE_UNREACHABLE', message: 'no route to device', retryable: false }),
  });
  const { server } = buildServer(adapter);
  await server.start();

  await server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_REBOOT });
  await waitUntil(() => server.getState(STATE_LAST_MESSAGE) === 'no route to device');
  await server.stop();
});

test('an effect intent committed before a restart is not lost (spec §19,96,140)', async () => {
  const persistence = createMemoryPersistence();
  const ir = compileToServerIR(buildGraph());

  // Simulates a crash: the adapter is called and never answers, exactly as if the process
  // had died mid-call. The promise it returns is deliberately never settled — a real crash
  // would not settle it either — so the only way `second` ever sees this effect succeed is
  // by resuming it independently after `first` is gone.
  const hangingAdapter = createFakeIntegrationAdapter({
    effect: () => new Promise<IntegrationResult>(() => undefined),
  });
  const first = createAxiomServer({
    ir,
    persistence,
    host: createDeterministicServerHost(),
    integrations: { [INTEGRATION]: hangingAdapter },
  });
  await first.start();
  await first.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_REBOOT });
  const pendingAfterFirst = (await persistence.loadPendingEffects?.()) ?? [];
  assert.equal(pendingAfterFirst.length, 1, 'the intent is durable before the adapter ever answers');
  // The persisted record itself, independent of `effectLog()`'s in-memory copy, must show
  // the adapter was genuinely called — not merely that an intent exists (spec 8.2 §20,23).
  assert.equal(pendingAfterFirst[0].status, 'running');
  assert.equal(pendingAfterFirst[0].attempts, 1);
  await first.stop();

  const resumedAdapter = createFakeIntegrationAdapter({ effect: () => ({ ok: true, value: 'ok after restart' }) });
  const second = createAxiomServer({
    ir,
    persistence,
    host: createDeterministicServerHost(),
    integrations: { [INTEGRATION]: resumedAdapter },
  });
  await second.start();
  await waitUntil(() => second.getState(STATE_LAST_MESSAGE) === 'ok after restart');
  // A record found `running` at startup gets a fresh attempt budget, not a stuck one at
  // zero remaining (spec §20) — attempts still counts up from where it was, and the outcome
  // applies exactly once (the state assertion above already proves that).
  const resumedRecord = second.effectLog().find((entry) => entry.operationId === OP_REBOOT);
  assert.equal(resumedRecord?.status, 'succeeded');
  assert.equal(resumedRecord?.attempts, 2);
  await second.stop();
});

test('effectLog reports status running with attempts 1 for a hung effect, never pending/0 (spec 8.2 §17-23)', async () => {
  const hangingAdapter = createFakeIntegrationAdapter({
    effect: () => new Promise<IntegrationResult>(() => undefined),
  });
  const { server } = buildServer(hangingAdapter);
  await server.start();

  await server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_REBOOT });
  await waitUntil(() => {
    const record = server.effectLog().find((entry) => entry.operationId === OP_REBOOT);
    return record?.status === 'running';
  });
  const record = server.effectLog().find((entry) => entry.operationId === OP_REBOOT) as EffectRecord;
  assert.equal(record.status, 'running', 'not yet dispatched must be distinguishable from dispatched and outstanding');
  assert.equal(record.attempts, 1, 'attempts counts invocations started, not merely settled (spec §21)');
  await server.stop();
});

// -------------------------------------------------------------------- events

test('a verified external event triggers its bound action (spec §51,98)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const { server } = buildServer(adapter);
  await server.start();

  const response = await server.handle({
    kind: 'event',
    protocol: 'axiom.protocol.v1',
    eventId: EVENT_STATUS_CHANGED,
    payload: 'online',
  });
  assert.equal((response as { ok: boolean }).ok, true);
  assert.equal(server.getState(STATE_STATUS), 'online');
  await server.stop();
});

test('a malformed event payload is rejected before any action sees it (spec §100)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const { server } = buildServer(adapter);
  await server.start();

  const response = await server.handle({
    kind: 'event',
    protocol: 'axiom.protocol.v1',
    eventId: EVENT_STATUS_CHANGED,
    payload: 42,
  });
  assert.equal((response as { ok: boolean }).ok, false);
  assert.equal(
    (response as { diagnostics: Array<{ code: string }> }).diagnostics[0]?.code,
    SERVER_DIAGNOSTIC_CODES.EVENT_PAYLOAD_INVALID,
  );
  assert.equal(server.getState(STATE_STATUS), 'unknown');
  await server.stop();
});

// -------------------------------------------------------- authority & rules

test('a constraint violation from a trigger rolls back, same as any other invocation (spec §102-103)', async () => {
  const adapter = createFakeIntegrationAdapter({ query: () => ({ ok: true, value: 'not-a-real-status' }) });
  const { server, host, events } = buildServer(adapter);
  await server.start();

  host.advance(5000);
  await waitUntil(() => events.some((event) => event.kind === 'trigger-invocation-failed'));
  assert.equal(server.getState(STATE_STATUS), 'unknown', 'an invalid status is never committed');
  await server.stop();
});

test('a system-triggered action still evaluates authorization, and can be refused by it (spec §67-69,104)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const { server, host, events } = buildServer(adapter);
  await server.start();

  host.advance(1000);
  await waitUntil(() => events.some((event) => event.kind === 'trigger-invocation-failed'));
  assert.equal(server.getState(STATE_LAST_MESSAGE), '', 'no ordinary user was impersonated to satisfy authorization');
  await server.stop();
});

// ------------------------------------------------------- invocation source (spec 8.1 §3-14)

test('an anonymous client cannot directly invoke an effect-outcome-only action (spec §11)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const { server } = buildServer(adapter);
  await server.start();

  const response = (await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ACTION_APPLY_MESSAGE,
    arguments: { [String(PARAM_MESSAGE)]: 'forged: reboot succeeded' },
  })) as { ok: boolean; diagnostics: Array<{ code: string }> };

  assert.equal(response.ok, false);
  assert.equal(response.diagnostics[0]?.code, 'INVOCATION_SOURCE_NOT_ALLOWED');
  assert.equal(server.getState(STATE_LAST_MESSAGE), '', 'the forged message never committed');
  await server.stop();
});

test('an anonymous client cannot directly invoke a webhook-only action (spec §10.C)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const { server } = buildServer(adapter);
  await server.start();

  const response = (await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ACTION_APPLY_STATUS,
    arguments: { [String(PARAM_STATUS)]: 'online' },
  })) as { ok: boolean; diagnostics: Array<{ code: string }> };

  assert.equal(response.ok, false);
  assert.equal(response.diagnostics[0]?.code, 'INVOCATION_SOURCE_NOT_ALLOWED');
  assert.equal(server.getState(STATE_STATUS), 'unknown', 'the forged status change never committed');
  await server.stop();
});

test('a client cannot forge system source through protocol data (spec §65-66)', async () => {
  const adapter = createFakeIntegrationAdapter({});
  const { server } = buildServer(adapter);
  await server.start();

  const response = (await server.handle({
    kind: 'invoke',
    protocol: 'axiom.protocol.v1',
    actionId: ACTION_APPLY_STATUS,
    arguments: { [String(PARAM_STATUS)]: 'online' },
    // InvokeRequest has no `source` field to forge in the first place; a client that sends
    // one anyway (as raw, untyped JSON reaching `handle`) must find it silently ignored.
    ...({ source: 'system' } as Record<string, unknown>),
  } as never)) as { ok: boolean; diagnostics: Array<{ code: string }> };

  assert.equal(response.ok, false);
  assert.equal(response.diagnostics[0]?.code, 'INVOCATION_SOURCE_NOT_ALLOWED');
  await server.stop();
});

test('missing integration adapters fail startup clearly, not at first invocation (spec §116)', async () => {
  const ir = compileToServerIR(buildGraph());
  const server = createAxiomServer({ ir, host: createDeterministicServerHost(), persistence: createMemoryPersistence() });
  await assert.rejects(() => server.start(), /Missing integration adapter/);
});

test('an event-dispatch cycle is stopped rather than recursing unboundedly (spec §120-121)', async () => {
  const adapter = createFakeIntegrationAdapter({ effect: () => ({ ok: true, value: 'ok' }) });
  const { server, events } = buildServer(adapter);
  await server.start();

  await server.handle({
    kind: 'event',
    protocol: 'axiom.protocol.v1',
    eventId: EVENT_SELF,
    payload: {
      [String(EFFECT_ID_FIELD)]: 'seed',
      [String(EFFECT_INTEGRATION_ID_FIELD)]: String(INTEGRATION),
      [String(EFFECT_OPERATION_ID_FIELD)]: String(OP_REBOOT),
      [String(EFFECT_RESULT_FIELD)]: 'go',
    },
  });
  // Each cascade round is a real, separately-scheduled effect dispatch, so this genuinely
  // waits across all of them rather than racing the last one.
  await waitUntil(
    () => events.filter((event) => event.kind === 'effect-succeeded').length >= MAX_EVENT_DISPATCH_DEPTH,
    5000,
  );
  // The cycle is real (each success re-fires the same event), so without the depth guard
  // this dispatch count would grow without bound; with it, it stops at a fixed ceiling.
  const requested = events.filter((event) => event.kind === 'effect-requested').length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const requestedAfterSettling = events.filter((event) => event.kind === 'effect-requested').length;
  assert.equal(requestedAfterSettling, requested, 'dispatch has genuinely stopped, not merely paused');
  assert.ok(requested <= MAX_EVENT_DISPATCH_DEPTH + 1, `expected a bounded cascade, got ${requested} dispatches`);
  await server.stop();
});
