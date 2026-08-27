import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  SCHEMA_CHANGE_CLASSES,
  addField,
  classifyFieldTypeChange,
  collectionType,
  diffSchema,
  enumType,
  fieldId,
  literal,
  migrationCoversDiff,
  nodeId,
  optionalType,
  primitiveType,
  removeField,
} from '@cynodia/axiom-core';
import type { EntityDef, MigrationOperation, StateDef } from '@cynodia/axiom-core';

const E_ORDER = nodeId('entity_order');
const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_NOTE = fieldId('field_order_note');
const F_ORDER_LEGACY = fieldId('field_order_legacy');

function graph(build: (g: ApplicationGraph) => void, schemaVersion = 1): ApplicationGraph {
  const g = new ApplicationGraph('app', 'App', '0.11.0');
  if (schemaVersion !== 1) g.setSchemaVersion(schemaVersion);
  g.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string') },
      { id: F_ORDER_TOTAL, valueType: primitiveType('number') },
    ],
  });
  g.addNode<StateDef>({
    id: nodeId('state_orders'),
    kind: 'state',
    valueType: collectionType({ kind: 'entity', entityId: E_ORDER }),
  });
  build(g);
  return g;
}

const noop = (): void => {};

test('an identical schema has an empty diff and a presentation-only verdict', () => {
  const diff = diffSchema(graph(noop), graph(noop));
  assert.deepEqual(diff.entries, []);
  assert.equal(diff.verdict, 'presentation-only');
});

test('renaming a label produces no diff entry', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.name = 'Purchase order';
    order.fields = order.fields.map((f) => (f.id === F_ORDER_TOTAL ? { ...f, name: 'Grand total' } : f));
    g.updateNode(order);
  });
  assert.deepEqual(diffSchema(before, after).entries, []);
});

test('an added optional field is persistence-compatible; an added required field is migration-required', () => {
  const before = graph(noop);
  const optionalAdded = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields.push({ id: F_ORDER_NOTE, valueType: optionalType(primitiveType('string')) });
    g.updateNode(order);
  });
  const requiredAdded = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields.push({ id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true });
    g.updateNode(order);
  });

  const d1 = diffSchema(before, optionalAdded);
  assert.equal(d1.entries.length, 1);
  assert.equal(d1.entries[0].kind, 'field-added');
  assert.equal(d1.entries[0].class, 'persistence-compatible');

  const d2 = diffSchema(before, requiredAdded);
  assert.equal(d2.entries[0].class, 'migration-required');
  assert.equal(d2.verdict, 'migration-required');
});

test('a removed field is destructive and reported as data loss', () => {
  const before = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields.push({ id: F_ORDER_LEGACY, valueType: primitiveType('string') });
    g.updateNode(order);
  });
  const after = graph(noop);
  const diff = diffSchema(before, after);
  assert.equal(diff.entries[0].kind, 'field-removed');
  assert.equal(diff.entries[0].class, 'destructive');
  assert.equal(diff.entries[0].dataLoss, true);
  assert.equal(diff.destructive.length, 1);
});

test('a removed entity is destructive', () => {
  const before = graph(noop);
  const after = new ApplicationGraph('app', 'App', '0.11.0');
  const diff = diffSchema(before, { schemaVersion: 1, entities: [], states: [], relationships: [], readPolicies: [] });
  assert.ok(diff.entries.some((e) => e.kind === 'entity-removed' && e.class === 'destructive'));
  void after;
});

test('classifyFieldTypeChange: identical, widen-to-optional, narrow, enum growth/shrink, kind change', () => {
  assert.equal(classifyFieldTypeChange(primitiveType('number'), primitiveType('number')).class, 'presentation-only');
  assert.equal(
    classifyFieldTypeChange(primitiveType('string'), optionalType(primitiveType('string'))).class,
    'persistence-compatible',
  );
  assert.equal(
    classifyFieldTypeChange(optionalType(primitiveType('string')), primitiveType('string')).class,
    'migration-required',
  );
  assert.equal(
    classifyFieldTypeChange(enumType(['a', 'b']), enumType(['a', 'b', 'c'])).class,
    'persistence-compatible',
  );
  const shrink = classifyFieldTypeChange(enumType(['a', 'b', 'c']), enumType(['a', 'b']));
  assert.equal(shrink.class, 'destructive');
  assert.equal(shrink.dataLoss, true);
  assert.equal(classifyFieldTypeChange(primitiveType('string'), primitiveType('number')).class, 'migration-required');
  assert.equal(
    classifyFieldTypeChange(collectionType(primitiveType('string')), primitiveType('string')).class,
    'destructive',
  );
});

