/**
 * Distributed authority: the one reusable coordination primitive (spec12 §7-§10).
 *
 * Every class of framework-owned asynchronous work — transactional-outbox effects,
 * scheduled trigger firings, subscription delivery cursors — is executed by exactly one
 * authority instance at a time through a **durable, leased, fenced, per-work-item ownership
 * claim**. This module defines that claim (`Lease`), the provider contract that issues and
 * arbitrates it (`CoordinationProvider`), the deterministic in-process reference
 * (`createMemoryCoordinationProvider`), and the host configuration around it.
 *
 * Design rules this file encodes:
 *
 * - **Leaderless** (spec12 §48, §49). There is no global leader. Ownership is per
 *   `resourceId`; any healthy compatible authority may reclaim an expired claim.
 * - **Fencing, not timing** (spec12 §9, §68, §105). Lease expiry authorizes *nothing* — it
 *   only makes a claim reclaimable. Each acquisition mints a strictly-increasing per-resource
 *   `generation`; a stale owner's conditional write carries an old `generation` and is
 *   rejected as `WORK_FENCED`.
 * - **No provider vocabulary leak** (spec12 §12, §87). Nothing here or in a diagnostic says
 *   `SETNX`, `Redlock`, TTL or "conditional write". Those are provider techniques.
 * - **Portable plain data** (spec12 §95, §96). A `Lease` is five scalars plus two ids; a
 *   future non-JS runtime reconstructs it without reverse-engineering Node.
 *
 * The SQLite cross-process implementation lives in `sqlite-coordination.ts`; the durable
 * work state machine that *uses* generations to gate its writes lives in
 * `durable-work.ts`.
 */

// --------------------------------------------------------------------------- identity

/**
 * A runtime identity for one authority process (spec12 §6). Infrastructure metadata only:
 * never application state, never reachable through an `Expression`, never usable for
 * authorization, never part of `schemaFingerprint` or graph identity. Defaults to
 * `host.uuid()` at startup; an explicit `instanceId` host-config override replaces it.
 */
export type AuthorityInstanceId = string;

/**
 * The fencing token (spec12 §9). Strictly increasing per `resourceId`, never reused, and
 * crash-durable. A durable-work mutation associated with owned work must carry the
 * `generation` it was claimed under; the provider/store rejects any mutation whose
 * `generation` is not the current one.
 */
export type FencingGeneration = number;

// ------------------------------------------------------------------------------ lease

/**
 * A held ownership claim over one coordination resource (spec12 §8).
 *
 * `token` is an opaque per-acquisition nonce: it must be presented to `renew` or `release`
 * so those operations are owner-specific even within one `AuthorityInstanceId`. `generation`
 * is the fencing token and is what gates durable-work writes. `acquiredAt` / `expiresAt` are
 * the coordination provider's own wall clock (spec12 §24, §91) — never exposed as
 * application semantic time.
 */
export interface Lease {
  resourceId: string;
  ownerId: AuthorityInstanceId;
  token: string;
  generation: FencingGeneration;
  acquiredAt: number;
  expiresAt: number;
}

/** A lease plus whether its lease window is still open at the moment of inspection. */
export interface LeaseView extends Lease {
  live: boolean;
}

export interface AcquireResult {
  ok: boolean;
  /** The granted claim, when `ok`. */
  lease?: Lease;
  /** The live claim that blocked acquisition, when not `ok`. */
  heldBy?: Lease;
}

/** A machine-readable answer to "may this authority still act on this work?" (spec12 §57). */
export interface OwnershipCheck {
  /** `(ownerId, generation)` is the current live owner. */
  current: boolean;
  /** The live claim as it now stands, or `null` if the resource is unclaimed/expired. */
  lease: Lease | null;
  /**
   * Why `current` is false, when it is:
   * - `expired`   — the presented owner's lease window has closed; another may reclaim.
   * - `fenced`    — a newer `generation` has been issued; the presented one is stale.
   * - `not-owner` — a different authority holds the live claim.
   * - `unknown-resource` — nothing was ever claimed here.
   */
  reason?: 'expired' | 'fenced' | 'not-owner' | 'unknown-resource';
}

// ----------------------------------------------------------------------- capabilities

