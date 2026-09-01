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

// -------------------------------------------------------------- spec14pt3 F1: malformed steps

import { workflowStepSuccessors, workflowStepExpressions, workflowStructuralProblems } from '@cynodia/axiom-core';

test('spec14pt3 F1: an unknown / malformed workflow step yields a structured diagnostic, never a TypeError', () => {
  const shapes: Array<[string, unknown]> = [
    ['unknown string kind', { type: 'sleep', id: 'x', next: 'done' }],
    ['missing kind', { id: 'x', next: 'done' }],
    ['null kind', { type: null, id: 'x' }],
    ['numeric kind', { type: 123, id: 'x' }],
    ['step is null', null],
    ['step is a string', 'not-a-step'],
    ['step is an array', ['action']],
    ['empty object', {}],
  ];
  for (const [label, badStep] of shapes) {
    const g = base();
    g.addNode<WorkflowDef>({
      id: WF,
      kind: 'workflow',
      entry: nodeId('entry'),
      steps: [
        { type: 'branch', id: nodeId('entry'), when: literal(true), then: nodeId('done'), else: nodeId('done') },
        { type: 'complete', id: nodeId('done') },
        badStep as never,
      ],
    });
    let result: ReturnType<AgentAPI['validate']>;
    assert.doesNotThrow(() => {
      result = new AgentAPI(g).validate();
    }, `${label}: validateGraph must not throw`);
    const codes = result!.errors.map((e) => e.code);
    assert.ok(codes.includes('WORKFLOW_INVALID_STEP'), `${label}: emits WORKFLOW_INVALID_STEP (got ${codes.join(',')})`);
    // The accessors are total over the same bad input.
    assert.doesNotThrow(() => workflowStepSuccessors(badStep as never));
    assert.doesNotThrow(() => workflowStepExpressions(badStep as never));
    assert.deepEqual(workflowStepSuccessors(badStep as never), []);
  }
});

test('spec14pt3 F2: workflowStructuralProblems is total and flags the tampered shapes', () => {
  assert.deepEqual(workflowStructuralProblems({ id: nodeId('w'), kind: 'workflow', entry: nodeId('a'), steps: [
    { type: 'complete', id: nodeId('a') },
  ] } as WorkflowDef), []);
  const bad = workflowStructuralProblems({ id: nodeId('w'), kind: 'workflow', entry: nodeId('ghost'), steps: [
    { type: 'action', id: nodeId('a'), action: A_RESERVE, arguments: {}, next: nodeId('nowhere') } as never,
    null as never,
  ] } as WorkflowDef);
  const codes = bad.map((p) => p.code);
  assert.ok(codes.includes('WORKFLOW_ENTRY_NOT_FOUND'));
  assert.ok(codes.includes('WORKFLOW_STEP_NOT_FOUND'));
  assert.ok(codes.includes('WORKFLOW_INVALID_STEP'));
});

// ------------------------------------------------------- spec14pt4 F1: analyzeWorkflow totality

/**
 * The reusable malformed-step corpus (spec14pt4 §9). The SAME list is run through every
 * public workflow analysis / validation boundary; none may crash where another rejects.
 */
const MALFORMED_STEPS: Array<[string, unknown]> = [
  ['null step', null],
  ['undefined step', undefined],
  ['string step', 'not-a-step'],
  ['number step', 42],
  ['boolean step', true],
  ['array step', ['action']],
  ['empty object', {}],
  ['unknown string kind', { id: 's', type: 'sleep' }],
  ['missing kind', { id: 's' }],
  ['null kind', { id: 's', type: null }],
  ['numeric kind', { id: 's', type: 7 }],
];

function withBadStep(bad: unknown) {
  const g = base();
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    entry: nodeId('entry'),
    steps: [
      { type: 'branch', id: nodeId('entry'), when: literal(true), then: nodeId('done'), else: nodeId('done') },
      { type: 'complete', id: nodeId('done') },
      bad as never,
    ],
  });
  return g;
}

test('spec14pt4 F1: AgentAPI.analyzeWorkflow is total over the malformed-step corpus (no native error)', () => {
  for (const [label, bad] of MALFORMED_STEPS) {
    const g = withBadStep(bad);
    let threw: unknown;
    try {
      new AgentAPI(g).analyzeWorkflow(String(WF));
    } catch (error) {
      threw = error;
    }
    assert.ok(threw instanceof Error, `${label}: analyzeWorkflow rejected with a structured Error`);
    const name = (threw as Error).name;
    const msg = (threw as Error).message;
    assert.ok(
      name === 'Error' && !/TypeError|Cannot read|is not a function|undefined is not/.test(msg),
      `${label}: not a native error (got ${name}: ${msg})`,
    );
    assert.match(msg, /analyzeWorkflow|WORKFLOW_/, `${label}: structured message`);
  }
});

test('spec14pt4 F1/§8/§54: the malformed corpus is rejected consistently by validateGraph and analyzeWorkflow', () => {
  // The compileToServerIR surface is exercised in packages/server (which references the
  // compiler); here the two AgentAPI-visible surfaces must agree — one may not silently
  // accept what the other identifies as structurally impossible.
  for (const [label, bad] of MALFORMED_STEPS) {
    const g = withBadStep(bad);
    const result = new AgentAPI(g).validate();
    assert.ok(
      result.errors.map((x) => x.code).includes('WORKFLOW_INVALID_STEP'),
      `${label}: AgentAPI.validate flags WORKFLOW_INVALID_STEP`,
    );
    let native = false;
    try {
      new AgentAPI(g).analyzeWorkflow(String(WF));
    } catch (error) {
      const e = error as Error;
      native = /TypeError|Cannot read|is not a function/.test(`${e.name}: ${e.message}`);
    }
    assert.equal(native, false, `${label}: analyzeWorkflow produced no native error`);
  }
});

test('spec14pt4 F1: analyzeWorkflow still analyzes a valid workflow unchanged', () => {
  const g = base();
  g.addNode<WorkflowDef>(fulfillment());
  const analysis = new AgentAPI(g).analyzeWorkflow(String(WF));
  assert.equal(analysis.entry, String(nodeId('reserve')));
  assert.deepEqual(analysis.actionDependencies, [String(A_RELEASE), String(A_RESERVE), String(A_SHIP)]);
  assert.equal(analysis.acyclic, true);
});
