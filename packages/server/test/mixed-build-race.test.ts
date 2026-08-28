import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
  isSqliteDurableWorkAvailable,
} from '@cynodia/axiom-server';

/**
 * spec12 §78, §83: the mixed-build test with **real OS processes** on one shared work store.
 *
 * Build X enqueues durable work stamped with its compatibility key. Build Y (same schema,
 * different semantic fingerprint) polls: it claims nothing and reports the item as stranded
 * for it. Build X polls: it runs the work. Never silent mixed execution.
 */

const available = await isSqliteDurableWorkAvailable();
const WORKER = fileURLToPath(new URL('./helpers/mixed-build-worker.js', import.meta.url));
const KEY_X = 'buildX|schema4|axiom.server.v7|sem-1111';
const KEY_Y = 'buildY|schema4|axiom.server.v7|sem-2222';

function run(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => (out += String(c)));
    child.stderr?.on('data', (c) => (err += String(c)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (err.includes('ERR_SQLITE_ERROR')) reject(new Error(`worker crashed: ${err.slice(0, 300)}`));
      else if (!out.trim()) reject(new Error(`worker exited ${code} with no output`));
      else resolve(JSON.parse(out.trim()));
    });
  });
}

test(
  'spec12 §78: a different-semantic-fingerprint build cannot claim another build\'s durable work',
  { skip: !available },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-mixed-build-'));
    const coordDb = path.join(dir, 'coord.db');
    const workDb = path.join(dir, 'work.db');
    try {
      const seedC = await createSqliteCoordinationProvider({ location: coordDb });
      const seedW = await createSqliteDurableWorkStorage({ location: workDb });
      await seedC.close?.();
      await seedW.close?.();

      const seeded = await run([coordDb, workDb, 'seed', KEY_X, 'seeder']);
      assert.equal(seeded.stampedKey, KEY_X, 'work is stamped with build X\'s key');

      const y = await run([coordDb, workDb, 'try-claim', KEY_Y, 'Y']);
      assert.deepEqual(y.claimed, [], 'build Y claims nothing');
      assert.deepEqual(y.incompatible, ['mb1'], 'build Y sees the work stranded for it');

      const x = await run([coordDb, workDb, 'try-claim', KEY_X, 'X']);
      assert.deepEqual(x.claimed, ['mb1'], 'the matching build X claims and runs it');
      assert.deepEqual(x.incompatible, [], 'nothing is incompatible for build X');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
