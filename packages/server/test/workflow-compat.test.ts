import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  EXECUTABLE_KINDS,
  compareAuthorityCompatibility,
  binary,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, EventDef, StateDef, WorkflowDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  SERVER_IR_EXECUTABLE_SLICES,
  WorkflowIRError,
  createMemoryWorkflowStore,
  createWorkflowEngine,
  serverIrCompatibilityKey,
  serverIrSemanticFingerprint,
  serverIrSemanticProjection,
} from '@cynodia/axiom-server';
import type { ServerIR } from '@cynodia/axiom-server';

/**
 * spec14pt3 F3 — `WorkflowDef` executable meaning must participate in the authority
 * compatibility key. Phase 22 proved a workflow semantic change (action target, event id,
 * branch predicate, timer duration, ...) produced a different `semanticFingerprint(graph)`
 * yet `authorityA.compatibilityKey.semanticFingerprint == authorityB...` — so an
 * incompatible authority silently advanced an in-flight instance. These tests pin that the
 * ServerIR-side projection now derives from the *same* `EXECUTABLE_KINDS` list and reflects
 * every workflow executable field.
 */

const S_COUNT = nodeId('state_count');
const A_A = nodeId('action_a');
const A_B = nodeId('action_b');
const EV_GO = nodeId('event_go');
const EV_ALT = nodeId('event_alt');
const E_SIG = nodeId('entity_sig');
const F_K = fieldId('field_sig_key');
const WF = nodeId('wf_x');
const IN_K = nodeId('input_k');

interface Knobs {
  event?: string;
  action?: string;
  after?: number;
  branchConst?: string;
  actionNext?: string;
  onError?: string;
  retry?: boolean;
  where?: boolean;
  timeout?: number;
  completeOut?: string;
  failErr?: string;
  entry?: string;
  description?: string;
  stepsReversed?: boolean;
}

function ir(k: Knobs = {}): ServerIR {
  const g = new ApplicationGraph('wc', 'Workflow Compat');
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<EntityDef>({ id: E_SIG, kind: 'entity', fields: [{ id: F_K, valueType: primitiveType('string'), required: true }] });
  g.addNode<EventDef>({ id: EV_GO, kind: 'event', payloadType: entityType(E_SIG) });
  g.addNode<EventDef>({ id: EV_ALT, kind: 'event', payloadType: entityType(E_SIG) });
  for (const [id, inc] of [[A_A, 1], [A_B, 2]] as const) {
    g.addNode<ActionDef>({
      id,
      kind: 'action',
      invocation: { allowedSources: ['system'] },
      operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(inc)) }],
    });
  }
  const steps: WorkflowDef['steps'] = [
    {
      type: 'wait-event',
      id: nodeId('s_wait'),
      event: nodeId(k.event ?? String(EV_GO)),
      ...(k.where ? { where: binary('eq', field(ref('EVENT' as never), F_K), ref(IN_K)) } : {}),
      ...(k.timeout ? { timeout: { seconds: k.timeout }, onTimeout: nodeId('s_fail') } : {}),
      next: nodeId('s_branch'),
    },
    {
      type: 'branch',
      id: nodeId('s_branch'),
      when: binary('eq', ref(IN_K), literal(k.branchConst ?? 'go')),
      then: nodeId('s_timer'),
      else: nodeId('s_fail'),
    },
    { type: 'timer', id: nodeId('s_timer'), after: { seconds: k.after ?? 60 }, next: nodeId('s_act') },
    {
      type: 'action',
      id: nodeId('s_act'),
      action: nodeId(k.action ?? String(A_A)),
      arguments: {},
      next: nodeId(k.actionNext ?? 's_done'),
      ...(k.onError ? { onError: nodeId(k.onError) } : {}),
      ...(k.retry ? { retry: { maxAttempts: 4, initialDelaySeconds: 1, backoffMultiplier: 2, maxDelaySeconds: 30 } } : {}),
    },
    { type: 'complete', id: nodeId('s_done'), output: { r: literal(k.completeOut ?? 'ok') } },
    { type: 'fail', id: nodeId('s_fail'), error: { reason: literal(k.failErr ?? 'no') } },
  ];
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    ...(k.description ? { description: k.description } : {}),
    inputs: [{ id: IN_K, valueType: primitiveType('string'), required: true }],
    entry: nodeId(k.entry ?? 's_wait'),
    steps: k.stepsReversed ? [...steps].reverse() : steps,
  });
  // `validate: false`: these are semantic-identity / projection tests, and several
  // deliberately rewire an edge (which orphans a step) purely to prove the fingerprint
  // responds. Graph validity is covered by validateGraph tests elsewhere.
  return compileToServerIR(g, { validate: false });
}

const semOf = (k?: Knobs) => serverIrSemanticFingerprint(ir(k));
const keyOf = (k?: Knobs) => serverIrCompatibilityKey(ir(k));

