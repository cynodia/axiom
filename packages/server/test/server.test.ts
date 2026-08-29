import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  PRINCIPAL,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  find,
  forEach,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  object,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  Expression,
  RouteDef,
  StateDef,
  TransitionConstraintDef,
  ViewNode,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  SERVER_DIAGNOSTIC_CODES,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { InvokeResponse, PrincipalRecord, ServerEvent, SnapshotResponse } from '@cynodia/axiom-server';

/**
 * The authoritative runtime.
 *
 * The point of most of these tests is that the *existing* semantic guarantees hold when
 * execution moves across the trust boundary: a graph must not behave differently merely
 * because the authority is executing it.
 */

const ENTITY_USER = nodeId('entity_user');
const F_USER_ID = fieldId('field_user_id');
const F_USER_ROLE = fieldId('field_user_role');

const ENTITY_PART = nodeId('entity_part');
const F_PART_ID = fieldId('field_part_id');
const F_PART_STOCK = fieldId('field_part_stock');

const ENTITY_LINE = nodeId('entity_line');
const F_LINE_ID = fieldId('field_line_id');
const F_LINE_PART = fieldId('field_line_part');
const F_LINE_QUANTITY = fieldId('field_line_quantity');

const STATE_PARTS = nodeId('state_parts');
const STATE_LOG = nodeId('state_log');
const ACTION_RESERVE = nodeId('action_reserve');
const PARAM_PART = nodeId('param_part');
const PARAM_QUANTITY = nodeId('param_quantity');
const ACTION_RESERVE_MANY = nodeId('action_reserve_many');
const PARAM_LINES = nodeId('param_lines');
const SCOPE_LINE = nodeId('scope_line');
const SCOPE_PART = nodeId('scope_part');
const ACTION_ADMIN_ONLY = nodeId('action_admin_only');
const PARAM_ADMIN_STOCK = nodeId('param_admin_stock');
const CONSTRAINT_STOCK = nodeId('constraint_stock');
const TRANSITION_SEALED = nodeId('transition_sealed');