/**
 * Semantics a `CoordinationProvider` advertises (spec12 §60). A runtime asked for a
 * capability the provider does not list fails **explicitly** with a capability diagnostic —
 * never a silent single-node fallback (spec12 §61).
 */
export const COORDINATION_CAPABILITIES = [
  'distributed-lease',
  'fencing',
  'atomic-work-claim',
  'durable-retry',
  'event-dedup',
  'durable-subscription-cursor',
  'revision-observation',
] as const;

export type CoordinationCapability = (typeof COORDINATION_CAPABILITIES)[number];

export interface CoordinationCapabilities {
  provider: string;
  supports: readonly CoordinationCapability[];
  /**
   * Whether the coordination state genuinely survives across OS processes (spec12 §62,
   * §63). The memory reference is a full *semantic* reference with this `false`; SQLite has
   * it `true`.
   */
  physicalDurability: boolean;
}

export function coordinationProviderSupports(
  capabilities: CoordinationCapabilities,
  capability: CoordinationCapability,
): boolean {
  return capabilities.supports.includes(capability);
}

// ------------------------------------------------------------------------- diagnostics

/**
 * Semantic diagnostics distributed authority introduces (spec12 §87). Provider-native
 * causes (`SQLITE_BUSY`, conditional-check-failed, "Redis lock lost") are never among them.
 */
export const COORDINATION_DIAGNOSTIC_CODES = [
  /** A claim is validly held by another authority right now; try later. */
  'WORK_IN_PROGRESS',
  /** A write was attempted under a `generation` that is no longer current. */
  'WORK_FENCED',
  /** The work exists but is not in a claimable state (already terminal, wrong schema). */
  'WORK_NOT_CLAIMABLE',
  /** The claiming authority's semantic build cannot execute this durable work (spec12 §43). */
  'INCOMPATIBLE_AUTHORITY',
  /** The same `source + externalEventId` arrived carrying a different payload (spec12 §73). */
  'EVENT_ID_CONFLICT',
] as const;

export type CoordinationDiagnosticCode = (typeof COORDINATION_DIAGNOSTIC_CODES)[number];

// ---------------------------------------------------------------------------- provider

/**
 * Physical coordination (spec12 §10). Axiom owns *semantic* coordination — logical work
 * identity, delivery guarantees, fencing meaning; a provider owns the *physical* mechanism
 * — atomic claim transitions, durable ownership storage, generation issuance.
 *
 * Every operation is async so a real adapter can persist; the memory reference resolves
 * synchronously. A provider MUST guarantee: at most one valid owner per resource generation;
 * a stale owner cannot mutate after losing ownership; an expired owner may be replaced;
 * renewal and release are owner-specific; ownership transitions are durable (spec12 §8).
 */
export interface CoordinationProvider {
  readonly capabilities: CoordinationCapabilities;

  /**
   * Atomically claim `resourceId` for `ownerId`. Succeeds when the resource is unclaimed or
   * the current claim's lease window has closed. A successful claim over an expired one
   * **increments `generation`** (spec12 §9, §17). Never grants when a live claim is held —
   * an owner wanting to keep a claim calls {@link renew}, not this.
   */
  acquire(resourceId: string, ownerId: AuthorityInstanceId, leaseMs: number): Promise<AcquireResult>;

  /** Extend the lease window. Fails unless `token` is the current holder's and still live. */
  renew(resourceId: string, token: string, leaseMs: number): Promise<boolean>;

  /** Relinquish the claim. A no-op if `token` is stale. `generation` is *not* rewound. */
  release(resourceId: string, token: string): Promise<void>;

  /** The live claim over `resourceId`, or `null` if unclaimed or expired. */
  inspect(resourceId: string): Promise<Lease | null>;

  /**
   * Whether `(ownerId, generation)` is still the current live owner of `resourceId` — the
   * gate every durable-work mutation consults before committing (spec12 §18, §30). A
   * durable store that shares physical storage with the provider performs the equivalent
   * check *atomically with* its write; callers that cannot use this as a best-effort guard.
   */
  checkOwnership(
    resourceId: string,
    ownerId: AuthorityInstanceId,
    generation: FencingGeneration,
  ): Promise<OwnershipCheck>;

