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
