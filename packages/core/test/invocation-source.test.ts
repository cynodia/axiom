import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  VALIDATION_CODES,
  allowedInvocationSources,
  collectionType,
  entityType,
  fieldId,
  isClientInvocable,
  isSystemOnlyAction,
  literal,
  nodeId,
  primitiveType,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  EntityDef,
  EventDef,
  RouteDef,
  StateDef,
  TriggerDef,
  ViewNode,
} from '@cynodia/axiom-core';

/** Spec 8.1 §3-14: an action may restrict who invokes it independently of `authorization`. */

const ENTITY = nodeId('entity_record_08_1');
const F_ID = fieldId('field_record_id_08_1');
const STATE_SERVER = nodeId('state_server_records_08_1');
const STATE_CLIENT = nodeId('state_client_records_08_1');
const VIEW = nodeId('ui_root_view_08_1');
const ROUTE = nodeId('route_root_08_1');
const ACTION_SERVER = nodeId('action_server_write_08_1');
const ACTION_CLIENT = nodeId('action_client_write_08_1');
const EVENT = nodeId('event_something_08_1');

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('invocation-source', 'Invocation source');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [{ id: F_ID, valueType: primitiveType('string'), required: true }],
  });
  graph.addNode<StateDef>({
    id: STATE_SERVER,
    kind: 'state',
    authority: 'server',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<StateDef>({
    id: STATE_CLIENT,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<ActionDef>({
    id: ACTION_SERVER,
    kind: 'action',
    operations: [{ kind: 'set', target: stateLocation(STATE_SERVER), value: literal([]) }],
  });
  graph.addNode<ActionDef>({
    id: ACTION_CLIENT,
    kind: 'action',
    operations: [{ kind: 'set', target: stateLocation(STATE_CLIENT), value: literal([]) }],
  });
  graph.addNode<EventDef>({ id: EVENT, kind: 'event', payloadType: primitiveType('string') });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

function restrict(graph: ApplicationGraph, actionId: typeof ACTION_SERVER, allowedSources: ('client' | 'system')[]): void {
  const action = graph.getNode(actionId) as ActionDef;
  graph.updateNode({ ...action, invocation: { allowedSources } });
}

function codes(graph: ApplicationGraph): string[] {
  return validateGraph(graph).errors.map((issue) => issue.code);
}

// ---------------------------------------------------------------- helpers

test('an action with no invocation policy allows both sources', () => {
  const action: ActionDef = { id: ACTION_SERVER, kind: 'action', operations: [] };
  assert.deepEqual(allowedInvocationSources(action), ['client', 'system']);
  assert.equal(isClientInvocable(action), true);
  assert.equal(isSystemOnlyAction(action), false);
});

test('an action restricted to system is not client-invocable', () => {
  const action: ActionDef = {
    id: ACTION_SERVER,
    kind: 'action',
    operations: [],
    invocation: { allowedSources: ['system'] },
  };
  assert.equal(isClientInvocable(action), false);
  assert.equal(isSystemOnlyAction(action), true);
});

test('an action restricted to client only is not system-only', () => {
  const action: ActionDef = {
    id: ACTION_SERVER,
    kind: 'action',
    operations: [],
    invocation: { allowedSources: ['client'] },
  };
  assert.equal(isClientInvocable(action), true);
  assert.equal(isSystemOnlyAction(action), false);
});

// ---------------------------------------------------------- trigger/source validation

test('a trigger targeting a system-only action validates', () => {
  const graph = baseGraph();
  restrict(graph, ACTION_SERVER, ['system']);
  graph.addNode<TriggerDef>({
    id: nodeId('trigger_event_08_1'),
    kind: 'trigger',
    actionId: ACTION_SERVER,
    when: { kind: 'event', eventId: EVENT },
  });
  assert.deepEqual(codes(graph).filter((code) => code === VALIDATION_CODES.triggerTargetSourceMismatch), []);
});

test('a trigger targeting a client-only action is rejected: it could never succeed', () => {
  const graph = baseGraph();
  restrict(graph, ACTION_SERVER, ['client']);
  graph.addNode<TriggerDef>({
    id: nodeId('trigger_event_08_1'),
    kind: 'trigger',
    actionId: ACTION_SERVER,
    when: { kind: 'event', eventId: EVENT },
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.triggerTargetSourceMismatch));
});

test('an empty allowedSources array is rejected: the action could never be invoked', () => {
  const graph = baseGraph();
  restrict(graph, ACTION_SERVER, []);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidInvocationSource));
});

// ---------------------------------------------------------- client trigger capability gate

test('a client-authority interval trigger is unsupported by a trigger runtime with no capabilities', () => {
  const graph = baseGraph();
  graph.addNode<TriggerDef>({
    id: nodeId('trigger_interval_08_1'),
    kind: 'trigger',
    actionId: ACTION_CLIENT,
    when: { kind: 'interval', everyMs: 1000 },
  });
  const result = validateGraph(graph, { triggerRuntime: { target: 'browser', supportedTriggerKinds: [] } });
  assert.ok(result.errors.some((issue) => issue.code === VALIDATION_CODES.clientTriggerUnsupported));
});

test('a client-authority interval trigger validates when the named trigger runtime supports it', () => {
  const graph = baseGraph();
  graph.addNode<TriggerDef>({
    id: nodeId('trigger_interval_08_1'),
    kind: 'trigger',
    actionId: ACTION_CLIENT,
    when: { kind: 'interval', everyMs: 1000 },
  });
  const result = validateGraph(graph, {
    triggerRuntime: { target: 'test-runtime', supportedTriggerKinds: ['interval'] },
  });
  assert.deepEqual(
    result.errors.filter((issue) => issue.code === VALIDATION_CODES.clientTriggerUnsupported),
    [],
  );
});

test('a client-authority interval trigger validates when no trigger runtime is named at all', () => {
  const graph = baseGraph();
  graph.addNode<TriggerDef>({
    id: nodeId('trigger_interval_08_1'),
    kind: 'trigger',
    actionId: ACTION_CLIENT,
    when: { kind: 'interval', everyMs: 1000 },
  });
  assert.deepEqual(codes(graph).filter((code) => code === VALIDATION_CODES.clientTriggerUnsupported), []);
});

test('a server-authority trigger of any kind is unaffected by trigger runtime capabilities', () => {
  const graph = baseGraph();
  graph.addNode<TriggerDef>({
    id: nodeId('trigger_interval_08_1'),
    kind: 'trigger',
    actionId: ACTION_SERVER,
    when: { kind: 'interval', everyMs: 1000 },
  });
  const result = validateGraph(graph, { triggerRuntime: { target: 'browser', supportedTriggerKinds: [] } });
  assert.deepEqual(
    result.errors.filter((issue) => issue.code === VALIDATION_CODES.clientTriggerUnsupported),
    [],
  );
});
