import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the portable conformance fixtures.
 *
 * A fixture is **pure data**: a Server IR, the state it starts from, the invocations to
 * perform, and the results expected. Nothing in it is TypeScript, and running it needs no
 * part of this implementation — which is the point. A conforming runtime in another
 * language should be able to take these files and nothing else.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const compiler = await import(path.join(repoRoot, 'packages/compiler/dist/index.js'));

const {
  ApplicationGraph, PRINCIPAL, binary, call, collectionType, effectOutcomeEntity, entityType,
  field, fieldId, fieldLocation, find, forEach, identitySelector, itemLocation, literal,
  nodeId, object, optionalType, primitiveType, ref, some, stateLocation, validateGraph,
  EFFECT_ID_FIELD, EFFECT_INTEGRATION_ID_FIELD, EFFECT_MESSAGE_FIELD, EFFECT_OPERATION_ID_FIELD,
  EFFECT_RESULT_FIELD,
  BLOB_KEY_FIELD, blobRefEntity, itemFieldLocation,
} = core;

const E_USER = nodeId('entity_user');
const F_USER_ID = fieldId('field_user_id');
const F_USER_ROLE = fieldId('field_user_role');
const E_PART = nodeId('entity_part');
const F_PART_ID = fieldId('field_part_id');
const F_PART_STOCK = fieldId('field_part_stock');
const E_LINE = nodeId('entity_line');
const F_LINE_ID = fieldId('field_line_id');
const F_LINE_PART = fieldId('field_line_part');
const F_LINE_QTY = fieldId('field_line_qty');

const S_PARTS = nodeId('state_parts');
const S_LEDGER = nodeId('state_ledger');
const S_TOTAL = nodeId('state_total');
const A_TAKE = nodeId('action_take');
const A_TAKE_MANY = nodeId('action_take_many');
const A_SET = nodeId('action_set_stock');
const P_PART = nodeId('param_part');
const P_QTY = nodeId('param_qty');
const P_LINES = nodeId('param_lines');
const P_STOCK = nodeId('param_stock');
const SC_PART = nodeId('scope_part');
const SC_LINE = nodeId('scope_line');
const SC_TOTAL = nodeId('scope_total');
const C_STOCK = nodeId('constraint_stock');
const T_FALLS = nodeId('transition_falls');
const SC_PREV = nodeId('scope_previous');
const SC_NEXT = nodeId('scope_proposed');

const stockOf = (part) =>
  field(find(ref(S_PARTS), SC_PART, binary('eq', field(ref(SC_PART), F_PART_ID), part)), F_PART_STOCK);

