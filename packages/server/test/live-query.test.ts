import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  providerRecordFieldLocation,
  providerRecordLocation,
  ref,
} from '@cynodia/axiom-core';
import type { ActionDef, ConstraintDef, EntityDef, QueryDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  applyDelta,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
  diffResults,
  queryLiveCapability,
} from '@cynodia/axiom-server';
import type {
  AxiomServer,
  LiveQueryDelta,
  LiveQueryHandle,
  LiveQueryMessage,
  QueryResponse,
  ServerRequest,
} from '@cynodia/axiom-server';

/**
 * spec13 internal test matrix (§186). The provider is seeded once and never gains a row it
 * did not start with — `provider-record` locations mutate and delete existing rows, they do
 * not insert. Rows enter and leave the *query result* through their `status` (the filter
 * predicate) and reorder through their `total` (the sort key), which is exactly the live
 * delta surface: `insert` / `remove` / `update` / `move` / `reset`.
 */

const E_ORDER = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_STATUS = fieldId('field_order_status');
const F_TOTAL = fieldId('field_order_total');
const S_SEED = nodeId('state_seed');
const C_TOTAL = nodeId('constraint_total_nonneg');
const Q_OPEN = nodeId('query_open_orders');
const Q_SUM = nodeId('query_open_total');
const ROW = nodeId('scope_row');
const A_STATUS = nodeId('action_set_status');
const A_TOTAL = nodeId('action_set_total');
const A_REMOVE = nodeId('action_remove');
const P_ID = nodeId('param_id');
const P_STATUS = nodeId('param_status');
const P_TOTAL = nodeId('param_total');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('orders', 'Orders');
  g.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_STATUS, valueType: primitiveType('string'), required: true },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<StateDef>({ id: S_SEED, kind: 'state', valueType: collectionType(entityType(E_ORDER)) });
  g.addNode<ConstraintDef>({
    id: C_TOTAL,
    kind: 'constraint',
    entityId: E_ORDER,
    message: 'An order total may not be negative.',
    expression: binary('gte', field(ref(E_ORDER), F_TOTAL), literal(0)),
  });
  g.addNode<QueryDef>({
    id: Q_OPEN,
    kind: 'query',
    source: E_ORDER,
    rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);
  g.addNode<QueryDef>({
    id: Q_SUM,
    kind: 'query',
    source: E_ORDER,
    rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    aggregate: [{ function: 'sum', key: field(ref(ROW), F_TOTAL), as: fieldId('field_total') }],
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);
  g.addNode<ActionDef>({
    id: A_STATUS,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_STATUS, valueType: primitiveType('string'), required: true },
    ],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ID, ref(P_ID), F_STATUS), value: ref(P_STATUS) },
    ],
  });
  g.addNode<ActionDef>({
    id: A_TOTAL,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_TOTAL, valueType: primitiveType('number'), required: true },
    ],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ID, ref(P_ID), F_TOTAL), value: ref(P_TOTAL) },
    ],
  });
  g.addNode<ActionDef>({
    id: A_REMOVE,
    kind: 'action',
    parameters: [{ id: P_ID, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'remove', target: providerRecordLocation(E_ORDER, F_ID, ref(P_ID)) }],
  });
  return g;
}

const IR = compileToServerIR(graph());

type Row = Record<string, unknown>;

async function makeServer(seed: Row[]): Promise<AxiomServer> {
  const s = createAxiomServer({
    ir: IR,
    host: createDeterministicServerHost({}),
    dataProvider: createMemoryDataProvider({
      rows: { [E_ORDER]: seed.map((r) => ({ ...r })) as never },
      maxPageSize: 50,
    }),
  });
  await s.start();
  return s;
}

const SEED: Row[] = [
  { [F_ID]: 'a', [F_STATUS]: 'open', [F_TOTAL]: 30 },
  { [F_ID]: 'b', [F_STATUS]: 'closed', [F_TOTAL]: 10 },
  { [F_ID]: 'c', [F_STATUS]: 'open', [F_TOTAL]: 10 },
  { [F_ID]: 'd', [F_STATUS]: 'closed', [F_TOTAL]: 99 },
];