/** Stock of a part, read from authoritative state. */
const stockOfPart = (partExpression: Expression) =>
  field(
    find(ref(STATE_PARTS), SCOPE_PART, binary('eq', field(ref(SCOPE_PART), F_PART_ID), partExpression)),
    F_PART_STOCK,
  );

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('warehouse', 'Warehouse');
  graph.setPrincipalEntity(ENTITY_USER);

  graph.addNode<EntityDef>({
    id: ENTITY_USER,
    kind: 'entity',
    identityFieldId: F_USER_ID,
    fields: [
      { id: F_USER_ID, valueType: primitiveType('string'), required: true },
      { id: F_USER_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_LINE,
    kind: 'entity',
    identityFieldId: F_LINE_ID,
    fields: [
      { id: F_LINE_ID, valueType: primitiveType('string'), required: true },
      { id: F_LINE_PART, valueType: primitiveType('string'), required: true },
      { id: F_LINE_QUANTITY, valueType: primitiveType('number'), required: true },
    ],
  });
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
    initialValue: [
      { [F_PART_ID]: 'bolt', [F_PART_STOCK]: 10 },
      { [F_PART_ID]: 'nut', [F_PART_STOCK]: 5 },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE_LOG,
    kind: 'state',
    name: 'log',
    authority: 'server',
    serverOnly: true,
    valueType: collectionType(primitiveType('string')),
    initialValue: [],
  });

  graph.addNode<ActionDef>({
    id: ACTION_RESERVE,
    kind: 'action',
    name: 'reserve',
    parameters: [
      { id: PARAM_PART, valueType: primitiveType('string'), required: true },
      { id: PARAM_QUANTITY, valueType: primitiveType('number'), required: true },
    ],
    guards: [
      {
        condition: binary('gte', stockOfPart(ref(PARAM_PART)), ref(PARAM_QUANTITY)),
        failureMode: { code: 'insufficient-stock', message: 'Not enough stock.' },
      },
    ],
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_PARTS), identitySelector(F_PART_ID, ref(PARAM_PART))),
          F_PART_STOCK,
        ),
        value: binary('subtract', stockOfPart(ref(PARAM_PART)), ref(PARAM_QUANTITY)),
      },
      {
        kind: 'insert',
        target: stateLocation(STATE_LOG),
        value: call('concat', literal('reserved '), call('to-string', ref(PARAM_QUANTITY))),
      },
    ],
  });

  /** Iteration across several lines, to check provisional writes on the authority. */
  graph.addNode<ActionDef>({
    id: ACTION_RESERVE_MANY,
    kind: 'action',
    name: 'reserveMany',
    parameters: [
      { id: PARAM_LINES, valueType: collectionType(entityType(ENTITY_LINE)), required: true },
    ],
    operations: [
      forEach(ref(PARAM_LINES), SCOPE_LINE, [
        {
          kind: 'set',
          target: fieldLocation(
            itemLocation(
              stateLocation(STATE_PARTS),
              identitySelector(F_PART_ID, field(ref(SCOPE_LINE), F_LINE_PART)),
            ),
            F_PART_STOCK,
          ),
          value: binary(
            'subtract',
            stockOfPart(field(ref(SCOPE_LINE), F_LINE_PART)),
            field(ref(SCOPE_LINE), F_LINE_QUANTITY),
          ),
        },
      ]),
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_ADMIN_ONLY,
    kind: 'action',
    name: 'setStock',
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin')),
    parameters: [
      { id: PARAM_PART, valueType: primitiveType('string'), required: true },
      { id: PARAM_ADMIN_STOCK, valueType: primitiveType('number'), required: true },
    ],
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_PARTS), identitySelector(F_PART_ID, ref(PARAM_PART))),
          F_PART_STOCK,
        ),
        value: ref(PARAM_ADMIN_STOCK),
      },
    ],
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_STOCK,
    kind: 'constraint',
    name: 'Stock is never negative',
    entityId: ENTITY_PART,
    message: 'Stock can never fall below zero.',
    expression: binary('gte', field(ref(ENTITY_PART), F_PART_STOCK), literal(0)),
  });
  graph.addNode<TransitionConstraintDef>({
    id: TRANSITION_SEALED,
    kind: 'transition-constraint',
    name: 'Stock only ever falls',
    entityId: ENTITY_PART,
    previousScopeId: nodeId('scope_previous'),
    proposedScopeId: nodeId('scope_proposed'),
    message: 'Stock may not be raised except by an administrator.',
    expression: binary(
      'lte',
      field(ref(nodeId('scope_proposed')), F_PART_STOCK),
      field(ref(nodeId('scope_previous')), F_PART_STOCK),
    ),
  });

  graph.addNode<ViewNode>({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

const CLERK: PrincipalRecord = { [F_USER_ID]: 'u1', [F_USER_ROLE]: 'clerk' };
const ADMIN: PrincipalRecord = { [F_USER_ID]: 'u2', [F_USER_ROLE]: 'admin' };

interface Harness {
  server: ReturnType<typeof createAxiomServer>;
  events: ServerEvent[];
  invoke(
    actionId: ReturnType<typeof nodeId>,
    args?: Record<string, unknown>,
    options?: { credential?: string; requestId?: string },
  ): Promise<InvokeResponse>;
}

async function harness(
  overrides: { principals?: Record<string, PrincipalRecord>; persistence?: ReturnType<typeof createMemoryPersistence> } = {},
): Promise<Harness> {
  const principals = overrides.principals ?? { clerk: CLERK, admin: ADMIN };
  const events: ServerEvent[] = [];
  const server = createAxiomServer({
    ir: compileToServerIR(buildGraph()),
    persistence: overrides.persistence ?? createMemoryPersistence(),
    host: createDeterministicServerHost({
      authenticate: (credential) => (credential ? principals[credential] ?? null : null),
      report: (event) => events.push(event),
    }),
  });
  await server.start();
  return {
    server,
    events,
    async invoke(actionId, args = {}, options = {}) {
      const response = await server.handle({
        kind: 'invoke',
        protocol: PROTOCOL_VERSION,
        actionId,
        arguments: args,
        ...(options.credential ? { credential: options.credential } : {}),
        ...(options.requestId ? { requestId: options.requestId } : {}),
      });
      assert.equal(response.kind, 'result');
      return response as InvokeResponse;
    },
  };
}

const stockOf = (server: Harness['server'], partId: string): number =>
  (server.getState(STATE_PARTS) as Array<Record<string, number>>).find(
    (part) => (part[F_PART_ID] as unknown as string) === partId,
  )?.[F_PART_STOCK] as number;

// -------------------------------------------------------------------- the graph

test('a server-capable graph is valid, and its two halves compile', () => {
  const graph = buildGraph();
  const result = validateGraph(graph);
  assert.deepEqual(result.errors, []);

  const ir = compileToServerIR(graph);
  assert.equal(ir.contract, 'axiom.server.v1');
  assert.deepEqual(Object.keys(ir.actions).sort(), [ACTION_ADMIN_ONLY, ACTION_RESERVE, ACTION_RESERVE_MANY].sort());
  assert.deepEqual(ir.observableStateIds, [STATE_PARTS], 'the log is server-only');
  assert.equal(ir.principalEntityId, ENTITY_USER);
});

/** Sections 8 and 36. */
test('the Server IR is portable data, and survives a round trip unchanged', () => {
  const ir = compileToServerIR(buildGraph());
  const serialized = JSON.stringify(ir);

  assert.doesNotMatch(serialized, /=>|\bfunction\b\(/, 'no closure could survive serialization');
  assert.doesNotMatch(serialized, /"kind":"(view|container|text|repeat|form|input|button)"/, 'no UI');
  assert.doesNotMatch(serialized, /presentation|theme|axiom-/, 'no presentation');
  assert.deepEqual(JSON.parse(serialized), ir);

  // And the round-tripped IR executes identically.
  const restored = JSON.parse(serialized) as typeof ir;
  const server = createAxiomServer({ ir: restored, host: createDeterministicServerHost() });
  assert.doesNotThrow(() => server.snapshot());
});

test('a runtime refuses an IR whose contract it does not know', () => {
  const ir = { ...compileToServerIR(buildGraph()), contract: 'axiom.server.v99' };
  assert.throws(() => createAxiomServer({ ir: ir as never }), /Unsupported Server IR contract/);
});

// ------------------------------------------------------- semantics must match

test('an authoritative action commits its whole transaction', async () => {
  const { server, invoke } = await harness();
  const answer = await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 3 });

  assert.equal(answer.ok, true, JSON.stringify(answer.diagnostics));
  assert.equal(stockOf(server, 'bolt'), 7);
  assert.deepEqual(answer.changes[STATE_PARTS], server.getState(STATE_PARTS));
  assert.equal(answer.changes[STATE_LOG], undefined, 'a server-only state is never returned');
});

test('a refused guard names the failure mode, exactly as it does locally', async () => {
  const { server, invoke } = await harness();
  const answer = await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 99 });

  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].code, 'PRECONDITION_FAILED');
  assert.equal(answer.diagnostics[0].details?.failureMode, 'insufficient-stock');
  assert.equal(answer.diagnostics[0].message, 'Not enough stock.');
  assert.equal(stockOf(server, 'bolt'), 10, 'nothing was mutated');
});