/** One graph, exercising every semantic area the suite must cover. */
function buildGraph() {
  const graph = new ApplicationGraph('conformance', 'Conformance', '0.6.0');
  graph.setPrincipalEntity(E_USER);

  graph.addNode({ id: E_USER, kind: 'entity', identityFieldId: F_USER_ID, fields: [
    { id: F_USER_ID, valueType: primitiveType('string'), required: true },
    { id: F_USER_ROLE, valueType: primitiveType('string'), required: true }] });
  graph.addNode({ id: E_PART, kind: 'entity', identityFieldId: F_PART_ID, fields: [
    { id: F_PART_ID, valueType: primitiveType('string'), required: true },
    { id: F_PART_STOCK, valueType: primitiveType('number'), required: true }] });
  graph.addNode({ id: E_LINE, kind: 'entity', identityFieldId: F_LINE_ID, fields: [
    { id: F_LINE_ID, valueType: primitiveType('string'), required: true },
    { id: F_LINE_PART, valueType: primitiveType('string'), required: true },
    { id: F_LINE_QTY, valueType: primitiveType('number'), required: true }] });

  graph.addNode({ id: S_PARTS, kind: 'state', name: 'parts', authority: 'server',
    valueType: collectionType(entityType(E_PART)),
    initialValue: [{ [F_PART_ID]: 'bolt', [F_PART_STOCK]: 10 }, { [F_PART_ID]: 'nut', [F_PART_STOCK]: 5 }] });
  graph.addNode({ id: S_LEDGER, kind: 'state', name: 'ledger', authority: 'server',
    valueType: collectionType(primitiveType('number')), initialValue: [] });
  graph.addNode({ id: S_TOTAL, kind: 'state', name: 'total', authority: 'server',
    valueType: primitiveType('number'),
    derivation: call('sum', core.map(ref(S_PARTS), SC_TOTAL, field(ref(SC_TOTAL), F_PART_STOCK))) });

  graph.addNode({ id: A_TAKE, kind: 'action', name: 'take',
    parameters: [
      { id: P_PART, valueType: primitiveType('string'), required: true },
      { id: P_QTY, valueType: primitiveType('number'), required: true }],
    guards: [
      { condition: binary('gt', ref(P_QTY), literal(0)),
        failureMode: { code: 'invalid-quantity', message: 'A quantity must be above zero.' } },
      { condition: binary('gte', stockOf(ref(P_PART)), ref(P_QTY)),
        failureMode: { code: 'insufficient-stock', message: 'Not enough stock.' } }],
    operations: [
      { kind: 'set',
        target: fieldLocation(itemLocation(stateLocation(S_PARTS), identitySelector(F_PART_ID, ref(P_PART))), F_PART_STOCK),
        value: binary('subtract', stockOf(ref(P_PART)), ref(P_QTY)) },
      { kind: 'insert', target: stateLocation(S_LEDGER), value: ref(P_QTY) }] });

  graph.addNode({ id: A_TAKE_MANY, kind: 'action', name: 'takeMany',
    parameters: [{ id: P_LINES, valueType: collectionType(entityType(E_LINE)), required: true }],
    operations: [forEach(ref(P_LINES), SC_LINE, [
      { kind: 'set',
        target: fieldLocation(itemLocation(stateLocation(S_PARTS),
          identitySelector(F_PART_ID, field(ref(SC_LINE), F_LINE_PART))), F_PART_STOCK),
        value: binary('subtract', stockOf(field(ref(SC_LINE), F_LINE_PART)), field(ref(SC_LINE), F_LINE_QTY)) }])] });

  graph.addNode({ id: A_SET, kind: 'action', name: 'setStock',
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin')),
    parameters: [
      { id: P_PART, valueType: primitiveType('string'), required: true },
      { id: P_STOCK, valueType: primitiveType('number'), required: true }],
    operations: [
      { kind: 'set',
        target: fieldLocation(itemLocation(stateLocation(S_PARTS), identitySelector(F_PART_ID, ref(P_PART))), F_PART_STOCK),
        value: ref(P_STOCK) }] });

  graph.addNode({ id: C_STOCK, kind: 'constraint', name: 'Stock is never negative', entityId: E_PART,
    message: 'Stock can never fall below zero.',
    expression: binary('gte', field(ref(E_PART), F_PART_STOCK), literal(0)) });
  graph.addNode({ id: T_FALLS, kind: 'transition-constraint', name: 'Stock only falls', entityId: E_PART,
    previousScopeId: SC_PREV, proposedScopeId: SC_NEXT,
    message: 'Stock may not be raised.',
    expression: binary('lte', field(ref(SC_NEXT), F_PART_STOCK), field(ref(SC_PREV), F_PART_STOCK)) });

  graph.addNode({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

const graph = buildGraph();
const validation = validateGraph(graph);
if (!validation.valid) {
  console.error(validation.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  process.exit(1);
}
const serverIR = compiler.compileToServerIR(graph);

// --------------------------------------------------------------------------------------
// v3/v4 vocabulary: integrations, effects, triggers and invocation-source restriction.
// A second, independent graph — the v1 suite above stays byte-identical (spec 8.1 §50-52,
// "do not widen frozen contracts silently").
// --------------------------------------------------------------------------------------

const INT_STATE_STATUS = nodeId('state_status');
const INT_STATE_MESSAGE = nodeId('state_message');
const INT_INTEGRATION = nodeId('integration_provider');
const INT_OP_FETCH = nodeId('integration_operation_fetch');
const INT_OP_REBOOT = nodeId('integration_operation_reboot');
const INT_ENTITY_OUTCOME = nodeId('entity_effect_outcome');
const INT_EVENT_SUCCEEDED = nodeId('event_succeeded');
const INT_EVENT_FAILED = nodeId('event_failed');
const INT_ACTION_REFRESH = nodeId('action_refresh');
const INT_ACTION_REBOOT = nodeId('action_reboot');
const INT_ACTION_APPLY_MESSAGE = nodeId('action_apply_message');
const INT_PARAM_MESSAGE = nodeId('param_message');
const INT_SCOPE_QUERY = nodeId('scope_query');
const INT_TRIGGER_POLL = nodeId('trigger_poll');
const INT_TRIGGER_SUCCEEDED = nodeId('trigger_succeeded');
const INT_TRIGGER_FAILED = nodeId('trigger_failed');

// 8.2 additions (spec 8.2 §11-12): a guarded record + constraint (rollback-suppresses-
// effect), a counter bumped by two simultaneous delay triggers (scheduling parity), and a
// verified-external-event → system-only-action pair (the webhook semantic fixture).
const INT_ENTITY_GUARD = nodeId('entity_guard');
const F_GUARD_ID = fieldId('field_guard_id');
const F_GUARD_VALUE = fieldId('field_guard_value');
const INT_STATE_GUARD = nodeId('state_guard');
const INT_CONSTRAINT_GUARD = nodeId('constraint_guard');
const INT_ACTION_GUARDED_REBOOT = nodeId('action_guarded_reboot');
const INT_STATE_COUNTER = nodeId('state_counter');
const INT_ACTION_BUMP_A = nodeId('action_bump_a');
const INT_ACTION_BUMP_B = nodeId('action_bump_b');
const INT_TRIGGER_BUMP_A = nodeId('trigger_bump_a');
const INT_TRIGGER_BUMP_B = nodeId('trigger_bump_b');
const INT_EVENT_EXTERNAL_STATUS = nodeId('event_external_status');
const INT_ACTION_APPLY_EXTERNAL_STATUS = nodeId('action_apply_external_status');
const INT_PARAM_STATUS = nodeId('param_status');
const INT_TRIGGER_EXTERNAL_STATUS = nodeId('trigger_external_status');

/** Every operation/trigger/effect-outcome/invocation-source construct 8.1 hardens. */
function buildIntegrationGraph() {
  const graph = new ApplicationGraph('conformance-integrations', 'Conformance integrations');

  graph.addNode({ id: INT_STATE_STATUS, kind: 'state', name: 'status', authority: 'server',
    valueType: primitiveType('string'), initialValue: 'unknown' });
  graph.addNode({ id: INT_STATE_MESSAGE, kind: 'state', name: 'message', authority: 'server',
    valueType: primitiveType('string'), initialValue: '' });

  graph.addNode({ id: INT_INTEGRATION, kind: 'integration', name: 'Provider' });
  graph.addNode({ id: INT_OP_FETCH, kind: 'integration-operation', integrationId: INT_INTEGRATION,
    name: 'fetchStatus', mode: 'query', resultType: primitiveType('string') });
  graph.addNode({ id: INT_OP_REBOOT, kind: 'integration-operation', integrationId: INT_INTEGRATION,
    name: 'reboot', mode: 'effect', idempotent: true, resultType: primitiveType('string'),
    retry: { policy: 'fixed', maxAttempts: 3, delayMs: 50 } });

  graph.addNode(effectOutcomeEntity(INT_ENTITY_OUTCOME, primitiveType('string')));
  graph.addNode({ id: INT_EVENT_SUCCEEDED, kind: 'event', payloadType: entityType(INT_ENTITY_OUTCOME) });
  graph.addNode({ id: INT_EVENT_FAILED, kind: 'event', payloadType: entityType(INT_ENTITY_OUTCOME) });

  graph.addNode({ id: INT_ACTION_REFRESH, kind: 'action', name: 'refresh',
    operations: [
      { kind: 'integration-query', operationId: INT_OP_FETCH, bindAs: INT_SCOPE_QUERY, timeoutMs: 500 },
      { kind: 'set', target: stateLocation(INT_STATE_STATUS), value: ref(INT_SCOPE_QUERY) }] });

  graph.addNode({ id: INT_ACTION_REBOOT, kind: 'action', name: 'reboot',
    operations: [
      { kind: 'integration-effect', operationId: INT_OP_REBOOT,
        succeededEventId: INT_EVENT_SUCCEEDED, failedEventId: INT_EVENT_FAILED }] });

  graph.addNode({ id: INT_ACTION_APPLY_MESSAGE, kind: 'action', name: 'apply message',
    // System-only (spec 8.1 §3-9): only the effect outcome events above may reach this.
    invocation: { allowedSources: ['system'] },
    parameters: [{ id: INT_PARAM_MESSAGE, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(INT_STATE_MESSAGE), value: ref(INT_PARAM_MESSAGE) }] });

  graph.addNode({ id: INT_TRIGGER_POLL, kind: 'trigger', actionId: INT_ACTION_REFRESH,
    when: { kind: 'interval', everyMs: 1000, overlap: 'skip' } });
  graph.addNode({ id: INT_TRIGGER_SUCCEEDED, kind: 'trigger', actionId: INT_ACTION_APPLY_MESSAGE,
    when: { kind: 'event', eventId: INT_EVENT_SUCCEEDED },
    arguments: { [INT_PARAM_MESSAGE]: field(ref(INT_TRIGGER_SUCCEEDED), EFFECT_RESULT_FIELD) } });
  graph.addNode({ id: INT_TRIGGER_FAILED, kind: 'trigger', actionId: INT_ACTION_APPLY_MESSAGE,
    when: { kind: 'event', eventId: INT_EVENT_FAILED },
    arguments: { [INT_PARAM_MESSAGE]: field(ref(INT_TRIGGER_FAILED), EFFECT_MESSAGE_FIELD) } });

  // A guarded record + constraint, so an action that both writes it invalid AND records an
  // effect intent demonstrates the whole transaction — mutation and effect intent alike —
  // rolls back together (spec 8.2 §11 item 6).
  graph.addNode({ id: INT_ENTITY_GUARD, kind: 'entity', identityFieldId: F_GUARD_ID, fields: [
    { id: F_GUARD_ID, valueType: primitiveType('string'), required: true },
    { id: F_GUARD_VALUE, valueType: primitiveType('number'), required: true }] });
  graph.addNode({ id: INT_STATE_GUARD, kind: 'state', name: 'guard', authority: 'server',
    valueType: collectionType(entityType(INT_ENTITY_GUARD)),
    initialValue: [{ [F_GUARD_ID]: 'g1', [F_GUARD_VALUE]: 1 }] });
  graph.addNode({ id: INT_CONSTRAINT_GUARD, kind: 'constraint', entityId: INT_ENTITY_GUARD,
    message: 'Guard value must stay below 10.',
    expression: binary('lt', field(ref(INT_ENTITY_GUARD), F_GUARD_VALUE), literal(10)) });
  graph.addNode({ id: INT_ACTION_GUARDED_REBOOT, kind: 'action', name: 'guardedReboot',
    operations: [
      { kind: 'set',
        target: fieldLocation(itemLocation(stateLocation(INT_STATE_GUARD), identitySelector(F_GUARD_ID, literal('g1'))), F_GUARD_VALUE),
        value: literal(999) },
      { kind: 'integration-effect', operationId: INT_OP_REBOOT,
        succeededEventId: INT_EVENT_SUCCEEDED, failedEventId: INT_EVENT_FAILED }] });

  // Two one-shot delay triggers due at the same simulated instant, bumping a shared
  // counter — the deterministic/real-host scheduling-parity guarantee (spec 8.1 §26-30),
  // as a portable fixture (spec 8.2 §11 item 5).
  graph.addNode({ id: INT_STATE_COUNTER, kind: 'state', name: 'counter', authority: 'server',
    valueType: primitiveType('number'), initialValue: 0 });
  graph.addNode({ id: INT_ACTION_BUMP_A, kind: 'action', name: 'bumpA',
    operations: [{ kind: 'set', target: stateLocation(INT_STATE_COUNTER), value: binary('add', ref(INT_STATE_COUNTER), literal(1)) }] });
  graph.addNode({ id: INT_ACTION_BUMP_B, kind: 'action', name: 'bumpB',
    operations: [{ kind: 'set', target: stateLocation(INT_STATE_COUNTER), value: binary('add', ref(INT_STATE_COUNTER), literal(1)) }] });
  graph.addNode({ id: INT_TRIGGER_BUMP_A, kind: 'trigger', actionId: INT_ACTION_BUMP_A, when: { kind: 'delay', afterMs: 10 } });
  graph.addNode({ id: INT_TRIGGER_BUMP_B, kind: 'trigger', actionId: INT_ACTION_BUMP_B, when: { kind: 'delay', afterMs: 10 } });

  // A verified external event → a system-only action, the semantic boundary a webhook sits
  // behind (spec 8.2 §12). HTTP delivery and signature verification are host/adapter
  // concerns (spec §53) and are deliberately absent — an `event` step models "already
  // verified", exactly as the fixture format's steps vocabulary intends.
  graph.addNode({ id: INT_EVENT_EXTERNAL_STATUS, kind: 'event', payloadType: primitiveType('string') });
  graph.addNode({ id: INT_ACTION_APPLY_EXTERNAL_STATUS, kind: 'action', name: 'applyExternalStatus',
    invocation: { allowedSources: ['system'] },
    parameters: [{ id: INT_PARAM_STATUS, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(INT_STATE_STATUS), value: ref(INT_PARAM_STATUS) }] });
  graph.addNode({ id: INT_TRIGGER_EXTERNAL_STATUS, kind: 'trigger', actionId: INT_ACTION_APPLY_EXTERNAL_STATUS,
    when: { kind: 'event', eventId: INT_EVENT_EXTERNAL_STATUS },
    arguments: { [INT_PARAM_STATUS]: ref(INT_TRIGGER_EXTERNAL_STATUS) } });

  return graph;
}

const integrationGraph = buildIntegrationGraph();
const integrationValidation = validateGraph(integrationGraph);
if (!integrationValidation.valid) {
  console.error(integrationValidation.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  process.exit(1);
}
const integrationServerIR = compiler.compileToServerIR(integrationGraph);

// A dedicated, trigger-free graph for the late-query fixtures: `integrationServerIR` above
// carries a 1000ms poll trigger, which a fixture advancing virtual time past 1000ms would
// incidentally also fire, consuming a second scripted response and hanging on a `neverSettle`-
// like unresolved timer nothing ever advances to. Isolating this graph avoids coupling two
// unrelated fixture concerns to the exact same shared IR.
const LATE_STATE_STATUS = nodeId('state_status_late');
const LATE_INTEGRATION = nodeId('integration_provider_late');
const LATE_OP_FETCH = nodeId('integration_operation_fetch_late');
const LATE_ACTION_REFRESH = nodeId('action_refresh_late');
const LATE_SCOPE_QUERY = nodeId('scope_query_late');

function buildLateQueryGraph() {
  const graph = new ApplicationGraph('conformance-late-query', 'Conformance late query');
  graph.addNode({ id: LATE_STATE_STATUS, kind: 'state', name: 'status', authority: 'server',
    valueType: primitiveType('string'), initialValue: 'unknown' });
  graph.addNode({ id: LATE_INTEGRATION, kind: 'integration', name: 'Provider' });
  graph.addNode({ id: LATE_OP_FETCH, kind: 'integration-operation', integrationId: LATE_INTEGRATION,
    name: 'fetchStatus', mode: 'query', resultType: primitiveType('string') });
  graph.addNode({ id: LATE_ACTION_REFRESH, kind: 'action', name: 'refresh',
    operations: [
      { kind: 'integration-query', operationId: LATE_OP_FETCH, bindAs: LATE_SCOPE_QUERY, timeoutMs: 500 },
      { kind: 'set', target: stateLocation(LATE_STATE_STATUS), value: ref(LATE_SCOPE_QUERY) }] });
  return graph;
}

const lateQueryGraph = buildLateQueryGraph();
const lateQueryValidation = validateGraph(lateQueryGraph);
if (!lateQueryValidation.valid) {
  console.error(lateQueryValidation.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  process.exit(1);
}
const lateQueryServerIR = compiler.compileToServerIR(lateQueryGraph);

const principals = {
  clerk: { [F_USER_ID]: 'u1', [F_USER_ROLE]: 'clerk' },
  admin: { [F_USER_ID]: 'u2', [F_USER_ROLE]: 'admin' },
};
const parts = (bolt, nut) => [
  { [F_PART_ID]: 'bolt', [F_PART_STOCK]: bolt },
  { [F_PART_ID]: 'nut', [F_PART_STOCK]: nut },
];

const fixtures = [
  {
    name: 'mutation-commits',
    covers: ['expression evaluation', 'mutation', 'derived state'],
    description: 'An action within its guards commits every write, and derived state follows.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 3 },
        expect: { ok: true, changedStates: [S_PARTS, S_LEDGER, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(7, 5), [S_LEDGER]: [3], [S_TOTAL]: 12 },
  },
  {
    name: 'guard-refuses',
    covers: ['action guards', 'failure modes'],
    description: 'A guard that does not hold refuses the invocation, naming its failure mode.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 99 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['PRECONDITION_FAILED'], failureModes: ['insufficient-stock'] } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 0 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['PRECONDITION_FAILED'], failureModes: ['invalid-quantity'] } }],
    expectedState: { [S_PARTS]: parts(10, 5), [S_LEDGER]: [] },
  },
  {
    name: 'constraint-rolls-back',
    covers: ['constraints', 'rollback', 'for-each provisional writes'],
    description:
      'Iteration N sees the writes of iterations before it, so two lines for one part are counted together — and the invariant then rolls the whole action back.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE_MANY,
        arguments: { [P_LINES]: [
          { [F_LINE_ID]: 'l1', [F_LINE_PART]: 'nut', [F_LINE_QTY]: 3 },
          { [F_LINE_ID]: 'l2', [F_LINE_PART]: 'nut', [F_LINE_QTY]: 3 }] },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['CONSTRAINT_VIOLATION'] } }],
    expectedState: { [S_PARTS]: parts(10, 5) },
  },
  {
    name: 'for-each-provisional',
    covers: ['for-each provisional writes'],
    description: 'The same two-line shape, within stock: 10 − 4 − 4, not 10 − 4 twice.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE_MANY,
        arguments: { [P_LINES]: [
          { [F_LINE_ID]: 'l1', [F_LINE_PART]: 'bolt', [F_LINE_QTY]: 4 },
          { [F_LINE_ID]: 'l2', [F_LINE_PART]: 'bolt', [F_LINE_QTY]: 4 }] },
        expect: { ok: true, changedStates: [S_PARTS, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(2, 5) },
  },
  {
    name: 'transition-constraint',
    covers: ['transition constraints'],
    description: 'A rule about how state may change refuses a raise, and permits a fall.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_SET, credential: 'admin', arguments: { [P_PART]: 'bolt', [P_STOCK]: 50 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['TRANSITION_CONSTRAINT_VIOLATION'] } },
      { actionId: A_SET, credential: 'admin', arguments: { [P_PART]: 'bolt', [P_STOCK]: 4 },
        expect: { ok: true, changedStates: [S_PARTS, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(4, 5) },
  },
  {
    name: 'authorization',
    covers: ['authorization'],
    description: 'Authorization is evaluated on the authority, with the caller bound to PRINCIPAL.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_SET, credential: 'clerk', arguments: { [P_PART]: 'bolt', [P_STOCK]: 1 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['AUTHORIZATION_DENIED'] } },
      { actionId: A_SET, arguments: { [P_PART]: 'bolt', [P_STOCK]: 1 },
        expect: { ok: false, changedStates: [], diagnosticCodes: ['AUTHORIZATION_DENIED'] } },
      { actionId: A_SET, credential: 'admin', arguments: { [P_PART]: 'bolt', [P_STOCK]: 1 },
        expect: { ok: true, changedStates: [S_PARTS, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(1, 5) },
  },
  {
    name: 'argument-validation',
    covers: ['argument validation'],
    description: 'Untrusted arguments are checked against declared parameter types.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 'three' },
        expect: { ok: false, diagnosticCodes: ['ARGUMENT_TYPE_MISMATCH'] } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt' },
        expect: { ok: false, diagnosticCodes: ['ARGUMENT_TYPE_MISMATCH'] } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 1, extra: true },
        expect: { ok: false, diagnosticCodes: ['ARGUMENT_TYPE_MISMATCH'] } },
      { actionId: nodeId('action_not_here'), arguments: {},
        expect: { ok: false, diagnosticCodes: ['UNKNOWN_SERVER_ACTION'] } }],
    expectedState: { [S_PARTS]: parts(10, 5) },
  },
  {
    name: 'idempotent-retry',
    covers: ['persistence', 'idempotency'],
    description: 'A repeated request id is answered from the record, not executed again.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, requestId: 'r-1', arguments: { [P_PART]: 'bolt', [P_QTY]: 3 },
        expect: { ok: true, changedStates: [S_PARTS, S_LEDGER, S_TOTAL] } },
      { actionId: A_TAKE, requestId: 'r-1', arguments: { [P_PART]: 'bolt', [P_QTY]: 3 },
        expect: { ok: true, replayed: true, changedStates: [S_PARTS, S_LEDGER, S_TOTAL] } }],
    expectedState: { [S_PARTS]: parts(7, 5), [S_LEDGER]: [3] },
  },
  {
    name: 'concurrent-invocations',
    covers: ['concurrent mutation'],
    description:
      'Three callers each want four of a stock of five. Exactly one may commit; the rest are refused by the guard against authoritative state.',
    initialState: [{ stateId: S_PARTS, value: parts(5, 5), revision: 1 }],
    concurrent: true,
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 4 } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 4 } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 4 } }],
    expect: { committedCount: 1 },
    expectedState: { [S_PARTS]: parts(1, 5) },
  },
  {
    name: 'restart',
    covers: ['persistence', 'restart'],
    description:
      'Committed state is restored exactly on restart, and a rolled-back write never reappears.',
    initialState: [{ stateId: S_PARTS, value: parts(10, 5), revision: 1 }],
    invocations: [
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 3 },
        expect: { ok: true, changedStates: [S_PARTS, S_LEDGER, S_TOTAL] } },
      { actionId: A_TAKE, arguments: { [P_PART]: 'bolt', [P_QTY]: 99 },
        expect: { ok: false, changedStates: [] } }],
    restartAndReassert: true,
    expectedState: { [S_PARTS]: parts(7, 5), [S_LEDGER]: [3] },
  },
];

