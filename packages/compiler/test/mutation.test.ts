import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  optionalType,
  primitiveType,
  ref,
  stateLocation,
  synchronizeEdges,
} from '@axiom/core';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  FieldDisplayNode,
  InputNode,
  RouteDef,
  StateDef,
  ViewNode,
} from '@axiom/core';
import { compileToIR } from '@axiom/compiler';
import { createAxiomRuntime, createMemoryHost, findByNodeId } from '@axiom/runtime';
import type { MemoryElement, MemoryHostOptions } from '@axiom/runtime';

/**
 * The 0.3 mutation architecture, exercised end to end: a record is edited through an
 * addressed location while the derived value the UI reads is a copy.
 */
const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_record_id');
const F_LABEL = fieldId('field_record_label');
const F_PRICE = fieldId('field_record_price');

const STATE_RECORDS = nodeId('state_records');
const STATE_CURRENT = nodeId('state_current');
const STATE_DRAFT = nodeId('state_draft');

const ACTION_RENAME = nodeId('action_rename');
const PARAM_NAME = nodeId('param_name');
const ACTION_RAISE = nodeId('action_raise');
const ACTION_INSERT = nodeId('action_insert');
const ACTION_REMOVE = nodeId('action_remove');
const ACTION_BREAK = nodeId('action_break');
const ACTION_NATIVE = nodeId('action_native');

const ROUTE = nodeId('route_record');
const PARAM_ROUTE_ID = nodeId('param_route_id');
const VIEW = nodeId('ui_view');
const UI_LABEL_INPUT = nodeId('ui_label_input');
const UI_DRAFT_INPUT = nodeId('ui_draft_input');
const UI_LABEL_DISPLAY = nodeId('ui_label_display');
const SCOPE = nodeId('scope_lookup');
const CONSTRAINT_LABEL = nodeId('constraint_label');

