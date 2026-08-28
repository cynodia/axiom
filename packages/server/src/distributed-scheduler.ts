/**
 * The multi-authority scheduler (spec12 §21-§24).
 *
 * A scheduled trigger (`interval` / `delay`) fires on a host timer, and every authority runs
 * its own timers. Without coordination, N authorities would each invoke the action for the
 * same due instant. 0.12 makes each **logical firing** a {@link DurableWorkItem} that
 * exactly one authority claims, runs, and settles under a fencing generation — so N pollers
 * cause one firing, a crash permits reclaim of *the same* firing, and no second firing
 * identity is ever created (spec12 §21, §71, §72).
 *
 * ### Firing identity (spec12 §22)
 *
 * `workId = "<scheduleId>@<dueInstant>"`. `dueInstant` is a wall-clock millisecond that
 * every authority derives identically:
 *
 * - `interval` — epoch-aligned: the firing boundaries are the multiples of `everyMs` since
 *   the Unix epoch (`k * everyMs`). Two authorities polling at any offset agree on which
 *   boundaries have passed.
 * - `delay` — the single instant `epoch + afterMs`, where `epoch` is a value shared by every
 *   authority (a durable scheduler epoch; the caller supplies it).
 *
 * Because the id is derived, not minted, `enqueue` is idempotent across authorities and a
 * duplicate is impossible by construction.
 *
 * ### Missed schedules (spec12 §23)
 *
 * `catchUp` decides what happens to boundaries that elapsed while nothing polled:
 * `'latest'` (default) enqueues only the most recent, `'all'` enqueues every missed one
 * (each is a distinct idempotent firing), a number caps how many. Whichever it is, the
 * durable claim lease guarantees a missed firing is caught up by **one** authority, never N.
 * {@link explainScheduleFiring} reports the six §23 states.
 *
 * ### Clock (spec12 §24)
 *
 * Due comparison uses the authority wall clock. It is infrastructure time, never exposed as
 * application semantic time. Safe skew handling is the lease margin
 * (`renewIntervalMs <= leaseDurationMs / 2`); no distributed clock sync is attempted.
 */

import {
  DEFAULT_COORDINATION_CONFIG,
  coordinationResourceId,
  type AuthorityInstanceId,
  type CoordinationConfig,
  type Lease,
} from './coordination.js';
import type { NodeId } from './deps.js';
import {
  isTerminalWorkState,
  type ClaimedWork,
  type DurableWorkItem,
  type DurableWorkStore,
} from './durable-work.js';

export const SCHEDULE_FIRING_WORK_CLASS = 'schedule-firing';

/** The canonical, authority-independent identity of one logical scheduled firing (spec12 §22). */
export function scheduledFiringId(scheduleId: NodeId | string, dueInstant: number): string {
  return `${String(scheduleId)}@${dueInstant}`;
}

/** Parse a firing id back into its parts. */
export function parseScheduledFiringId(workId: string): { scheduleId: string; dueInstant: number } {
  const at = workId.lastIndexOf('@');
  return { scheduleId: workId.slice(0, at), dueInstant: Number(workId.slice(at + 1)) };
}

export type ScheduleSpec =
  | { scheduleId: NodeId | string; kind: 'interval'; everyMs: number }
  | { scheduleId: NodeId | string; kind: 'delay'; afterMs: number };

export type CatchUpPolicy = 'latest' | 'all' | number;

export interface DistributedSchedulerOptions {
  store: DurableWorkStore;
  instanceId: AuthorityInstanceId;
  /**
   * The wall-clock instant (ms) every authority treats as this deployment's scheduler epoch,
   * for `delay` schedules. Must be the same value on every authority — a durable source
   * (spec12 §24). `interval` schedules ignore it (they are Unix-epoch aligned).
   */
  epoch: number;
  now?: () => number;
  config?: Partial<CoordinationConfig>;
  /** What to do with firing boundaries that elapsed while nothing polled (spec12 §23). Default `'latest'`. */
  catchUp?: CatchUpPolicy;
  /**
   * Runs one due firing: invoke the scheduled action for `dueInstant`. Returns whether the
   * invocation was accepted. Never called more than once per `(scheduleId, dueInstant)`
   * across the whole deployment for a successful firing.
   */
  fire(scheduleId: string, dueInstant: number): Promise<{ ok: boolean }>;
  report?(event: {
    kind: 'firing-claimed' | 'firing-succeeded' | 'firing-failed' | 'firing-caught-up';
    scheduleId: string;
    dueInstant: number;
    attempt: number;
  }): void;
}

