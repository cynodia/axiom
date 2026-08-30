import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  providerRecordFieldLocation,
  ref,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, QueryDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createInMemoryChannelPair,
  createLiveQueryChannelClient,
  createMemoryDataProvider,
  serveLiveQueryChannel,
} from '@cynodia/axiom-server';
import type { AxiomServer, LiveQueryMessage, ServerRequest } from '@cynodia/axiom-server';

/**
 * spec13 §87, §88, §194 — a live query pumped over a duplex message channel with no
 * application transport code. The in-memory channel pair stands in for a WebSocket; the
 * client code below is byte-identical to what it would be in-process.
 */

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_STATUS = fieldId('field_order_status');
const F_TOTAL = fieldId('field_order_total');
const Q = nodeId('query_open');
const A = nodeId('action_set_status');
const ROW = nodeId('scope_row');
const P_ID = nodeId('param_id');
const P_STATUS = nodeId('param_status');

function ir() {
  const g = new ApplicationGraph('orders', 'Orders');
  g.addNode<EntityDef>({
    id: E,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_STATUS, valueType: primitiveType('string'), required: true },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<QueryDef>({
    id: Q,
    kind: 'query',
    source: E,
    rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);
  g.addNode<ActionDef>({
    id: A,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_STATUS, valueType: primitiveType('string'), required: true },
    ],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E, F_ID, ref(P_ID), F_STATUS), value: ref(P_STATUS) },
    ],
  });
  return compileToServerIR(g);
}

async function makeServer(): Promise<AxiomServer> {
  const s = createAxiomServer({
    ir: ir(),
    host: createDeterministicServerHost({}),
    dataProvider: createMemoryDataProvider({
      rows: {
        [E]: [
          { [F_ID]: 'a', [F_STATUS]: 'open', [F_TOTAL]: 20 },
          { [F_ID]: 'b', [F_STATUS]: 'closed', [F_TOTAL]: 10 },
        ] as never,
      },
      maxPageSize: 50,
    }),
  });
  await s.start();
  return s;
}

const invoke = (actionId: string, args: Record<string, unknown>): ServerRequest =>
  ({ kind: 'invoke', protocol: PROTOCOL_VERSION, actionId: nodeId(actionId), arguments: args }) as ServerRequest;

async function nextMessage(it: AsyncIterator<LiveQueryMessage>): Promise<LiveQueryMessage> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    // Not unref'd — see the note in live-query.test.ts.
    timer = setTimeout(() => reject(new Error('no channel message within 1s')), 1000);
  });
  try {
    const r = await Promise.race([it.next(), timeout]);
    assert.equal(r.done, false, 'channel stream ended');
    return r.value as LiveQueryMessage;
  } finally {
    clearTimeout(timer!);
  }
}

test('a live query flows over a duplex channel: initial, then a delta after a remote commit', async () => {
  const server = await makeServer();
  const { server: serverChannel, client: clientChannel } = createInMemoryChannelPair();
  const channelServer = serveLiveQueryChannel(server, serverChannel);
  const client = createLiveQueryChannelClient(clientChannel);
  try {
    const stream = client.open(String(Q));
    const it = stream[Symbol.asyncIterator]();

    const initial = await nextMessage(it);
    assert.equal(initial.kind, 'initial');
    assert.deepEqual(
      (initial as { rows: Array<Record<string, unknown>> }).rows.map((r) => r[F_ID]),
      ['a'],
    );
    assert.equal(channelServer.openStreams, 1);

    await server.handle(invoke('action_set_status', { [P_ID]: 'b', [P_STATUS]: 'open' }));
    const update = await nextMessage(it);
    assert.equal(update.kind, 'update');
    assert.ok(
      (update as { delta: { changes: Array<{ kind: string; key?: string }> } }).delta.changes.some(
        (c) => c.kind === 'insert' && c.key === 'b',
      ),
    );

    stream.close();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(channelServer.openStreams, 0);
  } finally {
    channelServer.stop();
    await server.stop();
  }
});

test('resume travels over the channel and yields a reset at the current revision', async () => {
  const server = await makeServer();
  const { server: serverChannel, client: clientChannel } = createInMemoryChannelPair();
  const channelServer = serveLiveQueryChannel(server, serverChannel);
  const client = createLiveQueryChannelClient(clientChannel);
  try {
    const first = client.open(String(Q));
    const it1 = first[Symbol.asyncIterator]();
    const initial = await nextMessage(it1);
    assert.equal(initial.kind, 'initial');
    const cursor = (initial as { cursor: string }).cursor;
    first.close();

    const resumed = client.resume(cursor, String(Q));
    const it2 = resumed[Symbol.asyncIterator]();
    const reset = await nextMessage(it2);
    assert.equal(reset.kind, 'reset');
    resumed.close();
  } finally {
    channelServer.stop();
    await server.stop();
  }
});

test('an invalid queryId over the channel is an error frame, not a broken stream', async () => {
  const server = await makeServer();
  const { server: serverChannel, client: clientChannel } = createInMemoryChannelPair();
  const channelServer = serveLiveQueryChannel(server, serverChannel);
  const client = createLiveQueryChannelClient(clientChannel);
  try {
    const stream = client.open('query_does_not_exist');
    const it = stream[Symbol.asyncIterator]();
    const message = await nextMessage(it);
    assert.equal(message.kind, 'error');
    assert.equal((message as { code: string }).code, 'QUERY_NOT_FOUND');
  } finally {
    channelServer.stop();
    await server.stop();
  }
});

test('closing the underlying transport tears every stream down', async () => {
  const server = await makeServer();
  const pair = createInMemoryChannelPair();
  const channelServer = serveLiveQueryChannel(server, pair.server);
  const client = createLiveQueryChannelClient(pair.client);
  try {
    const stream = client.open(String(Q));
    const it = stream[Symbol.asyncIterator]();
    await nextMessage(it); // initial
    assert.equal(channelServer.openStreams, 1);

    pair.server.close();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(channelServer.openStreams, 0);
    const end = await it.next();
    assert.equal(end.done, true);
  } finally {
    channelServer.stop();
    await server.stop();
  }
});
