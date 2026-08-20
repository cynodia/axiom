import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
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
  ButtonNode,
  EntityDef,
  FormNode,
  InputNode,
  RouteDef,
  StateDef,
  ViewNode,
} from '@axiom/core';
import { AgentAPI, TransactionError } from '@axiom/agent-api';

const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_record_id');
const F_LABEL = fieldId('field_record_label');
const STATE = nodeId('state_records');
const STATE_DRAFT = nodeId('state_draft');
const ACTION_ADD = nodeId('action_add');
const ACTION_REMOVE = nodeId('action_remove');
const PARAM_REMOVE = nodeId('param_remove');
const VIEW = nodeId('ui_view');
const FORM = nodeId('ui_form');
const INPUT_LABEL = nodeId('ui_input_label');
const BUTTON_REMOVE = nodeId('ui_button_remove');

function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('agent-sample', 'Agent Sample');

  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LABEL, name: 'Label', valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<StateDef>({
    id: STATE_DRAFT,
    kind: 'state',
    name: 'draft',
    valueType: entityType(ENTITY),
    draft: true,
    initialValue: { [F_ID]: '', [F_LABEL]: '' },
  });
  graph.addNode<ActionDef>({
    id: ACTION_ADD,
    kind: 'action',
    name: 'addRecord',
    operations: [
      {
        kind: 'insert',
        target: stateLocation(STATE),
        value: {
          kind: 'object',
          entityId: ENTITY,
          entries: [
            { fieldId: F_ID, value: call('uuid') },
            { fieldId: F_LABEL, value: field(ref(STATE_DRAFT), F_LABEL) },
          ],
        },
      },
    ],
  });
  graph.addNode<ActionDef>({
    id: ACTION_REMOVE,
    kind: 'action',
    name: 'removeRecord',
    parameters: [{ id: PARAM_REMOVE, name: 'recordId', valueType: primitiveType('string') }],
    operations: [
      {
        kind: 'remove',
        target: itemLocation(stateLocation(STATE), identitySelector(F_ID, ref(PARAM_REMOVE))),
      },
    ],
  });
  graph.addNode<InputNode>({
    id: INPUT_LABEL,
    kind: 'input',
    label: 'Label',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT), F_LABEL) },
  });
  graph.addNode<FormNode>({
    id: FORM,
    kind: 'form',
    target: ref(STATE_DRAFT),
    children: [INPUT_LABEL],
    submitActionId: ACTION_ADD,
  });
  graph.addNode<ButtonNode>({
    id: BUTTON_REMOVE,
    kind: 'button',
    label: 'Remove',
    actionId: ACTION_REMOVE,
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [FORM, BUTTON_REMOVE] });
  graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });

  synchronizeEdges(graph);
  return graph;
}

test('an agent can traverse dependencies in both directions', () => {
  const agent = new AgentAPI(buildGraph());

  assert.deepEqual(
    agent.getWriters(STATE).map((action) => action.id),
    [ACTION_ADD, ACTION_REMOVE],
  );
  assert.ok(agent.getReaders(STATE_DRAFT).some((node) => node.id === INPUT_LABEL));
  assert.ok(agent.getDependencies(BUTTON_REMOVE).some((node) => node.id === ACTION_REMOVE));
  assert.ok(agent.getDependents(ACTION_REMOVE).some((node) => node.id === BUTTON_REMOVE));
});

test('an agent can find the semantics attached to an entity', () => {
  const agent = new AgentAPI(buildGraph());

  assert.deepEqual(
    agent.getStatesForEntity(ENTITY).map((state) => state.id),
    [STATE, STATE_DRAFT],
  );
  assert.deepEqual(
    agent.getActionsForEntity(ENTITY).map((action) => action.id),
    [ACTION_ADD, ACTION_REMOVE],
  );
  assert.deepEqual(
    agent.getViewsForEntity(ENTITY).map((view) => view.id),
    [VIEW],
  );
  assert.deepEqual(
    agent.getFormsForEntity(ENTITY).map((form) => form.id),
    [FORM],
  );
  assert.equal(agent.getField(F_LABEL)?.entityId, ENTITY);
});

test('destructive actions are found without searching for words like "delete"', () => {
  const agent = new AgentAPI(buildGraph());
  assert.deepEqual(
    agent.findDestructiveActions().map((action) => action.id),
    [ACTION_REMOVE],
    'inferred from the remove-item operation, not from the name',
  );
});

