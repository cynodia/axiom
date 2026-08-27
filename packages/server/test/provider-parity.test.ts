import assert from 'node:assert/strict';
import test from 'node:test';
import { binary, field, fieldId, literal, nodeId, ref } from '@cynodia/axiom-core';
import type { EntityDef, LiteralValue, RelationshipDef } from '@cynodia/axiom-core';
import {
  createMemoryDataProvider,
  createSqliteDataProvider,
  isSqliteDataProviderAvailable,
} from '@cynodia/axiom-server';
import type { DataProvider, ProviderQuery, ProviderRelationship } from '@cynodia/axiom-server';

const ENTITY_ORDER = nodeId('entity_order');
const ENTITY_ACCOUNT = nodeId('entity_account');
const F_ID = fieldId('field_order_id');
const F_ACCOUNT_ID = fieldId('field_order_account_id');
const F_STATUS = fieldId('field_order_status');
const F_CREATED = fieldId('field_order_created_at');
const F_TOTAL = fieldId('field_order_total');
const F_NOTE = fieldId('field_order_note');
const F_ACC_ID = fieldId('field_account_id');
const F_ACC_NAME = fieldId('field_account_name');
const ROW = nodeId('scope_row');
const ACC = nodeId('scope_acc');

const ORDER_ENTITY: EntityDef = {
  id: ENTITY_ORDER,
  kind: 'entity',
  name: 'Order',
  identityFieldId: F_ID,
  fields: [
    { id: F_ID, valueType: { kind: 'primitive', primitive: 'string' }, required: true },
    { id: F_ACCOUNT_ID, valueType: { kind: 'primitive', primitive: 'string' }, required: true },
    { id: F_STATUS, valueType: { kind: 'primitive', primitive: 'string' }, required: true },
    { id: F_CREATED, valueType: { kind: 'primitive', primitive: 'datetime' } },
    { id: F_TOTAL, valueType: { kind: 'primitive', primitive: 'number' }, required: true },
    { id: F_NOTE, valueType: { kind: 'primitive', primitive: 'string' } },
  ],
};
const ACCOUNT_ENTITY: EntityDef = {
  id: ENTITY_ACCOUNT,
  kind: 'entity',
  name: 'Account',
  identityFieldId: F_ACC_ID,
  fields: [
    { id: F_ACC_ID, valueType: { kind: 'primitive', primitive: 'string' }, required: true },
    { id: F_ACC_NAME, valueType: { kind: 'primitive', primitive: 'string' }, required: true },
  ],
};
const REL: RelationshipDef = {
  id: nodeId('rel_order_account'),
  kind: 'relationship',
  cardinality: 'to-one',
  from: { entityId: ENTITY_ORDER, fieldId: F_ACCOUNT_ID },
  to: { entityId: ENTITY_ACCOUNT, fieldId: F_ACC_ID },
};

