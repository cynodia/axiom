import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationGraph, VALIDATION_CODES, nodeId, fieldId, validateGraph } from '@cynodia/axiom-core';
import type { EntityDef, StateDef } from '@cynodia/axiom-core';

/**
 * spec12.1 F3 (§52, §93): a malformed / missing `TypeRef` reaching normal validation MUST
 * produce a structured `ValidationResult`, never a thrown JavaScript `TypeError`
 * ("Cannot read properties of undefined (reading 'kind')").
 */

test('a state with a missing valueType validates to a structured diagnostic, not a TypeError', () => {
  const graph = new ApplicationGraph('bad', 'Bad');
  graph.addNode<StateDef>({
    id: nodeId('state_x'),
    kind: 'state',
    name: 'x',
    // @ts-expect-error — deliberately malformed graph data from an untrusted source
    valueType: undefined,
  });

  let result: ReturnType<typeof validateGraph>;
  assert.doesNotThrow(() => {
    result = validateGraph(graph);
  });
  assert.equal(result!.valid, false);
  assert.ok(
    result!.errors.some((e) => e.code === VALIDATION_CODES.invalidTypeRef),
    'reports invalidTypeRef',
  );
});

test('a collection with a missing itemType, an enum with no values array, and an unknown kind are all structured', () => {
  const graph = new ApplicationGraph('bad2', 'Bad2');
  graph.addNode<EntityDef>({
    id: nodeId('entity_e'),
    kind: 'entity',
    name: 'E',
    identityFieldId: fieldId('field_id'),
    fields: [
      { id: fieldId('field_id'), name: 'Id', valueType: { kind: 'primitive', primitive: 'string' } },
      // @ts-expect-error — malformed
      { id: fieldId('field_coll'), name: 'Coll', valueType: { kind: 'collection' } },
      // @ts-expect-error — malformed
      { id: fieldId('field_enum'), name: 'Enum', valueType: { kind: 'enum' } },
      // @ts-expect-error — malformed
      { id: fieldId('field_weird'), name: 'Weird', valueType: { kind: 'strnig' } },
      // @ts-expect-error — malformed
      { id: fieldId('field_null'), name: 'Null', valueType: null },
    ],
  });

  let result: ReturnType<typeof validateGraph>;
  assert.doesNotThrow(() => {
    result = validateGraph(graph);
  });
  assert.equal(result!.valid, false);
  const codes = result!.errors.filter((e) => e.code === VALIDATION_CODES.invalidTypeRef);
  assert.ok(codes.length >= 3, `every malformed field is reported (${codes.length})`);
});

test('a well-formed graph still validates cleanly (the fix is narrow)', () => {
  const graph = new ApplicationGraph('ok', 'Ok');
  graph.addNode<StateDef>({
    id: nodeId('state_ok'),
    kind: 'state',
    name: 'ok',
    valueType: { kind: 'primitive', primitive: 'number' },
    initialValue: 0,
  });
  const result = validateGraph(graph);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});
