import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  EFFECT_MESSAGE_FIELD,
  EFFECT_RESULT_FIELD,
  effectOutcomeEntity,
  entityType,
  field,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  EventDef,
  IntegrationDef,
  IntegrationOperationDef,
  StateDef,
  TriggerDef,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createDeterministicServerHost,
  createFakeIntegrationAdapter,
  createMemoryPersistence,
} from '@cynodia/axiom-server';

/**
 * Spec 8.2 §38-39: `retryable: false` on an `IntegrationFailure` stops the remaining retry
 * policy immediately; `true` or absent both continue it — "absent" meaning the adapter could
 * not determine retryability, not that it is exempt from the policy. Also exercises a real
 * multi-attempt retry sequence with a stable `idempotencyKey` across every attempt (spec 8.2
 * §11 item 8), which nothing in the suite covered before.
 */

const STATE_MESSAGE = nodeId('state_message_08_2_retry');
const INTEGRATION = nodeId('integration_provider_08_2_retry');
const OP_NOTIFY = nodeId('integration_operation_notify_08_2_retry');
const ACTION_NOTIFY = nodeId('action_notify_08_2_retry');
const ACTION_APPLY_MESSAGE = nodeId('action_apply_message_08_2_retry');
const PARAM_MESSAGE = nodeId('param_message_08_2_retry');
const ENTITY_EFFECT_OUTCOME = nodeId('entity_effect_outcome_08_2_retry');
const EVENT_SUCCEEDED = nodeId('event_succeeded_08_2_retry');
const EVENT_FAILED = nodeId('event_failed_08_2_retry');
const TRIGGER_SUCCEEDED = nodeId('trigger_succeeded_08_2_retry');
const TRIGGER_FAILED = nodeId('trigger_failed_08_2_retry');

