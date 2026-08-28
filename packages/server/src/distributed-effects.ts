/**
 * The multi-authority transactional-outbox runner (spec12 §13-§20).
 *
 * The 0.8 outbox is unchanged in shape: an `integration-effect` / `blob-commit` /
 * `blob-delete` intent commits atomically with the state that caused it, and is dispatched
 * afterwards, never inside the caller's transaction. 0.12 changes only *who* dispatches it:
 * instead of every authority that holds the intent racing to call the adapter, each logical
 * effect is a {@link DurableWorkItem} that exactly one authority claims, attempts, and
 * settles under a fencing generation.
 *
 * The delivery contract this enforces (spec12 §15), machine-inspectable via the work store:
 *
 * - **exactly-once logical effect creation** — `workId` is the committed intent id; `enqueue`
 *   is idempotent, so two authorities committing/​resuming the same intent create one item.
 * - **at-least-once physical execution** — an attempt whose outcome is never observed (crash,
 *   lost lease) is retried by whichever authority reclaims the item. The Axiom-supplied
 *   `idempotencyKey` (= the logical effect id, spec12 §16) is what lets an idempotent
 *   provider collapse that to one side effect.
 * - **exactly-once durable completion transition** — `settle` is fenced: only the current
 *   owner's generation may move the item to `succeeded` / `failed`, so `onTerminal` (and the
 *   declared success/failure event) fires once.
 *
 * Retry is durable (spec12 §19): a transient failure moves the item to `retry` with a
 * `nextEligibleAt` backoff floor held *in the store*, not in a process-local timer, so a
 * restart or failover resumes it. The graph-owned retry policy (`maxAttempts`, backoff
 * shape, `retryable`) is honoured exactly — infrastructure only chooses poll cadence and
 * claim batch size (spec12 §20).
 */

import {
  DEFAULT_COORDINATION_CONFIG,
  type AuthorityInstanceId,
  type CoordinationConfig,
  type Lease,
} from './coordination.js';
import type { NodeId } from './deps.js';
import {
  effectRetryPolicy,
  performEffectAttempt,
  type EffectExecutionDeps,
} from './effects.js';
import type { ServerHost } from './host.js';
import type { ClaimedWork, DurableWorkItem, DurableWorkState, DurableWorkStore } from './durable-work.js';
import { isTerminalWorkState } from './durable-work.js';
import type { EffectRecord } from './persistence.js';

/** The {@link DurableWorkStore} work class every outbox effect belongs to. */
export const EFFECT_WORK_CLASS = 'effect';

export interface DistributedEffectRunnerOptions {
  /** The durable claim state machine, backed by a coordination provider (spec12 §7). */
  store: DurableWorkStore;
  /** Everything one physical attempt needs — shared with the single-authority runner. */
  execution: EffectExecutionDeps;
  host: ServerHost;
  /** This authority's identity; the owner recorded on every claim it wins. */
  instanceId: AuthorityInstanceId;
  /** Infrastructure cadence/batching only. Never changes a semantic guarantee (spec12 §20, §89). */
  config?: Partial<CoordinationConfig>;
  now?: () => number;
  /**
   * Fires once, on the authority that durably settled the effect, when it reaches
   * `succeeded` / `failed` — this is what dispatches the declared success/failure event.
   */
  onTerminal(record: EffectRecord): Promise<void>;
  /**
   * Observability: an attempt has been claimed and is about to call the adapter.
   * `uncertainAttempts > 0` means at least one earlier physical attempt's outcome was never
   * recorded — this attempt is a retry-after-uncertainty and reuses the same idempotency key
   * (spec12 §70).
   */
  onAttempt?(record: EffectRecord, attemptNumber: number, meta: { uncertainAttempts: number }): void;
  report?(event: {
    kind:
      | 'effect-attempted'
      | 'effect-succeeded'
      | 'effect-failed'
      | 'effect-retry-scheduled'
      | 'effect-outcome-uncertain';
    effectId: string;
    operationId: NodeId;
    attempt: number;
  }): void;
}

export interface DistributedEffectRunner {
  /**
   * Register freshly committed effect intents as durable work. Fire and forget — the
   * caller's transaction has already committed. Execution is picked up by the next
   * {@link poll}; with the background loop running (`start`) that is within `pollIntervalMs`.
   * A lower-latency wake on dispatch is spec12 §54 and deliberately not done here.
   */
  dispatch(records: EffectRecord[]): void;
  /**
   * Claim and run one batch of eligible effects — freshly enqueued, retry-eligible, or
   * orphaned by a crashed owner. Returns how many items reached a durable terminal state.
   * Safe to call on any authority at any time, including at startup in place of the old
   * `loadPendingEffects` resume.
   */
  poll(): Promise<number>;
  /** Begin the background poll loop on the host timer. */
  start(): void;
  /** Stop the background poll loop. In-flight attempts are left to finish. */
  stop(): Promise<void>;
}

function backoffMs(
  policy: NonNullable<ReturnType<typeof effectRetryPolicy>>,
  attemptNumber: number,
): number {
  const base = policy.delayMs ?? 1000;
  return policy.policy === 'exponential' ? base * 2 ** Math.max(0, attemptNumber - 1) : base;
}

