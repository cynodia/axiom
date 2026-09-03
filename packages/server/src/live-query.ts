/**
 * Live canonical queries (spec13) — the authoritative runtime half.
 *
 * A live query is a **persistent semantic observation of a `QueryDef` result**, not a stream
 * of provider events. The client subscribes, receives an initial coherent result, and then
 * receives canonical deltas (or resets) as authoritative committed state changes — through
 * any compatible authority, across reconnects, without writing a single line of transport,
 * polling, broadcast or diffing code.
 *
 * The **pure, graph-level analysis** — the canonical delta model
 * ({@link diffResults} / {@link applyDelta}), conservative static dependency analysis
 * ({@link queryDependencies} / {@link commitAffectsQuery}) and live-capability classification
 * ({@link queryLiveCapability}) — lives in `@cynodia/axiom-core` and is re-exported here for
 * convenience. This module owns what needs a host:
 *
 * - {@link liveQueryIdentity} / {@link sealLiveCursor} / {@link openLiveCursor} — stable
 *   logical identity and the versioned, integrity-protected `axiom.live-query-cursor.v1`
 *   (spec13 §7, §8, §33-§35, §79-§81).
 * - {@link createLiveQueryEngine} — the registry that turns "revision advanced" into
 *   "affected subscriptions re-evaluated, delta or reset delivered", with bounded buffering
 *   and coalescing (spec13 §39-§48).
 *
 * The reference correctness path is recompute-and-diff over the ordinary `DataProvider`; a
 * provider MAY later advertise a `query-delta` optimisation without changing any semantic
 * guarantee (spec13 §56, §57, §58).
 */

import { createHmac, randomUUID } from 'node:crypto';
import {
  applyDelta,
  canonicalJSON,
  commitAffectsQuery,
  diffResults,
  queryDependencies,
  queryLiveCapability,
  queryStateReferences,
  rowKey,
  LIVE_QUERY_NONDETERMINISTIC_BUILTINS,
  type CommitChangeset,
  type LiveCapability,
  type LiveChange,
  type LiveQueryDelta,
  type MaterializedResult,
  type QueryDependencySet,
} from './deps.js';

export {
  applyDelta,
  commitAffectsQuery,
  diffResults,
  queryDependencies,
  queryLiveCapability,
  queryStateReferences,
  rowKey,
  LIVE_QUERY_NONDETERMINISTIC_BUILTINS,
};
export type {
  CommitChangeset,
  LiveCapability,
  LiveChange,
  LiveQueryDelta,
  MaterializedResult,
  QueryDependencySet,
};

// --------------------------------------------------------------------------- identity

export interface LiveQueryIdentity {
  queryId: string;
  argumentsFingerprint: string;
  principalFingerprint: string;
  policyFingerprint: string;
  /** `{ serverContract, schemaFingerprint, semanticFingerprint }` digest (spec13 §79-§81). */
  compatibilityFingerprint: string;
}

export function liveQueryIdentity(parts: LiveQueryIdentity): LiveQueryIdentity {
  return {
    queryId: parts.queryId,
    argumentsFingerprint: parts.argumentsFingerprint,
    principalFingerprint: parts.principalFingerprint,
    policyFingerprint: parts.policyFingerprint,
    compatibilityFingerprint: parts.compatibilityFingerprint,
  };
}

export function liveQueryIdentityKey(identity: LiveQueryIdentity): string {
  return canonicalJSON(liveQueryIdentity(identity));
}

/** A fresh runtime subscription id — distinguishes two intentional subscriptions to one query. */
export function newSubscriptionId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------- cursor

export const LIVE_QUERY_CURSOR_VERSION = 'axiom.live-query-cursor.v1';

