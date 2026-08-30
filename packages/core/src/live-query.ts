/**
 * Live canonical query analysis (spec13) — the pure, graph-level half.
 *
 * A live query is a **persistent semantic observation of a `QueryDef` result**. Everything in
 * this file is a pure function of the graph: it names no transport, no HMAC, no async
 * iteration and no host. The authoritative runtime half — the versioned integrity cursor and
 * the re-evaluation engine — lives in `@cynodia/axiom-server`.
 *
 * - {@link queryLiveCapability} — is this `QueryDef` observable incrementally, only as whole
 *   resets, or not at all (a nondeterministic read)? (spec13 §145, §146, §148, §149)
 * - {@link queryDependencies} / {@link commitAffectsQuery} — the conservative static set of
 *   entities and `StateDef`s whose change may move the result, and the "may this commit have
 *   changed it?" test. False negatives are forbidden (spec13 §26-§31).
 * - {@link diffResults} / {@link applyDelta} — the provider-independent canonical delta model
 *   (`insert`/`remove`/`update`/`move`/`reset`), by recompute-and-compare against semantic
 *   row identity. Correctness before minimal diff (spec13 §13-§16, §56).
 */

import type { Expression } from './expressions.js';
import { walkExpression } from './expressions.js';
import type { NodeId } from './ids.js';
import type { QueryDef } from './query.js';
import type { ReadPolicyDef } from './read-policy.js';
import type { RelationshipDef } from './relationships.js';
import { canonicalJSON } from './schema-identity.js';

// ---------------------------------------------------------------------- delta model

export type LiveChange =
  | { kind: 'insert'; key: string; index?: number; value: unknown }
  | { kind: 'remove'; key: string }
  | { kind: 'update'; key: string; value: unknown }
  | { kind: 'move'; key: string; index: number }
  | { kind: 'reset'; rows: unknown[] };

export interface LiveQueryDelta {
  fromRevision: number;
  toRevision: number;
  changes: LiveChange[];
}

export interface MaterializedResult {
  revision: number;
  rows: unknown[];
  /** Aggregate / group-shaped result — no per-row identity, so only `reset` is meaningful. */
  resetOnly: boolean;
}

/** The semantic identity of a result row, or `undefined` when it has none. */
export function rowKey(row: unknown, identityFieldId: string | undefined): string | undefined {
  if (identityFieldId === undefined || row === null || typeof row !== 'object') return undefined;
  const id = (row as Record<string, unknown>)[identityFieldId];
  return id === undefined || id === null ? undefined : String(id);
}

/**
 * The canonical delta from `prev` to `next`, using semantic row identity (spec13 §13-§16).
 * Falls back to a single `reset` when either result has no stable per-row identity, when a
 * duplicate identity appears (cannot diff safely), or when either side is a scalar/grouped
 * result. Never the mathematically-minimal diff on principle — recompute-and-compare.
 */
export function diffResults(
  prev: MaterializedResult,
  next: { revision: number; rows: unknown[]; resetOnly: boolean },
  identityFieldId: string | undefined,
  ordered: boolean,
): LiveQueryDelta {
  const reset = (): LiveQueryDelta => ({
    fromRevision: prev.revision,
    toRevision: next.revision,
    changes: [{ kind: 'reset', rows: next.rows }],
  });

  if (prev.resetOnly || next.resetOnly) {
    return canonicalJSON(prev.rows) === canonicalJSON(next.rows)
      ? { fromRevision: prev.revision, toRevision: next.revision, changes: [] }
      : reset();
  }

  const prevKeys = new Map<string, { value: unknown; index: number }>();
  for (let i = 0; i < prev.rows.length; i += 1) {
    const key = rowKey(prev.rows[i], identityFieldId);
    if (key === undefined) return reset();
    prevKeys.set(key, { value: prev.rows[i], index: i });
  }
  const nextKeys = new Map<string, { value: unknown; index: number }>();
  for (let i = 0; i < next.rows.length; i += 1) {
    const key = rowKey(next.rows[i], identityFieldId);
    if (key === undefined) return reset();
    if (nextKeys.has(key)) return reset(); // duplicate identity — cannot diff safely
    nextKeys.set(key, { value: next.rows[i], index: i });
  }

  const changes: LiveChange[] = [];
  for (const [key, before] of prevKeys) {
    if (!nextKeys.has(key)) {
      changes.push({ kind: 'remove', key });
    } else {
      const after = nextKeys.get(key)!;
      if (canonicalJSON(before.value) !== canonicalJSON(after.value)) {
        changes.push({ kind: 'update', key, value: after.value });
      }
    }
  }
  for (const [key, after] of nextKeys) {
    if (!prevKeys.has(key)) {
      changes.push(
        ordered
          ? { kind: 'insert', key, index: after.index, value: after.value }
          : { kind: 'insert', key, value: after.value },
      );
    }
  }
  if (ordered) {
    // Emit `move` only for keys whose *relative* order among the surviving rows changed —
    // never for a key whose absolute index merely shifted because a row above it was
    // inserted or removed (spec13 §16). The keys to keep in place are a longest common
    // subsequence of the surviving keys in `prev` order and in `next` order; every other
    // surviving key gets an explicit `move` to its new index.
    const survivingPrev = [...prevKeys.keys()].filter((key) => nextKeys.has(key));
    const survivingNext = [...nextKeys.keys()].filter((key) => prevKeys.has(key));
    const stable = new Set(longestCommonSubsequence(survivingPrev, survivingNext));
    for (const key of survivingNext) {
      if (!stable.has(key)) changes.push({ kind: 'move', key, index: nextKeys.get(key)!.index });
    }
  }

  return { fromRevision: prev.revision, toRevision: next.revision, changes };
}

