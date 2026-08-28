/**
 * Distributed authority: the durable work-identity + claim state machine (spec12 §7, §14).
 *
 * Every class of framework-owned asynchronous work — transactional-outbox effects, scheduled
 * trigger firings, subscription cursors — is the *same shape*: a durable item that is
 * created once by committed application execution, claimed by exactly one authority at a
 * time, attempted physically one or more times, and finally transitioned to a durable
 * terminal (or retry) state exactly once. This module is that shape, factored out so the
 * effect runner, the scheduler and the subscription layer do not each reinvent leasing,
 * fencing and crash recovery.
 *
 * The spec12 §7 canonical model, made concrete:
 *
 * ```
 *   enqueue            → state 'pending'      (exactly-once logical creation, §14/§15)
 *   claim              → state 'claimed'      (lease acquired, fresh generation minted)
 *   settle 'retry'     → state 'retry'        (durable retry state, §19; lease released)
 *   settle 'succeeded' → state 'succeeded'    (exactly-once durable completion, §15)
 *   settle 'failed'    → state 'failed'       (terminal; §20 terminal-failure meaning)
 * ```
 *
 * ### Logical effect vs physical attempt (spec12 §14)
 *
 * `workId` is the **stable logical identity** — for an effect it is the `logicalEffectId`,
 * for a schedule firing it is `scheduleId:dueInstant`. It never changes across retries.
 * `attemptNumber` counts **physical attempts** and is incremented on every `claim`.
 * `ownerGeneration` is the fencing token from the {@link CoordinationProvider} the claim was
 * taken under.
 *
 * ### Completion fencing (spec12 §9, §18, §68 — release-blocking)
 *
 * `settle` is a **conditional write**: it commits only if the row is still `claimed` by the
 * exact `(ownerId, generation)` presented. The reclaim path mints a strictly greater
 * `generation`, so a paused owner that wakes after its lease moved on carries a stale
 * generation and its `settle` is rejected with `reason: 'fenced'` — it can never overwrite
 * the newer owner's completion or retry state.
 *
 * The state machine here is provider-independent plain data (spec12 §95, §96). The durable
 * storage of the rows is a {@link DurableWorkStorage}; the memory reference lives in this
 * file, the SQLite cross-process one in `sqlite-durable-work.ts`.
 */

import {
  DEFAULT_LEASE_DURATION_MS,
  coordinationResourceId,
  type AuthorityInstanceId,
  type CoordinationProvider,
  type FencingGeneration,
} from './coordination.js';

// ------------------------------------------------------------------------------ model

export const DURABLE_WORK_STATES = ['pending', 'claimed', 'retry', 'succeeded', 'failed'] as const;
export type DurableWorkState = (typeof DURABLE_WORK_STATES)[number];

/** The two states from which no further work happens. */
export function isTerminalWorkState(state: DurableWorkState): boolean {
  return state === 'succeeded' || state === 'failed';
}

export interface DurableWorkError {
  code: string;
  message: string;
  /** The graph-owned retry classification, carried through untouched (spec12 §20). */
  retryable?: boolean;
}

/**
 * One durable unit of framework-owned asynchronous work.
 *
 * `payload` is opaque to this layer — the effect runner stores `{ operationId, arguments,
 * idempotencyKey }`, the scheduler stores `{ scheduleId, dueInstant, triggerId }`. It must
 * be JSON-serializable (spec12 §95).
 */
