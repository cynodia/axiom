import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  expressionRef,
  field,
  fieldId,
  filter,
  group,
  groupItems,
  groupKey,
  literal,
  map,
  nodeId,
  object,
  optionalType,
  primitiveType,
  ref,
  sort,
  sum,
  validateGraph,
} from '@cynodia/axiom-core';
import type { ApplicationIR, ExpressionDef, StateDef, TextNode } from '@cynodia/axiom-core';
import { compileToIR, compileToServerIR } from '@cynodia/axiom-compiler';
import {
  RUNTIME_DIAGNOSTIC_CODES,
  createAxiomRuntime,
  createMemoryHost,
  findByNodeId,
  textOf,
} from '@cynodia/axiom-runtime';

/**
 * The 0.7 expression vocabulary, executed.
 *
 * `group` and `expression-ref` are semantics, so what matters is not that they exist but
 * what they *do*: the ordering contract, the strictness every other collection operator
 * already has, and the isolation that makes a named expression mean one thing.
 */
const E_LINE = nodeId('entity_line');
const F_ID = fieldId('field_line_id');
const F_CATEGORY = fieldId('field_line_category');
const F_AMOUNT = fieldId('field_line_amount');
const F_SUPPLIER = fieldId('field_line_supplier');

const E_SUPPLIER = nodeId('entity_supplier');
const F_SUPPLIER_ID = fieldId('field_supplier_id');
const F_SUPPLIER_REGION = fieldId('field_supplier_region');

const S_LINES = nodeId('state_lines');
const S_MISSING = nodeId('state_missing');
const S_LIMIT = nodeId('state_limit');
const SC_GROUP = nodeId('scope_group');
const SC_MEMBER = nodeId('scope_member');
const SC_AMOUNT = nodeId('scope_amount');

const X_OVER_LIMIT = nodeId('expression_over_limit');
const P_LINES = nodeId('param_lines');
const SC_OVER = nodeId('scope_over');

const line = (id: string, category: string, amount: number, region = 'north') => ({
  [F_ID]: id,
  [F_CATEGORY]: category,
  [F_AMOUNT]: amount,
  [F_SUPPLIER]: { [F_SUPPLIER_ID]: `s-${region}`, [F_SUPPLIER_REGION]: region },
});

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('expressions', 'Expressions');
  graph.addNode({
    id: E_SUPPLIER,
    kind: 'entity',
    name: 'Supplier',
    identityFieldId: F_SUPPLIER_ID,
    fields: [
      { id: F_SUPPLIER_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_SUPPLIER_REGION, name: 'Region', valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode({
    id: E_LINE,
    kind: 'entity',
    name: 'Line',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_CATEGORY, name: 'Category', valueType: primitiveType('string'), required: true },
      { id: F_AMOUNT, name: 'Amount', valueType: primitiveType('number'), required: true },
      { id: F_SUPPLIER, name: 'Supplier', valueType: entityType(E_SUPPLIER), required: true },
    ],
  });
  graph.addNode({
    id: S_LINES,
    kind: 'state',
    name: 'lines',
    valueType: collectionType(entityType(E_LINE)),
    initialValue: [
      line('l1', 'tools', 10),
      line('l2', 'parts', 5, 'south'),
      line('l3', 'tools', 7),
      line('l4', 'paint', 3, 'south'),
      line('l5', 'parts', 2, 'south'),
    ],
  });
  graph.addNode({
    id: S_MISSING,
    kind: 'state',
    name: 'missing',
    valueType: optionalType(collectionType(entityType(E_LINE))),
    initialValue: null,
  });
  graph.addNode({
    id: S_LIMIT,
    kind: 'state',
    name: 'limit',
    valueType: primitiveType('number'),
    initialValue: 6,
  });
  graph.addNode({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

function derived(graph: ApplicationGraph, id: string, valueType: StateDef['valueType'], derivation: StateDef['derivation']) {
  graph.addNode<StateDef>({ id: nodeId(id), kind: 'state', valueType, derivation });
  return nodeId(id);
}

function createApp(graph: ApplicationGraph) {
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  return { app, host };
}

// ------------------------------------------------------------------- group

test('groups appear in first-appearance order, with members in source order', () => {
  const graph = buildGraph();
  const keys = derived(
    graph,
    'state_keys',
    collectionType(primitiveType('string')),
    map(group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_CATEGORY)), SC_MEMBER, groupKey(ref(SC_MEMBER))),
  );
  const { app } = createApp(graph);
  assert.deepEqual(app.getState(keys), ['tools', 'parts', 'paint'], 'not sorted — first seen');
});

test('a group carries its members, in the order the source had them', () => {
  const graph = buildGraph();
  const grouped = derived(
    graph,
    'state_grouped',
    collectionType({
      kind: 'group',
      keyType: primitiveType('string'),
      itemType: entityType(E_LINE),
    }),
    group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_CATEGORY)),
  );

  const { app } = createApp(graph);
  const groups = app.getState(grouped) as Array<Record<string, unknown>>;
  assert.deepEqual(
    groups.map((entry) => [entry.field_group_key, (entry.field_group_items as unknown[]).length]),
    [
      ['tools', 2],
      ['parts', 2],
      ['paint', 1],
    ],
  );
  assert.deepEqual(
    (groups[0].field_group_items as Array<Record<string, unknown>>).map((item) => item[F_ID]),
    ['l1', 'l3'],
  );
});

