import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSqliteRowStore,
  isSqliteMigrationAvailable,
  memoryConformanceRowStore,
  runMigrationConformanceFixture,
} from '@cynodia/axiom-server';
import type { MigrationConformanceFixture } from '@cynodia/axiom-server';

const here = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const dir = path.join(here, '../conformance/migrations');
const sqliteAvailable = await isSqliteMigrationAvailable();

const files = (await readdir(dir)).filter((name) => name.endsWith('.json') && name !== 'manifest.json').sort();
const fixtures: MigrationConformanceFixture[] = await Promise.all(
  files.map(async (name) => JSON.parse(await readFile(path.join(dir, name), 'utf8')) as MigrationConformanceFixture),
);

test('the migration conformance suite covers the spec11 §84 scenarios', () => {
  const names = new Set(fixtures.map((fixture) => fixture.name));
  for (const required of [
    'metadata-only-change',
    'add-optional-field',
    'add-required-field-with-default',
    'transform-field',
    'remove-empty-field',
    'destructive-removal-refused',
    'destructive-removal-approved',
    'relationship-addition',
    'record-transformation',
    'large-batched-transformation',
    'crash-and-resume',
    'idempotent-rerun',
    'missing-migration-path',
    'invalid-target-record',
    'migration-lock',
    'schema-fingerprint-mismatch',
  ]) {
    assert.ok(names.has(required), `fixture "${required}" is present`);
  }
  assert.ok(fixtures.every((fixture) => fixture.conformance === 'axiom.conformance.v5'));
});

for (const fixture of fixtures) {
  test(`memory conformance: ${fixture.name}`, async () => {
    const result = await runMigrationConformanceFixture(fixture, {
      makeRowStore: (sourceData) => memoryConformanceRowStore(sourceData),
    });
    assert.deepEqual(result.failures, [], `${fixture.name}: ${result.failures.join('\n')}`);
  });

  test(`SQLite conformance: ${fixture.name}`, { skip: !sqliteAvailable }, async () => {
    const result = await runMigrationConformanceFixture(fixture, {
      makeRowStore: (sourceData, ir) => createSqliteRowStore({ location: ':memory:', ir, seed: sourceData }),
    });
    assert.deepEqual(result.failures, [], `${fixture.name}: ${result.failures.join('\n')}`);
  });

  test(`memory ≡ SQLite target data: ${fixture.name}`, { skip: !sqliteAvailable }, async () => {
    const mem = await runMigrationConformanceFixture(fixture, {
      makeRowStore: (sourceData) => memoryConformanceRowStore(sourceData),
    });
    const sql = await runMigrationConformanceFixture(fixture, {
      makeRowStore: (sourceData, ir) => createSqliteRowStore({ location: ':memory:', ir, seed: sourceData }),
    });
    assert.deepEqual(sql.resultData, mem.resultData, `${fixture.name}: providers diverged`);
  });
}
