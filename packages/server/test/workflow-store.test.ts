import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createMemoryWorkflowStore,
  createSqliteWorkflowStore,
  isSqliteWorkflowStoreAvailable,
} from '@cynodia/axiom-server';
import type { WorkflowStartIdentity, WorkflowStore, WorkflowTransition } from '@cynodia/axiom-server';

/**
 * spec14 §81-§85, §131-§133 — the `WorkflowStore` contract, run identically against the
 * memory reference and the SQLite reference. Every transition is a fenced CAS; the check is
 * inside the write transaction, so conflicting transitions from one revision cannot both
 * commit.
 */

const START: WorkflowStartIdentity = {
  workflowId: 'wf_x',
  principalFingerprint: 'p1',
  idempotencyKey: 'k1',
  compatibilityFingerprint: 'build-1',
};

function initFor(instanceId: string) {
  return () => ({
    instanceId,
    workflowId: 'wf_x',
    compatibilityFingerprint: 'build-1',
    principal: { user: 'u1' },
    principalFingerprint: 'p1',
    inputs: { orderId: 'o-1' },
    entryStepId: 'step_a',
  });
}

const transitionTo = (currentStepId: string, status: WorkflowTransition['status'] = 'running'): WorkflowTransition => ({
  status,
  currentStepId,
  activationId: `${currentStepId}#0`,
  attempt: 0,
  pendingAction: null,
  nextEligibleAt: null,
  history: { kind: 'branch-chosen', stepId: currentStepId },
});