test('subtotals per group are one expression, not one per known key', () => {
  const graph = buildGraph();
  const subtotals = derived(
    graph,
    'state_subtotals',
    collectionType(primitiveType('number')),
    map(
      group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_CATEGORY)),
      SC_MEMBER,
      sum(map(groupItems(ref(SC_MEMBER)), SC_AMOUNT, field(ref(SC_AMOUNT), F_AMOUNT))),
    ),
  );

  const { app } = createApp(graph);
  assert.deepEqual(app.getState(subtotals), [17, 7, 3]);
});

test('a key may be an open-ended value, including a nested entity', () => {
  const graph = buildGraph();
  // Grouping by the whole supplier record: keys are compared structurally.
  const counts = derived(
    graph,
    'state_by_supplier',
    collectionType(primitiveType('number')),
    map(
      group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_SUPPLIER)),
      SC_MEMBER,
      call('count', groupItems(ref(SC_MEMBER))),
    ),
  );
  const regions = derived(
    graph,
    'state_regions',
    collectionType(primitiveType('string')),
    map(
      group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_SUPPLIER)),
      SC_MEMBER,
      field(groupKey(ref(SC_MEMBER)), F_SUPPLIER_REGION),
    ),
  );

  const { app } = createApp(graph);
  assert.deepEqual(app.getState(counts), [2, 3]);
  assert.deepEqual(app.getState(regions), ['north', 'south']);
});

test('an empty collection produces no groups, and a missing one fails the evaluation', () => {
  const graph = buildGraph();
  const empty = derived(
    graph,
    'state_empty_groups',
    collectionType(primitiveType('string')),
    map(
      group(filter(ref(S_LINES), SC_GROUP, literal(false)), nodeId('scope_empty'), field(ref(nodeId('scope_empty')), F_CATEGORY)),
      SC_MEMBER,
      groupKey(ref(SC_MEMBER)),
    ),
  );
  const missing = derived(
    graph,
    'state_missing_groups',
    collectionType(primitiveType('string')),
    map(
      group(ref(S_MISSING), nodeId('scope_absent'), field(ref(nodeId('scope_absent')), F_CATEGORY)),
      SC_MEMBER,
      groupKey(ref(SC_MEMBER)),
    ),
  );

  const { app } = createApp(graph);
  assert.deepEqual(app.getState(empty), []);
  assert.equal(app.getState(missing), null, 'a null collection is a failure, not an empty group set');
  assert.ok(
    app
      .diagnostics()
      .some(
        (diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.EXPRESSION_EVALUATION_FAILED,
      ),
    'and it says so',
  );
});

test('groups can be ordered by sorting them, which is the operator whose job that is', () => {
  const graph = buildGraph();
  const ordered = derived(
    graph,
    'state_ordered_keys',
    collectionType(primitiveType('string')),
    map(
      sort(
        group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_CATEGORY)),
        SC_MEMBER,
        groupKey(ref(SC_MEMBER)),
      ),
      nodeId('scope_ordered'),
      groupKey(ref(nodeId('scope_ordered'))),
    ),
  );

  const { app } = createApp(graph);
  assert.deepEqual(app.getState(ordered), ['paint', 'parts', 'tools']);
});

