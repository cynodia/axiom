import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EFFECT_WORK_CLASS,
  createDistributedEffectRunner,
  createDurableWorkStore,
  createMemoryCoordinationProvider,
  createMemoryDurableWorkStorage,
  explainEffectDelivery,
  type EffectExecutionDeps,
} from '@cynodia/axiom-server';
import type { IntegrationAdapter, IntegrationResult } from '@cynodia/axiom-server';
import { nodeId } from '@cynodia/axiom-core';

/**
 * Spec12 §13-§20: the multi-authority transactional outbox.
 *
 * Deterministic, in-process, memory coordination provider — one authority ≈ N authorities:
 *
 * - a logical effect is executed once even when several authorities poll (§17);
 * - a crashed owner's lease lapses and another authority reclaims + completes it (§66),
 *   while the stale owner's late completion is fenced (§18);
 * - retry is durable — the backoff floor lives in the store, `attemptNumber` climbs, the
 *   logical effect id never changes (§14, §19);
 * - the Axiom-supplied idempotency key is the logical effect id (§16);
 * - the graph-owned retry ceiling and terminal-failure meaning are honoured exactly (§20).
 */

// --------------------------------------------------------------------------- fixtures

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** Let queued microtasks/promises drain — used when a `poll()` is deliberately not awaited. */
async function drain(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** `dispatch` is fire-and-forget (enqueue only); wait for the durable row before polling. */
async function enqueue(
  runner: ReturnType<typeof createDistributedEffectRunner>,
  ...intents: EffectIntent[]
): Promise<void> {
  runner.dispatch(intents);
  await drain(2);
}

/** A host whose timers never fire on their own — tests drive `poll()` directly. */
function inertHost() {
  let n = 0;
  return {
    now: () => `2026-01-01T00:00:${String((n += 1)).padStart(2, '0')}.000Z`,
    uuid: () => `id-${(n += 1)}`,
    schedule: () => ({ cancel() {} }),
    scheduleOnce: () => ({ cancel() {} }),
  } as unknown as Parameters<typeof createDistributedEffectRunner>[0]['host'];
}

const OP = nodeId('integration_operation_notify');
const INTEGRATION = nodeId('integration_email');

interface AdapterScript {
  /** Outcomes returned in order; the last one repeats. A function may return a pending promise. */
  outcomes: Array<IntegrationResult | (() => Promise<IntegrationResult>)>;
}

function scriptedAdapter(script: AdapterScript) {
  const calls: Array<{ args: Record<string, unknown>; idempotencyKey?: string }> = [];
  let i = 0;
  const adapter: IntegrationAdapter = {
    async query(): Promise<IntegrationResult> {
      return { ok: false, code: 'NOPE', message: 'not a query test' };
    },
    async effect(_operation, args, context): Promise<IntegrationResult> {
      calls.push({ args, idempotencyKey: context.idempotencyKey });
      const step = script.outcomes[Math.min(i, script.outcomes.length - 1)];
      i += 1;
      return typeof step === 'function' ? step() : step;
    },
  };
  return { adapter, calls };
}

function executionDeps(
  adapter: IntegrationAdapter,
  retry?: { policy: 'none' | 'fixed' | 'exponential'; maxAttempts?: number; delayMs?: number },
): EffectExecutionDeps {
  return {
    adapters: { [INTEGRATION]: adapter },
    integrationOperations: {
      [OP]: {
        id: OP,
        kind: 'integration-operation',
        integrationId: INTEGRATION,
        mode: 'effect',
        resultType: { kind: 'primitive', primitive: 'string' },
        ...(retry ? { retry } : {}),
      },
    } as EffectExecutionDeps['integrationOperations'],
  };
}

type EffectIntent = Parameters<ReturnType<typeof createDistributedEffectRunner>['dispatch']>[0][number];

function effectIntent(id: string, extra: Record<string, unknown> = {}): EffectIntent {
  return {
    id,
    operationId: OP,
    arguments: { to: 'x@example.com' },
    succeededEventId: nodeId('event_ok'),
    failedEventId: nodeId('event_bad'),
    outcome: 'committed',
    status: 'pending',
    attempts: 0,
    ...extra,
  } as EffectIntent;
}

function harness(deps: EffectExecutionDeps, clock: ReturnType<typeof fakeClock>) {
  const coordination = createMemoryCoordinationProvider({ now: clock.now });
  const storage = createMemoryDurableWorkStorage();
  const store = createDurableWorkStore({ coordination, storage, now: clock.now });
  const terminals: Array<{ id: string; status: string; result?: unknown; code?: string }> = [];
  const attempts: Array<{ id: string; attemptNumber: number; uncertainAttempts: number }> = [];
  const reports: string[] = [];
  const make = (instanceId: string) =>
    createDistributedEffectRunner({
      store,
      execution: deps,
      host: inertHost(),
      instanceId,
      now: clock.now,
      config: { leaseDurationMs: 1_000, renewIntervalMs: 400 },
      onTerminal: async (record) => {
        terminals.push({
          id: record.id,
          status: record.status,
          result: record.result,
          code: record.lastError?.code,
        });
      },
      onAttempt: (record, attemptNumber, meta) =>
        attempts.push({ id: record.id, attemptNumber, uncertainAttempts: meta.uncertainAttempts }),
      report: (event) => reports.push(event.kind),
    });
  return { store, coordination, make, terminals, attempts, reports };
}

// ------------------------------------------------------------------------------ tests

test('the work class is "effect"', () => {
  assert.equal(EFFECT_WORK_CLASS, 'effect');
});

test('one logical effect runs once even when two authorities poll (spec12 §17)', async () => {
  const clock = fakeClock();
  const { adapter, calls } = scriptedAdapter({ outcomes: [{ ok: true, value: 'sent-1' }] });
  const { store, make, terminals } = harness(executionDeps(adapter), clock);
  const a = make('A');
  const b = make('B');

  await enqueue(a, effectIntent('e1'));
  // Both authorities poll; the claim lease makes it exclusive.
  const [ta, tb] = await Promise.all([a.poll(), b.poll()]);

  assert.equal(calls.length, 1, 'the adapter was called exactly once');
  assert.equal(terminals.length, 1, 'exactly one terminal transition');
  assert.equal(terminals[0]?.status, 'succeeded');
  assert.equal(terminals[0]?.result, 'sent-1');
  assert.equal(ta + tb, 1, 'exactly one authority counted a terminal');

  const item = await store.get(EFFECT_WORK_CLASS, 'e1');
  assert.equal(item?.state, 'succeeded');
  assert.equal(item?.attemptNumber, 1);
});

test('the idempotency key defaults to the logical effect id (spec12 §16)', async () => {
  const clock = fakeClock();
  const { adapter, calls } = scriptedAdapter({ outcomes: [{ ok: true, value: 'ok' }] });
  const { make } = harness(executionDeps(adapter), clock);
  const runner = make('A');

  await enqueue(runner, effectIntent('e-logical-42'));
  await runner.poll();
  assert.equal(calls[0]?.idempotencyKey, 'e-logical-42');

  const { adapter: a2, calls: c2 } = scriptedAdapter({ outcomes: [{ ok: true, value: 'ok' }] });
  const h2 = harness(executionDeps(a2), fakeClock());
  const r2 = h2.make('A');
  await enqueue(r2, effectIntent('e2', { idempotencyKey: 'author-declared-key' }));
  await r2.poll();
  assert.equal(c2[0]?.idempotencyKey, 'author-declared-key', 'an author-declared key is preserved');
});

test('a crashed owner is reclaimed and completed; its stale completion is fenced (spec12 §18, §66)', async () => {
  const clock = fakeClock();
  let releaseHung: (r: IntegrationResult) => void = () => {};
  const hung = new Promise<IntegrationResult>((resolve) => {
    releaseHung = resolve;
  });
  const { adapter, calls } = scriptedAdapter({
    outcomes: [() => hung, { ok: true, value: 'sent-by-B' }],
  });
  const { store, make, terminals, attempts, reports } = harness(executionDeps(adapter), clock);
  const a = make('A');
  const b = make('B');

  await enqueue(a, effectIntent('e1'));
  void a.poll(); // A claims gen 1; its adapter call hangs
  await drain();
  assert.equal(calls.length, 1, 'A started an attempt');

  // A "crashes": it never renews. Its 1_000ms lease lapses.
  clock.advance(1_001);

  const bTerminals = await b.poll(); // B reclaims generation 2, adapter #2 succeeds, B settles
  assert.equal(bTerminals, 1, 'B durably completed the effect');
  assert.equal(terminals.at(-1)?.status, 'succeeded');
  assert.equal(terminals.at(-1)?.result, 'sent-by-B');

  // §70: B's attempt is a retry after an unknown outcome — reported, and reusing A's key.
  assert.ok(reports.includes('effect-outcome-uncertain'), 'the uncertain outcome is reported');
  assert.equal(attempts.at(-1)?.uncertainAttempts, 1, 'B sees one uncertain prior attempt');
  assert.equal(calls[0]?.idempotencyKey, calls[1]?.idempotencyKey, 'the stable idempotency key is reused');
  assert.equal(calls[1]?.idempotencyKey, 'e1');

  // A finally gets its hung result back and tries to settle generation 1 — fenced.
  releaseHung({ ok: true, value: 'sent-by-A' });
  await drain();

  assert.equal(terminals.length, 1, 'A did not fire a second terminal');
  const item = await store.get(EFFECT_WORK_CLASS, 'e1');
  assert.equal(item?.state, 'succeeded');
  assert.equal(item?.result, 'sent-by-B', "the reclaimer's result is authoritative");
  assert.equal(item?.uncertainAttempts, 1, 'the uncertain-attempt count is durable');
  assert.equal(item?.attemptNumber, 2, 'two physical attempts');
});

test('durable retry: transient failures climb attemptNumber, keep one logical id, then succeed (spec12 §14, §19)', async () => {
  const clock = fakeClock();
  const { adapter, calls } = scriptedAdapter({
    outcomes: [
      { ok: false, code: 'HTTP_503', message: 'unavailable', retryable: true },
      { ok: false, code: 'HTTP_503', message: 'unavailable', retryable: true },
      { ok: true, value: 'sent-on-3' },
    ],
  });
  const { store, make, terminals, attempts } = harness(
    executionDeps(adapter, { policy: 'fixed', maxAttempts: 3, delayMs: 5_000 }),
    clock,
  );
  const runner = make('A');
  await enqueue(runner, effectIntent('e1'));

  assert.equal(await runner.poll(), 0, 'attempt 1 fails → retry, no terminal');
  assert.equal(await runner.poll(), 0, 'still inside the 5s backoff — nothing claimed');
  assert.equal(calls.length, 1, 'the backoff floor is respected');

  clock.advance(5_000);
  assert.equal(await runner.poll(), 0, 'attempt 2 fails → retry');
  clock.advance(5_000);
  assert.equal(await runner.poll(), 1, 'attempt 3 succeeds → terminal');

  assert.equal(calls.length, 3);
  assert.deepEqual(
    attempts.map((a) => a.attemptNumber),
    [1, 2, 3],
    'physical attempts are numbered 1..3',
  );
  assert.ok(
    attempts.every((a) => a.id === 'e1'),
    'the logical effect id never changed across retries',
  );
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.status, 'succeeded');
  assert.equal((await store.get(EFFECT_WORK_CLASS, 'e1'))?.state, 'succeeded');
});

