import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDurableWorkStore,
  createMemoryCoordinationProvider,
  createMemoryDurableWorkStorage,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
  isSqliteDurableWorkAvailable,
} from '@cynodia/axiom-server';
import type { DurableWorkStorage, CoordinationProvider } from '@cynodia/axiom-server';
import { compareAuthorityCompatibility } from '@cynodia/axiom-core';

/**
 * spec12 §43-§47: an incompatible / older-build authority never executes new-schema work.
 *
 * `createDurableWorkStore({ authorityKey })` stamps its key onto enqueued work and refuses
 * to `claim` any item whose stored key differs — the refused item stays claimable by a
 * compatible authority and is visible via `listIncompatible`.
 */

const sqliteAvailable = await isSqliteDurableWorkAvailable();
const KEY_A = 'build-A:schema4:v7:sem-aaa';
const KEY_B = 'build-B:schema4:v7:sem-bbb'; // same schema, different semantic fingerprint

async function bothBackends(
  body: (storage: DurableWorkStorage, coordA: CoordinationProvider, coordB: CoordinationProvider, label: string) => Promise<void>,
): Promise<void> {
  await body(
    createMemoryDurableWorkStorage(),
    createMemoryCoordinationProvider(),
    createMemoryCoordinationProvider(),
    'memory',
  );
  if (!sqliteAvailable) return;
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-dw-compat-'));
  const storage = await createSqliteDurableWorkStorage({ location: path.join(dir, 'work.db') });
  const coordA = await createSqliteCoordinationProvider({ location: path.join(dir, 'coord.db') });
  const coordB = await createSqliteCoordinationProvider({ location: path.join(dir, 'coord.db') });
  await body(storage, coordA, coordB, 'sqlite');
  await storage.close?.();
  await coordA.close?.();
  await coordB.close?.();
  rmSync(dir, { recursive: true, force: true });
}

test('a mismatched-build authority refuses to claim work another build enqueued (spec12 §44)', async () => {
  await bothBackends(async (storage, coordA, coordB, label) => {
    const storeA = createDurableWorkStore({ coordination: coordA, storage, authorityKey: KEY_A });
    const storeB = createDurableWorkStore({ coordination: coordB, storage, authorityKey: KEY_B });

    const { item } = await storeA.enqueue({ workClass: 'effect', workId: 'e1', payload: {} });
    assert.equal(item.compatibilityKey, KEY_A, `${label}: enqueue stamps the creator's key`);

    const bClaims = await storeB.claim('effect', 'B', { leaseMs: 10_000 });
    assert.equal(bClaims.length, 0, `${label}: the incompatible build claims nothing`);

    const incompatible = await storeB.listIncompatible('effect');
    assert.deepEqual(incompatible.map((r) => r.workId), ['e1'], `${label}: B can see it is stranded for it`);

    const aClaims = await storeA.claim('effect', 'A', { leaseMs: 10_000 });
    assert.deepEqual(aClaims.map((c) => c.item.workId), ['e1'], `${label}: the matching build runs it`);
  });
});

test('unkeyed work is claimable by any authority; a keyed store still stamps new work', async () => {
  await bothBackends(async (storage, coordA, coordB, label) => {
    // Work enqueued by a store with NO authorityKey carries a null key.
    const legacy = createDurableWorkStore({ coordination: coordA, storage });
    const { item } = await legacy.enqueue({ workClass: 'effect', workId: 'legacy', payload: {} });
    assert.equal(item.compatibilityKey, null, `${label}`);

    const storeB = createDurableWorkStore({ coordination: coordB, storage, authorityKey: KEY_B });
    const claims = await storeB.claim('effect', 'B', { leaseMs: 10_000 });
    assert.deepEqual(claims.map((c) => c.item.workId), ['legacy'], `${label}: null key = anyone may run it`);

    const { item: keyed } = await storeB.enqueue({ workClass: 'effect', workId: 'new', payload: {} });
    assert.equal(keyed.compatibilityKey, KEY_B, `${label}: the keyed store stamps its own new work`);
  });
});

test('compareAuthorityCompatibility drives the refuse decision', () => {
  const a = { schemaVersion: 4, schemaFingerprint: 's', serverContract: 'axiom.server.v7', semanticFingerprint: 'x' };
  assert.equal(compareAuthorityCompatibility(a, { ...a }).compatible, true);
  assert.equal(compareAuthorityCompatibility(a, { ...a, semanticFingerprint: 'y' }).compatible, false);
});