export function createDistributedEffectRunner(
  options: DistributedEffectRunnerOptions,
): DistributedEffectRunner {
  const { store, execution, host, instanceId, onTerminal, onAttempt, report } = options;
  const config: CoordinationConfig = { ...DEFAULT_COORDINATION_CONFIG, ...options.config };
  const now = options.now ?? (() => Date.now());
  const batchSize = Math.max(1, Math.min(config.claimBatchSize, config.workerConcurrency));

  let running = false;
  let polling = false;
  let pollQueued = false;
  const activeHeartbeats = new Set<() => void>();

  /** Reconstruct a live `EffectRecord` view from the stored payload + the claim's attempt. */
  function recordOf(claim: ClaimedWork, status: EffectRecord['status']): EffectRecord {
    const payload = claim.item.payload as EffectRecord;
    return { ...payload, status, attempts: claim.item.attemptNumber };
  }

  /** Keep the lease alive while an adapter call is outstanding. Stops itself on lease loss. */
  function heartbeat(claim: ClaimedWork): () => void {
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      activeHeartbeats.delete(cancel);
    };
    const tick = (): void => {
      if (cancelled || !running) return;
      void store.renew(claim, config.leaseDurationMs).then((held) => {
        if (cancelled || !running || !held) return;
        host.scheduleOnce(config.renewIntervalMs, tick);
      });
    };
    activeHeartbeats.add(cancel);
    host.scheduleOnce(config.renewIntervalMs, tick);
    return cancel;
  }

  async function runClaim(claim: ClaimedWork): Promise<boolean> {
    const attemptNumber = claim.item.attemptNumber;
    const uncertainAttempts = claim.item.uncertainAttempts;
    const attemptRecord = recordOf(claim, 'running');
    const effectId = attemptRecord.id;
    const operationId = attemptRecord.operationId;

    if (uncertainAttempts > 0) {
      // A prior physical attempt may or may not have reached the external system. We retry
      // per the delivery contract with the same idempotency key — never claiming the earlier
      // attempt did not happen (spec12 §15, §70).
      report?.({ kind: 'effect-outcome-uncertain', effectId, operationId, attempt: attemptNumber });
    }
    onAttempt?.(attemptRecord, attemptNumber, { uncertainAttempts });
    report?.({ kind: 'effect-attempted', effectId, operationId, attempt: attemptNumber });

    const stopHeartbeat = heartbeat(claim);
    let result;
    try {
      result = await performEffectAttempt(attemptRecord, execution);
    } catch (error) {
      result = {
        ok: false as const,
        code: 'EFFECT_ATTEMPT_THREW',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    } finally {
      stopHeartbeat();
    }

    if (result.ok) {
      const settled = await store.settle(claim, { kind: 'succeeded', result: result.value });
      if (!settled.ok) {
        // Fenced or already terminal: another authority owns or finished this logical
        // effect. We must not fire the terminal event a second time (spec12 §18).
        return false;
      }
      await onTerminal({ ...recordOf(claim, 'succeeded'), result: result.value });
      report?.({ kind: 'effect-succeeded', effectId, operationId, attempt: attemptNumber });
      return true;
    }

    const lastError = { code: result.code, message: result.message, retryable: result.retryable };
    const policy = effectRetryPolicy(attemptRecord, execution) ?? { policy: 'none' as const };
    const maxAttempts = policy.policy === 'none' ? 1 : policy.maxAttempts ?? 3;
    const exhausted = attemptNumber >= maxAttempts || result.retryable === false;

    if (exhausted) {
      const settled = await store.settle(claim, { kind: 'failed', error: lastError });
      if (!settled.ok) {
        return false;
      }
      await onTerminal({ ...recordOf(claim, 'failed'), lastError });
      report?.({ kind: 'effect-failed', effectId, operationId, attempt: attemptNumber });
      return true;
    }

    // Durable backoff (spec12 §19): the next-eligible time lives in the store, so a restart
    // or failover between now and then still retries — never a process-local setTimeout.
    const nextEligibleAt = now() + backoffMs(policy, attemptNumber);
    await store.settle(claim, { kind: 'retry', error: lastError, nextEligibleAt });
    report?.({ kind: 'effect-retry-scheduled', effectId, operationId, attempt: attemptNumber });
    return false;
  }

  async function poll(): Promise<number> {
    if (polling) {
      pollQueued = true;
      return 0;
    }
    polling = true;
    let terminals = 0;
    try {
      const claimed = await store.claim(EFFECT_WORK_CLASS, instanceId, {
        batchSize,
        leaseMs: config.leaseDurationMs,
      });
      const outcomes = await Promise.all(claimed.map((claim) => runClaim(claim)));
      terminals = outcomes.filter(Boolean).length;
    } finally {
      polling = false;
    }
    if (pollQueued) {
      pollQueued = false;
      return terminals + (await poll());
    }
    return terminals;
  }

  let loopTimer: { cancel(): void } | undefined;
  function scheduleLoop(): void {
    loopTimer = undefined;
    if (!running) {
      return;
    }
    loopTimer = host.scheduleOnce(config.pollIntervalMs, () => {
      void poll().finally(scheduleLoop);
    });
  }

  return {
    dispatch(records: EffectRecord[]): void {
      for (const record of records) {
        const payload: EffectRecord = {
          ...record,
          // spec12 §16: the application never invents a distributed execution id — absent an
          // author-declared key, the logical effect id is the idempotency key.
          idempotencyKey: record.idempotencyKey ?? record.id,
        };
        void store.enqueue({ workClass: EFFECT_WORK_CLASS, workId: record.id, payload });
      }
    },
    poll,
    start(): void {
      if (running) return;
      running = true;
      scheduleLoop();
    },
    async stop(): Promise<void> {
      // Stop scheduling new polls immediately, and stop renewing the lease behind any attempt
      // still in flight (e.g. a hung adapter call) — that attempt is left detached, its lease
      // expires, and another authority reclaims it. `stop()` never blocks on it (spec12 §66).
      running = false;
      loopTimer?.cancel();
      loopTimer = undefined;
      for (const cancelHeartbeat of [...activeHeartbeats]) cancelHeartbeat();
    },
  };
}