/**
 * v3/v4 fixtures — integrations, effects, triggers, invocation source. `steps`/
 * `externalAdapters` are `axiom.conformance.v2` vocabulary: a fixture format extension a v1
 * consumer never needs, exactly as `axiom.server.v2`/`v3`/`v4` extend the IR itself.
 *
 * `externalAdapters` scripts a fake adapter purely as data: an ordered list of responses per
 * operation, consumed one per call (the last one repeats once exhausted). `{ neverSettle:
 * true }` models a non-cooperating provider. `steps` drives a deterministic clock: `invoke`/
 * `event` start a request without necessarily waiting on it yet, `advance` moves virtual
 * time forward (letting a `timeoutMs` deadline or a trigger's schedule fire), and every
 * started request is awaited and checked once every step has run.
 */
const integrationFixtures = [
  {
    name: 'integration-query-success',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['integration query'],
    description: 'A successful integration query binds its result and commits.',
    initialState: [{ stateId: INT_STATE_STATUS, value: 'unknown', revision: 1 }],
    externalAdapters: {
      [INT_INTEGRATION]: { query: [{ result: { ok: true, value: 'online' } }] },
    },
    steps: [
      { kind: 'invoke', actionId: INT_ACTION_REFRESH,
        expect: { ok: true, changedStates: [INT_STATE_STATUS] } },
    ],
    expectedState: { [INT_STATE_STATUS]: 'online' },
  },
  {
    name: 'integration-query-timeout',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['integration query', 'timeout'],
    description:
      'A non-cooperating adapter cannot wedge the invocation past its declared timeoutMs; the runtime enforces the deadline itself.',
    initialState: [{ stateId: INT_STATE_STATUS, value: 'unknown', revision: 1 }],
    externalAdapters: {
      [INT_INTEGRATION]: { query: [{ neverSettle: true }] },
    },
    steps: [
      { kind: 'invoke', actionId: INT_ACTION_REFRESH,
        expect: { ok: false, diagnosticCodes: ['INTEGRATION_TIMEOUT'] } },
      { kind: 'advance', ms: 500 },
    ],
    expectedState: { [INT_STATE_STATUS]: 'unknown' },
  },
  {
    name: 'timed-trigger-polling',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['triggers', 'integration query'],
    description: 'An interval trigger fires the query and writes its result, with no real wait.',
    initialState: [{ stateId: INT_STATE_STATUS, value: 'unknown', revision: 1 }],
    externalAdapters: {
      [INT_INTEGRATION]: { query: [{ result: { ok: true, value: 'online' } }] },
    },
    steps: [{ kind: 'advance', ms: 1000 }],
    expectedState: { [INT_STATE_STATUS]: 'online' },
  },
  {
    name: 'effect-success-event',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['effects', 'events', 'invocation source'],
    description:
      "A succeeded effect dispatches its structured outcome to a system-only follow-up action — never reachable by a client directly.",
    initialState: [{ stateId: INT_STATE_MESSAGE, value: '', revision: 1 }],
    externalAdapters: {
      [INT_INTEGRATION]: { effect: [{ result: { ok: true, value: 'rebooted' } }] },
    },
    steps: [
      { kind: 'invoke', actionId: INT_ACTION_REBOOT, expect: { ok: true } },
    ],
    expectedState: { [INT_STATE_MESSAGE]: 'rebooted' },
  },
  {
    name: 'system-only-action-rejects-client',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['invocation source'],
    description:
      'An anonymous client cannot directly invoke an action reachable only by a trigger, event or effect outcome.',
    initialState: [{ stateId: INT_STATE_MESSAGE, value: '', revision: 1 }],
    // Never called in this fixture — registered only so `start()`'s "every declared
    // integration has an adapter" check (spec §116) does not itself refuse the graph.
    externalAdapters: { [INT_INTEGRATION]: {} },
    steps: [
      { kind: 'invoke', actionId: INT_ACTION_APPLY_MESSAGE, arguments: { [INT_PARAM_MESSAGE]: 'forged' },
        expect: { ok: false, diagnosticCodes: ['INVOCATION_SOURCE_NOT_ALLOWED'] } },
    ],
    expectedState: { [INT_STATE_MESSAGE]: '' },
  },
  {
    name: 'late-query-result-after-timeout',
    conformance: 'axiom.conformance.v2',
    serverIR: lateQueryServerIR,
    principals: {},
    covers: ['integration query', 'timeout'],
    description:
      'A query that eventually resolves successfully, but only after its declared timeoutMs already answered, is discarded — the late success can never mutate state.',
    initialState: [{ stateId: LATE_STATE_STATUS, value: 'unknown', revision: 1 }],
    externalAdapters: {
      [LATE_INTEGRATION]: { query: [{ result: { ok: true, value: 'online' }, resolveAfterMs: 300 }] },
    },
    steps: [
      { kind: 'invoke', actionId: LATE_ACTION_REFRESH, expect: { ok: false, diagnosticCodes: ['INTEGRATION_TIMEOUT'] } },
      { kind: 'advance', ms: 500 },
      // The late result resolves well after the deadline already answered (300ms after the
      // query started, i.e. 200ms after its 500ms timeoutMs deadline already fired).
      { kind: 'advance', ms: 200 },
    ],
    expectedState: { [LATE_STATE_STATUS]: 'unknown' },
  },
  {
    name: 'late-query-rejection-after-timeout',
    conformance: 'axiom.conformance.v2',
    serverIR: lateQueryServerIR,
    principals: {},
    covers: ['integration query', 'timeout'],
    description:
      'A query that eventually rejects, but only after its declared timeoutMs already answered, is discarded exactly like a late success — the invocation already failed with INTEGRATION_TIMEOUT, not the provider error.',
    initialState: [{ stateId: LATE_STATE_STATUS, value: 'unknown', revision: 1 }],
    externalAdapters: {
      [LATE_INTEGRATION]: {
        query: [{ result: { ok: false, code: 'DEVICE_UNREACHABLE', message: 'no route', retryable: false }, resolveAfterMs: 300 }],
      },
    },
    steps: [
      { kind: 'invoke', actionId: LATE_ACTION_REFRESH, expect: { ok: false, diagnosticCodes: ['INTEGRATION_TIMEOUT'] } },
      { kind: 'advance', ms: 500 },
      { kind: 'advance', ms: 200 },
    ],
    expectedState: { [LATE_STATE_STATUS]: 'unknown' },
  },
  {
    name: 'failed-effect-structured-outcome',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['effects', 'events'],
    description:
      'A failed effect dispatches its structured failure outcome (code, message, retryable) to a system-only follow-up action — no text parsing required.',
    initialState: [{ stateId: INT_STATE_MESSAGE, value: '', revision: 1 }],
    externalAdapters: {
      [INT_INTEGRATION]: {
        effect: [{ result: { ok: false, code: 'DEVICE_UNREACHABLE', message: 'no route to device', retryable: false } }],
      },
    },
    steps: [{ kind: 'invoke', actionId: INT_ACTION_REBOOT, expect: { ok: true } }],
    expectedState: { [INT_STATE_MESSAGE]: 'no route to device' },
  },
  {
    name: 'authenticated-client-rejects-system-only-action',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: { someone: {} },
    covers: ['invocation source', 'authorization'],
    description:
      "An authenticated client is refused by a system-only action exactly like an anonymous one — invocation.allowedSources checks the request's source, not the caller's identity.",
    initialState: [{ stateId: INT_STATE_MESSAGE, value: '', revision: 1 }],
    externalAdapters: { [INT_INTEGRATION]: {} },
    steps: [
      { kind: 'invoke', actionId: INT_ACTION_APPLY_MESSAGE, credential: 'someone', arguments: { [INT_PARAM_MESSAGE]: 'forged' },
        expect: { ok: false, diagnosticCodes: ['INVOCATION_SOURCE_NOT_ALLOWED'] } },
    ],
    expectedState: { [INT_STATE_MESSAGE]: '' },
  },
  {
    name: 'simultaneous-same-instant-triggers-both-commit',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['triggers', 'concurrent mutation'],
    description:
      'Two one-shot delay triggers due at the same simulated instant are serialized against each other, not raced — both commit, with no spurious conflict.',
    initialState: [{ stateId: INT_STATE_COUNTER, value: 0, revision: 1 }],
    externalAdapters: { [INT_INTEGRATION]: {} },
    steps: [{ kind: 'advance', ms: 10 }],
    expectedState: { [INT_STATE_COUNTER]: 2 },
  },
  {
    name: 'rolled-back-action-produces-no-effect',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['effects', 'rollback', 'constraints'],
    description:
      'A constraint violation rolls back the whole transaction, including the effect intent it recorded within it — no adapter call, no outcome event.',
    initialState: [
      { stateId: INT_STATE_GUARD, value: [{ [F_GUARD_ID]: 'g1', [F_GUARD_VALUE]: 1 }], revision: 1 },
      { stateId: INT_STATE_MESSAGE, value: '', revision: 1 },
    ],
    // If the effect intent were not suppressed by rollback, this would be called and
    // INT_STATE_MESSAGE would move — the assertion below is what proves it never runs.
    externalAdapters: { [INT_INTEGRATION]: { effect: [{ result: { ok: true, value: 'should never be dispatched' } }] } },
    steps: [
      { kind: 'invoke', actionId: INT_ACTION_GUARDED_REBOOT,
        expect: { ok: false, diagnosticCodes: ['CONSTRAINT_VIOLATION'], changedStates: [] } },
    ],
    expectedState: {
      [INT_STATE_GUARD]: [{ [F_GUARD_ID]: 'g1', [F_GUARD_VALUE]: 1 }],
      [INT_STATE_MESSAGE]: '',
    },
  },
  {
    name: 'effect-retry-sequence',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['effects', 'events'],
    description:
      'A transient failure (retryable: true) is retried under the declared fixed-delay policy and eventually dispatches a success outcome.',
    initialState: [{ stateId: INT_STATE_MESSAGE, value: '', revision: 1 }],
    externalAdapters: {
      [INT_INTEGRATION]: {
        effect: [
          { result: { ok: false, code: 'TRANSIENT', message: 'try again', retryable: true } },
          { result: { ok: true, value: 'rebooted after retry' } },
        ],
      },
    },
    steps: [
      { kind: 'invoke', actionId: INT_ACTION_REBOOT, expect: { ok: true } },
      { kind: 'advance', ms: 60 },
    ],
    expectedState: { [INT_STATE_MESSAGE]: 'rebooted after retry' },
  },
  {
    name: 'event-payload-invalid',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['events'],
    description: 'A malformed event payload is rejected before any bound action sees it.',
    initialState: [{ stateId: INT_STATE_MESSAGE, value: '', revision: 1 }],
    externalAdapters: { [INT_INTEGRATION]: {} },
    steps: [
      { kind: 'event', eventId: INT_EVENT_SUCCEEDED, payload: 'not-a-valid-outcome',
        expect: { ok: false, diagnosticCodes: ['EVENT_PAYLOAD_INVALID'] } },
    ],
    expectedState: { [INT_STATE_MESSAGE]: '' },
  },
  {
    name: 'verified-external-event-invokes-system-only-action',
    conformance: 'axiom.conformance.v2',
    serverIR: integrationServerIR,
    principals: {},
    covers: ['events', 'triggers', 'invocation source'],
    description:
      'A verified external event — semantically, an ordinary event dispatch, since HTTP delivery and signature verification are host/adapter concerns outside the graph — invokes a system-only action through its bound trigger, never reachable by a direct client InvokeRequest.',
    initialState: [{ stateId: INT_STATE_STATUS, value: 'unknown', revision: 1 }],
    externalAdapters: { [INT_INTEGRATION]: {} },
    // An EventResponse carries no `changes` (that is reported only for an invoke response),
    // so the effect of the dispatched event is checked through `expectedState` below rather
    // than a changedStates assertion on the step itself.
    steps: [
      { kind: 'event', eventId: INT_EVENT_EXTERNAL_STATUS, payload: 'online',
        expect: { ok: true } },
    ],
    expectedState: { [INT_STATE_STATUS]: 'online' },
  },
];

