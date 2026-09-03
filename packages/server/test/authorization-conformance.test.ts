import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSqlitePersistence,
  isSqliteAvailable,
  runAuthorizationConformanceFixture,
  runAuthorizationConformanceSuite,
} from '@cynodia/axiom-server';
import type { AuthorizationConformanceFixture } from '@cynodia/axiom-server';

/**
 * spec15 §71-§73, §114-§115 — the portable `axiom.conformance.v9` authorization tier. Every
 * fixture is self-contained data; the runner uses a real `createAxiomServer` and asserts the
 * runtime's decision matches the one the fixture author computed independently, and that a
 * denied step changed nothing.
 */

const dir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance/authorization');

async function load(): Promise<AuthorizationConformanceFixture[]> {
  const files = (await readdir(dir)).filter((n) => n.endsWith('.json') && n !== 'manifest.json');
  return Promise.all(
    files.sort().map(async (n) => JSON.parse(await readFile(path.join(dir, n), 'utf8')) as AuthorizationConformanceFixture),
  );
}

const fixtures = await load();

const REQUIRED_CATEGORIES = [
  'allow',
  'deny',
  'anonymous',
  'owner',
  'cross-principal',
  'role/claim condition',
  'resource-owner condition',
  'tenant isolation',
  'query filtering',
  'action invocation',
  'workflow continuation',
  'workflow cancellation',
  'workflow inspection',
  'live-query resume',
  'mixed-build policy change',
];

test('the authorization conformance suite covers every spec15 §71 category', () => {
  const covered = new Set(fixtures.flatMap((f) => f.covers));
  for (const category of REQUIRED_CATEGORIES) {
    assert.ok(covered.has(category), `no fixture covers "${category}"`);
  }
  assert.ok(fixtures.length >= 10, `expected ≥10 fixtures, got ${fixtures.length}`);
  for (const f of fixtures) assert.equal(f.conformance, 'axiom.conformance.v9');
});

for (const fixture of fixtures) {
  test(`authorization conformance — ${fixture.name} (memory)`, async () => {
    const result = await runAuthorizationConformanceFixture(fixture);
    assert.deepEqual(result.failures, [], result.failures.join('\n'));
    assert.equal(result.passed, true);
  });
}

test('spec15 §114/§115: every fixture produces the same decisions over SQLite persistence', async (t) => {
  if (!(await isSqliteAvailable())) {
    t.skip('node:sqlite unavailable');
    return;
  }
  for (const fixture of fixtures) {
    const persistence = await createSqlitePersistence({ location: ':memory:' });
    const result = await runAuthorizationConformanceFixture(fixture, { persistence });
    assert.deepEqual(result.failures, [], `${fixture.name} over SQLite:\n${result.failures.join('\n')}`);
  }
});

test('runAuthorizationConformanceSuite folds the whole tier', async () => {
  const { passed, results } = await runAuthorizationConformanceSuite(fixtures);
  assert.equal(
    passed,
    true,
    results
      .filter((r) => !r.passed)
      .map((r) => `${r.name}: ${r.failures.join('; ')}`)
      .join('\n'),
  );
});
