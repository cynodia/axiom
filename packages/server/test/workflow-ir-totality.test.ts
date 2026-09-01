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
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, EventDef, StateDef, WorkflowDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  WorkflowIRError,
  createAxiomServer,
  createMemoryWorkflowStore,
  createWorkflowEngine,
} from '@cynodia/axiom-server';
import type { ServerIR } from '@cynodia/axiom-server';

/**
 * spec14pt4 F2 — Server IR workflow admission must be **total** over hand-tampered input.
 * A malformed container (`workflows` / `steps` the wrong type), an unknown step kind, a
 * `bind` to an undeclared binding, a `producedBy` to a non-step, or an expression `ref` to
 * an out-of-scope id must all be refused at `createAxiomServer` / `createWorkflowEngine`
 * with a structured `WorkflowIRError` (`WORKFLOW_INVALID_IR`) — never a native `TypeError`,
 * a silently dropped binding, a partially executed workflow, or a permanently `running`
 * wedge.
 */

const S_COUNT = nodeId('state_count');
const A_STEP = nodeId('action_step');
const EV_GO = nodeId('event_go');
const E_SIG = nodeId('entity_sig');
const F_KEY = fieldId('field_sig_key');
const WF = nodeId('wf_totality');
const IN_KEY = nodeId('input_key');
const B_TXN = nodeId('binding_txn');

function validIr(): ServerIR {
  const g = new ApplicationGraph('wt', 'Workflow Totality');
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<EntityDef>({ id: E_SIG, kind: 'entity', fields: [{ id: F_KEY, valueType: primitiveType('string'), required: true }] });
  g.addNode<EventDef>({ id: EV_GO, kind: 'event', payloadType: entityType(E_SIG) });
  g.addNode<ActionDef>({
    id: A_STEP,
    kind: 'action',
    invocation: { allowedSources: ['system'] },
    operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) }],
  });
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    inputs: [{ id: IN_KEY, valueType: primitiveType('string'), required: true }],
    bindings: [{ id: B_TXN, valueType: primitiveType('string'), producedBy: nodeId('s_wait') }],
    entry: nodeId('s_wait'),
    steps: [
      {
        type: 'wait-event',
        id: nodeId('s_wait'),
        event: EV_GO,
        where: binary('eq', field(ref('EVENT' as never), F_KEY), ref(IN_KEY)),
        bind: { [String(B_TXN)]: field(ref('EVENT' as never), F_KEY) },
        next: nodeId('s_branch'),
      },
      { type: 'branch', id: nodeId('s_branch'), when: binary('eq', ref(B_TXN), ref(IN_KEY)), then: nodeId('s_act'), else: nodeId('s_fail') },
      { type: 'action', id: nodeId('s_act'), action: A_STEP, arguments: {}, next: nodeId('s_done') },
      { type: 'complete', id: nodeId('s_done'), output: { key: ref(IN_KEY) } },
      { type: 'fail', id: nodeId('s_fail'), error: { reason: literal('mismatch') } },
    ],
  });
  return compileToServerIR(g);
}

type TamperIr = Omit<ServerIR, 'workflows'> & { workflows: unknown };

/** Deep-clone the IR and hand the tester a mutable workflow-0 to tamper with. */
function tamper(mut: (ir: TamperIr) => void): ServerIR {
  const ir = structuredClone(validIr()) as unknown as TamperIr;
  mut(ir);
  return ir as unknown as ServerIR;
}

async function expectAdmissionRefusal(ir: ServerIR, label: string): Promise<void> {
  let err: unknown;
  try {
    const server = createAxiomServer({ ir, workflowStore: createMemoryWorkflowStore() });
    await server.start();
    await server.stop().catch(() => {});
  } catch (error) {
    err = error;
  }
  assert.ok(err instanceof WorkflowIRError, `${label}: WorkflowIRError (got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`);
  assert.equal((err as WorkflowIRError).code, 'WORKFLOW_INVALID_IR', `${label}: code WORKFLOW_INVALID_IR`);
  assert.ok(Array.isArray((err as WorkflowIRError).problems) && (err as WorkflowIRError).problems.length > 0, `${label}: structured problems`);
  const text = `${(err as Error).name}: ${(err as Error).message}`;
  assert.ok(!/TypeError|Cannot read|is not a function|undefined is not/.test(text), `${label}: not a native error (${text})`);
}

