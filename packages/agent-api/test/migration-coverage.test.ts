import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  collectionType,
  diffSchema,
  entityType,
  fieldId,
  literal,
  migrationCoversDiff,
  nodeId,
  primitiveType,
} from '@cynodia/axiom-core';
import type { EntityDef, MigrationDef, MigrationOperation, StateDef } from '@cynodia/axiom-core';
import { migrationImpact } from '@cynodia/axiom-agent-api';

/**
 * Permanent regression guard for D-3 (spec11.1 §22-28, §50): migration coverage is scoped to
 * the semantic transition being evaluated, not to every migration a graph carries. A
 * historical operation from an earlier step must never turn `covered` into a false negative,
 * and `covered: false` is always explained by `uncovered` / `unmatched` / `steps`.
 *
 * It also runs the §27 AgentAPI matrix: single step, multi-step chain, chain with a gap,
 * same version, metadata-only diff, an uncovered required field, and a covered destructive
 * change — checking both the boolean verdict and the explanation payload each time.
 */

const E = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_TOTAL = fieldId('field_order_total');
const F_STATUS = fieldId('field_order_status');
const F_PRIORITY = fieldId('field_order_priority');
const S = nodeId('state_orders');

const M_1_2: MigrationDef = {
  id: nodeId('m_1_2'),
  kind: 'migration',
  fromSchema: 1,
  toSchema: 2,
  operations: [
    {
      id: nodeId('op_add_status'),
      kind: 'add-field',
      entityId: E,
      field: { id: F_STATUS, valueType: primitiveType('string'), required: true },
      populate: literal('draft'),
    },
  ],
};
const M_2_3: MigrationDef = {
  id: nodeId('m_2_3'),
  kind: 'migration',
  fromSchema: 2,
  toSchema: 3,
  operations: [
    {
      id: nodeId('op_add_priority'),
      kind: 'add-field',
      entityId: E,
      field: { id: F_PRIORITY, valueType: primitiveType('string'), required: true },
      populate: literal('normal'),
    },
  ],
};
const M_3_4: MigrationDef = {
  id: nodeId('m_3_4'),
  kind: 'migration',
  fromSchema: 3,
  toSchema: 4,
  operations: [
    { id: nodeId('op_drop_total'), kind: 'remove-field', entityId: E, fieldId: F_TOTAL, destructive: true },
  ],
};

const ALL_STEPS = [M_1_2, M_2_3, M_3_4];

interface GraphOpts {
  /** Replace a step's operations (e.g. to make a required field uncovered). */
  overrideOps?: Record<string, MigrationOperation[]>;
  /** Migration ids to leave out, producing a chain gap. */
  omit?: string[];
  /** Add a read-policy to the graph (a metadata-only, authorization-semantic change). */
  readPolicy?: boolean;
}

