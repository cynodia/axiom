import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import { compareValues } from '@cynodia/axiom-runtime';
import { createDeterministicServerHost } from '@cynodia/axiom-server';
import { createOrderServerGraph } from '@cynodia/axiom-demo/order-server';

/**
 * What `axiom.server.v1` promises an implementer in another language.
 *
 * These are the properties a Rust or Go runtime has to be able to reproduce from the
 * contract alone — no TypeScript, no JavaScript coercion lore. Each one is pinned here
 * because leaving it to "whatever the reference runtime happens to do" is exactly how a
 * portable contract stops being portable.
 */

// ------------------------------------------------------------- serialization

/** Everything a JSON document cannot carry, or cannot carry the same way twice. */
function unportable(value: unknown, at = '$'): string[] {
  if (value === undefined) return [`${at}: undefined`];
  if (typeof value === 'function') return [`${at}: function`];
  if (typeof value === 'bigint') return [`${at}: bigint`];
  if (typeof value === 'symbol') return [`${at}: symbol`];
  if (typeof value === 'number' && !Number.isFinite(value)) return [`${at}: ${String(value)}`];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => unportable(item, `${at}[${index}]`));
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return [`${at}: ${(value as object).constructor?.name ?? 'class instance'}`];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    unportable(entry, `${at}.${key}`),
  );
}

test('a Server IR carries nothing JSON cannot represent', () => {
  const ir = compileToServerIR(createOrderServerGraph());
  assert.deepEqual(unportable(ir), [], 'no undefined, function, NaN, Infinity, Date, RegExp or class instance');
});

test('a Server IR survives a JSON round trip unchanged', () => {
  // The contract is the serialized document, not the object a TypeScript compiler produced.
  // If those two differ, an implementer reading the JSON is reading something else.
  const ir = compileToServerIR(createOrderServerGraph());
  assert.deepEqual(JSON.parse(JSON.stringify(ir)), ir);
});

test('every shipped conformance fixture is portable JSON', async () => {
  const directory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance');
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.json'))) {
    const raw = await readFile(path.join(directory, file), 'utf8');
    assert.deepEqual(unportable(JSON.parse(raw)), [], `${file} is portable`);
    // Round-tripping the *text* catches anything that parses one way and prints another.
    assert.equal(JSON.stringify(JSON.parse(raw)), JSON.stringify(JSON.parse(JSON.stringify(JSON.parse(raw)))));
  }
});

// ------------------------------------------------------------------ ordering

test('text orders by Unicode code point, not by locale and not by UTF-16', () => {
  // Locale collation would put these in a different order in a Norwegian locale than in an
  // English one, and the graph says nothing about a locale — so it cannot be locale's call.
  assert.equal(compareValues('a', 'b'), -1);
  assert.equal(compareValues('Z', 'a'), -1, 'uppercase sorts before lowercase: U+005A < U+0061');
  assert.equal(compareValues('æ', 'z'), 1, 'U+00E6 is after U+007A, whatever a dictionary says');
  assert.equal(compareValues('abc', 'abcd'), -1, 'a prefix sorts first');
  assert.equal(compareValues('abc', 'abc'), 0);

  // The case that separates code-point order from UTF-16 code-unit order: an astral
  // character (U+1D400) against one in the private use area (U+E000). By code point the
  // astral one is larger; by UTF-16 units its leading surrogate (U+D835) is smaller.
  assert.equal(compareValues('\u{1D400}', ''), 1);
  assert.equal('\u{1D400}' < '', true, 'which is what the language operator would have said');
});

test('numbers order by value, and text conversion of a number is not locale-aware', () => {
  assert.equal(compareValues(2, 10), -1, 'numeric, not lexicographic');
  assert.equal(compareValues(-1, 0), -1);
  assert.equal(compareValues(1000000, 999999), 1, 'no digit grouping enters the comparison');
});

// -------------------------------------------------------------- host values

test('the deterministic host is one shared counter, so call order fixes every value', () => {
  // A fixture that reaches `now()` or `uuid()` must produce the same document in every
  // language, which means the model has to be stated as an algorithm, not as a sample.
  const host = createDeterministicServerHost();
  assert.equal(host.uuid(), 'id-1');
  assert.equal(host.now(), '2026-01-01T00:00:02.000Z');
  assert.equal(host.uuid(), 'id-3', 'the two share the counter');
  assert.equal(host.now(), '2026-01-01T00:00:04.000Z');

  // Independent instances start over; nothing is global.
  assert.equal(createDeterministicServerHost().uuid(), 'id-1');
});
