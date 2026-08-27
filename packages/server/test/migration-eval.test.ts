import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIGRATION_OLD_SCOPE,
  binary,
  call,
  conditional,
  field,
  fieldId,
  filter,
  literal,
  map,
  nodeId,
  object,
  ref,
  sort,
} from '@cynodia/axiom-core';
import {
  MigrationTransformError,
  evaluateMigrationExpression,
  migrationRowScope,
} from '@cynodia/axiom-server';

const F_NAME = fieldId('field_name');
const F_LINES = fieldId('field_lines');
const F_QTY = fieldId('field_qty');
const SCOPE = nodeId('scope_line');

function evalOld(expression: Parameters<typeof evaluateMigrationExpression>[0], old: Record<string, unknown>, constants = {}) {
  return evaluateMigrationExpression(expression, migrationRowScope(old, constants));
}

test('reads the old record and a declared constant', () => {
  const K = nodeId('const_suffix');
  const result = evalOld(
    call('concat', field(ref(MIGRATION_OLD_SCOPE), F_NAME), ref(K)),
    { [String(F_NAME)]: 'Ada' },
    { [String(K)]: ' L.' },
  );
  assert.equal(result, 'Ada L.');
});

test('object / conditional / binary compose', () => {
  const result = evalOld(
    object([
      {
        fieldId: F_NAME,
        value: conditional(
          binary('gt', field(ref(MIGRATION_OLD_SCOPE), F_QTY), literal(0)),
          literal('some'),
          literal('none'),
        ),
      },
    ]),
    { [String(F_QTY)]: 3 },
  );
  assert.deepEqual(result, { [String(F_NAME)]: 'some' });
});

test('map / filter / sort over a collection field of the old record', () => {
  const old = {
    [String(F_LINES)]: [{ [String(F_QTY)]: 3 }, { [String(F_QTY)]: 1 }, { [String(F_QTY)]: 2 }],
  };
  assert.deepEqual(
    evalOld(map(field(ref(MIGRATION_OLD_SCOPE), F_LINES), SCOPE, field(ref(SCOPE), F_QTY)), old),
    [3, 1, 2],
  );
  assert.deepEqual(
    evalOld(
      filter(field(ref(MIGRATION_OLD_SCOPE), F_LINES), SCOPE, binary('gte', field(ref(SCOPE), F_QTY), literal(2))),
      old,
    ),
    [{ [String(F_QTY)]: 3 }, { [String(F_QTY)]: 2 }],
  );
  assert.deepEqual(
    evalOld(
      map(sort(field(ref(MIGRATION_OLD_SCOPE), F_LINES), SCOPE, field(ref(SCOPE), F_QTY)), SCOPE, field(ref(SCOPE), F_QTY)),
      old,
    ),
    [1, 2, 3],
  );
});

test('now() and uuid() are rejected inside a transform (spec11 §26)', () => {
  assert.throws(() => evalOld(call('now'), {}), MigrationTransformError);
  assert.throws(() => evalOld(call('uuid'), {}), MigrationTransformError);
});

test('a ref to a scope that is neither the old record nor a constant throws', () => {
  assert.throws(
    () => evalOld(ref(nodeId('state_something')), { [String(F_NAME)]: 'x' }),
    MigrationTransformError,
  );
});

test('a collection operator over a missing collection throws rather than guessing', () => {
  assert.throws(
    () => evalOld(map(field(ref(MIGRATION_OLD_SCOPE), F_LINES), SCOPE, literal(1)), {}),
    MigrationTransformError,
  );
});
