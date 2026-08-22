import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  PRINCIPAL,
  VALIDATION_CODES,
  actionAuthority,
  authorityContext,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  literal,
  nodeId,
  primitiveType,
  ref,
  serverStateClosure,
  stateAuthority,
  stateLocation,
  statesWrittenBy,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  EntityDef,
  InputNode,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';

/**
 * The authority model.
 *
 * Authority is derived, not declared: an action that writes server-owned state is a server
 * action whatever anyone says. And the boundary is validated, so a graph in which a client
 * could commit authoritative state does not compile.
 */

const ENTITY_USER = nodeId('entity_user');
const F_USER_ID = fieldId('field_user_id');
const F_USER_ROLE = fieldId('field_user_role');
const ENTITY_ITEM = nodeId('entity_item');
const F_ITEM_ID = fieldId('field_item_id');
const F_ITEM_COUNT = fieldId('field_item_count');

const STATE_SERVER = nodeId('state_server');
const STATE_CLIENT = nodeId('state_client');
const STATE_SECRET = nodeId('state_secret');
const ACTION_SERVER = nodeId('action_server');
const ACTION_CLIENT = nodeId('action_client');
const PARAM_COUNT = nodeId('param_count');
const VIEW = nodeId('ui_view');
const ROUTE = nodeId('route');

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('authority', 'Authority');
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
    id: ENTITY_ITEM,
    kind: 'entity',
    identityFieldId: F_ITEM_ID,
    fields: [
      { id: F_ITEM_ID, valueType: primitiveType('string'), required: true },
      { id: F_ITEM_COUNT, valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_SERVER,
    kind: 'state',
    name: 'counters',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  graph.addNode<StateDef>({
    id: STATE_CLIENT,
    kind: 'state',
    name: 'draft',
    draft: true,
    valueType: primitiveType('number'),
    initialValue: 0,
  });

  graph.addNode<ActionDef>({
    id: ACTION_SERVER,
    kind: 'action',
    name: 'bump',
    parameters: [{ id: PARAM_COUNT, valueType: primitiveType('number'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(STATE_SERVER), value: ref(PARAM_COUNT) }],
  });
  graph.addNode<ActionDef>({
    id: ACTION_CLIENT,
    kind: 'action',
    name: 'edit',
    operations: [{ kind: 'set', target: stateLocation(STATE_CLIENT), value: literal(1) }],
  });

  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

const codes = (graph: ApplicationGraph): string[] =>
  validateGraph(graph).errors.map((problem) => problem.code);

// ------------------------------------------------------------------- the model

test('authority is client unless a state says otherwise', () => {
  const graph = baseGraph();
  assert.equal(stateAuthority(graph.getNode<StateDef>(STATE_SERVER)!), 'server');
  assert.equal(stateAuthority(graph.getNode<StateDef>(STATE_CLIENT)!), 'client');
});

/** Section 54: a graph with no authority metadata behaves exactly as before. */
test('a graph that declares no authority is entirely client-authoritative', () => {
  const graph = baseGraph();
  const state = graph.getNode<StateDef>(STATE_SERVER)!;
  const { authority, ...local } = state;
  void authority;
  graph.updateNode(local as StateDef);

  const context = authorityContext(graph.listNodes(), graph.principalEntityId);
  assert.equal(actionAuthority(graph.getNode<ActionDef>(ACTION_SERVER)!, context), 'client');
  assert.deepEqual([...serverStateClosure(context)], []);
});

test('an action that writes server state is a server action, whatever it says', () => {
  const graph = baseGraph();
  const context = authorityContext(graph.listNodes(), graph.principalEntityId);

  assert.equal(actionAuthority(graph.getNode<ActionDef>(ACTION_SERVER)!, context), 'server');
  assert.equal(actionAuthority(graph.getNode<ActionDef>(ACTION_CLIENT)!, context), 'client');
  assert.deepEqual([...statesWrittenBy(graph.getNode<ActionDef>(ACTION_SERVER)!, context)], [STATE_SERVER]);
});

test('authority follows an invocation into the action it invokes', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_wrapper'),
    kind: 'action',
    name: 'wrapper',
    operations: [
      { kind: 'invoke', actionId: ACTION_SERVER, arguments: { [PARAM_COUNT]: literal(1) } },
    ],
  });
  const context = authorityContext(graph.listNodes(), graph.principalEntityId);
  assert.equal(actionAuthority(graph.getNode<ActionDef>(nodeId('action_wrapper'))!, context), 'server');
});

