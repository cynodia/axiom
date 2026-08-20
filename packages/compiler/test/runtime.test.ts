import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  enumType,
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
  unary,
} from '@axiom/core';
import type {
  ActionDef,
  ButtonNode,
  ConditionalNode,
  ConstraintDef,
  ContainerNode,
  EntityDef,
  Expression,
  FieldDisplayNode,
  FormNode,
  InputNode,
  RepeatNode,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@axiom/core';
import { compileToHtml, compileToIR } from '@axiom/compiler';
import {
  createAxiomRuntime,
  createMemoryHost,
  findAll,
  findByNodeId,
  findByTag,
  textOf,
} from '@axiom/runtime';
import type { MemoryElement, MemoryHostOptions } from '@axiom/runtime';

/**
 * A synthetic application that exercises the whole vocabulary. The runtime under test
 * has no knowledge of it beyond the semantics in the graph.
 */
const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_record_id');
const F_LABEL = fieldId('field_record_label');
const F_SIZE = fieldId('field_record_size');
const F_STAGE = fieldId('field_record_stage');
const F_ACTIVE = fieldId('field_record_active');

const STATE_RECORDS = nodeId('state_records');
const STATE_DRAFT = nodeId('state_draft');
const STATE_CURRENT = nodeId('state_current');
const STATE_TOTAL = nodeId('state_total');

const ACTION_ADD = nodeId('action_add');
const ACTION_REMOVE = nodeId('action_remove');
const PARAM_REMOVE = nodeId('param_remove');
const ACTION_GROW = nodeId('action_grow');
const ACTION_OPEN = nodeId('action_open');
const PARAM_OPEN = nodeId('param_open');
const ACTION_NATIVE = nodeId('action_native');

const ROUTE_ROOT = nodeId('route_root');
const ROUTE_DETAIL = nodeId('route_detail');
const PARAM_ROUTE_ID = nodeId('param_route_id');

const UI_ROOT = nodeId('ui_root');
const UI_HEADING = nodeId('ui_heading');
const UI_COUNT = nodeId('ui_count');
const UI_REPEAT = nodeId('ui_repeat');
const UI_ROW = nodeId('ui_row');
const UI_ROW_LABEL = nodeId('ui_row_label');
const UI_ROW_OPEN = nodeId('ui_row_open');
const UI_EMPTY = nodeId('ui_empty');
const UI_FORM = nodeId('ui_form');
const UI_INPUT_LABEL = nodeId('ui_input_label');
const UI_INPUT_SIZE = nodeId('ui_input_size');
const UI_INPUT_STAGE = nodeId('ui_input_stage');
const UI_INPUT_ACTIVE = nodeId('ui_input_active');
const UI_DETAIL = nodeId('ui_detail');
const UI_DETAIL_CONDITIONAL = nodeId('ui_detail_conditional');
const UI_DETAIL_LABEL = nodeId('ui_detail_label');
const UI_DETAIL_MISSING = nodeId('ui_detail_missing');
const UI_GROW = nodeId('ui_grow');

const SCOPE_LOOKUP = nodeId('scope_lookup');

const CONSTRAINT_LABEL = nodeId('constraint_label');

const emptyDraft = {
  [F_ID]: '',
  [F_LABEL]: '',
  [F_SIZE]: 0,
  [F_STAGE]: 'draft',
  [F_ACTIVE]: false,
};

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('runtime-sample', 'Runtime Sample');

  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LABEL, name: 'Label', valueType: primitiveType('string'), required: true },
      { id: F_SIZE, name: 'Size', valueType: primitiveType('number'), required: true },
      { id: F_STAGE, name: 'Stage', valueType: enumType(['draft', 'ready']), required: true },
      { id: F_ACTIVE, name: 'Active', valueType: optionalType(primitiveType('boolean')) },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_RECORDS,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [
      { [F_ID]: 'r1', [F_LABEL]: 'First', [F_SIZE]: 2, [F_STAGE]: 'ready', [F_ACTIVE]: true },
      { [F_ID]: 'r2', [F_LABEL]: 'Second', [F_SIZE]: 5, [F_STAGE]: 'draft', [F_ACTIVE]: false },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT,
    kind: 'state',
    name: 'draft',
    valueType: entityType(ENTITY),
    draft: true,
    initialValue: { ...emptyDraft },
  });

  graph.addNode<StateDef>({
    id: STATE_CURRENT,
    kind: 'state',
    name: 'current',
    valueType: optionalType(entityType(ENTITY)),
    derivation: {
      kind: 'find',
      source: ref(STATE_RECORDS),
      scopeId: SCOPE_LOOKUP,
      predicate: binary('eq', field(ref(SCOPE_LOOKUP), F_ID), ref(PARAM_ROUTE_ID)),
    },
  });

  graph.addNode<StateDef>({
    id: STATE_TOTAL,
    kind: 'state',
    name: 'total',
    valueType: primitiveType('number'),
    derivation: call('count', ref(STATE_RECORDS)),
  });

  graph.addNode<ActionDef>({
    id: ACTION_ADD,
    kind: 'action',
    name: 'addRecord',
    preconditions: [call('required', field(ref(STATE_DRAFT), F_LABEL))],
    failureModes: [{ code: 'label-missing', message: 'A record needs a label.' }],
    operations: [
      {
        kind: 'insert',
        target: stateLocation(STATE_RECORDS),
        value: {
          kind: 'object',
          entityId: ENTITY,
          entries: [
            { fieldId: F_ID, value: call('uuid') },
            { fieldId: F_LABEL, value: field(ref(STATE_DRAFT), F_LABEL) },
            { fieldId: F_SIZE, value: field(ref(STATE_DRAFT), F_SIZE) },
            { fieldId: F_STAGE, value: field(ref(STATE_DRAFT), F_STAGE) },
            { fieldId: F_ACTIVE, value: field(ref(STATE_DRAFT), F_ACTIVE) },
          ],
        },
      },
      { kind: 'set', target: stateLocation(STATE_DRAFT), value: literal({ ...emptyDraft }) },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_REMOVE,
    kind: 'action',
    name: 'removeRecord',
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: 'Remove this record?',
    parameters: [{ id: PARAM_REMOVE, name: 'recordId', valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'remove',
        target: itemLocation(stateLocation(STATE_RECORDS), identitySelector(F_ID, ref(PARAM_REMOVE))),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_GROW,
    kind: 'action',
    name: 'growCurrent',
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_RECORDS), identitySelector(F_ID, ref(PARAM_ROUTE_ID))),
          F_SIZE,
        ),
        value: binary('add', field(ref(STATE_CURRENT), F_SIZE), literal(3)),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_OPEN,
    kind: 'action',
    name: 'openRecord',
    parameters: [{ id: PARAM_OPEN, name: 'id', valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'navigate', routeId: ROUTE_DETAIL, parameters: { [PARAM_ROUTE_ID]: ref(PARAM_OPEN) } },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_NATIVE,
    kind: 'action',
    name: 'exportRecords',
    operations: [
      {
        kind: 'native',
        implementationId: 'test.capture',
        inputs: { count: call('count', ref(STATE_RECORDS)) },
        declaredEffects: [{ kind: 'reads-state', stateId: STATE_RECORDS }],
      },
    ],
  });

  graph.addNode<TextNode>({ id: UI_HEADING, kind: 'text', value: 'Records' });
  graph.addNode<TextNode>({ id: UI_COUNT, kind: 'text', value: call('to-string', ref(STATE_TOTAL)) });
  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_LABEL,
    kind: 'field-display',
    source: ref(UI_REPEAT),
    fieldId: F_LABEL,
  });
  graph.addNode<ButtonNode>({
    id: UI_ROW_OPEN,
    kind: 'button',
    label: 'Open',
    actionId: ACTION_OPEN,
    arguments: { [PARAM_OPEN]: field(ref(UI_REPEAT), F_ID) },
  });
  graph.addNode<ContainerNode>({
    id: UI_ROW,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_ROW_LABEL, UI_ROW_OPEN],
  });
  graph.addNode<TextNode>({ id: UI_EMPTY, kind: 'text', value: 'Nothing here' });
  graph.addNode<RepeatNode>({
    id: UI_REPEAT,
    kind: 'repeat',
    templateId: UI_ROW,
    emptyTemplateId: UI_EMPTY,
    source: {
      kind: 'filter',
      source: ref(STATE_RECORDS),
      scopeId: nodeId('scope_visible'),
      predicate: unary('not', binary('eq', field(ref(nodeId('scope_visible')), F_STAGE), literal('hidden'))),
    },
  });

  graph.addNode<InputNode>({
    id: UI_INPUT_LABEL,
    kind: 'input',
    label: 'Label',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT), F_LABEL) },
  });
  graph.addNode<InputNode>({
    id: UI_INPUT_SIZE,
    kind: 'input',
    label: 'Size',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT), F_SIZE) },
  });
  graph.addNode<InputNode>({
    id: UI_INPUT_STAGE,
    kind: 'input',
    label: 'Stage',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT), F_STAGE) },
  });
  graph.addNode<InputNode>({
    id: UI_INPUT_ACTIVE,
    kind: 'input',
    label: 'Active',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT), F_ACTIVE) },
  });
  graph.addNode<FormNode>({
    id: UI_FORM,
    kind: 'form',
    target: ref(STATE_DRAFT),
    children: [UI_INPUT_LABEL, UI_INPUT_SIZE, UI_INPUT_STAGE, UI_INPUT_ACTIVE],
    submitActionId: ACTION_ADD,
    submitLabel: 'Add',
  });

  graph.addNode<ViewNode>({
    id: UI_ROOT,
    kind: 'view',
    children: [UI_HEADING, UI_COUNT, UI_REPEAT, UI_FORM],
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_DETAIL_LABEL,
    kind: 'field-display',
    source: ref(STATE_CURRENT),
    fieldId: F_LABEL,
  });
  graph.addNode<ButtonNode>({ id: UI_GROW, kind: 'button', label: 'Grow', actionId: ACTION_GROW });
  graph.addNode<TextNode>({ id: UI_DETAIL_MISSING, kind: 'text', value: 'Not found' });
  graph.addNode<ConditionalNode>({
    id: UI_DETAIL_CONDITIONAL,
    kind: 'conditional',
    condition: call('required', ref(STATE_CURRENT)),
    whenTrue: [UI_DETAIL_LABEL, UI_GROW],
    whenFalse: [UI_DETAIL_MISSING],
  });
  graph.addNode<ViewNode>({ id: UI_DETAIL, kind: 'view', children: [UI_DETAIL_CONDITIONAL] });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_LABEL,
    kind: 'constraint',
    name: 'Label present',
    entityId: ENTITY,
    message: 'Every record must keep a label.',
    expression: call('required', field(ref(ENTITY), F_LABEL)),
  });

  graph.addNode<RouteDef>({ id: ROUTE_ROOT, kind: 'route', path: '/', viewId: UI_ROOT });
  graph.addNode<RouteDef>({
    id: ROUTE_DETAIL,
    kind: 'route',
    path: '/records/:id',
    viewId: UI_DETAIL,
    parameters: [{ id: PARAM_ROUTE_ID, name: 'id' }],
  });

  synchronizeEdges(graph);
  return graph;
}