const orders: Record<string, LiteralValue>[] = [
  { [F_ID]: 'o1', [F_ACCOUNT_ID]: 'a1', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-03', [F_TOTAL]: 30, [F_NOTE]: 'rush' },
  { [F_ID]: 'o2', [F_ACCOUNT_ID]: 'a2', [F_STATUS]: 'pending', [F_CREATED]: '2026-01-01', [F_TOTAL]: 10, [F_NOTE]: null },
  { [F_ID]: 'o3', [F_ACCOUNT_ID]: 'a1', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-02', [F_TOTAL]: 20, [F_NOTE]: 'gift' },
  { [F_ID]: 'o4', [F_ACCOUNT_ID]: 'a2', [F_STATUS]: 'confirmed', [F_CREATED]: '2026-01-02', [F_TOTAL]: 40, [F_NOTE]: null },
  { [F_ID]: 'o5', [F_ACCOUNT_ID]: 'a1', [F_STATUS]: 'cancelled', [F_CREATED]: null, [F_TOTAL]: 5, [F_NOTE]: 'void' },
];
const accounts: Record<string, LiteralValue>[] = [
  { [F_ACC_ID]: 'a1', [F_ACC_NAME]: 'Acme' },
  { [F_ACC_ID]: 'a2', [F_ACC_NAME]: 'Globex' },
];

function baseQuery(overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return {
    queryId: nodeId('q'),
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

const relUse: ProviderRelationship = { use: { relationshipId: REL.id, bindAs: ACC }, relationship: REL };

async function providers(): Promise<{ memory: DataProvider; sqlite: DataProvider }> {
  return {
    memory: createMemoryDataProvider({
      rows: { [ENTITY_ORDER]: orders.map((row) => ({ ...row })), [ENTITY_ACCOUNT]: accounts.map((row) => ({ ...row })) },
    }),
    sqlite: await createSqliteDataProvider({
      location: ':memory:',
      entities: [ORDER_ENTITY, ACCOUNT_ENTITY],
      relationships: [REL],
      seed: { [ENTITY_ORDER]: orders, [ENTITY_ACCOUNT]: accounts },
    }),
  };
}

async function assertParity(name: string, query: ProviderQuery): Promise<void> {
  const { memory, sqlite } = await providers();
  const isAggregate = query.aggregate.length > 0;
  if (isAggregate) {
    const m = await memory.aggregate(query);
    const s = await sqlite.aggregate(query);
    assert.ok(m.ok && s.ok, `${name}: both ok`);
    assert.deepEqual(s.value.rows, m.value.rows, `${name}: aggregate rows match`);
    return;
  }
  const m = await memory.query(query);
  const s = await sqlite.query(query);
  assert.ok(m.ok && s.ok, `${name}: both ok`);
  assert.deepEqual(s.value.items, m.value.items, `${name}: items match`);
  assert.equal(s.value.hasMore, m.value.hasMore, `${name}: hasMore matches`);
}

const available = await isSqliteDataProviderAvailable();

test('memory and SQLite agree: simple filter', { skip: !available }, async () => {
  await assertParity('filter', baseQuery({ filter: binary('eq', field(ref(ROW), F_STATUS), literal('confirmed')) }));
});

test('memory and SQLite agree: compound filter', { skip: !available }, async () => {
  await assertParity(
    'compound',
    baseQuery({
      filter: binary(
        'and',
        binary('eq', field(ref(ROW), F_STATUS), literal('confirmed')),
        binary('gte', field(ref(ROW), F_TOTAL), literal(20)),
      ),
    }),
  );
});

test('memory and SQLite agree: multi-key sort with nulls', { skip: !available }, async () => {
  await assertParity(
    'multi-sort',
    baseQuery({
      sort: [
        { key: field(ref(ROW), F_CREATED), direction: 'asc', nulls: 'last', label: 'createdAt ASC' },
        { key: field(ref(ROW), F_TOTAL), direction: 'desc', nulls: 'last', label: 'total DESC' },
        { key: field(ref(ROW), F_ID), direction: 'asc', nulls: 'last', label: 'id ASC' },
      ],
    }),
  );
});

test('memory and SQLite agree: null ordering', { skip: !available }, async () => {
  await assertParity(
    'null-order',
    baseQuery({
      sort: [
        { key: field(ref(ROW), F_NOTE), direction: 'asc', nulls: 'last', label: 'note ASC' },
        { key: field(ref(ROW), F_ID), direction: 'asc', nulls: 'last', label: 'id ASC' },
      ],
    }),
  );
});

test('memory and SQLite agree: projection with to-one relationship', { skip: !available }, async () => {
  await assertParity(
    'projection',
    baseQuery({
      relationships: [relUse],
      projection: {
        entityId: nodeId('entity_summary'),
        fields: [
          { id: fieldId('field_s_id'), value: field(ref(ROW), F_ID) },
          { id: fieldId('field_s_account'), value: field(ref(ACC), F_ACC_NAME) },
        ],
      },
    }),
  );
});

test('memory and SQLite agree: cursor page 1 then page 2', { skip: !available }, async () => {
  const { memory, sqlite } = await providers();
  const q1 = baseQuery({
    pageSize: 2,
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc', nulls: 'last', label: 'total ASC' }],
  });
  const m1 = await memory.query(q1);
  const s1 = await sqlite.query(q1);
  assert.ok(m1.ok && s1.ok);
  assert.deepEqual(s1.value.items, m1.value.items, 'page 1 items match');

  const q2 = { ...q1, after: m1.value.lastPosition };
  const m2 = await memory.query(q2);
  const s2 = await sqlite.query({ ...q1, after: s1.value.lastPosition });
  assert.ok(m2.ok && s2.ok);
  assert.deepEqual(s2.value.items, m2.value.items, 'page 2 items match');
});

test('memory and SQLite agree: count and sum', { skip: !available }, async () => {
  await assertParity(
    'count-sum',
    baseQuery({
      filter: binary('eq', field(ref(ROW), F_STATUS), literal('confirmed')),
      aggregate: [
        { function: 'count', as: fieldId('field_a_count') },
        { function: 'sum', key: field(ref(ROW), F_TOTAL), as: fieldId('field_a_total') },
        { function: 'min', key: field(ref(ROW), F_TOTAL), as: fieldId('field_a_min') },
        { function: 'average', key: field(ref(ROW), F_TOTAL), as: fieldId('field_a_avg') },
      ],
    }),
  );
});

test('memory and SQLite agree: grouped count in first-seen order', { skip: !available }, async () => {
  await assertParity(
    'group',
    baseQuery({
      groupBy: [field(ref(ROW), F_STATUS)],
      aggregate: [{ function: 'count', as: fieldId('field_a_count') }],
    }),
  );
});

test('memory and SQLite agree: an unsupported leaf is rejected by both', { skip: !available }, async () => {
  const { memory, sqlite } = await providers();
  const q = baseQuery({ filter: { kind: 'call', function: 'now', arguments: [] } as never });
  const m = await memory.query(q);
  const s = await sqlite.query(q);
  assert.equal(m.ok, false);
  assert.equal(s.ok, false);
});
