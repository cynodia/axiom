import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EFFECT_CODE_FIELD,
  EFFECT_ID_FIELD,
  EFFECT_INTEGRATION_ID_FIELD,
  EFFECT_MESSAGE_FIELD,
  EFFECT_OPERATION_ID_FIELD,
  EFFECT_RESULT_FIELD,
  effectOutcomeEntity,
  entityType,
  nodeId,
  primitiveType,
  validateValueAgainstType,
} from '@cynodia/axiom-core';
import type { EntityDef } from '@cynodia/axiom-core';

/** Spec 8.1 §37-41: one entity shape covers both a succeeded and a failed effect dispatch. */

const ENTITY_OUTCOME = nodeId('entity_outcome_08_1');

function entities(): Map<string, EntityDef> {
  return new Map([[String(ENTITY_OUTCOME), effectOutcomeEntity(ENTITY_OUTCOME, primitiveType('string'))]]);
}

function problems(value: unknown): string[] {
  const registry = entities();
  return validateValueAgainstType(value, entityType(ENTITY_OUTCOME), {
    path: 'payload',
    getEntity: (id) => registry.get(String(id)),
  }).map((problem) => problem.message);
}

test('a success payload validates with only effectId/integrationId/operationId/result', () => {
  assert.deepEqual(
    problems({
      [String(EFFECT_ID_FIELD)]: 'effect-1',
      [String(EFFECT_INTEGRATION_ID_FIELD)]: 'integration-1',
      [String(EFFECT_OPERATION_ID_FIELD)]: 'operation-1',
      [String(EFFECT_RESULT_FIELD)]: 'rebooted',
    }),
    [],
  );
});

test('a failure payload validates with code/message/retryable instead of result', () => {
  assert.deepEqual(
    problems({
      [String(EFFECT_ID_FIELD)]: 'effect-1',
      [String(EFFECT_INTEGRATION_ID_FIELD)]: 'integration-1',
      [String(EFFECT_OPERATION_ID_FIELD)]: 'operation-1',
      [String(EFFECT_CODE_FIELD)]: 'DEVICE_UNREACHABLE',
      [String(EFFECT_MESSAGE_FIELD)]: 'no route to device',
    }),
    [],
  );
});

test('effectId, integrationId and operationId are required either way', () => {
  assert.notDeepEqual(
    problems({ [String(EFFECT_RESULT_FIELD)]: 'rebooted' }),
    [],
  );
});