function createApp(options: MemoryHostOptions = {}) {
  const ir = compileToIR(buildGraph());
  const host = createMemoryHost({ path: '/', ...options });
  const app = createAxiomRuntime({
    ir,
    rootElement: host.root,
    host,
    nativeOperations: {
      'test.capture': (inputs) => {
        host.reports.push(`captured ${String(inputs.count)}`);
      },
    },
  });
  app.start();
  return { app, host };
}

/** Inputs render a label wrapper around the control; the control carries the value. */
function control(root: MemoryElement, id: string): MemoryElement {
  const found = findByNodeId(root, id).find((element) => element.tagName !== 'label');
  assert.ok(found, `no control rendered for ${id}`);
  return found;
}

test('a view renders its semantic children', () => {
  const { host } = createApp();
  assert.match(textOf(host.root), /Records/);
  assert.match(textOf(host.root), /First/);
  assert.match(textOf(host.root), /Second/);
});

test('derived state is recomputed rather than stored', () => {
  const { app, host } = createApp();
  assert.equal(app.getState(STATE_TOTAL), 2);
  assert.match(textOf(host.root), /\b2\b/);

  app.setState(STATE_RECORDS, []);
  assert.equal(app.getState(STATE_TOTAL), 0);
  assert.match(textOf(host.root), /Nothing here/);
});