  /**
   * Every claim this provider knows about, live or expired — for observability and explicit
   * reclaim (spec12 §55, §57). Bounded: a provider MUST NOT materialize an unbounded set;
   * `prefix` scopes it to one work class.
   */
  list(prefix?: string): Promise<LeaseView[]>;

  close?(): Promise<void>;
}

/** Namespacing helper so work classes cannot collide on `resourceId` (spec12 §22). */
export function coordinationResourceId(kind: string, ...parts: (string | number)[]): string {
  return [kind, ...parts.map((part) => String(part))].join(':');
}

// ------------------------------------------------------------------------ host config

/**
 * Infrastructure knobs (spec12 §89). None of these alters a semantic guarantee — they tune
 * cadence, batching and concurrency only. Defaults are safe for a single authority and for
 * a cluster.
 */
export interface CoordinationConfig {
  /** Explicit `AuthorityInstanceId`; otherwise `host.uuid()` at startup. */
  instanceId?: AuthorityInstanceId;
  /** Lease window. A claim not renewed within this becomes reclaimable. */
  leaseDurationMs: number;
  /** How often an owner renews a claim it is still working. MUST be `< leaseDurationMs`. */
  renewIntervalMs: number;
  /** Max in-flight durable work items per authority (spec12 §52). */
  workerConcurrency: number;
  /** Max items claimed per poll (spec12 §51, §52). */
  claimBatchSize: number;
  /** Durable-state re-observation cadence (spec12 §53, §54). Not semantic timing. */
  pollIntervalMs: number;
}

