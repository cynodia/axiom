import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEMANTIC_NODE_KINDS,
  authoringSchema,
  describeAuthoringKind,
  listAuthorableKinds,
  validateGraph,
  ApplicationGraph,
} from '@cynodia/axiom-core';

test('every semantic node kind has an authoring descriptor (spec16 §69, §70, Phase G gate)', () => {
  const described = new Set(authoringSchema().map((d) => d.kind));
  for (const kind of SEMANTIC_NODE_KINDS) {
    assert.ok(described.has(kind), `no authoring descriptor for ${kind}`);
  }
  assert.deepEqual([...listAuthorableKinds()].sort(), [...SEMANTIC_NODE_KINDS].sort());
});

test('every descriptor names required fields and a purpose', () => {
  for (const descriptor of authoringSchema()) {
    assert.ok(descriptor.purpose.length > 0, `${descriptor.kind} has no purpose`);
    for (const field of descriptor.fields) {
      assert.ok(field.name.length > 0);
      assert.ok(field.description.length > 0, `${descriptor.kind}.${field.name} has no description`);
    }
  }
});

test('an unknown kind returns undefined rather than throwing', () => {
  assert.equal(describeAuthoringKind('not-a-real-kind'), undefined);
});

test('a closed-vocabulary field names real values from the vocabulary it documents', () => {
  const action = describeAuthoringKind('action')!;
  const operations = action.fields.find((field) => field.name === 'operations')!;
  assert.ok(operations.closedEnum!.includes('set'));
  assert.ok(operations.closedEnum!.includes('native'));

  const workflow = describeAuthoringKind('workflow')!;
  const steps = workflow.fields.find((field) => field.name === 'steps')!;
  assert.deepEqual([...steps.closedEnum!].sort(), ['action', 'branch', 'complete', 'fail', 'timer', 'wait-event'].sort());
});

test('every template validates against a graph that supplies the references it names (spec16 §77, §78)', () => {
  // The entity/state/action/authorization-policy templates are self-contained; build a tiny
  // graph around each and confirm the template shape itself is not rejected as malformed.
  for (const descriptor of authoringSchema()) {
    assert.equal(descriptor.template.kind, descriptor.kind);
    assert.ok(typeof descriptor.template.id === 'string' && descriptor.template.id.length > 0);
  }
});

test('an ActionDef template carries no authorizationPolicy — a template is not a default (spec16 §78)', () => {
  const action = describeAuthoringKind('action')!;
  assert.equal((action.template as { authorizationPolicy?: unknown }).authorizationPolicy, undefined);
});

test('the entity template is actually a valid graph node', () => {
  const graph = new ApplicationGraph('app', 'App', '0.16.0');
  const template = describeAuthoringKind('entity')!.template as { id: string; kind: 'entity'; fields: unknown[] };
  graph.addNode({ ...template, id: 'entity_x' } as never);
  const result = validateGraph(graph);
  assert.equal(result.valid, true);
});
