import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isSqliteAvailable } from '@cynodia/axiom-server';
import type { MixedVariant } from './helpers/workflow-mixed-graph.js';

/**
 * spec14pt3 F3 — real-OS-process mixed-build fail-closed (§27, §28, §66-§85, §120).
 *
 * Build A creates and parks a workflow instance. A semantically different build B, on the
 * same shared SQLite stores, must refuse to advance it — no transition, no ActionDef
 * invocation, no event match, no timer fire, no `instanceRevision` advance — and leave it
 * intact for a compatible authority. A build that differs only in presentation continues
 * it normally. No sticky routing, no leader, no homogeneous-build assumption.
 */

const available = await isSqliteAvailable();
const WORKER = fileURLToPath(new URL('./helpers/workflow-mixed-worker.js', import.meta.url));
const TRIALS = Math.max(1, Number(process.env.AXIOM_WF_MIXED_TRIALS ?? 25));

const REPLY: Record<string, string> = {
  start: 'started',
  list: 'list',
  get: 'workflow',
  history: 'history',
  count: 'count',
  event: 'event-ack',
  cancel: 'cancelled',
};

interface Authority {
  child: ChildProcess;
  label: string;
  send(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): void;
}

function spawnAuthority(dbs: { stateDb: string; wfDb: string; coordDb: string }, label: string, variant: MixedVariant): Promise<Authority> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [dbs.stateDb, dbs.wfDb, dbs.coordDb, label, variant], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (c) => (stderr += String(c)));
    const inbox: Record<string, unknown>[] = [];
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
    const authority: Authority = {
      child,
      label,
      send: (msg) => {
        child.send(msg);
        const type = REPLY[String(msg.type)];
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`${label}: timed out waiting for ${type ?? 'reply'}`)), 12_000);
          waiters.push({
            ...(type ? { type } : {}),
            resolve: (m) => {
              clearTimeout(t);
              res(m);
            },
          });
          pump();
        });
      },
      stop: () => {
        try {
          child.send({ type: 'stop' });
        } catch {
          /* gone */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }, 500).unref();
      },
    };
  });
}

function tempDbs(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, stateDb: path.join(dir, 'state.db'), wfDb: path.join(dir, 'wf.db'), coordDb: path.join(dir, 'coord.db') };
}

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000, step = 150): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await fn();
  while (Date.now() < deadline) {
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, step));
    last = await fn();
  }
  return last;
}

const status = (m: Record<string, unknown>): string | undefined => (m.value as { status?: string } | null)?.status;

// --------------------------------------------------------------------------- semantic refusal

const SEMANTIC_VARIANTS: Array<[string, MixedVariant]> = [
  ['different wait-event target', 'b-event'],
  ['different timer duration', 'b-timer'],
  ['different action target', 'b-action'],
];

for (const [label, bVariant] of SEMANTIC_VARIANTS) {
  test(
    `spec14pt3 F3: build B (${label}) refuses an A instance across real processes — ${TRIALS} trials`,
    { skip: !available },
    async () => {
      let refusedEveryTrial = 0;
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const dbs = tempDbs('axiom-wf-mixed-');
        let a: Authority | undefined;
        let b: Authority | undefined;
        let a2: Authority | undefined;
        try {
          a = await spawnAuthority(dbs, `A${trial}`, 'a');
          const started = (await a.send({ type: 'start', workflowId: 'wf', key: `k${trial}` })).result as {
            instanceId: string;
          };
          const id = started.instanceId;
          await a.send({ type: 'event', key: `k${trial}` }); // A parks it at the timer
          const parked = await poll(() => a!.send({ type: 'get', instanceId: id }), (m) => status(m) === 'waiting' || status(m) === 'running');
          const before = parked.value as { instanceRevision: number; status: string; currentStepId: string };
          const beforeHistory = ((await a.send({ type: 'history', instanceId: id })).value as string[]).length;

          // Stop A entirely; only the incompatible B remains (§84 incompatible-only deployment).
          a.stop();
          await new Promise((r) => setTimeout(r, 400));

          b = await spawnAuthority(dbs, `B${trial}`, bVariant);
          // Give B every chance: its poll loop, an explicit event, a cancel attempt.
          await b.send({ type: 'event', key: `k${trial}` });
          const bCancel = (await b.send({ type: 'cancel', instanceId: id })).value as { error?: { code: string } };
          await new Promise((r) => setTimeout(r, 1500)); // B poll loop churns

          const bView = await b.send({ type: 'get', instanceId: id });
          assert.equal((bView.value as { compatible?: boolean }).compatible, false, `trial ${trial}: B reports incompatible`);
          assert.equal((bView.value as { incompatibleReason?: string }).incompatibleReason, 'incompatible-build');
          assert.ok(bCancel?.error?.code === 'INCOMPATIBLE_AUTHORITY', `trial ${trial}: B cancel refused`);

          const after = bView.value as { instanceRevision: number; status: string; currentStepId: string };
          assert.equal(after.instanceRevision, before.instanceRevision, `trial ${trial}: no revision advance by B`);
          assert.equal(after.status, before.status, `trial ${trial}: no status change by B`);
          assert.equal(after.currentStepId, before.currentStepId, `trial ${trial}: no step change by B`);
          assert.equal((await b.send({ type: 'count' })).value, 0, `trial ${trial}: B invoked no ActionDef`);
          const bHistory = (await b.send({ type: 'history', instanceId: id })).value as string[];
          assert.equal(bHistory.length, beforeHistory, `trial ${trial}: B appended nothing to the logical history`);
          refusedEveryTrial += 1;

          // A compatible authority (fresh process, semantically identical build A) recovers it.
          a2 = await spawnAuthority(dbs, `A2-${trial}`, 'a');
          const done = await poll(() => a2!.send({ type: 'get', instanceId: id }), (m) => status(m) === 'completed');
          assert.equal(status(done), 'completed', `trial ${trial}: compatible A2 completed it`);
          assert.equal((await a2.send({ type: 'count' })).value, 1, `trial ${trial}: the ActionDef ran exactly once, on A2`);
        } finally {
          a?.stop();
          b?.stop();
          a2?.stop();
          await new Promise((r) => setTimeout(r, 150));
          rmSync(dbs.dir, { recursive: true, force: true });
        }
      }
      assert.equal(refusedEveryTrial, TRIALS, 'B refused every trial');
    },
  );
}

