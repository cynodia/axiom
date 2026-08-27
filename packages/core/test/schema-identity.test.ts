import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  DEFAULT_SCHEMA_VERSION,
  SCHEMA_FINGERPRINT_VERSION,
  canonicalJSON,
  collectionType,
  enumType,
  fieldId,
  nodeId,
  optionalType,
  primitiveType,
  schemaFingerprint,
  schemaProjection,
} from '@cynodia/axiom-core';
import type { EntityDef, ReadPolicyDef, RelationshipDef, StateDef } from '@cynodia/axiom-core';

const E_ORDER = nodeId('entity_order');
const E_ACCOUNT = nodeId('entity_account');
const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_ACCOUNT_ID = fieldId('field_order_account_id');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ACCOUNT_ID = fieldId('field_account_id');
const F_ACCOUNT_NAME = fieldId('field_account_name');

function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('app', 'App');
  graph.addNode<EntityDef>({
    id: E_ACCOUNT,
    kind: 'entity',
    name: 'Account',
    identityFieldId: F_ACCOUNT_ID,
    fields: [
      { id: F_ACCOUNT_ID, name: 'Id', valueType: primitiveType('string') },
      { id: F_ACCOUNT_NAME, name: 'Name', valueType: primitiveType('string') },
    ],
  });
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, name: 'Id', valueType: primitiveType('string') },
      { id: F_ORDER_ACCOUNT_ID, name: 'Account', valueType: primitiveType('string') },
      { id: F_ORDER_TOTAL, name: 'Total', valueType: primitiveType('number') },
    ],
  });
  graph.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    name: 'Orders',
    valueType: collectionType({ kind: 'entity', entityId: E_ORDER }),
  });
  return graph;
}

test('schemaVersion defaults to 1 and is a distinct concept from version', () => {
  const graph = new ApplicationGraph('app', 'App', '0.11.0');
  assert.equal(graph.schemaVersion, DEFAULT_SCHEMA_VERSION);
  assert.equal(graph.schemaVersion, 1);
  assert.equal(graph.version, '0.11.0');
  graph.setSchemaVersion(7);
  assert.equal(graph.schemaVersion, 7);
  assert.equal(graph.version, '0.11.0');
});

test('setSchemaVersion rejects a non-positive or non-integer version', () => {
  const graph = new ApplicationGraph('app', 'App');
  assert.throws(() => graph.setSchemaVersion(0));
  assert.throws(() => graph.setSchemaVersion(-3));
  assert.throws(() => graph.setSchemaVersion(2.5));
});

test('schemaVersion survives serialize / deserialize', () => {
  const graph = baseGraph();
  graph.setSchemaVersion(4);
  const restored = ApplicationGraph.deserialize(graph.serialize());
  assert.equal(restored.schemaVersion, 4);
});

test('the fingerprint is deterministic and stable across rebuilds', () => {
  assert.equal(schemaFingerprint(baseGraph()), schemaFingerprint(baseGraph()));
  assert.match(schemaFingerprint(baseGraph()), /^[0-9a-f]{64}$/);
});

test('the projection carries the algorithm version and the schema version', () => {
  const graph = baseGraph();
  graph.setSchemaVersion(3);
  const projection = schemaProjection(graph);
  assert.equal(projection.fingerprintVersion, SCHEMA_FINGERPRINT_VERSION);
  assert.equal(projection.schemaVersion, 3);
});

test('renaming a label or field name does not change the fingerprint (spec11 §7, §16)', () => {
  const before = schemaFingerprint(baseGraph());
  const graph = baseGraph();
  const order = graph.getNode<EntityDef>(E_ORDER)!;
  order.name = 'Purchase Order';
  order.fields = order.fields.map((f) =>
    f.id === F_ORDER_TOTAL ? { ...f, name: 'Grand total' } : f,
  );
  graph.updateNode(order);
  assert.equal(schemaFingerprint(graph), before);
});

test('presentation, metadata and declaration order do not change the fingerprint', () => {
  const before = schemaFingerprint(baseGraph());

  const reordered = new ApplicationGraph('app', 'App');
  // Add the Order entity first this time, with its fields in a different order.
  reordered.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ORDER_ID,
    metadata: { note: 'irrelevant' },
    fields: [
      { id: F_ORDER_TOTAL, valueType: primitiveType('number') },
      { id: F_ORDER_ID, valueType: primitiveType('string') },
      { id: F_ORDER_ACCOUNT_ID, valueType: primitiveType('string') },
    ],
  });
  reordered.addNode<EntityDef>({
    id: E_ACCOUNT,
    kind: 'entity',
    identityFieldId: F_ACCOUNT_ID,
    fields: [
      { id: F_ACCOUNT_NAME, valueType: primitiveType('string') },
      { id: F_ACCOUNT_ID, valueType: primitiveType('string') },
    ],
  });
  reordered.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType({ kind: 'entity', entityId: E_ORDER }),
  });

  assert.equal(schemaFingerprint(reordered), before);
});

