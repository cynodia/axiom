import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the portable **workflow conformance** fixtures (`axiom.conformance.v8`, spec14
 * §156-§159). Each file carries a compiled `axiom.server.v8` Server IR, the start arguments,
 * a deterministic driver script, and the required logical transition history + terminal
 * state. Running one needs nothing from this repository but the in-memory `WorkflowStore`
 * and the semantics in `docs/WORKFLOWS.md`.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const compiler = await import(path.join(repoRoot, 'packages/compiler/dist/index.js'));
const { ApplicationGraph, binary, entityType, field, fieldId, literal, nodeId, primitiveType, ref } = core;

const A_DO = nodeId('action_do');
const A_ALT = nodeId('action_alt');
const EV = nodeId('event_go');
const E_PAY = nodeId('entity_pay');
const F_KEY = fieldId('field_pay_key');
const P_KEY = nodeId('input_key');
const P_FLAG = nodeId('input_flag');

function buildGraph() {
  const g = new ApplicationGraph('workflow-conformance', 'Workflow Conformance', version);
  g.addNode({ id: A_DO, kind: 'action', operations: [], invocation: { allowedSources: ['system'] } });
  g.addNode({ id: A_ALT, kind: 'action', operations: [], invocation: { allowedSources: ['system'] } });
  g.addNode({ id: E_PAY, kind: 'entity', fields: [{ id: F_KEY, valueType: primitiveType('string'), required: true }] });
  g.addNode({ id: EV, kind: 'event', payloadType: entityType(E_PAY) });

  // start-complete
  g.addNode({
    id: nodeId('wf_start_complete'), kind: 'workflow', entry: nodeId('c'),
    steps: [{ type: 'complete', id: nodeId('c') }],
  });
  // action-success / action-terminal-failure / action-on-error
  g.addNode({
    id: nodeId('wf_action'), kind: 'workflow', entry: nodeId('a'),
    steps: [
      { type: 'action', id: nodeId('a'), action: A_DO, arguments: {}, next: nodeId('done'), onError: nodeId('recover') },
      { type: 'action', id: nodeId('recover'), action: A_ALT, arguments: {}, next: nodeId('done') },
      { type: 'complete', id: nodeId('done') },
    ],
  });
  g.addNode({
    id: nodeId('wf_action_fail'), kind: 'workflow', entry: nodeId('a'),
    steps: [
      { type: 'action', id: nodeId('a'), action: A_DO, arguments: {}, next: nodeId('done') },
      { type: 'complete', id: nodeId('done') },
    ],
  });
  // action-retry
  g.addNode({
    id: nodeId('wf_retry'), kind: 'workflow', entry: nodeId('a'),
    steps: [
      {
        type: 'action', id: nodeId('a'), action: A_DO, arguments: {}, next: nodeId('done'),
        retry: { maxAttempts: 5, initialDelaySeconds: 1, backoffMultiplier: 2, maxDelaySeconds: 30 },
      },
      { type: 'complete', id: nodeId('done') },
    ],
  });
  // timer
  g.addNode({
    id: nodeId('wf_timer'), kind: 'workflow', entry: nodeId('t'),
    steps: [
      { type: 'timer', id: nodeId('t'), after: { seconds: 3600 }, next: nodeId('done') },
      { type: 'complete', id: nodeId('done') },
    ],
  });
  // event-match / event-nonmatch / event-timeout / cancel-waiting
  g.addNode({
    id: nodeId('wf_event'), kind: 'workflow',
    inputs: [{ id: P_KEY, valueType: primitiveType('string'), required: true }],
    entry: nodeId('w'),
    steps: [
      {
        type: 'wait-event', id: nodeId('w'), event: EV,
        where: binary('eq', field(ref('EVENT'), F_KEY), ref(P_KEY)),
        next: nodeId('done'), timeout: { seconds: 7200 }, onTimeout: nodeId('gaveup'),
      },
      { type: 'complete', id: nodeId('done') },
      { type: 'fail', id: nodeId('gaveup'), error: { reason: literal('timeout') } },
    ],
  });
  // branch-true / branch-false
  g.addNode({
    id: nodeId('wf_branch'), kind: 'workflow',
    inputs: [{ id: P_FLAG, valueType: primitiveType('boolean'), required: true }],
    entry: nodeId('b'),
    steps: [
      { type: 'branch', id: nodeId('b'), when: ref(P_FLAG), then: nodeId('yes'), else: nodeId('no') },
      { type: 'complete', id: nodeId('yes') },
      { type: 'fail', id: nodeId('no'), error: { reason: literal('flag-false') } },
    ],
  });

  const result = core.validateGraph(g);
  if (!result.valid) throw new Error(`workflow-conformance graph invalid:\n${JSON.stringify(result.errors, null, 2)}`);
  return g;
}

