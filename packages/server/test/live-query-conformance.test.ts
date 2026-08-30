import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMemoryDataProvider,
  createSqliteDataProvider,
  isSqliteDataProviderAvailable,
  runLiveQueryConformanceFixture,
  runLiveQueryConformanceSuite,
} from '@cynodia/axiom-server';
import type { LiveQueryConformanceFixture } from '@cynodia/axiom-server';

/**
 * spec13 §152, §194 — the portable `axiom.conformance.v7` live-query tier. Every fixture is
 * self-contained data; the runner uses only the public `DataProvider` contract.
 */

const dir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance/live');

async function loadFixtures(): Promise<LiveQueryConformanceFixture[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json') && name !== 'manifest.json');
  return Promise.all(
    files.sort().map(async (name) => JSON.parse(await readFile(path.join(dir, name), 'utf8')) as LiveQueryConformanceFixture),
  );
}

const fixtures = await loadFixtures();
const sqliteAvailable = await isSqliteDataProviderAvailable();

const memoryProvider = (dataset: Record<string, Array<Record<string, unknown>>>) =>
  createMemoryDataProvider({ rows: dataset as never, maxPageSize: 100 });

test('the live-query conformance suite covers the spec13 §186 areas', () => {
  const covered = new Set(fixtures.flatMap((fixture) => fixture.covers));
  for (const area of [
    'initial',
    'insert',
    'remove',
    'update',
    'ordering-move',
    'limit-boundary',
    'reset',
    'aggregate',
    'capability',
    'no-op',
  ]) {
    assert.ok(covered.has(area), `no fixture covers "${area}"`);
  }
  assert.ok(fixtures.length >= 10, `expected >= 10 fixtures, found ${fixtures.length}`);
  for (const fixture of fixtures) {
    assert.equal(fixture.conformance, 'axiom.conformance.v7');
  }
});

for (const fixture of fixtures) {
  test(`memory provider — ${fixture.name}`, async () => {
    const result = await runLiveQueryConformanceFixture(fixture, { makeProvider: memoryProvider });
    assert.ok(result.passed, result.failures.join('\n'));
  });

  test(`SQLite provider — ${fixture.name}`, { skip: !sqliteAvailable }, async () => {
    const result = await runLiveQueryConformanceFixture(fixture, {
      makeProvider: (dataset, ir) =>
        createSqliteDataProvider({
          location: ':memory:',
          entities: ir.entities,
          relationships: ir.relationships ?? [],
          seed: dataset as never,
          maxPageSize: 100,
        }),
    });
    assert.ok(result.passed, result.failures.join('\n'));
  });
}

test('runLiveQueryConformanceSuite reports the aggregate outcome', async () => {
  const suite = await runLiveQueryConformanceSuite(fixtures, { makeProvider: memoryProvider });
  assert.equal(suite.passed, true, JSON.stringify(suite.results.filter((r) => !r.passed), null, 2));
  assert.equal(suite.results.length, fixtures.length);
});

test('negative control — a corrupted expected change set fails the runner', async () => {
  const base = fixtures.find((fixture) => fixture.name === 'insert-on-filter-entry');
  assert.ok(base);
  const tampered: LiveQueryConformanceFixture = {
    ...base,
    steps: base.steps.map((step) => ({
      ...step,
      expect: { kind: 'update', changes: [{ kind: 'remove', key: 'b' }] }, // was insert
    })),
  };
  const result = await runLiveQueryConformanceFixture(tampered, { makeProvider: memoryProvider });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('change set mismatch')), result.failures.join('\n'));
});

test('negative control — a corrupted expected initial result fails the runner', async () => {
  const base = fixtures.find((fixture) => fixture.name === 'initial-result');
  assert.ok(base);
  const tampered: LiveQueryConformanceFixture = {
    ...base,
    expectInitial: [{ field_order_id: 'wrong', field_order_status: 'open', field_order_total: 1 }],
  };
  const result = await runLiveQueryConformanceFixture(tampered, { makeProvider: memoryProvider });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('initial rows mismatch')), result.failures.join('\n'));
});