test('a non-retryable failure is terminal immediately (spec12 §20)', async () => {
  const clock = fakeClock();
  const { adapter, calls } = scriptedAdapter({
    outcomes: [{ ok: false, code: 'BAD_ADDRESS', message: 'no such recipient', retryable: false }],
  });
  const { store, make, terminals } = harness(
    executionDeps(adapter, { policy: 'fixed', maxAttempts: 5, delayMs: 1_000 }),
    clock,
  );
  const runner = make('A');
  await enqueue(runner, effectIntent('e1'));

  assert.equal(await runner.poll(), 1);
  assert.equal(calls.length, 1, 'no retry for a non-retryable failure');
  assert.equal(terminals[0]?.status, 'failed');
  assert.equal(terminals[0]?.code, 'BAD_ADDRESS');
  assert.equal((await store.get(EFFECT_WORK_CLASS, 'e1'))?.state, 'failed');
});

test('the retry ceiling is the graph-owned maxAttempts, then failed (spec12 §20)', async () => {
  const clock = fakeClock();
  const { adapter, calls } = scriptedAdapter({
    outcomes: [{ ok: false, code: 'HTTP_503', message: 'unavailable', retryable: true }],
  });
  const { store, make, terminals } = harness(
    executionDeps(adapter, { policy: 'fixed', maxAttempts: 2, delayMs: 1_000 }),
    clock,
  );
  const runner = make('A');
  await enqueue(runner, effectIntent('e1'));

  assert.equal(await runner.poll(), 0, 'attempt 1 → retry');
  clock.advance(1_000);
  assert.equal(await runner.poll(), 1, 'attempt 2 exhausts the ceiling → failed');
  assert.equal(calls.length, 2);
  assert.equal(terminals[0]?.status, 'failed');
  assert.equal(terminals[0]?.code, 'HTTP_503');
  assert.equal((await store.get(EFFECT_WORK_CLASS, 'e1'))?.state, 'failed');
});

