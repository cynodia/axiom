import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSqliteCoordinationProvider,
  createSqliteCursorPositionStore,
  createSubscriptionCursorStore,
  isSqliteSubscriptionCursorAvailable,
} from '@cynodia/axiom-server';

/**
 * Spec12 §75, §83 (release-blocking): subscription cursor fencing proved with **real OS
 * processes** on shared SQLite files.
 *
 * A owns delivery generation g. A stalls. B takes generation g+1 and advances the cursor. A
 * resumes and tries to write its old cursor state → the write MUST be rejected, and B's
 * cursor MUST stand.
 */

const available = await isSqliteSubscriptionCursorAvailable();
const WORKER = fileURLToPath(new URL('./helpers/subscription-cursor-race-worker.js', import.meta.url));

test(
  'spec12 §75: a stalled cursor owner in another process cannot overwrite a newer owner (fenced)',
  { skip: !available },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-subcursor-race-'));
    const coordDb = path.join(dir, 'coord.db');
    const cursorDb = path.join(dir, 'cursor.db');
    let holder: ChildProcess | undefined;
    try {
      // Materialize both schemas before the workers open their own connections.
      const seedC = await createSqliteCoordinationProvider({ location: coordDb });
      const seedP = await createSqliteCursorPositionStore({ location: cursorDb });
      await seedC.close?.();
      await seedP.close?.();

      const acquired = await new Promise<{ ok: boolean; generation?: number }>((resolve, reject) => {
        holder = fork(WORKER, [coordDb, cursorDb, 'hold', 'A', '600'], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        holder.on('error', reject);
        holder.on('message', (m: { type?: string; ok?: boolean; generation?: number }) => {
          if (m?.type === 'acquired') resolve({ ok: Boolean(m.ok), generation: m.generation });
        });
      });
      assert.ok(acquired.ok, 'A (process 1) acquired the subscription cursor');
      assert.equal(acquired.generation, 1);

      // A stalls (never renews). Let its 600ms lease lapse, then B (process 2) takes over.
      await new Promise((r) => setTimeout(r, 900));
      const takeOut = await new Promise<string>((resolve, reject) => {
        const b = fork(WORKER, [coordDb, cursorDb, 'take', 'B', '30000'], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let out = '';
        b.stdout?.on('data', (c) => (out += String(c)));
        b.on('error', reject);
        b.on('exit', () => resolve(out.trim()));
      });
      const take = JSON.parse(takeOut) as { generation: number; resumeFrom: number };
      assert.equal(take.generation, 2, 'B took generation 2');
      assert.equal(take.resumeFrom, 10, 'B resumed from the durable cursor A left at 10');

      // Wake A and have it try to advance its stale generation-1 claim.
      const advanced = await new Promise<{ ok: boolean; reason: string | null }>((resolve, reject) => {
        holder?.on('message', (m: { type?: string; ok?: boolean; reason?: string | null }) => {
          if (m?.type === 'advanced') resolve({ ok: Boolean(m.ok), reason: m.reason ?? null });
        });
        holder?.on('error', reject);
        holder?.send({ type: 'advance', to: 999 });
      });
      assert.equal(advanced.ok, false, 'the stalled owner cannot advance');
      assert.equal(advanced.reason, 'fenced', 'the reason is fencing, not sequence');

      // B's cursor stands.
      const positions = await createSqliteCursorPositionStore({ location: cursorDb });
      const cursor = await positions.read('sub');
      await positions.close?.();
      assert.equal(cursor?.sequence, 25, "B's cursor was not overwritten");
      assert.equal(cursor?.writerGeneration, 2);
    } finally {
      holder?.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
