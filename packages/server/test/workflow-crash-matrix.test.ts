import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isSqliteAvailable } from '@cynodia/axiom-server';
import { WF_ACTION, WF_EVENT } from './helpers/workflow-crash-graph.js';

/**
 * spec14pt2 F1 / F2 / §3 — the real-OS-process durable-workflow crash matrix.
 *
 * Independent processes, independent SQLite connections, one set of database files. An
 * authority is SIGKILL'd at the narrowest crash boundary and a *fresh* authority — with no
 * process-local state whatsoever — recovers the workflow. The invariants:
 *
 *   logical ActionDef invocations        1   (S_COUNT === 1)
 *   workflow logical step transitions    1   (one `step-succeeded`, one `event-matched`)
 *   duplicate logical effects            0
 *   stale successful commits             0
 */

const available = await isSqliteAvailable();
const WORKER = fileURLToPath(new URL('./helpers/workflow-crash-worker.js', import.meta.url));
const TRIALS = Math.max(1, Number(process.env.AXIOM_WF_TRIALS ?? 50));

const REPLY: Record<string, string> = {
  start: 'started',
  list: 'list',
  get: 'workflow',
  history: 'history',
  count: 'count',
  event: 'event-ack',
  cancel: 'cancelled',
  holdAndStaleTransition: 'held',
};

interface Authority {
  child: ChildProcess;
  label: string;
  send(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  fire(msg: Record<string, unknown>): void;
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): void;
}

function spawnAuthority(
  stateDb: string,
  wfDb: string,
  coordDb: string,
  label: string,
  crashMode = '',
): Promise<Authority> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [stateDb, wfDb, coordDb, label, crashMode], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (c) => (stderr += String(c)));
    const inbox: Record<string, unknown>[] = [];
    // A waiter with `type: undefined` matches the next message of any type.
    const waiters: Array<{ type?: string; resolve: (m: Record<string, unknown>) => void }> = [];
    const pump = (): void => {
      for (let i = 0; i < inbox.length; ) {
        const m = inbox[i];
        const w = waiters.findIndex((x) => x.type === undefined || x.type === m.type);
        if (w === -1) {
          i += 1;
          continue;
        }
        waiters.splice(w, 1)[0].resolve(m);
        inbox.splice(i, 1);
      }
    };
    child.on('message', (m: Record<string, unknown>) => {
      if (m?.type === 'ready') {
        resolve(authority);
        return;
      }
      inbox.push(m);
      pump();
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (/SQLITE|ERR_SQLITE_ERROR|database is locked/i.test(stderr)) {
        reject(new Error(`authority ${label} leaked raw SQLite (${code}/${signal}): ${stderr.slice(0, 300)}`));
      }
    });
    const next = (type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`${label}: timed out waiting for ${type}`)), timeoutMs);
        waiters.push({
          ...(type === '*' ? {} : { type }),
          resolve: (m) => {
            clearTimeout(t);
            res(m);
          },
        });
        pump();
      });
    const authority: Authority = {
      child,
      label,
      fire: (msg) => {
        try {
          child.send(msg);
        } catch {
          /* process already gone */
        }
      },
      send: (msg) => {
        child.send(msg);
        return next(REPLY[String(msg.type)] ?? '*');
      },
      next,
      waitExit: (timeoutMs = 10_000) =>
        new Promise((res, rej) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            res({ code: child.exitCode, signal: child.signalCode });
            return;
          }
          const t = setTimeout(() => rej(new Error(`${label}: did not exit`)), timeoutMs);
          child.on('exit', (code, signal) => {
            clearTimeout(t);
            res({ code, signal });
          });
        }),
      stop: () => {
        try {
          child.send({ type: 'stop' });
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 500).unref();
      },
    };
  });
}

function tempDbs(prefix: string): { dir: string; stateDb: string; wfDb: string; coordDb: string } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    stateDb: path.join(dir, 'state.db'),
    wfDb: path.join(dir, 'wf.db'),
    coordDb: path.join(dir, 'coord.db'),
  };
}

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 12_000, step = 150): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await fn();
  while (Date.now() < deadline) {
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, step));
    last = await fn();
  }
  return last;
}

const count = (arr: string[], v: string): number => arr.filter((x) => x === v).length;

// --------------------------------------------------------------------------- F1