// ============================================================ 0.9: external I/O
//
// A dedicated graph for the subscription and blob fixtures. It is deliberately separate
// from the integration graph above: that one carries a 1000ms poll trigger, and a fixture
// advancing virtual time to drive a reconnect would fire it incidentally.

const IO_E_USER = nodeId('entity_io_user');
const IO_F_USER_ID = fieldId('field_io_user_id');
const IO_F_USER_ROLE = fieldId('field_io_user_role');
const IO_E_DEVICE = nodeId('entity_io_device');
const IO_F_DEVICE_ID = fieldId('field_io_device_id');
const IO_F_DEVICE_STATUS = fieldId('field_io_device_status');
const IO_F_DEVICE_LOG = fieldId('field_io_device_log');
const IO_E_BLOB = nodeId('entity_io_blob');
const IO_E_CHANGE = nodeId('entity_io_change');
const IO_F_CHANGE_DEVICE = fieldId('field_io_change_device');
const IO_F_CHANGE_STATUS = fieldId('field_io_change_status');
const IO_F_CHANGE_DELIVERY = fieldId('field_io_change_delivery');

const IO_STATE_DEVICES = nodeId('state_io_devices');
const IO_INTEGRATION = nodeId('integration_io_devices');
const IO_STORAGE = nodeId('storage_io_logs');
const IO_EVENT_STATUS = nodeId('event_io_status');
const IO_SUBSCRIPTION = nodeId('subscription_io_status');
const IO_ACTION_APPLY = nodeId('action_io_apply_status');
const IO_PARAM_DEVICE = nodeId('param_io_device');
const IO_PARAM_STATUS = nodeId('param_io_status');
const IO_TRIGGER_STATUS = nodeId('trigger_io_status');
const IO_ACTION_ATTACH = nodeId('action_io_attach');
const IO_PARAM_ATTACH_DEVICE = nodeId('param_io_attach_device');
const IO_PARAM_ATTACH_BLOB = nodeId('param_io_attach_blob');
const IO_ACTION_DETACH = nodeId('action_io_detach');
const IO_PARAM_DETACH_DEVICE = nodeId('param_io_detach_device');
const IO_SCOPE_METADATA = nodeId('scope_io_metadata');
const IO_SCOPE_DEVICE = nodeId('scope_io_device');
const IO_SCOPE_REF = nodeId('scope_io_ref');
const IO_CONSTRAINT_STATUS = nodeId('constraint_io_status');

