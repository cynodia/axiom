import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  VALIDATION_CODES,
  collectionType,
  entityType,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, StateDef } from '@cynodia/axiom-core';

/**
 * spec16pt2 F1/F2 — `validateGraph` must be total over malformed public graph input. These
 * are the exact alpha.1 external-campaign reproductions (§101, §102), the sibling operation
 * audit (§17-19), and a fuzz-adjacent matrix over the traversal code the campaign proved was
 * unsafe (`ActionDef.operations`, an operation's `target`, a `for-each`'s nested
 * `operations`). Every case must produce a structured diagnostic, never a native exception.
 */

const ENTITY = nodeId('entity_x');
const F_ID = fieldId('field_x_id');
const STATE = nodeId('state_x');
const ACTION = nodeId('action_x');

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('totality', 'Totality');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [{ id: F_ID, valueType: primitiveType('string'), required: true }],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  return graph;
}

function addAction(graph: ApplicationGraph, operations: unknown): void {
  graph.addNode({ id: ACTION, kind: 'action', operations } as unknown as ActionDef);
}

function codes(graph: ApplicationGraph): string[] {
  return validateGraph(graph).errors.map((issue) => issue.code);
}

test('a complete graph still validates (fuzz valid control, spec16pt2 §29)', () => {
  const graph = baseGraph();
  addAction(graph, [{ kind: 'set', target: stateLocation(STATE), value: literal([]) }]);
  const result = validateGraph(graph);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

// -------------------------------------------------------------------------------------- F1

test('F1 exact reproduction: ActionDef.operations = {} never throws (spec16pt2 §101)', () => {
  const graph = baseGraph();
  addAction(graph, {});
  let result;
  assert.doesNotThrow(() => {
    result = validateGraph(graph);
  });
  assert.equal(result!.valid, false);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidOperationCollection));
});

for (const [label, operations] of [
  ['a string', 'foo'],
  ['a number', 123],
  ['true', true],
  ['null', null],
] as const) {
  test(`F1 sibling: ActionDef.operations = ${label} is rejected structurally, never thrown`, () => {
    const graph = baseGraph();
    addAction(graph, operations);
    assert.doesNotThrow(() => validateGraph(graph));
    assert.ok(codes(graph).includes(VALIDATION_CODES.invalidOperationCollection));
  });
}

test('ActionDef.operations left undefined is absent, not invalid (spec16pt2 §15)', () => {
  const graph = baseGraph();
  const action = { id: ACTION, kind: 'action' } as unknown as ActionDef;
  graph.addNode(action);
  assert.doesNotThrow(() => validateGraph(graph));
  assert.ok(!codes(graph).includes(VALIDATION_CODES.invalidOperationCollection));
});

test('an array containing a malformed operation entry is rejected per-entry, never thrown', () => {
  const graph = baseGraph();
  addAction(graph, [null, 'not an operation', 42, { kind: 'not-a-real-kind' }]);
  assert.doesNotThrow(() => validateGraph(graph));
  const errorCodes = codes(graph);
  assert.ok(errorCodes.filter((c) => c === VALIDATION_CODES.invalidOperation).length >= 3);
});

test('a for-each with non-array nested operations is rejected structurally, never thrown', () => {
  const graph = baseGraph();
  addAction(graph, [{ kind: 'for-each', collection: stateLocation(STATE), scopeId: nodeId('scope_x'), operations: {} }]);
  assert.doesNotThrow(() => validateGraph(graph));
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidOperationCollection));
});

test('a for-each with a null nested operation entry is rejected, never thrown', () => {
  const graph = baseGraph();
  addAction(graph, [
    { kind: 'for-each', collection: stateLocation(STATE), scopeId: nodeId('scope_x'), operations: [null] },
  ]);
  assert.doesNotThrow(() => validateGraph(graph));
  assert.ok(codes(graph).includes(VALIDATION_CODES.unsupportedOperation));
});

// -------------------------------------------------------------------------------------- F2

test('F2 exact reproduction: SetOperation.target = null never throws (spec16pt2 §102)', () => {
  const graph = baseGraph();
  addAction(graph, [{ kind: 'set', target: null, value: literal(1) }]);
  let result;
  assert.doesNotThrow(() => {
    result = validateGraph(graph);
  });
  assert.equal(result!.valid, false);
  assert.ok(codes(graph).includes(VALIDATION_CODES.unknownStateRef));
});

const NULL_TARGET_MATRIX: ReadonlyArray<['set' | 'insert' | 'remove', unknown]> = [
  ['set', null],
  ['set', undefined],
  ['set', {}],
  ['set', 'a string'],
  ['set', { kind: 'bogus' }],
  ['insert', null],
  ['insert', {}],
  ['remove', null],
  ['remove', {}],
];

for (const [kind, target] of NULL_TARGET_MATRIX) {
  test(`F2 sibling matrix: ${kind}.target = ${JSON.stringify(target)} is rejected structurally, never thrown`, () => {
    const graph = baseGraph();
    addAction(graph, [{ kind, target, value: literal(1) }]);
    assert.doesNotThrow(() => validateGraph(graph));
    assert.equal(validateGraph(graph).valid, false);
  });
}

test('F2 sibling: native.resultTarget = null is rejected structurally, never thrown', () => {
  const graph = baseGraph();
  addAction(graph, [{ kind: 'native', implementationId: 'x', resultTarget: null }]);
  assert.doesNotThrow(() => validateGraph(graph));
});

test('a malformed collection-item selector is rejected structurally, never thrown', () => {
  const graph = baseGraph();
  addAction(graph, [
    {
      kind: 'set',
      target: { kind: 'collection-item', collection: stateLocation(STATE), selector: null },
      value: literal({}),
    },
  ]);
  assert.doesNotThrow(() => validateGraph(graph));
  assert.equal(validateGraph(graph).valid, false);
});

// ------------------------------------------------------------------------- adjacent surfaces

test('getEdges / semanticEdges never throw on a malformed graph either (spec16pt2 §24 adjacent traversal)', () => {
  const graph = baseGraph();
  addAction(graph, [{ kind: 'set', target: null, value: literal(1) }]);
  assert.doesNotThrow(() => graph.getEdges(ACTION));
  assert.doesNotThrow(() => graph.semanticEdges());
});

test('a malformed operations shape does not mutate the graph or throw during analysis', () => {
  const graph = baseGraph();
  addAction(graph, {});
  const before = graph.toJSON();
  validateGraph(graph);
  graph.getEdges(ACTION);
  assert.deepEqual(graph.toJSON(), before);
});