test('authority follows a declared native effect', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_native'),
    kind: 'action',
    name: 'native',
    operations: [
      {
        kind: 'native',
        implementationId: 'host.thing',
        declaredEffects: [{ kind: 'writes-state', stateId: STATE_SERVER }],
      },
    ],
  });
  const context = authorityContext(graph.listNodes(), graph.principalEntityId);
  assert.equal(actionAuthority(graph.getNode<ActionDef>(nodeId('action_native'))!, context), 'server');
});

// -------------------------------------------------------------- the boundary

/** Section 4: the invariant is structural, not a UI convention. */
test('an input bound into server-authoritative state is rejected', () => {
  const graph = baseGraph();
  graph.addNode<InputNode>({
    id: nodeId('ui_input'),
    kind: 'input',
    label: 'Count',
    binding: { location: stateLocation(STATE_SERVER) },
  });
  const view = graph.getNode<ViewNode>(VIEW)!;
  graph.updateNode({ ...view, children: [nodeId('ui_input')] });

  assert.ok(codes(graph).includes(VALIDATION_CODES.clientWriteToServerState));
});

test('an input bound into a client draft is fine', () => {
  const graph = baseGraph();
  graph.addNode<InputNode>({
    id: nodeId('ui_input'),
    kind: 'input',
    label: 'Count',
    binding: { location: stateLocation(STATE_CLIENT) },
  });
  const view = graph.getNode<ViewNode>(VIEW)!;
  graph.updateNode({ ...view, children: [nodeId('ui_input')] });

  assert.deepEqual(validateGraph(graph).errors, []);
});

/** A server action cannot read state the authority does not own. */
test('a server action that reads client state is rejected', () => {
  const graph = baseGraph();
  const action = graph.getNode<ActionDef>(ACTION_SERVER)!;
  graph.updateNode({
    ...action,
    operations: [{ kind: 'set', target: stateLocation(STATE_SERVER), value: ref(STATE_CLIENT) }],
  });

  const problems = validateGraph(graph).errors;
  assert.ok(problems.some((problem) => problem.code === VALIDATION_CODES.serverDependsOnClientState));
  assert.match(problems[0].message, /pass the value as an action parameter/);
});

test('server-authoritative state cannot derive from client state', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_server_derived'),
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('number'),
    derivation: ref(STATE_CLIENT),
  });
  assert.ok(codes(graph).includes(VALIDATION_CODES.serverDependsOnClientState));
});

test('client state may derive from observable server state', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_doubled'),
    kind: 'state',
    valueType: primitiveType('number'),
    derivation: binary('multiply', ref(STATE_SERVER), literal(2)),
  });
  assert.deepEqual(validateGraph(graph).errors, []);
});

// ------------------------------------------------------------ server-only state

function withSecret(graph: ApplicationGraph): ApplicationGraph {
  graph.addNode<StateDef>({
    id: STATE_SECRET,
    kind: 'state',
    name: 'secret',
    authority: 'server',
    serverOnly: true,
    valueType: collectionType(primitiveType('string')),
    initialValue: [],
  });
  return graph;
}

test('server-only state cannot be observed by the client, however indirectly', () => {
  const viaInput = withSecret(baseGraph());
  viaInput.addNode<InputNode>({
    id: nodeId('ui_input'),
    kind: 'input',
    label: 'Secret',
    binding: { location: stateLocation(STATE_SECRET) },
  });
  const view = viaInput.getNode<ViewNode>(VIEW)!;
  viaInput.updateNode({ ...view, children: [nodeId('ui_input')] });
  assert.ok(codes(viaInput).includes(VALIDATION_CODES.serverOnlyStateObserved));

  const viaDerivation = withSecret(baseGraph());
  viaDerivation.addNode<StateDef>({
    id: nodeId('state_leak'),
    kind: 'state',
    valueType: primitiveType('number'),
    derivation: call('count', ref(STATE_SECRET)),
  });
  assert.ok(codes(viaDerivation).includes(VALIDATION_CODES.serverOnlyStateObserved));

  const viaText = withSecret(baseGraph());
  viaText.addNode<TextNode>({
    id: nodeId('ui_text'),
    kind: 'text',
    value: call('to-string', ref(STATE_SECRET)),
  });
  const textView = viaText.getNode<ViewNode>(VIEW)!;
  viaText.updateNode({ ...textView, children: [nodeId('ui_text')] });
  assert.ok(codes(viaText).includes(VALIDATION_CODES.serverOnlyStateObserved));
});