function buildIoGraph() {
  const graph = new ApplicationGraph('external-io', 'External IO', '0.9.0');
  graph.setPrincipalEntity(IO_E_USER);

  graph.addNode({ id: IO_E_USER, kind: 'entity', identityFieldId: IO_F_USER_ID, fields: [
    { id: IO_F_USER_ID, valueType: primitiveType('string'), required: true },
    { id: IO_F_USER_ROLE, valueType: primitiveType('string'), required: true }] });
  graph.addNode(blobRefEntity(IO_E_BLOB));
  graph.addNode({ id: IO_E_DEVICE, kind: 'entity', identityFieldId: IO_F_DEVICE_ID, fields: [
    { id: IO_F_DEVICE_ID, valueType: primitiveType('string'), required: true },
    { id: IO_F_DEVICE_STATUS, valueType: primitiveType('string'), required: true },
    { id: IO_F_DEVICE_LOG, valueType: optionalType(entityType(IO_E_BLOB)) }] });
  graph.addNode({ id: IO_E_CHANGE, kind: 'entity', fields: [
    { id: IO_F_CHANGE_DEVICE, valueType: primitiveType('string'), required: true },
    { id: IO_F_CHANGE_STATUS, valueType: primitiveType('string'), required: true },
    { id: IO_F_CHANGE_DELIVERY, valueType: primitiveType('string') }] });

  graph.addNode({ id: IO_STATE_DEVICES, kind: 'state', name: 'devices', authority: 'server',
    valueType: collectionType(entityType(IO_E_DEVICE)),
    initialValue: [{ [IO_F_DEVICE_ID]: 'd1', [IO_F_DEVICE_STATUS]: 'unknown', [IO_F_DEVICE_LOG]: null }] });

  graph.addNode({ id: IO_INTEGRATION, kind: 'integration', name: 'Devices' });
  graph.addNode({ id: IO_EVENT_STATUS, kind: 'event', payloadType: entityType(IO_E_CHANGE) });

  // A status the graph refuses. It is what makes the poison-delivery fixture a *semantic*
  // failure — the payload conforms, the action runs, and the invariant rejects the result.
  graph.addNode({ id: IO_CONSTRAINT_STATUS, kind: 'constraint', entityId: IO_E_DEVICE,
    message: 'Device status must be unknown, online or offline.',
    expression: call('one-of', field(ref(IO_E_DEVICE), IO_F_DEVICE_STATUS),
      literal('unknown'), literal('online'), literal('offline')) });

  graph.addNode({ id: IO_ACTION_APPLY, kind: 'action', name: 'applyStatus',
    invocation: { allowedSources: ['system'] },
    parameters: [
      { id: IO_PARAM_DEVICE, valueType: primitiveType('string'), required: true },
      { id: IO_PARAM_STATUS, valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'set',
        target: itemFieldLocation(IO_STATE_DEVICES, IO_F_DEVICE_ID, ref(IO_PARAM_DEVICE), IO_F_DEVICE_STATUS),
        value: ref(IO_PARAM_STATUS) }] });
  graph.addNode({ id: IO_TRIGGER_STATUS, kind: 'trigger', actionId: IO_ACTION_APPLY,
    when: { kind: 'event', eventId: IO_EVENT_STATUS },
    arguments: {
      [IO_PARAM_DEVICE]: field(ref(IO_TRIGGER_STATUS), IO_F_CHANGE_DEVICE),
      [IO_PARAM_STATUS]: field(ref(IO_TRIGGER_STATUS), IO_F_CHANGE_STATUS) } });

  graph.addNode({ id: IO_SUBSCRIPTION, kind: 'subscription', name: 'live status',
    integrationId: IO_INTEGRATION, source: 'device-status', eventId: IO_EVENT_STATUS,
    lifecycle: { reconnect: { policy: 'fixed', maxAttempts: 3, delayMs: 100 } },
    delivery: { deduplicateBy: IO_F_CHANGE_DELIVERY, maxQueued: 8, backpressure: 'block' } });

  graph.addNode({ id: IO_STORAGE, kind: 'storage', name: 'Logs', blobEntityId: IO_E_BLOB,
    // Referenced-by-a-device, so possession of a key is never permission on its own.
    readAuthorization: some(ref(IO_STATE_DEVICES), IO_SCOPE_REF,
      binary('eq', field(field(ref(IO_SCOPE_REF), IO_F_DEVICE_LOG), BLOB_KEY_FIELD),
        field(ref(IO_STORAGE), BLOB_KEY_FIELD))),
    uploadAuthorization: binary('eq', field(ref(PRINCIPAL), IO_F_USER_ROLE), literal('operator')) });

  graph.addNode({ id: IO_ACTION_ATTACH, kind: 'action', name: 'attachLog',
    authorization: binary('eq', field(ref(PRINCIPAL), IO_F_USER_ROLE), literal('operator')),
    parameters: [
      { id: IO_PARAM_ATTACH_DEVICE, valueType: primitiveType('string'), required: true },
      { id: IO_PARAM_ATTACH_BLOB, valueType: entityType(IO_E_BLOB), required: true }],
    operations: [
      { kind: 'set',
        target: itemFieldLocation(IO_STATE_DEVICES, IO_F_DEVICE_ID, ref(IO_PARAM_ATTACH_DEVICE), IO_F_DEVICE_LOG),
        value: ref(IO_PARAM_ATTACH_BLOB) },
      { kind: 'blob-commit', storageId: IO_STORAGE,
        blobKey: field(ref(IO_PARAM_ATTACH_BLOB), BLOB_KEY_FIELD) }] });

  graph.addNode({ id: IO_ACTION_DETACH, kind: 'action', name: 'detachLog',
    authorization: binary('eq', field(ref(PRINCIPAL), IO_F_USER_ROLE), literal('operator')),
    parameters: [{ id: IO_PARAM_DETACH_DEVICE, valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'blob-metadata', storageId: IO_STORAGE, bindAs: IO_SCOPE_METADATA,
        blobKey: field(field(find(ref(IO_STATE_DEVICES), IO_SCOPE_DEVICE,
          binary('eq', field(ref(IO_SCOPE_DEVICE), IO_F_DEVICE_ID), ref(IO_PARAM_DETACH_DEVICE))),
          IO_F_DEVICE_LOG), BLOB_KEY_FIELD) },
      { kind: 'set',
        target: itemFieldLocation(IO_STATE_DEVICES, IO_F_DEVICE_ID, ref(IO_PARAM_DETACH_DEVICE), IO_F_DEVICE_LOG),
        value: literal(null) },
      { kind: 'blob-delete', storageId: IO_STORAGE,
        blobKey: field(ref(IO_SCOPE_METADATA), BLOB_KEY_FIELD) }] });

  return graph;
}

