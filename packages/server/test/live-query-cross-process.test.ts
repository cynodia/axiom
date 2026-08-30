import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSqliteDataProvider,
  isSqliteAvailable,
} from '@cynodia/axiom-server';
import type { LiveQueryMessage } from '@cynodia/axiom-server';
import {
  E_ORDER,
  F_ID,
  F_STATUS,
  F_TOTAL,
  LIVE_ORDERS_IR,
} from './helpers/live-orders-graph.js';

/**
 * spec13 §159, §187, §189 Q5/Q6/Q26 — topology transparency with **real OS processes**: a
 * live query served from authority B observes a commit made on authority A, through the
 * shared durable revision alone. No broadcast, no sticky routing, no Redis.
 */

const available = await isSqliteAvailable();
const WORKER = fileURLToPath(new URL('./helpers/live-query-authority-worker.js', import.meta.url));

interface Authority {
  child: ChildProcess;
  send(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): void;
}

function spawnAuthority(stateDb: string, dataDb: string, id: string): Promise<Authority> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [stateDb, dataDb, id], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    const pending: Array<(m: Record<string, unknown>) => void> = [];
    child.on('message', (m: Record<string, unknown>) => {
      if (m?.type === 'ready') {
        resolve({
          child,
          send: (msg) =>
            new Promise((res) => {
              pending.push(res);
              child.send(msg);
            }),
          stop: () => child.send({ type: 'stop' }),
        });
        return;
      }
      const next = pending.shift();
      if (next) next(m);
    });
    child.on('exit', (code, signal) => {
      if (/SQLITE|ERR_SQLITE_ERROR|database is locked/.test(stderr)) {
        reject(new Error(`authority ${id} leaked a raw SQLite error (code=${code} signal=${signal}): ${stderr.slice(0, 400)}`));
      }
    });
  });
}

const ids = (rows: unknown[]): string[] =>
  rows.map((r) => String((r as Record<string, unknown>)[F_ID as unknown as string]));

async function seed(dataDb: string): Promise<void> {
  const provider = await createSqliteDataProvider({
    location: dataDb,
    entities: LIVE_ORDERS_IR.entities ?? [],
    seed: {
      [E_ORDER]: [
        { [F_ID]: 'a', [F_STATUS]: 'open', [F_TOTAL]: 30 },
        { [F_ID]: 'b', [F_STATUS]: 'closed', [F_TOTAL]: 10 },
        { [F_ID]: 'c', [F_STATUS]: 'open', [F_TOTAL]: 20 },
      ] as never,
    },
    maxPageSize: 100,
  });
  // Nothing to close on the provider contract; the handle is released when this scope ends
  // and the WAL file is picked up by the worker processes.
  void provider;
}

async function drainUntil(
  authority: Authority,
  predicate: (messages: LiveQueryMessage[]) => boolean,
  timeoutMs = 4000,
): Promise<LiveQueryMessage[]> {
  const deadline = Date.now() + timeoutMs;
  let messages: LiveQueryMessage[] = [];
  while (Date.now() < deadline) {
    messages = ((await authority.send({ type: 'drain' })).messages as LiveQueryMessage[]) ?? [];
    if (predicate(messages)) return messages;
    await new Promise((r) => setTimeout(r, 50));
  }
  return messages;
}

test(
  'a live query on authority B sees a provider-record commit made on authority A (spec13 §159)',
  { skip: !available },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-live-xp-'));
    const stateDb = path.join(dir, 'state.db');
    const dataDb = path.join(dir, 'data.db');
    let a: Authority | undefined;
    let b: Authority | undefined;
    try {
      await seed(dataDb);
      a = await spawnAuthority(stateDb, dataDb, 'A');
      b = await spawnAuthority(stateDb, dataDb, 'B');

      // B opens the live query and gets its initial coherent result.
      assert.equal((await b.send({ type: 'openLive' })).type, 'opened');
      let messages = await drainUntil(b, (m) => m.length >= 1 && m[0].kind === 'initial');
      assert.equal(messages[0].kind, 'initial');
      assert.deepEqual(ids((messages[0] as { rows: unknown[] }).rows), ['c', 'a'], 'open orders, total asc');

      // A flips `b` to open. B must observe it via the shared revision, with no message from A.
      assert.equal((await a.send({ type: 'invokeStatus', id: 'b', status: 'open' })).ok, true);
      messages = await drainUntil(b, (m) => m.length >= 2);
      const afterInsert = messages.slice(1);
      assert.ok(
        afterInsert.some(
          (m) =>
            (m.kind === 'update' && m.delta.changes.some((c) => 'key' in c && c.key === 'b')) ||
            (m.kind === 'reset' && ids(m.rows).includes('b')),
        ),
        `B never saw b enter its live result: ${JSON.stringify(afterInsert)}`,
      );

      // A raises c's total so it sorts last; B observes the reorder.
      assert.equal((await a.send({ type: 'invokeTotal', id: 'c', total: 999 })).ok, true);
      messages = await drainUntil(b, (m) => m.length >= 3);
      // Fold every delta/reset B received and compare identity set to a fresh authoritative read.
      const folded = foldMessages(messages);
      assert.deepEqual(folded.sort(), ['a', 'b', 'c'].sort(), 'B converged on the authoritative open set');
    } finally {
      a?.stop();
      b?.stop();
      await new Promise((r) => setTimeout(r, 250));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

function foldMessages(messages: LiveQueryMessage[]): string[] {
  let rows: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.kind === 'initial' || message.kind === 'reset') {
      rows = [...(message.rows as Array<Record<string, unknown>>)];
    } else if (message.kind === 'update') {
      for (const change of message.delta.changes) {
        if (change.kind === 'reset') rows = [...(change.rows as Array<Record<string, unknown>>)];
        else if (change.kind === 'remove') rows = rows.filter((r) => String(r[F_ID as unknown as string]) !== change.key);
        else if (change.kind === 'insert') rows.push(change.value as Record<string, unknown>);
        else if (change.kind === 'update') {
          rows = rows.map((r) =>
            String(r[F_ID as unknown as string]) === change.key ? (change.value as Record<string, unknown>) : r,
          );
        }
      }
    }
  }
  return rows.map((r) => String(r[F_ID as unknown as string]));
}
