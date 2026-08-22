import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  find,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, ConstraintDef, EntityDef, RouteDef, StateDef, ViewNode } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
  createSqlitePersistence,
  isSqliteAvailable,
} from '@cynodia/axiom-server';
import type { InvokeResponse, PersistenceAdapter } from '@cynodia/axiom-server';

/**
 * Persistence semantics: durability, atomicity and identity preservation.
 *
 * The important property is that a semantic Axiom transaction persists as one unit. It must
 * never be possible to find one of an action's writes committed and another missing.
 */

const ENTITY_PART = nodeId('entity_part');
const F_PART_ID = fieldId('field_part_id');
const F_PART_STOCK = fieldId('field_part_stock');
const STATE_PARTS = nodeId('state_parts');
const STATE_LEDGER = nodeId('state_ledger');
const ACTION_TAKE = nodeId('action_take');
const PARAM_QUANTITY = nodeId('param_quantity');
const SCOPE_PART = nodeId('scope_part');
const CONSTRAINT_STOCK = nodeId('constraint_stock');

const stock = field(
  find(ref(STATE_PARTS), SCOPE_PART, binary('eq', field(ref(SCOPE_PART), F_PART_ID), literal('bolt'))),
  F_PART_STOCK,
);

/** Two states written by one action, so atomicity is observable. */
function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('store', 'Store');
  graph.addNode<EntityDef>({
    id: ENTITY_PART,
    kind: 'entity',
    identityFieldId: F_PART_ID,
    fields: [
      { id: F_PART_ID, valueType: primitiveType('string'), required: true },
      { id: F_PART_STOCK, valueType: primitiveType('number'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE_PARTS,
    kind: 'state',
    name: 'parts',
    authority: 'server',
    valueType: collectionType(entityType(ENTITY_PART)),
    initialValue: [{ [F_PART_ID]: 'bolt', [F_PART_STOCK]: 10 }],
  });
  graph.addNode<StateDef>({
    id: STATE_LEDGER,
    kind: 'state',
    name: 'ledger',
    authority: 'server',
    valueType: collectionType(primitiveType('number')),
    initialValue: [],
  });
  graph.addNode<ActionDef>({
    id: ACTION_TAKE,
    kind: 'action',
    name: 'take',
    parameters: [{ id: PARAM_QUANTITY, valueType: primitiveType('number'), required: true }],
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_PARTS), identitySelector(F_PART_ID, literal('bolt'))),
          F_PART_STOCK,
        ),
        value: binary('subtract', stock, ref(PARAM_QUANTITY)),
      },
      { kind: 'insert', target: stateLocation(STATE_LEDGER), value: ref(PARAM_QUANTITY) },
    ],
  });
  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_STOCK,
    kind: 'constraint',
    entityId: ENTITY_PART,
    message: 'Stock can never fall below zero.',
    expression: binary('gte', field(ref(ENTITY_PART), F_PART_STOCK), literal(0)),
  });
  graph.addNode<ViewNode>({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

async function start(persistence: PersistenceAdapter) {
  const server = createAxiomServer({
    ir: compileToServerIR(buildGraph()),
    persistence,
    host: createDeterministicServerHost(),
  });
  await server.start();
  const take = async (quantity: number): Promise<InvokeResponse> =>
    (await server.handle({
      kind: 'invoke',
      protocol: PROTOCOL_VERSION,
      actionId: ACTION_TAKE,
      arguments: { [PARAM_QUANTITY]: quantity },
    })) as InvokeResponse;
  const stockOf = (): number =>
    (server.getState(STATE_PARTS) as Array<Record<string, number>>)[0][F_PART_STOCK];
  return { server, take, stockOf };
}

// ------------------------------------------------------------------- in memory

test('the memory adapter implements the whole transaction model', async () => {
  const persistence = createMemoryPersistence();
  const { take, stockOf } = await start(persistence);

  assert.equal((await take(3)).ok, true);
  assert.equal(stockOf(), 7);
  assert.equal(await persistence.revision(), 1);

  const committed = await persistence.load();
  assert.deepEqual(
    committed.map((entry) => entry.stateId).sort(),
    [STATE_LEDGER, STATE_PARTS].sort(),
  );
});

/** Section 21. */
test('a refused transaction persists none of its writes', async () => {
  const persistence = createMemoryPersistence();
  const { take, stockOf } = await start(persistence);

  assert.equal((await take(99)).ok, false);
  assert.equal(stockOf(), 10);
  assert.deepEqual(await persistence.load(), [], 'not one of the two writes was persisted');
  assert.equal(await persistence.revision(), 0);
});

test('a commit is refused when a revision no longer matches', async () => {
  const persistence = createMemoryPersistence();
  const outcome = await persistence.commit({
    writes: [{ stateId: STATE_PARTS, value: [] }],
    expected: { [STATE_PARTS]: 7 },
  });
  assert.equal(outcome.committed, false);
  assert.deepEqual(outcome.conflicts, [STATE_PARTS]);
  assert.deepEqual(await persistence.load(), [], 'and nothing was written');
});

test('a refused commit writes none of its states, not merely the conflicting one', async () => {
  const persistence = createMemoryPersistence();
  await persistence.commit({ writes: [{ stateId: STATE_PARTS, value: ['a'] }], expected: {} });
  const outcome = await persistence.commit({
    writes: [
      { stateId: STATE_LEDGER, value: [1] },
      { stateId: STATE_PARTS, value: ['b'] },
    ],
    expected: { [STATE_LEDGER]: 0, [STATE_PARTS]: 99 },
  });

  assert.equal(outcome.committed, false);
  const stored = await persistence.load();
  assert.equal(stored.find((entry) => entry.stateId === STATE_LEDGER), undefined);
  assert.deepEqual(stored.find((entry) => entry.stateId === STATE_PARTS)?.value, ['a']);
});

test('a memory adapter can be seeded, which is how a fixture starts from a known state', async () => {
  const persistence = createMemoryPersistence([
    { stateId: STATE_PARTS, value: [{ [F_PART_ID]: 'bolt', [F_PART_STOCK]: 2 }], revision: 1 },
  ]);
  const { take, stockOf } = await start(persistence);
  assert.equal(stockOf(), 2);
  assert.equal((await take(3)).ok, false);
  assert.equal((await take(2)).ok, true);
  assert.equal(stockOf(), 0);
});

// --------------------------------------------------------------------- durable

const sqlite = (await isSqliteAvailable()) ? test : test.skip;

/** Section 22. */
sqlite('committed state survives a restart, and a rolled-back write never returns', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'axiom-sqlite-'));
  const file = path.join(directory, 'state.db');
  try {
    const first = await start(await createSqlitePersistence({ location: file }));
    assert.equal((await first.take(3)).ok, true);
    assert.equal((await first.take(99)).ok, false);
    assert.equal(first.stockOf(), 7);
    await first.server.stop();

    const second = await start(await createSqlitePersistence({ location: file }));
    assert.equal(second.stockOf(), 7, 'the commit survived');
    assert.deepEqual(second.server.getState(STATE_LEDGER), [3], 'and the refused one did not');

    assert.equal((await second.take(2)).ok, true);
    await second.server.stop();

    const third = await start(await createSqlitePersistence({ location: file }));
    assert.equal(third.stockOf(), 5);
    assert.deepEqual(third.server.getState(STATE_LEDGER), [3, 2]);
    await third.server.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

sqlite('a durable transaction is atomic across states', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'axiom-sqlite-'));
  const file = path.join(directory, 'state.db');
  try {
    const { take, server } = await start(await createSqlitePersistence({ location: file }));
    await take(4);
    await take(99);
    await server.stop();

    const reopened = await createSqlitePersistence({ location: file });
    const stored = await reopened.load();
    const parts = stored.find((entry) => entry.stateId === STATE_PARTS)?.value as Array<
      Record<string, number>
    >;
    const ledger = stored.find((entry) => entry.stateId === STATE_LEDGER)?.value as number[];
    // 10 − 4, and one ledger line: never a debit without its line.
    assert.equal(parts[0][F_PART_STOCK], 6);
    assert.deepEqual(ledger, [4]);
    await reopened.close?.();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

sqlite('the durable adapter preserves identity and refuses a stale commit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'axiom-sqlite-'));
  try {
    const persistence = await createSqlitePersistence({
      location: path.join(directory, 'state.db'),
    });
    await persistence.commit({ writes: [{ stateId: STATE_PARTS, value: [{ a: 1 }] }], expected: {} });
    assert.equal(await persistence.revision(), 1);

    const stale = await persistence.commit({
      writes: [{ stateId: STATE_PARTS, value: [{ a: 2 }] }],
      expected: { [STATE_PARTS]: 0 },
    });
    assert.equal(stale.committed, false);
    assert.deepEqual((await persistence.load())[0].value, [{ a: 1 }]);
    await persistence.close?.();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
