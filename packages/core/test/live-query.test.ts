import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDelta,
  binary,
  call,
  commitAffectsQuery,
  diffResults,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  queryDependencies,
  queryLiveCapability,
  ref,
  rowKey,
  type LiveQueryDelta,
  type QueryDef,
  type ReadPolicyDef,
  type RelationshipDef,
} from '@cynodia/axiom-core';

/**
 * spec13 §13-§16, §26-§31, §148, §149 — the pure, graph-level live-query analysis.
 */

const F_ID = 'field_id';
const ID = (id: string, rest: Record<string, unknown> = {}) => ({ [F_ID]: id, ...rest });

function fold(prev: unknown[], delta: LiveQueryDelta): unknown[] {
  return applyDelta(prev, delta, F_ID);
}
const keys = (rows: unknown[]) => rows.map((r) => rowKey(r, F_ID));

// ------------------------------------------------------------------- delta model

test('diffResults: an appended row is an insert at its index; applyDelta reproduces it', () => {
  const prev = { revision: 1, rows: [ID('a'), ID('b')], resetOnly: false };
  const next = { revision: 2, rows: [ID('a'), ID('b'), ID('c')], resetOnly: false };
  const delta = diffResults(prev, next, F_ID, true);
  assert.deepEqual(delta.changes, [{ kind: 'insert', key: 'c', index: 2, value: ID('c') }]);
  assert.deepEqual(keys(fold(prev.rows, delta)), ['a', 'b', 'c']);
});

test('diffResults: a removed row is a remove; surviving rows do not move', () => {
  const prev = { revision: 1, rows: [ID('a'), ID('b'), ID('c')], resetOnly: false };
  const next = { revision: 2, rows: [ID('a'), ID('c')], resetOnly: false };
  const delta = diffResults(prev, next, F_ID, true);
  assert.deepEqual(delta.changes, [{ kind: 'remove', key: 'b' }]);
  assert.deepEqual(keys(fold(prev.rows, delta)), ['a', 'c']);
});

test('diffResults: a changed value is an update keyed by identity', () => {
  const prev = { revision: 1, rows: [ID('a', { n: 1 })], resetOnly: false };
  const next = { revision: 2, rows: [ID('a', { n: 2 })], resetOnly: false };
  const delta = diffResults(prev, next, F_ID, false);
  assert.deepEqual(delta.changes, [{ kind: 'update', key: 'a', value: ID('a', { n: 2 }) }]);
  assert.deepEqual(fold(prev.rows, delta), [ID('a', { n: 2 })]);
});

test('diffResults: `move` is emitted only for a real relative-order change, not an index shift', () => {
  // b leaves; a and c keep their relative order → no move.
  let delta = diffResults(
    { revision: 1, rows: [ID('a'), ID('b'), ID('c')], resetOnly: false },
    { revision: 2, rows: [ID('a'), ID('c')], resetOnly: false },
    F_ID,
    true,
  );
  assert.ok(!delta.changes.some((c) => c.kind === 'move'));

  // a and c swap → exactly one move reconciles it.
  delta = diffResults(
    { revision: 1, rows: [ID('a'), ID('c')], resetOnly: false },
    { revision: 2, rows: [ID('c'), ID('a')], resetOnly: false },
    F_ID,
    true,
  );
  const moves = delta.changes.filter((c) => c.kind === 'move');
  assert.equal(moves.length, 1);
  assert.deepEqual(keys(fold([ID('a'), ID('c')], delta)), ['c', 'a']);
});

test('diffResults: reorder with an insert — applyDelta still reproduces the exact order', () => {
  const prev = { revision: 1, rows: [ID('a'), ID('b'), ID('c')], resetOnly: false };
  const next = { revision: 2, rows: [ID('c'), ID('x'), ID('a'), ID('b')], resetOnly: false };
  const delta = diffResults(prev, next, F_ID, true);
  assert.deepEqual(keys(fold(prev.rows, delta)), ['c', 'x', 'a', 'b']);
});

test('diffResults: no stable identity, or a duplicate identity, falls back to a single reset', () => {
  const noId = diffResults(
    { revision: 1, rows: [{ x: 1 }], resetOnly: false },
    { revision: 2, rows: [{ x: 2 }], resetOnly: false },
    undefined,
    false,
  );
  assert.deepEqual(noId.changes.map((c) => c.kind), ['reset']);

  const dup = diffResults(
    { revision: 1, rows: [ID('a')], resetOnly: false },
    { revision: 2, rows: [ID('a'), ID('a')], resetOnly: false },
    F_ID,
    false,
  );
  assert.deepEqual(dup.changes.map((c) => c.kind), ['reset']);
});

test('diffResults: a reset-only result emits an empty delta when unchanged, a reset when changed', () => {
  const same = diffResults(
    { revision: 1, rows: [{ total: 5 }], resetOnly: true },
    { revision: 2, rows: [{ total: 5 }], resetOnly: true },
    F_ID,
    false,
  );
  assert.deepEqual(same.changes, []);
  const changed = diffResults(
    { revision: 1, rows: [{ total: 5 }], resetOnly: true },
    { revision: 2, rows: [{ total: 9 }], resetOnly: true },
    F_ID,
    false,
  );
  assert.deepEqual(changed.changes, [{ kind: 'reset', rows: [{ total: 9 }] }]);
});

// -------------------------------------------------------------- dependency analysis