export interface DistributedScheduler {
  /** Register a schedule so `poll` will produce its firings. Idempotent per `scheduleId`. */
  register(spec: ScheduleSpec): void;
  /**
   * Enqueue every due (and, per `catchUp`, missed) logical firing for the registered
   * schedules, then claim and run the ones this authority wins. Returns how many firings
   * reached a terminal state here. Call it from a host timer and/or a poll loop.
   */
  poll(): Promise<number>;
  /** Registered schedules, for observability. */
  schedules(): ScheduleSpec[];
}

/** Interval firing boundaries in `(from, to]`, epoch-aligned to multiples of `everyMs`. */
export function intervalDueInstants(everyMs: number, from: number, to: number): number[] {
  if (everyMs <= 0) return [];
  const firstK = Math.floor(from / everyMs) + 1;
  const lastK = Math.floor(to / everyMs);
  const out: number[] = [];
  for (let k = firstK; k <= lastK; k += 1) out.push(k * everyMs);
  return out;
}

function applyCatchUp(instants: number[], policy: CatchUpPolicy): number[] {
  if (instants.length <= 1) return instants;
  if (policy === 'all') return instants;
  if (policy === 'latest') return instants.slice(-1);
  const n = Math.max(1, Math.floor(policy));
  return instants.slice(-n);
}

export function createDistributedScheduler(
  options: DistributedSchedulerOptions,
): DistributedScheduler {
  const { store, instanceId, epoch, fire, report } = options;
  const now = options.now ?? (() => Date.now());
  const config: CoordinationConfig = { ...DEFAULT_COORDINATION_CONFIG, ...options.config };
  const catchUp = options.catchUp ?? 'latest';
  const batchSize = Math.max(1, Math.min(config.claimBatchSize, config.workerConcurrency));

  const specs = new Map<string, ScheduleSpec>();
  /** Highest boundary already enqueued per schedule this process, so we do not re-scan history. */
  const scannedThrough = new Map<string, number>();
  let polling = false;

  async function enqueueDue(at: number): Promise<void> {
    for (const spec of specs.values()) {
      const scheduleId = String(spec.scheduleId);
      let instants: number[];
      if (spec.kind === 'interval') {
        const from = scannedThrough.get(scheduleId) ?? at - spec.everyMs; // first poll: only the current boundary
        instants = applyCatchUp(intervalDueInstants(spec.everyMs, from, at), catchUp);
      } else {
        const due = epoch + spec.afterMs;
        instants = due <= at && (scannedThrough.get(scheduleId) ?? -1) < due ? [due] : [];
      }
      for (const dueInstant of instants) {
        const { created } = await store.enqueue({
          workClass: SCHEDULE_FIRING_WORK_CLASS,
          workId: scheduledFiringId(scheduleId, dueInstant),
          payload: { scheduleId, dueInstant },
        });
        if (created && dueInstant < at - 1) {
          report?.({ kind: 'firing-caught-up', scheduleId, dueInstant, attempt: 0 });
        }
      }
      scannedThrough.set(scheduleId, at);
    }
  }

  async function runClaim(claim: ClaimedWork): Promise<boolean> {
    const { scheduleId, dueInstant } = claim.item.payload as { scheduleId: string; dueInstant: number };
    const attempt = claim.item.attemptNumber;
    report?.({ kind: 'firing-claimed', scheduleId, dueInstant, attempt });

    let ok = false;
    try {
      ok = (await fire(scheduleId, dueInstant)).ok;
    } catch {
      ok = false;
    }

    if (ok) {
      const settled = await store.settle(claim, { kind: 'succeeded', result: null });
      if (settled.ok) {
        report?.({ kind: 'firing-succeeded', scheduleId, dueInstant, attempt });
        return true;
      }
      return false; // fenced / already terminal — another authority owns this firing
    }
    // A failed scheduled firing is terminal: there is no graph-owned retry policy for a
    // trigger, and re-running a whole schedule tick later is not "the same" firing.
    const settled = await store.settle(claim, {
      kind: 'failed',
      error: { code: 'SCHEDULED_FIRING_REFUSED', message: `firing ${scheduleId}@${dueInstant} was refused` },
    });
    if (settled.ok) {
      report?.({ kind: 'firing-failed', scheduleId, dueInstant, attempt });
      return true;
    }
    return false;
  }

  return {
    register(spec: ScheduleSpec): void {
      specs.set(String(spec.scheduleId), spec);
    },
    schedules(): ScheduleSpec[] {
      return [...specs.values()];
    },
    async poll(): Promise<number> {
      if (polling) return 0;
      polling = true;
      try {
        await enqueueDue(now());
        const claimed = await store.claim(SCHEDULE_FIRING_WORK_CLASS, instanceId, {
          batchSize,
          leaseMs: config.leaseDurationMs,
        });
        const outcomes = await Promise.all(claimed.map((claim) => runClaim(claim)));
        return outcomes.filter(Boolean).length;
      } finally {
        polling = false;
      }
    },
  };
}