test(
  `spec14pt2 F1: SIGKILL after the ActionDef commit, before the workflow transition — ${TRIALS} trials, exactly once`,
  { skip: !available },
  async () => {
    let doubles = 0;
    let recovered = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const { dir, stateDb, wfDb, coordDb } = tempDbs('axiom-wf-f1-');
      let a: Authority | undefined;
      let b: Authority | undefined;
      try {
        a = await spawnAuthority(stateDb, wfDb, coordDb, `A${trial}`, 'f1');
        a.fire({ type: 'start', workflowId: String(WF_ACTION), key: `k${trial}` });
        const exit = await a.waitExit(10_000);
        assert.equal(exit.signal, 'SIGKILL', `trial ${trial}: A must die by SIGKILL, got ${JSON.stringify(exit)}`);

        // A fresh authority — no in-memory request cache, no engine state — recovers it.
        b = await spawnAuthority(stateDb, wfDb, coordDb, `B${trial}`, '');
        const list = (await b.send({ type: 'list' })).items as Array<{ instanceId: string }>;
        assert.equal(list.length, 1, `trial ${trial}: exactly one instance`);
        const id = list[0].instanceId;

        const done = await poll(
          () => b!.send({ type: 'get', instanceId: id }),
          (m) => (m.value as { status?: string } | null)?.status === 'completed',
        );
        assert.equal((done.value as { status: string }).status, 'completed', `trial ${trial}: workflow completed`);
        recovered += 1;

        const c = (await b.send({ type: 'count' })).value as number;
        if (c !== 1) doubles += 1;
        assert.equal(c, 1, `trial ${trial}: the ActionDef committed exactly once (S_COUNT)`);

        const history = (await b.send({ type: 'history', instanceId: id })).value as string[];
        assert.equal(count(history, 'started'), 1, `trial ${trial}: one 'started'`);
        assert.equal(count(history, 'step-succeeded'), 1, `trial ${trial}: one 'step-succeeded'`);
        assert.equal(count(history, 'completed'), 1, `trial ${trial}: one 'completed'`);
      } finally {
        a?.stop();
        b?.stop();
        await new Promise((r) => setTimeout(r, 120));
        rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(doubles, 0, 'no trial executed the ActionDef twice');
    assert.equal(recovered, TRIALS, 'every trial recovered to completion');
  },
);

// --------------------------------------------------------------------------- F2 Case A

test(
  `spec14pt2 F2 Case A: SIGKILL the event-routing authority before the workflow transition — ${TRIALS} trials`,
  { skip: !available },
  async () => {
    let doubles = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const { dir, stateDb, wfDb, coordDb } = tempDbs('axiom-wf-f2a-');
      let a: Authority | undefined;
      let b: Authority | undefined;
      try {
        a = await spawnAuthority(stateDb, wfDb, coordDb, `A${trial}`, 'f2');
        const started = (await a.send({ type: 'start', workflowId: String(WF_EVENT), key: `k${trial}` }))
          .result as { instanceId: string; status: string };
        assert.ok(started.instanceId, `trial ${trial}: started`);
        const id = started.instanceId;
        await poll(
          () => a!.send({ type: 'get', instanceId: id }),
          (m) => (m.value as { status?: string } | null)?.status === 'waiting',
          6000,
        );

        // The matching event: A journals it durably, then SIGKILLs on the `event-matched`
        // transition — the workflow is still `waiting`, the event lives only in the shared
        // durable journal.
        a.fire({ type: 'event', key: `k${trial}` });
        const exit = await a.waitExit(10_000);
        assert.equal(exit.signal, 'SIGKILL', `trial ${trial}: A died by SIGKILL`);

        b = await spawnAuthority(stateDb, wfDb, coordDb, `B${trial}`, '');
        const done = await poll(
          () => b!.send({ type: 'get', instanceId: id }),
          (m) => (m.value as { status?: string } | null)?.status === 'completed',
        );
        assert.equal(
          (done.value as { status: string }).status,
          'completed',
          `trial ${trial}: recovered from the shared journal, no client resend`,
        );

        const c = (await b.send({ type: 'count' })).value as number;
        if (c !== 1) doubles += 1;
        assert.equal(c, 1, `trial ${trial}: the follow-on ActionDef ran exactly once`);
        const history = (await b.send({ type: 'history', instanceId: id })).value as string[];
        assert.equal(count(history, 'event-matched'), 1, `trial ${trial}: exactly one 'event-matched'`);
        assert.equal(count(history, 'completed'), 1, `trial ${trial}: one 'completed'`);
      } finally {
        a?.stop();
        b?.stop();
        await new Promise((r) => setTimeout(r, 120));
        rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(doubles, 0, 'F2 Case A: no double transition across the matrix');
  },
);

// --------------------------------------------------------------------------- F2 Case B

test(
  `spec14pt2 F2 Case B: race wait-activation vs matching-event commit — ${TRIALS} trials, deterministic classification`,
  { skip: !available },
  async () => {
    let before = 0;
    let after = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const { dir, stateDb, wfDb, coordDb } = tempDbs('axiom-wf-f2b-');
      let a: Authority | undefined;
      try {
        a = await spawnAuthority(stateDb, wfDb, coordDb, `A${trial}`, '');
        // Fire the start and the matching event with no ordering guarantee between them.
        const startP = a.send({ type: 'start', workflowId: String(WF_EVENT), key: `k${trial}` });
        const evP = a.send({ type: 'event', key: `k${trial}` });
        const [startMsg] = await Promise.all([startP, evP]);
        const id = (startMsg.result as { instanceId: string }).instanceId;

        const settled = await poll(
          () => a!.send({ type: 'get', instanceId: id }),
          (m) => {
            const s = (m.value as { status?: string } | null)?.status;
            return s === 'completed' || s === 'waiting';
          },
          8000,
        );
        const status = (settled.value as { status: string }).status;
        const history1 = (await a.send({ type: 'history', instanceId: id })).value as string[];

        if (status === 'completed') {
          after += 1;
          assert.equal((await a.send({ type: 'count' })).value, 1, `trial ${trial}: after-activation ran once`);
          assert.equal(count(history1, 'event-matched'), 1, `trial ${trial}: one 'event-matched'`);
        } else {
          before += 1;
          // The event committed strictly before the wait was live: correctly NOT matched.
          assert.equal((await a.send({ type: 'count' })).value, 0, `trial ${trial}: before-activation matched nothing`);
          assert.equal(count(history1, 'event-matched'), 0, `trial ${trial}: no 'event-matched' yet`);
          // The machinery is intact: a *subsequent* event still matches, exactly once.
          await a.send({ type: 'event', key: `k${trial}` });
          const done = await poll(
            () => a!.send({ type: 'get', instanceId: id }),
            (m) => (m.value as { status?: string } | null)?.status === 'completed',
          );
          assert.equal((done.value as { status: string }).status, 'completed', `trial ${trial}: 2nd event completed it`);
          assert.equal((await a.send({ type: 'count' })).value, 1, `trial ${trial}: exactly one execution`);
          const history2 = (await a.send({ type: 'history', instanceId: id })).value as string[];
          assert.equal(count(history2, 'event-matched'), 1, `trial ${trial}: still exactly one 'event-matched'`);
        }
      } finally {
        a?.stop();
        await new Promise((r) => setTimeout(r, 100));
        rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(before + after, TRIALS, 'every trial classified deterministically, no event lost in a handoff gap');
  },
);

// --------------------------------------------------------------------------- F2 Case C

test(
  'spec14pt2 F2 Case C: replaying the same logical event (live + across restart) yields one transition',
  { skip: !available },
  async () => {
    const { dir, stateDb, wfDb, coordDb } = tempDbs('axiom-wf-f2c-');
    let a: Authority | undefined;
    let a2: Authority | undefined;
    try {
      a = await spawnAuthority(stateDb, wfDb, coordDb, 'A', '');
      const started = (await a.send({ type: 'start', workflowId: String(WF_EVENT), key: 'k' })).result as {
        instanceId: string;
      };
      const id = started.instanceId;
      await poll(
        () => a!.send({ type: 'get', instanceId: id }),
        (m) => (m.value as { status?: string } | null)?.status === 'waiting',
        6000,
      );

      for (let i = 0; i < 5; i += 1) await a.send({ type: 'event', key: 'k' });
      const done = await poll(
        () => a!.send({ type: 'get', instanceId: id }),
        (m) => (m.value as { status?: string } | null)?.status === 'completed',
      );
      assert.equal((done.value as { status: string }).status, 'completed');
      assert.equal((await a.send({ type: 'count' })).value, 1, 'one execution despite five deliveries');

      // Restart: the startup journal replay must not re-transition a terminal instance.
      a.stop();
      await new Promise((r) => setTimeout(r, 300));
      a2 = await spawnAuthority(stateDb, wfDb, coordDb, 'A2', '');
      await new Promise((r) => setTimeout(r, 1200)); // let the poll loop + journal replay run
      const history = (await a2.send({ type: 'history', instanceId: id })).value as string[];
      assert.equal(count(history, 'event-matched'), 1, 'still exactly one logical event-matched after restart replay');
      assert.equal((await a2.send({ type: 'count' })).value, 1, 'still one execution after restart replay');
    } finally {
      a?.stop();
      a2?.stop();
      await new Promise((r) => setTimeout(r, 150));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// --------------------------------------------------------------------------- §3 claim races

for (const N of [2, 8]) {
  test(
    `spec14pt2 §3: ${N} authorities claim the same runnable workflow — exactly one logical transition`,
    { skip: !available },
    async () => {
      const { dir, stateDb, wfDb, coordDb } = tempDbs(`axiom-wf-claim${N}-`);
      const authorities: Authority[] = [];
      try {
        for (let i = 0; i < N; i += 1) {
          authorities.push(await spawnAuthority(stateDb, wfDb, coordDb, `a${i}`, ''));
        }
        // Every authority races to start the *same* instance (idempotent) and its poll loop
        // then contends to advance it.
        const results = await Promise.all(
          authorities.map((w) =>
            w.send({ type: 'start', workflowId: String(WF_ACTION), key: 'shared', idempotencyKey: 'race' }),
          ),
        );
        const ids = new Set(
          results.map((r) => (r.result as { instanceId?: string }).instanceId).filter(Boolean) as string[],
        );
        assert.equal(ids.size, 1, `all ${N} starts resolved to one instance`);
        const id = [...ids][0];

        const done = await poll(
          () => authorities[0].send({ type: 'get', instanceId: id }),
          (m) => (m.value as { status?: string } | null)?.status === 'completed',
        );
        assert.equal((done.value as { status: string }).status, 'completed');
        assert.equal((await authorities[0].send({ type: 'count' })).value, 1, `${N} authorities → one ActionDef commit`);
        const history = (await authorities[0].send({ type: 'history', instanceId: id })).value as string[];
        assert.equal(count(history, 'step-succeeded'), 1, `${N} authorities → one 'step-succeeded'`);
        assert.equal(count(history, 'completed'), 1, `${N} authorities → one 'completed'`);
      } finally {
        for (const w of authorities) w.stop();
        await new Promise((r) => setTimeout(r, 200));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

// --------------------------------------------------------------------------- §3 stale owner

test(
  'spec14pt2 §3: SIGSTOP the lease owner, another authority advances, the resumed stale write is refused',
  { skip: !available },
  async () => {
    const { dir, stateDb, wfDb, coordDb } = tempDbs('axiom-wf-stale-');
    let a: Authority | undefined;
    let b: Authority | undefined;
    try {
      a = await spawnAuthority(stateDb, wfDb, coordDb, 'A', '');
      b = await spawnAuthority(stateDb, wfDb, coordDb, 'B', '');
      const started = (await a.send({ type: 'start', workflowId: String(WF_EVENT), key: 'k' })).result as {
        instanceId: string;
      };
      const id = started.instanceId;
      await poll(
        () => a!.send({ type: 'get', instanceId: id }),
        (m) => (m.value as { status?: string } | null)?.status === 'waiting',
        6000,
      );

      // A takes the per-instance lease and schedules a fenced transition for +2.5s.
      a.fire({ type: 'holdAndStaleTransition', instanceId: id, leaseMs: 700, delayMs: 2500 });
      const held = await a.next('held', 6000);
      assert.ok(Number(held.generation) >= 0, 'A acquired the lease');

      // Freeze A. Its lease lapses. B cancels the workflow under a fresh generation.
      a.child.kill('SIGSTOP');
      await new Promise((r) => setTimeout(r, 1100));
      const cancelled = (await b.send({ type: 'cancel', instanceId: id })).value as { status?: string };
      assert.equal(cancelled.status, 'cancelled', 'B advanced the instance while A was frozen');

      // Thaw A; its scheduled stale transition now fires and MUST be refused.
      a.child.kill('SIGCONT');
      const stale = await a.next('staleResult', 8000);
      assert.equal(stale.ok, false, `A's stale fenced write was refused (reason: ${String(stale.reason)})`);
      assert.ok(
        ['fenced', 'terminal', 'revision'].includes(String(stale.reason)),
        `refusal reason is a known fencing outcome, got ${String(stale.reason)}`,
      );

      const finalStatus = ((await b.send({ type: 'get', instanceId: id })).value as { status: string }).status;
      assert.equal(finalStatus, 'cancelled', 'the workflow stayed at B’s outcome; no stale commit landed');
      assert.equal((await b.send({ type: 'count' })).value, 0, 'no ActionDef ran');
    } finally {
      a?.child.kill('SIGCONT');
      a?.stop();
      b?.stop();
      await new Promise((r) => setTimeout(r, 200));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