test('spec14pt3 §5/§189: every core EXECUTABLE_KIND is projected into the authority fingerprint', () => {
  for (const kind of EXECUTABLE_KINDS) {
    assert.ok(kind in SERVER_IR_EXECUTABLE_SLICES, `EXECUTABLE_KIND ${kind} has a ServerIR slice — cannot silently escape authority compatibility`);
  }
  assert.ok('workflows' in serverIrSemanticProjection(ir()), 'a workflow graph projects a workflows slice');
  assert.ok(!('workflows' in serverIrSemanticProjection(compileToServerIR(new ApplicationGraph('n', 'n')))), 'a non-workflow graph does not — its fingerprint is unperturbed');
});

test('spec14pt3 F3: each workflow executable change flips the authority semantic fingerprint', () => {
  const base = semOf();
  const mutations: Array<[string, Knobs]> = [
    ['wait-event event id', { event: String(EV_ALT) }],
    ['wait-event where (correlation)', { where: true }],
    ['wait-event timeout', { timeout: 3600 }],
    ['action target', { action: String(A_B) }],
    ['action next edge', { actionNext: 's_fail' }],
    ['action onError edge', { onError: 's_fail' }],
    ['action retry policy', { retry: true }],
    ['timer duration', { after: 600 }],
    ['branch predicate constant', { branchConst: 'nope' }],
    ['complete output', { completeOut: 'different' }],
    ['fail error', { failErr: 'other' }],
    ['entry step', { entry: 's_branch' }],
  ];
  for (const [label, k] of mutations) {
    assert.notEqual(semOf(k), base, `${label}: fingerprint moves`);
    const cmp = compareAuthorityCompatibility(keyOf(), keyOf(k));
    assert.equal(cmp.compatible, false, `${label}: authorities incompatible`);
    assert.ok(cmp.mismatches.includes('semanticFingerprint'), `${label}: mismatch names semanticFingerprint`);
  }
});

test('spec14pt3 §20/§104: a workflow presentation-only change stays compatible', () => {
  assert.equal(semOf({ description: 'a helpful description of the workflow' }), semOf());
  assert.equal(
    compareAuthorityCompatibility(keyOf(), keyOf({ description: 'docs' })).compatible,
    true,
  );
});

test('spec14pt3 §64: workflow step declaration order is not semantic', () => {
  assert.equal(semOf({ stepsReversed: true }), semOf());
});

test('spec14pt3 §30/§65: a transitively-referenced ActionDef change flips compatibility', () => {
  // Same workflow text (still calls action_a); action_a's body differs.
  const baseIr = ir();
  const mutedIr = ir();
  (mutedIr.actions as Record<string, ActionDef>)[String(A_A)].operations = [
    { kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(99)) },
  ];
  assert.notEqual(serverIrSemanticFingerprint(mutedIr), serverIrSemanticFingerprint(baseIr));
  assert.equal(
    compareAuthorityCompatibility(serverIrCompatibilityKey(baseIr), serverIrCompatibilityKey(mutedIr)).compatible,
    false,
  );
});

test('spec14pt3 §34/§81: an independently-compiled identical workflow graph is compatible', () => {
  assert.equal(semOf(), semOf());
  assert.equal(compareAuthorityCompatibility(keyOf(), keyOf()).compatible, true);
});

// --------------------------------------------------------------- F2 tampered workflow IR

test('spec14pt3 F2: createWorkflowEngine fails closed on structurally invalid workflow IR', () => {
  const good = ir().workflows!;
  const tampered: Array<[string, (w: WorkflowDef) => WorkflowDef]> = [
    ['unknown step kind', (w) => ({ ...w, steps: w.steps.map((s) => (String(s.id) === 's_timer' ? ({ ...s, type: 'sleep' } as never) : s)) })],
    ['dangling next edge', (w) => ({ ...w, steps: w.steps.map((s) => (String(s.id) === 's_act' ? ({ ...s, next: nodeId('nowhere') } as never) : s)) })],
    ['entry points nowhere', (w) => ({ ...w, entry: nodeId('ghost') })],
    ['step is null', (w) => ({ ...w, steps: [...w.steps, null as never] })],
    ['timer with neither after nor at', (w) => ({ ...w, steps: w.steps.map((s) => (String(s.id) === 's_timer' ? ({ type: 'timer', id: s.id, next: nodeId('s_act') } as never) : s)) })],
  ];
  for (const [label, mut] of tampered) {
    assert.throws(
      () =>
        createWorkflowEngine({
          workflows: [mut(structuredClone(good[0]))],
          store: createMemoryWorkflowStore(),
          invokeAction: async () => ({ ok: true, retryable: false }),
          compatibilityFingerprint: 'k',
          instanceId: 'a',
          resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
        }),
      (e: unknown) => e instanceof WorkflowIRError && Array.isArray(e.problems) && e.problems.length > 0,
      `${label} → WorkflowIRError, not a native TypeError`,
    );
  }
});

test('spec14pt3 F1/§41: validateGraph and compileToServerIR reject a malformed step consistently', () => {
  const g = new ApplicationGraph('m', 'M');
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    entry: nodeId('e'),
    steps: [
      { type: 'branch', id: nodeId('e'), when: literal(true), then: nodeId('d'), else: nodeId('d') },
      { type: 'complete', id: nodeId('d') },
      { type: 'teleport', id: nodeId('bad') } as never,
      null as never,
    ],
  });
  assert.throws(() => compileToServerIR(g), (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return /WORKFLOW_INVALID_STEP/.test(msg) && !/TypeError|Cannot read/.test(msg);
  });
});