test('a repeat renders one row per group, and its template reads the group', () => {
  const graph = buildGraph();
  const grouped = derived(
    graph,
    'state_grouped_rows',
    collectionType({ kind: 'group', keyType: primitiveType('string'), itemType: entityType(E_LINE) }),
    group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_CATEGORY)),
  );
  const repeat = nodeId('ui_group_rows');
  graph.addNode<TextNode>({
    id: nodeId('ui_group_heading'),
    kind: 'text',
    value: call(
      'concat',
      groupKey(ref(repeat)),
      literal(': '),
      call('to-string', sum(map(groupItems(ref(repeat)), SC_AMOUNT, field(ref(SC_AMOUNT), F_AMOUNT)))),
    ),
  });
  graph.addNode({
    id: repeat,
    kind: 'repeat',
    source: ref(grouped),
    templateId: nodeId('ui_group_heading'),
  });
  graph.updateNode({ id: nodeId('ui_view'), kind: 'view', children: [repeat] });

  const { app, host } = createApp(graph);
  assert.deepEqual(validateGraph(graph).errors, []);
  assert.deepEqual(
    findByNodeId(host.root, 'ui_group_heading').map((element) => textOf(element)),
    ['tools: 17', 'parts: 7', 'paint: 3'],
  );
  assert.deepEqual(app.diagnostics(), []);
});

// --------------------------------------------------------- reusable expressions

/** "the lines above the limit", named once. */
function overLimit(): ExpressionDef {
  return {
    id: X_OVER_LIMIT,
    kind: 'expression',
    name: 'over limit',
    parameters: [{ id: P_LINES, valueType: collectionType(entityType(E_LINE)) }],
    expression: filter(ref(P_LINES), SC_OVER, binary('gt', field(ref(SC_OVER), F_AMOUNT), ref(S_LIMIT))),
  };
}

test('one definition serves a derived state, a guard and a visibility condition', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(overLimit());
  const use = expressionRef(X_OVER_LIMIT, { [P_LINES]: ref(S_LINES) });

  const count = derived(graph, 'state_over_count', primitiveType('number'), call('count', use));
  graph.addNode<TextNode>({
    id: nodeId('ui_over_warning'),
    kind: 'text',
    value: literal('Some lines are over the limit'),
    visibleWhen: call('non-empty', use),
  });
  graph.addNode({
    id: nodeId('action_clear'),
    kind: 'action',
    name: 'clear',
    guards: [
      {
        condition: call('non-empty', use),
        failureMode: { code: 'nothing-over-limit', message: 'No line is over the limit.' },
      },
    ],
    operations: [{ kind: 'set', target: { kind: 'state', stateId: S_LIMIT }, value: literal(100) }],
  });
  graph.updateNode({ id: nodeId('ui_view'), kind: 'view', children: [nodeId('ui_over_warning')] });

  const { app, host } = createApp(graph);
  assert.deepEqual(validateGraph(graph).errors, []);
  assert.equal(app.getState(count), 2, 'l1 (10) and l3 (7) are above 6');
  assert.equal(findByNodeId(host.root, 'ui_over_warning').length, 1);

  // The guard passes while something is over the limit, and refuses once nothing is.
  assert.equal(app.invokeAction(nodeId('action_clear')).ok, true);
  const refused = app.invokeAction(nodeId('action_clear'));
  assert.equal(refused.ok, false);
  assert.equal(refused.diagnostics[0]?.details?.failureMode, 'nothing-over-limit');
  // Every consumer follows the same edit, because there is only one calculation.
  assert.equal(app.getState(count), 0);
});

test('a definition is evaluated in isolation: the caller’s scope is invisible to it', () => {
  const graph = buildGraph();
  // A definition whose own scope id is the same one the caller uses. Under a copied
  // expression this is where the collision would be; here the two cannot meet.
  graph.addNode<ExpressionDef>({
    id: nodeId('expression_total'),
    kind: 'expression',
    parameters: [{ id: P_LINES, valueType: collectionType(entityType(E_LINE)) }],
    expression: sum(map(ref(P_LINES), SC_MEMBER, field(ref(SC_MEMBER), F_AMOUNT))),
  });
  const perCategory = derived(
    graph,
    'state_per_category',
    collectionType(primitiveType('number')),
    map(
      group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_CATEGORY)),
      SC_MEMBER,
      expressionRef(nodeId('expression_total'), { [P_LINES]: groupItems(ref(SC_MEMBER)) }),
    ),
  );

  const { app } = createApp(graph);
  assert.deepEqual(validateGraph(graph).errors, []);
  assert.deepEqual(app.getState(perCategory), [17, 7, 3]);
});