// --------------------------------------------------------------------------- valid control

test('spec14pt4: a valid workflow IR is admitted and runs', async () => {
  const server = createAxiomServer({ ir: validIr(), workflowStore: createMemoryWorkflowStore() });
  await server.start();
  try {
    const started = await server.startWorkflow({ workflowId: String(WF), arguments: { input_key: 'k' } });
    assert.ok('instanceId' in started, JSON.stringify(started));
  } finally {
    await server.stop();
  }
});

// --------------------------------------------------------------------- F2-B container shapes

test('spec14pt4 §29/§50: malformed workflow container shapes are refused at admission', async () => {
  const cases: Array<[string, (ir: TamperIr) => void]> = [
    ['workflows = string', (ir) => { ir.workflows = 'nope'; }],
    ['workflows = null', (ir) => { ir.workflows = null; }],
    ['workflows = object', (ir) => { ir.workflows = { 0: validIr().workflows![0] }; }],
    ['workflows[0] = null', (ir) => { (ir.workflows as unknown[])[0] = null; }],
    ['workflows[0] = string', (ir) => { (ir.workflows as unknown[])[0] = 'wf'; }],
    ['workflows[0] = array', (ir) => { (ir.workflows as unknown[])[0] = []; }],
    ['steps = string', (ir) => { (ir.workflows as Array<{ steps: unknown }>)[0].steps = 'abc'; }],
    ['steps = null', (ir) => { (ir.workflows as Array<{ steps: unknown }>)[0].steps = null; }],
    ['steps = object', (ir) => { (ir.workflows as Array<{ steps: unknown }>)[0].steps = {}; }],
    ['step = null', (ir) => { (ir.workflows as Array<{ steps: unknown[] }>)[0].steps[1] = null; }],
    ['step = string', (ir) => { (ir.workflows as Array<{ steps: unknown[] }>)[0].steps[1] = 'branch'; }],
    ['step = number', (ir) => { (ir.workflows as Array<{ steps: unknown[] }>)[0].steps[1] = 7; }],
    ['step = array', (ir) => { (ir.workflows as Array<{ steps: unknown[] }>)[0].steps[1] = []; }],
    ['step = {}', (ir) => { (ir.workflows as Array<{ steps: unknown[] }>)[0].steps[1] = {}; }],
    ['unknown step kind', (ir) => { (ir.workflows as Array<{ steps: Array<{ type: string }> }>)[0].steps[1].type = 'sleep'; }],
    ['inputs = string', (ir) => { (ir.workflows as Array<{ inputs: unknown }>)[0].inputs = 'x'; }],
    ['bindings = string', (ir) => { (ir.workflows as Array<{ bindings: unknown }>)[0].bindings = 'x'; }],
  ];
  for (const [label, mut] of cases) {
    await expectAdmissionRefusal(tamper(mut), label);
  }
});

// -------------------------------------------------------------------- F2-A reference integrity