async function contractBody(store: WorkflowStore): Promise<void> {
  // Idempotent creation.
  const a = await store.createIdempotent(START, initFor('wf_inst_1'));
  assert.equal(a.created, true);
  const b = await store.createIdempotent(START, initFor('wf_inst_2'));
  assert.equal(b.created, false);
  assert.equal(b.instance.instanceId, 'wf_inst_1');

  const loaded = await store.load('wf_inst_1');
  assert.equal(loaded?.status, 'running');
  assert.equal(loaded?.instanceRevision, 0);
  assert.deepEqual(loaded?.inputs, { orderId: 'o-1' });

  // A fenced CAS at the expected revision succeeds and bumps the revision.
  const t1 = await store.transition({ instanceId: 'wf_inst_1', expectedRevision: 0, fence: 0, next: transitionTo('step_b') });
  assert.equal(t1.ok, true);
  assert.equal(t1.ok && t1.record.instanceRevision, 1);
  assert.equal(t1.ok && t1.record.currentStepId, 'step_b');

  // A CAS from a stale revision is refused (spec14 §133).
  const stale = await store.transition({ instanceId: 'wf_inst_1', expectedRevision: 0, fence: 0, next: transitionTo('step_c') });
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.reason, 'revision');

  // A CAS carrying a stale fence is refused (spec14 §89, §90).
  const t2 = await store.transition({ instanceId: 'wf_inst_1', expectedRevision: 1, fence: 5, next: transitionTo('step_c') });
  assert.equal(t2.ok, true);
  const fenced = await store.transition({ instanceId: 'wf_inst_1', expectedRevision: 2, fence: 3, next: transitionTo('step_d') });
  assert.equal(fenced.ok, false);
  assert.equal(!fenced.ok && fenced.reason, 'fenced');

  // A terminal instance cannot transition (spec14 §74).
  const done = await store.transition({
    instanceId: 'wf_inst_1',
    expectedRevision: 2,
    fence: 5,
    next: { ...transitionTo('step_c', 'completed'), output: { ok: true }, history: { kind: 'completed', stepId: 'step_c' } },
  });
  assert.equal(done.ok, true);
  const afterTerminal = await store.transition({ instanceId: 'wf_inst_1', expectedRevision: 3, fence: 5, next: transitionTo('step_e') });
  assert.equal(afterTerminal.ok, false);
  assert.equal(!afterTerminal.ok && afterTerminal.reason, 'terminal');

  // Durable per-activation action outcome.
  await store.recordActionOutcome('wf_inst_1', 'step_b#0', { ok: true, retryable: false });
  assert.deepEqual(await store.loadActionOutcome('wf_inst_1', 'step_b#0'), { ok: true, retryable: false });
  await store.recordActionOutcome('wf_inst_1', 'step_b#0', undefined);
  assert.equal(await store.loadActionOutcome('wf_inst_1', 'step_b#0'), undefined);

  // History is an append log with a monotone seq.
  const history = await store.history('wf_inst_1');
  assert.deepEqual(history.map((h) => h.seq), [0, 1, 2, 3]);
  assert.equal(history[0].kind, 'started');
  assert.equal(history.at(-1)!.kind, 'completed');

  // spec14pt2 F2 — the durable accepted-event journal: a store-global monotone seq, a
  // per-event `> sinceSeq` read, and a high-water mark that survives trimming.
  assert.equal(await store.latestAcceptedEventSeq(), 0);
  const s1 = await store.appendAcceptedEvent('event_go', { k: 'a' });
  const s2 = await store.appendAcceptedEvent('event_other', { k: 'b' });
  const s3 = await store.appendAcceptedEvent('event_go', { k: 'c' });
  assert.ok(s1 < s2 && s2 < s3, 'monotone across event types');
  assert.equal(await store.latestAcceptedEventSeq(), s3);

  const fromZero = await store.readAcceptedEventsSince('event_go', 0, 10);
  assert.deepEqual(
    fromZero.map((e) => e.seq),
    [s1, s3],
    'only this event type, oldest first',
  );
  const afterS1 = await store.readAcceptedEventsSince('event_go', s1, 10);
  assert.deepEqual(afterS1.map((e) => e.payload), [{ k: 'c' }], 'strictly greater than sinceSeq');
  assert.deepEqual(await store.readAcceptedEventsSince('event_go', s3, 10), [], 'nothing past the head');

  // A fresh instance parked on an event is discoverable by the unfiltered scan.
  await store.createIdempotent(
    { ...START, workflowId: 'wf_y', idempotencyKey: 'w2' },
    () => ({
      instanceId: 'wf_wait_1',
      workflowId: 'wf_y',
      compatibilityFingerprint: 'build-1',
      principal: null,
      principalFingerprint: 'p1',
      inputs: {},
      entryStepId: 'w',
    }),
  );
  await store.transition({
    instanceId: 'wf_wait_1',
    expectedRevision: 0,
    fence: 0,
    next: {
      status: 'waiting',
      currentStepId: 'w',
      activationId: 'w#0',
      attempt: 0,
      pendingAction: null,
      nextEligibleAt: null,
      wait: { kind: 'event', stepId: 'w', eventId: 'event_go', correlation: {}, sinceEventSeq: s1 },
      history: { kind: 'step-activated', stepId: 'w' },
    },
  });
  const pending = await store.pendingEventWaits(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].instanceId, 'wf_wait_1');
  assert.equal(pending[0].eventId, 'event_go');
  assert.equal(pending[0].sinceEventSeq, s1);
}

test('memory WorkflowStore satisfies the contract', async () => {
  await contractBody(createMemoryWorkflowStore());
});

test('SQLite WorkflowStore satisfies the identical contract', async (t) => {
  if (!(await isSqliteWorkflowStoreAvailable())) return t.skip('node:sqlite unavailable');
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-wfstore-'));
  try {
    const store = await createSqliteWorkflowStore({ location: path.join(dir, 'wf.db') });
    await contractBody(store);
    await store.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite: concurrent conflicting transitions from one revision — exactly one commits', async (t) => {
  if (!(await isSqliteWorkflowStoreAvailable())) return t.skip('node:sqlite unavailable');
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-wfrace-'));
  try {
    const dbPath = path.join(dir, 'wf.db');
    const store = await createSqliteWorkflowStore({ location: dbPath });
    await store.createIdempotent({ ...START, idempotencyKey: 'race' }, initFor('wf_race'));

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.transition({ instanceId: 'wf_race', expectedRevision: 0, fence: 0, next: transitionTo(`step_${i}`) }),
      ),
    );
    const committed = results.filter((r) => r.ok);
    assert.equal(committed.length, 1, 'exactly one transition from revision 0 committed');
    assert.ok(results.filter((r) => !r.ok).every((r) => (r as { reason: string }).reason === 'revision'));
    assert.equal((await store.load('wf_race'))?.instanceRevision, 1);
    await store.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