export interface LiveCursorPayload {
  v: typeof LIVE_QUERY_CURSOR_VERSION;
  sub: string;
  /** The identity fingerprints, inlined so a tamper is caught before any evaluation. */
  q: string;
  a: string;
  p: string;
  rp: string;
  cf: string;
  /** The replay position — an authoritative durable revision. */
  rev: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function liveCursorPayload(
  subscriptionId: string,
  identity: LiveQueryIdentity,
  revision: number,
): LiveCursorPayload {
  return {
    v: LIVE_QUERY_CURSOR_VERSION,
    sub: subscriptionId,
    q: identity.queryId,
    a: identity.argumentsFingerprint,
    p: identity.principalFingerprint,
    rp: identity.policyFingerprint,
    cf: identity.compatibilityFingerprint,
    rev: revision,
  };
}

export function sealLiveCursor(payload: LiveCursorPayload, secret: string): string {
  const body = b64url(Buffer.from(canonicalJSON(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function openLiveCursor(token: string, secret: string): LiveCursorPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i += 1) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(unb64url(body).toString('utf8')) as LiveCursorPayload;
    return payload && payload.v === LIVE_QUERY_CURSOR_VERSION ? payload : null;
  } catch {
    return null;
  }
}

export type LiveCursorMismatch =
  | 'ok'
  | 'version'
  | 'query'
  | 'principal'
  | 'parameters'
  | 'policy'
  | 'compatibility';

/** Fail-closed cursor context check (spec13 §34, §81). Returns the first field that diverges. */
export function liveCursorMatch(
  payload: LiveCursorPayload,
  identity: LiveQueryIdentity,
): LiveCursorMismatch {
  if (payload.v !== LIVE_QUERY_CURSOR_VERSION) return 'version';
  if (payload.q !== identity.queryId) return 'query';
  if (payload.p !== identity.principalFingerprint) return 'principal';
  if (payload.a !== identity.argumentsFingerprint) return 'parameters';
  if (payload.rp !== identity.policyFingerprint) return 'policy';
  if (payload.cf !== identity.compatibilityFingerprint) return 'compatibility';
  return 'ok';
}

// -------------------------------------------------------- durable subscription store

export const DEFAULT_LIVE_SUBSCRIPTION_RETENTION_MS = 60 * 60 * 1000;

export interface LiveSubscriptionRecord {
  subscriptionId: string;
  identity: LiveQueryIdentity;
  lastRevision: number;
  updatedAt: number;
}

/**
 * A bounded retention of logical live subscriptions for observability and GC (spec13 §24,
 * §25, §53, §54, §136, §137). It is NOT the resumable position — the cursor is (spec13 §17,
 * §85). A reconnect past the retention window still works: it is a `reset` from a fresh
 * evaluation. There is deliberately no unbounded history scan.
 */
export interface LiveSubscriptionStore {
  record(record: LiveSubscriptionRecord): void;
  get(subscriptionId: string): LiveSubscriptionRecord | undefined;
  forget(subscriptionId: string): void;
  /** Drop records older than the retention window; returns how many were dropped. */
  sweep(now?: number): number;
  list(): LiveSubscriptionRecord[];
}

export function createMemoryLiveSubscriptionStore(options: {
  retentionMs?: number;
  now?: () => number;
} = {}): LiveSubscriptionStore {
  const retentionMs = Math.max(0, options.retentionMs ?? DEFAULT_LIVE_SUBSCRIPTION_RETENTION_MS);
  const now = options.now ?? (() => Date.now());
  const records = new Map<string, LiveSubscriptionRecord>();
  const sweep = (at = now()): number => {
    let dropped = 0;
    for (const [id, record] of [...records]) {
      if (at - record.updatedAt > retentionMs) {
        records.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  };
  return {
    record: (record) => {
      records.set(record.subscriptionId, { ...record });
      sweep();
    },
    get: (subscriptionId) => {
      const found = records.get(subscriptionId);
      return found ? { ...found } : undefined;
    },
    forget: (subscriptionId) => void records.delete(subscriptionId),
    sweep,
    list: () => [...records.values()].map((record) => ({ ...record })),
  };
}

// -------------------------------------------------------------------------- engine

export type LiveQueryMessage =
  | { kind: 'initial'; revision: number; rows: unknown[]; cursor: string }
  | { kind: 'update'; delta: LiveQueryDelta; cursor: string }
  | { kind: 'reset'; revision: number; rows: unknown[]; cursor: string }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'closed' };

export interface LiveQueryHandle extends AsyncIterable<LiveQueryMessage> {
  readonly subscriptionId: string;
  /** The most recent cursor this handle has emitted. */
  cursor(): string;
  close(): void;
}

export interface LiveEvaluation {
  revision: number;
  rows: unknown[];
  resetOnly: boolean;
}

export interface LiveSubscriptionSpec {
  identity: LiveQueryIdentity;
  dependencies: QueryDependencySet;
  identityFieldId: string | undefined;
  ordered: boolean;
  /** Max rows the query can return — the materialized-result bound (spec13 §60, §183). */
  resultCap: number;
  /** Re-run the query at the current coherent revision (recompute-and-diff, spec13 §56). */
  reevaluate(): Promise<LiveEvaluation>;
}

export interface LiveQueryEngineOptions {
  cursorSecret: string;
  /** Bounded pending-delta buffer per subscription before coalescing to a single reset (spec13 §46-§48). */
  maxPendingChanges?: number;
  /** Optional bounded retention for observability / GC (spec13 §24, §25). */
  subscriptionStore?: LiveSubscriptionStore;
}

interface Registration {
  spec: LiveSubscriptionSpec;
  materialized: MaterializedResult;
  lastCursor: string;
  queue: LiveQueryMessage[];
  waiters: Array<(m: IteratorResult<LiveQueryMessage>) => void>;
  closed: boolean;
}

export interface LiveQueryEngine {
  /** Register a new subscription from a freshly evaluated coherent initial result. */
  register(subscriptionId: string, spec: LiveSubscriptionSpec, initial: LiveEvaluation): LiveQueryHandle;
  /**
   * Resume an existing subscription id (reconnect through any authority). This authority has
   * no materialized result, so it re-evaluates fresh and the first message is a `reset`
   * (spec13 §36-§38, §108).
   */
  resume(subscriptionId: string, spec: LiveSubscriptionSpec, current: LiveEvaluation): LiveQueryHandle;
  /**
   * A commit (local or a revision advance observed from another authority) — re-evaluate
   * every affected subscription and enqueue a delta or reset (spec13 §56, §122, §123).
   */
  onCommit(changeset: CommitChangeset): Promise<void>;
  close(subscriptionId: string): void;
  /** Bounded observability listing (spec13 §96, §170). */
  list(): Array<{ subscriptionId: string; revision: number; pending: number; queryId: string }>;
}

export function createLiveQueryEngine(options: LiveQueryEngineOptions): LiveQueryEngine {
  const { cursorSecret } = options;
  const maxPending = Math.max(1, options.maxPendingChanges ?? 256);
  const store = options.subscriptionStore;
  const registrations = new Map<string, Registration>();

  const cursorFor = (subscriptionId: string, identity: LiveQueryIdentity, revision: number): string =>
    sealLiveCursor(liveCursorPayload(subscriptionId, identity, revision), cursorSecret);

  const remember = (subscriptionId: string, reg: Registration): void => {
    store?.record({
      subscriptionId,
      identity: reg.spec.identity,
      lastRevision: reg.materialized.revision,
      updatedAt: Date.now(),
    });
  };

  function push(reg: Registration, message: LiveQueryMessage): void {
    const waiter = reg.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else reg.queue.push(message);
  }

  function makeHandle(subscriptionId: string): LiveQueryHandle {
    const reg = registrations.get(subscriptionId)!;
    const iterator: AsyncIterator<LiveQueryMessage> = {
      next(): Promise<IteratorResult<LiveQueryMessage>> {
        const queued = reg.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (reg.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => reg.waiters.push(resolve));
      },
      return(): Promise<IteratorResult<LiveQueryMessage>> {
        close(subscriptionId);
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
    return {
      subscriptionId,
      cursor: () => reg.lastCursor,
      close: () => close(subscriptionId),
      [Symbol.asyncIterator]: () => iterator,
    };
  }

  function close(subscriptionId: string): void {
    const reg = registrations.get(subscriptionId);
    if (!reg || reg.closed) return;
    reg.closed = true;
    const waiter = reg.waiters.shift();
    if (waiter) waiter({ value: undefined as never, done: true });
    for (const w of reg.waiters.splice(0)) w({ value: undefined as never, done: true });
    registrations.delete(subscriptionId);
  }

  function start(
    subscriptionId: string,
    spec: LiveSubscriptionSpec,
    initial: LiveEvaluation,
    asReset: boolean,
  ): LiveQueryHandle {
    const cursor = cursorFor(subscriptionId, spec.identity, initial.revision);
    const reg: Registration = {
      spec,
      materialized: { revision: initial.revision, rows: initial.rows, resetOnly: initial.resetOnly },
      lastCursor: cursor,
      queue: [],
      waiters: [],
      closed: false,
    };
    registrations.set(subscriptionId, reg);
    remember(subscriptionId, reg);
    const handle = makeHandle(subscriptionId);
    push(
      reg,
      asReset
        ? { kind: 'reset', revision: initial.revision, rows: initial.rows, cursor }
        : { kind: 'initial', revision: initial.revision, rows: initial.rows, cursor },
    );
    return handle;
  }

  return {
    register: (subscriptionId, spec, initial) => start(subscriptionId, spec, initial, false),
    resume: (subscriptionId, spec, current) => start(subscriptionId, spec, current, true),

    async onCommit(changeset): Promise<void> {
      for (const [subscriptionId, reg] of [...registrations]) {
        if (reg.closed) continue;
        if (changeset.toRevision <= reg.materialized.revision) continue;
        if (!commitAffectsQuery(changeset, reg.spec.dependencies)) {
          // Not a dependency — advance the position without a client-visible message
          // (revisions may be coalesced, spec13 §44).
          reg.materialized = { ...reg.materialized, revision: changeset.toRevision };
          reg.lastCursor = cursorFor(subscriptionId, reg.spec.identity, changeset.toRevision);
          remember(subscriptionId, reg);
          continue;
        }
        let evaluation: LiveEvaluation;
        try {
          evaluation = await reg.spec.reevaluate();
        } catch (error) {
          push(reg, {
            kind: 'error',
            // A re-evaluation that fails because the caller's authorization no longer holds
            // (spec15 §19) carries `AUTHORIZATION_DENIED`; anything else is an evaluation
            // fault. Either way the stream stops serving now-unauthorized / stale data.
            code: (error as { code?: string })?.code ?? 'LIVE_QUERY_EVALUATION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const delta = diffResults(
          reg.materialized,
          { revision: evaluation.revision, rows: evaluation.rows, resetOnly: evaluation.resetOnly },
          reg.spec.identityFieldId,
          reg.spec.ordered,
        );
        reg.materialized = {
          revision: evaluation.revision,
          rows: evaluation.rows,
          resetOnly: evaluation.resetOnly,
        };
        const cursor = cursorFor(subscriptionId, reg.spec.identity, evaluation.revision);
        reg.lastCursor = cursor;
        remember(subscriptionId, reg);
        if (delta.changes.length === 0) continue; // false-positive invalidation — no client message

        // A whole-result replacement (a reset-only query, or a diff that could not be
        // expressed incrementally) is a `reset` *message*, not an `update` wrapping a single
        // `reset` change (spec13 §14, §38).
        const isWholeReset = delta.changes.length === 1 && delta.changes[0].kind === 'reset';

        // Slow-consumer bound (spec13 §46-§48): coalesce, then collapse to a single reset.
        const pendingChanges = reg.queue.reduce(
          (n, m) => n + (m.kind === 'update' ? m.delta.changes.length : m.kind === 'reset' ? m.rows.length : 0),
          0,
        );
        if (isWholeReset || pendingChanges + delta.changes.length > maxPending) {
          reg.queue.length = 0;
          push(reg, { kind: 'reset', revision: evaluation.revision, rows: evaluation.rows, cursor });
        } else {
          push(reg, { kind: 'update', delta, cursor });
        }
      }
    },

    close,
    list: () =>
      [...registrations].map(([subscriptionId, reg]) => ({
        subscriptionId,
        revision: reg.materialized.revision,
        pending: reg.queue.length,
        queryId: reg.spec.identity.queryId,
      })),
  };
}