const serverIR = compiler.compileToServerIR(buildGraph());
if (serverIR.contract !== 'axiom.server.v8') throw new Error(`expected axiom.server.v8, got ${serverIR.contract}`);

const fixtures = [
  {
    name: 'workflow-start-complete', covers: ['start', 'complete'],
    description: 'A workflow whose entry step is `complete` finishes immediately.',
    workflowId: String(nodeId('wf_start_complete')), steps: [],
    expectHistory: ['started', 'completed'], expectStatus: 'completed',
  },
  {
    name: 'workflow-action-success', covers: ['action'],
    description: 'An action step succeeds and the workflow transitions to its next step.',
    workflowId: String(nodeId('wf_action')), steps: [],
    expectHistory: ['started', 'step-activated', 'step-succeeded', 'completed'], expectStatus: 'completed',
    expectActionInvocations: { [String(A_DO)]: 1 },
  },
  {
    name: 'workflow-action-terminal-failure', covers: ['action', 'fail'],
    description: 'A non-retryable action failure with no onError edge fails the workflow.',
    workflowId: String(nodeId('wf_action_fail')),
    actionOutcomes: { [String(A_DO)]: { ok: false, retryable: false } },
    steps: [],
    expectHistory: ['started', 'step-activated', 'failed'], expectStatus: 'failed',
    expectActionInvocations: { [String(A_DO)]: 1 },
  },
  {
    name: 'workflow-action-on-error', covers: ['action', 'onError'],
    description: 'A terminal action failure follows the declared onError edge.',
    workflowId: String(nodeId('wf_action')),
    actionOutcomes: { [String(A_DO)]: { ok: false, retryable: false } },
    steps: [],
    expectHistory: ['started', 'step-activated', 'step-failed', 'step-activated', 'step-succeeded', 'completed'],
    expectStatus: 'completed',
    expectActionInvocations: { [String(A_DO)]: 1, [String(A_ALT)]: 1 },
  },
  {
    name: 'workflow-action-retry', covers: ['action', 'retry'],
    description: 'A retryable failure backs off and the durable attempt count is not reset.',
    workflowId: String(nodeId('wf_retry')),
    actionOutcomes: { [String(A_DO)]: { ok: false, retryable: true } },
    steps: [
      { do: 'advance-clock', seconds: 2 },
      { do: 'poll' },
      { do: 'action-outcome', action: String(A_DO), ok: true },
      { do: 'advance-clock', seconds: 5 },
      { do: 'poll' },
    ],
    expectHistory: ['started', 'step-activated', 'retry-scheduled', 'step-activated', 'retry-scheduled', 'step-activated', 'step-succeeded', 'completed'],
    expectStatus: 'completed',
  },
  {
    name: 'workflow-timer', covers: ['timer'],
    description: 'A timer step waits, then fires exactly once after its captured target instant.',
    workflowId: String(nodeId('wf_timer')),
    steps: [{ do: 'advance-clock', seconds: 3600 }],
    expectHistory: ['started', 'step-activated', 'timer-fired', 'completed'], expectStatus: 'completed',
  },
  {
    name: 'workflow-event-match', covers: ['wait-event', 'correlation'],
    description: 'A wait-event step is unblocked by a matching event and completes.',
    workflowId: String(nodeId('wf_event')), arguments: { [String(P_KEY)]: 'k1' },
    steps: [{ do: 'deliver-event', eventId: String(EV), payload: { [String(F_KEY)]: 'k1' } }],
    expectHistory: ['started', 'step-activated', 'event-matched', 'completed'], expectStatus: 'completed',
  },
  {
    name: 'workflow-event-nonmatch', covers: ['wait-event', 'correlation'],
    description: 'A non-matching event does not transition the wait.',
    workflowId: String(nodeId('wf_event')), arguments: { [String(P_KEY)]: 'k1' },
    steps: [{ do: 'deliver-event', eventId: String(EV), payload: { [String(F_KEY)]: 'other' } }],
    expectHistory: ['started', 'step-activated'], expectStatus: 'waiting',
  },
  {
    name: 'workflow-event-timeout', covers: ['wait-event', 'timeout'],
    description: 'A wait-event timeout routes to the onTimeout edge.',
    workflowId: String(nodeId('wf_event')), arguments: { [String(P_KEY)]: 'k1' },
    steps: [{ do: 'advance-clock', seconds: 7200 }],
    expectHistory: ['started', 'step-activated', 'timeout-fired', 'failed'], expectStatus: 'failed',
  },
  {
    name: 'workflow-branch-true', covers: ['branch'],
    description: 'A branch chooses its `then` edge for a true condition.',
    workflowId: String(nodeId('wf_branch')), arguments: { [String(P_FLAG)]: true }, steps: [],
    expectHistory: ['started', 'branch-chosen', 'completed'], expectStatus: 'completed',
  },
  {
    name: 'workflow-branch-false', covers: ['branch'],
    description: 'A branch chooses its `else` edge for a false condition.',
    workflowId: String(nodeId('wf_branch')), arguments: { [String(P_FLAG)]: false }, steps: [],
    expectHistory: ['started', 'branch-chosen', 'failed'], expectStatus: 'failed',
  },
  {
    name: 'workflow-cancel-waiting', covers: ['cancel'],
    description: 'A waiting workflow becomes cancelled and a later event does not resume it.',
    workflowId: String(nodeId('wf_event')), arguments: { [String(P_KEY)]: 'k1' },
    steps: [
      { do: 'cancel' },
      { do: 'deliver-event', eventId: String(EV), payload: { [String(F_KEY)]: 'k1' } },
    ],
    expectHistory: ['started', 'step-activated', 'cancelled'], expectStatus: 'cancelled',
  },
  {
    name: 'workflow-start-idempotency', covers: ['start-idempotency'],
    description: 'Two starts with the same idempotency key are one logical instance.',
    workflowId: String(nodeId('wf_start_complete')), idempotencyKey: 'once', steps: [],
    expectHistory: ['started', 'completed'], expectStatus: 'completed',
  },
];

const dir = path.join(repoRoot, 'packages/server/conformance/workflow');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const manifest = {
  conformance: 'axiom.conformance.v8',
  baseContract: 'axiom.server.v8',
  protocol: 'axiom.protocol.v1',
  release: version,
  description:
    'Portable workflow conformance fixtures (spec14 §156-§159). Each file carries a compiled axiom.server.v8 Server IR, the start arguments, a deterministic driver script, and the required logical transition history + terminal state. Physical action attempts may be duplicated; the logical history must match exactly. Running one needs only the in-memory WorkflowStore and the semantics in docs/WORKFLOWS.md.',
  fixtures: [],
};

for (const fixture of fixtures) {
  const document = { conformance: 'axiom.conformance.v8', ...fixture, serverIR };
  await writeFile(path.join(dir, `${fixture.name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  manifest.fixtures.push({ name: fixture.name, covers: fixture.covers });
}
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${fixtures.length} workflow conformance fixtures to ${path.relative(repoRoot, dir)}`);
