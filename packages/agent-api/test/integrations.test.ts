import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationGraph, nodeId, primitiveType, stateLocation } from '@cynodia/axiom-core';
import type {
  ActionDef,
  EventDef,
  IntegrationDef,
  IntegrationOperationDef,
  StateDef,
  TriggerDef,
} from '@cynodia/axiom-core';
import { AgentAPI } from '@cynodia/axiom-agent-api';

/**
 * AgentAPI over integrations, effects, triggers and events — an agent should be able to
 * answer "what external systems can this application reach, and what runs automatically"
 * without reading source (spec §77-78).
 */

const INTEGRATION = nodeId('integration_provider');
const OP_QUERY = nodeId('integration_operation_query');
const OP_EFFECT = nodeId('integration_operation_effect');

const STATE_STATUS = nodeId('state_status');
const ACTION_REFRESH = nodeId('action_refresh');
const ACTION_REBOOT = nodeId('action_reboot');
const SCOPE_QUERY = nodeId('scope_query');

const EVENT_CHANGED = nodeId('event_changed');
const TRIGGER_INTERVAL = nodeId('trigger_interval');
const TRIGGER_EVENT = nodeId('trigger_event');
const ACTION_APPLY = nodeId('action_apply');
const PARAM_STATUS = nodeId('param_status');

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('agent-api-integrations', 'Agent API integrations');

  graph.addNode<StateDef>({
    id: STATE_STATUS,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('string'),
    initialValue: 'unknown',
  });

  graph.addNode<IntegrationDef>({ id: INTEGRATION, kind: 'integration', name: 'Device provider' });
  graph.addNode<IntegrationOperationDef>({
    id: OP_QUERY,
    kind: 'integration-operation',
    integrationId: INTEGRATION,
    mode: 'query',
    resultType: primitiveType('string'),
  });
  graph.addNode<IntegrationOperationDef>({
    id: OP_EFFECT,
    kind: 'integration-operation',
    integrationId: INTEGRATION,
    mode: 'effect',
    resultType: primitiveType('string'),
  });

  graph.addNode<ActionDef>({
    id: ACTION_REFRESH,
    kind: 'action',
    operations: [
      { kind: 'integration-query', operationId: OP_QUERY, bindAs: SCOPE_QUERY },
      { kind: 'set', target: stateLocation(STATE_STATUS), value: { kind: 'ref', targetId: SCOPE_QUERY } },
    ],
  });
  graph.addNode<ActionDef>({
    id: ACTION_REBOOT,
    kind: 'action',
    operations: [{ kind: 'integration-effect', operationId: OP_EFFECT }],
  });

  graph.addNode<EventDef>({ id: EVENT_CHANGED, kind: 'event', payloadType: primitiveType('string') });
  graph.addNode<ActionDef>({
    id: ACTION_APPLY,
    kind: 'action',
    parameters: [{ id: PARAM_STATUS, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(STATE_STATUS), value: { kind: 'ref', targetId: PARAM_STATUS } }],
  });

  graph.addNode<TriggerDef>({
    id: TRIGGER_INTERVAL,
    kind: 'trigger',
    actionId: ACTION_REFRESH,
    when: { kind: 'interval', everyMs: 5000 },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_EVENT,
    kind: 'trigger',
    actionId: ACTION_APPLY,
    when: { kind: 'event', eventId: EVENT_CHANGED },
    arguments: { [String(PARAM_STATUS)]: { kind: 'ref', targetId: TRIGGER_EVENT } },
  });

  return graph;
}

test('listIntegrations and listIntegrationOperations enumerate the external capability model', () => {
  const agent = new AgentAPI(buildGraph());
  assert.deepEqual(agent.listIntegrations().map((integration) => integration.id), [INTEGRATION]);
  assert.deepEqual(
    agent.listIntegrationOperations(INTEGRATION).map((operation) => operation.id).sort(),
    [OP_EFFECT, OP_QUERY].sort(),
  );
});

test('getActionsUsingIntegration finds every action that calls into it, query or effect', () => {
  const agent = new AgentAPI(buildGraph());
  assert.deepEqual(
    agent.getActionsUsingIntegration(INTEGRATION).map((action) => action.id).sort(),
    [ACTION_REBOOT, ACTION_REFRESH].sort(),
  );
});

test('getEffectsForAction reports only the effect-mode operations, not queries', () => {
  const agent = new AgentAPI(buildGraph());
  assert.deepEqual(agent.getEffectsForAction(ACTION_REBOOT).map((operation) => operation.id), [OP_EFFECT]);
  assert.deepEqual(agent.getEffectsForAction(ACTION_REFRESH), []);
});

test('getTriggersForAction and getTimedTriggers answer what runs automatically', () => {
  const agent = new AgentAPI(buildGraph());
  assert.deepEqual(agent.getTriggersForAction(ACTION_REFRESH).map((trigger) => trigger.id), [TRIGGER_INTERVAL]);
  assert.deepEqual(agent.getTimedTriggers().map((trigger) => trigger.id), [TRIGGER_INTERVAL]);
});

test('getActionsTriggeredByEvent and getWebhookEvents follow event-kind triggers', () => {
  const agent = new AgentAPI(buildGraph());
  assert.deepEqual(agent.getActionsTriggeredByEvent(EVENT_CHANGED).map((action) => action.id), [ACTION_APPLY]);
  assert.deepEqual(agent.getWebhookEvents().map((event) => event.id), [EVENT_CHANGED]);
});

test('getExternalDependencies is the machine-discoverable external dependency manifest', () => {
  const agent = new AgentAPI(buildGraph());
  const dependencies = agent.getExternalDependencies();
  assert.deepEqual(dependencies.integrations.map((integration) => integration.id), [INTEGRATION]);
  assert.deepEqual(dependencies.operations.map((operation) => operation.id).sort(), [OP_EFFECT, OP_QUERY].sort());
});