const ioGraph = buildIoGraph();
const ioValidation = validateGraph(ioGraph);
if (!ioValidation.valid) {
  console.error(ioValidation.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  process.exit(1);
}
const ioServerIR = compiler.compileToServerIR(ioGraph);

const ioPrincipals = {
  operator: { [IO_F_USER_ID]: 'op-1', [IO_F_USER_ROLE]: 'operator' },
  viewer: { [IO_F_USER_ID]: 'v-1', [IO_F_USER_ROLE]: 'viewer' },
};
const ioDevice = (status, log = null) => [{ [IO_F_DEVICE_ID]: 'd1', [IO_F_DEVICE_STATUS]: status, [IO_F_DEVICE_LOG]: log }];
const ioChange = (status, delivery) => ({
  [IO_F_CHANGE_DEVICE]: 'd1',
  [IO_F_CHANGE_STATUS]: status,
  ...(delivery === undefined ? {} : { [IO_F_CHANGE_DELIVERY]: delivery }),
});
const STORED_LOG = {
  [BLOB_KEY_FIELD]: 'log-1',
  field_blob_media_type: 'text/plain',
  field_blob_size: 8,
  field_blob_filename: 'd1.log',
  field_blob_checksum: '5f2e1a7f',
};

const externalIoFixtures = [
  {
    name: 'subscription-becomes-active-at-startup',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'lifecycle'],
    description:
      'Startup activates every auto-start subscription, with no application code calling start(). The lifecycle state is observable before any delivery arrives.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    steps: [
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION,
        expect: { state: 'active', received: 0, applied: 0 } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },
  {
    name: 'subscription-delivery-applies',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'events', 'invocation source'],
    description:
      'An external delivery is validated against the EventDef payload type, dispatched through the ordinary EventDef → TriggerDef → ActionDef pipeline, and commits under the system principal.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: {
      [IO_SUBSCRIPTION]: { entries: [{ kind: 'deliver', afterMs: 1, payload: ioChange('online', 'm-1') }] },
    },
    steps: [
      { kind: 'advance', ms: 5 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { received: 1, applied: 1, rejected: 0 } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('online') },
  },
  {
    name: 'subscription-sequential-delivery',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'ordering'],
    description:
      'Deliveries of one subscription are dispatched one at a time in accepted order, each in its own transaction — so the last delivery is the last applied.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: {
      [IO_SUBSCRIPTION]: {
        entries: [
          { kind: 'deliver', afterMs: 1, payload: ioChange('online', 'm-1') },
          { kind: 'deliver', afterMs: 2, payload: ioChange('offline', 'm-2') },
        ],
      },
    },
    steps: [
      { kind: 'advance', ms: 5 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { applied: 2 } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('offline') },
  },
  {
    name: 'subscription-duplicate-delivery',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'deduplication'],
    description:
      'The same external delivery identity presented twice mutates state once. The second carries a different status, so only deduplication — not ordering — can produce this result.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: {
      [IO_SUBSCRIPTION]: {
        entries: [
          { kind: 'deliver', afterMs: 1, payload: ioChange('online', 'm-7') },
          { kind: 'deliver', afterMs: 2, payload: ioChange('offline', 'm-7') },
        ],
      },
    },
    steps: [
      { kind: 'advance', ms: 5 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { applied: 1, rejected: 1 } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('online') },
  },
  {
    name: 'subscription-invalid-payload',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'events'],
    description:
      'A delivery whose payload does not conform to the EventDef is refused before any action runs, and the valid delivery that follows still applies.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: {
      [IO_SUBSCRIPTION]: {
        entries: [
          { kind: 'deliver', afterMs: 1, payload: 'not-a-record' },
          { kind: 'deliver', afterMs: 2, payload: ioChange('online', 'm-2') },
        ],
      },
    },
    steps: [
      { kind: 'advance', ms: 5 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { applied: 1, rejected: 1 } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('online') },
  },
  {
    name: 'subscription-poison-delivery',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'constraints', 'rollback'],
    description:
      'A conforming payload whose action violates an invariant rolls that transaction back and is counted as failed, not applied — and the subscription keeps running under the default report policy.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: {
      [IO_SUBSCRIPTION]: { entries: [{ kind: 'deliver', afterMs: 1, payload: ioChange('melted', 'm-1') }] },
    },
    steps: [
      { kind: 'advance', ms: 5 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { state: 'active', applied: 0, failed: 1 } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },
  {
    name: 'subscription-reconnects-after-transport-loss',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'lifecycle', 'reconnect'],
    description:
      'A lost transport moves the subscription to reconnecting and back to active on the graph-declared fixed 100ms policy — reconnect policy is the runtime’s, the adapter only reports the loss.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: {
      [IO_SUBSCRIPTION]: {
        entries: [
          { kind: 'disconnect', afterMs: 1, attempt: 1 },
          { kind: 'deliver', afterMs: 5, attempt: 2, payload: ioChange('online', 'm-after') },
        ],
      },
    },
    steps: [
      { kind: 'advance', ms: 2 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { state: 'reconnecting' } },
      { kind: 'advance', ms: 100 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { state: 'active', attempts: 2 } },
      { kind: 'advance', ms: 10 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { applied: 1 } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('online') },
  },
  {
    name: 'subscription-permanent-failure-leaves-application-running',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'lifecycle', 'startup'],
    description:
      'A source that never connects exhausts the declared reconnect budget and settles in failed. Startup succeeded and the rest of the application is unaffected, because the subscription is not declared required.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: {
      [IO_SUBSCRIPTION]: {
        entries: [
          { kind: 'connect-failure', message: 'no route to broker' },
          { kind: 'connect-failure', message: 'no route to broker' },
          { kind: 'connect-failure', message: 'no route to broker' },
        ],
      },
    },
    steps: [
      { kind: 'advance', ms: 100 },
      { kind: 'advance', ms: 100 },
      { kind: 'advance', ms: 100 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { state: 'failed' } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },
  {
    name: 'subscription-delivery-after-shutdown',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'shutdown'],
    description:
      'A delivery scheduled for after the fixture ends never reaches application state: the runner stops the server, and a stopped subscription accepts nothing. The final state is the one the pre-shutdown delivery produced.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: {
      [IO_SUBSCRIPTION]: {
        entries: [
          { kind: 'deliver', afterMs: 1, payload: ioChange('online', 'm-before') },
          { kind: 'deliver', afterMs: 100000, payload: ioChange('offline', 'm-after') },
        ],
      },
    },
    steps: [
      { kind: 'advance', ms: 5 },
      { kind: 'expect-subscription', subscriptionId: IO_SUBSCRIPTION, expect: { applied: 1 } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('online') },
  },
  {
    name: 'subscription-client-cannot-forge-a-delivery',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['subscriptions', 'invocation source', 'authorization'],
    description:
      'A client that knows the subscription-only action id cannot invoke it: invocation.allowedSources refuses a client-sourced call before identity is even consulted, so no delivery can be forged.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    steps: [
      { kind: 'invoke', actionId: IO_ACTION_APPLY, credential: 'operator',
        arguments: { [IO_PARAM_DEVICE]: 'd1', [IO_PARAM_STATUS]: 'online' },
        expect: { ok: false, diagnosticCodes: ['INVOCATION_SOURCE_NOT_ALLOWED'], changedStates: [] } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },

  // ------------------------------------------------------------------------ blobs

  {
    name: 'blob-upload-and-commit',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'authorization'],
    description:
      'An authorized upload is staged and returns the public BlobRef; the action that stores the reference also commits the object, and the commit dispatches only after the transaction commits.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: { [IO_STORAGE]: {} },
    steps: [
      { kind: 'upload-blob', storageId: IO_STORAGE, credential: 'operator', mediaType: 'text/plain',
        filename: 'd1.log', text: 'boot ok\n', expectKey: 'blob-1', expect: { ok: true } },
      { kind: 'expect-blob', storageId: IO_STORAGE, blobKey: 'blob-1', expect: { present: true, lifecycle: 'staged' } },
      { kind: 'invoke', actionId: IO_ACTION_ATTACH, credential: 'operator',
        arguments: { [IO_PARAM_ATTACH_DEVICE]: 'd1', [IO_PARAM_ATTACH_BLOB]: {
          [BLOB_KEY_FIELD]: 'blob-1', field_blob_media_type: 'text/plain', field_blob_size: 8,
          field_blob_filename: 'd1.log' } },
        expect: { ok: true } },
      { kind: 'expect-blob', storageId: IO_STORAGE, blobKey: 'blob-1', expect: { present: true, lifecycle: 'stored' } },
    ],
    expectedState: {
      [IO_STATE_DEVICES]: ioDevice('unknown', {
        [BLOB_KEY_FIELD]: 'blob-1', field_blob_media_type: 'text/plain', field_blob_size: 8,
        field_blob_filename: 'd1.log' }),
    },
  },
  {
    name: 'blob-upload-unauthorized',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'authorization'],
    description:
      'A caller the store’s uploadAuthorization does not admit is refused before a byte is stored, and an anonymous caller likewise.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: { [IO_STORAGE]: {} },
    steps: [
      { kind: 'upload-blob', storageId: IO_STORAGE, credential: 'viewer', mediaType: 'text/plain',
        text: 'nope', expect: { ok: false, diagnosticCodes: ['BLOB_ACCESS_DENIED'] } },
      { kind: 'upload-blob', storageId: IO_STORAGE, mediaType: 'text/plain',
        text: 'nope', expect: { ok: false, diagnosticCodes: ['BLOB_ACCESS_DENIED'] } },
      { kind: 'expect-blob', storageId: IO_STORAGE, blobKey: 'blob-1', expect: { present: false } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },
  {
    name: 'blob-authorized-read',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'authorization'],
    description:
      'A stored object referenced by a device is readable, because the store’s readAuthorization is a rule over authoritative state rather than a route guard.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown', STORED_LOG), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: { [IO_STORAGE]: { objects: [{ key: 'log-1', mediaType: 'text/plain', filename: 'd1.log', text: 'boot ok\n' }] } },
    steps: [
      { kind: 'read-blob', storageId: IO_STORAGE, blobKey: 'log-1', credential: 'viewer', expect: { ok: true } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown', STORED_LOG) },
  },
  {
    name: 'blob-unauthorized-read-and-guessed-key',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'authorization'],
    description:
      'Possession of a key is not permission: a real, stored object that nothing references is refused, and a key that names nothing is refused identically — so the endpoint is not an oracle for enumerating keys.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: { [IO_STORAGE]: { objects: [{ key: 'log-1', mediaType: 'text/plain', text: 'secret\n' }] } },
    steps: [
      { kind: 'read-blob', storageId: IO_STORAGE, blobKey: 'log-1', credential: 'operator',
        expect: { ok: false, diagnosticCodes: ['BLOB_ACCESS_DENIED'] } },
      { kind: 'read-blob', storageId: IO_STORAGE, blobKey: 'log-guessed', credential: 'operator',
        expect: { ok: false, diagnosticCodes: ['BLOB_ACCESS_DENIED'] } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },
  {
    name: 'blob-metadata-lookup',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'integration query'],
    description:
      'A blob-metadata operation resolves before the transaction opens, binds the BlobRef into scope, and the deletion that follows addresses the object it named.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown', STORED_LOG), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: { [IO_STORAGE]: { objects: [{ key: 'log-1', mediaType: 'text/plain', filename: 'd1.log', text: 'boot ok\n' }] } },
    steps: [
      { kind: 'invoke', actionId: IO_ACTION_DETACH, credential: 'operator',
        arguments: { [IO_PARAM_DETACH_DEVICE]: 'd1' }, expect: { ok: true } },
      { kind: 'expect-blob', storageId: IO_STORAGE, blobKey: 'log-1', expect: { present: false } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },
  {
    name: 'blob-metadata-missing-refuses-the-action',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'rollback'],
    description:
      'A blob-metadata lookup for a key the store does not hold fails the whole invocation rather than binding a plausible empty record — so nothing is mutated on the strength of an object that is not there.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown', STORED_LOG), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: { [IO_STORAGE]: {} },
    steps: [
      { kind: 'invoke', actionId: IO_ACTION_DETACH, credential: 'operator',
        arguments: { [IO_PARAM_DETACH_DEVICE]: 'd1' },
        expect: { ok: false, diagnosticCodes: ['BLOB_METADATA_FAILED'], changedStates: [] } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown', STORED_LOG) },
  },
  {
    name: 'blob-commit-not-dispatched-when-the-transaction-is-refused',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'rollback', 'authorization'],
    description:
      'A refused transaction dispatches no storage effect. The uploaded object stays staged — a sweepable orphan — rather than becoming a committed object nothing references.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown'), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: { [IO_STORAGE]: {} },
    steps: [
      { kind: 'upload-blob', storageId: IO_STORAGE, credential: 'operator', mediaType: 'text/plain',
        filename: 'd1.log', text: 'boot ok\n', expectKey: 'blob-1', expect: { ok: true } },
      { kind: 'invoke', actionId: IO_ACTION_ATTACH, credential: 'viewer',
        arguments: { [IO_PARAM_ATTACH_DEVICE]: 'd1', [IO_PARAM_ATTACH_BLOB]: {
          [BLOB_KEY_FIELD]: 'blob-1', field_blob_media_type: 'text/plain', field_blob_size: 8 } },
        expect: { ok: false, diagnosticCodes: ['AUTHORIZATION_DENIED'], changedStates: [] } },
      { kind: 'expect-blob', storageId: IO_STORAGE, blobKey: 'blob-1', expect: { present: true, lifecycle: 'staged' } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },
  {
    name: 'blob-delete-failure-leaves-state-correct',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'effects'],
    description:
      'A store that refuses the deletion does not undo the committed state change: the device is unattached and correct, and the object remains as an observable orphan. State correctness and external cleanup are separately observable, never falsely coupled.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown', STORED_LOG), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: {
      [IO_STORAGE]: {
        objects: [{ key: 'log-1', mediaType: 'text/plain', filename: 'd1.log', text: 'boot ok\n' }],
        failOn: { delete: { code: 'STORE_UNAVAILABLE', message: 'the store is down', retryable: false } },
      },
    },
    steps: [
      { kind: 'invoke', actionId: IO_ACTION_DETACH, credential: 'operator',
        arguments: { [IO_PARAM_DETACH_DEVICE]: 'd1' }, expect: { ok: true } },
      { kind: 'expect-blob', storageId: IO_STORAGE, blobKey: 'log-1', expect: { present: true } },
    ],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown') },
  },
  {
    name: 'blob-restart-preserves-references',
    conformance: 'axiom.conformance.v3',
    serverIR: ioServerIR,
    principals: ioPrincipals,
    covers: ['blob storage', 'persistence'],
    description:
      'A BlobRef is ordinary authoritative state: it survives a restart exactly as any other committed value does, and nothing about the object had to be reloaded to make that true.',
    initialState: [{ stateId: IO_STATE_DEVICES, value: ioDevice('unknown', STORED_LOG), revision: 1 }],
    externalSubscriptions: { [IO_SUBSCRIPTION]: { entries: [] } },
    blobStores: { [IO_STORAGE]: { objects: [{ key: 'log-1', mediaType: 'text/plain', filename: 'd1.log', text: 'boot ok\n' }] } },
    restartAndReassert: true,
    invocations: [],
    expectedState: { [IO_STATE_DEVICES]: ioDevice('unknown', STORED_LOG) },
  },
];