/** The record named by the route, addressed where it is actually stored. */
const routedRecord = itemLocation(
  stateLocation(STATE_RECORDS),
  identitySelector(F_ID, ref(PARAM_ROUTE_ID)),
);

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('mutation-sample', 'Mutation Sample');

  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LABEL, name: 'Label', valueType: primitiveType('string'), required: true },
      { id: F_PRICE, name: 'Price', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_RECORDS,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [
      { [F_ID]: 'r1', [F_LABEL]: 'First', [F_PRICE]: 10 },
      { [F_ID]: 'r2', [F_LABEL]: 'Second', [F_PRICE]: 20 },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT,
    kind: 'state',
    name: 'draft',
    valueType: entityType(ENTITY),
    draft: true,
    initialValue: { [F_ID]: '', [F_LABEL]: '', [F_PRICE]: 0 },
  });

  graph.addNode<StateDef>({
    id: STATE_CURRENT,
    kind: 'state',
    name: 'current',
    valueType: optionalType(entityType(ENTITY)),
    derivation: {
      kind: 'find',
      source: ref(STATE_RECORDS),
      scopeId: SCOPE,
      predicate: binary('eq', field(ref(SCOPE), F_ID), ref(PARAM_ROUTE_ID)),
    },
  });

  graph.addNode<ActionDef>({
    id: ACTION_RENAME,
    kind: 'action',
    name: 'renameRecord',
    parameters: [{ id: PARAM_NAME, name: 'name', valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'set', target: fieldLocation(routedRecord, F_LABEL), value: ref(PARAM_NAME) },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_RAISE,
    kind: 'action',
    name: 'raisePrice',
    operations: [
      {
        kind: 'set',
        target: fieldLocation(routedRecord, F_PRICE),
        value: binary('add', field(ref(STATE_CURRENT), F_PRICE), literal(5)),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_INSERT,
    kind: 'action',
    name: 'insertRecord',
    operations: [
      {
        kind: 'insert',
        target: stateLocation(STATE_RECORDS),
        position: 'start',
        value: {
          kind: 'object',
          entityId: ENTITY,
          entries: [
            { fieldId: F_ID, value: call('uuid') },
            { fieldId: F_LABEL, value: field(ref(STATE_DRAFT), F_LABEL) },
            { fieldId: F_PRICE, value: literal(1) },
          ],
        },
      },
      { kind: 'set', target: stateLocation(STATE_DRAFT), value: literal({ [F_ID]: '', [F_LABEL]: '', [F_PRICE]: 0 }) },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_REMOVE,
    kind: 'action',
    name: 'removeRecord',
    operations: [{ kind: 'remove', target: routedRecord }],
  });

  // Two mutations where the second violates an invariant, to prove atomic rollback.
  graph.addNode<ActionDef>({
    id: ACTION_BREAK,
    kind: 'action',
    name: 'breakInvariant',
    operations: [
      { kind: 'set', target: fieldLocation(routedRecord, F_PRICE), value: literal(999) },
      { kind: 'set', target: fieldLocation(routedRecord, F_LABEL), value: literal('') },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_NATIVE,
    kind: 'action',
    name: 'stampLabel',
    operations: [
      {
        kind: 'native',
        implementationId: 'test.stamp',
        inputs: { current: field(ref(STATE_CURRENT), F_LABEL) },
        resultTarget: fieldLocation(routedRecord, F_LABEL),
      },
    ],
  });

  graph.addNode<InputNode>({
    id: UI_LABEL_INPUT,
    kind: 'input',
    label: 'Label',
    binding: { location: fieldLocation(routedRecord, F_LABEL) },
  });
  graph.addNode<InputNode>({
    id: UI_DRAFT_INPUT,
    kind: 'input',
    label: 'Draft label',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT), F_LABEL) },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_LABEL_DISPLAY,
    kind: 'field-display',
    source: ref(STATE_CURRENT),
    fieldId: F_LABEL,
  });
  graph.addNode<ViewNode>({
    id: VIEW,
    kind: 'view',
    children: [UI_LABEL_INPUT, UI_DRAFT_INPUT, UI_LABEL_DISPLAY],
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_LABEL,
    kind: 'constraint',
    name: 'Label present',
    entityId: ENTITY,
    message: 'Every record must keep a label.',
    expression: call('required', field(ref(ENTITY), F_LABEL)),
  });

  graph.addNode<RouteDef>({
    id: ROUTE,
    kind: 'route',
    path: '/records/:id',
    viewId: VIEW,
    parameters: [{ id: PARAM_ROUTE_ID, name: 'id', valueType: primitiveType('string') }],
  });

  synchronizeEdges(graph);
  return graph;
}

function createApp(options: MemoryHostOptions = {}) {
  const host = createMemoryHost({ path: '/records/r1', ...options });
  const app = createAxiomRuntime({
    ir: compileToIR(buildGraph()),
    rootElement: host.root,
    host,
    nativeOperations: {
      'test.stamp': (inputs) => `${String(inputs.current)} (stamped)`,
    },
  });
  app.start();
  return { app, host };
}

const records = (app: ReturnType<typeof createApp>['app']): Array<Record<string, unknown>> =>
  app.getState(STATE_RECORDS) as Array<Record<string, unknown>>;

function control(root: MemoryElement, id: string): MemoryElement {
  const found = findByNodeId(root, id).find((element) => element.tagName !== 'label');
  assert.ok(found, `no control rendered for ${id}`);
  return found;
}

test('an action sets a field of the record its location addresses', () => {
  const { app } = createApp();
  const result = app.invokeAction(ACTION_RENAME, { [PARAM_NAME]: 'Renamed' });

  assert.equal(result.ok, true);
  assert.equal(records(app)[0][F_LABEL], 'Renamed');
  assert.equal(records(app)[1][F_LABEL], 'Second', 'other records are untouched');
});

test('the derived value is a copy, and editing still reaches the stored record', () => {
  const { app } = createApp();

  const derived = app.getState(STATE_CURRENT) as Record<string, unknown>;
  const stored = records(app)[0];
  assert.deepEqual(derived[F_ID], stored[F_ID]);
  assert.notEqual(derived, stored, 'nothing may rely on the two sharing an object');

  app.invokeAction(ACTION_RENAME, { [PARAM_NAME]: 'Through the location' });

  assert.equal(records(app)[0][F_LABEL], 'Through the location');
  assert.equal(
    (app.getState(STATE_CURRENT) as Record<string, unknown>)[F_LABEL],
    'Through the location',
    'the derived value is recomputed from the state that was written',
  );
});

test('a value read out of the runtime cannot be used to change it', () => {
  const { app } = createApp();
  const copy = records(app);
  copy[0][F_LABEL] = 'Sneaky';

  assert.equal(records(app)[0][F_LABEL], 'First', 'the store is unaffected');
});

test('an action reads the derived value and writes through the location', () => {
  const { app } = createApp();
  assert.equal(app.invokeAction(ACTION_RAISE).ok, true);
  assert.equal(records(app)[0][F_PRICE], 15);
});

test('insert and remove address collections explicitly', () => {
  const inserted = createApp();
  // The invariant applies to inserted records too, so the draft has to be complete.
  assert.equal(inserted.app.invokeAction(ACTION_INSERT).ok, false, 'an empty label is refused');
  assert.equal(records(inserted.app).length, 2, 'the refused insert left nothing behind');

  const draftInput = control(inserted.host.root, UI_DRAFT_INPUT);
  draftInput.value = 'Third';
  draftInput.dispatch('input');

  assert.equal(inserted.app.invokeAction(ACTION_INSERT).ok, true);
  assert.equal(records(inserted.app).length, 3);
  assert.equal(records(inserted.app)[0][F_LABEL], 'Third', 'inserted at the requested position');
  assert.equal(
    (inserted.app.getState(STATE_DRAFT) as Record<string, unknown>)[F_LABEL],
    '',
    'the draft was reset by the same action',
  );

  const removed = createApp();
  assert.equal(removed.app.invokeAction(ACTION_REMOVE).ok, true);
  assert.deepEqual(
    records(removed.app).map((record) => record[F_ID]),
    ['r2'],
  );
});

test('every mutation of a failed action is rolled back together', () => {
  const { app } = createApp();
  const result = app.invokeAction(ACTION_BREAK);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'CONSTRAINT_VIOLATION'));
  assert.equal(records(app)[0][F_PRICE], 10, 'the first mutation was rolled back too');
  assert.equal(records(app)[0][F_LABEL], 'First');
});

