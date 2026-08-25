import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, RouteDef, StateDef, TriggerDef, ViewNode } from '@cynodia/axiom-core';
import { BROWSER_TRIGGER_CAPABILITIES } from '@cynodia/axiom-runtime';
import { compileToIR, compileToServerIR } from '@cynodia/axiom-compiler';

/**
 * Spec 8.1 §31-36: before this, a client-authority trigger validated, compiled into
 * `ApplicationIR.triggers`, and the browser runtime silently never fired it. The browser's
 * published capability set is now empty, so the gate that already protects UI node kinds
 * (`renderability.test.ts`) rejects such a graph at authoring time instead.
 */

const ENTITY = nodeId('entity_note_08_1');
const STATE_SERVER = nodeId('state_server_08_1');
const STATE_CLIENT = nodeId('state_client_08_1');
const ACTION_SERVER = nodeId('action_server_08_1');
const ACTION_CLIENT = nodeId('action_client_08_1');

function graphWithClientTrigger(): ApplicationGraph {
  const graph = new ApplicationGraph('trigger-capabilities', 'Trigger capabilities');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    fields: [{ id: fieldId('field_note_id_08_1'), valueType: primitiveType('string'), required: true }],
  });
  graph.addNode<StateDef>({
    id: STATE_SERVER,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('string'),
    initialValue: '',
  });
  graph.addNode<StateDef>({
    id: STATE_CLIENT,
    kind: 'state',
    valueType: primitiveType('string'),
    initialValue: '',
  });
  graph.addNode<ActionDef>({
    id: ACTION_SERVER,
    kind: 'action',
    operations: [{ kind: 'set', target: stateLocation(STATE_SERVER), value: literal('x') }],
  });
  graph.addNode<ActionDef>({
    id: ACTION_CLIENT,
    kind: 'action',
    operations: [{ kind: 'set', target: stateLocation(STATE_CLIENT), value: literal('x') }],
  });
  graph.addNode<TriggerDef>({
    id: nodeId('trigger_client_interval_08_1'),
    kind: 'trigger',
    actionId: ACTION_CLIENT,
    when: { kind: 'interval', everyMs: 1000 },
  });
  graph.addNode<ViewNode>({ id: nodeId('ui_view_08_1'), kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route_08_1'), kind: 'route', path: '/', viewId: nodeId('ui_view_08_1') });
  return graph;
}

test('the browser trigger runtime publishes no supported trigger kind', () => {
  assert.deepEqual([...BROWSER_TRIGGER_CAPABILITIES.supportedTriggerKinds], []);
});

test('compileToIR applies the browser trigger capabilities by default, and refuses a client trigger', () => {
  const graph = graphWithClientTrigger();
  assert.throws(() => compileToIR(graph), /GraphValidationError|CLIENT_TRIGGER_UNSUPPORTED/);
});

test('a trigger runtime that supports the kind accepts the same graph', () => {
  const graph = graphWithClientTrigger();
  assert.doesNotThrow(() =>
    compileToIR(graph, { triggerRuntime: { target: 'test-runtime', supportedTriggerKinds: ['interval'] } }),
  );
});

test('validation with no named trigger runtime accepts every client trigger kind', () => {
  assert.deepEqual(
    validateGraph(graphWithClientTrigger()).errors.filter((error) => error.code === 'CLIENT_TRIGGER_UNSUPPORTED'),
    [],
  );
});

test('compileToServerIR is unaffected: a client-authority trigger is simply absent from the server half', () => {
  const graph = graphWithClientTrigger();
  assert.doesNotThrow(() => compileToServerIR(graph));
});
