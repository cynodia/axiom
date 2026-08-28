import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateGraph } from '@cynodia/axiom-core';
import type { LiteralValue } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import { migrationImpact } from '@cynodia/axiom-agent-api';
import {
  createMemoryMigrationStore,
  createMemoryRowStore,
  createSqliteRowStore,
  isSqliteMigrationAvailable,
  planMigration,
  runMigration,
} from '@cynodia/axiom-server';
import type { MigrationDataset } from '@cynodia/axiom-server';
import {
  SCHEMA_LETTERS,
  createOrderHistoryGraph,
  historyIds,
  orderHistoryDataset,
} from '@cynodia/axiom-demo';

const H = historyIds;
const sqliteAvailable = await isSqliteMigrationAvailable();

test('every historical schema A–D validates with a contiguous migration chain (spec11 §95)', () => {
  for (const letter of SCHEMA_LETTERS) {
    const result = validateGraph(createOrderHistoryGraph(letter));
    assert.deepEqual(result.errors, [], `${letter}: ${JSON.stringify(result.errors)}`);
  }
});

test('A → B is non-destructive and fully covered (spec11 §97)', () => {
  const impact = migrationImpact(createOrderHistoryGraph('A'), createOrderHistoryGraph('B'));
  assert.equal(impact.verdict, 'migration-required');
  assert.equal(impact.dataLossPossible, false);
  assert.equal(impact.covered, true);
  assert.ok(impact.affectedFields.includes(String(H.orderStatus)));
});

test('A → D is destructive (name split discards a field, legacy field removed) (spec11 §98, §99)', () => {
  const impact = migrationImpact(createOrderHistoryGraph('A'), createOrderHistoryGraph('D'));
  assert.equal(impact.dataLossPossible, true);
  assert.ok(['destructive', 'incompatible-ambiguous'].includes(impact.verdict));
  // A pure diff never pairs "-name +givenName +familyName" as a rename; the transform-record
  // operation is what supplies the intent, and the chain still covers the diff.
  assert.equal(impact.covered, true);
  assert.ok(impact.diff.destructive.some((e) => e.fieldId === String(H.customerLegacyCode)));
});

function dataset(): MigrationDataset {
  const seed = orderHistoryDataset();
  return {
    rows: new Map(Object.entries(seed).map(([id, rows]) => [id, rows.map((r) => ({ ...r }))])),
  };
}

async function evolve(
  toLetter: 'B' | 'C' | 'D',
  data: MigrationDataset,
  approvals: string[] = [],
) {
  const ir = compileToServerIR(createOrderHistoryGraph(toLetter), { validate: false });
  const planned = planMigration(ir, { fromVersion: 1 });
  assert.ok(planned.ok);
  const metadata = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 'source-1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  const run = await runMigration(ir, planned.plan, metadata, createMemoryRowStore(data), {
    holder: 'evolve',
    approveDestructive: approvals,
    batchSize: 4,
  });
  return { run, metadata };
}

test('the full A → D evolution transforms every record and splits the name (spec11 §27, §98)', async () => {
  const data = dataset();
  const { run } = await evolve('D', data, [
    String('op_split_name'),
    String('op_drop_legacy'),
  ]);
  assert.equal(run.ok, true, run.ok ? '' : run.message);

  const customers = data.rows.get(String(H.customer))!;
  const ada = customers.find((c) => c[String(H.customerId)] === 'cust-0')!;
  assert.equal(ada[String(H.customerGiven)], 'Ada');
  assert.equal(ada[String(H.customerFamily)], 'Lovelace');
  assert.equal(String(H.customerName) in ada, false, 'the single-string name was dropped');
  assert.equal(String(H.customerLegacyCode) in ada, false, 'the legacy field was dropped');

  const orders = data.rows.get(String(H.order))!;
  assert.ok(orders.every((o) => o[String(H.orderStatus)] === 'draft'), 'every order gained status');
});

test('A → D without approving the legacy-field removal performs zero writes (spec11 §99, §106)', async () => {
  const data = dataset();
  const before = JSON.stringify(data.rows.get(String(H.customer)));
  const { run, metadata } = await evolve('D', data, [String('op_split_name')]); // no op_drop_legacy
  assert.equal(run.ok, false);
  if (!run.ok) assert.equal(run.code, 'MIGRATION_APPROVAL_REQUIRED');
  assert.equal(JSON.stringify(data.rows.get(String(H.customer))), before, 'nothing was written');
  assert.equal((await metadata.readSchema())?.schemaVersion, 1, 'schema version not advanced');
});

test('memory ≡ SQLite for the C-version name split (spec11 §83)', { skip: !sqliteAvailable }, async () => {
  const irC = compileToServerIR(createOrderHistoryGraph('C'), { validate: false });
  const planned = planMigration(irC, { fromVersion: 1 });
  assert.ok(planned.ok);
  const seed = orderHistoryDataset();

  const memData = dataset();
  const memMeta = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 's1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  await runMigration(irC, planned.plan, memMeta, createMemoryRowStore(memData), {
    holder: 'm',
    approveDestructive: [String('op_split_name')],
    batchSize: 4,
  });

  const sqlStore = await createSqliteRowStore({ location: ':memory:', ir: irC, seed });
  const sqlMeta = createMemoryMigrationStore({
    seed: { schemaVersion: 1, schemaFingerprint: 's1', history: [], updatedAt: 0 },
    now: () => 1,
  });
  await runMigration(irC, planned.plan, sqlMeta, sqlStore, {
    holder: 's',
    approveDestructive: [String('op_split_name')],
    batchSize: 4,
  });

  const norm = (rows: Array<Record<string, LiteralValue>>) =>
    [...rows]
      .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)))
      .sort((a, b) => String(a[String(H.customerId)]).localeCompare(String(b[String(H.customerId)])));

  assert.deepEqual(norm(sqlStore.snapshot(String(H.customer))), norm(memData.rows.get(String(H.customer))!));
});

test('the reference evolution has no application SQL, no callback and no native operation (spec11 §107)', async () => {
  const source = await readFile(
    path.join(fileURLToPath(new URL('.', import.meta.url)), '../src/order-management-history.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /\bSELECT\b|\bALTER TABLE\b|\bUPDATE\b\s+\w/i, 'no raw SQL');
  assert.doesNotMatch(source, /kind:\s*'native'/, 'no NativeOperation');
  assert.doesNotMatch(source, /=>\s*\{[^}]*\bawait\b/, 'no async migration callback');
});
