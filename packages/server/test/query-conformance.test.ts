import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMemoryDataProvider,
  createSqliteDataProvider,
  isSqliteDataProviderAvailable,
  runQueryConformanceFixture,
} from '@cynodia/axiom-server';
import type { QueryConformanceFixture } from '@cynodia/axiom-server';

const dir = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../conformance/queries',
);

async function loadFixtures(): Promise<QueryConformanceFixture[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json') && name !== 'manifest.json');
  return Promise.all(
    files.sort().map(async (name) => JSON.parse(await readFile(path.join(dir, name), 'utf8')) as QueryConformanceFixture),
  );
}

const fixtures = await loadFixtures();
const sqliteAvailable = await isSqliteDataProviderAvailable();

test('the query conformance suite covers the spec §89 areas', () => {
  const covered = new Set(fixtures.flatMap((fixture) => fixture.covers));
  for (const area of ['filter', 'sort', 'projection', 'pagination', 'relationship', 'aggregate', 'group', 'read-policy', 'null-semantics']) {
    assert.ok(covered.has(area), `no fixture covers "${area}"`);
  }
  assert.ok(fixtures.length >= 16, `expected >= 16 fixtures, found ${fixtures.length}`);
});

for (const fixture of fixtures) {
  test(`memory provider — ${fixture.name}`, async () => {
    const result = await runQueryConformanceFixture(fixture, {
      makeProvider: (dataset) =>
        createMemoryDataProvider({ rows: dataset as never, maxPageSize: 50 }),
    });
    assert.ok(result.passed, result.failures.join('\n'));
  });

  test(`SQLite provider — ${fixture.name}`, { skip: !sqliteAvailable }, async () => {
    const result = await runQueryConformanceFixture(fixture, {
      makeProvider: (dataset, ir) =>
        createSqliteDataProvider({
          location: ':memory:',
          entities: ir.entities,
          relationships: ir.relationships ?? [],
          seed: dataset as never,
          maxPageSize: 50,
        }),
    });
    assert.ok(result.passed, result.failures.join('\n'));
  });
}

test('memory and SQLite produce identical query results for every fixture', { skip: !sqliteAvailable }, async () => {
  for (const fixture of fixtures) {
    const memory = await runQueryConformanceFixture(fixture, {
      makeProvider: (dataset) => createMemoryDataProvider({ rows: dataset as never, maxPageSize: 50 }),
    });
    const sqlite = await runQueryConformanceFixture(fixture, {
      makeProvider: (dataset, ir) =>
        createSqliteDataProvider({
          location: ':memory:',
          entities: ir.entities,
          relationships: ir.relationships ?? [],
          seed: dataset as never,
          maxPageSize: 50,
        }),
    });
    assert.deepEqual(sqlite.queryResults, memory.queryResults, `${fixture.name}: provider results diverge`);
  }
});
