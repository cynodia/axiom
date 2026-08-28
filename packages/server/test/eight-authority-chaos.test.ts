import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createDurableWorkStore,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
  isSqliteDurableWorkAvailable,
} from '@cynodia/axiom-server';

/**
 * spec12 §81, §83: **eight** concurrent authority processes racing effects, scheduled work
 * and generic durable claims on one shared SQLite store. The semantic result — every item
 * completed exactly once — must be independent of which authority won what.
 */

const available = await isSqliteDurableWorkAvailable();
const WORKER = fileURLToPath(new URL('./helpers/eight-authority-worker.js', import.meta.url));
const AUTHORITIES = Math.max(8, Number(process.env.AXIOM_AUTHORITIES ?? 8));
const PER_CLASS = Math.max(30, Number(process.env.AXIOM_CHAOS_ITEMS ?? 120));

interface WorkerLine {
  ownerId: string;
  settled: Record<string, number>;
  thrown?: boolean;
  errorCode?: string;
}

test(
  `${AUTHORITIES} authority processes race effects + schedule firings + generic work — each item completes exactly once`,
  { skip: !available },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-8auth-'));
    const coordDb = path.join(dir, 'coord.db');
    const workDb = path.join(dir, 'work.db');
    try {
      // Seed PER_CLASS items in each of the three work classes.
      const seedCoord = await createSqliteCoordinationProvider({ location: coordDb });
      const seedWork = await createSqliteDurableWorkStorage({ location: workDb });
      const seedStore = createDurableWorkStore({ coordination: seedCoord, storage: seedWork });
      for (const workClass of ['effect', 'schedule-firing', 'generic']) {
        for (let i = 0; i < PER_CLASS; i += 1) {
          await seedStore.enqueue({ workClass, workId: `${workClass}-${i}`, payload: { i } });
        }
      }
      await seedCoord.close?.();
      await seedWork.close?.();

      const lines: WorkerLine[] = await Promise.all(
        Array.from({ length: AUTHORITIES }, (_, i) =>
          new Promise<WorkerLine>((resolve, reject) => {
            const child = fork(WORKER, [coordDb, workDb, `auth-${i}`], {
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            let out = '';
            let err = '';
            child.stdout?.on('data', (c) => (out += String(c)));
            child.stderr?.on('data', (c) => (err += String(c)));
            child.on('error', reject);
            child.on('exit', (code) => {
              if (err.includes('ERR_SQLITE_ERROR')) reject(new Error(`worker crashed: ${err.slice(0, 300)}`));
              else if (!out.trim()) reject(new Error(`auth-${i} exited ${code} with no output`));
              else resolve(JSON.parse(out.trim()) as WorkerLine);
            });
          }),
        ),
      );
      const label = JSON.stringify(lines);

      for (const line of lines) assert.notEqual(line.thrown ?? false, true, `${label} — a worker threw`);

      // Every item completed exactly once, summed across all winners.
      for (const workClass of ['effect', 'schedule-firing', 'generic']) {
        const total = lines.reduce((n, l) => n + (l.settled[workClass] ?? 0), 0);
        assert.equal(total, PER_CLASS, `${label} — ${workClass}: ${total} settlements != ${PER_CLASS}`);
      }

      // Ground truth: the durable store. Every seeded item is 'succeeded', none left behind.
      const coord = await createSqliteCoordinationProvider({ location: coordDb });
      const work = await createSqliteDurableWorkStorage({ location: workDb });
      const store = createDurableWorkStore({ coordination: coord, storage: work });
      for (const workClass of ['effect', 'schedule-firing', 'generic']) {
        const rows = await store.list(workClass, PER_CLASS + 10);
        assert.equal(rows.length, PER_CLASS, `${label} — ${workClass}: row count`);
        assert.ok(
          rows.every((r) => r.state === 'succeeded' && r.attemptNumber === 1),
          `${label} — ${workClass}: every item succeeded on its first (and only) attempt`,
        );
      }
      await coord.close?.();
      await work.close?.();

      // The result is independent of winner distribution: at least a few authorities did work.
      const contributors = lines.filter((l) => Object.values(l.settled).some((n) => n > 0)).length;
      assert.ok(contributors >= 2, `${label} — work was genuinely shared (${contributors} contributors)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