test('enum membership order does not change the fingerprint', () => {
  const a = baseGraph();
  const orderA = a.getNode<EntityDef>(E_ORDER)!;
  orderA.fields.push({ id: F_ORDER_STATUS, valueType: enumType(['draft', 'open', 'closed']) });
  a.updateNode(orderA);

  const b = baseGraph();
  const orderB = b.getNode<EntityDef>(E_ORDER)!;
  orderB.fields.push({ id: F_ORDER_STATUS, valueType: enumType(['closed', 'draft', 'open']) });
  b.updateNode(orderB);

  assert.equal(schemaFingerprint(a), schemaFingerprint(b));
});

test('adding a field changes the fingerprint', () => {
  const before = schemaFingerprint(baseGraph());
  const graph = baseGraph();
  const order = graph.getNode<EntityDef>(E_ORDER)!;
  order.fields.push({ id: F_ORDER_STATUS, valueType: primitiveType('string') });
  graph.updateNode(order);
  assert.notEqual(schemaFingerprint(graph), before);
});

test('making a field required changes the fingerprint', () => {
  const before = schemaFingerprint(baseGraph());
  const graph = baseGraph();
  const order = graph.getNode<EntityDef>(E_ORDER)!;
  order.fields = order.fields.map((f) =>
    f.id === F_ORDER_TOTAL ? { ...f, required: true } : f,
  );
  graph.updateNode(order);
  assert.notEqual(schemaFingerprint(graph), before);
});

test('changing a field type changes the fingerprint', () => {
  const before = schemaFingerprint(baseGraph());
  const graph = baseGraph();
  const order = graph.getNode<EntityDef>(E_ORDER)!;
  order.fields = order.fields.map((f) =>
    f.id === F_ORDER_TOTAL ? { ...f, valueType: optionalType(primitiveType('number')) } : f,
  );
  graph.updateNode(order);
  assert.notEqual(schemaFingerprint(graph), before);
});

test('bumping the schema version changes the fingerprint', () => {
  const before = schemaFingerprint(baseGraph());
  const graph = baseGraph();
  graph.setSchemaVersion(2);
  assert.notEqual(schemaFingerprint(graph), before);
});

test('a derived state is distinguished from a stored one of the same type', () => {
  const stored = baseGraph();
  stored.addNode<StateDef>({
    id: nodeId('state_total'),
    kind: 'state',
    valueType: primitiveType('number'),
  });

  const derived = baseGraph();
  derived.addNode<StateDef>({
    id: nodeId('state_total'),
    kind: 'state',
    valueType: primitiveType('number'),
    derivation: { kind: 'literal', value: 0 },
  });

  assert.notEqual(schemaFingerprint(stored), schemaFingerprint(derived));
});

test('an ephemeral state contributes nothing to the fingerprint', () => {
  const before = schemaFingerprint(baseGraph());
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_panel_open'),
    kind: 'state',
    valueType: primitiveType('boolean'),
    ephemeral: true,
  });
  assert.equal(schemaFingerprint(graph), before);
});

test('a relationship endpoint change changes the fingerprint', () => {
  const withRel = (): ApplicationGraph => {
    const graph = baseGraph();
    graph.addNode<RelationshipDef>({
      id: nodeId('rel_order_account'),
      kind: 'relationship',
      cardinality: 'to-one',
      from: { entityId: E_ORDER, fieldId: F_ORDER_ACCOUNT_ID },
      to: { entityId: E_ACCOUNT, fieldId: F_ACCOUNT_ID },
    });
    return graph;
  };
  const before = schemaFingerprint(withRel());
  const changed = withRel();
  const rel = changed.getNode<RelationshipDef>(nodeId('rel_order_account'))!;
  rel.cardinality = 'to-many';
  changed.updateNode(rel);
  assert.notEqual(schemaFingerprint(changed), before);
});

test('which entity a read policy governs is in the fingerprint; its predicate is not', () => {
  const withPolicy = (predicateValue: boolean): ApplicationGraph => {
    const graph = baseGraph();
    graph.addNode<ReadPolicyDef>({
      id: nodeId('policy_order'),
      kind: 'read-policy',
      entityId: E_ORDER,
      rowScopeId: nodeId('scope_policy_order'),
      predicate: { kind: 'literal', value: predicateValue },
    });
    return graph;
  };
  // Predicate excluded — an authorization change, not a data-schema change (spec11 §42).
  assert.equal(schemaFingerprint(withPolicy(true)), schemaFingerprint(withPolicy(false)));

  const noPolicy = schemaFingerprint(baseGraph());
  assert.notEqual(schemaFingerprint(withPolicy(true)), noPolicy);
});

test('canonicalJSON sorts keys recursively and drops undefined', () => {
  assert.equal(
    canonicalJSON({ b: 1, a: { d: 4, c: 3 }, e: undefined }),
    '{"a":{"c":3,"d":4},"b":1}',
  );
  assert.equal(canonicalJSON([{ b: 2, a: 1 }]), '[{"a":1,"b":2}]');
});
