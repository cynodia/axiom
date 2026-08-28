import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  coordinationResourceId,
  createMemoryCoordinationProvider,
  createSqliteCoordinationProvider,
  isSqliteCoordinationAvailable,
} from '@cynodia/axiom-server';
import type { CoordinationProvider } from '@cynodia/axiom-server';

/**
 * Spec12 §11, §64: the SQLite coordination provider must be a faithful implementation of
 * the same semantic contract the memory reference defines. This file runs the reference
 * assertions against SQLite in-process (one connection, several logical authorities); the
 * genuine cross-process guarantees — real OS processes, SIGKILL, reclaim — live in
 * `coordination-race.test.ts`.
 */

const available = await isSqliteCoordinationAvailable();

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** Run one body against both providers so parity is asserted by construction. */
async function bothProviders(
  clock: ReturnType<typeof fakeClock>,
  body: (provider: CoordinationProvider, label: string) => Promise<void>,
): Promise<void> {
  const memory = createMemoryCoordinationProvider({ now: clock.now });
  await body(memory, 'memory');
  if (!available) return;
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-coord-'));
  try {
    const sqlite = await createSqliteCoordinationProvider({
      location: path.join(dir, 'coord.db'),
      now: clock.now,
    });
    await body(sqlite, 'sqlite');
    await sqlite.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SQLite provider: acquire / block / reclaim-bumps-generation', { skip: !available }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-coord-'));
  try {
    const clock = fakeClock();
    const provider = await createSqliteCoordinationProvider({
      location: path.join(dir, 'coord.db'),
      now: clock.now,
    });
    const r = coordinationResourceId('effect', 'e1');

    const a = await provider.acquire(r, 'A', 10_000);
    assert.ok(a.ok && a.lease);
    assert.equal(a.lease.generation, 1);

    const blocked = await provider.acquire(r, 'B', 10_000);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.heldBy?.ownerId, 'A');

    clock.advance(10_001);
    assert.equal(await provider.inspect(r), null);
    const b = await provider.acquire(r, 'B', 10_000);
    assert.ok(b.ok && b.lease);
    assert.equal(b.lease.generation, 2, 'reclaim over an expired lease bumps generation');

    // A is now fenced.
    const check = await provider.checkOwnership(r, 'A', 1);
    assert.equal(check.current, false);
    assert.equal(check.reason, 'fenced');

    await provider.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite provider: renew / release owner-specificity matches the memory reference', async () => {
  const clock = fakeClock();
  await bothProviders(clock, async (provider, label) => {
    const r = coordinationResourceId('subscription', label);
    const a = await provider.acquire(r, 'A', 10_000);
    assert.ok(a.ok && a.lease, `${label}: acquired`);

    assert.equal(await provider.renew(r, 'wrong', 10_000), false, `${label}: renew rejects a foreign token`);
    assert.equal(await provider.renew(r, a.lease.token, 10_000), true, `${label}: owner renews`);

    await provider.release(r, 'wrong'); // no-op
    assert.notEqual(await provider.inspect(r), null, `${label}: foreign release is a no-op`);
    await provider.release(r, a.lease.token);
    assert.equal(await provider.inspect(r), null, `${label}: owner release frees the claim`);

    const b = await provider.acquire(r, 'B', 10_000);
    assert.ok(b.ok && b.lease);
    assert.equal(b.lease.generation, 2, `${label}: generation never rewinds across release`);
  });
});

test('SQLite provider: list is prefix-scoped, excludes released claims, reports liveness', { skip: !available }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-coord-'));
  try {
    const clock = fakeClock();
    const provider = await createSqliteCoordinationProvider({
      location: path.join(dir, 'coord.db'),
      now: clock.now,
    });
    const held = await provider.acquire(coordinationResourceId('effect', 'kept'), 'A', 10_000);
    const released = await provider.acquire(coordinationResourceId('effect', 'gone'), 'B', 10_000);
    await provider.acquire(coordinationResourceId('schedule', 's1'), 'A', 10_000);
    assert.ok(released.ok && released.lease);
    await provider.release(coordinationResourceId('effect', 'gone'), released.lease.token);

    const effects = await provider.list('effect:');
    assert.deepEqual(effects.map((v) => v.resourceId), ['effect:kept'], 'released claim is not listed');
    assert.ok(effects[0]?.live);
    assert.ok(held.ok);

    clock.advance(10_001);
    assert.ok((await provider.list('effect:')).every((v) => !v.live), 'expired-but-unreleased still lists, not live');

    await provider.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
