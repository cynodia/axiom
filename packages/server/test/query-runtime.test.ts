import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  enumType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
} from '@cynodia/axiom-core';
import type { EntityDef, QueryDef, ReadPolicyDef, RelationshipDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  SERVER_DIAGNOSTIC_CODES,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
} from '@cynodia/axiom-server';
import type { QueryRequest, QueryResponse } from '@cynodia/axiom-server';

const ENTITY_ORDER = nodeId('entity_order');
const ENTITY_ACCOUNT = nodeId('entity_account');
const ENTITY_SUMMARY = nodeId('entity_order_summary');
const ENTITY_PRINCIPAL = nodeId('entity_principal');

const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_ACCOUNT_ID = fieldId('field_order_account_id');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_CREATED = fieldId('field_order_created_at');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ACC_ID = fieldId('field_account_id');
const F_ACC_NAME = fieldId('field_account_name');
const F_SUM_ID = fieldId('field_summary_id');
const F_SUM_ACC = fieldId('field_summary_account');
const F_SUM_TOTAL = fieldId('field_summary_total');
const F_SUM_COUNT = fieldId('field_summary_count');
const F_PR_ROLE = fieldId('field_principal_role');
const F_PR_ACCOUNT = fieldId('field_principal_account_id');

const STATE_ORDERS = nodeId('state_orders');
const REL_ORDER_ACCOUNT = nodeId('rel_order_account');
const POLICY_ORDER = nodeId('policy_order');
const QUERY_ORDERS = nodeId('query_orders');
const QUERY_COUNT = nodeId('query_order_count');
const ROW = nodeId('scope_row');
const ACC = nodeId('scope_acc');
const PROW = nodeId('scope_policy_row');
const P_STATUS = nodeId('param_status');

