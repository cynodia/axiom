import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SERVER_IR_CONTRACT, SERVER_IR_CONTRACTS } from '@cynodia/axiom-core';
import { PROTOCOL_VERSION, runConformanceFixture } from '@cynodia/axiom-server';
import type { ConformanceFixture, ConformanceManifest } from '@cynodia/axiom-server';

/**
 * The conformance suite.
 *
 * Every fixture is pure data: a Server IR, the state to start from, invocations to perform
 * and the results expected. This test runs each one through the **public** reference runner
 * (`runConformanceFixture`, `@cynodia/axiom-server`) rather than a parallel, potentially
 * drifting reimplementation — so proving the fixtures pass here is the same thing as proving
 * the exported runner is correct (spec 8.2 §14-16,59).
 *
 * Regenerate with `npm run conformance:generate`.
 */

/** Resolved from the compiled test, which sits in `dist-test/` beside `conformance/`. */
const directory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance');
const files = (await readdir(directory))
  .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
  .sort();

assert.ok(files.length > 0, 'there are conformance fixtures to run');

/** The manifest is the entry point a non-JavaScript implementation is expected to read. */
const manifest = JSON.parse(
  await readFile(path.join(directory, 'manifest.json'), 'utf8'),
) as ConformanceManifest;

for (const file of files) {
  const fixture = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as ConformanceFixture;

  test(`conformance: ${fixture.name} — ${fixture.description}`, async () => {
    const result = await runConformanceFixture(fixture);
    assert.ok(
      result.ok,
      `${fixture.name} failed:\n${result.failures.map((failure) => `  [${failure.where}] ${failure.message}`).join('\n')}`,
    );
  });
}

test('the fixtures cover every area the contract requires', async () => {
  const covered = new Set<string>();
  for (const file of files) {
    const fixture = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as ConformanceFixture;
    fixture.covers.forEach((area) => covered.add(area));
  }
  for (const area of [
    'expression evaluation',
    'action guards',
    'mutation',
    'rollback',
    'constraints',
    'transition constraints',
    'for-each provisional writes',
    'authorization',
    'persistence',
    'restart',
    'concurrent mutation',
  ]) {
    assert.ok(covered.has(area), `no fixture covers "${area}"`);
  }
});

test('a fixture is self-contained data, with nothing of this implementation in it', async () => {
  for (const file of files) {
    const source = await readFile(path.join(directory, file), 'utf8');
    // `"function": "sum"` is a builtin's name — data. Executable text is what must be absent.
    assert.doesNotMatch(source, /=>|\bfunction\s*\(|\brequire\(|^import /m, `${file} contains code`);
    // It carries its own IR, so a runtime needs no compiler to execute it.
    const fixture = JSON.parse(source) as ConformanceFixture;
    assert.ok((SERVER_IR_CONTRACTS as readonly string[]).includes(fixture.serverIR.contract));
    assert.ok(fixture.serverIR.states.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture);
  }
});

test('the manifest describes exactly the fixtures that ship', () => {
  // An implementer who reads only the manifest must see the whole suite: a fixture missing
  // from it is a fixture nobody outside this repository knows to run.
  assert.equal(manifest.conformance, 'axiom.conformance.v1');
  // The manifest-level field names the OLDEST contract any fixture may use, not the
  // contract of the suite as a whole — the suite ships v1 through v4 fixtures at once
  // (spec 8.2 §9-10). Every fixture's own `contract` is checked against the full set below.
  assert.equal(manifest.baseContract, SERVER_IR_CONTRACT);
  assert.ok(
    manifest.fixtures.every((entry) => (SERVER_IR_CONTRACTS as readonly string[]).includes(entry.contract)),
    'every fixture entry names a recognized Server IR contract',
  );
  assert.equal(manifest.protocol, PROTOCOL_VERSION);
  assert.deepEqual(
    manifest.fixtures.map((entry) => entry.file).sort(),
    files,
    'every fixture file is listed, and every listed file exists',
  );
});

test('the manifest is reachable through the package export map', async () => {
  // Shipping the files is not the same as making them addressable: an exports map without
  // a conformance subpath hides them from every consumer, which is what 0.6.0 did.
  const manifestPath = JSON.parse(
    await readFile(path.resolve(directory, '../package.json'), 'utf8'),
  ) as { exports: Record<string, unknown>; files: string[] };
  assert.equal(manifestPath.exports['./conformance'], './conformance/manifest.json');
  assert.equal(manifestPath.exports['./conformance/*'], './conformance/*');
  assert.ok(manifestPath.files.includes('conformance/*.json'));
});

test('runConformanceFixture reports a structured failure, not a throw, for an unmet expectation', async () => {
  const [first] = files;
  const fixture = JSON.parse(await readFile(path.join(directory, first), 'utf8')) as ConformanceFixture;
  const broken: ConformanceFixture = { ...fixture, expectedState: { ...fixture.expectedState, __bogus__: 'never' } };
  const result = await runConformanceFixture(broken);
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
  assert.ok(result.failures.some((failure) => failure.message.includes('__bogus__')));
});
