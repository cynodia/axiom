import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  OPERATION,
  PRINCIPAL,
  binary,
  every,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  AuthorizationPolicyDef,
  EntityDef,
  QueryDef,
  ReadPolicyDef,
  StateDef,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { PrincipalRecord, QueryResponse, ServerRequest } from '@cynodia/axiom-server';

/**
 * spec15 Phase D — `QueryDef.authorizationPolicy` (`query.read`) is enforced by the same
 * `authorize()` evaluator as an action, before any provider call, identically for a one-shot
 * query, a `query` operation inside an action and a live-query open (§16, §54). Row-level
 * filtering stays `ReadPolicyDef`, AND-ed into the effective filter so `filter`/`sort`/
 * `limit`/aggregation see only the authorized dataset (§17, §18, §81, §82).
 */

// E_GATE carries no ReadPolicy — used to isolate the `query.read` gate.
const E_GATE = nodeId('entity_gate');
const G_ID = fieldId('field_gate_id');
// E_DOC carries a tenant ReadPolicy — used for row-level composition.
const E_DOC = nodeId('entity_doc');
const F_ID = fieldId('field_doc_id');
const F_TENANT = fieldId('field_doc_tenant');
const F_TOTAL = fieldId('field_doc_total');

const E_USER = nodeId('entity_user');
const P_UID = fieldId('field_user_id');
const P_ROLE = fieldId('field_user_role');
const P_TENANT = fieldId('field_user_tenant');

const ROW = nodeId('scope_row');
const POL_ROW = nodeId('scope_policy_row');

const Q_GATED = nodeId('query_gated'); // authorizationPolicy: role == 'analyst'
const Q_BADPOL = nodeId('query_badpol'); // authorizationPolicy throws
const Q_TENANT = nodeId('query_tenant'); // ReadPolicyDef: row.tenant == PRINCIPAL.tenant, sorted
const Q_SUM = nodeId('query_sum'); // aggregate sum over the tenant-filtered rows

const POL_ANALYST = nodeId('policy_analyst');
const POL_BAD = nodeId('policy_bad');
const RP_TENANT = nodeId('readpolicy_tenant');