test('server-only state read by a server action is fine', () => {
  const graph = withSecret(baseGraph());
  const action = graph.getNode<ActionDef>(ACTION_SERVER)!;
  graph.updateNode({
    ...action,
    operations: [
      ...action.operations,
      { kind: 'insert', target: stateLocation(STATE_SECRET), value: literal('note') },
    ],
  });
  assert.deepEqual(validateGraph(graph).errors, []);
});

// ------------------------------------------------------------- authorization

test('an authorization rule needs a principal entity to read the caller through', () => {
  const graph = baseGraph();
  graph.setPrincipalEntity(undefined);
  const action = graph.getNode<ActionDef>(ACTION_SERVER)!;
  graph.updateNode({ ...action, authorization: call('required', ref(PRINCIPAL)) });

  assert.ok(codes(graph).includes(VALIDATION_CODES.authorizationWithoutPrincipal));
});

test('a principal entity must be an entity', () => {
  const graph = baseGraph();
  graph.setPrincipalEntity(STATE_SERVER);
  assert.ok(codes(graph).includes(VALIDATION_CODES.invalidPrincipalEntity));
});

test('an authorization rule on a client action would never be evaluated', () => {
  const graph = baseGraph();
  const action = graph.getNode<ActionDef>(ACTION_CLIENT)!;
  graph.updateNode({ ...action, authorization: call('required', ref(PRINCIPAL)) });

  assert.ok(codes(graph).includes(VALIDATION_CODES.principalReferenceOnClient));
});

test('the caller cannot be read anywhere a client evaluates', () => {
  const viaDerivation = baseGraph();
  viaDerivation.addNode<StateDef>({
    id: nodeId('state_who'),
    kind: 'state',
    valueType: primitiveType('string'),
    derivation: field(ref(PRINCIPAL), F_USER_ROLE),
  });
  assert.ok(codes(viaDerivation).includes(VALIDATION_CODES.principalReferenceOnClient));

  const viaUi = baseGraph();
  viaUi.addNode<TextNode>({
    id: nodeId('ui_text'),
    kind: 'text',
    value: field(ref(PRINCIPAL), F_USER_ROLE),
  });
  const view = viaUi.getNode<ViewNode>(VIEW)!;
  viaUi.updateNode({ ...view, children: [nodeId('ui_text')] });
  assert.ok(codes(viaUi).includes(VALIDATION_CODES.principalReferenceOnClient));
});

test('a server action may read the caller', () => {
  const graph = baseGraph();
  const action = graph.getNode<ActionDef>(ACTION_SERVER)!;
  graph.updateNode({
    ...action,
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin')),
  });
  assert.deepEqual(validateGraph(graph).errors, []);
});

test('server state with no authorization anywhere is a warning, not an error', () => {
  const result = validateGraph(baseGraph());
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.some((warning) => warning.code === VALIDATION_CODES.authorizationWithoutPrincipal),
    'an application whose authoritative actions are open to everyone is worth mentioning',
  );
});

// ----------------------------------------------------------------- the closure

test('the server closure includes what authoritative execution reads', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_rate'),
    kind: 'state',
    name: 'rate',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 2,
  });
  const action = graph.getNode<ActionDef>(ACTION_SERVER)!;
  graph.updateNode({
    ...action,
    operations: [
      {
        kind: 'set',
        target: stateLocation(STATE_SERVER),
        value: binary('multiply', ref(PARAM_COUNT), ref(nodeId('state_rate'))),
      },
    ],
  });

  const closure = serverStateClosure(authorityContext(graph.listNodes(), graph.principalEntityId));
  assert.ok(closure.has(STATE_SERVER));
  assert.ok(closure.has(nodeId('state_rate')));
  assert.equal(closure.has(STATE_CLIENT), false, 'and nothing the client owns');
});

test('an unused field of the model does not drag client state into the closure', () => {
  const graph = baseGraph();
  const closure = serverStateClosure(authorityContext(graph.listNodes(), graph.principalEntityId));
  assert.deepEqual([...closure], [STATE_SERVER]);
  void fieldLocation;
  void entityType;
  void collectionType;
  void F_ITEM_COUNT;
  void ENTITY_ITEM;
  void F_ITEM_ID;
});
