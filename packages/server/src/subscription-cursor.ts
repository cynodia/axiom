/**
 * Multi-authority subscription ownership and cursor fencing (spec12 §27-§31, §75).
 *
 * A `SubscriptionDef` has three separable things (spec12 §27):
 *
 * - the **semantic subscription** — durable, one per graph;
 * - the **physical client connection** — belongs to whichever authority the client reached,
 *   and may drop independently;
 * - the **delivery cursor** — a durable per-subscription position, owned by exactly one
 *   authority at a time.
 *
 * This module owns the third. Ownership is a fenced coordination lease (Phase 1-4); the
 * cursor position is a durable monotonic integer guarded so that:
 *
 * - **advancement is fenced** (spec12 §30, §75, release-blocking) — a write carries the
 *   generation its owner was claimed under; a write whose generation is not at least the
 *   stored writer generation is rejected (`fenced`). A stalled owner that resumes after
 *   another authority took over can never move the cursor.
 * - **the cursor never regresses** (spec12 §28) — a write with `toSequence` below the stored
 *   sequence is rejected (`stale-sequence`), even from the current owner.
 * - **reconnect follows the durable cursor, not process memory** (spec12 §31) — a new
 *   authority `acquire`s ownership and is handed the durable position to resume from.
 *
 * ### Ordering (spec12 §29)
 *
 * The only ordering guarantee is **per subscription**: `sequence` is monotonic within one
 * `subscriptionId`. There is deliberately **no** ordering across subscriptions, and none is
 * implied between a subscription and any other event source. {@link subscriptionOrderingGuarantee}
 * states this in machine-readable form.
 */

import {
  coordinationResourceId,
  type AuthorityInstanceId,
  type CoordinationProvider,
  type FencingGeneration,
} from './coordination.js';

export const SUBSCRIPTION_CURSOR_RESOURCE_KIND = 'subscription-cursor';

/** The durable per-subscription cursor row. */
export interface SubscriptionCursor {
  subscriptionId: string;
  /** Last delivered position — monotonic within this subscription only (spec12 §29). */
  sequence: number;
  /** The generation of the authority that last advanced the cursor. Fencing floor (spec12 §30). */
  writerGeneration: FencingGeneration;
  updatedAt: number;
}

/**
 * Durable storage for cursor positions. The conditional advance is where fencing +
 * monotonicity live, applied atomically with the write (memory + SQLite parity, spec12 §63).
 */
export interface CursorPositionStore {
  read(subscriptionId: string): Promise<SubscriptionCursor | null>;
  /**
   * Set the cursor to `toSequence` for `subscriptionId`, recording `generation` as the new
   * writer generation. Applies only if `generation >= storedWriterGeneration` **and**
   * `toSequence >= storedSequence` (upsert when there is no row). Returns whether it applied.
   */
  advanceConditional(
    subscriptionId: string,
    generation: FencingGeneration,
    toSequence: number,
    at: number,
  ): Promise<boolean>;
  list(limit: number): Promise<SubscriptionCursor[]>;
  close?(): Promise<void>;
}

export interface SubscriptionOwnership {
  subscriptionId: string;
  ownerId: AuthorityInstanceId;
  /** Fencing generation for this ownership term; strictly greater than any prior term's. */
  generation: FencingGeneration;
  /** Present to `renew` / `release`. */
  token: string;
  leaseExpiresAt: number;
  /** The durable position to resume delivery from (spec12 §31). */
  resumeFrom: number;
}

export type AcquireCursorResult =
  | { ok: true; ownership: SubscriptionOwnership }
  | { ok: false; heldBy: { ownerId: AuthorityInstanceId; generation: FencingGeneration; leaseExpiresAt: number } };

export type CursorAdvanceResult =
  | { ok: true; sequence: number }
  | { ok: false; reason: 'fenced' | 'stale-sequence' | 'not-owner' | 'unknown-subscription' };

export interface SubscriptionCursorStore {
  /**
   * Take delivery ownership of `subscriptionId`. Succeeds when unowned or the current lease
   * has expired; a live foreign lease blocks with `heldBy`. A successful acquire over an
   * expired one mints a strictly greater `generation` (spec12 §9).
   */
  acquire(
    subscriptionId: string,
    ownerId: AuthorityInstanceId,
    leaseMs: number,
  ): Promise<AcquireCursorResult>;
  renew(subscriptionId: string, token: string, leaseMs: number): Promise<boolean>;
  release(subscriptionId: string, token: string): Promise<void>;
  /**
   * Move the cursor forward. Fenced on `generation` and monotonic on `toSequence`
   * (spec12 §30). A stalled prior owner is rejected `fenced`; a backward move is
   * `stale-sequence`.
   */
  advance(
    subscriptionId: string,
    ownerId: AuthorityInstanceId,
    generation: FencingGeneration,
    toSequence: number,
  ): Promise<CursorAdvanceResult>;
  read(subscriptionId: string): Promise<SubscriptionCursor | null>;
  list(limit?: number): Promise<SubscriptionCursor[]>;
}

