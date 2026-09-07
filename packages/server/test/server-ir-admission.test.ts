import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  ServerIRError,
  createAxiomServer,
  createMemoryPersistence,
  runNormalizationConformanceFixture,
  serverIRNormalizationProblems,
  serverIRStructuralProblems,
} from '@cynodia/axiom-server';
import type { NormalizationConformanceFixture, ServerIR } from '@cynodia/axiom-server';

/**
 * spec17 §15-§19, §80 — Server IR admission is total over untrusted serialized input.
 *
 * F1-B: a `null` / primitive / structurally invalid semantic-node entry is a structured
 * `ServerIRError`, never a native `TypeError`, and nothing is executed.
 *
 * F2: an executable Server IR whose authoring `guards` are not represented in the aligned
 * lowered `preconditions` / `failureModes` is rejected fail-closed with
 * `SERVER_IR_NOT_NORMALIZED` — the authority never silently skips the unmatched check.
 */

const S = nodeId('state_count');
const A = nodeId('action_bump');
const P = nodeId('param_amount');

function baseIR(): ServerIR {
  const g = new ApplicationGraph('adm', 'Admission');
  g.addNode<StateDef>({
    id: S,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  g.addNode<ActionDef>({
    id: A,
    kind: 'action',
    parameters: [{ id: P, valueType: primitiveType('number'), required: true }],
    guards: [
      {
        condition: binary('gt', ref(P), literal(0)),
        failureMode: { code: 'not-positive', message: 'must be positive' },
      },
    ],
    operations: [{ kind: 'set', target: stateLocation(S), value: binary('add', ref(S), literal(1)) }],
  });
  return compileToServerIR(g);
}

const clone = (): ServerIR => JSON.parse(JSON.stringify(baseIR())) as ServerIR;

async function expectStructuredRejection(
  ir: unknown,
  label: string,
  requiredCode: string,
): Promise<void> {
  let error: unknown;
  try {
    const server = createAxiomServer({ ir: ir as never, persistence: createMemoryPersistence() });
    await server.start();
    await server.stop().catch(() => {});
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof ServerIRError, `${label}: ServerIRError (got ${String(error)})`);
  const text = `${(error as Error).name}: ${(error as Error).message}`;
  assert.ok(!/TypeError|RangeError|Cannot read|is not a function|is not iterable/.test(text), `${label}: not a native error (${text})`);
  const codes = (error as ServerIRError).problems.map((problem) => String(problem.code));
  assert.ok(codes.includes(requiredCode), `${label}: expected ${requiredCode}, got [${codes.join(', ')}]`);
}

// -------------------------------------------------------------------- F1-B: structural totality

test('spec17 §17: a non-object Server IR is refused structurally', async () => {
  for (const value of [null, 7, 'ir', true, []]) {
    await expectStructuredRejection(value, `ir = ${JSON.stringify(value)}`, 'SERVER_IR_NOT_OBJECT');
  }
});

test('spec17 §15/§62: a required collection that is not an array is refused', async () => {
  const ir = clone();
  (ir as unknown as { states: unknown }).states = {};
  await expectStructuredRejection(ir, 'states = {}', 'SERVER_IR_INVALID_COLLECTION');
});

test('spec17 §16/§80 F1-B: a null semantic-node map entry is a structured diagnostic', async () => {
  const ir = clone();
  (ir.actions as Record<string, unknown>)['action_bump'] = null;
  await expectStructuredRejection(ir, 'actions.action_bump = null', 'SERVER_IR_INVALID_NODE');
});

test('spec17 §16/§80 F1-B: a primitive semantic-node map entry is a structured diagnostic', async () => {
  const ir = clone();
  (ir.actions as Record<string, unknown>)['action_bump'] = 7;
  await expectStructuredRejection(ir, 'actions.action_bump = 7', 'SERVER_IR_INVALID_NODE');
});

test('spec17 §16/§62: a null semantic-node array entry is a structured diagnostic', async () => {
  const ir = clone();
  (ir as unknown as { constraints: unknown[] }).constraints = [null];
  await expectStructuredRejection(ir, 'constraints[0] = null', 'SERVER_IR_INVALID_NODE');
});

test('spec17 §14/§62: a null operation is a structured diagnostic, not a silent drop', async () => {
  const ir = clone();
  ((ir.actions as Record<string, { operations: unknown[] }>)['action_bump']).operations = [null];
  await expectStructuredRejection(ir, 'operations[0] = null', 'SERVER_IR_INVALID_NODE');
});

test('spec17 §17: serverIRStructuralProblems is total and returns [] for a valid IR', () => {
  assert.deepEqual(serverIRStructuralProblems(baseIR()), []);
  // total over arbitrary junk — never throws
  for (const junk of [null, undefined, 7, 'x', [], { actions: 3 }, { actions: { a: null } }]) {
    assert.ok(Array.isArray(serverIRStructuralProblems(junk)));
  }
});

// -------------------------------------------------------------------- F2: guard normalization

test('spec17 §12-§13/§80 F2: an unrepresented extra guard is refused SERVER_IR_NOT_NORMALIZED', async () => {
  const ir = clone();
  const action = (ir.actions as Record<string, { guards: unknown[]; preconditions: unknown[] }>)[
    'action_bump'
  ];
  action.guards = [
    action.guards[0],
    { condition: binary('lt', ref(P), literal(100)), failureMode: { code: 'too-big' } },
  ];
  // preconditions stays length 1
  await expectStructuredRejection(ir, 'guards.length > preconditions.length', 'SERVER_IR_NOT_NORMALIZED');
});

test('spec17 §12: a lowered precondition that does not match its guard is refused', async () => {
  const ir = clone();
  (ir.actions as Record<string, { preconditions: unknown[] }>)['action_bump'].preconditions = [
    literal(true),
  ];
  await expectStructuredRejection(ir, 'preconditions[0] != guards[0].condition', 'SERVER_IR_NOT_NORMALIZED');
});

test('spec17 §12: a compiled Server IR is normalized (guards aligned with preconditions)', () => {
  assert.deepEqual(serverIRNormalizationProblems(baseIR()), []);
  // an action with only positional preconditions (no guards) is normalized by definition
  assert.deepEqual(
    serverIRNormalizationProblems({ actions: { a: { id: 'a', preconditions: [literal(true)], failureModes: [] } } }),
    [],
  );
});

test('spec17 §19: a rejected Server IR mutates nothing — no server object is returned', async () => {
  const ir = clone();
  (ir.actions as Record<string, unknown>)['action_bump'] = null;
  let server: unknown;
  try {
    server = createAxiomServer({ ir: ir as never, persistence: createMemoryPersistence() });
  } catch {
    /* expected */
  }
  assert.equal(server, undefined, 'construction itself failed; there is nothing to mutate');
});

// -------------------------------------------------------------- runtime-neutral conformance tier

const dir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance/normalization');
const files = (await readdir(dir)).filter((name) => name.endsWith('.json') && name !== 'manifest.json').sort();

test('axiom.conformance.v11 normalization tier has fixtures and a stamped manifest', async () => {
  assert.ok(files.length >= 8, `expected the normalization fixtures, found ${files.length}`);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
    conformance: string;
  };
  assert.equal(manifest.conformance, 'axiom.conformance.v11');
});

for (const file of files) {
  const fixture = JSON.parse(
    await readFile(path.join(dir, file), 'utf8'),
  ) as NormalizationConformanceFixture;
  test(`conformance/normalization: ${fixture.name} — ${fixture.description}`, async () => {
    const result = await runNormalizationConformanceFixture(fixture);
    assert.ok(result.passed, result.failures.join('\n'));
  });
}
