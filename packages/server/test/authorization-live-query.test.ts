import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  PRINCIPAL,
  binary,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  providerRecordFieldLocation,
  ref,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  AuthorizationPolicyDef,
  EntityDef,
  QueryDef,
  ReadPolicyDef,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
} from '@cynodia/axiom-server';
import type { LiveQueryHandle, LiveQueryMessage, PrincipalRecord, ServerRequest } from '@cynodia/axiom-server';

/**
 * spec15 Phase F — a live query's authorization is not decided only at open. `query.read`
 * is re-checked on every re-evaluation against the *re-resolved* caller, so a revoked
 * principal stops the stream (§19, §59). Row-level `ReadPolicyDef` participates in the live
 * result: a claim / row change that removes access surfaces as a `remove` delta (§79), the
 * reverse as an `insert` (§80). A resume cursor is not a bearer token — resume re-resolves
 * the principal, re-authorizes, and refuses a cursor issued for a different principal (§20).
 */

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const F_UTENANT = fieldId('field_user_tenant');

const E_DOC = nodeId('entity_doc');
const F_ID = fieldId('field_doc_id');
const F_DTENANT = fieldId('field_doc_tenant');

const ROW = nodeId('scope_row');
const PROW = nodeId('scope_policy_row');
const Q_LIVE = nodeId('query_live');
const POL_ANALYST = nodeId('policy_analyst');
const RP_TENANT = nodeId('readpolicy_tenant');
const A_MOVE = nodeId('action_move');
const P_ID = nodeId('param_id');
const P_TENANT = nodeId('param_tenant');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-f', 'Authz Live');
  g.addNode<EntityDef>({
    id: E_USER,
    kind: 'entity',
    identityFieldId: F_UID,
    fields: [
      { id: F_UID, valueType: primitiveType('string'), required: true },
      { id: F_ROLE, valueType: primitiveType('string'), required: true },
      { id: F_UTENANT, valueType: primitiveType('string'), required: true },
    ],
  });
  g.setPrincipalEntity(E_USER);
  g.addNode<EntityDef>({
    id: E_DOC,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_DTENANT, valueType: primitiveType('string'), required: true },
    ],
  });

  g.addNode<AuthorizationPolicyDef>({
    id: POL_ANALYST,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('analyst')),
  });
  g.addNode<ReadPolicyDef>({
    id: RP_TENANT,
    kind: 'read-policy',
    entityId: E_DOC,
    rowScopeId: PROW,
    predicate: binary('eq', field(ref(PROW), F_DTENANT), field(ref(PRINCIPAL), F_UTENANT)),
  });
  g.addNode<QueryDef>({
    id: Q_LIVE,
    kind: 'query',
    source: E_DOC,
    rowScopeId: ROW,
    authorizationPolicy: POL_ANALYST,
    readPolicyId: RP_TENANT,
    sort: [{ key: field(ref(ROW), F_ID), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);
  g.addNode<ActionDef>({
    id: A_MOVE,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_TENANT, valueType: primitiveType('string'), required: true },
    ],
    operations: [{ kind: 'set', target: providerRecordFieldLocation(E_DOC, F_ID, ref(P_ID), F_DTENANT), value: ref(P_TENANT) }],
  } as ActionDef);
  return g;
}

const IR = compileToServerIR(graph());
const SEED = [
  { [F_ID]: 'a', [F_DTENANT]: 't1' },
  { [F_ID]: 'b', [F_DTENANT]: 't2' },
];

const ANALYST_T1: PrincipalRecord = { [F_UID]: 'u1', [F_ROLE]: 'analyst', [F_UTENANT]: 't1' };
const ANALYST_T2: PrincipalRecord = { [F_UID]: 'u2', [F_ROLE]: 'analyst', [F_UTENANT]: 't2' };

function makeServer() {
  const revoked = new Set<string>();
  const s = createAxiomServer({
    ir: IR,
    dataProvider: createMemoryDataProvider({ rows: { [E_DOC]: SEED.map((r) => ({ ...r })) as never }, maxPageSize: 100 }),
    host: createDeterministicServerHost({
      authenticate: (c) =>
        typeof c === 'string' && !revoked.has(c)
          ? c === 'analyst-t1'
            ? ANALYST_T1
            : c === 'analyst-t2'
              ? ANALYST_T2
              : null
          : null,
    }),
  });
  return { s, revoked };
}

async function nextMessage(it: AsyncIterator<LiveQueryMessage>): Promise<LiveQueryMessage> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no live message within 1s')), 1000);
  });
  try {
    const r = await Promise.race([it.next(), timeout]);
    assert.equal(r.done, false, 'live stream ended unexpectedly');
    return r.value as LiveQueryMessage;
  } finally {
    clearTimeout(timer!);
  }
}

const rowIds = (rows: unknown[]) => rows.map((r) => String((r as Record<string, unknown>)[F_ID as unknown as string]));