/** The longest common subsequence of two key lists (order-preserving), used for `move` minimisation. */
function longestCommonSubsequence(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push(a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return result;
}

/**
 * Apply a canonical delta to a row list — the inverse of {@link diffResults} and the
 * conformance oracle (spec13 §15, §40). `insert` and `move` carry a target index into the
 * *final* ordered result, so they are all placed together, in ascending index order, after
 * `remove` and `update` have been applied.
 */
export function applyDelta(
  rows: unknown[],
  delta: LiveQueryDelta,
  identityFieldId: string | undefined,
): unknown[] {
  let result = [...rows];
  const keyOf = (row: unknown): string | undefined => rowKey(row, identityFieldId);

  for (let start = 0; start < delta.changes.length; ) {
    const change = delta.changes[start];
    if (change.kind === 'reset') {
      result = [...change.rows];
      start += 1;
      continue;
    }

    // Take the whole run of non-reset changes and apply it as one atomic batch.
    let end = start;
    while (end < delta.changes.length && delta.changes[end].kind !== 'reset') end += 1;
    const batch = delta.changes.slice(start, end);
    start = end;

    const removed = new Set<string>();
    const updated = new Map<string, unknown>();
    const placements: Array<{ key: string; index: number; value: unknown }> = [];
    for (const c of batch) {
      if (c.kind === 'remove') removed.add(c.key);
      else if (c.kind === 'update') updated.set(c.key, c.value);
      else if (c.kind === 'insert') placements.push({ key: c.key, index: c.index ?? Number.MAX_SAFE_INTEGER, value: c.value });
      else if (c.kind === 'move') placements.push({ key: c.key, index: c.index, value: undefined });
    }
    const placedKeys = new Set(placements.map((p) => p.key));

    // Rows that stay in place: not removed, not moved/inserted. Updates replace the value.
    const base = result
      .filter((row) => {
        const key = keyOf(row);
        return key === undefined || (!removed.has(key) && !placedKeys.has(key));
      })
      .map((row) => {
        const key = keyOf(row);
        return key !== undefined && updated.has(key) ? updated.get(key) : row;
      });

    // A `move` reuses the current (post-update) row value; an `insert` brings its own.
    const currentByKey = new Map<string, unknown>();
    for (const row of result) {
      const key = keyOf(row);
      if (key !== undefined) currentByKey.set(key, updated.has(key) ? updated.get(key) : row);
    }

    const merged = [...base];
    for (const placement of placements.sort((a, b) => a.index - b.index)) {
      const value = placement.value !== undefined ? placement.value : currentByKey.get(placement.key);
      merged.splice(Math.min(placement.index, merged.length), 0, value);
    }
    result = merged;
  }
  return result;
}

// ------------------------------------------------------------- dependency analysis

export interface QueryDependencySet {
  entityIds: Set<string>;
  stateIds: Set<string>;
  /**
   * `StateDef` ids a `QueryDef` clause (or the effective `ReadPolicy` predicate) references
   * — which the provider cannot bind, so the query is not validly executable (spec13.1 F2).
   * Never a real dependency; a query with any of these is not live-capable.
   */
  unsupportedStateRefs: Set<string>;
  /** A dependency that is not statically enumerable — re-evaluate on every commit (spec13 §29). */
  broad: boolean;
}

/**
 * The `StateDef` ids referenced by a `QueryDef`'s clauses outside the query's legal
 * execution scope (`rowScopeId`, parameters, relationship binds, `PRINCIPAL`, nested
 * iteration scopes). A query executes on the `DataProvider`, which binds no authority
 * state, so any such reference would evaluate to nothing — it is a validation error
 * (spec13.1 F2, §76). `includePolicy` also walks a `ReadPolicyDef` predicate, whose runtime
 * scope is likewise state-free.
 */
export function queryStateReferences(
  query: QueryDef,
  knownStateIds: ReadonlySet<string>,
  policy?: ReadPolicyDef,
): string[] {
  const found = new Set<string>();
  const localScopes = new Set<string>([
    String(query.rowScopeId),
    ...(query.parameters ?? []).map((p) => String(p.id)),
    'PRINCIPAL',
  ]);
  for (const use of query.relationships ?? []) {
    if (use.bindAs) localScopes.add(String(use.bindAs));
  }
  if (policy) localScopes.add(String(policy.rowScopeId));

  const scan = (expression: Expression | undefined): void => {
    if (!expression) return;
    walkExpression(expression, (node) => {
      if (
        node.kind === 'filter' ||
        node.kind === 'find' ||
        node.kind === 'map' ||
        node.kind === 'sort' ||
        node.kind === 'every' ||
        node.kind === 'some'
      ) {
        const scopeId = (node as { scopeId?: NodeId }).scopeId;
        if (scopeId) localScopes.add(String(scopeId));
      }
      if (node.kind === 'ref') {
        const id = String(node.targetId);
        if (!localScopes.has(id) && knownStateIds.has(id)) found.add(id);
      }
    });
  };

  scan(query.filter);
  for (const key of query.sort ?? []) scan(key.key);
  for (const field of query.projection?.fields ?? []) scan(field.value);
  for (const expression of query.groupBy ?? []) scan(expression);
  for (const aggregate of query.aggregate ?? []) scan(aggregate.key);
  if (policy) scan(policy.predicate);

  return [...found];
}

/**
 * Conservative static dependencies of a live `QueryDef` (spec13 §26-§31). Includes the
 * source entity, every entity a used / source-touching relationship reaches, and every
 * `StateDef` a query clause or the effective `ReadPolicy` predicate reads. `broad` is set
 * when a `ref` cannot be resolved to a state, parameter, principal or iteration scope —
 * false negatives are forbidden (§27).
 */
export function queryDependencies(
  query: QueryDef,
  policy: ReadPolicyDef | undefined,
  relationships: readonly RelationshipDef[],
  knownStateIds: ReadonlySet<string>,
): QueryDependencySet {
  const entityIds = new Set<string>([String(query.source)]);
  const stateIds = new Set<string>();
  const unsupportedStateRefs = new Set<string>(queryStateReferences(query, knownStateIds, policy));
  let broad = false;

  const localScopes = new Set<string>([
    String(query.rowScopeId),
    ...(query.parameters ?? []).map((p) => String(p.id)),
    'PRINCIPAL',
  ]);
  for (const use of query.relationships ?? []) {
    if (use.bindAs) localScopes.add(String(use.bindAs));
  }
  if (policy) localScopes.add(String(policy.rowScopeId));

  const scan = (expression: Expression | undefined): void => {
    if (!expression) return;
    walkExpression(expression, (node) => {
      if (
        node.kind === 'filter' ||
        node.kind === 'find' ||
        node.kind === 'map' ||
        node.kind === 'sort' ||
        node.kind === 'every' ||
        node.kind === 'some'
      ) {
        const scopeId = (node as { scopeId?: NodeId }).scopeId;
        if (scopeId) localScopes.add(String(scopeId));
      }
      if (node.kind === 'ref') {
        const id = String(node.targetId);
        if (localScopes.has(id)) return;
        // A `StateDef` ref is not a real dependency — the query cannot bind it (spec13.1 F2);
        // it is collected in `unsupportedStateRefs` above, not here.
        if (unsupportedStateRefs.has(id)) return;
        if (knownStateIds.has(id)) stateIds.add(id);
        else broad = true; // an unresolved ref — be conservative
      }
    });
  };

  scan(query.filter);
  for (const key of query.sort ?? []) scan(key.key);
  for (const field of query.projection?.fields ?? []) scan(field.value);
  for (const expression of query.groupBy ?? []) scan(expression);
  for (const aggregate of query.aggregate ?? []) scan(aggregate.key);
  if (policy) scan(policy.predicate);

  for (const relationship of relationships) {
    if (
      String(relationship.from.entityId) === String(query.source) ||
      (query.relationships ?? []).some((use) => String(use.relationshipId) === String(relationship.id))
    ) {
      entityIds.add(String(relationship.from.entityId));
      entityIds.add(String(relationship.to.entityId));
    }
  }
  if (policy) entityIds.add(String(policy.entityId));

  return { entityIds, stateIds, unsupportedStateRefs, broad };
}

export interface CommitChangeset {
  toRevision: number;
  /** Entity ids whose provider-backed rows this commit mutated. */
  entityIds: Set<string>;
  /** Durable `StateDef` ids this commit wrote. */
  stateIds: Set<string>;
  /**
   * The precise write set is unknown — a commit observed only as a durable-revision advance
   * from another authority (spec13 §31, §32, §68). Every live subscription must re-evaluate.
   */
  broad?: boolean;
}

/** Conservative "may this commit have changed the query's result?" (spec13 §27, §63, §64). */
export function commitAffectsQuery(changeset: CommitChangeset, deps: QueryDependencySet): boolean {
  if (changeset.broad || deps.broad) return true;
  for (const id of changeset.entityIds) if (deps.entityIds.has(id)) return true;
  for (const id of changeset.stateIds) if (deps.stateIds.has(id)) return true;
  return false;
}

// ------------------------------------------------------------ capability analysis

export type LiveCapability =
  | { capability: 'live-capable' }
  | { capability: 'live-capable-reset-only'; reason: string }
  | { capability: 'not-live-capable'; reason: string };

/** Builtins whose value is not a pure function of committed state (spec13 §145, §146). */
export const LIVE_QUERY_NONDETERMINISTIC_BUILTINS: readonly string[] = ['now', 'uuid'];

function usesNondeterministic(expression: Expression | undefined): boolean {
  if (!expression) return false;
  let found = false;
  const nd = new Set(LIVE_QUERY_NONDETERMINISTIC_BUILTINS);
  walkExpression(expression, (node) => {
    if (node.kind === 'call' && nd.has(node.function)) found = true;
  });
  return found;
}

/**
 * Classify a `QueryDef`'s live capability (spec13 §145, §146, §148, §149; spec13.1 §78). A
 * query whose clause references a `StateDef` (when `knownStateIds` is supplied) is
 * `not-live-capable` — it is not validly executable (F2). A query that reads a
 * nondeterministic builtin (`now`, `uuid`) is `not-live-capable`; an aggregate / grouped
 * query, or one whose source entity has no identity field, is `live-capable-reset-only`;
 * otherwise `live-capable`.
 */
export function queryLiveCapability(
  query: QueryDef,
  sourceIdentityFieldId: string | undefined,
  knownStateIds?: ReadonlySet<string>,
): LiveCapability {
  if (knownStateIds) {
    const stateRefs = queryStateReferences(query, knownStateIds);
    if (stateRefs.length > 0) {
      return {
        capability: 'not-live-capable',
        reason: `query expression references a StateDef (${stateRefs.join(', ')}), which QueryDef execution scope does not bind`,
      };
    }
  }
  const expressions: Array<Expression | undefined> = [
    query.filter,
    ...(query.sort ?? []).map((k) => k.key),
    ...(query.projection?.fields ?? []).map((f) => f.value),
    ...(query.groupBy ?? []),
    ...(query.aggregate ?? []).map((a) => a.key),
  ];
  if (expressions.some(usesNondeterministic)) {
    return { capability: 'not-live-capable', reason: 'query reads a nondeterministic builtin (now/uuid)' };
  }
  if ((query.aggregate?.length ?? 0) > 0 || (query.groupBy?.length ?? 0) > 0) {
    return { capability: 'live-capable-reset-only', reason: 'aggregate/grouped result has no per-row identity' };
  }
  if (sourceIdentityFieldId === undefined) {
    return { capability: 'live-capable-reset-only', reason: 'source entity has no identity field' };
  }
  return { capability: 'live-capable' };
}