test('repeat falls back to its empty template', () => {
  const { app, host } = createApp();
  app.setState(STATE_RECORDS, []);
  assert.match(textOf(host.root), /Nothing here/);
  assert.equal(findByNodeId(host.root, UI_ROW).length, 0);
});

test('controls are inferred from the field type', () => {
  const { host } = createApp();
  assert.equal(control(host.root, UI_INPUT_LABEL).getAttribute('type'), 'text');
  assert.equal(control(host.root, UI_INPUT_SIZE).getAttribute('type'), 'number');
  assert.equal(control(host.root, UI_INPUT_ACTIVE).getAttribute('type'), 'checkbox');

  const stage = control(host.root, UI_INPUT_STAGE);
  assert.equal(stage.tagName, 'select');
  assert.deepEqual(
    stage.children.map((option) => option.textContent),
    ['draft', 'ready'],
  );
});

test('typing into an input writes through to state, coerced to the field type', () => {
  const { app, host } = createApp();
  const label = control(host.root, UI_INPUT_LABEL);
  label.value = 'Third';
  label.dispatch('input');

  const size = control(host.root, UI_INPUT_SIZE);
  size.value = '7';
  size.dispatch('input');

  const draft = app.getState(STATE_DRAFT) as Record<string, unknown>;
  assert.equal(draft[F_LABEL], 'Third');
  assert.equal(draft[F_SIZE], 7, 'a numeric field stores a number, not a string');
});