export const DEFAULT_LEASE_DURATION_MS = 30_000;
export const DEFAULT_RENEW_INTERVAL_MS = 10_000;
export const DEFAULT_WORKER_CONCURRENCY = 4;
export const DEFAULT_CLAIM_BATCH_SIZE = 32;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export const DEFAULT_COORDINATION_CONFIG: CoordinationConfig = {
  leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
  renewIntervalMs: DEFAULT_RENEW_INTERVAL_MS,
  workerConcurrency: DEFAULT_WORKER_CONCURRENCY,
  claimBatchSize: DEFAULT_CLAIM_BATCH_SIZE,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

/**
 * Reject configurations that make fencing probabilistically unsafe (spec12 §90). Returns a
 * list of human-readable problems; empty means safe. `createAxiomServer` throws on a
 * non-empty result rather than starting with unsafe coordination.
 */
export function validateCoordinationConfig(config: Partial<CoordinationConfig>): string[] {
  const merged = { ...DEFAULT_COORDINATION_CONFIG, ...config };
  const problems: string[] = [];
  if (merged.leaseDurationMs <= 0) {
    problems.push(`leaseDurationMs must be > 0 (got ${merged.leaseDurationMs})`);
  }
  if (merged.renewIntervalMs <= 0) {
    problems.push(`renewIntervalMs must be > 0 (got ${merged.renewIntervalMs})`);
  }
  if (merged.renewIntervalMs >= merged.leaseDurationMs) {
    problems.push(
      `renewIntervalMs (${merged.renewIntervalMs}) must be < leaseDurationMs (${merged.leaseDurationMs}): ` +
        'a renew cadence that cannot beat the lease makes fencing unsafe',
    );
  }
  // A renew that only just beats the lease leaves no margin for a slow provider round trip.
  if (merged.renewIntervalMs * 2 > merged.leaseDurationMs) {
    problems.push(
      `renewIntervalMs (${merged.renewIntervalMs}) should be <= leaseDurationMs/2 ` +
        `(${merged.leaseDurationMs / 2}) to tolerate one lost renewal`,
    );
  }
  if (merged.workerConcurrency <= 0) {
    problems.push(`workerConcurrency must be > 0 (got ${merged.workerConcurrency})`);
  }
  if (merged.claimBatchSize <= 0) {
    problems.push(`claimBatchSize must be > 0 (got ${merged.claimBatchSize})`);
  }
  if (merged.pollIntervalMs <= 0) {
    problems.push(`pollIntervalMs must be > 0 (got ${merged.pollIntervalMs})`);
  }
  return problems;
}

/** Merge a partial host config over the safe defaults, throwing on an unsafe combination. */
export function resolveCoordinationConfig(config: Partial<CoordinationConfig> = {}): CoordinationConfig {
  const problems = validateCoordinationConfig(config);
  if (problems.length > 0) {
    throw new Error(`Unsafe coordination configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return { ...DEFAULT_COORDINATION_CONFIG, ...config };
}

// ------------------------------------------------------------------- memory reference

export interface MemoryCoordinationOptions {
  /** Deterministic clock. Defaults to `Date.now`; conformance and tests inject a fake. */
  now?: () => number;
  /** Deterministic token source. Defaults to a counter; a real adapter uses a random nonce. */
  nextToken?: () => string;
}

interface ResourceState {
  lease: Lease | null;
  /** Kept across `release` so `generation` never rewinds (spec12 §9). */
  lastGeneration: FencingGeneration;
}

/**
 * The deterministic in-process reference (spec12 §63). It is a full *semantic* reference —
 * every fencing, reclaim and ownership rule holds — and it can simulate an N-authority
 * cluster by having several `AuthorityInstanceId`s share one provider instance. It does
 * **not** claim cross-process durability: `capabilities.physicalDurability` is `false`.
 */
export function createMemoryCoordinationProvider(
  options: MemoryCoordinationOptions = {},
): CoordinationProvider {
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const nextToken = options.nextToken ?? (() => `lease-${(counter += 1)}`);
  const resources = new Map<string, ResourceState>();

  const stateOf = (resourceId: string): ResourceState => {
    let state = resources.get(resourceId);
    if (!state) {
      state = { lease: null, lastGeneration: 0 };
      resources.set(resourceId, state);
    }
    return state;
  };
  const liveLease = (state: ResourceState): Lease | null =>
    state.lease !== null && state.lease.expiresAt > now() ? state.lease : null;

  return {
    capabilities: {
      provider: 'memory',
      supports: COORDINATION_CAPABILITIES,
      physicalDurability: false,
    },

    async acquire(resourceId, ownerId, leaseMs) {
      const state = stateOf(resourceId);
      const held = liveLease(state);
      if (held) {
        return { ok: false, heldBy: { ...held } };
      }
      const acquiredAt = now();
      const generation = state.lastGeneration + 1;
      const lease: Lease = {
        resourceId,
        ownerId,
        token: nextToken(),
        generation,
        acquiredAt,
        expiresAt: acquiredAt + leaseMs,
      };
      state.lease = lease;
      state.lastGeneration = generation;
      return { ok: true, lease: { ...lease } };
    },

    async renew(resourceId, token, leaseMs) {
      const state = resources.get(resourceId);
      if (!state || state.lease === null || state.lease.token !== token) {
        return false;
      }
      if (state.lease.expiresAt <= now()) {
        return false;
      }
      state.lease = { ...state.lease, expiresAt: now() + leaseMs };
      return true;
    },

    async release(resourceId, token) {
      const state = resources.get(resourceId);
      if (state && state.lease !== null && state.lease.token === token) {
        state.lease = null;
      }
    },

    async inspect(resourceId) {
      const state = resources.get(resourceId);
      if (!state) {
        return null;
      }
      const live = liveLease(state);
      return live ? { ...live } : null;
    },

    async checkOwnership(resourceId, ownerId, generation) {
      const state = resources.get(resourceId);
      if (!state || (state.lease === null && state.lastGeneration === 0)) {
        return { current: false, lease: null, reason: 'unknown-resource' };
      }
      const live = state.lease !== null && state.lease.expiresAt > now() ? state.lease : null;
      if (live && live.ownerId === ownerId && live.generation === generation) {
        return { current: true, lease: { ...live } };
      }
      let reason: OwnershipCheck['reason'];
      if (state.lastGeneration > generation) {
        reason = 'fenced';
      } else if (!live) {
        reason = 'expired';
      } else {
        reason = 'not-owner';
      }
      return { current: false, lease: live ? { ...live } : null, reason };
    },

    async list(prefix) {
      const at = now();
      const views: LeaseView[] = [];
      for (const state of resources.values()) {
        if (state.lease === null) {
          continue;
        }
        if (prefix !== undefined && !state.lease.resourceId.startsWith(prefix)) {
          continue;
        }
        views.push({ ...state.lease, live: state.lease.expiresAt > at });
      }
      return views.sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
    },
  };
}