const E_ORDER = nodeId('entity_order');
const E_ACCOUNT = nodeId('entity_account');
const FID_STATUS = fieldId('field_order_status');
const FID_TOTAL = fieldId('field_order_total');
const FID_ACCT = fieldId('field_order_account');
const FID_ACC_ID = fieldId('field_account_id');
const S_MIN = nodeId('state_min_total');
const ROW = nodeId('scope_row');
const ACC = nodeId('scope_acc');
const PROW = nodeId('scope_policy');
const REL = nodeId('rel_order_account');

function baseQuery(overrides: Partial<QueryDef> = {}): QueryDef {
  return {
    id: nodeId('query_x'),
    kind: 'query',
    source: E_ORDER,
    rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), FID_STATUS), literal('open')),
    pagination: { strategy: 'offset', maxPageSize: 50 },
    ...overrides,
  } as QueryDef;
}

test('queryDependencies: the source entity is always a dependency; a StateDef ref is unsupported, not a dependency (spec13.1 F2)', () => {
  const query = baseQuery({
    filter: binary('gte', field(ref(ROW), FID_TOTAL), ref(S_MIN)),
  });
  const deps = queryDependencies(query, undefined, [], new Set([String(S_MIN)]));
  assert.ok(deps.entityIds.has(String(E_ORDER)));
  assert.ok(deps.unsupportedStateRefs.has(String(S_MIN)), 'a query cannot bind a StateDef');
  assert.ok(!deps.stateIds.has(String(S_MIN)), 'so it is never advertised as a real dependency');
  assert.equal(deps.broad, false, 'a known StateDef is not an unresolved ref');
});

test('queryDependencies: an unresolved ref is conservative (broad = true)', () => {
  const query = baseQuery({
    filter: binary('eq', field(ref(ROW), FID_TOTAL), ref(nodeId('scope_unknown'))),
  });
  const deps = queryDependencies(query, undefined, [], new Set());
  assert.equal(deps.broad, true);
  assert.equal(
    commitAffectsQuery(
      { toRevision: 2, entityIds: new Set(['whatever']), stateIds: new Set() },
      deps,
    ),
    true,
  );
});

test('queryDependencies: a used relationship pulls in both endpoint entities; policy scope is local', () => {
  const relationship: RelationshipDef = {
    id: REL,
    kind: 'relationship',
    cardinality: 'to-one',
    from: { entityId: E_ORDER, fieldId: FID_ACCT },
    to: { entityId: E_ACCOUNT, fieldId: FID_ACC_ID },
  };
  const policy: ReadPolicyDef = {
    id: nodeId('policy_order'),
    kind: 'read-policy',
    entityId: E_ORDER,
    rowScopeId: PROW,
    predicate: binary('eq', field(ref(PROW), FID_STATUS), field(ref(PROW), FID_STATUS)),
  };
  const query = baseQuery({ relationships: [{ relationshipId: REL, bindAs: ACC }] });
  const deps = queryDependencies(query, policy, [relationship], new Set());
  assert.ok(deps.entityIds.has(String(E_ORDER)));
  assert.ok(deps.entityIds.has(String(E_ACCOUNT)));
  assert.equal(deps.broad, false, 'the policy row scope is a local binding, not an unresolved ref');
});

test('commitAffectsQuery: matches on entity or state, misses otherwise', () => {
  const deps = {
    entityIds: new Set(['entity_order']),
    stateIds: new Set(['state_a']),
    unsupportedStateRefs: new Set<string>(),
    broad: false,
  };
  assert.equal(commitAffectsQuery({ toRevision: 1, entityIds: new Set(['entity_order']), stateIds: new Set() }, deps), true);
  assert.equal(commitAffectsQuery({ toRevision: 1, entityIds: new Set(), stateIds: new Set(['state_a']) }, deps), true);
  assert.equal(commitAffectsQuery({ toRevision: 1, entityIds: new Set(['entity_other']), stateIds: new Set(['state_b']) }, deps), false);
});

test('queryLiveCapability: a StateDef reference makes a query not-live-capable when stateIds are known (spec13.1 F2)', () => {
  const query = baseQuery({ filter: binary('gte', field(ref(ROW), FID_TOTAL), ref(S_MIN)) });
  assert.equal(queryLiveCapability(query, F_ID).capability, 'live-capable', 'unknown without the state set');
  const classified = queryLiveCapability(query, F_ID, new Set([String(S_MIN)]));
  assert.equal(classified.capability, 'not-live-capable');
  assert.match((classified as { reason: string }).reason, /StateDef/);
});

// --------------------------------------------------------------- capability analysis

test('queryLiveCapability: a plain filtered query with an identity field is live-capable', () => {
  assert.deepEqual(queryLiveCapability(baseQuery(), F_ID), { capability: 'live-capable' });
});

test('queryLiveCapability: an aggregate or identity-less query is reset-only', () => {
  const agg = baseQuery({ aggregate: [{ function: 'sum', key: field(ref(ROW), FID_TOTAL), as: fieldId('field_total') }] });
  assert.equal(queryLiveCapability(agg, F_ID).capability, 'live-capable-reset-only');
  assert.equal(queryLiveCapability(baseQuery(), undefined).capability, 'live-capable-reset-only');
});

test('queryLiveCapability: a query reading `now` or `uuid` is not-live-capable', () => {
  const nowQuery = baseQuery({ filter: binary('gte', field(ref(ROW), FID_TOTAL), call('now')) });
  assert.equal(queryLiveCapability(nowQuery, F_ID).capability, 'not-live-capable');
  const uuidQuery = baseQuery({ sort: [{ key: call('uuid'), direction: 'asc' }] });
  assert.equal(queryLiveCapability(uuidQuery, F_ID).capability, 'not-live-capable');
});

