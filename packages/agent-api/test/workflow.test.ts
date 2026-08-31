import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, EventDef, StateDef, WorkflowDef } from '@cynodia/axiom-core';
import { AgentAPI, analyzeWorkflow } from '@cynodia/axiom-agent-api';

/**
 * spec14 §121-§125, §138, §139 — static workflow validation + AgentAPI analysis.
 */

const A_RESERVE = nodeId('action_reserve');
const A_SHIP = nodeId('action_ship');
const A_RELEASE = nodeId('action_release');
const EV_PAID = nodeId('event_paid');
const E_PAY = nodeId('entity_pay');
const F_ORDER = fieldId('field_pay_order');
const P_ORDER = nodeId('input_order');
const B_TXN = nodeId('binding_txn');
const WF = nodeId('wf_fulfillment');

function base(): ApplicationGraph {
  const g = new ApplicationGraph('wf', 'WF');
  for (const id of [A_RESERVE, A_SHIP, A_RELEASE]) {
    g.addNode<ActionDef>({ id, kind: 'action', operations: [] });
  }
  g.addNode<EntityDef>({ id: E_PAY, kind: 'entity', fields: [{ id: F_ORDER, valueType: primitiveType('string'), required: true }] });
  g.addNode<EventDef>({ id: EV_PAID, kind: 'event', payloadType: entityType(E_PAY) });
  return g;
}

function fulfillment(): WorkflowDef {
  return {
    id: WF,
    kind: 'workflow',
    inputs: [{ id: P_ORDER, valueType: primitiveType('string'), required: true }],
    bindings: [{ id: B_TXN, valueType: primitiveType('string'), producedBy: nodeId('wait') }],
    entry: nodeId('reserve'),
    steps: [
      { type: 'action', id: nodeId('reserve'), action: A_RESERVE, arguments: { orderId: ref(P_ORDER) }, next: nodeId('wait'), retry: { maxAttempts: 3, initialDelaySeconds: 1, backoffMultiplier: 2, maxDelaySeconds: 10 } },
      {
        type: 'wait-event',
        id: nodeId('wait'),
        event: EV_PAID,
        where: binary('eq', field(ref('EVENT' as never), F_ORDER), ref(P_ORDER)),
        bind: { [String(B_TXN)]: field(ref('EVENT' as never), F_ORDER) },
        next: nodeId('ship'),
        timeout: { seconds: 600_000 },
        onTimeout: nodeId('release'),
      },
      { type: 'action', id: nodeId('ship'), action: A_SHIP, arguments: {}, next: nodeId('done') },
      { type: 'action', id: nodeId('release'), action: A_RELEASE, arguments: {}, next: nodeId('aborted') },
      { type: 'complete', id: nodeId('done') },
      { type: 'fail', id: nodeId('aborted'), error: { reason: literal('timeout') } },
    ],
  };
}

test('analyzeWorkflow reports inputs, steps, dependencies, terminals and wait reasons', () => {
  const g = base();
  g.addNode<WorkflowDef>(fulfillment());
  const a = analyzeWorkflow(g, String(WF));
  assert.deepEqual(a.inputs, [{ id: String(P_ORDER), required: true }]);
  assert.equal(a.entry, String(nodeId('reserve')));
  assert.equal(a.acyclic, true);
  assert.deepEqual(a.actionDependencies, [String(A_RELEASE), String(A_RESERVE), String(A_SHIP)]);
  assert.deepEqual(a.eventDependencies, [String(EV_PAID)]);
  assert.deepEqual(a.terminalOutcomes, { completed: [String(nodeId('done'))], failed: [String(nodeId('aborted'))] });
  assert.deepEqual(a.possibleWaitReasons, ['event', 'ownership', 'retry']);
  assert.equal(a.authorizationContext, 'workflow-bound-principal');
  const wait = a.steps.find((s) => s.type === 'wait-event');
  assert.deepEqual(wait?.event, { eventId: String(EV_PAID), hasWhere: true, timeout: true, onTimeout: String(nodeId('release')), binds: [String(B_TXN)] });
  assert.equal(a.steps.find((s) => s.id === String(nodeId('reserve')))?.action?.retry, true);
});

test('AgentAPI.analyzeWorkflow is the class entry point', () => {
  const g = base();
  g.addNode<WorkflowDef>(fulfillment());
  assert.equal(new AgentAPI(g).analyzeWorkflow(String(WF)).workflowId, String(WF));
});

test('validateGraph rejects a control-flow cycle (spec14 §11)', () => {
  const g = base();
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    entry: nodeId('a'),
    steps: [
      { type: 'branch', id: nodeId('a'), when: literal(true), then: nodeId('b'), else: nodeId('done') },
      { type: 'branch', id: nodeId('b'), when: literal(true), then: nodeId('a'), else: nodeId('done') },
      { type: 'complete', id: nodeId('done') },
    ],
  });
  const errors = new AgentAPI(g).validate().errors.map((e) => e.code);
  assert.ok(errors.includes('WORKFLOW_CYCLE_NOT_ALLOWED'), errors.join(','));
});

test('validateGraph rejects an unknown edge target and an unreachable step (spec14 §121, §122)', () => {
  const g = base();
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    entry: nodeId('a'),
    steps: [
      { type: 'action', id: nodeId('a'), action: A_RESERVE, arguments: {}, next: nodeId('nowhere') },
      { type: 'complete', id: nodeId('orphan') },
    ],
  });
  const errors = new AgentAPI(g).validate().errors.map((e) => e.code);
  assert.ok(errors.includes('WORKFLOW_STEP_NOT_FOUND'));
  assert.ok(errors.includes('WORKFLOW_UNREACHABLE_STEP'));
});

test('validateGraph rejects a workflow expression that references a StateDef (spec14 §127)', () => {
  const g = base();
  g.addNode<StateDef>({ id: nodeId('state_flag'), kind: 'state', valueType: primitiveType('boolean'), initialValue: false });
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    entry: nodeId('br'),
    steps: [
      { type: 'branch', id: nodeId('br'), when: ref(nodeId('state_flag')), then: nodeId('ok'), else: nodeId('no') },
      { type: 'complete', id: nodeId('ok') },
      { type: 'fail', id: nodeId('no') },
    ],
  });
  const errors = new AgentAPI(g).validate().errors.map((e) => e.code);
  assert.ok(errors.includes('WORKFLOW_EXPRESSION_SCOPE'), errors.join(','));
});

test('validateGraph rejects a nondeterministic workflow expression (spec14 §129)', () => {
  const g = base();
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    entry: nodeId('br'),
    steps: [
      { type: 'branch', id: nodeId('br'), when: { kind: 'call', function: 'uuid', arguments: [] } as never, then: nodeId('ok'), else: nodeId('no') },
      { type: 'complete', id: nodeId('ok') },
      { type: 'fail', id: nodeId('no') },
    ],
  });
  const errors = new AgentAPI(g).validate().errors.map((e) => e.code);
  assert.ok(errors.includes('WORKFLOW_NONDETERMINISTIC'), errors.join(','));
});
