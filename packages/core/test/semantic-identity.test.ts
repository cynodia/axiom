import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  SEMANTIC_FINGERPRINT_VERSION,
  authorityCompatibilityKey,
  compareAuthorityCompatibility,
  compatibilityKeyString,
  fieldId,
  nodeId,
  primitiveType,
  schemaFingerprint,
  semanticFingerprint,
  semanticProjection,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, RouteDef, StateDef } from '@cynodia/axiom-core';

/**
 * spec12 §45, §46: the application semantic fingerprint and the authority compatibility key.
 */

const E_ORDER = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const S_ORDERS = nodeId('state_orders');
const A_APPROVE = nodeId('action_approve');

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('app', 'App');
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string') },
      { id: F_TOTAL, name: 'Total', valueType: primitiveType('number') },
    ],
  });
  graph.addNode<StateDef>({
    id: S_ORDERS,
    kind: 'state',
    name: 'Approved count',
    valueType: primitiveType('number'),
    authority: 'server',
  });
  graph.addNode<ActionDef>({
    id: A_APPROVE,
    kind: 'action',
    name: 'Approve order',
    parameters: [{ id: nodeId('param_id'), name: 'id', valueType: primitiveType('string') }],
    operations: [
      {
        kind: 'set',
        target: { kind: 'state', stateId: S_ORDERS },
        value: { kind: 'literal', value: 0 },
      },
    ],
  });
  return graph;
}