function orderGraph(version: number, opts: GraphOpts = {}): ApplicationGraph {
  const graph = new ApplicationGraph('shop', 'Shop', '0.11.0');
  graph.setSchemaVersion(version);
  const fields: EntityDef['fields'] = [{ id: F_ID, valueType: primitiveType('string') }];
  if (version <= 3) fields.push({ id: F_TOTAL, valueType: primitiveType('number') });
  if (version >= 2) fields.push({ id: F_STATUS, valueType: primitiveType('string'), required: true });
  if (version >= 3) fields.push({ id: F_PRIORITY, valueType: primitiveType('string'), required: true });
  graph.addNode<EntityDef>({ id: E, kind: 'entity', identityFieldId: F_ID, fields });
  graph.addNode<StateDef>({
    id: S,
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  for (const step of ALL_STEPS) {
    if (step.toSchema > version) continue;
    if (opts.omit?.includes(String(step.id))) continue;
    const override = opts.overrideOps?.[String(step.id)];
    graph.addNode<MigrationDef>(override ? { ...step, operations: override } : step);
  }
  if (opts.readPolicy) {
    graph.addNode({
      id: nodeId('policy_order'),
      kind: 'read-policy',
      entityId: E,
      rowScopeId: nodeId('scope_policy'),
      predicate: literal(true),
    } as never);
  }
  return graph;
}

test('D-3: a historical migration in `next` does not make a single-step diff a false negative', () => {
  const b = orderGraph(2); // carries m_1_2
  const c = orderGraph(3); // carries m_1_2 AND m_2_3
  const diff = diffSchema(b, c);
  assert.equal(diff.fromVersion, 2);
  assert.equal(diff.toVersion, 3);
  assert.equal(diff.entries.length, 1);
  assert.equal(diff.entries[0].fieldId, String(F_PRIORITY));

  // The step's own operations cover the diff exactly.
  assert.equal(migrationCoversDiff(diff, M_2_3.operations).covered, true);

  // Feeding every historical operation into the endpoint diff is what produced the bug:
  // m_1_2's add-status op matches nothing in a 2 → 3 diff.
  const flattened = migrationCoversDiff(diff, [...M_1_2.operations, ...M_2_3.operations]);
  assert.equal(flattened.covered, false);
  assert.equal(flattened.unmatched.length, 1);

  // migrationImpact must agree with the step-scoped check, not the flattened one.
  const impact = migrationImpact(b, c);
  assert.equal(impact.covered, true);
  assert.equal(impact.coverageMode, 'step');
  assert.equal(impact.unmatched.length, 0);
  assert.equal(impact.uncovered.length, 0);
  assert.deepEqual(
    impact.steps.map((s) => s.migrationId),
    [String(M_2_3.id)],
  );
});

test('§26: migrationImpact and migrationCoversDiff agree on a valid single step', () => {
  const b = orderGraph(2);
  const c = orderGraph(3);
  const diff = diffSchema(b, c);
  const primitive = migrationCoversDiff(diff, M_2_3.operations);
  const impact = migrationImpact(b, c);
  assert.equal(impact.covered, primitive.covered);
  assert.deepEqual(impact.uncovered, primitive.uncovered);
  assert.deepEqual(impact.unmatched, primitive.unmatched);
});

test('§27: a multi-step diff reports chain coverage, not per-step coverage', () => {
  const impact = migrationImpact(orderGraph(1), orderGraph(4));
  assert.equal(impact.coverageMode, 'chain');
  assert.equal(impact.covered, true); // a complete 1 → 2 → 3 → 4 chain exists
  assert.deepEqual(
    impact.steps.map((s) => s.migrationId),
    [String(M_1_2.id), String(M_2_3.id), String(M_3_4.id)],
  );
});

test('§27: a multi-step diff with a chain gap is uncovered and says so', () => {
  const impact = migrationImpact(orderGraph(1), orderGraph(4, { omit: [String(M_2_3.id)] }));
  assert.equal(impact.coverageMode, 'chain');
  assert.equal(impact.covered, false);
  assert.ok(impact.uncovered.length > 0, 'uncovered names the data-affecting entries');
  assert.equal(impact.steps.length, 0, 'no chain, so no ordered steps');
});

test('§27: same version on both sides is coverageMode "none" and covered', () => {
  const impact = migrationImpact(orderGraph(2), orderGraph(2));
  assert.equal(impact.coverageMode, 'none');
  assert.equal(impact.covered, true);
  assert.equal(impact.diff.entries.length, 0);
});

test('§27: a metadata-only diff needs no data operation and is covered', () => {
  const impact = migrationImpact(orderGraph(2), orderGraph(2, { readPolicy: true }));
  assert.equal(impact.covered, true);
  assert.equal(impact.dataLossPossible, false);
  assert.deepEqual(impact.authorizationChanges, [String(nodeId('policy_order'))]);
});

test('§27: an uncovered required field is a false verdict with a named entry', () => {
  const b = orderGraph(2);
  const c = orderGraph(3, { overrideOps: { [String(M_2_3.id)]: [] } }); // step exists, does nothing
  const impact = migrationImpact(b, c);
  assert.equal(impact.coverageMode, 'step');
  assert.equal(impact.covered, false);
  assert.equal(impact.uncovered.length, 1);
  assert.equal(impact.uncovered[0].fieldId, String(F_PRIORITY));
});

test('§27: a covered destructive change reports covered:true and dataLossPossible:true', () => {
  const impact = migrationImpact(orderGraph(3), orderGraph(4));
  assert.equal(impact.coverageMode, 'step');
  assert.equal(impact.covered, true);
  assert.equal(impact.dataLossPossible, true);
  assert.deepEqual(impact.affectedFields, [String(F_TOTAL)]);
});