export interface DurableWorkItem {
  workClass: string;
  /** Stable logical identity. Unique within `workClass`. Never changes across retries. */
  workId: string;
  state: DurableWorkState;
  /** Physical attempts made so far. `0` while `pending`; incremented by every `claim`. */
  attemptNumber: number;
  /**
   * How many physical attempts were started under a since-fenced generation and whose
   * outcome was **never durably recorded** — the uncertain-outcome count (spec12 §70). It
   * rises only when a `claim` reclaims a row that was still `claimed` (an in-flight attempt
   * whose owner crashed or lost its lease mid-call). It never decreases; a positive value
   * means "at least one earlier attempt may or may not have reached the external system".
   */
  uncertainAttempts: number;
  /** The authority that currently holds the active attempt, or `null`. */
  ownerId: AuthorityInstanceId | null;
  /** The fencing generation the current claim was taken under, or `null`. */
  ownerGeneration: FencingGeneration | null;
  /** Wall-clock time the most recent physical attempt was claimed (spec12 §19). `null` before the first. */
  lastAttemptAt: number | null;
  /** Earliest wall-clock time this item may be claimed — retry backoff lives here (spec12 §19). */
  nextEligibleAt: number;
  payload: unknown;
  lastError: DurableWorkError | null;
  /** The adapter's returned value once `state` is `'succeeded'`. */
  result: unknown;
  /**
   * The compatibility identity of the authority build that created this work (spec12 §43,
   * §45). Opaque here — Phase 11 defines its structure; an incompatible claimer refuses the
   * item with `INCOMPATIBLE_AUTHORITY` rather than executing it. `null` until Phase 11 wires
   * it through.
   */
  compatibilityKey: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A `DurableWorkItem` plus whether an authority is provably working it right now. */
export interface DurableWorkItemView extends DurableWorkItem {
  /** A live coordination lease exists over this item's resource. */
  leaseLive: boolean;
}

// ---------------------------------------------------------------------------- storage

/**
 * Durable row storage for the work state machine. Every method is a single atomic step; the
 * conditional ones return whether they changed a row, which is how {@link DurableWorkStore}
 * enforces fencing without a transaction spanning the coordination provider.
 *
 * An implementation MUST guarantee: `insert` is idempotent on `(workClass, workId)`;
 * `markClaimed`, `settleConditional` and `releaseConditional` apply atomically or not at
 * all; `selectClaimable` never returns a terminal row.
 */
export interface DurableWorkStorage {
  /** Create a `pending` row. Returns `false` (and does not touch the existing row) if `(workClass, workId)` already exists. */
  insert(item: DurableWorkItem): Promise<boolean>;

  get(workClass: string, workId: string): Promise<DurableWorkItem | null>;

  /**
   * Non-terminal rows whose `nextEligibleAt <= at`, most-claimable first: fresh
   * (`pending`/`retry`) work before rows already `claimed` by someone, then FIFO by
   * `createdAt`, `workId` (spec12 §50 fairness). Bounded by `limit`.
   */
  selectClaimable(workClass: string, at: number, limit: number): Promise<DurableWorkItem[]>;

  /**
   * Transition a row to `claimed` by `(ownerId, generation)` and increment `attemptNumber`.
   * Conditional: applies only to a non-terminal row whose `ownerGeneration` is null or
   * strictly less than `generation` (so a stale reclaim cannot regress ownership). Returns
   * the updated row, or `null` if the condition did not hold.
   */
  markClaimed(
    workClass: string,
    workId: string,
    ownerId: AuthorityInstanceId,
    generation: FencingGeneration,
    at: number,
  ): Promise<DurableWorkItem | null>;

  /**
   * The fenced completion write (spec12 §18). Applies only to a row that is still `claimed`
   * by exactly `(ownerId, generation)`. Returns whether it applied.
   */
  settleConditional(
    workClass: string,
    workId: string,
    ownerId: AuthorityInstanceId,
    generation: FencingGeneration,
    patch: SettlePatch,
    at: number,
  ): Promise<boolean>;

  /**
   * Voluntary hand-back (graceful shutdown). Applies only to a row still `claimed` by
   * `(ownerId, generation)`; moves it to `retry`, eligible at `at`, owner cleared. Returns
   * whether it applied.
   */
  releaseConditional(
    workClass: string,
    workId: string,
    ownerId: AuthorityInstanceId,
    generation: FencingGeneration,
    at: number,
  ): Promise<boolean>;

  /** Bounded observability listing (spec12 §55). Newest activity first is not required; `createdAt` order is fine. */
  list(workClass: string, limit: number): Promise<DurableWorkItem[]>;