function invoke(actionId: string, args: Record<string, unknown>): ServerRequest {
  return { kind: 'invoke', protocol: PROTOCOL_VERSION, actionId: nodeId(actionId), arguments: args } as ServerRequest;
}

/** Next live message, with a self-clearing timeout so a stalled stream fails fast instead of hanging. */
async function nextMessage(it: AsyncIterator<LiveQueryMessage>): Promise<LiveQueryMessage> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    // Not unref'd: this timer is the only thing holding the loop open while an idle engine
    // is being waited on, and it is what turns a stalled stream into this error rather than
    // an opaque "event loop has already resolved" cancellation.
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

function ids(rows: unknown[]): string[] {
  return rows.map((r) => String((r as Row)[F_ID]));
}

function asDelta(message: LiveQueryMessage): LiveQueryDelta {
  assert.equal(message.kind, 'update', `expected an update message, got ${message.kind}`);
  return (message as { delta: LiveQueryDelta }).delta;
}

async function open(
  server: AxiomServer,
  queryId: string,
): Promise<{ handle: LiveQueryHandle; it: AsyncIterator<LiveQueryMessage>; initial: LiveQueryMessage }> {
  const opened = await server.openLiveQuery({ queryId });
  assert.ok(
    !('error' in opened),
    `openLiveQuery failed: ${JSON.stringify((opened as { error?: unknown }).error)}`,
  );
  const handle = opened as LiveQueryHandle;
  const it = handle[Symbol.asyncIterator]();
  const initial = await nextMessage(it);
  return { handle, it, initial };
}

async function freshResult(server: AxiomServer, queryId: string): Promise<Row[]> {
  const res = (await server.handle({
    kind: 'query',
    protocol: PROTOCOL_VERSION,
    queryId: nodeId(queryId),
    arguments: {},
  } as ServerRequest)) as QueryResponse;
  return (res.page?.items ?? []) as Row[];
}

// ---------------------------------------------------------------------------- unit

test('queryLiveCapability separates deterministic, aggregate and identity-less queries (spec13 §148, §149)', () => {
  const openQuery = IR.queries!.find((q) => String(q.id) === String(Q_OPEN))!;
  const sumQuery = IR.queries!.find((q) => String(q.id) === String(Q_SUM))!;
  assert.deepEqual(queryLiveCapability(openQuery, String(F_ID)), { capability: 'live-capable' });
  assert.equal(queryLiveCapability(sumQuery, String(F_ID)).capability, 'live-capable-reset-only');
  assert.equal(queryLiveCapability(openQuery, undefined).capability, 'live-capable-reset-only');
});

test('diffResults falls back to a single reset when a row has no stable identity (spec13 §15)', () => {
  const prev = { revision: 1, rows: [{ x: 1 }, { x: 2 }], resetOnly: false };
  const next = { revision: 2, rows: [{ x: 1 }, { x: 3 }], resetOnly: false };
  const delta = diffResults(prev, next, undefined, false);
  assert.equal(delta.changes.length, 1);
  assert.equal(delta.changes[0]?.kind, 'reset');
});

test('diffResults produces insert / update / remove / move against semantic identity (spec13 §13-§16)', () => {
  const prev = {
    revision: 1,
    rows: [
      { [F_ID]: 'c', [F_TOTAL]: 10 },
      { [F_ID]: 'a', [F_TOTAL]: 30 },
    ],
    resetOnly: false,
  };
  const next = {
    revision: 2,
    rows: [
      { [F_ID]: 'a', [F_TOTAL]: 30 },
      { [F_ID]: 'x', [F_TOTAL]: 40 },
    ],
    resetOnly: false,
  };
  const delta = diffResults(prev, next, String(F_ID), true);
  const kinds = delta.changes.map((c) => c.kind).sort();
  assert.ok(kinds.includes('remove'), 'c left the result');
  assert.ok(kinds.includes('insert'), 'x entered the result');
  // `a` is the only surviving row, so its relative order did not change — no `move` (spec13 §16).
  assert.ok(!kinds.includes('move'), 'no spurious move for the lone survivor');
  assert.deepEqual(ids(applyDelta(prev.rows, delta, String(F_ID))), ['a', 'x']);
});

