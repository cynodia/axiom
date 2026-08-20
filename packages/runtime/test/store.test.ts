import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createStateStore } from '@cynodia/axiom-runtime';

test('the store hands out values that cannot be changed behind its back', () => {
  const store = createStateStore();
  store.write('state_records', [{ label: 'First' }]);

  const value = store.read('state_records') as Array<Record<string, string>>;
  assert.ok(Object.isFrozen(value), 'the collection is frozen');
  assert.ok(Object.isFrozen(value[0]), 'and so is everything inside it');
  assert.throws(() => {
    value[0].label = 'Changed';
  }, TypeError);
  assert.throws(() => {
    value.push({ label: 'Extra' });
  }, TypeError);

  store.write('state_records', [...value, { label: 'Second' }]);
  assert.equal((store.read('state_records') as unknown[]).length, 2);
});

test('a snapshot restores exactly what was captured', () => {
  const store = createStateStore();
  store.write('a', 1);
  const snapshot = store.capture();

  store.write('a', 2);
  store.write('b', 3);
  assert.deepEqual(store.keys().sort(), ['a', 'b']);

  store.restore(snapshot);
  assert.equal(store.read('a'), 1);
  assert.deepEqual(store.keys(), ['a']);
});

/**
 * Section 47 — all managed state writes live in one place. This checks the structure
 * that makes that true: nothing outside the mutation subsystem owns a state map, and
 * `runtime.ts` touches the store only while seeding it and inside its single write path.
 */
const runtimeSrc = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../src');

/** The body of a named function, matched by braces. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    }
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Could not find the end of ${signature}`);
}

test('the store is created once, by the runtime, from the mutation subsystem', async () => {
  const entries = await readdir(runtimeSrc, { withFileTypes: true });
  const modules = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));

  let constructions = 0;
  for (const entry of modules) {
    const source = await readFile(path.join(runtimeSrc, entry.name), 'utf8');
    constructions += (source.match(/createStateStore\(\)/g) ?? []).length;
  }

  assert.equal(constructions, 1, 'there is exactly one application state store');
});

test('the runtime writes state only while seeding and through one write path', async () => {
  const source = await readFile(path.join(runtimeSrc, 'runtime.ts'), 'utf8');
  const total = (source.match(/store\.write\(/g) ?? []).length;
  const accountedFor =
    (functionBody(source, 'function initializeStore(').match(/store\.write\(/g) ?? []).length +
    (functionBody(source, 'function writeState(').match(/store\.write\(/g) ?? []).length;

  assert.equal(total, accountedFor, 'a store write appeared outside initialization and writeState');
  assert.ok(total > 0, 'the check would be vacuous if the runtime never wrote state');
});