test('a broken invariant rolls the whole authoritative transaction back', async () => {
  const { server, invoke } = await harness();
  // The guard passes for each line individually; together they exceed the stock.
  const answer = await invoke(ACTION_RESERVE_MANY, {
    [PARAM_LINES]: [
      { [F_LINE_ID]: 'l1', [F_LINE_PART]: 'nut', [F_LINE_QUANTITY]: 3 },
      { [F_LINE_ID]: 'l2', [F_LINE_PART]: 'nut', [F_LINE_QUANTITY]: 3 },
    ],
  });

  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics.some((d) => d.code === 'CONSTRAINT_VIOLATION'), true);
  assert.equal(stockOf(server, 'nut'), 5, 'the first debit did not survive the second');
});

/** Section 6: iteration N observes writes from iterations < N, on the authority too. */
test('for-each iterations see each other on the authority', async () => {
  const { server, invoke } = await harness();
  const answer = await invoke(ACTION_RESERVE_MANY, {
    [PARAM_LINES]: [
      { [F_LINE_ID]: 'l1', [F_LINE_PART]: 'bolt', [F_LINE_QUANTITY]: 4 },
      { [F_LINE_ID]: 'l2', [F_LINE_PART]: 'bolt', [F_LINE_QUANTITY]: 4 },
    ],
  });
  assert.equal(answer.ok, true, JSON.stringify(answer.diagnostics));
  assert.equal(stockOf(server, 'bolt'), 2, '10 − 4 − 4, not 10 − 4 twice');
});

test('a transition rule holds on the authority', async () => {
  const { server, invoke } = await harness();
  const answer = await invoke(
    ACTION_ADMIN_ONLY,
    { [PARAM_PART]: 'bolt', [PARAM_ADMIN_STOCK]: 50 },
    { credential: 'admin' },
  );
  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].code, 'TRANSITION_CONSTRAINT_VIOLATION');
  assert.equal(stockOf(server, 'bolt'), 10);
});