test('a field type change surfaces the from/to types in details', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields = order.fields.map((f) =>
      f.id === F_ORDER_TOTAL ? { ...f, valueType: primitiveType('string') } : f,
    );
    g.updateNode(order);
  });
  const diff = diffSchema(before, after);
  assert.equal(diff.entries[0].kind, 'field-type-changed');
  assert.equal(diff.entries[0].class, 'migration-required');
  assert.ok(diff.entries[0].details?.from);
  assert.ok(diff.entries[0].details?.to);
});

test('required <-> optional flips classify by direction', () => {
  const before = graph(noop);
  const nowRequired = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields = order.fields.map((f) => (f.id === F_ORDER_TOTAL ? { ...f, required: true } : f));
    g.updateNode(order);
  });
  assert.equal(diffSchema(before, nowRequired).entries[0].class, 'migration-required');
  assert.equal(diffSchema(nowRequired, before).entries[0].class, 'persistence-compatible');
});

test('a removed field and an added field are two entries — never paired as a rename (spec11 §60)', () => {
  const before = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields.push({ id: F_ORDER_LEGACY, valueType: primitiveType('string') });
    g.updateNode(order);
  });
  const after = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields.push({ id: F_ORDER_NOTE, valueType: primitiveType('string') });
    g.updateNode(order);
  });
  const diff = diffSchema(before, after);
  const kinds = diff.entries.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['field-added', 'field-removed']);
  // The diff does NOT invent a rename; nothing is classified as incompatible-ambiguous by
  // the diff alone — the coverage check is what forces explicit intent.
});

test('changing the identity field is incompatible-ambiguous', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.identityFieldId = F_ORDER_TOTAL;
    g.updateNode(order);
  });
  const diff = diffSchema(before, after);
  assert.ok(diff.entries.some((e) => e.kind === 'identity-changed' && e.class === 'incompatible-ambiguous'));
  assert.equal(diff.verdict, 'incompatible-ambiguous');
});

test('read policy add/remove is persistence-compatible but flagged as an authorization change', () => {
  const before = graph(noop);
  const after = graph((g) => {
    g.addNode({
      id: nodeId('policy_order'),
      kind: 'read-policy',
      entityId: E_ORDER,
      rowScopeId: nodeId('scope_policy_order'),
      predicate: literal(true),
    } as never);
  });
  const diff = diffSchema(before, after);
  const entry = diff.entries.find((e) => e.kind === 'read-policy-added');
  assert.ok(entry);
  assert.equal(entry!.class, 'persistence-compatible');
  assert.equal(entry!.authorizationChange, true);
});

test('SCHEMA_CHANGE_CLASSES enumerates all five', () => {
  assert.deepEqual([...SCHEMA_CHANGE_CLASSES], [
    'presentation-only',
    'persistence-compatible',
    'migration-required',
    'destructive',
    'incompatible-ambiguous',
  ]);
});

test('migrationCoversDiff: covered when every data-affecting entry has a matching operation', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields.push({ id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true });
    g.updateNode(order);
  }, 2);
  const diff = diffSchema(before, after);
  const ops: MigrationOperation[] = [
    addField(nodeId('op1'), E_ORDER, { id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true }, {
      populate: literal('draft'),
    }),
  ];
  const coverage = migrationCoversDiff(diff, ops);
  assert.equal(coverage.covered, true);
  assert.deepEqual(coverage.uncovered, []);
  assert.deepEqual(coverage.unmatched, []);
});

test('migrationCoversDiff: uncovered entry when a required change has no operation', () => {
  const before = graph(noop);
  const after = graph((g) => {
    const order = g.getNode<EntityDef>(E_ORDER)!;
    order.fields.push({ id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true });
    order.fields.push({ id: F_ORDER_NOTE, valueType: primitiveType('string'), required: true });
    g.updateNode(order);
  }, 2);
  const diff = diffSchema(before, after);
  const ops: MigrationOperation[] = [
    addField(nodeId('op1'), E_ORDER, { id: F_ORDER_STATUS, valueType: primitiveType('string'), required: true }, {
      populate: literal('draft'),
    }),
  ];
  const coverage = migrationCoversDiff(diff, ops);
  assert.equal(coverage.covered, false);
  assert.equal(coverage.uncovered.length, 1);
  assert.equal(coverage.uncovered[0].fieldId, F_ORDER_NOTE);
});

test('migrationCoversDiff: unmatched operation when a migration describes a change the graphs do not contain', () => {
  const before = graph(noop);
  const after = graph(noop, 2);
  const diff = diffSchema(before, after); // empty
  const ops: MigrationOperation[] = [removeField(nodeId('op1'), E_ORDER, F_ORDER_TOTAL, { destructive: true })];
  const coverage = migrationCoversDiff(diff, ops);
  assert.equal(coverage.covered, false);
  assert.equal(coverage.unmatched.length, 1);
});