const A_READS = nodeId('action_reads'); // a `query` operation over Q_GATED
const S_HITS = nodeId('state_hits');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-d', 'Authz Query');
  g.addNode<EntityDef>({
    id: E_USER,
    kind: 'entity',
    identityFieldId: P_UID,
    fields: [
      { id: P_UID, valueType: primitiveType('string'), required: true },
      { id: P_ROLE, valueType: primitiveType('string'), required: true },
      { id: P_TENANT, valueType: primitiveType('string'), required: true },
    ],
  });
  g.setPrincipalEntity(E_USER);
  g.addNode<EntityDef>({
    id: E_GATE,
    kind: 'entity',
    identityFieldId: G_ID,
    fields: [{ id: G_ID, valueType: primitiveType('string'), required: true }],
  });
  g.addNode<EntityDef>({
    id: E_DOC,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_TENANT, valueType: primitiveType('string'), required: true },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<StateDef>({ id: S_HITS, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });

  g.addNode<AuthorizationPolicyDef>({
    id: POL_ANALYST,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(PRINCIPAL), P_ROLE), literal('analyst')),
  });
  g.addNode<AuthorizationPolicyDef>({
    id: POL_BAD,
    kind: 'authorization-policy',
    // `OPERATION` resolves to a string, not a collection — `every` is strict and throws at
    // eval, which must be DENY (§123). In scope, so it passes validation.
    allow: every(ref(OPERATION), nodeId('x'), literal(true)),
  });

  g.addNode<ReadPolicyDef>({
    id: RP_TENANT,
    kind: 'read-policy',
    entityId: E_DOC,
    rowScopeId: POL_ROW,
    predicate: binary('eq', field(ref(POL_ROW), F_TENANT), field(ref(PRINCIPAL), P_TENANT)),
  });

  g.addNode<QueryDef>({
    id: Q_GATED,
    kind: 'query',
    source: E_GATE,
    rowScopeId: ROW,
    authorizationPolicy: POL_ANALYST,
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);
  g.addNode<QueryDef>({
    id: Q_BADPOL,
    kind: 'query',
    source: E_GATE,
    rowScopeId: ROW,
    authorizationPolicy: POL_BAD,
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);
  g.addNode<QueryDef>({
    id: Q_TENANT,
    kind: 'query',
    source: E_DOC,
    rowScopeId: ROW,
    readPolicyId: RP_TENANT,
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);
  g.addNode<QueryDef>({
    id: Q_SUM,
    kind: 'query',
    source: E_DOC,
    rowScopeId: ROW,
    readPolicyId: RP_TENANT,
    aggregate: [{ function: 'sum', key: field(ref(ROW), F_TOTAL), as: fieldId('field_sum') }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);

  g.addNode<ActionDef>({
    id: A_READS,
    kind: 'action',
    operations: [
      { kind: 'query', queryId: Q_GATED, bindAs: nodeId('rows') },
      { kind: 'set', target: stateLocation(S_HITS), value: binary('add', ref(S_HITS), literal(1)) },
    ],
  } as ActionDef);
  return g;
}

const IR = compileToServerIR(graph());

const GATE_ROWS = [{ [G_ID]: 'g1' }, { [G_ID]: 'g2' }, { [G_ID]: 'g3' }];
const DOCS = [
  { [F_ID]: 'a', [F_TENANT]: 't1', [F_TOTAL]: 5 },
  { [F_ID]: 'b', [F_TENANT]: 't2', [F_TOTAL]: 50 },
  { [F_ID]: 'c', [F_TENANT]: 't1', [F_TOTAL]: 3 },
  { [F_ID]: 'd', [F_TENANT]: 't2', [F_TOTAL]: 40 },
  { [F_ID]: 'e', [F_TENANT]: 't1', [F_TOTAL]: 1 },
];

const ANALYST_T1: PrincipalRecord = { [P_UID]: 'u1', [P_ROLE]: 'analyst', [P_TENANT]: 't1' };
const VIEWER_T1: PrincipalRecord = { [P_UID]: 'u2', [P_ROLE]: 'viewer', [P_TENANT]: 't1' };
const ANALYST_T2: PrincipalRecord = { [P_UID]: 'u3', [P_ROLE]: 'analyst', [P_TENANT]: 't2' };

async function server() {
  const s = createAxiomServer({
    ir: IR,
    persistence: createMemoryPersistence(),
    dataProvider: createMemoryDataProvider({
      rows: { [E_GATE]: GATE_ROWS.map((r) => ({ ...r })) as never, [E_DOC]: DOCS.map((r) => ({ ...r })) as never },
      maxPageSize: 100,
    }),
    host: createDeterministicServerHost({
      authenticate: (c) =>
        c === 'analyst-t1' ? ANALYST_T1 : c === 'viewer-t1' ? VIEWER_T1 : c === 'analyst-t2' ? ANALYST_T2 : null,
    }),
  });
  await s.start();
  return s;
}

async function query(
  s: Awaited<ReturnType<typeof server>>,
  queryId: ReturnType<typeof nodeId>,
  credential?: string,
  pageSize?: number,
): Promise<QueryResponse> {
  return (await s.handle({
    kind: 'query',
    protocol: PROTOCOL_VERSION,
    queryId,
    arguments: {},
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(credential ? { credential } : {}),
  } as ServerRequest)) as QueryResponse;
}

const rowIds = (res: QueryResponse, key: string) =>
  (res.page?.items ?? []).map((r) => String((r as Record<string, unknown>)[key]));
const isDenied = (res: QueryResponse) =>
  res.ok === false && (res.diagnostics ?? []).some((d) => String(d.code) === 'AUTHORIZATION_DENIED');

test('spec15 §70: a query-policy graph labels itself axiom.server.v9 and admits', () => {
  assert.equal(IR.contract, 'axiom.server.v9');
});

test('spec15 §16: query.read allows the authorized principal and denies the rest', async () => {
  const s = await server();
  const ok = await query(s, Q_GATED, 'analyst-t1');
  assert.equal(ok.ok, true);
  assert.deepEqual(rowIds(ok, 'field_gate_id').sort(), ['g1', 'g2', 'g3']);

  assert.equal(isDenied(await query(s, Q_GATED, 'viewer-t1')), true);
  assert.equal(isDenied(await query(s, Q_GATED)), true, 'anonymous denied, not defaulted through');
  await s.stop();
});

test('spec15 §123: a query policy that throws at evaluation is DENY', async () => {
  const s = await server();
  const res = await query(s, Q_BADPOL, 'analyst-t1');
  assert.equal(isDenied(res), true);
  assert.equal(
    (res.diagnostics ?? []).find((d) => String(d.code) === 'AUTHORIZATION_DENIED')?.details?.reason,
    'policy-error',
  );
  await s.stop();
});

test('spec15 §18/§81: a ReadPolicy filters rows before sort/limit — limit is over the authorized set', async () => {
  const s = await server();
  // t1 rows by total: e(1), c(3), a(5). Ask for the two smallest. The unauthorized t2 rows
  // b(50)/d(40) must not participate even though the limit is small.
  const res = await query(s, Q_TENANT, 'analyst-t1', 2);
  assert.equal(res.ok, true);
  assert.deepEqual(rowIds(res, 'field_doc_id'), ['e', 'c'], 'limit 2 over {e,c,a}, not a global limit then filter');

  const t2 = await query(s, Q_TENANT, 'analyst-t2');
  assert.deepEqual(rowIds(t2, 'field_doc_id').sort(), ['b', 'd']);
  await s.stop();
});

test('spec15 §82: an aggregate excludes rows the caller may not read', async () => {
  const s = await server();
  const t1 = await query(s, Q_SUM, 'analyst-t1');
  assert.equal(t1.ok, true);
  const sum1 = Number((t1.aggregate?.rows?.[0] as { values: Record<string, unknown> })?.values?.['field_sum']);
  assert.equal(sum1, 9, 'sum of t1 rows 5+3+1, not the global 99');

  const t2 = await query(s, Q_SUM, 'analyst-t2');
  const sum2 = Number((t2.aggregate?.rows?.[0] as { values: Record<string, unknown> })?.values?.['field_sum']);
  assert.equal(sum2, 90);
  await s.stop();
});

test('spec15 §54: a `query` operation inside an action is gated by query.read', async () => {
  const s = await server();
  const denied = (await s.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: A_READS,
    arguments: {},
    credential: 'viewer-t1',
  } as ServerRequest)) as { ok: boolean; diagnostics?: Array<{ code: string; details?: Record<string, unknown> }> };
  assert.equal(denied.ok, false);
  // The operation failure carries the authorization denial (as `details.code`, wrapped by
  // the runtime's query-operation boundary).
  assert.ok(
    (denied.diagnostics ?? []).some(
      (d) => String(d.code) === 'AUTHORIZATION_DENIED' || d.details?.code === 'AUTHORIZATION_DENIED',
    ),
    JSON.stringify(denied.diagnostics),
  );
  assert.equal(s.getState(S_HITS), 0, 'the action transaction rolled back — no partial read, no write');

  const ok = (await s.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: A_READS,
    arguments: {},
    credential: 'analyst-t1',
  } as ServerRequest)) as { ok: boolean };
  assert.equal(ok.ok, true);
  assert.equal(s.getState(S_HITS), 1);
  await s.stop();
});

test('spec15 §16: openLiveQuery refuses a denied caller at open', async () => {
  const s = await server();
  const denied = await s.openLiveQuery({ queryId: String(Q_GATED), credential: 'viewer-t1' });
  assert.ok('error' in denied, 'expected an error result');
  assert.equal((denied as { error: { code: string } }).error.code, 'AUTHORIZATION_DENIED');

  const opened = await s.openLiveQuery({ queryId: String(Q_GATED), credential: 'analyst-t1' });
  assert.ok(!('error' in opened), JSON.stringify((opened as { error?: unknown }).error));
  s.closeLiveQuery((opened as { subscriptionId: string }).subscriptionId);
  await s.stop();
});