test('a form submit runs its action and resets the draft', () => {
  const { app, host } = createApp();
  const label = control(host.root, UI_INPUT_LABEL);
  label.value = 'Third';
  label.dispatch('input');

  findByNodeId(host.root, UI_FORM)[0].dispatch('submit');

  const records = app.getState(STATE_RECORDS) as Array<Record<string, unknown>>;
  assert.equal(records.length, 3);
  assert.equal(records[2][F_LABEL], 'Third');
  assert.equal((app.getState(STATE_DRAFT) as Record<string, unknown>)[F_LABEL], '');
});

test('an unsatisfied precondition stops the action and reports its failure mode', () => {
  const { app } = createApp();
  const result = app.invokeAction(ACTION_ADD);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, 'PRECONDITION_FAILED');
  assert.match(result.diagnostics[0]?.message ?? '', /needs a label/);
  assert.equal((app.getState(STATE_RECORDS) as unknown[]).length, 2);
});

test('a button passes arguments and navigates through a route', () => {
  const { app, host } = createApp();
  const open = findByNodeId(host.root, UI_ROW_OPEN)[0];
  open.dispatch('click');

  assert.equal(host.path, '/records/r1');
  assert.equal(app.currentRoute()?.route.path, '/records/:id');
  assert.match(textOf(host.root), /First/);
});

test('a route parameter feeds derived state, and a missing record renders the other branch', () => {
  const { host } = createApp({ path: '/records/r2' });
  assert.match(textOf(host.root), /Second/);

  const { host: missing } = createApp({ path: '/records/absent' });
  assert.match(textOf(missing.root), /Not found/);
});

test('a set writes into the record its location addresses', () => {
  const { app, host } = createApp({ path: '/records/r1' });
  findByNodeId(host.root, UI_GROW)[0].dispatch('click');

  const records = app.getState(STATE_RECORDS) as Array<Record<string, unknown>>;
  assert.equal(records[0][F_SIZE], 5, 'the stored record, not a copy, was updated');
});

test('a destructive action asks for confirmation and honours the answer', () => {
  const declined = createApp({ confirm: false });
  declined.app.invokeAction(ACTION_REMOVE, { [PARAM_REMOVE]: 'r1' });
  assert.equal((declined.app.getState(STATE_RECORDS) as unknown[]).length, 2);
  assert.deepEqual(declined.host.confirmations, ['Remove this record?']);

  const accepted = createApp({ confirm: true });
  accepted.app.invokeAction(ACTION_REMOVE, { [PARAM_REMOVE]: 'r1' });
  assert.equal((accepted.app.getState(STATE_RECORDS) as unknown[]).length, 1);
});