  close?(): Promise<void>;
}

/** The mutation `settleConditional` applies, already reduced to plain fields. */
export interface SettlePatch {
  state: 'retry' | 'succeeded' | 'failed';
  lastError: DurableWorkError | null;
  result: unknown;
  /** New backoff floor for `retry`; ignored for terminal states. */
  nextEligibleAt: number;
}

// ------------------------------------------------------------------------------ store

export interface DurableWorkStoreOptions {
  coordination: CoordinationProvider;
  storage: DurableWorkStorage;
  /** Deterministic clock. Defaults to `Date.now`; conformance and tests inject a fake. */
  now?: () => number;
  /** Lease window for a claim, unless overridden per `claim` call. */
  defaultLeaseMs?: number;
  /**
   * This authority's compatibility identity (spec12 §43-§45). When set: `enqueue` stamps it
   * onto new work, and `claim` **refuses** any item whose stored key is non-null and differs
   * — an incompatible / older build never executes new-schema work (spec12 §44, §47). The
   * refused item stays claimable by a compatible authority; {@link DurableWorkStore.listIncompatible}
   * makes it observable.
   */
  authorityKey?: string;
}

export interface EnqueueInput {
  workClass: string;
  workId: string;
  payload: unknown;
  /** Delay first eligibility past creation time. Defaults to "immediately". */
  nextEligibleAt?: number;
  compatibilityKey?: string | null;
}

export interface ClaimOptions {
  batchSize?: number;
  leaseMs?: number;
}

/** A claim handle. `token` is kept in memory by the working authority for renew/release. */
export interface ClaimedWork {
  item: DurableWorkItem;
  ownerId: AuthorityInstanceId;
  generation: FencingGeneration;
  token: string;
  resourceId: string;
}

export type SettleOutcome =
  | { kind: 'succeeded'; result?: unknown }
  | { kind: 'failed'; error: DurableWorkError }
  | { kind: 'retry'; error: DurableWorkError; nextEligibleAt: number };

export type SettleResult =
  | { ok: true; item: DurableWorkItem }
  | { ok: false; reason: 'fenced' | 'unknown-work' | 'already-terminal' | 'not-claimed' };

/**
 * The claim state machine. It composes a {@link CoordinationProvider} (lease + fencing
 * generation) with a {@link DurableWorkStorage} (the durable row) and exposes the five
 * operations every work class needs: `enqueue`, `claim`, `renew`, `settle`, `release`.
 */
export interface DurableWorkStore {
  /**
   * Create the durable work item, or return the existing one untouched — exactly-once
   * logical creation keyed by `(workClass, workId)` (spec12 §14, §15). A retry never calls
   * this; it re-`claim`s the same `workId`.
   */
  enqueue(input: EnqueueInput): Promise<{ created: boolean; item: DurableWorkItem }>;

  /**
   * Claim up to `batchSize` eligible items of `workClass` for `ownerId`. For each candidate
   * an atomic coordination `acquire` decides ownership: a live lease held by another
   * authority means "skip" (`WORK_IN_PROGRESS`), an expired one is reclaimed under a fresh,
   * strictly-greater `generation`. Returns only the items actually won.
   */
  claim(workClass: string, ownerId: AuthorityInstanceId, options?: ClaimOptions): Promise<ClaimedWork[]>;

  /**
   * Claim one named work item, if it is eligible and this authority may execute it. Returns
   * `null` when it is held by a live lease elsewhere, terminal, backing off, or stamped for a
   * different build. Used where the caller already knows exactly which item it wants (a
   * scheduled firing keyed by `scheduleId@dueInstant`).
   */
  claimOne(
    workClass: string,
    workId: string,
    ownerId: AuthorityInstanceId,
    options?: ClaimOptions,
  ): Promise<ClaimedWork | null>;

  /** Heartbeat the lease behind a held claim. `false` means ownership has already moved. */
  renew(claim: ClaimedWork, leaseMs?: number): Promise<boolean>;