test('the mutation log records outcomes, rolled-back attempts included', async () => {
  const { server, invoke } = await harness();
  await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 99 });
  await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 1 });

  const log = server.mutationLog();
  assert.ok(log.some((entry) => entry.outcome === 'committed'));
  assert.equal(
    log.every((entry) => entry.outcome !== undefined),
    true,
    'every attempt has settled',
  );
});

// ------------------------------------------------------------- authorization

test('an unauthorized caller is refused before anything runs', async () => {
  const { server, invoke } = await harness();
  const answer = await invoke(
    ACTION_ADMIN_ONLY,
    { [PARAM_PART]: 'bolt', [PARAM_ADMIN_STOCK]: 1 },
    { credential: 'clerk' },
  );

  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_DENIED);
  assert.equal(stockOf(server, 'bolt'), 10);
});

test('an anonymous caller cannot satisfy an authorization rule', async () => {
  const { invoke } = await harness();
  const answer = await invoke(ACTION_ADMIN_ONLY, { [PARAM_PART]: 'bolt', [PARAM_ADMIN_STOCK]: 1 });
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_DENIED);
});

test('an authorized caller passes, and the rule is the only gate it passes', async () => {
  const { invoke } = await harness();
  // Authorization allows it; the transition rule still refuses raising stock.
  const raised = await invoke(
    ACTION_ADMIN_ONLY,
    { [PARAM_PART]: 'bolt', [PARAM_ADMIN_STOCK]: 20 },
    { credential: 'admin' },
  );
  assert.equal(raised.diagnostics[0].code, 'TRANSITION_CONSTRAINT_VIOLATION');

  const lowered = await invoke(
    ACTION_ADMIN_ONLY,
    { [PARAM_PART]: 'bolt', [PARAM_ADMIN_STOCK]: 4 },
    { credential: 'admin' },
  );
  assert.equal(lowered.ok, true, JSON.stringify(lowered.diagnostics));
});

test('an action with no authorization rule is open to any caller', async () => {
  const { invoke } = await harness();
  const answer = await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 1 });
  assert.equal(answer.ok, true);
});

// -------------------------------------------------------- argument validation

test('arguments are validated against their declared types', async () => {
  const { invoke } = await harness();

  const wrongType = await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 'lots' });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.ARGUMENT_TYPE_MISMATCH);

  const missing = await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt' });
  assert.equal(missing.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.ARGUMENT_TYPE_MISMATCH);

  const unknown = await invoke(ACTION_RESERVE, {
    [PARAM_PART]: 'bolt',
    [PARAM_QUANTITY]: 1,
    smuggled: 'value',
  });
  assert.equal(unknown.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.ARGUMENT_TYPE_MISMATCH);
});

test('a structured argument is validated all the way down', async () => {
  const { invoke } = await harness();
  const answer = await invoke(ACTION_RESERVE_MANY, {
    // Keyed by field name rather than field id, and missing a required field.
    [PARAM_LINES]: [{ part: 'bolt', quantity: 1 }],
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.ARGUMENT_TYPE_MISMATCH);
  assert.match(answer.diagnostics.map((d) => d.message).join(' '), /keyed by field id/);
});

// ------------------------------------------------------------------- protocol

test('an unknown action is refused without disclosing anything', async () => {
  const { invoke } = await harness();
  const answer = await invoke(nodeId('action_does_not_exist'));
  assert.equal(answer.ok, false);
  assert.equal(answer.diagnostics[0].code, SERVER_DIAGNOSTIC_CODES.UNKNOWN_SERVER_ACTION);
});

test('a malformed or foreign request is refused', async () => {
  const { server } = await harness();
  const wrongProtocol = await server.handle({ kind: 'invoke', protocol: 'other', actionId: ACTION_RESERVE } as never);
  assert.equal(wrongProtocol.kind, 'error');

  const wrongKind = await server.handle({ kind: 'mutate', protocol: PROTOCOL_VERSION } as never);
  assert.equal(wrongKind.kind, 'error');
});

test('a snapshot returns observable state and nothing else', async () => {
  const { server } = await harness();
  const answer = (await server.handle({ kind: 'snapshot', protocol: PROTOCOL_VERSION })) as SnapshotResponse;

  assert.equal(answer.kind, 'snapshot');
  assert.deepEqual(Object.keys(answer.snapshot.states), [STATE_PARTS]);
  assert.equal(STATE_LOG in answer.snapshot.states, false);
});

// ---------------------------------------------------------------- idempotency

/** Section 49. */
test('a retried request is answered, not executed again', async () => {
  const { server, invoke } = await harness();
  const first = await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 3 }, { requestId: 'r-1' });
  assert.equal(first.ok, true);
  assert.equal(stockOf(server, 'bolt'), 7);

  const retry = await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 3 }, { requestId: 'r-1' });
  assert.equal(retry.ok, true);
  assert.equal(retry.replayed, true);
  assert.equal(stockOf(server, 'bolt'), 7, 'the action did not run a second time');
});