test('an input writes to its location through the same engine as an action', () => {
  const { app, host } = createApp();
  const input = control(host.root, UI_LABEL_INPUT);
  input.value = 'Typed';
  input.dispatch('input');

  assert.equal(records(app)[0][F_LABEL], 'Typed');

  const entry = app.getMutationLog().at(-1);
  assert.equal(entry?.source, 'ui');
  assert.equal(entry?.sourceNodeId, UI_LABEL_INPUT);
  assert.equal(entry?.operation, 'set');
  assert.equal(entry?.description, `${STATE_RECORDS} → [r1] → ${F_LABEL}`);
  assert.equal(entry?.oldValue, 'First');
  assert.equal(entry?.newValue, 'Typed');
});

test('a draft input writes to the draft, never to the stored record', () => {
  const { app, host } = createApp();
  const input = control(host.root, UI_DRAFT_INPUT);
  input.value = 'Draft only';
  input.dispatch('input');

  assert.equal((app.getState(STATE_DRAFT) as Record<string, unknown>)[F_LABEL], 'Draft only');
  assert.equal(records(app)[0][F_LABEL], 'First');
});

test('mutations carry provenance and a transaction id', () => {
  const { app } = createApp();
  app.invokeAction(ACTION_RENAME, { [PARAM_NAME]: 'Logged' });

  const entry = app.getMutationLog().at(-1);
  assert.equal(entry?.source, 'action');
  assert.equal(entry?.sourceNodeId, ACTION_RENAME);
  assert.match(entry?.transactionId ?? '', /^tx_\d+$/);
  assert.deepEqual(entry?.path.segments, [
    { kind: 'collection-item', fieldId: F_ID, identity: 'r1' },
    { kind: 'field', fieldId: F_LABEL },
  ]);
});

test('a native operation cannot write state itself; its result is set through a location', () => {
  const { app } = createApp();
  assert.equal(app.invokeAction(ACTION_NATIVE).ok, true);

  assert.equal(records(app)[0][F_LABEL], 'First (stamped)');
  const entry = app.getMutationLog().at(-1);
  assert.equal(entry?.source, 'native');
});

test('the runtime refuses to write derived state even if asked directly', () => {
  const { app } = createApp();
  app.setState(STATE_CURRENT, { [F_ID]: 'r1', [F_LABEL]: 'nope' });

  assert.equal(records(app)[0][F_LABEL], 'First');
  assert.ok(
    app.diagnostics().some((diagnostic) => diagnostic.code === 'DERIVED_STATE_WRITE'),
    'the attempt is reported rather than silently ignored',
  );
});
