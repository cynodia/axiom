import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVER_IR_ADMISSION_CODES,
  ServerIRError,
  assertAdmissibleServerIR,
  serverIRNormalizationProblems,
  serverIRStructuralProblems,
} from '@cynodia/axiom-core';

/**
 * spec17 §15-§19, §80 F1-B / F2 — the Server IR admission totality boundary in `core`.
 *
 * These functions are pure, total over `unknown`, and the single source of truth an
 * independent runtime reproduces from `docs/AUTHORITY.md#server-ir-admission`. They MUST
 * NOT throw for any input; a structured problem list is the only output.
 */

/** A minimal well-formed serialized Server IR. */
function baseIR(): Record<string, unknown> {
  return {
    contract: 'axiom.server.v1',
    id: 'g',
    name: 'G',
    version: '0.0.0',
    entities: [],
    fields: {},
    states: [{ id: 'state_x', kind: 'state' }],
    actions: {
      action_a: {
        id: 'action_a',
        kind: 'action',
        operations: [],
        guards: [{ condition: { kind: 'literal', value: true } }],
        preconditions: [{ kind: 'literal', value: true }],
        failureModes: [{ code: 'precondition-failed' }],
      },
    },
    constraints: [],
    transitionConstraints: [],
    observableStateIds: ['state_x'],
  };
}

test('serverIRStructuralProblems is total over arbitrary input and never throws', () => {
  const junk: unknown[] = [
    null,
    undefined,
    0,
    '',
    'ir',
    true,
    [],
    [1, 2],
    {},
    { actions: 3 },
    { actions: [] },
    { actions: { a: null } },
    { states: { 0: 1 } },
    { entities: 'x', states: null, constraints: 7 },
    { actions: { a: { id: 'a', operations: [null, 1, 'x', [], {}] } } },
    { observableStateIds: [1, {}, null] },
    Object.create(null),
  ];
  for (const value of junk) {
    const problems = serverIRStructuralProblems(value);
    assert.ok(Array.isArray(problems), `array result for ${JSON.stringify(value)}`);
    for (const problem of problems) {
      assert.equal(typeof problem.code, 'string');
      assert.equal(typeof problem.path, 'string');
      assert.equal(typeof problem.message, 'string');
    }
  }
});

test('a well-formed serialized Server IR has no structural or normalization problems', () => {
  assert.deepEqual(serverIRStructuralProblems(baseIR()), []);
  assert.deepEqual(serverIRNormalizationProblems(baseIR()), []);
  assert.doesNotThrow(() => assertAdmissibleServerIR(baseIR()));
});

test('§17 — a non-object document is SERVER_IR_NOT_OBJECT', () => {
  for (const value of [null, 7, 'x', true, []]) {
    const [problem, ...rest] = serverIRStructuralProblems(value);
    assert.equal(problem?.code, SERVER_IR_ADMISSION_CODES.SERVER_IR_NOT_OBJECT);
    assert.deepEqual(rest, []);
  }
});

test('§15 — a required collection that is not an array is SERVER_IR_INVALID_COLLECTION', () => {
  const ir = baseIR();
  ir.states = {};
  const codes = serverIRStructuralProblems(ir).map((p) => p.code);
  assert.ok(codes.includes(SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_COLLECTION));
});

test('§16 F1-B — null / primitive semantic-node entries are SERVER_IR_INVALID_NODE', () => {
  for (const bad of [null, 7, 'x', [], true]) {
    const mapIr = baseIR();
    (mapIr.actions as Record<string, unknown>).action_a = bad;
    assert.ok(
      serverIRStructuralProblems(mapIr).some(
        (p) => p.code === SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_NODE && p.path === 'actions.action_a',
      ),
      `map entry ${JSON.stringify(bad)}`,
    );

    const arrIr = baseIR();
    arrIr.constraints = [bad];
    assert.ok(
      serverIRStructuralProblems(arrIr).some(
        (p) => p.code === SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_NODE && p.path === 'constraints[0]',
      ),
      `array entry ${JSON.stringify(bad)}`,
    );
  }
});

test('§14 — a malformed operation entry is SERVER_IR_INVALID_NODE, not a silent drop', () => {
  const ir = baseIR();
  (ir.actions as Record<string, { operations: unknown[] }>).action_a.operations = [
    null,
    { kind: 'set', target: {}, value: {} },
    7,
  ];
  const problems = serverIRStructuralProblems(ir).filter(
    (p) => p.code === SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_NODE,
  );
  assert.equal(problems.length, 2, JSON.stringify(problems));
});

test('§16 — workflows keep their own admission path (not reported here)', () => {
  const ir = baseIR();
  ir.workflows = [null, 'x', 7];
  // serverIRStructuralProblems deliberately does not touch `workflows` — WorkflowIRError does.
  assert.deepEqual(serverIRStructuralProblems(ir), []);
});

test('§12-§13 F2 — an unrepresented guard is SERVER_IR_NOT_NORMALIZED', () => {
  const ir = baseIR();
  const action = (ir.actions as Record<string, { guards: unknown[] }>).action_a;
  action.guards = [...action.guards, { condition: { kind: 'literal', value: false } }];
  const problems = serverIRNormalizationProblems(ir);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, SERVER_IR_ADMISSION_CODES.SERVER_IR_NOT_NORMALIZED);
});

test('§12 — a lowered precondition that does not match its guard is SERVER_IR_NOT_NORMALIZED', () => {
  const ir = baseIR();
  (ir.actions as Record<string, { preconditions: unknown[] }>).action_a.preconditions = [
    { kind: 'literal', value: false },
  ];
  const problems = serverIRNormalizationProblems(ir);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, SERVER_IR_ADMISSION_CODES.SERVER_IR_NOT_NORMALIZED);
});

test('an action with only positional preconditions (no guards) is normalized', () => {
  const ir = baseIR();
  const action = ir.actions as Record<string, Record<string, unknown>>;
  delete action.action_a.guards;
  assert.deepEqual(serverIRNormalizationProblems(ir), []);
});

test('serverIRNormalizationProblems is total over arbitrary input', () => {
  for (const value of [null, undefined, 7, 'x', [], {}, { actions: 3 }, { actions: { a: 1 } }]) {
    assert.ok(Array.isArray(serverIRNormalizationProblems(value)));
  }
});

test('assertAdmissibleServerIR throws a structured ServerIRError, never a native error', () => {
  try {
    assertAdmissibleServerIR({ ...baseIR(), states: 5 });
    assert.fail('expected a throw');
  } catch (error) {
    assert.ok(error instanceof ServerIRError);
    assert.ok(Array.isArray((error as ServerIRError).problems));
    assert.ok((error as ServerIRError).problems.length > 0);
    assert.ok(!/TypeError|Cannot read/.test((error as Error).message));
  }
});