// --------------------------------------------------------------------------- presentation control

test(
  `spec14pt3 §71/§104/§121: a presentation-only build B continues an A instance — ${TRIALS} trials`,
  { skip: !available },
  async () => {
    let ok = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const dbs = tempDbs('axiom-wf-mixed-pres-');
      let a: Authority | undefined;
      let b: Authority | undefined;
      try {
        a = await spawnAuthority(dbs, `A${trial}`, 'a');
        const started = (await a.send({ type: 'start', workflowId: 'wf', key: `k${trial}` })).result as { instanceId: string };
        const id = started.instanceId;
        await a.send({ type: 'event', key: `k${trial}` });
        await poll(() => a!.send({ type: 'get', instanceId: id }), (m) => status(m) === 'waiting' || status(m) === 'running');
        a.stop();
        await new Promise((r) => setTimeout(r, 400));

        b = await spawnAuthority(dbs, `Bpres${trial}`, 'a-presentation');
        const bView = await poll(() => b!.send({ type: 'get', instanceId: id }), (m) => status(m) === 'completed');
        assert.equal(status(bView), 'completed', `trial ${trial}: presentation-only B completed it`);
        assert.equal((bView.value as { compatible?: boolean }).compatible, true, `trial ${trial}: B reports compatible`);
        assert.equal((await b.send({ type: 'count' })).value, 1, `trial ${trial}: exactly one ActionDef commit`);
        ok += 1;
      } finally {
        a?.stop();
        b?.stop();
        await new Promise((r) => setTimeout(r, 150));
        rmSync(dbs.dir, { recursive: true, force: true });
      }
    }
    assert.equal(ok, TRIALS, 'presentation-only B is compatible every trial (over-fingerprinting is also a defect)');
  },
);

// --------------------------------------------------------------------------- mixed topology

for (const N of [2, 8]) {
  test(
    `spec14pt3 §27/§82/§83: ${N}-authority mixed deployment — only compatible authorities advance`,
    { skip: !available },
    async () => {
      const dbs = tempDbs(`axiom-wf-mixed-topo${N}-`);
      const auths: Authority[] = [];
      try {
        // Half compatible (A), half a semantic B. A creates the instance.
        const half = Math.max(1, N / 2);
        for (let i = 0; i < N; i += 1) {
          auths.push(await spawnAuthority(dbs, `n${i}`, i < half ? 'a' : 'b-timer'));
        }
        const started = (await auths[0].send({ type: 'start', workflowId: 'wf', key: 'shared' })).result as { instanceId: string };
        const id = started.instanceId;
        // Every authority is exposed to the event; only compatible ones may transition on it.
        await Promise.all(auths.map((w) => w.send({ type: 'event', key: 'shared' })));

        const done = await poll(() => auths[0].send({ type: 'get', instanceId: id }), (m) => status(m) === 'completed', 20_000);
        assert.equal(status(done), 'completed', `${N}-auth: a compatible authority carried it to completion`);
        assert.equal((await auths[0].send({ type: 'count' })).value, 1, `${N}-auth: exactly one logical ActionDef commit`);
        const history = (await auths[0].send({ type: 'history', instanceId: id })).value as string[];
        assert.equal(history.filter((k) => k === 'event-matched').length, 1, `${N}-auth: one event-matched`);
        assert.equal(history.filter((k) => k === 'step-succeeded').length, 1, `${N}-auth: one step-succeeded`);

        // The incompatible authorities each still see it as not-theirs.
        for (let i = half; i < N; i += 1) {
          const v = await auths[i].send({ type: 'get', instanceId: id });
          assert.equal((v.value as { compatible?: boolean }).compatible, false, `${N}-auth: B#${i} reports incompatible`);
        }
      } finally {
        for (const w of auths) w.stop();
        await new Promise((r) => setTimeout(r, 250));
        rmSync(dbs.dir, { recursive: true, force: true });
      }
    },
  );
}
