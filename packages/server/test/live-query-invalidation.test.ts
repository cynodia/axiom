import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ApplicationGraph,
  binary,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  providerRecordFieldLocation,
  providerRecordLocation,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, QueryDef, StateDef } from '@cynodia/axiom-core';
import { GraphValidationError, compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryDataProvider,
  createSqliteDataProvider,
  createSqlitePersistence,
  isSqliteAvailable,
} from '@cynodia/axiom-server';
import type { AxiomServer, DataProvider, LiveQueryMessage, ServerRequest } from '@cynodia/axiom-server';

/**
 * spec13.1 F1 — the observable application revision. Deterministic, in-process coverage of
 * the invalidation mechanism (the real-OS-process proof is in
 * `live-query-cross-process.test.ts`). F2 — QueryDef / StateDef scope consistency.
 */

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_STATUS = fieldId('field_order_status');
const F_TOTAL = fieldId('field_order_total');
const S_AUDIT = nodeId('state_audit');
const Q_OPEN = nodeId('query_open');
const A_STATUS = nodeId('action_set_status');
const A_TOTAL = nodeId('action_set_total');
const A_REMOVE = nodeId('action_remove');
const A_MIXED = nodeId('action_mixed'); // provider-record + StateDef in one transaction
const ROW = nodeId('scope_row');
const P_ID = nodeId('param_id');
const P_STATUS = nodeId('param_status');
const P_TOTAL = nodeId('param_total');

function graph(): ApplicationGraph {
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
  g.addNode<StateDef>({ id: S_AUDIT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<QueryDef>({
    id: Q_OPEN,
    kind: 'query',
    source: E,
    rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);
  g.addNode<ActionDef>({
    id: A_STATUS,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_STATUS, valueType: primitiveType('string'), required: true },
    ],
    operations: [{ kind: 'set', target: providerRecordFieldLocation(E, F_ID, ref(P_ID), F_STATUS), value: ref(P_STATUS) }],
  });
  g.addNode<ActionDef>({
    id: A_TOTAL,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_TOTAL, valueType: primitiveType('number'), required: true },
    ],
    operations: [{ kind: 'set', target: providerRecordFieldLocation(E, F_ID, ref(P_ID), F_TOTAL), value: ref(P_TOTAL) }],
  });
  g.addNode<ActionDef>({
    id: A_REMOVE,
    kind: 'action',
    parameters: [{ id: P_ID, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'remove', target: providerRecordLocation(E, F_ID, ref(P_ID)) }],
  });
  g.addNode<ActionDef>({
    id: A_MIXED,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_STATUS, valueType: primitiveType('string'), required: true },
    ],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E, F_ID, ref(P_ID), F_STATUS), value: ref(P_STATUS) },
      { kind: 'set', target: stateLocation(S_AUDIT), value: binary('add', ref(S_AUDIT), literal(1)) },
    ],
  });
  return g;
}

const IR = compileToServerIR(graph());
const SEED = [
  { [F_ID]: 'a', [F_STATUS]: 'open', [F_TOTAL]: 30 },
  { [F_ID]: 'b', [F_STATUS]: 'closed', [F_TOTAL]: 10 },
  { [F_ID]: 'c', [F_STATUS]: 'open', [F_TOTAL]: 20 },
];
const invoke = (actionId: string, args: Record<string, unknown>): ServerRequest =>
  ({ kind: 'invoke', protocol: PROTOCOL_VERSION, actionId: nodeId(actionId), arguments: args }) as ServerRequest;
const ids = (rows: unknown[]) => rows.map((r) => String((r as Record<string, unknown>)[F_ID as unknown as string]));

// --------------------------------------------------------------------------- F1 unit

test('a provider-record insert / update / delete each advances the memory provider generation', async () => {
  const provider = createMemoryDataProvider({ rows: { [E]: SEED.map((r) => ({ ...r })) as never }, maxPageSize: 100 });
  assert.equal(provider.capabilities.mutationObservation, 'in-process');
  const g0 = await provider.observedMutationGeneration!();
  await provider.applyMutations!([{ entityId: E, identityFieldId: F_ID, identityValue: 'a', kind: 'set', row: { [F_ID]: 'a', [F_TOTAL]: 99 } }]);
  const g1 = await provider.observedMutationGeneration!();
  await provider.applyMutations!([{ entityId: E, identityFieldId: F_ID, identityValue: 'z', kind: 'set', row: { [F_ID]: 'z', [F_STATUS]: 'open', [F_TOTAL]: 5 } }]);
  const g2 = await provider.observedMutationGeneration!();
  await provider.applyMutations!([{ entityId: E, identityFieldId: F_ID, identityValue: 'z', kind: 'remove' }]);
  const g3 = await provider.observedMutationGeneration!();
  assert.ok(g1 > g0 && g2 > g1 && g3 > g2, `generation is monotone: ${g0} ${g1} ${g2} ${g3}`);
});