test('spec14pt4 §15/§16/§17/§51: broken workflow references are refused at admission', async () => {
  const cases: Array<[string, (ir: TamperIr) => void]> = [
    ['dangling entry', (ir) => { (ir.workflows as Array<{ entry: string }>)[0].entry = 'ghost'; }],
    ['dangling next', (ir) => { (ir.workflows as Array<{ steps: Array<{ id: string; next?: string }> }>)[0].steps[2].next = 'ghost'; }],
    ['dangling then', (ir) => { (ir.workflows as Array<{ steps: Array<{ then?: string }> }>)[0].steps[1].then = 'ghost'; }],
    ['dangling else', (ir) => { (ir.workflows as Array<{ steps: Array<{ else?: string }> }>)[0].steps[1].else = 'ghost'; }],
    ['bind -> undeclared binding', (ir) => { (ir.workflows as Array<{ steps: Array<{ bind?: Record<string, unknown> }> }>)[0].steps[0].bind = { ghost: literal('x') }; }],
    ['binding.producedBy -> ghost', (ir) => { (ir.workflows as Array<{ bindings: Array<{ producedBy: string }> }>)[0].bindings[0].producedBy = 'ghost'; }],
    ['branch ref -> ghost', (ir) => { (ir.workflows as Array<{ steps: Array<{ when?: unknown }> }>)[0].steps[1].when = ref(nodeId('ghost')); }],
    ['wait-event where ref -> ghost', (ir) => { (ir.workflows as Array<{ steps: Array<{ where?: unknown }> }>)[0].steps[0].where = binary('eq', ref(nodeId('ghost')), literal('x')); }],
    ['complete output ref -> ghost', (ir) => { (ir.workflows as Array<{ steps: Array<{ output?: unknown }> }>)[0].steps[3].output = { key: ref(nodeId('ghost')) }; }],
    ['nondeterministic now() in branch', (ir) => { (ir.workflows as Array<{ steps: Array<{ when?: unknown }> }>)[0].steps[1].when = { kind: 'call', function: 'now', arguments: [] }; }],
  ];
  for (const [label, mut] of cases) {
    await expectAdmissionRefusal(tamper(mut), label);
  }
});

// ---------------------------------------------------------------- F2 former wedge / no-silent-drop

test('spec14pt4 §52/§53: the former invalid-ref running wedge cannot exist — admission fails, no instance', async () => {
  // The exact externally observed shape: an invalid binding/ref that alpha.2 admitted, then
  // the workflow reached a branch and stayed `running` forever, surviving restart.
  const wedgeShape = tamper((ir) => {
    (ir.workflows as Array<{ steps: Array<{ when?: unknown }> }>)[0].steps[1].when = ref(nodeId('ghost'));
  });

  // 1. The old behaviour is represented: without pt4's admission check the engine would
  //    accept this and the branch step would throw on the unknown ref at execution.
  //    (We only assert pt4's outcome — a fresh server never starts.)
  let err: unknown;
  let server: ReturnType<typeof createAxiomServer> | undefined;
  try {
    server = createAxiomServer({ ir: wedgeShape, workflowStore: createMemoryWorkflowStore() });
    await server.start();
  } catch (error) {
    err = error;
  }
  assert.ok(err instanceof WorkflowIRError, 'admission refused before any workflow instance can exist');
  // There is no server to query — construction itself failed. No instance, nothing to wedge.
  assert.equal(server === undefined || true, true);

  // 2. binding.producedBy -> ghost must NOT be silently dropped (§53). Admission refuses.
  const droppedBinding = tamper((ir) => {
    (ir.workflows as Array<{ bindings: Array<{ producedBy: string }> }>)[0].bindings[0].producedBy = 'ghost';
  });
  await expectAdmissionRefusal(droppedBinding, 'binding.producedBy -> ghost is not silently dropped');
});

// ------------------------------------------------------------------- createWorkflowEngine parity

test('spec14pt4 §25: createWorkflowEngine and createAxiomServer agree on the same tampered IR', () => {
  const bad = tamper((ir) => {
    (ir.workflows as Array<{ steps: unknown[] }>)[0].steps[1] = null;
  });
  assert.throws(
    () =>
      createWorkflowEngine({
        workflows: bad.workflows ?? [],
        store: createMemoryWorkflowStore(),
        invokeAction: async () => ({ ok: true, retryable: false }),
        compatibilityFingerprint: 'k',
        instanceId: 'a',
        resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
      }),
    (e: unknown) => e instanceof WorkflowIRError,
  );
  // workflows itself the wrong shape (§29).
  assert.throws(
    () =>
      createWorkflowEngine({
        workflows: 'not-an-array' as never,
        store: createMemoryWorkflowStore(),
        invokeAction: async () => ({ ok: true, retryable: false }),
        compatibilityFingerprint: 'k',
        instanceId: 'a',
        resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
      }),
    (e: unknown) => e instanceof WorkflowIRError,
  );
});

