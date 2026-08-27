import assert from 'node:assert/strict';
import test from 'node:test';
import { binary, field, fieldId, literal, nodeId, ref } from '@cynodia/axiom-core';
import type { LiteralValue, RelationshipDef } from '@cynodia/axiom-core';
import { createMemoryDataProvider } from '@cynodia/axiom-server';
import type { ProviderQuery, ProviderRelationship } from '@cynodia/axiom-server';

const ENTITY_ORDER = nodeId('entity_order');
const ENTITY_ACCOUNT = nodeId('entity_account');

const F_ID = fieldId('field_order_id');
const F_ACCOUNT_ID = fieldId('field_order_account_id');
const F_STATUS = fieldId('field_order_status');
const F_CREATED = fieldId('field_order_created_at');
const F_TOTAL = fieldId('field_order_total');
const F_ACC_ID = fieldId('field_account_id');
const F_ACC_NAME = fieldId('field_account_name');

const ROW = nodeId('scope_row');
const ACC = nodeId('scope_acc');

const orders = [
  { [F_ID]: 'o1', [F_ACCOUNT_ID]: 'a1', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-03', [F_TOTAL]: 30 },
  { [F_ID]: 'o2', [F_ACCOUNT_ID]: 'a2', [F_STATUS]: 'pending', [F_CREATED]: '2026-01-01', [F_TOTAL]: 10 },
  { [F_ID]: 'o3', [F_ACCOUNT_ID]: 'a1', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-02', [F_TOTAL]: 20 },
  { [F_ID]: 'o4', [F_ACCOUNT_ID]: 'a2', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-02', [F_TOTAL]: 40 },
  { [F_ID]: 'o5', [F_ACCOUNT_ID]: 'a1', [F_STATUS]: 'cancelled', [F_CREATED]: null, [F_TOTAL]: 5 },
] as Record<string, LiteralValue>[];

const accounts = [
  { [F_ACC_ID]: 'a1', [F_ACC_NAME]: 'Acme' },
  { [F_ACC_ID]: 'a2', [F_ACC_NAME]: 'Globex' },
] as Record<string, LiteralValue>[];

function provider(onCall?: MemoryCall) {
  return createMemoryDataProvider({
    rows: { [ENTITY_ORDER]: orders, [ENTITY_ACCOUNT]: accounts },
    maxPageSize: 100,
    onProviderCall: onCall,
  });
}
type MemoryCall = (kind: string, entityId: unknown) => void;

function query(overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return {
    queryId: nodeId('query_orders'),
    source: ENTITY_ORDER,
    rowScopeId: ROW,
    sort: [{ key: field(ref(ROW), F_ID), direction: 'asc', nulls: 'last', label: 'id ASC' }],
    identityFieldId: F_ID,
    relationships: [],
    groupBy: [],
    aggregate: [],
    arguments: {},
    principal: null,
    pageSize: 50,
    strategy: 'cursor',
    ...overrides,
  };
}

test('filter keeps only matching rows', async () => {
  const result = await provider().query(
    query({ filter: binary('eq', field(ref(ROW), F_STATUS), literal('confirmed')) }),
  );
  assert.ok(result.ok);
  assert.deepEqual(result.value.items.map((row) => row[F_ID]), ['o1', 'o3', 'o4']);
});

test('multi-key sort orders by each key in turn', async () => {
  const result = await provider().query(
    query({
      filter: binary('eq', field(ref(ROW), F_STATUS), literal('confirmed')),
      sort: [
        { key: field(ref(ROW), F_CREATED), direction: 'asc', nulls: 'last', label: 'createdAt ASC' },
        { key: field(ref(ROW), F_TOTAL), direction: 'desc', nulls: 'last', label: 'total DESC' },
      ],
    }),
  );
  assert.ok(result.ok);
  // 2026-01-02: o4 (40) before o3 (20); then 2026-01-03: o1
  assert.deepEqual(result.value.items.map((row) => row[F_ID]), ['o4', 'o3', 'o1']);
});

test('null sorts last for an ascending key regardless of position', async () => {
  const result = await provider().query(
    query({
      sort: [{ key: field(ref(ROW), F_CREATED), direction: 'asc', nulls: 'last', label: 'createdAt ASC' }],
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.value.items[result.value.items.length - 1][F_ID], 'o5');
});

test('projection returns only the projected shape', async () => {
  const result = await provider().query(
    query({
      projection: {
        entityId: nodeId('entity_summary'),
        fields: [{ id: fieldId('field_summary_ref'), value: field(ref(ROW), F_ID) }],
      },
    }),
  );
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.value.items[0]), [String(fieldId('field_summary_ref'))]);
});

test('cursor pagination walks distinct, complete pages', async () => {
  const p = provider();
  const page1 = await p.query(query({ pageSize: 2 }));
  assert.ok(page1.ok);
  assert.deepEqual(page1.value.items.map((row) => row[F_ID]), ['o1', 'o2']);
  assert.equal(page1.value.hasMore, true);

  const page2 = await p.query(query({ pageSize: 2, after: page1.value.lastPosition }));
  assert.ok(page2.ok);
  assert.deepEqual(page2.value.items.map((row) => row[F_ID]), ['o3', 'o4']);

  const page3 = await p.query(query({ pageSize: 2, after: page2.value.lastPosition }));
  assert.ok(page3.ok);
  assert.deepEqual(page3.value.items.map((row) => row[F_ID]), ['o5']);
  assert.equal(page3.value.hasMore, false);
});

test('a to-one relationship resolves without N+1', async () => {
  const calls: string[] = [];
  const rel: RelationshipDef = {
    id: nodeId('rel_order_account'),
    kind: 'relationship',
    cardinality: 'to-one',
    from: { entityId: ENTITY_ORDER, fieldId: F_ACCOUNT_ID },
    to: { entityId: ENTITY_ACCOUNT, fieldId: F_ACC_ID },
  };
  const use: ProviderRelationship = { use: { relationshipId: rel.id, bindAs: ACC }, relationship: rel };
  const result = await provider((kind) => calls.push(kind)).query(
    query({
      relationships: [use],
      projection: {
        entityId: nodeId('entity_summary'),
        fields: [
          { id: fieldId('field_summary_ref'), value: field(ref(ROW), F_ID) },
          { id: fieldId('field_summary_account'), value: field(ref(ACC), F_ACC_NAME) },
        ],
      },
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.value.items[0][fieldId('field_summary_account')], 'Acme');
  // One 'query' plus a bounded number of 'relationship' index builds — never one per row.
  const relationshipCalls = calls.filter((kind) => kind === 'relationship').length;
  assert.ok(relationshipCalls <= 6, `expected batched traversal, saw ${relationshipCalls} relationship calls`);
  assert.ok(relationshipCalls < orders.length * 2);
});

test('count and sum aggregate without returning rows', async () => {
  const result = await provider().aggregate(
    query({
      filter: binary('eq', field(ref(ROW), F_STATUS), literal('confirmed')),
      aggregate: [
        { function: 'count', as: fieldId('field_agg_count') },
        { function: 'sum', key: field(ref(ROW), F_TOTAL), as: fieldId('field_agg_total') },
      ],
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.value.rows.length, 1);
  assert.equal(result.value.rows[0].values[fieldId('field_agg_count')], 3);
  assert.equal(result.value.rows[0].values[fieldId('field_agg_total')], 90);
});

test('grouping produces one row per key in first-seen order', async () => {
  const result = await provider().aggregate(
    query({
      groupBy: [field(ref(ROW), F_STATUS)],
      aggregate: [{ function: 'count', as: fieldId('field_agg_count') }],
    }),
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.rows.map((row) => row.key?.[0]),
    ['confirmed', 'pending', 'cancelled'],
  );
  assert.deepEqual(
    result.value.rows.map((row) => row.values[fieldId('field_agg_count')]),
    [3, 1, 1],
  );
});

test('an unsupported leaf expression is rejected, never approximated', async () => {
  const result = await provider().query(
    query({ filter: { kind: 'call', function: 'now', arguments: [] } as never }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'QUERY_CAPABILITY_UNSUPPORTED');
  }
});

test('loadByIdentity returns exactly the requested rows', async () => {
  const result = await provider().loadByIdentity(ENTITY_ORDER, F_ID, ['o2', 'o4']);
  assert.ok(result.ok);
  assert.deepEqual(result.value.map((row) => row[F_ID]).sort(), ['o2', 'o4']);
});
