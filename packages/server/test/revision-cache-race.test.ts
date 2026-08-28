import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createRevisionObservingCache,
  createSqlitePersistence,
  isSqliteDataProviderAvailable,
} from '@cynodia/axiom-server';
import { nodeId } from '@cynodia/axiom-core';

/**
 * Spec12 §34, §76, §83: cross-instance read-after-write proved with a **real OS process**
 * committing through its own connection to the shared state database.
 *
 * Authority A caches a query result at revision R. A separate process (authority B) commits
 * a mutation. A re-observes the durable revision and its cached entry — computed at R — is
 * no longer served. No stale-read mode is created by topology; the staleness bound is 0.
 */

const available = await isSqliteDataProviderAvailable();
const WORKER = fileURLToPath(new URL('./helpers/revision-commit-worker.js', import.meta.url));

test(
  'spec12 §76: a cache over shared persistence detects another process\'s commit via the durable revision',
  { skip: !available },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-revcache-race-'));
    const stateDb = path.join(dir, 'state.db');
    try {
      const authorityA = await createSqlitePersistence({ location: stateDb });
      await authorityA.commit({
        writes: [{ stateId: nodeId('state_orders'), value: [] }],
        expected: { [nodeId('state_orders')]: 0 },
      });

      const cache = createRevisionObservingCache<string>();
      const rBefore = await authorityA.revision();
      cache.set('ownOrders', 'A-computed-result', rBefore);
      assert.equal(cache.get('ownOrders', await authorityA.revision()), 'A-computed-result', 'fresh before B commits');

      const out = await new Promise<string>((resolve, reject) => {
        const child = fork(WORKER, [stateDb], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let s = '';
        child.stdout?.on('data', (c) => (s += String(c)));
        child.on('error', reject);
        child.on('exit', () => resolve(s.trim()));
      });
      const result = JSON.parse(out) as { committed?: boolean; revision?: number; thrown?: boolean };
      assert.equal(result.thrown ?? false, false, 'the committing process did not throw');
      assert.equal(result.committed, true, 'authority B committed through its own connection');
      assert.ok((result.revision ?? 0) > rBefore, 'the durable revision advanced');

      const rAfter = await authorityA.revision();
      assert.equal(rAfter, result.revision, "A observes B's revision");
      assert.equal(cache.get('ownOrders', rAfter), undefined, 'A no longer serves the pre-commit result');
      assert.equal(cache.stats().staleEvictions, 1);

      await authorityA.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