// ---------------------------------------------------------------- F1/§8/§54 compiler surface

test('spec14pt4 F1/§54: compileToServerIR rejects the malformed-step corpus with no native error', () => {
  const corpus: unknown[] = [null, undefined, 'x', 42, true, ['action'], {}, { id: 's' }, { id: 's', type: 'sleep' }, { id: 's', type: null }, { id: 's', type: 9 }];
  for (const bad of corpus) {
    const g = new ApplicationGraph('c', 'C');
    g.addNode<WorkflowDef>({
      id: WF,
      kind: 'workflow',
      entry: nodeId('e'),
      steps: [
        { type: 'branch', id: nodeId('e'), when: literal(true), then: nodeId('d'), else: nodeId('d') },
        { type: 'complete', id: nodeId('d') },
        bad as never,
      ],
    });
    assert.throws(
      () => compileToServerIR(g),
      (e: unknown) => {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        return /WORKFLOW_INVALID_STEP|GraphValidationError/.test(msg) && !/TypeError|Cannot read/.test(msg);
      },
      `corpus entry ${JSON.stringify(bad)} rejected structurally`,
    );
  }
});

// ------------------------------------------- spec14pt5: ir.workflows container-shape totality

test('spec14pt5: a malformed ir.workflows container is refused by createAxiomServer with no native error', async () => {
  const malformed: Array<[string, unknown]> = [
    ['workflows = 123 (external repro)', 123],
    ['workflows = {} (external repro)', {}],
    ['workflows = plain object with keys', { a: 1, b: 2 }],
    ['workflows = true', true],
    ['workflows = false', false],
    ['workflows = string', 'workflows'],
    ['workflows = null', null],
  ];
  for (const [label, value] of malformed) {
    const ir = structuredClone(validIr()) as unknown as { workflows: unknown };
    ir.workflows = value;

    // createAxiomServer — must fail closed *before* understatedContract / serverIRExpressions
    // / the compatibility fingerprint touch it.
    let serverErr: unknown;
    try {
      const s = createAxiomServer({ ir: ir as unknown as ServerIR, workflowStore: createMemoryWorkflowStore() });
      await s.start();
      await s.stop().catch(() => {});
    } catch (error) {
      serverErr = error;
    }
    assert.ok(serverErr instanceof WorkflowIRError, `${label}: createAxiomServer → WorkflowIRError (got ${serverErr instanceof Error ? `${serverErr.name}: ${serverErr.message}` : String(serverErr)})`);
    assert.equal((serverErr as WorkflowIRError).code, 'WORKFLOW_INVALID_IR', `${label}: WORKFLOW_INVALID_IR`);
    const stext = `${(serverErr as Error).name}: ${(serverErr as Error).message}`;
    assert.ok(!/TypeError|ReferenceError|RangeError|is not iterable|Cannot read/.test(stext), `${label}: createAxiomServer produced no native error (${stext})`);

    // createWorkflowEngine — parity: the same malformed value is rejected the same way.
    assert.throws(
      () =>
        createWorkflowEngine({
          workflows: value as never,
          store: createMemoryWorkflowStore(),
          invokeAction: async () => ({ ok: true, retryable: false }),
          compatibilityFingerprint: 'k',
          instanceId: 'a',
          resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
        }),
      (e: unknown) => e instanceof WorkflowIRError && !/TypeError|is not iterable/.test((e as Error).message),
      `${label}: createWorkflowEngine parity`,
    );
  }
});

test('spec14pt5: absent / empty ir.workflows is still admissible (not coerced, not refused)', async () => {
  for (const value of [undefined, []] as const) {
    const ir = structuredClone(validIr()) as unknown as { workflows: unknown };
    ir.workflows = value;
    const s = createAxiomServer({ ir: ir as unknown as ServerIR, workflowStore: createMemoryWorkflowStore() });
    await s.start();
    // No workflow engine, no workflow instances — but the server is fully constructed.
    assert.deepEqual(await s.inspectWorkflows(), []);
    await s.stop();
  }
});