// --------------------------------------------------------------------- integration

test('the initial message is a coherent, filtered, ordered snapshot (spec13 §9, §10)', async () => {
  const s = await makeServer(SEED);
  try {
    const { initial } = await open(s, String(Q_OPEN));
    assert.equal(initial.kind, 'initial');
    assert.deepEqual(ids((initial as { rows: unknown[] }).rows), ['c', 'a'], 'open only, total asc');
    assert.equal(typeof (initial as { cursor: string }).cursor, 'string');
  } finally {
    await s.stop();
  }
});

test('a filter-predicate flip enters and leaves the result as insert / remove (spec13 §13, §109)', async () => {
  const s = await makeServer(SEED);
  try {
    const { it } = await open(s, String(Q_OPEN));

    await s.handle(invoke('action_set_status', { [P_ID]: 'b', [P_STATUS]: 'open' }));
    let delta = asDelta(await nextMessage(it));
    assert.ok(delta.changes.some((c) => c.kind === 'insert' && c.key === 'b'), 'b entered');

    await s.handle(invoke('action_set_status', { [P_ID]: 'a', [P_STATUS]: 'closed' }));
    delta = asDelta(await nextMessage(it));
    assert.ok(delta.changes.some((c) => c.kind === 'remove' && c.key === 'a'), 'a left');
  } finally {
    await s.stop();
  }
});

test('a sort-key change arrives as update (and move when the order changes) (spec13 §14, §16, §110)', async () => {
  const s = await makeServer(SEED);
  try {
    const { it } = await open(s, String(Q_OPEN)); // result: c(10), a(30)

    await s.handle(invoke('action_set_total', { [P_ID]: 'c', [P_TOTAL]: 25 })); // still before a
    let delta = asDelta(await nextMessage(it));
    assert.ok(delta.changes.some((c) => c.kind === 'update' && c.key === 'c'));
    assert.ok(!delta.changes.some((c) => c.kind === 'move'), 'order unchanged, no move');

    await s.handle(invoke('action_set_total', { [P_ID]: 'c', [P_TOTAL]: 50 })); // now after a
    delta = asDelta(await nextMessage(it));
    assert.ok(delta.changes.some((c) => c.kind === 'update' && c.key === 'c'));
    assert.ok(delta.changes.some((c) => c.kind === 'move'), 'c moved past a');
  } finally {
    await s.stop();
  }
});

test('a provider-record remove of a member arrives as a remove change (spec13 §13)', async () => {
  const s = await makeServer(SEED);
  try {
    const { it } = await open(s, String(Q_OPEN));
    await s.handle(invoke('action_remove', { [P_ID]: 'c' }));
    const delta = asDelta(await nextMessage(it));
    assert.ok(delta.changes.some((c) => c.kind === 'remove' && c.key === 'c'));
  } finally {
    await s.stop();
  }
});

test('applying the delta stream reproduces a fresh QueryDef result (spec13 §15, §40, §56)', async () => {
  const s = await makeServer(SEED);
  try {
    const { it, initial } = await open(s, String(Q_OPEN));
    let rows = (initial as { rows: Row[] }).rows;

    const steps: Array<[string, Record<string, unknown>]> = [
      ['action_set_status', { [P_ID]: 'b', [P_STATUS]: 'open' }],
      ['action_set_total', { [P_ID]: 'a', [P_TOTAL]: 5 }],
      ['action_set_total', { [P_ID]: 'c', [P_TOTAL]: 500 }],
      ['action_set_status', { [P_ID]: 'c', [P_STATUS]: 'closed' }],
      ['action_remove', { [P_ID]: 'b' }],
    ];
    for (const [action, args] of steps) {
      await s.handle(invoke(action, args));
      const message = await nextMessage(it);
      if (message.kind === 'update') rows = applyDelta(rows, asDelta(message), String(F_ID)) as Row[];
      else if (message.kind === 'reset') rows = (message as { rows: Row[] }).rows;
      else assert.fail(`unexpected message ${message.kind}`);
    }

    assert.deepEqual(ids(rows).sort(), ids(await freshResult(s, String(Q_OPEN))).sort());
  } finally {
    await s.stop();
  }
});