  /**
   * The fenced completion transition (spec12 §18). Commits only while `claim` is still the
   * current owner; a stale generation is rejected with `reason: 'fenced'` and cannot
   * overwrite a newer owner's state. Releases the lease on success.
   */
  settle(claim: ClaimedWork, outcome: SettleOutcome): Promise<SettleResult>;

  /** Voluntarily return a held claim to the queue (graceful shutdown). Fenced like `settle`. */
  release(claim: ClaimedWork): Promise<boolean>;

  get(workClass: string, workId: string): Promise<DurableWorkItem | null>;

  /** Bounded listing joined with live-lease observation (spec12 §55, §57). */
  list(workClass: string, limit?: number): Promise<DurableWorkItemView[]>;

  /**
   * Non-terminal items this authority cannot execute because their stamped compatibility key
   * differs from `authorityKey` (spec12 §44, §47, §55). Empty when no `authorityKey` is set.
   */
  listIncompatible(workClass: string, limit?: number): Promise<DurableWorkItem[]>;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_LIST_LIMIT = 100;

export function createDurableWorkStore(options: DurableWorkStoreOptions): DurableWorkStore {
  const { coordination, storage } = options;
  const now = options.now ?? (() => Date.now());
  const defaultLeaseMs = options.defaultLeaseMs ?? DEFAULT_LEASE_DURATION_MS;
  const authorityKey = options.authorityKey;

  /** This authority may execute an item iff the item carries no key, or the same key. */
  const executable = (item: { compatibilityKey: string | null }): boolean =>
    authorityKey === undefined ||
    item.compatibilityKey === null ||
    item.compatibilityKey === authorityKey;

  const resourceIdFor = (workClass: string, workId: string): string =>
    coordinationResourceId(workClass, workId);

  return {
    async enqueue(input) {
      const existing = await storage.get(input.workClass, input.workId);
      if (existing) {
        return { created: false, item: existing };
      }
      const at = now();
      const item: DurableWorkItem = {
        workClass: input.workClass,
        workId: input.workId,
        state: 'pending',
        attemptNumber: 0,
        uncertainAttempts: 0,
        ownerId: null,
        ownerGeneration: null,
        lastAttemptAt: null,
        nextEligibleAt: input.nextEligibleAt ?? at,
        payload: input.payload,
        lastError: null,
        result: undefined,
        compatibilityKey: input.compatibilityKey ?? authorityKey ?? null,
        createdAt: at,
        updatedAt: at,
      };
      const created = await storage.insert(item);
      if (created) {
        return { created: true, item };
      }
      // Lost an enqueue race — the row is there now, hand back the winner's copy.
      const raced = await storage.get(input.workClass, input.workId);
      return { created: false, item: raced ?? item };
    },

    async claim(workClass, ownerId, claimOptions) {
      const batchSize = Math.max(1, claimOptions?.batchSize ?? DEFAULT_BATCH_SIZE);
      const leaseMs = claimOptions?.leaseMs ?? defaultLeaseMs;
      const at = now();
      // Over-fetch a little so incompatible items filtered out here do not shrink the batch.
      const raw = await storage.selectClaimable(workClass, at, batchSize * 2);
      const candidates = raw.filter(executable).slice(0, batchSize);
      const claimed: ClaimedWork[] = [];

      for (const candidate of candidates) {
        const resourceId = resourceIdFor(workClass, candidate.workId);
        const acquired = await coordination.acquire(resourceId, ownerId, leaseMs);
        if (!acquired.ok || !acquired.lease) {
          // A live claim is held by another authority right now (spec12 §17).
          continue;
        }
        const generation = acquired.lease.generation;
        const marked = await storage.markClaimed(workClass, candidate.workId, ownerId, generation, now());
        if (!marked) {
          // The row went terminal (or was regraded) between select and claim — release the
          // lease we just took so it does not sit held over finished work.
          await coordination.release(resourceId, acquired.lease.token);
          continue;
        }
        claimed.push({ item: marked, ownerId, generation, token: acquired.lease.token, resourceId });
      }
      return claimed;
    },

    async claimOne(workClass, workId, ownerId, claimOptions) {
      const leaseMs = claimOptions?.leaseMs ?? defaultLeaseMs;
      const item = await storage.get(workClass, workId);
      if (!item || isTerminalWorkState(item.state) || item.nextEligibleAt > now() || !executable(item)) {
        return null;
      }
      const resourceId = resourceIdFor(workClass, workId);
      const acquired = await coordination.acquire(resourceId, ownerId, leaseMs);
      if (!acquired.ok || !acquired.lease) {
        return null;
      }
      const generation = acquired.lease.generation;
      const marked = await storage.markClaimed(workClass, workId, ownerId, generation, now());
      if (!marked) {
        await coordination.release(resourceId, acquired.lease.token);
        return null;
      }
      return { item: marked, ownerId, generation, token: acquired.lease.token, resourceId };
    },

    async renew(claim, leaseMs) {
      return coordination.renew(claim.resourceId, claim.token, leaseMs ?? defaultLeaseMs);
    },

    async settle(claim, outcome) {
      const at = now();
      const patch: SettlePatch =
        outcome.kind === 'succeeded'
          ? { state: 'succeeded', lastError: null, result: outcome.result, nextEligibleAt: at }
          : outcome.kind === 'failed'
            ? { state: 'failed', lastError: outcome.error, result: undefined, nextEligibleAt: at }
            : {
                state: 'retry',
                lastError: outcome.error,
                result: undefined,
                nextEligibleAt: outcome.nextEligibleAt,
              };

      const applied = await storage.settleConditional(
        claim.item.workClass,
        claim.item.workId,
        claim.ownerId,
        claim.generation,
        patch,
        at,
      );

      if (applied) {
        // The completion is durable; the lease has no more purpose. Releasing keeps
        // `list()` honest — it does not rewind the fencing generation (spec12 §9).
        await coordination.release(claim.resourceId, claim.token);
        const item = await storage.get(claim.item.workClass, claim.item.workId);
        return { ok: true, item: item ?? { ...claim.item, ...patch, updatedAt: at } };
      }

      const current = await storage.get(claim.item.workClass, claim.item.workId);
      if (!current) {
        return { ok: false, reason: 'unknown-work' };
      }
      if (isTerminalWorkState(current.state)) {
        return { ok: false, reason: 'already-terminal' };
      }
      if (current.ownerGeneration !== null && current.ownerGeneration > claim.generation) {
        // A newer owner exists; this claim is stale and must not overwrite it (spec12 §18).
        return { ok: false, reason: 'fenced' };
      }
      return { ok: false, reason: 'not-claimed' };
    },

    async release(claim) {
      const at = now();
      const applied = await storage.releaseConditional(
        claim.item.workClass,
        claim.item.workId,
        claim.ownerId,
        claim.generation,
        at,
      );
      await coordination.release(claim.resourceId, claim.token);
      return applied;
    },

    async get(workClass, workId) {
      return storage.get(workClass, workId);
    },

    async list(workClass, limit) {
      const rows = await storage.list(workClass, limit ?? DEFAULT_LIST_LIMIT);
      const leases = await coordination.list(`${workClass}:`);
      const live = new Set(leases.filter((lease) => lease.live).map((lease) => lease.resourceId));
      return rows.map((row) => ({
        ...row,
        leaseLive: live.has(resourceIdFor(workClass, row.workId)),
      }));
    },

    async listIncompatible(workClass, limit) {
      if (authorityKey === undefined) {
        return [];
      }
      const rows = await storage.list(workClass, limit ?? DEFAULT_LIST_LIMIT);
      return rows.filter((row) => !isTerminalWorkState(row.state) && !executable(row));
    },
  };
}

// ------------------------------------------------------------------- memory reference

/**
 * Deterministic in-memory {@link DurableWorkStorage} (spec12 §63). A full semantic
 * reference — every conditional transition behaves exactly as the SQLite one — with no
 * cross-process durability of its own.
 */
export function createMemoryDurableWorkStorage(): DurableWorkStorage {
  const rows = new Map<string, DurableWorkItem>();
  const key = (workClass: string, workId: string): string => `${workClass} ${workId}`;
  const clone = (item: DurableWorkItem): DurableWorkItem => ({
    ...item,
    lastError: item.lastError ? { ...item.lastError } : null,
    payload: structuredClone(item.payload),
    result: structuredClone(item.result),
  });

  return {
    async insert(item) {
      const k = key(item.workClass, item.workId);
      if (rows.has(k)) {
        return false;
      }
      rows.set(k, clone(item));
      return true;
    },

    async get(workClass, workId) {
      const found = rows.get(key(workClass, workId));
      return found ? clone(found) : null;
    },

    async selectClaimable(workClass, at, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.workClass === workClass &&
            !isTerminalWorkState(row.state) &&
            row.nextEligibleAt <= at,
        )
        .sort((a, b) => {
          const freshA = a.state === 'claimed' ? 1 : 0;
          const freshB = b.state === 'claimed' ? 1 : 0;
          if (freshA !== freshB) return freshA - freshB;
          if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
          return a.workId < b.workId ? -1 : a.workId > b.workId ? 1 : 0;
        })
        .slice(0, limit)
        .map(clone);
    },

    async markClaimed(workClass, workId, ownerId, generation, at) {
      const k = key(workClass, workId);
      const row = rows.get(k);
      if (!row || isTerminalWorkState(row.state)) {
        return null;
      }
      if (row.ownerGeneration !== null && row.ownerGeneration >= generation) {
        return null;
      }
      // Reclaiming a row that is still `claimed` means an in-flight attempt is being stolen
      // from a crashed / lease-lapsed owner: its outcome is unknown (spec12 §70).
      const stoleInFlight = row.state === 'claimed';
      const updated: DurableWorkItem = {
        ...row,
        state: 'claimed',
        attemptNumber: row.attemptNumber + 1,
        uncertainAttempts: row.uncertainAttempts + (stoleInFlight ? 1 : 0),
        ownerId,
        ownerGeneration: generation,
        lastAttemptAt: at,
        updatedAt: at,
      };
      rows.set(k, updated);
      return clone(updated);
    },

    async settleConditional(workClass, workId, ownerId, generation, patch, at) {
      const k = key(workClass, workId);
      const row = rows.get(k);
      if (
        !row ||
        row.state !== 'claimed' ||
        row.ownerId !== ownerId ||
        row.ownerGeneration !== generation
      ) {
        return false;
      }
      const terminal = patch.state === 'succeeded' || patch.state === 'failed';
      rows.set(k, {
        ...row,
        state: patch.state,
        lastError: patch.lastError ? { ...patch.lastError } : null,
        result: patch.state === 'succeeded' ? structuredClone(patch.result) : undefined,
        nextEligibleAt: terminal ? row.nextEligibleAt : patch.nextEligibleAt,
        ownerId: null,
        ownerGeneration: null,
        updatedAt: at,
      });
      return true;
    },

    async releaseConditional(workClass, workId, ownerId, generation, at) {
      const k = key(workClass, workId);
      const row = rows.get(k);
      if (
        !row ||
        row.state !== 'claimed' ||
        row.ownerId !== ownerId ||
        row.ownerGeneration !== generation
      ) {
        return false;
      }
      rows.set(k, {
        ...row,
        state: 'retry',
        nextEligibleAt: at,
        ownerId: null,
        ownerGeneration: null,
        updatedAt: at,
      });
      return true;
    },

    async list(workClass, limit) {
      return [...rows.values()]
        .filter((row) => row.workClass === workClass)
        .sort((a, b) => a.createdAt - b.createdAt || (a.workId < b.workId ? -1 : 1))
        .slice(0, limit)
        .map(clone);
    },
  };
}
