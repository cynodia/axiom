import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationGraph, nodeId, primitiveType, stateLocation } from '@cynodia/axiom-core';
import type {
  ActionDef,
  IntegrationDef,
  IntegrationOperationDef,
  StateDef,
  SubscriptionDef,
  TriggerDef,
} from '@cynodia/axiom-core';
import { AgentAPI, inspectDistributedSemantics } from '@cynodia/axiom-agent-api';

/**
 * spec12 §56, §57: AgentAPI distributed-authority inspection (static, over the graph).
 */

const INT = nodeId('integration_x');
const OP_EFFECT = nodeId('integration_operation_notify');
const S_COUNT = nodeId('state_count');
const A_NOTIFY = nodeId('action_notify');
const A_PLAIN = nodeId('action_plain');
const T_INTERVAL = nodeId('trigger_tick');
const T_EVENT = nodeId('trigger_on_event');
const EV = nodeId('event_thing');

function buildGraph(withSubscription = false): ApplicationGraph {
  const graph = new ApplicationGraph('dist', 'Dist');
  graph.addNode<StateDef>({
    id: S_COUNT,
    kind: 'state',
    name: 'count',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  graph.addNode<IntegrationDef>({ id: INT, kind: 'integration', name: 'X' });
  graph.addNode<IntegrationOperationDef>({
    id: OP_EFFECT,
    kind: 'integration-operation',
    integrationId: INT,
    name: 'notify',
    mode: 'effect',
    resultType: primitiveType('string'),
  });
  graph.addNode<ActionDef>({
    id: A_NOTIFY,
    kind: 'action',
    name: 'notify',
    operations: [{ kind: 'integration-effect', operationId: OP_EFFECT }],
  });
  graph.addNode<ActionDef>({
    id: A_PLAIN,
    kind: 'action',
    name: 'plain',
    operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: { kind: 'literal', value: 1 } }],
  });
  graph.addNode<TriggerDef>({
    id: T_INTERVAL,
    kind: 'trigger',
    name: 'tick',
    when: { kind: 'interval', everyMs: 60_000 },
    actionId: A_PLAIN,
  });
  graph.addNode<TriggerDef>({
    id: T_EVENT,
    kind: 'trigger',
    name: 'on event',
    when: { kind: 'event', eventId: EV },
    actionId: A_PLAIN,
  });
  if (withSubscription) {
    graph.addNode<SubscriptionDef>({
      id: nodeId('subscription_feed'),
      kind: 'subscription',
      name: 'feed',
      integrationId: INT,
      eventId: EV,
    });
  }
  return graph;
}

test('inspectDistributedSemantics enumerates the framework-owned async work classes (spec12 §56)', () => {
  const info = inspectDistributedSemantics(buildGraph(true));

  assert.equal(info.activation, 'automatic-when-coordination-provider-and-durable-persistence-shared');

  const classes = new Map(info.workClasses.map((wc) => [wc.workClass, wc]));
  assert.ok(classes.has('effect'));
  assert.ok(classes.has('schedule-firing'));
  assert.ok(classes.has('subscription-delivery'));

  // effect: only the action that actually has an effect operation is a source
  assert.deepEqual(classes.get('effect')?.sources, ['action_notify']);
  assert.deepEqual(classes.get('effect')?.delivery, {
    logicalCreation: 'exactly-once',
    physicalExecution: 'at-least-once',
    completionTransition: 'exactly-once',
  });
  assert.equal(classes.get('effect')?.orderingScope, 'none');

  // schedule-firing: only the interval trigger, not the event trigger
  assert.deepEqual(classes.get('schedule-firing')?.sources, ['trigger_tick']);

  // subscription-delivery: per-subscription ordering, at-least-once, duplicates possible
  assert.equal(classes.get('subscription-delivery')?.orderingScope, 'per-subscription');
  assert.deepEqual(classes.get('subscription-delivery')?.delivery, {
    guarantee: 'at-least-once',
    duplicatesPossible: true,
  });
});

test('the four §56 categories are kept separate', () => {
  const wc = inspectDistributedSemantics(buildGraph()).workClasses[0]!;
  assert.equal(wc.ownership, 'leased-per-work-item-fenced'); // semantic guarantee
  assert.match(wc.runtimeStateAvailableFrom, /AxiomServer/); // where the live state is
  assert.ok(wc.providerCapabilityRequired.includes('fencing')); // provider capability
  // operational tuning is on the top-level inspection, never mixed into a guarantee
  assert.deepEqual(inspectDistributedSemantics(buildGraph()).operationalTuning, [
    'instanceId',
    'leaseDurationMs',
    'renewIntervalMs',
    'workerConcurrency',
    'claimBatchSize',
    'pollIntervalMs',
  ]);
});

test('compatibility identity is the four-field key, fail-closed, exposed through AgentAPI (spec12 §45, §56)', () => {
  const agent = new AgentAPI(buildGraph());
  const info = agent.inspectDistributedSemantics();
  assert.equal(info.compatibility.serverContract, 'axiom.server.v7');
  assert.match(info.compatibility.semanticFingerprint, /^[0-9a-f]{64}$/);
  assert.match(info.compatibility.schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(info.compatibility.schemaVersion, 1);
  assert.match(info.compatibility.note, /fail closed/i);

  // A graph with a different action body changes the semantic fingerprint but not the schema one.
  const other = buildGraph();
  const action = other.getNode(A_NOTIFY) as ActionDef;
  other.updateNode({ ...action, requiresConfirmation: true });
  const otherInfo = inspectDistributedSemantics(other);
  assert.equal(otherInfo.compatibility.schemaFingerprint, info.compatibility.schemaFingerprint);
  assert.notEqual(otherInfo.compatibility.semanticFingerprint, info.compatibility.semanticFingerprint);
});

test('an application with no async work reports no work classes but still a compatibility key', () => {
  const graph = new ApplicationGraph('bare', 'Bare');
  graph.addNode<StateDef>({
    id: S_COUNT,
    kind: 'state',
    name: 'c',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  const info = inspectDistributedSemantics(graph);
  assert.deepEqual(info.workClasses, []);
  assert.match(info.compatibility.semanticFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(info.cacheCoherence.stalenessBoundRevisions, 0);
});