const DELAY_MS = 100;

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('effect-retry-08-2', 'Effect retry');

  graph.addNode<StateDef>({
    id: STATE_MESSAGE,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('string'),
    initialValue: '',
  });

  graph.addNode<IntegrationDef>({ id: INTEGRATION, kind: 'integration', name: 'Notifier' });
  graph.addNode<IntegrationOperationDef>({
    id: OP_NOTIFY,
    kind: 'integration-operation',
    integrationId: INTEGRATION,
    name: 'notify',
    mode: 'effect',
    idempotent: true,
    resultType: primitiveType('string'),
    retry: { policy: 'fixed', maxAttempts: 3, delayMs: DELAY_MS },
  });

  graph.addNode(effectOutcomeEntity(ENTITY_EFFECT_OUTCOME, primitiveType('string')));
  graph.addNode<EventDef>({ id: EVENT_SUCCEEDED, kind: 'event', payloadType: entityType(ENTITY_EFFECT_OUTCOME) });
  graph.addNode<EventDef>({ id: EVENT_FAILED, kind: 'event', payloadType: entityType(ENTITY_EFFECT_OUTCOME) });

  graph.addNode<ActionDef>({
    id: ACTION_NOTIFY,
    kind: 'action',
    operations: [
      {
        kind: 'integration-effect',
        operationId: OP_NOTIFY,
        idempotencyKey: literal('stable-key-1'),
        succeededEventId: EVENT_SUCCEEDED,
        failedEventId: EVENT_FAILED,
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_APPLY_MESSAGE,
    kind: 'action',
    invocation: { allowedSources: ['system'] },
    parameters: [{ id: PARAM_MESSAGE, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(STATE_MESSAGE), value: ref(PARAM_MESSAGE) }],
  });

  // An `event`-kind trigger's `arguments` may `ref` its own id to read the dispatched
  // payload — the succeeded/failed structured envelope, here (spec 8.1 §37-41).
  graph.addNode<TriggerDef>({
    id: TRIGGER_SUCCEEDED,
    kind: 'trigger',
    actionId: ACTION_APPLY_MESSAGE,
    when: { kind: 'event', eventId: EVENT_SUCCEEDED },
    arguments: { [PARAM_MESSAGE]: field(ref(TRIGGER_SUCCEEDED), EFFECT_RESULT_FIELD) },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_FAILED,
    kind: 'trigger',
    actionId: ACTION_APPLY_MESSAGE,
    when: { kind: 'event', eventId: EVENT_FAILED },
    arguments: { [PARAM_MESSAGE]: field(ref(TRIGGER_FAILED), EFFECT_MESSAGE_FIELD) },
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

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Advances the deterministic clock by the retry policy's delay, once per attempt already made. */
async function driveThroughRetries(
  host: ReturnType<typeof createDeterministicServerHost>,
  callCount: () => number,
  expectedCalls: number,
): Promise<void> {
  for (let seen = 1; seen < expectedCalls; seen++) {
    await waitUntil(() => callCount() >= seen);
    await settle();
    host.advance(DELAY_MS);
  }
}

test('retryable: false stops the remaining retry policy immediately, whatever maxAttempts says (spec 8.2 §38-39)', async () => {
  const calls: Array<string | undefined> = [];
  const adapter = createFakeIntegrationAdapter({
    effect: (_operation, _args, context) => {
      calls.push(context.idempotencyKey);
      return { ok: false, code: 'REJECTED', message: 'provider rejected permanently', retryable: false };
    },
  });
  const ir = compileToServerIR(buildGraph());
  const host = createDeterministicServerHost();
  const server = createAxiomServer({ ir, host, persistence: createMemoryPersistence(), integrations: { [INTEGRATION]: adapter } });
  await server.start();

  await server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_NOTIFY });
  await waitUntil(() => server.getState(STATE_MESSAGE) !== '');

  assert.equal(calls.length, 1, 'retryable: false must stop after the first attempt despite maxAttempts: 3');
  assert.equal(server.getState(STATE_MESSAGE), 'provider rejected permanently');
  await server.stop();
});

test('retryable: true continues the declared retry policy across every attempt (spec 8.2 §38-39)', async () => {
  const calls: Array<string | undefined> = [];
  const adapter = createFakeIntegrationAdapter({
    effect: (_operation, _args, context) => {
      calls.push(context.idempotencyKey);
      if (calls.length < 3) {
        return { ok: false, code: 'TRANSIENT', message: 'try again', retryable: true };
      }
      return { ok: true, value: `ok after ${calls.length} attempts` };
    },
  });
  const ir = compileToServerIR(buildGraph());
  const host = createDeterministicServerHost();
  const server = createAxiomServer({ ir, host, persistence: createMemoryPersistence(), integrations: { [INTEGRATION]: adapter } });
  await server.start();

  await server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_NOTIFY });
  await driveThroughRetries(host, () => calls.length, 3);
  await waitUntil(() => server.getState(STATE_MESSAGE) !== '');

  assert.equal(calls.length, 3, 'retryable: true keeps the policy going up to maxAttempts');
  assert.equal(server.getState(STATE_MESSAGE), 'ok after 3 attempts');
  assert.deepEqual(new Set(calls), new Set(['stable-key-1']), 'idempotencyKey is stable across every attempt');
  await server.stop();
});

test('retryable absent continues the declared retry policy, same as true — the adapter simply does not know (spec 8.2 §38-39)', async () => {
  const calls: Array<string | undefined> = [];
  const adapter = createFakeIntegrationAdapter({
    effect: (_operation, _args, context) => {
      calls.push(context.idempotencyKey);
      if (calls.length < 2) {
        return { ok: false, code: 'UNKNOWN', message: 'no idea' };
      }
      return { ok: true, value: `ok after ${calls.length} attempts` };
    },
  });
  const ir = compileToServerIR(buildGraph());
  const host = createDeterministicServerHost();
  const server = createAxiomServer({ ir, host, persistence: createMemoryPersistence(), integrations: { [INTEGRATION]: adapter } });
  await server.start();

  await server.handle({ kind: 'invoke', protocol: 'axiom.protocol.v1', actionId: ACTION_NOTIFY });
  await driveThroughRetries(host, () => calls.length, 2);
  await waitUntil(() => server.getState(STATE_MESSAGE) !== '');

  assert.equal(calls.length, 2, 'an absent retryable is not treated as false — the policy continues');
  assert.equal(server.getState(STATE_MESSAGE), 'ok after 2 attempts');
  await server.stop();
});
