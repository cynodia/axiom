import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSqliteExternalEventDedupStore,
  isSqliteExternalEventDedupAvailable,
} from '@cynodia/axiom-server';

/**
 * Spec12 §73, §83: external-event deduplication proved with **real OS processes** racing on
 * one shared SQLite file.
 *
 * - N processes concurrently `admit` the same `(source, externalEventId, payload)` → exactly
 *   one `accepted`, every other `duplicate`. One semantic event.
 * - The same id later with a different payload → `conflict` (`EVENT_ID_CONFLICT`), never a
 *   silent second acceptance.
 */

const available = await isSqliteExternalEventDedupAvailable();
const WORKER = fileURLToPath(new URL('./helpers/external-event-dedup-race-worker.js', import.meta.url));
const AUTHORITIES = Math.max(2, Number(process.env.AXIOM_AUTHORITIES ?? 6));
const TRIALS = Math.max(1, Number(process.env.AXIOM_RACE_TRIALS ?? 8));

function admit(dedupDb: string, payload: unknown, barrierAt: number): Promise<{ status: string; code?: string; thrown?: boolean; errorCode?: string }> {
  return new Promise((resolve, reject) => {
    const child = fork(
      WORKER,
      [dedupDb, 'stripe', 'evt_race', JSON.stringify(payload), String(barrierAt)],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let out = '';
    child.stdout?.on('data', (c) => (out += String(c)));
    child.on('error', reject);
    child.on('exit', (code) => {
      const trimmed = out.trim();
      if (!trimmed) {
        reject(new Error(`worker exited ${code} with no output`));
        return;
      }
      resolve(JSON.parse(trimmed));
    });
  });
}

test(
  `spec12 §73: ${AUTHORITIES} OS processes ingest one identical delivery — exactly one semantic event`,
  { skip: !available },
  async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const dir = mkdtempSync(path.join(tmpdir(), 'axiom-dedup-race-'));
      const dedupDb = path.join(dir, 'dedup.db');
      try {
        // Materialize the schema before the racers open their own connections.
        const seed = await createSqliteExternalEventDedupStore({ location: dedupDb });
        await seed.close?.();

        const barrierAt = Date.now() + 60;
        const lines = await Promise.all(
          Array.from({ length: AUTHORITIES }, () => admit(dedupDb, { amount: 100 }, barrierAt)),
        );
        const label = `trial ${trial}: ${JSON.stringify(lines)}`;

        for (const line of lines) assert.notEqual(line.thrown ?? false, true, `${label} — a worker threw`);
        assert.equal(
          lines.filter((l) => l.status === 'accepted').length,
          1,
          `${label} — exactly one authority accepted the event`,
        );
        assert.ok(
          lines.filter((l) => l.status !== 'accepted').every((l) => l.status === 'duplicate'),
          `${label} — every other authority saw a duplicate, not a second event`,
        );

        // A later delivery reusing the id with a different payload is a conflict.
        const conflict = await admit(dedupDb, { amount: 999 }, Date.now());
        assert.equal(conflict.status, 'conflict', `${label} — divergent payload is a conflict`);
        assert.equal(conflict.code, 'EVENT_ID_CONFLICT', `${label}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