// -------------------------------------------------------------------- explainability

/** The spec12 §23 catch-up state vocabulary for one logical firing. */
export type ScheduleFiringState =
  | 'due'
  | 'late'
  | 'currently-owned'
  | 'expired-owner'
  | 'already-fired'
  | 'terminally-completed';

export interface ScheduleFiringExplanation {
  scheduleId: string;
  dueInstant: number;
  state: ScheduleFiringState;
  attemptNumber: number;
  owner: { ownerId: AuthorityInstanceId; generation: number; expiresAt: number } | null;
  reclaimable: boolean;
  /** How far past `dueInstant` we are now, in ms (0 if not yet due). */
  latenessMs: number;
  ifOwnerCrashes: string;
}

export function explainScheduleFiring(
  item: DurableWorkItem,
  lease: Lease | null,
  now: number,
): ScheduleFiringExplanation {
  const { scheduleId, dueInstant } = item.payload as { scheduleId: string; dueInstant: number };
  const leaseLive = lease !== null && lease.expiresAt > now;
  const latenessMs = Math.max(0, now - dueInstant);

  let state: ScheduleFiringState;
  if (item.state === 'succeeded') {
    state = 'already-fired';
  } else if (item.state === 'failed') {
    state = 'terminally-completed';
  } else if (item.state === 'claimed' && leaseLive) {
    state = 'currently-owned';
  } else if (item.ownerGeneration !== null && !leaseLive) {
    state = 'expired-owner';
  } else {
    state = latenessMs > 0 ? 'late' : 'due';
  }

  return {
    scheduleId,
    dueInstant,
    state,
    attemptNumber: item.attemptNumber,
    owner: leaseLive
      ? { ownerId: lease.ownerId, generation: lease.generation, expiresAt: lease.expiresAt }
      : null,
    reclaimable: !isTerminalWorkState(item.state) && item.ownerGeneration !== null && !leaseLive,
    latenessMs,
    ifOwnerCrashes: isTerminalWorkState(item.state)
      ? 'Nothing: this firing has completed and will not run again.'
      : 'The lease expires and any healthy authority reclaims this same logical firing under a higher ' +
        'generation. No second firing identity is created (spec12 §72).',
  };
}

/** The coordination resource id a firing's lease lives under — for observability joins. */
export function scheduledFiringResourceId(scheduleId: NodeId | string, dueInstant: number): string {
  return coordinationResourceId(SCHEDULE_FIRING_WORK_CLASS, scheduledFiringId(scheduleId, dueInstant));
}