test('spec14pt3 F2: a valid workflow IR still constructs the engine', () => {
  assert.doesNotThrow(() =>
    createWorkflowEngine({
      workflows: ir().workflows!,
      store: createMemoryWorkflowStore(),
      invokeAction: async () => ({ ok: true, retryable: false }),
      compatibilityFingerprint: 'k',
      instanceId: 'a',
      resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
    }),
  );
});

// --------------------------------------------- in-process mixed-build enforcement (§76-§78)

function engine(
  store: ReturnType<typeof createMemoryWorkflowStore>,
  fp: string,
  invocations: { n: number },
  clock: { t: number },
) {
  return createWorkflowEngine({
    workflows: ir().workflows!,
    store,
    invokeAction: async () => {
      invocations.n += 1;
      return { ok: true, retryable: false };
    },
    compatibilityFingerprint: fp,
    instanceId: `auth-${fp}`,
    resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
    now: () => clock.t,
  });
}

test('spec14pt3 §76/§77/§78: an incompatible authority advances nothing on an existing instance', async () => {
  const store = createMemoryWorkflowStore();
  const inv = { n: 0 };
  const clock = { t: 1_000_000 };
  const a = engine(store, 'BUILD-A', inv, clock);
  const started = await a.startWorkflow({ workflowId: String(WF), arguments: { [String(IN_K)]: 'go' } });
  assert.ok('instanceId' in started);
  const id = started.instanceId;
  // Deliver the event so A parks it at the timer with a real durable position.
  await a.onEventAccepted(String(EV_GO), { [String(F_K)]: 'go' });
  const before = await store.load(id);
  assert.ok(before);
  const historyBefore = (await store.history(id)).length;

  // A semantically different build B (different compatibility fingerprint) attempts everything.
  const b = engine(store, 'BUILD-B', inv, clock);
  const invBefore = inv.n;
  clock.t += 10_000_000; // even with the timer long overdue, B must not fire it
  await b.advance(id);
  await b.onEventAccepted(String(EV_GO), { [String(F_K)]: 'go' });
  const bCancel = await b.cancelWorkflow(id);
  clock.t = 1_000_000;

  const after = await store.load(id);
  assert.equal(after!.instanceRevision, before!.instanceRevision, 'B advanced no revision');
  assert.equal(after!.status, before!.status, 'B changed no status');
  assert.deepEqual(after!.bindings, before!.bindings, 'B wrote no binding');
  assert.equal(inv.n, invBefore, 'B invoked no ActionDef');
  assert.equal((await store.history(id)).length, historyBefore, 'B appended no history');
  assert.equal(bCancel && 'error' in bCancel && bCancel.error.code, 'INCOMPATIBLE_AUTHORITY', 'B cancel refused');

  // B's inspection is honest about why it will not progress.
  const insp = await b.getWorkflow(id);
  assert.equal(insp?.compatible, false);
  assert.equal(insp?.incompatibleReason, 'incompatible-build');

  // A compatible authority resumes it: past the (now due) timer, through the action, to done.
  const a2 = engine(store, 'BUILD-A', inv, clock);
  clock.t += 10_000_000;
  await a2.advance(id);
  const done = await a2.getWorkflow(id);
  assert.equal(done?.compatible, true);
  assert.equal(done?.status, 'completed');
  assert.equal(inv.n, invBefore + 1, 'the ActionDef ran exactly once, on the compatible authority');
});

test('spec14pt3 §161/§162: a start identity is compat-fingerprint scoped — B never reuses A’s instance', async () => {
  const store = createMemoryWorkflowStore();
  const inv = { n: 0 };
  const clock = { t: 1_000_000 };
  const a = engine(store, 'BUILD-A', inv, clock);
  const first = await a.startWorkflow({ workflowId: String(WF), arguments: { [String(IN_K)]: 'go' }, idempotencyKey: 'K' });
  assert.ok('instanceId' in first);
  const aId = first.instanceId;
  const aRev = (await store.load(aId))!.instanceRevision;

  // B repeats the textual key. WorkflowStartIdentity mixes the compatibility fingerprint,
  // so B gets its own B-semantic instance and A's is never touched or reinterpreted.
  const b = engine(store, 'BUILD-B', inv, clock);
  const repeat = await b.startWorkflow({ workflowId: String(WF), arguments: { [String(IN_K)]: 'go' }, idempotencyKey: 'K' });
  assert.ok('instanceId' in repeat, JSON.stringify(repeat));
  assert.notEqual(repeat.instanceId, aId, 'a distinct instance, not a silent reuse under B semantics');
  assert.equal((await store.load(aId))!.instanceRevision, aRev, 'A’s instance untouched');
  assert.equal((await store.load(aId))!.compatibilityFingerprint, 'BUILD-A');
  assert.equal((await store.load(repeat.instanceId))!.compatibilityFingerprint, 'BUILD-B');
});