test('a subgraph query returns only the requested neighbourhood', () => {
  const agent = new AgentAPI(buildGraph());

  const shallow = agent.getSubgraph({ root: STATE, depth: 1 });
  assert.ok(shallow.nodes.some((node) => node.id === ACTION_ADD));
  assert.ok(!shallow.nodes.some((node) => node.id === BUTTON_REMOVE), 'two hops away');

  const deeper = agent.getSubgraph({ root: STATE, depth: 2 });
  assert.ok(deeper.nodes.some((node) => node.id === BUTTON_REMOVE));

  const writesOnly = agent.getSubgraph({ root: STATE, depth: 1, edgeKinds: ['writes'] });
  assert.deepEqual(
    writesOnly.nodes.map((node) => node.id).sort(),
    [ACTION_ADD, ACTION_REMOVE, STATE].sort(),
  );
});

test('a transaction is invisible outside itself until it commits', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const transaction = agent.beginTransaction();
  transaction.addField(ENTITY, { name: 'Note', valueType: optionalType(primitiveType('string')) });
  assert.equal(graph.getNode<EntityDef>(ENTITY)?.fields.length, 2, 'the shared graph is untouched');
  assert.equal(transaction.staged.getNode<EntityDef>(ENTITY)?.fields.length, 3);

  const change = transaction.commit({ reason: 'Track a note', actor: 'test', timestamp: 1 });
  assert.equal(graph.getNode<EntityDef>(ENTITY)?.fields.length, 3);
  assert.equal(change.reason, 'Track a note');
  assert.ok(change.operations.some((operation) => operation.kind === 'add-field'));
  assert.deepEqual(agent.history().map((entry) => entry.reason), ['Track a note']);
});

test('a rolled back transaction leaves nothing behind', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const transaction = agent.beginTransaction();
  transaction.addField(ENTITY, { name: 'Temporary', valueType: primitiveType('string') });
  transaction.rollback();

  assert.equal(graph.getNode<EntityDef>(ENTITY)?.fields.length, 2);
  assert.deepEqual(agent.history(), []);
  assert.throws(() => transaction.commit(), TransactionError);
});

test('a transaction that would break the graph cannot be committed', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const outcome = agent.transact((transaction) => {
    transaction.removeField(F_LABEL);
  });

  assert.equal(outcome.committed, false);
  assert.ok(outcome.result.errors.some((problem) => problem.code === 'DANGLING_FIELD_REF'));
  assert.equal(graph.getNode<EntityDef>(ENTITY)?.fields.length, 2, 'the field is still there');
});

test('committing maintains the derived edges for new nodes', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const outcome = agent.transact((transaction) => {
    const noteId = transaction.addField(ENTITY, {
      name: 'Note',
      valueType: optionalType(primitiveType('string')),
    });
    transaction.bindField({
      parentId: FORM,
      location: fieldLocation(stateLocation(STATE_DRAFT), noteId),
      label: 'Note',
    });
  }, { reason: 'Make notes editable' });

  assert.equal(outcome.committed, true);
  const form = graph.getNode<FormNode>(FORM);
  assert.equal(form?.children.length, 2);

  const inputId = form?.children[1];
  assert.ok(inputId);
  const binds = graph.getOutgoingEdges(inputId, { kinds: ['binds'] });
  assert.deepEqual(
    binds.map((edge) => edge.to),
    [STATE_DRAFT],
    'the binding edge was derived, not hand written',
  );
  assert.ok(graph.getIncomingEdges(inputId, { kinds: ['contains'] }).some((edge) => edge.from === FORM));
});

test('an agent can add a whole feature — entity, state, action and UI — in one transaction', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const outcome = agent.transact((transaction) => {
    const tagId = transaction.addEntity({ name: 'Tag' });
    const tagFieldId = transaction.addField(tagId, {
      name: 'Name',
      valueType: primitiveType('string'),
      required: true,
    });
    const identity = transaction.addField(tagId, { name: 'Id', valueType: primitiveType('string') });
    const tag = transaction.staged.getNode<EntityDef>(tagId);
    if (tag) {
      tag.identityFieldId = identity;
      transaction.updateNode(tag);
    }
    const tagsState = transaction.addState({
      name: 'tags',
      valueType: collectionType(entityType(tagId)),
      initialValue: [],
    });
    const clearAction = transaction.addAction({
      name: 'clearTags',
      operations: [{ kind: 'set', target: stateLocation(tagsState), value: literal([]) }],
    });
    const buttonId = transaction.addButton({ label: 'Clear tags', actionId: clearAction });
    transaction.appendChild(VIEW, buttonId);
    transaction.addConstraint({
      name: 'Tag name present',
      entityId: tagId,
      expression: call('required', field(ref(tagId), tagFieldId)),
    });
  }, { reason: 'Add tagging' });

  assert.equal(outcome.committed, true);
  assert.equal(graph.getNodesByKind('entity').length, 2);
  assert.equal(graph.getNodesByKind('constraint').length, 1);
  assert.equal(graph.getNode<ViewNode>(VIEW)?.children.length, 3);
  assert.equal(agent.validate().valid, true);
});
