import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fieldId,
  fieldLocation,
  identitySelector,
  indexSelector,
  itemLocation,
  literal,
  nodeId,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { Expression } from '@cynodia/axiom-core';
import { LocationResolutionError, deepFreeze, describePath, resolveLocation } from '@cynodia/axiom-runtime';
import type { LocationRuntime } from '@cynodia/axiom-runtime';

const STATE = nodeId('state_records');
const STATE_SETTINGS = nodeId('state_settings');
const F_ID = fieldId('field_id');
const F_LABEL = fieldId('field_label');
const F_NESTED = fieldId('field_nested');
const PARAM = nodeId('param_id');

/** A store with the same shape the runtime uses: frozen values, replaced wholesale. */
function createStore(scope: Record<string, unknown> = {}): LocationRuntime & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>([
    [
      STATE,
      deepFreeze([
        { [F_ID]: 'r1', [F_LABEL]: 'First', [F_NESTED]: { [F_LABEL]: 'inner' } },
        { [F_ID]: 'r2', [F_LABEL]: 'Second' },
      ]),
    ],
    [STATE_SETTINGS, deepFreeze({ [F_LABEL]: 'settings' })],
  ]);

  return {
    values,
    readState: (stateId) => values.get(stateId),
    writeState: (stateId, value) => {
      values.set(stateId, deepFreeze(value));
    },
    evaluate: (expression: Expression) => {
      if (expression.kind === 'literal') {
        return expression.value;
      }
      if (expression.kind === 'ref') {
        return scope[expression.targetId] ?? values.get(expression.targetId);
      }
      throw new Error('unsupported in this fixture');
    },
  };
}

test('a state location reads and replaces the whole value', () => {
  const runtime = createStore();
  const resolved = resolveLocation(stateLocation(STATE_SETTINGS), {}, runtime);

  assert.deepEqual(resolved.read(), { [F_LABEL]: 'settings' });
  assert.equal(resolved.rootStateId, STATE_SETTINGS);
  assert.deepEqual(resolved.path.segments, []);

  resolved.write({ [F_LABEL]: 'changed' });
  assert.deepEqual(runtime.values.get(STATE_SETTINGS), { [F_LABEL]: 'changed' });
});

test('a field location reads and writes one field', () => {
  const runtime = createStore();
  const resolved = resolveLocation(fieldLocation(stateLocation(STATE_SETTINGS), F_LABEL), {}, runtime);

  assert.equal(resolved.read(), 'settings');
  resolved.write('renamed');
  assert.deepEqual(runtime.values.get(STATE_SETTINGS), { [F_LABEL]: 'renamed' });
});

test('a collection item is addressed by identity', () => {
  const runtime = createStore({ [PARAM]: 'r2' });
  const location = itemLocation(stateLocation(STATE), identitySelector(F_ID, ref(PARAM)));
  const resolved = resolveLocation(location, {}, runtime);

  assert.deepEqual(resolved.read(), { [F_ID]: 'r2', [F_LABEL]: 'Second' });
  assert.deepEqual(resolved.path.segments, [
    { kind: 'collection-item', fieldId: F_ID, identity: 'r2' },
  ]);
  assert.equal(describePath(resolved.path), 'state_records → [r2]');
});

test('a collection item can also be addressed by index', () => {
  const runtime = createStore();
  const resolved = resolveLocation(
    fieldLocation(itemLocation(stateLocation(STATE), indexSelector(literal(0))), F_LABEL),
    {},
    runtime,
  );
  assert.equal(resolved.read(), 'First');
});

test('nested fields inside a collection item resolve', () => {
  const runtime = createStore({ [PARAM]: 'r1' });
  const location = fieldLocation(
    fieldLocation(itemLocation(stateLocation(STATE), identitySelector(F_ID, ref(PARAM))), F_NESTED),
    F_LABEL,
  );
  const resolved = resolveLocation(location, {}, runtime);

  assert.equal(resolved.read(), 'inner');
  assert.equal(describePath(resolved.path), 'state_records → [r1] → field_nested → field_label');

  resolved.write('deep');
  const records = runtime.values.get(STATE) as Array<Record<string, Record<string, string>>>;
  assert.equal(records[0][F_NESTED][F_LABEL], 'deep');
});

test('writing rebuilds the path instead of mutating stored objects', () => {
  const runtime = createStore({ [PARAM]: 'r1' });
  const before = runtime.values.get(STATE) as unknown[];
  const untouched = before[1];

  resolveLocation(
    fieldLocation(itemLocation(stateLocation(STATE), identitySelector(F_ID, ref(PARAM))), F_LABEL),
    {},
    runtime,
  ).write('Rewritten');

  const after = runtime.values.get(STATE) as unknown[];
  assert.notEqual(after, before, 'the collection is replaced, not edited in place');
  assert.notEqual(after[0], before[0], 'the addressed item is a new object');
  assert.equal(after[1], untouched, 'items off the path keep their identity');
  assert.equal((before[0] as Record<string, string>)[F_LABEL], 'First', 'the old value is unchanged');
});

test('addressing a missing item fails loudly rather than writing nowhere', () => {
  const runtime = createStore({ [PARAM]: 'absent' });
  const resolved = resolveLocation(
    fieldLocation(itemLocation(stateLocation(STATE), identitySelector(F_ID, ref(PARAM))), F_LABEL),
    {},
    runtime,
  );

  assert.equal(resolved.read(), null, 'reading an absent item yields nothing');
  assert.throws(() => resolved.write('x'), LocationResolutionError);
});