const directory = path.join(repoRoot, 'packages/server/conformance');
await mkdir(directory, { recursive: true });
for (const existing of await readdir(directory).catch(() => [])) {
  if (existing.endsWith('.json')) {
    await writeFile(path.join(directory, existing), '');
  }
}

const written = [];
const manifestEntries = [];
for (const fixture of [...fixtures, ...integrationFixtures, ...externalIoFixtures]) {
  const document = {
    conformance: fixture.conformance ?? 'axiom.conformance.v1',
    name: fixture.name,
    covers: fixture.covers,
    description: fixture.description,
    principals: fixture.principals ?? principals,
    serverIR: fixture.serverIR ?? serverIR,
    initialState: fixture.initialState,
    ...(fixture.concurrent ? { concurrent: true } : {}),
    ...(fixture.restartAndReassert ? { restartAndReassert: true } : {}),
    ...(fixture.invocations ? { invocations: fixture.invocations } : {}),
    ...(fixture.externalAdapters ? { externalAdapters: fixture.externalAdapters } : {}),
    ...(fixture.externalSubscriptions ? { externalSubscriptions: fixture.externalSubscriptions } : {}),
    ...(fixture.blobStores ? { blobStores: fixture.blobStores } : {}),
    ...(fixture.steps ? { steps: fixture.steps } : {}),
    ...(fixture.expect ? { expect: fixture.expect } : {}),
    expectedState: fixture.expectedState,
  };
  const file = path.join(directory, `${fixture.name}.json`);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  written.push(`${fixture.name}.json`);
  manifestEntries.push({
    name: fixture.name,
    file: `${fixture.name}.json`,
    covers: fixture.covers,
    description: fixture.description,
    conformance: document.conformance,
    contract: document.serverIR.contract,
    concurrent: Boolean(fixture.concurrent),
    restartAndReassert: Boolean(fixture.restartAndReassert),
    invocations: (fixture.invocations ?? fixture.steps ?? []).length,
  });
}