test('an item is removed by the identity its location selects', () => {
  const { app } = createApp({ confirm: true });
  app.invokeAction(ACTION_REMOVE, { [PARAM_REMOVE]: 'r2' });
  const remaining = app.getState(STATE_RECORDS) as Array<Record<string, unknown>>;
  assert.deepEqual(
    remaining.map((item) => item[F_ID]),
    ['r1'],
  );
});

test('a constraint violation rolls the whole action back', () => {
  const { app, host } = createApp();
  const label = control(host.root, UI_INPUT_LABEL);
  label.value = 'Fine';
  label.dispatch('input');

  // Break an existing record so the invariant fails after the action's operations run.
  const records = app.getState(STATE_RECORDS) as Array<Record<string, unknown>>;
  records[0][F_LABEL] = '';
  app.setState(STATE_RECORDS, records);

  const result = app.invokeAction(ACTION_ADD);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'CONSTRAINT_VIOLATION'));
  assert.equal(
    (app.getState(STATE_RECORDS) as unknown[]).length,
    2,
    'the added record was rolled back with the failed action',
  );
});

test('a native operation runs only through its registered implementation', () => {
  const { app, host } = createApp();
  const result = app.invokeAction(ACTION_NATIVE);
  assert.equal(result.ok, true);
  assert.ok(host.reports.includes('captured 2'));
});

test('an unresolvable path renders a route diagnostic instead of guessing', () => {
  const { host } = createApp({ path: '/nowhere' });
  assert.equal(findAll(host.root, (element) => element.getAttribute('class') === 'axiom-no-route').length, 1);
});

test('state marked for local storage is persisted and restored', () => {
  const ir = compileToIR(buildGraph());
  const persistent = structuredClone(ir);
  const records = persistent.states.find((state) => state.id === STATE_RECORDS);
  assert.ok(records);
  records.persistence = { kind: 'local-storage', key: 'records' };
  persistent.nodes[STATE_RECORDS] = records;

  const host = createMemoryHost({ storage: true });
  const first = createAxiomRuntime({ ir: persistent, rootElement: host.root, host });
  first.start();
  first.setState(STATE_RECORDS, [{ [F_ID]: 'r9', [F_LABEL]: 'Kept', [F_SIZE]: 1, [F_STAGE]: 'ready' }]);

  const second = createAxiomRuntime({
    ir: persistent,
    rootElement: createMemoryHost().root,
    host,
  });
  const restored = second.getState(STATE_RECORDS) as Array<Record<string, unknown>>;
  assert.deepEqual(
    restored.map((item) => item[F_LABEL]),
    ['Kept'],
  );
});

test('the runtime renders only generic element types', () => {
  const { host } = createApp();
  const tags = new Set(findAll(host.root, () => true).map((element) => element.tagName));
  for (const tag of tags) {
    assert.ok(
      ['div', 'span', 'form', 'label', 'input', 'select', 'option', 'textarea', 'button'].includes(tag),
      `unexpected element <${tag}>`,
    );
  }
  assert.ok(findByTag(host.root, 'button').length > 0);
});

test('the generated page boots against browser-shaped globals', () => {
  const html = compileToHtml(buildGraph());
  const source = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(source, 'the page carries an inline module');

  const host = createMemoryHost({ path: '/' });
  const app = host.document.createElement('div') as MemoryElement;
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: globals.document,
    history: globals.history,
    location: globals.location,
    addEventListener: globals.addEventListener,
  };

  globals.document = {
    createElement: (tagName: string) => host.document.createElement(tagName),
    getElementById: (id: string) => (id === 'app' ? app : null),
  };
  globals.history = { pushState: () => undefined };
  globals.location = { pathname: '/' };
  globals.addEventListener = () => undefined;

  try {
    // The inlined runtime resolves no modules, so it runs as an ordinary script body.
    new Function(source)();
  } finally {
    globals.document = saved.document;
    globals.history = saved.history;
    globals.location = saved.location;
    globals.addEventListener = saved.addEventListener;
  }

  assert.match(textOf(app), /Records/);
  assert.match(textOf(app), /First/);
  assert.ok(globals.__AXIOM_APP__, 'the page exposes its runtime for inspection');
  delete globals.__AXIOM_APP__;
});