test('semanticFingerprint is deterministic and carries the projection version', () => {
  const a = semanticFingerprint(baseGraph());
  const b = semanticFingerprint(baseGraph());
  assert.equal(a, b, 'same graph → same fingerprint');
  assert.equal(semanticProjection(baseGraph()).fingerprintVersion, SEMANTIC_FINGERPRINT_VERSION);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('names, descriptions, UI and routes do not change the semantic fingerprint (spec12 §46)', () => {
  const before = semanticFingerprint(baseGraph());

  const renamed = baseGraph();
  const action = renamed.getNode(A_APPROVE) as ActionDef;
  renamed.updateNode({ ...action, name: 'Totally different label' });
  assert.equal(semanticFingerprint(renamed), before, 'a rename does not change executable meaning');

  const withRoute = baseGraph();
  withRoute.addNode<RouteDef>({ id: nodeId('route_home'), kind: 'route', name: 'Home', path: '/', viewId: nodeId('view_x') });
  assert.equal(semanticFingerprint(withRoute), before, 'a route is not executable server meaning');
});

test('changing an action operation DOES change the semantic fingerprint', () => {
  const before = semanticFingerprint(baseGraph());
  const changed = baseGraph();
  const action = changed.getNode(A_APPROVE) as ActionDef;
  changed.updateNode({
    ...action,
    operations: [
      {
        ...action.operations[0],
        value: { kind: 'literal', value: 999 }, // was 0
      } as ActionDef['operations'][number],
    ],
  });
  assert.notEqual(semanticFingerprint(changed), before, 'a different action body is a different semantic build');
});

test('the semantic fingerprint is distinct from the schema fingerprint (spec12 §46)', () => {
  const original = baseGraph();
  const divergent = baseGraph();
  const action = divergent.getNode(A_APPROVE) as ActionDef;
  divergent.updateNode({
    ...action,
    operations: [{ ...action.operations[0], value: { kind: 'literal', value: 42 } } as ActionDef['operations'][number]],
  });

  // Same persisted shapes → identical schema fingerprint …
  assert.equal(schemaFingerprint(divergent), schemaFingerprint(original), 'schema shape unchanged');
  // … but different executable meaning → different semantic fingerprint.
  assert.notEqual(semanticFingerprint(divergent), semanticFingerprint(original));
});

test('authorityCompatibilityKey + compareAuthorityCompatibility fail closed on any field (spec12 §44)', () => {
  const base = authorityCompatibilityKey({
    schemaVersion: 4,
    schemaFingerprint: 'sha-schema',
    serverContract: 'axiom.server.v7',
    semanticFingerprint: 'sha-semantic',
  });

  assert.deepEqual(compareAuthorityCompatibility(base, { ...base }), { compatible: true, mismatches: [] });

  for (const field of ['schemaVersion', 'schemaFingerprint', 'serverContract', 'semanticFingerprint'] as const) {
    const other = { ...base, [field]: field === 'schemaVersion' ? 99 : 'different' };
    const cmp = compareAuthorityCompatibility(base, other);
    assert.equal(cmp.compatible, false, `${field} mismatch is incompatible`);
    assert.deepEqual(cmp.mismatches, [field]);
  }

  // Multiple mismatches are all reported.
  const wild = { ...base, schemaVersion: 5, semanticFingerprint: 'x' };
  assert.deepEqual(compareAuthorityCompatibility(base, wild).mismatches.sort(), ['schemaVersion', 'semanticFingerprint']);
});

test('compatibilityKeyString is canonical — field order does not matter', () => {
  const a = compatibilityKeyString({
    schemaVersion: 1,
    schemaFingerprint: 'f',
    serverContract: 'axiom.server.v7',
    semanticFingerprint: 's',
  });
  const b = compatibilityKeyString({
    semanticFingerprint: 's',
    serverContract: 'axiom.server.v7',
    schemaFingerprint: 'f',
    schemaVersion: 1,
  });
  assert.equal(a, b);
});

// --------------------------------------------------------------- spec14pt3: WorkflowDef

import type { EventDef, WorkflowDef } from '@cynodia/axiom-core';
import { binary, field as fieldExpr, literal as lit, ref } from '@cynodia/axiom-core';

const EV_GO = nodeId('event_go');
const EV_ALT = nodeId('event_alt');
const A_ALT = nodeId('action_alt');
const WF = nodeId('wf_order');

function workflowGraph(mut: (w: WorkflowDef) => void = () => {}): ApplicationGraph {
  const graph = baseGraph();
  graph.addNode<EventDef>({ id: EV_GO, kind: 'event', payloadType: primitiveType('string') });
  graph.addNode<EventDef>({ id: EV_ALT, kind: 'event', payloadType: primitiveType('string') });
  graph.addNode<ActionDef>({
    id: A_ALT,
    kind: 'action',
    operations: [{ kind: 'set', target: { kind: 'state', stateId: S_ORDERS }, value: { kind: 'literal', value: 9 } }],
  });
  const wf: WorkflowDef = {
    id: WF,
    kind: 'workflow',
    name: 'Order workflow',
    inputs: [{ id: nodeId('in_id'), valueType: primitiveType('string'), required: true }],
    entry: nodeId('s_wait'),
    steps: [
      { type: 'wait-event', id: nodeId('s_wait'), event: EV_GO, next: nodeId('s_branch') },
      { type: 'branch', id: nodeId('s_branch'), when: binary('eq', ref(nodeId('in_id')), lit('x')), then: nodeId('s_timer'), else: nodeId('s_fail') },
      { type: 'timer', id: nodeId('s_timer'), after: { seconds: 60 }, next: nodeId('s_act') },
      { type: 'action', id: nodeId('s_act'), action: A_APPROVE, arguments: { id: ref(nodeId('in_id')) }, next: nodeId('s_done') },
      { type: 'complete', id: nodeId('s_done'), output: { id: ref(nodeId('in_id')) } },
      { type: 'fail', id: nodeId('s_fail'), error: { reason: lit('no') } },
    ],
  };
  mut(wf);
  graph.addNode<WorkflowDef>(wf);
  return graph;
}

const stepOf = (w: WorkflowDef, id: string) => w.steps.find((s) => String(s.id) === id)!;

test('spec14pt3: WorkflowDef executable meaning is in the graph semantic fingerprint', () => {
  const base = semanticFingerprint(workflowGraph());
  assert.equal(base, semanticFingerprint(workflowGraph()), 'deterministic');

  const cases: Array<[string, (w: WorkflowDef) => void]> = [
    ['entry step', (w) => { w.entry = nodeId('s_branch'); }],
    ['wait-event event id', (w) => { (stepOf(w, 's_wait') as never as { event: unknown }).event = EV_ALT; }],
    ['action target', (w) => { (stepOf(w, 's_act') as never as { action: unknown }).action = A_ALT; }],
    ['action arguments', (w) => { (stepOf(w, 's_act') as never as { arguments: unknown }).arguments = { id: lit('const') }; }],
    ['action next edge', (w) => { (stepOf(w, 's_act') as never as { next: unknown }).next = nodeId('s_fail'); }],
    ['action retry policy', (w) => { (stepOf(w, 's_act') as never as { retry: unknown }).retry = { maxAttempts: 3, initialDelaySeconds: 1, backoffMultiplier: 2, maxDelaySeconds: 9 }; }],
    ['branch predicate', (w) => { (stepOf(w, 's_branch') as never as { when: unknown }).when = binary('eq', ref(nodeId('in_id')), lit('y')); }],
    ['branch then edge', (w) => { (stepOf(w, 's_branch') as never as { then: unknown }).then = nodeId('s_done'); }],
    ['timer duration', (w) => { (stepOf(w, 's_timer') as never as { after: unknown }).after = { seconds: 600 }; }],
    ['complete output', (w) => { (stepOf(w, 's_done') as never as { output: unknown }).output = { id: lit('done') }; }],
    ['fail error', (w) => { (stepOf(w, 's_fail') as never as { error: unknown }).error = { reason: lit('other') }; }],
    ['inputs', (w) => { w.inputs = [{ id: nodeId('in_id'), valueType: primitiveType('number'), required: true }]; }],
    ['step kind', (w) => { (stepOf(w, 's_timer') as never as { type: unknown }).type = 'complete'; }],
  ];
  for (const [label, mut] of cases) {
    assert.notEqual(semanticFingerprint(workflowGraph(mut)), base, `${label} change → fingerprint moves`);
  }
});

test('spec14pt3: a workflow presentation-only change does NOT move the fingerprint', () => {
  const base = semanticFingerprint(workflowGraph());
  assert.equal(semanticFingerprint(workflowGraph((w) => { w.name = 'Renamed workflow'; (w as { description?: string }).description = 'docs here'; })), base);
});

test('spec14pt3: a transitively-referenced ActionDef change moves the workflow graph fingerprint', () => {
  const base = semanticFingerprint(workflowGraph());
  const mutated = workflowGraph();
  const approve = mutated.getNode(A_APPROVE) as ActionDef;
  approve.operations = [{ kind: 'set', target: { kind: 'state', stateId: S_ORDERS }, value: { kind: 'literal', value: 42 } }];
  mutated.updateNode(approve);
  assert.notEqual(semanticFingerprint(mutated), base, 'the referenced ActionDef body is executable meaning');
});

test('spec14pt3: construction order does not affect the workflow fingerprint', () => {
  const forward = workflowGraph();
  const shuffled = workflowGraph((w) => { w.steps = [...w.steps].reverse(); });
  assert.equal(semanticFingerprint(forward), semanticFingerprint(shuffled), 'steps are keyed by id, not position');
});

// ------------------------------------------------------------- spec15: AuthorizationPolicyDef

import type { AuthorizationPolicyDef } from '@cynodia/axiom-core';
import { binary as bin, field as fld, fieldId as fid, ref as rf } from '@cynodia/axiom-core';

const POL = nodeId('policy_x');
const F_R_OWNER = fid('field_r_owner');
const F_P_ID = fid('field_p_id');

function authzGraph(mut: (p: AuthorizationPolicyDef) => void = () => {}): ApplicationGraph {
  const g = baseGraph();
  const policy: AuthorizationPolicyDef = {
    id: POL,
    kind: 'authorization-policy',
    name: 'Owner may act',
    allow: bin('eq', fld(rf('RESOURCE' as never), F_R_OWNER), fld(rf('PRINCIPAL' as never), F_P_ID)),
  };
  mut(policy);
  g.addNode<AuthorizationPolicyDef>(policy);
  // reference it from the action so a re-pointed ref is also exercised
  const action = g.getNode(A_APPROVE) as ActionDef;
  (action as { authorizationPolicy?: string }).authorizationPolicy = String(POL);
  g.updateNode(action);
  return g;
}

test('spec15 §45: a policy ALLOW→DENY change moves the semantic fingerprint', () => {
  const base = semanticFingerprint(authzGraph());
  assert.equal(base, semanticFingerprint(authzGraph()), 'deterministic');
  // flip the rule to a constant deny
  const denied = semanticFingerprint(authzGraph((p) => { p.allow = { kind: 'literal', value: false }; }));
  assert.notEqual(denied, base, 'authorization meaning is executable meaning');
});

test('spec15 §45: a policy presentation-only change does NOT move the fingerprint', () => {
  const base = semanticFingerprint(authzGraph());
  assert.equal(
    semanticFingerprint(authzGraph((p) => { p.name = 'Renamed policy'; (p as { description?: string }).description = 'docs'; })),
    base,
  );
});

test('spec15: a graph with no authorization vocabulary has an unchanged fingerprint', () => {
  // baseGraph() carries no policy and no authorizationPolicy ref.
  const a = semanticFingerprint(baseGraph());
  const b = semanticFingerprint(baseGraph());
  assert.equal(a, b);
  // adding an *unreferenced* policy still changes it (it is executable graph content)…
  assert.notEqual(semanticFingerprint(authzGraph()), a);
});

test('spec15: re-pointing an action.authorizationPolicy moves the fingerprint', () => {
  const withPolicy = authzGraph();
  const base = semanticFingerprint(withPolicy);
  const cleared = authzGraph();
  const action = cleared.getNode(A_APPROVE) as ActionDef;
  delete (action as { authorizationPolicy?: string }).authorizationPolicy;
  cleared.updateNode(action);
  assert.notEqual(semanticFingerprint(cleared), base, 'the authorizationPolicy reference is semantic');
});