/**
 * The manifest is how an implementation in another language enumerates the suite without
 * listing a directory or knowing anything about npm. It names the contracts the fixtures
 * are written against, so a runtime can refuse a suite it does not implement rather than
 * discovering the mismatch one assertion at a time.
 */
const manifest = {
  conformance: 'axiom.conformance.v1',
  // Renamed from the ambiguous `contract` (spec 8.2 §9-10): this is the OLDEST Server IR
  // contract any fixture in this manifest may use, not "the contract of this suite" — the
  // suite ships fixtures spanning v1 through v4 simultaneously. Each fixture's own
  // `contract` field (below) is what is authoritative for what that fixture actually uses;
  // this top-level field exists only so a minimal consumer that implements nothing past v1
  // can tell at a glance that some fixtures require more before it even opens one.
  baseContract: 'axiom.server.v1',
  protocol: 'axiom.protocol.v1',
  release: version,
  description:
    'Portable conformance fixtures for the Axiom Server IR. Each entry is a self-contained ' +
    'JSON document: the Server IR, the state to start from, the principals, the invocations ' +
    'to perform and the results required. Running them needs no part of this implementation. ' +
    '"conformance" above is the fixture-FORMAT version (axiom.conformance.v1/v2); each ' +
    'fixture entry\'s own "contract" is the Server IR contract THAT fixture requires — the ' +
    'two are independent axes and neither implies the other.',
  areas: [...new Set([...fixtures, ...integrationFixtures, ...externalIoFixtures].flatMap((fixture) => fixture.covers))].sort(),
  fixtures: manifestEntries,
};
await writeFile(
  path.join(directory, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
written.push('manifest.json');

console.log(`Wrote ${written.length} conformance fixtures:\n  ${written.join('\n  ')}`);