test('the SQLite provider generation is durable — a fresh handle to the same file reads it back', async (t) => {
  if (!(await isSqliteAvailable())) return t.skip('node:sqlite unavailable');
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-gen-'));
  try {
    const dataDb = path.join(dir, 'data.db');
    const first = await createSqliteDataProvider({ location: dataDb, entities: IR.entities ?? [], seed: { [E]: SEED as never }, maxPageSize: 100 });
    assert.equal(first.capabilities.mutationObservation, 'durable');
    await first.applyMutations!([{ entityId: E, identityFieldId: F_ID, identityValue: 'a', kind: 'set', row: { [F_ID]: 'a', [F_TOTAL]: 42 } }]);
    const durable = await first.observedMutationGeneration!();
    assert.ok(durable >= 1);
    const second = await createSqliteDataProvider({ location: dataDb, entities: IR.entities ?? [], maxPageSize: 100 });
    assert.equal(await second.observedMutationGeneration!(), durable, 'a separate connection sees the same durable generation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- F1 integration

async function nextMessage(it: AsyncIterator<LiveQueryMessage>, ms = 2000): Promise<LiveQueryMessage> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no live message in time')), ms);
  });
  try {
    const r = await Promise.race([it.next(), timeout]);
    assert.equal(r.done, false);
    return r.value as LiveQueryMessage;
  } finally {
    clearTimeout(timer!);
  }
}

test('revisionInspection keeps stateRevision and dataGeneration distinct; a provider-only commit moves only the latter', async () => {
  const s = createAxiomServer({
    ir: IR,
    host: createDeterministicServerHost({}),
    dataProvider: createMemoryDataProvider({ rows: { [E]: SEED.map((r) => ({ ...r })) as never }, maxPageSize: 100 }),
  });
  await s.start();
  try {
    const before = await s.revisionInspection();
    assert.equal(before.stateRevision, 0);
    await s.handle(invoke('action_set_status', { [P_ID]: 'b', [P_STATUS]: 'open' }));
    const after = await s.revisionInspection();
    assert.equal(after.stateRevision, 0, 'no StateDef was written');
    assert.ok(after.dataGeneration > before.dataGeneration, 'the provider generation advanced');
    assert.ok(after.applicationRevision > before.applicationRevision, 'the application revision advanced');

    // A mixed StateDef + provider transaction moves both.
    await s.handle(invoke('action_mixed', { [P_ID]: 'a', [P_STATUS]: 'closed' }));
    const mixed = await s.revisionInspection();
    assert.ok(mixed.stateRevision > after.stateRevision && mixed.dataGeneration > after.dataGeneration);
  } finally {
    await s.stop();
  }
});

test('two authorities over one shared SQLite file: a provider-record-only commit on A is seen by a live query on B (spec13.1 F1)', async (t) => {
  if (!(await isSqliteAvailable())) return t.skip('node:sqlite unavailable');
  const dir = mkdtempSync(path.join(tmpdir(), 'axiom-f1-inproc-'));
  try {
    const stateDb = path.join(dir, 'state.db');
    const dataDb = path.join(dir, 'data.db');
    // Seed once, then give each authority its own independent connection.
    await createSqliteDataProvider({ location: dataDb, entities: IR.entities ?? [], seed: { [E]: SEED as never }, maxPageSize: 100 });

    const make = async (): Promise<AxiomServer> => {
      const s = createAxiomServer({
        ir: IR,
        persistence: await createSqlitePersistence({ location: stateDb }),
        dataProvider: (await createSqliteDataProvider({ location: dataDb, entities: IR.entities ?? [], maxPageSize: 100 })) as DataProvider,
        liveQueryPollMs: 30,
      });
      await s.start();
      return s;
    };
    const a = await make();
    const b = await make();
    try {
      const opened = await b.openLiveQuery({ queryId: String(Q_OPEN) });
      assert.ok(!('error' in opened), JSON.stringify((opened as { error?: unknown }).error));
      const it = (opened as { [Symbol.asyncIterator](): AsyncIterator<LiveQueryMessage> })[Symbol.asyncIterator]();
      const initial = await nextMessage(it);
      assert.equal(initial.kind, 'initial');
      assert.deepEqual(ids((initial as { rows: unknown[] }).rows), ['c', 'a']);

      await a.handle(invoke('action_set_status', { [P_ID]: 'b', [P_STATUS]: 'open' }));
      // B has no StateDef change to observe — only the durable provider generation.
      let rows = ids((initial as { rows: unknown[] }).rows);
      for (let i = 0; i < 5 && !rows.includes('b'); i += 1) {
        const m = await nextMessage(it, 4000);
        if (m.kind === 'update') {
          for (const c of m.delta.changes) {
            if (c.kind === 'insert') rows.push(c.key);
            else if (c.kind === 'remove') rows = rows.filter((k) => k !== c.key);
            else if (c.kind === 'reset') rows = ids(c.rows);
          }
        } else if (m.kind === 'reset') {
          rows = ids(m.rows);
        }
      }
      assert.ok(rows.includes('b'), 'B observed the provider-record-only commit from A');
      assert.equal((await b.revisionInspection()).stateRevision, 0, 'via the provider generation, not a StateDef pulse');
      (opened as { close(): void }).close();
    } finally {
      await a.stop();
      await b.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a losing provider transaction does not expose speculative live state (spec13.1 §23, §66)', async () => {
  // A constraint makes a negative total illegal; the whole action (provider write included)
  // rolls back, so no generation advance and no live change.
  const g = graph();
  g.addNode({
    id: nodeId('constraint_nonneg'),
    kind: 'constraint',
    entityId: E,
    message: 'total must be >= 0',
    expression: binary('gte', field(ref(E), F_TOTAL), literal(0)),
  } as never);
  const s = createAxiomServer({
    ir: compileToServerIR(g),
    host: createDeterministicServerHost({}),
    dataProvider: createMemoryDataProvider({ rows: { [E]: SEED.map((r) => ({ ...r })) as never }, maxPageSize: 100 }),
  });
  await s.start();
  try {
    const before = await s.revisionInspection();
    const res = (await s.handle(invoke('action_set_total', { [P_ID]: 'a', [P_TOTAL]: -5 }))) as { ok?: boolean };
    assert.equal(res.ok, false, 'the constraint refused the action');
    const after = await s.revisionInspection();
    assert.equal(after.dataGeneration, before.dataGeneration, 'a losing transaction advances no observable generation');
  } finally {
    await s.stop();
  }
});

// ---------------------------------------------------------------------------- F2

test('compileToServerIR rejects a QueryDef whose clause references a StateDef (spec13.1 F2)', () => {
  const g = new ApplicationGraph('bad', 'Bad');
  g.addNode<EntityDef>({
    id: E,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<StateDef>({ id: S_AUDIT, kind: 'state', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<QueryDef>({
    id: Q_OPEN,
    kind: 'query',
    source: E,
    rowScopeId: ROW,
    filter: binary('gte', field(ref(ROW), F_TOTAL), ref(S_AUDIT)),
    pagination: { strategy: 'offset', maxPageSize: 50 },
  } as QueryDef);

  assert.throws(
    () => compileToServerIR(g),
    (error: unknown) => {
      assert.ok(error instanceof GraphValidationError);
      assert.ok(
        error.problems.some((problem) => problem.code === 'QUERY_STATE_REF_NOT_ALLOWED'),
        JSON.stringify(error.problems),
      );
      return true;
    },
  );
});

test('the runtime guard refuses a hand-built IR whose query references a StateDef (spec13.1 §81)', async () => {
  // Bypass validation by mutating a compiled IR to reintroduce a state ref.
  const ir = compileToServerIR(graph());
  const tampered = JSON.parse(JSON.stringify(ir));
  const q = tampered.queries.find((x: { id: string }) => x.id === String(Q_OPEN));
  q.filter = {
    kind: 'binary',
    operator: 'and',
    left: q.filter,
    right: { kind: 'binary', operator: 'gte', left: { kind: 'field', source: { kind: 'ref', targetId: String(ROW) }, fieldId: String(F_TOTAL) }, right: { kind: 'ref', targetId: String(S_AUDIT) } },
  };
  const s = createAxiomServer({
    ir: tampered,
    host: createDeterministicServerHost({}),
    dataProvider: createMemoryDataProvider({ rows: { [E]: SEED.map((r) => ({ ...r })) as never }, maxPageSize: 100 }),
  });
  await s.start();
  try {
    const res = (await s.handle({ kind: 'query', protocol: PROTOCOL_VERSION, queryId: nodeId(String(Q_OPEN)), arguments: {} } as never)) as {
      ok: boolean;
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(res.ok, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'QUERY_STATE_REF_NOT_ALLOWED'), JSON.stringify(res.diagnostics));
    const live = await s.openLiveQuery({ queryId: String(Q_OPEN) });
    assert.ok('error' in live && live.error.code === 'QUERY_STATE_REF_NOT_ALLOWED');
  } finally {
    await s.stop();
  }
});