export interface SubscriptionCursorStoreOptions {
  coordination: CoordinationProvider;
  positions: CursorPositionStore;
  now?: () => number;
}

const RESOURCE = (subscriptionId: string): string =>
  coordinationResourceId(SUBSCRIPTION_CURSOR_RESOURCE_KIND, subscriptionId);

export function createSubscriptionCursorStore(
  options: SubscriptionCursorStoreOptions,
): SubscriptionCursorStore {
  const { coordination, positions } = options;
  const now = options.now ?? (() => Date.now());

  return {
    async acquire(subscriptionId, ownerId, leaseMs) {
      const acquired = await coordination.acquire(RESOURCE(subscriptionId), ownerId, leaseMs);
      if (!acquired.ok || !acquired.lease) {
        const held = acquired.heldBy;
        return {
          ok: false,
          heldBy: held
            ? { ownerId: held.ownerId, generation: held.generation, leaseExpiresAt: held.expiresAt }
            : { ownerId: 'unknown', generation: 0, leaseExpiresAt: 0 },
        };
      }
      const cursor = await positions.read(subscriptionId);
      return {
        ok: true,
        ownership: {
          subscriptionId,
          ownerId,
          generation: acquired.lease.generation,
          token: acquired.lease.token,
          leaseExpiresAt: acquired.lease.expiresAt,
          resumeFrom: cursor?.sequence ?? 0,
        },
      };
    },

    async renew(subscriptionId, token, leaseMs) {
      return coordination.renew(RESOURCE(subscriptionId), token, leaseMs);
    },

    async release(subscriptionId, token) {
      await coordination.release(RESOURCE(subscriptionId), token);
    },

    async advance(subscriptionId, ownerId, generation, toSequence) {
      // The durable conditional write is the fence: it applies only if `generation` is at
      // least the stored writer generation and `toSequence` does not regress. The ownership
      // check is a secondary read purely to classify the failure for observability.
      const applied = await positions.advanceConditional(subscriptionId, generation, toSequence, now());
      if (applied) {
        return { ok: true, sequence: toSequence };
      }
      const current = await positions.read(subscriptionId);
      if (current && generation < current.writerGeneration) {
        return { ok: false, reason: 'fenced' };
      }
      if (current && toSequence < current.sequence) {
        return { ok: false, reason: 'stale-sequence' };
      }
      const ownership = await coordination.checkOwnership(RESOURCE(subscriptionId), ownerId, generation);
      if (ownership.reason === 'fenced') {
        return { ok: false, reason: 'fenced' };
      }
      if (!ownership.current) {
        return { ok: false, reason: 'not-owner' };
      }
      return { ok: false, reason: current ? 'stale-sequence' : 'unknown-subscription' };
    },

    async read(subscriptionId) {
      return positions.read(subscriptionId);
    },

    async list(limit = 100) {
      return positions.list(limit);
    },
  };
}

/** The machine-readable ordering guarantee for a subscription (spec12 §29). */
export interface SubscriptionOrderingGuarantee {
  scope: 'per-subscription';
  monotonicField: 'sequence';
  acrossSubscriptions: 'none';
  acrossEventSources: 'none';
  deliveryGuarantee: 'at-least-once';
  duplicateDeliveryPossible: true;
}

export function subscriptionOrderingGuarantee(): SubscriptionOrderingGuarantee {
  return {
    scope: 'per-subscription',
    monotonicField: 'sequence',
    acrossSubscriptions: 'none',
    acrossEventSources: 'none',
    deliveryGuarantee: 'at-least-once',
    duplicateDeliveryPossible: true,
  };
}

// ------------------------------------------------------------------- memory reference

export function createMemoryCursorPositionStore(): CursorPositionStore {
  const rows = new Map<string, SubscriptionCursor>();
  return {
    async read(subscriptionId) {
      const row = rows.get(subscriptionId);
      return row ? { ...row } : null;
    },
    async advanceConditional(subscriptionId, generation, toSequence, at) {
      const row = rows.get(subscriptionId);
      if (row && (generation < row.writerGeneration || toSequence < row.sequence)) {
        return false;
      }
      rows.set(subscriptionId, {
        subscriptionId,
        sequence: toSequence,
        writerGeneration: generation,
        updatedAt: at,
      });
      return true;
    },
    async list(limit) {
      return [...rows.values()]
        .sort((a, b) => (a.subscriptionId < b.subscriptionId ? -1 : 1))
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
  };
}