test('a different request id executes again', async () => {
  const { server, invoke } = await harness();
  await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 3 }, { requestId: 'r-1' });
  await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 3 }, { requestId: 'r-2' });
  assert.equal(stockOf(server, 'bolt'), 4);
});

// ----------------------------------------------------------------- concurrency

/** Section 40 and 46: two callers must not both commit from the same stock. */
test('concurrent actions cannot both commit from the same snapshot', async () => {
  const { server, invoke } = await harness();
  await invoke(ACTION_ADMIN_ONLY, { [PARAM_PART]: 'bolt', [PARAM_ADMIN_STOCK]: 5 }, { credential: 'admin' });
  assert.equal(stockOf(server, 'bolt'), 5);

  const [a, b] = await Promise.all([
    invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 4 }),
    invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 4 }),
  ]);

  const committed = [a, b].filter((answer) => answer.ok);
  assert.equal(committed.length, 1, 'exactly one may commit');
  assert.equal(stockOf(server, 'bolt'), 1);
  const refused = [a, b].find((answer) => !answer.ok);
  assert.equal(refused?.diagnostics[0].code, 'PRECONDITION_FAILED');
});

test('many concurrent requests never oversell', async () => {
  const { server, invoke } = await harness();
  const answers = await Promise.all(
    Array.from({ length: 12 }, () => invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 1 })),
  );
  assert.equal(answers.filter((answer) => answer.ok).length, 10, 'exactly the stock that existed');
  assert.equal(stockOf(server, 'bolt'), 0);
});

test('after a remote commit, the authority reconciles and the next action runs from the winning state (spec12.1 F1)', async () => {
  const persistence = createMemoryPersistence();
  const { server, invoke } = await harness({ persistence });
  await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 1 });

  // Something else committed to the same store — another authority sharing it.
  await persistence.commit({
    writes: [{ stateId: STATE_PARTS, value: [{ [F_PART_ID]: 'bolt', [F_PART_STOCK]: 99 }] }],
    expected: { [STATE_PARTS]: 1 },
  });

  // spec12.1 §11, §14: this authority MUST NOT stay wedged on the stale revision. It
  // reconciles to the durable state before executing, so the action succeeds from 99.
  const answer = await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 1 });
  assert.equal(answer.ok, true, 'the authority is not permanently wedged');
  assert.equal(stockOf(server, 'bolt'), 98, 'it ran from the winning durable value, not its stale copy');

  const snap = await server.coherentSnapshot();
  assert.ok(snap.revision >= 3);
});

// --------------------------------------------------------------- observability

/** Section 50. */
test('the authority reports structured execution information', async () => {
  const { events, invoke } = await harness();
  await invoke(ACTION_RESERVE, { [PARAM_PART]: 'bolt', [PARAM_QUANTITY]: 1 }, { requestId: 'r-9' });
  await invoke(ACTION_ADMIN_ONLY, { [PARAM_PART]: 'bolt', [PARAM_ADMIN_STOCK]: 1 }, { credential: 'clerk' });

  const invoked = events.find((event) => event.kind === 'invoke');
  assert.ok(invoked);
  assert.equal(invoked.actionId, ACTION_RESERVE);
  assert.equal(invoked.ok, true);
  assert.equal(invoked.requestId, 'r-9');
  assert.deepEqual(invoked.committed, [STATE_PARTS, STATE_LOG], 'including the server-only log');
  assert.equal(typeof invoked.durationMs, 'number');
  assert.equal(typeof invoked.revision, 'number');

  const rejected = events.find((event) => event.kind === 'reject');
  assert.equal(rejected?.actionId, ACTION_ADMIN_ONLY);
  assert.equal(rejected?.principal, 'u1', 'the identity, not the whole principal record');
});

