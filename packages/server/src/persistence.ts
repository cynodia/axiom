import type { EffectIntentRecord, NodeId } from './deps.js';

/**
 * Observable status of an effect's dispatch to its adapter — distinct from
 * `EffectIntentRecord.outcome`, which says only whether the *intent* was committed as part
 * of its originating transaction (spec §26).
 */
export type EffectDispatchStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** A committed effect intent, plus the server's own bookkeeping of dispatching it. */
export interface EffectRecord extends EffectIntentRecord {
  status: EffectDispatchStatus;
  attempts: number;
  lastError?: { code: string; message: string; retryable?: boolean };
  /** How many event dispatches already led here — carried forward for cycle protection. */
  dispatchDepth?: number;
  /** The adapter's returned value, once `status` is `'succeeded'` — the success event's payload. */
  result?: unknown;
}

/**
 * Where committed authoritative state survives.
 *
 * The contract is deliberately narrow, and deliberately **atomic**: a semantic Axiom
 * transaction that writes several states must persist as one unit. It must never be
 * possible to find an order inserted and one of its two stock debits missing, because that
 * is one transaction.
 *
 * No SQL, no schema and no query language appears in an ApplicationGraph or in this
 * interface. An adapter stores serialized semantic values against state ids; projecting
 * them onto a relational schema is deliberately future work.
 */
export interface PersistedState {
  stateId: NodeId;
  value: unknown;
  /** Incremented on every committed write to this state. */
  revision: number;
}

export interface PersistenceCommit {
  /** The states this transaction writes, with the values it proposes. */
  writes: Array<{ stateId: NodeId; value: unknown }>;
  /**
   * The revision each written state had when the transaction began. A mismatch means
   * something else committed in between, and the commit MUST be refused rather than
   * overwrite it.
   */
  expected: Record<NodeId, number>;
  /**
   * Effect intents this transaction recorded, committed atomically with the state writes
   * above — the transactional outbox invariant (spec §18). A crash between this commit and
   * the adapter call must not lose one: `loadPendingEffects` is how a restarted authority
   * finds it again.
   */
  effects?: EffectRecord[];
}

export interface CommitOutcome {
  committed: boolean;
  /** The new revision of the store when committed. */
  revision: number;
  /** States whose revision no longer matched, when refused. */
  conflicts: NodeId[];
}

export interface PersistenceAdapter {
  /** Everything committed so far. Called once, when the authority starts. */
  load(): Promise<PersistedState[]>;
  /**
   * Applies a whole transaction, or none of it. An adapter MUST NOT apply a subset, and
   * MUST refuse when any expected revision no longer matches.
   */
  commit(commit: PersistenceCommit): Promise<CommitOutcome>;
  /** The current store revision, for conflict detection and observation. */
  revision(): Promise<number>;
  /**
   * Effect intents that were committed but never reached a terminal `succeeded`/`failed`
   * status — what a restarted authority resumes dispatching. Absent on an adapter that does
   * not implement durable effect storage; such an adapter's outbox is memory-only and does
   * not survive a restart, which must then be documented rather than assumed away.
   */
  loadPendingEffects?(): Promise<EffectRecord[]>;
  /** Records an attempted (or terminal) status for a previously committed effect intent. */
  recordEffectAttempt?(id: string, update: Partial<EffectRecord>): Promise<void>;
  close?(): Promise<void>;
}

/**
 * In-memory persistence. It implements the complete authoritative transaction model — the
 * atomicity and the revision check included — so a conformance run or a test exercises the
 * same semantics a durable adapter does, deterministically and without a filesystem.
 */
export function createMemoryPersistence(seed: PersistedState[] = []): PersistenceAdapter {
  const values = new Map<NodeId, PersistedState>();
  for (const entry of seed) {
    values.set(entry.stateId, { ...entry, value: structuredClone(entry.value) });
  }
  let revision = seed.reduce((highest, entry) => Math.max(highest, entry.revision), 0);
  const effects = new Map<string, EffectRecord>();

  return {
    async load(): Promise<PersistedState[]> {
      return [...values.values()].map((entry) => ({ ...entry, value: structuredClone(entry.value) }));
    },
    async commit(commit: PersistenceCommit): Promise<CommitOutcome> {
      const conflicts = commit.writes
        .map((write) => write.stateId)
        .filter((stateId) => (values.get(stateId)?.revision ?? 0) !== (commit.expected[stateId] ?? 0));
      if (conflicts.length > 0) {
        return { committed: false, revision, conflicts };
      }
      // Nothing is written until every expectation has held: all of it, or none — and the
      // effect intents this transaction recorded are committed in the same step, so a
      // crash right after this call cannot lose one.
      revision += 1;
      for (const write of commit.writes) {
        values.set(write.stateId, {
          stateId: write.stateId,
          value: structuredClone(write.value),
          revision,
        });
      }
      for (const effect of commit.effects ?? []) {
        effects.set(effect.id, { ...effect, arguments: structuredClone(effect.arguments) });
      }
      return { committed: true, revision, conflicts: [] };
    },
    async revision(): Promise<number> {
      return revision;
    },
    async loadPendingEffects(): Promise<EffectRecord[]> {
      return [...effects.values()]
        .filter((effect) => effect.status !== 'succeeded' && effect.status !== 'failed')
        .map((effect) => ({ ...effect, arguments: structuredClone(effect.arguments) }));
    },
    async recordEffectAttempt(id: string, update: Partial<EffectRecord>): Promise<void> {
      const existing = effects.get(id);
      if (existing) {
        effects.set(id, { ...existing, ...update });
      }
    },
  };
}
