import assert from 'node:assert/strict';
import test from 'node:test';
import { fieldId, literal, nodeId, primitiveType } from '@cynodia/axiom-core';
import type { MigrationOperation } from '@cynodia/axiom-core';
import {
  createMemoryMigrationStore,
  isMigrationCapable,
  planPhysicalMigration,
} from '@cynodia/axiom-server';
import type { SemanticMigrationPlan } from '@cynodia/axiom-server';

const E = nodeId('entity_order');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');

// ---------------------------------------------------------------- the durable store

test('a fresh store has no schema record and a free lock', async () => {
  const store = createMemoryMigrationStore();
  assert.equal(await store.readSchema(), null);
  assert.equal(await store.readLock(), null);
  assert.equal(await store.readCheckpoint(), null);
});

test('writeSchema stamps version + fingerprint, appendHistory is idempotent', async () => {
  let clock = 1000;
  const store = createMemoryMigrationStore({ now: () => clock });
  await store.writeSchema(2, 'fp-2');
  const entry = {
    migrationId: 'm_1_2',
    fromSchema: 1,
    toSchema: 2,
    operationIds: ['op1'],
    completedAt: clock,
  };
  await store.appendHistory(entry);
  clock = 2000;
  await store.appendHistory(entry); // same migrationId — no-op (spec11 §35)
  const record = await store.readSchema();
  assert.equal(record?.schemaVersion, 2);
  assert.equal(record?.schemaFingerprint, 'fp-2');
  assert.equal(record?.history.length, 1);
});

test('the migration lock is exclusive while the lease is live', async () => {
  let clock = 0;
  const store = createMemoryMigrationStore({ now: () => clock });
  const a = await store.acquireLock('server-A', 5000);
  assert.equal(a.ok, true);
  const b = await store.acquireLock('server-B', 5000);
  assert.equal(b.ok, false);
  assert.equal(b.heldBy?.holder, 'server-A');
});

test('an expired lease is reclaimable by another instance (crash recovery, spec11 §67)', async () => {
  let clock = 0;
  const store = createMemoryMigrationStore({ now: () => clock });
  const a = await store.acquireLock('server-A', 5000);
  assert.equal(a.ok, true);
  clock = 6000; // A crashed; its lease has expired
  const b = await store.acquireLock('server-B', 5000);
  assert.equal(b.ok, true);
  assert.equal(b.lock?.holder, 'server-B');
  // A's stale token can no longer renew or corrupt the lock.
  assert.equal(await store.renewLock(a.lock!.token, 5000), false);
});

test('renewLock extends only for the current holder; releaseLock frees it', async () => {
  let clock = 0;
  const store = createMemoryMigrationStore({ now: () => clock });
  const a = await store.acquireLock('server-A', 5000);
  clock = 4000;
  assert.equal(await store.renewLock(a.lock!.token, 5000), true);
  clock = 8000; // would have expired without the renew
  assert.notEqual(await store.readLock(), null);
  await store.releaseLock(a.lock!.token);
  assert.equal(await store.readLock(), null);
});

test('checkpoints round-trip and clear', async () => {
  const store = createMemoryMigrationStore({ now: () => 42 });
  await store.writeCheckpoint({
    planId: 'plan-1',
    targetFingerprint: 'fp-3',
    operationIndex: 2,
    batchCursor: 'row-1000',
    rowsProcessed: 1000,
    updatedAt: 0,
  });
  const cp = await store.readCheckpoint();
  assert.equal(cp?.operationIndex, 2);
  assert.equal(cp?.batchCursor, 'row-1000');
  assert.equal(cp?.updatedAt, 42);
  await store.clearCheckpoint();
  assert.equal(await store.readCheckpoint(), null);
});

// ---------------------------------------------------------------- the physical plan

function semanticPlan(operations: MigrationOperation[]): SemanticMigrationPlan {
  const capsNeeded = operations.some((o) =>
    ['populate-field', 'transform-field', 'transform-record'].includes(o.kind) ||
    (o.kind === 'add-field' && 'populate' in o && o.populate),
  )
    ? (['batched-transform', 'checkpointing'] as const)
    : (['atomic-schema-change'] as const);
  return {
    fromVersion: 1,
    toVersion: 2,
    steps: [{ migrationId: 'm_1_2', fromSchema: 1, toSchema: 2, operations }],
    operationCount: operations.length,
    affectedEntities: [String(E)],
    affectedFields: [],
    destructive: [],
    transformations: [],
    providerCapabilitiesRequired: [...capsNeeded],
    reversibility: 'irreversible',
    hasDataLoss: false,
  };
}

test('planPhysicalMigration: schema-only changes are atomic DDL', () => {
  const plan = planPhysicalMigration(
    semanticPlan([
      { id: nodeId('op1'), kind: 'add-field', entityId: E, field: { id: F_STATUS, valueType: primitiveType('string') } },
    ]),
    ['atomic-schema-change', 'transactional-ddl'],
  );
  assert.equal(plan.strategy, 'atomic-ddl');
  assert.equal(plan.batched, false);
  assert.equal(plan.atomic, true);
  assert.equal(plan.boundedMemory, true);
  assert.deepEqual(plan.unsupported, []);
  assert.equal(plan.steps[0].strategy, 'atomic-ddl');
});

test('planPhysicalMigration: a transform is batched and not atomic', () => {
  const plan = planPhysicalMigration(
    semanticPlan([
      {
        id: nodeId('op1'),
        kind: 'transform-field',
        entityId: E,
        fieldId: F_TOTAL,
        fromType: primitiveType('string'),
        toType: primitiveType('number'),
        expression: literal(0),
      },
    ]),
    ['batched-transform', 'checkpointing'],
  );
  assert.equal(plan.strategy, 'batched-transform');
  assert.equal(plan.batched, true);
  assert.equal(plan.atomic, false);
  assert.equal(plan.steps[0].batched, true);
  assert.deepEqual(plan.unsupported, []);
});

test('planPhysicalMigration: a missing capability lands in unsupported (spec11 §79)', () => {
  const plan = planPhysicalMigration(
    semanticPlan([
      {
        id: nodeId('op1'),
        kind: 'transform-record',
        entityId: E,
        produce: literal(0),
      },
    ]),
    ['atomic-schema-change'], // no batched-transform / checkpointing
  );
  assert.ok(plan.unsupported.includes('batched-transform'));
  assert.ok(plan.unsupported.includes('checkpointing'));
});

test('isMigrationCapable recognises the provider contract', () => {
  assert.equal(isMigrationCapable({}), false);
  assert.equal(
    isMigrationCapable({ migrationCapabilities: [], planPhysicalMigration: () => ({}) }),
    true,
  );
});