test('an aggregate live query is reset-only and refreshes on a dependency change (spec13 §14, §19, §115)', async () => {
  const s = await makeServer(SEED);
  try {
    const { it, initial } = await open(s, String(Q_SUM));
    assert.equal(initial.kind, 'initial');
    await s.handle(invoke('action_set_total', { [P_ID]: 'a', [P_TOTAL]: 1000 }));
    const message = await nextMessage(it);
    if (message.kind === 'update') {
      assert.equal(asDelta(message).changes[0]?.kind, 'reset');
    } else {
      assert.equal(message.kind, 'reset');
    }
  } finally {
    await s.stop();
  }
});

test('a dependency commit that does not change the result produces no client message (spec13 §27, §64, §112)', async () => {
  const s = await makeServer(SEED);
  try {
    const { it } = await open(s, String(Q_OPEN));
    // `d` is closed — in the query's dependency set (same entity) but not in its result.
    await s.handle(invoke('action_set_total', { [P_ID]: 'd', [P_TOTAL]: 7 }));
    // Prove the stream is still live and the previous commit yielded nothing.
    await s.handle(invoke('action_set_status', { [P_ID]: 'b', [P_STATUS]: 'open' }));
    const delta = asDelta(await nextMessage(it));
    assert.ok(delta.changes.some((c) => c.kind === 'insert' && c.key === 'b'));
    assert.ok(!delta.changes.some((c) => 'key' in c && c.key === 'd'), 'the closed row never surfaced');
  } finally {
    await s.stop();
  }
});

test('resumeLiveQuery reconnects with a reset at the current revision (spec13 §36-§38, §108)', async () => {
  const s = await makeServer(SEED);
  try {
    const { handle, it } = await open(s, String(Q_OPEN));
    await s.handle(invoke('action_set_status', { [P_ID]: 'b', [P_STATUS]: 'open' }));
    await nextMessage(it); // consume the update
    const cursor = handle.cursor();
    handle.close();

    const resumed = await s.resumeLiveQuery(cursor, { queryId: String(Q_OPEN) });
    assert.ok(!('error' in resumed), JSON.stringify((resumed as { error?: unknown }).error));
    const rit = (resumed as LiveQueryHandle)[Symbol.asyncIterator]();
    const first = await nextMessage(rit);
    assert.equal(first.kind, 'reset');
    assert.deepEqual(ids((first as { rows: unknown[] }).rows), ['b', 'c', 'a'], 'b(10), c(10), a(30)');
    (resumed as LiveQueryHandle).close();
  } finally {
    await s.stop();
  }
});

test('a live-query cursor is fail-closed: tampered or foreign cursors are refused (spec13 §34, §35, §171)', async () => {
  const s = await makeServer(SEED);
  try {
    const { handle } = await open(s, String(Q_OPEN));
    const good = handle.cursor();
    handle.close();

    const tampered = `${good.slice(0, -4)}AAAA`;
    const r1 = await s.resumeLiveQuery(tampered, { queryId: String(Q_OPEN) });
    assert.ok('error' in r1 && r1.error.code === 'LIVE_QUERY_CURSOR_INVALID', JSON.stringify(r1));

    // A cursor minted for one query cannot resume another.
    const r2 = await s.resumeLiveQuery(good, { queryId: String(Q_SUM) });
    assert.ok('error' in r2 && r2.error.code === 'LIVE_QUERY_CURSOR_INVALID', JSON.stringify(r2));
  } finally {
    await s.stop();
  }
});

test('inspectLiveQueries lists the open subscriptions and closeLiveQuery drops them (spec13 §96, §170)', async () => {
  const s = await makeServer(SEED);
  try {
    const { handle } = await open(s, String(Q_OPEN));
    const listed = s.inspectLiveQueries();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.queryId, String(Q_OPEN));
    assert.equal(listed[0]?.subscriptionId, handle.subscriptionId);
    s.closeLiveQuery(handle.subscriptionId);
    assert.deepEqual(s.inspectLiveQueries(), []);
  } finally {
    await s.stop();
  }
});
