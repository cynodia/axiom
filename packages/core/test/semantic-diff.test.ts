import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  semanticDiff,
} from '@cynodia/axiom-core';
import type { ActionDef, AuthorizationPolicyDef, EntityDef, StateDef } from '@cynodia/axiom-core';

const E_ORDER = nodeId('entity_order');
const F_ORDER_ID = fieldId('field_order_id');
const S_COUNTER = nodeId('state_counter');
const A_INCREMENT = nodeId('action_increment');
const P_ADMIN = nodeId('policy_admin');

function graph(build: (g: ApplicationGraph) => void): ApplicationGraph {
  const g = new ApplicationGraph('app', 'App', '0.16.0');
  g.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [{ id: F_ORDER_ID, valueType: primitiveType('string') }],
  });
  g.addNode<StateDef>({ id: S_COUNTER, kind: 'state', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<ActionDef>({
    id: A_INCREMENT,
    kind: 'action',
    operations: [{ kind: 'set', target: { kind: 'state', stateId: S_COUNTER }, value: literal(1) }],
  });
  build(g);
  return g;
}

const noop = (): void => {};

test('identical graphs produce a no-op diff', () => {
  const diff = semanticDiff(graph(noop), graph(noop));
  assert.equal(diff.isNoOp, true);
  assert.deepEqual(diff.entries, []);
  assert.equal(diff.compatibility.semanticFingerprintChanged, false);
  assert.equal(diff.compatibility.schemaFingerprintChanged, false);
});

test('a presentation-only rename does not appear as a semantic entry (spec16 §35, §171)', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const action = g.getNode<ActionDef>(A_INCREMENT)!;
    g.updateNode({ ...action, name: 'Increment the counter' });
  });
  const diff = semanticDiff(before, after);
  assert.equal(diff.entries.length, 1);
  assert.deepEqual(diff.entries[0].categories, ['metadata']);
  assert.equal(diff.compatibility.semanticFingerprintChanged, false);
});

test('changing an action operation is a semantic change that moves the fingerprint', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const action = g.getNode<ActionDef>(A_INCREMENT)!;
    g.updateNode({
      ...action,
      operations: [{ kind: 'set', target: { kind: 'state', stateId: S_COUNTER }, value: literal(2) }],
    });
  });
  const diff = semanticDiff(before, after);
  const entry = diff.entries.find((e) => e.nodeId === A_INCREMENT);
  assert.ok(entry);
  assert.deepEqual(entry!.categories, ['semantic']);
  assert.equal(diff.compatibility.semanticFingerprintChanged, true);
});

test('adding an entity field is a schema change, not a top-level entry (spec16 §159)', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const entity = g.getNode<EntityDef>(E_ORDER)!;
    g.updateNode({ ...entity, fields: [...entity.fields, { id: fieldId('field_order_total'), valueType: primitiveType('number') }] });
  });
  const diff = semanticDiff(before, after);
  assert.deepEqual(
    diff.entries.filter((e) => e.nodeKind === 'entity'),
    [],
  );
  assert.equal(diff.schema.entries.some((e) => e.kind === 'field-added'), true);
  assert.equal(diff.isNoOp, false);
});

test('attaching an authorization policy is classified as an authorization change (spec16 §156, §172)', () => {
  const before = graph(noop);
  const after = graph((g) => {
    g.addNode<AuthorizationPolicyDef>({
      id: P_ADMIN,
      kind: 'authorization-policy',
      allow: literal(true),
    });
    const action = g.getNode<ActionDef>(A_INCREMENT)!;
    g.updateNode({ ...action, authorizationPolicy: P_ADMIN });
  });
  const diff = semanticDiff(before, after);
  const added = diff.entries.find((e) => e.nodeId === P_ADMIN);
  assert.ok(added);
  assert.deepEqual(added!.categories, ['authorization']);
  const changed = diff.entries.find((e) => e.nodeId === A_INCREMENT);
  assert.ok(changed);
  // spec16pt2 §40: categories are additive — an authorization-bearing field change adds
  // `authorization` alongside the node's own kind category, never in its place.
  assert.deepEqual(changed!.categories, ['semantic', 'authorization']);
  assert.equal(diff.compatibility.semanticFingerprintChanged, true);
  assert.equal(diff.compatibility.serverContractAfter, 'axiom.server.v9');
});

test('a policy allow -> deny edit is reported and moves the fingerprint (spec16 §38)', () => {
  const before = graph((g) => {
    g.addNode<AuthorizationPolicyDef>({ id: P_ADMIN, kind: 'authorization-policy', allow: literal(true) });
  });
  const after = graph((g) => {
    g.addNode<AuthorizationPolicyDef>({ id: P_ADMIN, kind: 'authorization-policy', allow: literal(false) });
  });
  const diff = semanticDiff(before, after);
  const entry = diff.entries.find((e) => e.nodeId === P_ADMIN);
  assert.ok(entry);
  assert.deepEqual(entry!.categories, ['authorization']);
  assert.equal(diff.compatibility.semanticFingerprintChanged, true);
});

test('a removed node is reported as removed, categorized by kind', () => {
  const before = graph(noop);
  const after = graph((g) => {
    g.removeNode(A_INCREMENT);
  });
  const diff = semanticDiff(before, after);
  const entry = diff.entries.find((e) => e.nodeId === A_INCREMENT);
  assert.ok(entry);
  assert.equal(entry!.changeKind, 'removed');
  assert.deepEqual(entry!.categories, ['semantic']);
});

test('computing a diff never mutates either graph (spec16 §133)', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const action = g.getNode<ActionDef>(A_INCREMENT)!;
    g.updateNode({ ...action, name: 'x' });
  });
  const beforeJSON = before.toJSON();
  const afterJSON = after.toJSON();
  semanticDiff(before, after);
  assert.deepEqual(before.toJSON(), beforeJSON);
  assert.deepEqual(after.toJSON(), afterJSON);
});