async function openLive(s: ReturnType<typeof makeServer>['s'], credential: string) {
  const opened = await s.openLiveQuery({ queryId: String(Q_LIVE), credential });
  assert.ok(!('error' in opened), JSON.stringify((opened as { error?: unknown }).error));
  const handle = opened as LiveQueryHandle;
  const it = handle[Symbol.asyncIterator]();
  const initial = await nextMessage(it);
  return { handle, it, initial };
}

const move = (id: string, tenant: string, credential: string): ServerRequest =>
  ({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: A_MOVE,
    arguments: { [String(P_ID)]: id, [String(P_TENANT)]: tenant },
    credential,
  }) as ServerRequest;

test('spec15 §16: openLiveQuery enforces query.read', async () => {
  const { s } = makeServer();
  const denied = await s.openLiveQuery({ queryId: String(Q_LIVE), credential: 'nobody' });
  assert.ok('error' in denied);
  assert.equal((denied as { error: { code: string } }).error.code, 'AUTHORIZATION_DENIED');
  await s.stop();
});

test('spec15 §19/§59: revoking the caller mid-subscription stops the stream with AUTHORIZATION_DENIED', async () => {
  const { s, revoked } = makeServer();
  const { it, initial, handle } = await openLive(s, 'analyst-t1');
  assert.equal(initial.kind, 'initial');
  assert.deepEqual(rowIds((initial as { rows: unknown[] }).rows), ['a']); // t1 only

  revoked.add('analyst-t1'); // auth infra no longer resolves this credential
  await s.handle(move('b', 't1', 'analyst-t2')); // a commit that would otherwise re-evaluate the query

  const msg = await nextMessage(it);
  assert.equal(msg.kind, 'error');
  assert.equal((msg as { code: string }).code, 'AUTHORIZATION_DENIED');
  handle.close();
  await s.stop();
});

test('spec15 §79: a row leaving the caller’s authorized set is a remove delta', async () => {
  const { s } = makeServer();
  const { it, initial } = await openLive(s, 'analyst-t1');
  assert.deepEqual(rowIds((initial as { rows: unknown[] }).rows), ['a']);

  await s.handle(move('a', 't2', 'analyst-t2')); // 'a' now belongs to t2 — the t1 caller loses it
  const msg = await nextMessage(it);
  assert.equal(msg.kind, 'update');
  const delta = (msg as { delta: { changes: Array<{ kind: string }> } }).delta;
  assert.ok(delta.changes.some((c) => c.kind === 'remove' || c.kind === 'reset'), JSON.stringify(delta));

  const after = await s.handle({ kind: 'query', protocol: PROTOCOL_VERSION, queryId: Q_LIVE, arguments: {}, credential: 'analyst-t1' } as ServerRequest);
  assert.deepEqual(rowIds(((after as { page?: { items: unknown[] } }).page?.items) ?? []), [], 'one-shot agrees: nothing visible');
  await s.stop();
});

test('spec15 §80: a row entering the caller’s authorized set is an insert delta', async () => {
  const { s } = makeServer();
  const { it, initial } = await openLive(s, 'analyst-t1');
  assert.deepEqual(rowIds((initial as { rows: unknown[] }).rows), ['a']);

  await s.handle(move('b', 't1', 'analyst-t2')); // 'b' joins t1 — the caller may now observe it
  const msg = await nextMessage(it);
  assert.equal(msg.kind, 'update');
  const delta = (msg as { delta: { changes: Array<{ kind: string }> } }).delta;
  assert.ok(delta.changes.some((c) => c.kind === 'insert' || c.kind === 'reset'), JSON.stringify(delta));
  await s.stop();
});

test('spec15 §20: a resume cursor issued for one principal does not carry another principal’s access', async () => {
  const { s } = makeServer();
  const { handle } = await openLive(s, 'analyst-t1');
  const cursor = handle.cursor();

  // A different (also-authorized) principal cannot inherit P1's cursor position.
  const p2 = await s.resumeLiveQuery(cursor, { queryId: String(Q_LIVE), credential: 'analyst-t2' });
  assert.ok('error' in p2, JSON.stringify(p2));
  assert.match((p2 as { error: { code: string } }).error.code, /LIVE_QUERY_CURSOR|AUTHORIZATION_DENIED/);

  // An unauthorized principal is refused outright.
  const p3 = await s.resumeLiveQuery(cursor, { queryId: String(Q_LIVE), credential: 'nobody' });
  assert.equal((p3 as { error: { code: string } }).error.code, 'AUTHORIZATION_DENIED');

  handle.close();
  await s.stop();
});

test('spec15 §20/§59: resume re-authorizes — a revoked principal cannot resume its own cursor', async () => {
  const { s, revoked } = makeServer();
  const { handle } = await openLive(s, 'analyst-t1');
  const cursor = handle.cursor();
  handle.close();

  revoked.add('analyst-t1');
  const resumed = await s.resumeLiveQuery(cursor, { queryId: String(Q_LIVE), credential: 'analyst-t1' });
  assert.ok('error' in resumed);
  assert.equal((resumed as { error: { code: string } }).error.code, 'AUTHORIZATION_DENIED');
  await s.stop();
});