test('dispatch is idempotent on the logical effect id — a re-dispatched intent is not a second effect', async () => {
  const clock = fakeClock();
  const { adapter, calls } = scriptedAdapter({ outcomes: [{ ok: true, value: 'once' }] });
  const { store, make, terminals } = harness(executionDeps(adapter), clock);
  const runner = make('A');

  await enqueue(runner, effectIntent('e1'));
  await enqueue(runner, effectIntent('e1')); // e.g. a restart re-loading the same pending intent
  await runner.poll();
  await runner.poll();

  assert.equal(calls.length, 1, 'still one physical execution');
  assert.equal(terminals.length, 1);
  assert.equal((await store.get(EFFECT_WORK_CLASS, 'e1'))?.attemptNumber, 1);
});

test('lastAttemptAt is recorded on every claim (spec12 §19)', async () => {
  const clock = fakeClock(10_000);
  const { adapter } = scriptedAdapter({
    outcomes: [
      { ok: false, code: 'HTTP_503', message: 'x', retryable: true },
      { ok: true, value: 'ok' },
    ],
  });
  const { store, make } = harness(
    executionDeps(adapter, { policy: 'fixed', maxAttempts: 3, delayMs: 1_000 }),
    clock,
  );
  const runner = make('A');
  await enqueue(runner, effectIntent('e1'));

  await runner.poll();
  assert.equal((await store.get(EFFECT_WORK_CLASS, 'e1'))?.lastAttemptAt, 10_000);
  clock.advance(1_000);
  await runner.poll();
  assert.equal((await store.get(EFFECT_WORK_CLASS, 'e1'))?.lastAttemptAt, 11_000, 'updated to the newest attempt');
});

