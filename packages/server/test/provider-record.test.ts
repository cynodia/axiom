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
import type { ActionDef, ConstraintDef, EntityDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
} from '@cynodia/axiom-server';
import type { QueryResponse, ServerRequest } from '@cynodia/axiom-server';

const ENTITY_ORDER = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_STATUS = fieldId('field_order_status');
const F_TOTAL = fieldId('field_order_total');

const STATE_SEED = nodeId('state_seed'); // a materialized state so the graph has an ordinary half too
const CONSTRAINT_TOTAL = nodeId('constraint_total_nonneg');
const QUERY_ONE = nodeId('query_one_order');
const ACTION_CONFIRM = nodeId('action_confirm');
const ACTION_DISCOUNT = nodeId('action_discount');
const ACTION_CANCEL = nodeId('action_cancel');

const ROW = nodeId('scope_row');
const P_ID = nodeId('param_id');
const P_QID = nodeId('param_query_id');
const P_AMOUNT = nodeId('param_amount');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('orders', 'Orders');
  g.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_STATUS, valueType: primitiveType('string'), required: true },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<StateDef>({ id: STATE_SEED, kind: 'state', valueType: collectionType(entityType(ENTITY_ORDER)) });
  g.addNode<ConstraintDef>({
    id: CONSTRAINT_TOTAL,
    kind: 'constraint',
    entityId: ENTITY_ORDER,
    message: 'An order total may not be negative.',
    expression: binary('gte', field(ref(ENTITY_ORDER), F_TOTAL), literal(0)),
  });
  g.addNode({
    id: QUERY_ONE,
    kind: 'query',
    source: ENTITY_ORDER,
    rowScopeId: ROW,
    parameters: [{ id: P_QID, valueType: primitiveType('string'), required: true }],
    filter: binary('eq', field(ref(ROW), F_ID), ref(P_QID)),
    pagination: { strategy: 'offset', maxPageSize: 5 },
  });
  g.addNode<ActionDef>({
    id: ACTION_CONFIRM,
    kind: 'action',
    parameters: [{ id: P_ID, valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'set',
        target: providerRecordFieldLocation(ENTITY_ORDER, F_ID, ref(P_ID), F_STATUS),
        value: literal('confirmed'),
      },
    ],
  });
  g.addNode<ActionDef>({
    id: ACTION_DISCOUNT,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_AMOUNT, valueType: primitiveType('number'), required: true },
    ],
    operations: [
      {
        kind: 'set',
        target: providerRecordFieldLocation(ENTITY_ORDER, F_ID, ref(P_ID), F_TOTAL),
        value: ref(P_AMOUNT),
      },
    ],
  });
  g.addNode<ActionDef>({
    id: ACTION_CANCEL,
    kind: 'action',
    parameters: [{ id: P_ID, valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'remove', target: providerRecordLocation(ENTITY_ORDER, F_ID, ref(P_ID)) },
    ],
  });
  return g;
}

const orders = [
  { [F_ID]: 'o1', [F_STATUS]: 'pending', [F_TOTAL]: 100 },
  { [F_ID]: 'o2', [F_STATUS]: 'pending', [F_TOTAL]: 50 },
];

async function server() {
  const s = createAxiomServer({
    ir: compileToServerIR(graph()),
    host: createDeterministicServerHost({}),
    dataProvider: createMemoryDataProvider({
      rows: { [ENTITY_ORDER]: orders.map((row) => ({ ...row })) as never },
      maxPageSize: 5,
    }),
  });
  await s.start();
  return s;
}

function invoke(actionId: string, args: Record<string, unknown>): ServerRequest {
  return {
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: nodeId(actionId),
    arguments: args,
  } as ServerRequest;
}

async function statusOf(s: Awaited<ReturnType<typeof server>>, id: string): Promise<unknown> {
  const res = (await s.handle({
    kind: 'query',
    protocol: PROTOCOL_VERSION,
    queryId: QUERY_ONE,
    arguments: { [P_QID]: id },
  })) as QueryResponse;
  return res.page?.items[0]?.[F_STATUS];
}

async function totalOf(s: Awaited<ReturnType<typeof server>>, id: string): Promise<unknown> {
  const res = (await s.handle({
    kind: 'query',
    protocol: PROTOCOL_VERSION,
    queryId: QUERY_ONE,
    arguments: { [P_QID]: id },
  })) as QueryResponse;
  return res.page?.items[0]?.[F_TOTAL];
}

test('an action mutates a provider-backed record by identity, never materializing the table', async () => {
  const s = await server();
  const res = await s.handle(invoke(ACTION_CONFIRM, { [P_ID]: 'o1' }));
  assert.equal((res as { ok: boolean }).ok, true, JSON.stringify(res));
  assert.equal(await statusOf(s, 'o1'), 'confirmed');
  assert.equal(await statusOf(s, 'o2'), 'pending', 'the other row is untouched');
});

test('a constraint violation rolls the provider write back entirely', async () => {
  const s = await server();
  const res = await s.handle(invoke(ACTION_DISCOUNT, { [P_ID]: 'o1', [P_AMOUNT]: -5 }));
  assert.equal((res as { ok: boolean }).ok, false);
  assert.equal(await totalOf(s, 'o1'), 100, 'the canonical row is unchanged');
});

test('a valid provider-backed set commits', async () => {
  const s = await server();
  const res = await s.handle(invoke(ACTION_DISCOUNT, { [P_ID]: 'o2', [P_AMOUNT]: 25 }));
  assert.equal((res as { ok: boolean }).ok, true, JSON.stringify(res));
  assert.equal(await totalOf(s, 'o2'), 25);
});

test('a provider-backed remove deletes exactly the addressed row', async () => {
  const s = await server();
  const res = await s.handle(invoke(ACTION_CANCEL, { [P_ID]: 'o1' }));
  assert.equal((res as { ok: boolean }).ok, true, JSON.stringify(res));
  assert.equal(await statusOf(s, 'o1'), undefined, 'o1 is gone');
  assert.equal(await statusOf(s, 'o2'), 'pending', 'o2 remains');
});