test('a definition reached through another definition still evaluates', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(overLimit());
  graph.addNode<ExpressionDef>({
    id: nodeId('expression_over_limit_total'),
    kind: 'expression',
    parameters: [{ id: nodeId('param_source'), valueType: collectionType(entityType(E_LINE)) }],
    expression: sum(
      map(
        expressionRef(X_OVER_LIMIT, { [P_LINES]: ref(nodeId('param_source')) }),
        SC_AMOUNT,
        field(ref(SC_AMOUNT), F_AMOUNT),
      ),
    ),
  });
  const total = derived(
    graph,
    'state_over_total',
    primitiveType('number'),
    expressionRef(nodeId('expression_over_limit_total'), { [nodeId('param_source')]: ref(S_LINES) }),
  );

  const { app } = createApp(graph);
  assert.equal(app.getState(total), 17);
});

test('an action can write through a reused calculation', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(overLimit());
  graph.addNode({
    id: nodeId('action_archive_over_limit'),
    kind: 'action',
    name: 'archive over limit',
    operations: [
      {
        kind: 'for-each',
        collection: expressionRef(X_OVER_LIMIT, { [P_LINES]: ref(S_LINES) }),
        scopeId: nodeId('scope_each'),
        operations: [
          {
            kind: 'set',
            target: {
              kind: 'field',
              target: {
                kind: 'collection-item',
                collection: { kind: 'state', stateId: S_LINES },
                selector: { kind: 'identity', fieldId: F_ID, value: field(ref(nodeId('scope_each')), F_ID) },
              },
              fieldId: F_AMOUNT,
            },
            value: literal(0),
          },
        ],
      },
    ],
  });

  const { app } = createApp(graph);
  assert.deepEqual(validateGraph(graph).errors, []);
  assert.equal(app.invokeAction(nodeId('action_archive_over_limit')).ok, true);
  assert.deepEqual(
    (app.getState(S_LINES) as Array<Record<string, number>>).map((entry) => entry[F_AMOUNT]),
    [0, 5, 0, 3, 2],
  );
});

// ------------------------------------------------------------------- the IR

test('the IR carries definitions as data, and the runtime resolves them from it', () => {
  const graph = buildGraph();
  graph.addNode<ExpressionDef>(overLimit());
  derived(
    graph,
    'state_over',
    collectionType(entityType(E_LINE)),
    expressionRef(X_OVER_LIMIT, { [P_LINES]: ref(S_LINES) }),
  );

  const ir: ApplicationIR = compileToIR(graph);
  assert.deepEqual(Object.keys(ir.expressionDefs), [String(X_OVER_LIMIT)]);
  // Data, not a closure: it survives a serialization round trip and still executes.
  const restored = JSON.parse(JSON.stringify(ir)) as ApplicationIR;
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: restored, rootElement: host.root, host });
  app.start();
  assert.equal((app.getState(nodeId('state_over')) as unknown[]).length, 2);
});

test('a Server IR that uses the 0.7 vocabulary says so, and one that does not stays v1', () => {
  const plain = buildGraph();
  plain.updateNode({ ...plain.getNode<StateDef>(S_LINES)!, authority: 'server' });
  plain.addNode({
    id: nodeId('action_add'),
    kind: 'action',
    name: 'add',
    operations: [
      {
        kind: 'insert',
        target: { kind: 'state', stateId: S_LINES },
        value: object(
          [
            { fieldId: F_ID, value: call('uuid') },
            { fieldId: F_CATEGORY, value: literal('tools') },
            { fieldId: F_AMOUNT, value: literal(1) },
            {
              fieldId: F_SUPPLIER,
              value: object(
                [
                  { fieldId: F_SUPPLIER_ID, value: literal('s-north') },
                  { fieldId: F_SUPPLIER_REGION, value: literal('north') },
                ],
                E_SUPPLIER,
              ),
            },
          ],
          E_LINE,
        ),
      },
    ],
  });
  assert.equal(compileToServerIR(plain).contract, 'axiom.server.v1');

  const grouping = ApplicationGraph.deserialize(plain.serialize());
  grouping.addNode({
    id: nodeId('constraint_categories'),
    kind: 'constraint',
    message: 'No category may exceed 100.',
    expression: {
      kind: 'every',
      source: map(
        group(ref(S_LINES), SC_GROUP, field(ref(SC_GROUP), F_CATEGORY)),
        SC_MEMBER,
        sum(map(groupItems(ref(SC_MEMBER)), SC_AMOUNT, field(ref(SC_AMOUNT), F_AMOUNT))),
      ),
      scopeId: nodeId('scope_subtotal'),
      predicate: binary('lte', ref(nodeId('scope_subtotal')), literal(100)),
    },
  });
  const server = compileToServerIR(grouping);
  assert.equal(server.contract, 'axiom.server.v2', 'a v1 runtime has never heard of group');
  assert.equal(server.expressionDefs, undefined, 'and it carries no definitions it does not use');
});