test('explainEffectDelivery answers the spec12 §57 questions without provider knowledge', async () => {
  const clock = fakeClock(1_000);
  let release: (r: import('@cynodia/axiom-server').IntegrationResult) => void = () => {};
  const hung = new Promise<import('@cynodia/axiom-server').IntegrationResult>((r) => {
    release = r;
  });
  const { adapter } = scriptedAdapter({ outcomes: [() => hung, { ok: true, value: 'done' }] });
  const { store, coordination, make } = harness(
    executionDeps(adapter, { policy: 'fixed', maxAttempts: 3, delayMs: 5_000 }),
    clock,
  );
  const runner = make('A');
  await enqueue(runner, effectIntent('e1'));

  // pending → runnable, no owner, exactly-once/at-least-once/exactly-once
  let item = (await store.get(EFFECT_WORK_CLASS, 'e1'))!;
  let x = explainEffectDelivery(item, await coordination.inspect('effect:e1'), clock.now());
  assert.equal(x.runnable, 'runnable');
  assert.equal(x.owner, null);
  assert.equal(x.reclaimable, false);
  assert.deepEqual(x.deliveryGuarantee, {
    logicalCreation: 'exactly-once',
    physicalExecution: 'at-least-once',
    completionTransition: 'exactly-once',
  });

  // claimed with a live lease → in-progress, owner present, not reclaimable
  void runner.poll();
  await drain();
  item = (await store.get(EFFECT_WORK_CLASS, 'e1'))!;
  x = explainEffectDelivery(item, await coordination.inspect('effect:e1'), clock.now());
  assert.equal(x.runnable, 'in-progress');
  assert.equal(x.owner?.ownerId, 'A');
  assert.equal(x.owner?.generation, 1);
  assert.equal(x.reclaimable, false);
  assert.match(x.ifOwnerCrashes, /lease expires/i);

  // lease lapses → reclaimable, runnable, no live owner
  clock.advance(1_001);
  x = explainEffectDelivery(item, await coordination.inspect('effect:e1'), clock.now());
  assert.equal(x.reclaimable, true);
  assert.equal(x.runnable, 'runnable');
  assert.equal(x.owner, null);

  // provider-idempotent flips only the physical-execution guarantee
  assert.equal(
    explainEffectDelivery(item, null, clock.now(), { providerIdempotent: true }).deliveryGuarantee
      .physicalExecution,
    'exactly-once-if-provider-idempotent',
  );

  // A's hung attempt finally returns a retryable failure; A still holds generation 1 (no one
  // reclaimed), so its own retry settle applies → state 'retry', backing off 5s.
  release({ ok: false, code: 'HTTP_503', message: 'x', retryable: true });
  await drain();
  item = (await store.get(EFFECT_WORK_CLASS, 'e1'))!;
  assert.equal(item.state, 'retry');

  // After the backoff, a poll reclaims (gen 2) and the scripted success → terminal.
  clock.advance(5_001);
  await runner.poll();
  item = (await store.get(EFFECT_WORK_CLASS, 'e1'))!;
  x = explainEffectDelivery(item, await coordination.inspect('effect:e1'), clock.now());
  assert.equal(x.runnable, 'terminal');
  assert.equal(x.reclaimable, false);
  assert.match(x.ifOwnerCrashes, /Nothing/);
});

test('explainEffectDelivery reports a backing-off retry state', async () => {
  const clock = fakeClock(1_000);
  const { adapter } = scriptedAdapter({
    outcomes: [{ ok: false, code: 'HTTP_503', message: 'x', retryable: true }],
  });
  const { store, coordination, make } = harness(
    executionDeps(adapter, { policy: 'fixed', maxAttempts: 5, delayMs: 5_000 }),
    clock,
  );
  const runner = make('A');
  await enqueue(runner, effectIntent('e1'));
  await runner.poll(); // attempt 1 fails → retry, nextEligibleAt = 6_000

  const item = (await store.get(EFFECT_WORK_CLASS, 'e1'))!;
  const x = explainEffectDelivery(item, await coordination.inspect('effect:e1'), clock.now());
  assert.equal(item.state, 'retry');
  assert.equal(x.runnable, 'backing-off');
  assert.equal(x.reclaimable, false, 'not reclaimable while inside the backoff window');
  assert.equal(x.nextEligibleAt, 6_000);
  assert.equal(x.attemptNumber, 1);
});