// -------------------------------------------------------------------- explainability

/**
 * The provider-independent, machine-readable answer to spec12 §57: given one effect work
 * item (and the lease over its resource, if any), what does an agent need to know?
 *
 * It separates the four things §56 says must never be conflated: the **semantic guarantee**
 * (`deliveryGuarantee`), the **current runtime state** (`state`, `owner`, `reclaimable`),
 * the **provider capability** (folded into `physicalExecution` via `providerIdempotent`),
 * and **operational tuning** (`nextEligibleAt`, which a poll cadence only observes).
 */
export interface EffectDeliveryExplanation {
  effectId: string;
  state: DurableWorkState;
  /** Physical attempts started so far. */
  attemptNumber: number;
  /** Attempts whose outcome was never recorded — a positive value means at-least-once may have delivered more than once (spec12 §70). */
  uncertainAttempts: number;
  /** The live owner of the active attempt, or `null` if unclaimed / lease expired. */
  owner: { ownerId: AuthorityInstanceId; generation: number; expiresAt: number } | null;
  /** The highest generation ever issued for this item, or `null` if never claimed. */
  currentGeneration: number | null;
  /**
   * A previous owner's claim can be taken over now — the item was claimed, its lease is not
   * live, and any backoff has elapsed. `false` for a never-claimed `pending` item (that is
   * simply claimable) and for a `retry` item whose owner was already cleared.
   */
  reclaimable: boolean;
  /** Why the item is or is not runnable right now. */
  runnable: 'runnable' | 'in-progress' | 'backing-off' | 'terminal';
  /** Earliest wall-clock time a claim will succeed (retry backoff). */
  nextEligibleAt: number;
  /** What happens to this item if the current owner crashes — in plain, provider-free terms. */
  ifOwnerCrashes: string;
  deliveryGuarantee: {
    logicalCreation: 'exactly-once';
    physicalExecution: 'at-least-once' | 'exactly-once-if-provider-idempotent';
    completionTransition: 'exactly-once';
  };
}

export function explainEffectDelivery(
  item: DurableWorkItem,
  lease: Lease | null,
  now: number,
  options: { providerIdempotent?: boolean } = {},
): EffectDeliveryExplanation {
  const leaseLive = lease !== null && lease.expiresAt > now;
  const owner = leaseLive
    ? { ownerId: lease.ownerId, generation: lease.generation, expiresAt: lease.expiresAt }
    : null;
  const terminal = isTerminalWorkState(item.state);
  const backingOff = !terminal && item.nextEligibleAt > now;

  const runnable: EffectDeliveryExplanation['runnable'] = terminal
    ? 'terminal'
    : item.state === 'claimed' && leaseLive
      ? 'in-progress'
      : backingOff
        ? 'backing-off'
        : 'runnable';

  return {
    effectId: item.workId,
    state: item.state,
    attemptNumber: item.attemptNumber,
    uncertainAttempts: item.uncertainAttempts,
    owner,
    currentGeneration: item.ownerGeneration ?? (item.attemptNumber > 0 ? item.attemptNumber : null),
    reclaimable:
      !terminal && item.ownerGeneration !== null && !leaseLive && item.nextEligibleAt <= now,
    runnable,
    nextEligibleAt: item.nextEligibleAt,
    ifOwnerCrashes: terminal
      ? 'Nothing: the effect has reached a durable terminal state and will not run again.'
      : 'The lease expires, any healthy compatible authority reclaims the item under a higher generation, ' +
        'and retries it with the same idempotency key. The crashed owner cannot commit a completion afterwards.',
    deliveryGuarantee: {
      logicalCreation: 'exactly-once',
      physicalExecution: options.providerIdempotent
        ? 'exactly-once-if-provider-idempotent'
        : 'at-least-once',
      completionTransition: 'exactly-once',
    },
  };
}
