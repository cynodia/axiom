import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the portable **Server IR admission / normalization conformance** fixtures
 * (`axiom.conformance.v11`, spec17 §15-§19, §62, §80 F1-B / F2).
 *
 * Each file carries a serialized Server IR — valid, or deliberately malformed / not
 * normalized — and the required admission outcome: either the document is admissible, or it
 * is rejected before any semantic execution with one of the stable `SERVER_IR_*` codes and
 * with **zero** state mutation, provider mutation, effect creation, event dispatch or
 * workflow advancement.
 *
 * Running one needs nothing from this repository: a conforming runtime performs its own
 * structural admission of the `serverIR` and compares the outcome. The reference runner is
 * `runNormalizationConformanceFixture` in `@cynodia/axiom-server`.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const compiler = await import(path.join(repoRoot, 'packages/compiler/dist/index.js'));
const {
  ApplicationGraph,
  binary,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} = core;

const S_COUNT = nodeId('state_count');
const A_BUMP = nodeId('action_bump');
const P_AMOUNT = nodeId('param_amount');

function buildGraph() {
  const g = new ApplicationGraph('normalization-conformance', 'Normalization Conformance', version);
  g.addNode({
    id: S_COUNT,
    kind: 'state',
    name: 'count',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  g.addNode({
    id: A_BUMP,
    kind: 'action',
    name: 'bump',
    parameters: [{ id: P_AMOUNT, valueType: primitiveType('number'), required: true }],
    guards: [
      {
        condition: binary('gt', ref(P_AMOUNT), literal(0)),
        failureMode: { code: 'amount-not-positive', message: 'The amount must be above zero.' },
      },
    ],
    operations: [
      { kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) },
    ],
  });
  const result = core.validateGraph(g);
  if (!result.valid) {
    throw new Error(`normalization-conformance graph invalid:\n${JSON.stringify(result.errors, null, 2)}`);
  }
  return g;
}

const baseIR = compiler.compileToServerIR(buildGraph());

/** Deep clone the compiled Server IR so each fixture's tamper is isolated. */
const clone = () => JSON.parse(JSON.stringify(baseIR));

const fixtures = [
  {
    name: 'valid-control',
    covers: ['admission'],
    semanticRule: 'spec17 §15 — a well-formed, normalized Server IR is admissible.',
    description: 'The untampered compiled Server IR is admitted.',
    serverIR: clone(),
    expect: { admissible: true },
  },
  {
    name: 'non-object-ir',
    covers: ['admission', 'totality'],
    semanticRule: 'spec17 §17-§18, §62 — a non-object serialized Server IR fails structurally, never as a native exception.',
    description: 'A serialized Server IR that is not a JSON object is rejected.',
    serverIR: null,
    expect: { admissible: false, admissionCodes: ['SERVER_IR_NOT_OBJECT'] },
  },
  {
    name: 'non-array-required-collection',
    covers: ['admission', 'totality'],
    semanticRule: 'spec17 §15, §62 — a required collection present but not an array is rejected.',
    description: 'The `states` collection is an object rather than an array.',
    serverIR: (() => {
      const ir = clone();
      ir.states = {};
      return ir;
    })(),
    expect: { admissible: false, admissionCodes: ['SERVER_IR_INVALID_COLLECTION'] },
  },
  {
    name: 'null-node-map-entry',
    covers: ['admission', 'totality', 'F1-B'],
    semanticRule: 'spec17 §16, §80 F1-B — a `null` entry in a semantic-node map is a structured diagnostic, not a native TypeError.',
    description: 'The `actions` map carries a `null` value under a present key.',
    serverIR: (() => {
      const ir = clone();
      ir.actions = { action_bump: null };
      return ir;
    })(),
    expect: { admissible: false, admissionCodes: ['SERVER_IR_INVALID_NODE'] },
  },
  {
    name: 'primitive-node-map-entry',
    covers: ['admission', 'totality', 'F1-B'],
    semanticRule: 'spec17 §16, §80 F1-B — a primitive entry in a semantic-node map is a structured diagnostic.',
    description: 'The `actions` map carries the number `7` under a present key.',
    serverIR: (() => {
      const ir = clone();
      ir.actions = { action_bump: 7 };
      return ir;
    })(),
    expect: { admissible: false, admissionCodes: ['SERVER_IR_INVALID_NODE'] },
  },
  {
    name: 'null-node-array-entry',
    covers: ['admission', 'totality', 'F1-B'],
    semanticRule: 'spec17 §16, §62 — a `null` entry in a semantic-node array collection is a structured diagnostic.',
    description: 'The `constraints` array carries a `null` element.',
    serverIR: (() => {
      const ir = clone();
      ir.constraints = [null];
      return ir;
    })(),
    expect: { admissible: false, admissionCodes: ['SERVER_IR_INVALID_NODE'] },
  },
  {
    name: 'null-operation',
    covers: ['admission', 'totality'],
    semanticRule: 'spec17 §14, §62 — a `null` operation is a structured diagnostic, never a value silently dropped at execution.',
    description: 'An action carries a `null` element in its `operations` array.',
    serverIR: (() => {
      const ir = clone();
      ir.actions.action_bump.operations = [null];
      return ir;
    })(),
    expect: { admissible: false, admissionCodes: ['SERVER_IR_INVALID_NODE'] },
  },
  {
    name: 'non-normalized-extra-guard',
    covers: ['normalization', 'F2'],
    semanticRule: 'spec17 §12-§13, §80 F2 — `guards.length > preconditions.length` where the extra guard is an executable check: reject fail-closed.',
    description: 'An action declares two guards but only one lowered precondition.',
    serverIR: (() => {
      const ir = clone();
      const action = ir.actions.action_bump;
      action.guards = [
        action.guards[0],
        {
          condition: { kind: 'binary', operator: 'lt', left: { kind: 'ref', targetId: 'param_amount' }, right: { kind: 'literal', value: 100 } },
          failureMode: { code: 'amount-too-large', message: 'The amount is too large.' },
        },
      ];
      // preconditions / failureModes left at length 1 — the second guard is unrepresented.
      return ir;
    })(),
    expect: { admissible: false, admissionCodes: ['SERVER_IR_NOT_NORMALIZED'] },
  },
  {
    name: 'non-normalized-mismatched-guard',
    covers: ['normalization', 'F2'],
    semanticRule: 'spec17 §12 — a lowered precondition that does not match its guard condition means the executable form omits a declared check.',
    description: 'An action`s preconditions[0] is a different expression from guards[0].condition.',
    serverIR: (() => {
      const ir = clone();
      ir.actions.action_bump.preconditions = [
        { kind: 'literal', value: true },
      ];
      return ir;
    })(),
    expect: { admissible: false, admissionCodes: ['SERVER_IR_NOT_NORMALIZED'] },
  },
];

const dir = path.join(repoRoot, 'packages/server/conformance/normalization');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const manifest = {
  conformance: 'axiom.conformance.v11',
  baseContract: baseIR.contract,
  protocol: 'axiom.protocol.v1',
  release: version,
  description:
    'Portable Server IR admission / normalization conformance fixtures (axiom.conformance.v11, spec17 §15-§19, §62, §80). Each file carries a serialized Server IR and the required admission outcome: admissible, or rejected before any semantic execution with a stable SERVER_IR_* code and zero mutation. A conforming runtime performs its own structural admission and compares. Running one needs nothing from this implementation; the reference runner is runNormalizationConformanceFixture in @cynodia/axiom-server.',
  fixtures: [],
};

for (const fixture of fixtures) {
  const document = { conformance: 'axiom.conformance.v11', ...fixture };
  await writeFile(path.join(dir, `${fixture.name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  manifest.fixtures.push({ name: fixture.name, covers: fixture.covers, description: fixture.description });
}
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${fixtures.length} normalization conformance fixtures to ${path.relative(repoRoot, dir)}`);