const STATUS = ['pending', 'confirmed', 'cancelled'];
const PRINCIPAL_ID = 'axiom_principal';

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('orders', 'Orders');
  g.addNode<EntityDef>({
    id: ENTITY_PRINCIPAL,
    kind: 'entity',
    identityFieldId: F_PR_ACCOUNT,
    fields: [
      { id: F_PR_ROLE, valueType: primitiveType('string'), required: true },
      { id: F_PR_ACCOUNT, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_ACCOUNT_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_STATUS, valueType: enumType(STATUS), required: true },
      { id: F_ORDER_CREATED, valueType: primitiveType('datetime'), required: true },
      { id: F_ORDER_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: ENTITY_ACCOUNT,
    kind: 'entity',
    identityFieldId: F_ACC_ID,
    fields: [
      { id: F_ACC_ID, valueType: primitiveType('string'), required: true },
      { id: F_ACC_NAME, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: ENTITY_SUMMARY,
    kind: 'entity',
    identityFieldId: F_SUM_ID,
    fields: [
      { id: F_SUM_ID, valueType: primitiveType('string'), required: true },
      { id: F_SUM_ACC, valueType: primitiveType('string') },
      { id: F_SUM_TOTAL, valueType: primitiveType('number') },
      { id: F_SUM_COUNT, valueType: primitiveType('number') },
    ],
  });
  g.addNode<StateDef>({ id: STATE_ORDERS, kind: 'state', valueType: collectionType(entityType(ENTITY_ORDER)) });
  g.addNode<RelationshipDef>({
    id: REL_ORDER_ACCOUNT,
    kind: 'relationship',
    cardinality: 'to-one',
    from: { entityId: ENTITY_ORDER, fieldId: F_ORDER_ACCOUNT_ID },
    to: { entityId: ENTITY_ACCOUNT, fieldId: F_ACC_ID },
  });
  g.addNode<ReadPolicyDef>({
    id: POLICY_ORDER,
    kind: 'read-policy',
    entityId: ENTITY_ORDER,
    rowScopeId: PROW,
    // admin sees all; anyone else only their own account's orders
    predicate: binary(
      'or',
      binary('eq', field(ref(nodeId(PRINCIPAL_ID)), F_PR_ROLE), literal('admin')),
      binary(
        'eq',
        field(ref(PROW), F_ORDER_ACCOUNT_ID),
        field(ref(nodeId(PRINCIPAL_ID)), F_PR_ACCOUNT),
      ),
    ),
  });
  g.addNode<QueryDef>({
    id: QUERY_ORDERS,
    kind: 'query',
    source: ENTITY_ORDER,
    rowScopeId: ROW,
    parameters: [{ id: P_STATUS, valueType: enumType(STATUS), required: false }],
    filter: binary('eq', field(ref(ROW), F_ORDER_STATUS), ref(P_STATUS)),
    sort: [{ key: field(ref(ROW), F_ORDER_CREATED), direction: 'desc' }],
    relationships: [{ relationshipId: REL_ORDER_ACCOUNT, bindAs: ACC }],
    projection: {
      entityId: ENTITY_SUMMARY,
      fields: [
        { id: F_SUM_ID, value: field(ref(ROW), F_ORDER_ID) },
        { id: F_SUM_ACC, value: field(ref(ACC), F_ACC_NAME) },
        { id: F_SUM_TOTAL, value: field(ref(ROW), F_ORDER_TOTAL) },
      ],
    },
    pagination: { strategy: 'cursor', maxPageSize: 10, defaultPageSize: 5 },
    readPolicyId: POLICY_ORDER,
  });
  g.addNode<QueryDef>({
    id: QUERY_COUNT,
    kind: 'query',
    source: ENTITY_ORDER,
    rowScopeId: ROW,
    aggregate: [{ function: 'count', as: F_SUM_COUNT }],
    pagination: { strategy: 'offset', maxPageSize: 1 },
    readPolicyId: POLICY_ORDER,
  });
  g.setPrincipalEntity(ENTITY_PRINCIPAL);
  return g;
}

const orders = Array.from({ length: 12 }, (_, i) => ({
  [F_ORDER_ID]: `o${String(i + 1).padStart(2, '0')}`,
  [F_ORDER_ACCOUNT_ID]: i % 2 === 0 ? 'a1' : 'a2',
  [F_ORDER_STATUS]: 'confirmed',
  [F_ORDER_CREATED]: `2026-01-${String(i + 1).padStart(2, '0')}`,
  [F_ORDER_TOTAL]: (i + 1) * 10,
})) as Record<string, unknown>[];

const accounts = [
  { [F_ACC_ID]: 'a1', [F_ACC_NAME]: 'Acme' },
  { [F_ACC_ID]: 'a2', [F_ACC_NAME]: 'Globex' },
] as Record<string, unknown>[];

async function server(opts: { provider?: boolean } = {}) {
  const s = createAxiomServer({
    ir: compileToServerIR(graph()),
    host: createDeterministicServerHost({
      authenticate: (credential) =>
        credential === 'admin'
          ? { [F_PR_ROLE]: 'admin', [F_PR_ACCOUNT]: 'root' }
          : credential === 'a1'
            ? { [F_PR_ROLE]: 'account', [F_PR_ACCOUNT]: 'a1' }
            : credential === 'a2'
              ? { [F_PR_ROLE]: 'account', [F_PR_ACCOUNT]: 'a2' }
              : null,
    }),
    cursorSecret: 'test-secret',
    ...(opts.provider === false
      ? {}
      : {
          dataProvider: createMemoryDataProvider({
            rows: { [ENTITY_ORDER]: orders as never, [ENTITY_ACCOUNT]: accounts as never },
            maxPageSize: 10,
          }),
        }),
  });
  await s.start();
  return s;
}

function q(queryId: string, extra: Record<string, unknown> = {}, credential?: string): QueryRequest {
  return {
    kind: 'query',
    protocol: PROTOCOL_VERSION,
    queryId: nodeId(queryId),
    ...(credential ? { credential } : {}),
    ...extra,
  } as QueryRequest;
}

/** The row query, always with its status argument supplied. */
function rows(extra: Record<string, unknown> = {}, credential?: string): QueryRequest {
  return q(QUERY_ORDERS, { arguments: { [P_STATUS]: 'confirmed' }, ...extra }, credential);
}

test('an admin query returns projected rows with the joined account name', async () => {
  const s = await server();
  const res = (await s.handle(rows({ pageSize: 3 }, 'admin'))) as QueryResponse;
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.page?.items.length, 3);
  assert.deepEqual(Object.keys(res.page!.items[0]).sort(), [F_SUM_ACC, F_SUM_ID, F_SUM_TOTAL].sort());
  // createdAt DESC: o12 (account a2 -> Globex) is newest and first.
  assert.equal(res.page!.items[0][F_SUM_ID], 'o12');
  assert.equal(res.page!.items[0][F_SUM_ACC], 'Globex');
  assert.equal(res.page!.items[1][F_SUM_ACC], 'Acme');
});

test('the read policy restricts a customer to their own account, ignoring client arguments', async () => {
  const s = await server();
  const a1 = (await s.handle(rows({ pageSize: 10 }, 'a1'))) as QueryResponse;
  const a2 = (await s.handle(rows({ pageSize: 10 }, 'a2'))) as QueryResponse;
  assert.equal(a1.page!.items.length, 6);
  assert.equal(a2.page!.items.length, 6);
  // Every a1 row belongs to Acme; the hostile client cannot widen this.
  assert.ok(a1.page!.items.every((row) => row[F_SUM_ACC] === 'Acme'));
});

test('an aggregate count is computed after the read policy', async () => {
  const s = await server();
  const admin = (await s.handle(q(QUERY_COUNT, {}, 'admin'))) as QueryResponse;
  const a1 = (await s.handle(q(QUERY_COUNT, {}, 'a1'))) as QueryResponse;
  assert.equal(admin.aggregate?.rows[0].values[F_SUM_COUNT], 12);
  assert.equal(a1.aggregate?.rows[0].values[F_SUM_COUNT], 6);
});

test('cursor pages are distinct and continue from the sealed position', async () => {
  const s = await server();
  const p1 = (await s.handle(rows({ pageSize: 4 }, 'admin'))) as QueryResponse;
  assert.equal(p1.page!.hasMore, true);
  const p2 = (await s.handle(rows({ pageSize: 4, cursor: p1.page!.nextCursor }, 'admin'))) as QueryResponse;
  const ids1 = new Set(p1.page!.items.map((row) => row[F_SUM_ID]));
  assert.ok(p2.page!.items.every((row) => !ids1.has(row[F_SUM_ID])), 'page 2 does not repeat page 1');
});

test('a tampered cursor is rejected', async () => {
  const s = await server();
  const p1 = (await s.handle(rows({ pageSize: 4 }, 'admin'))) as QueryResponse;
  const tampered = `${p1.page!.nextCursor!.slice(0, -2)}xy`;
  const res = (await s.handle(rows({ pageSize: 4, cursor: tampered }, 'admin'))) as QueryResponse;
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_CURSOR_INVALID);
});

test("a cursor minted for one principal is invalid for another", async () => {
  const s = await server();
  const forA1 = (await s.handle(rows({ pageSize: 2 }, 'a1'))) as QueryResponse;
  const res = (await s.handle(rows({ pageSize: 2, cursor: forA1.page!.nextCursor }, 'a2'))) as QueryResponse;
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_CURSOR_INVALID);
});

test('an oversized page request is refused, not truncated', async () => {
  const s = await server();
  const res = (await s.handle(rows({ pageSize: 5000 }, 'admin'))) as QueryResponse;
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_PAGE_SIZE_EXCEEDED);
});

test('an unknown query id is rejected', async () => {
  const s = await server();
  const res = (await s.handle(q('query_missing', {}, 'admin'))) as QueryResponse;
  assert.equal(res.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_NOT_FOUND);
});

test('an unknown argument name is rejected', async () => {
  const s = await server();
  const res = (await s.handle(q(QUERY_ORDERS, { arguments: { nope: 1 }, pageSize: 2 }, 'admin'))) as QueryResponse;
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_ARGUMENT_TYPE_MISMATCH);
});

test('a query with no registered provider is rejected clearly', async () => {
  const s = await server({ provider: false });
  const res = (await s.handle(q(QUERY_ORDERS, { pageSize: 2 }, 'admin'))) as QueryResponse;
  assert.equal(res.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.QUERY_PROVIDER_MISSING);
});
