import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentAPI } from '@cynodia/axiom-agent-api';
import {
  ApplicationGraph,
  DEFAULT_THEME,
  VALIDATION_CODES,
  collectionType,
  entityType,
  fieldId,
  fieldLocation,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ButtonNode,
  ContainerNode,
  EntityDef,
  FormNode,
  InputNode,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';

/**
 * Presentation as something an agent can reason about, sections 46–49.
 *
 * The questions below are the ones that are impossible to answer from a stylesheet: which
 * control is the primary action, why these children are grouped, what happens on a narrow
 * display, where presentation contradicts the application's own semantics.
 */

const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_id');
const F_NAME = fieldId('field_name');
const F_NOTE = fieldId('field_note');
const STATE = nodeId('state_records');
const DRAFT = nodeId('state_draft');
const PANEL_OPEN = nodeId('state_panel_open');
const ACTION_SAVE = nodeId('action_save');
const ACTION_DROP = nodeId('action_drop');
const PARAM_DROP = nodeId('param_drop');

const VIEW = nodeId('ui_view');
const TITLE = nodeId('ui_title');
const FORM = nodeId('ui_form');
const SECTION_MAIN = nodeId('ui_section_main');
const SECTION_MAIN_HEADING = nodeId('ui_section_main_heading');
const NAME_INPUT = nodeId('ui_name');
const SECTION_MORE = nodeId('ui_section_more');
const SECTION_MORE_HEADING = nodeId('ui_section_more_heading');
const NOTE_INPUT = nodeId('ui_note');
const ACTIONS = nodeId('ui_actions');
const CANCEL = nodeId('ui_cancel');
const DROP = nodeId('ui_drop');
const LOOSE_INPUT = nodeId('ui_loose');
const ROUTE = nodeId('route_records');

/** The semantic form of §59: two sections and an action group. */
function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('presentation', 'Presentation');

  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_NOTE, name: 'Note', valueType: primitiveType('string') },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [{ [F_ID]: 'r1', [F_NAME]: 'First', [F_NOTE]: '' }],
  });
  graph.addNode<StateDef>({
    id: DRAFT,
    kind: 'state',
    name: 'draft',
    valueType: entityType(ENTITY),
    draft: true,
    initialValue: { [F_ID]: '', [F_NAME]: '', [F_NOTE]: '' },
  });
  // Section 76: which panel is open is not a domain fact, and says so.
  graph.addNode<StateDef>({
    id: PANEL_OPEN,
    kind: 'state',
    name: 'panelOpen',
    valueType: primitiveType('boolean'),
    ephemeral: true,
    initialValue: false,
  });
  graph.addNode<ActionDef>({
    id: ACTION_SAVE,
    kind: 'action',
    name: 'save',
    operations: [{ kind: 'insert', target: stateLocation(STATE), value: ref(DRAFT) }],
  });
  graph.addNode<ActionDef>({
    id: ACTION_DROP,
    kind: 'action',
    name: 'drop',
    destructive: true,
    parameters: [{ id: PARAM_DROP, name: 'id', valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'remove', target: itemLocation(stateLocation(STATE), identitySelector(F_ID, ref(PARAM_DROP))) },
    ],
  });

  graph.addNode<TextNode>({ id: TITLE, kind: 'text', value: 'Records', presentation: { textRole: 'title' } });
  graph.addNode<TextNode>({
    id: SECTION_MAIN_HEADING,
    kind: 'text',
    value: 'Identity',
    presentation: { textRole: 'heading' },
  });
  graph.addNode<InputNode>({
    id: NAME_INPUT,
    kind: 'input',
    label: 'Name',
    binding: { location: fieldLocation(stateLocation(DRAFT), F_NAME) },
  });
  graph.addNode<ContainerNode>({
    id: SECTION_MAIN,
    kind: 'container',
    name: 'IdentitySection',
    children: [SECTION_MAIN_HEADING, NAME_INPUT],
    presentation: { uxRole: 'form-section' },
  });

  graph.addNode<TextNode>({
    id: SECTION_MORE_HEADING,
    kind: 'text',
    value: 'Notes',
    presentation: { textRole: 'heading' },
  });
  graph.addNode<InputNode>({
    id: NOTE_INPUT,
    kind: 'input',
    label: 'Note',
    binding: { location: fieldLocation(stateLocation(DRAFT), F_NOTE) },
    presentation: { control: 'multiline' },
  });
  graph.addNode<ContainerNode>({
    id: SECTION_MORE,
    kind: 'container',
    name: 'NotesSection',
    children: [SECTION_MORE_HEADING, NOTE_INPUT],
    presentation: { uxRole: 'form-section' },
  });

  graph.addNode<ButtonNode>({
    id: CANCEL,
    kind: 'button',
    label: 'Cancel',
    actionId: ACTION_SAVE,
    presentation: { uxRole: 'secondary-action' },
  });
  graph.addNode<ButtonNode>({
    id: DROP,
    kind: 'button',
    label: 'Delete',
    actionId: ACTION_DROP,
    arguments: { [PARAM_DROP]: literal('r1') },
  });
  graph.addNode<ContainerNode>({
    id: ACTIONS,
    kind: 'container',
    name: 'FormActions',
    children: [CANCEL, DROP],
    presentation: { uxRole: 'action-group' },
  });
  graph.addNode<InputNode>({
    id: LOOSE_INPUT,
    kind: 'input',
    label: 'Reference',
    binding: { location: fieldLocation(stateLocation(DRAFT), F_ID) },
  });
  graph.addNode<FormNode>({
    id: FORM,
    kind: 'form',
    name: 'RecordForm',
    target: ref(DRAFT),
    children: [SECTION_MAIN, SECTION_MORE, LOOSE_INPUT, ACTIONS],
    submitActionId: ACTION_SAVE,
    submitLabel: 'Save',
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', name: 'Records', children: [TITLE, FORM] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

function api(): AgentAPI {
  return new AgentAPI(buildGraph());
}

// ------------------------------------------------------------------- queries

test('an agent reads both what a node declared and what was resolved', () => {
  const agent = api();

  assert.deepEqual(agent.getPresentation(TITLE), { textRole: 'title' });
  assert.equal(agent.getPresentation(DROP), undefined, 'the delete button declares nothing');

  const resolved = agent.resolvePresentation(DROP);
  assert.equal(resolved?.role, 'destructive', 'but it resolves to destructive anyway');
  assert.equal(resolved?.origins.role, 'inferred');
});

test('an agent asks why a group exists', () => {
  const agent = api();
  assert.equal(agent.getUxRole(SECTION_MAIN), 'form-section');
  assert.equal(agent.getUxRole(ACTIONS), 'action-group');
  assert.equal(agent.getUxRole(NAME_INPUT), undefined);
});

test('an agent asks what happens on a narrow display', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);
  assert.deepEqual(agent.getResponsiveBehavior(ACTIONS), {}, 'nothing is declared yet');

  const transaction = agent.beginTransaction();
  transaction.setResponsiveBehavior(ACTIONS, 'compact', { layout: 'vertical' });
  transaction.commit({ reason: 'Stack the actions on a phone' });

  const behaviour = new AgentAPI(graph).getResponsiveBehavior(ACTIONS);
  assert.equal(behaviour.compact?.layout?.kind, 'vertical');
});

/** Section 46. */
test('an agent finds the primary and destructive actions of a view', () => {
  const agent = api();

  assert.deepEqual(
    agent.getPrimaryActions(VIEW).map((action) => action.name),
    ['save'],
  );
  assert.deepEqual(
    agent.getDestructiveActions(VIEW).map((action) => action.name),
    ['drop'],
  );
});

/** Section 59. */
test('an agent reads a form as UX rather than as a list of children', () => {
  const structure = api().getFormStructure(FORM);

  assert.equal(structure.formId, FORM);
  assert.equal(structure.submitActionId, ACTION_SAVE);
  assert.equal(structure.density, 'comfortable');
  assert.deepEqual(
    structure.sections.map((section) => section.name),
    ['IdentitySection', 'NotesSection'],
  );
  assert.deepEqual(structure.sections[0].headings, ['Identity']);
  assert.deepEqual(structure.sections[0].inputIds, [NAME_INPUT]);
  assert.deepEqual(structure.ungroupedInputIds, [LOOSE_INPUT], 'a control in no section is visible as such');
  assert.deepEqual(structure.actionGroupIds, [ACTIONS]);
  assert.deepEqual(structure.primaryActionIds, [ACTION_SAVE]);
  assert.deepEqual(structure.destructiveActionIds, [ACTION_DROP]);
  assert.deepEqual(structure.requiredInputIds, [NAME_INPUT, LOOSE_INPUT], 'required comes from the model');
});

test('an agent finds nodes by UX role, presentation role and density', () => {
  const agent = api();

  assert.deepEqual(
    agent.findNodesByUxRole('form-section').map((node) => node.id),
    [SECTION_MAIN, SECTION_MORE],
  );
  assert.deepEqual(
    agent.findNodesByRole('destructive').map((node) => node.id),
    [DROP],
  );
  assert.equal(agent.findNodesByDensity('comfortable').length > 0, true);
  assert.deepEqual(agent.findNodesByDensity('spacious'), []);
});

/** Section 47. */
test('an agent asks which views use a role', () => {
  const agent = api();
  assert.deepEqual(
    agent.getViewsUsingRole('destructive').map((view) => view.name),
    ['Records'],
  );
  assert.deepEqual(agent.getViewsUsingRole('warning'), []);
});

test('an agent asks which forms lack a primary action', () => {
  const graph = buildGraph();
  assert.deepEqual(new AgentAPI(graph).getFormsWithoutPrimaryAction(), []);

  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  const { submitActionId, ...withoutSubmit } = form;
  void submitActionId;
  graph.updateNode(withoutSubmit as FormNode);

  assert.deepEqual(
    new AgentAPI(graph).getFormsWithoutPrimaryAction().map((f) => f.name),
    ['RecordForm'],
  );
});

test('an agent asks which views contain presentation warnings', () => {
  const graph = buildGraph();
  const button = graph.getNode<ButtonNode>(DROP);
  assert.ok(button);
  graph.updateNode({ ...button, presentation: { role: 'success' } });

  const agent = new AgentAPI(graph);
  const codes = agent.getPresentationWarnings().map((finding) => finding.code);
  assert.ok(codes.includes(VALIDATION_CODES.destructiveActionPresentedAsSuccess));

  const scoped = agent.getPresentationWarnings(VIEW).map((finding) => finding.code);
  assert.ok(scoped.includes(VALIDATION_CODES.destructiveActionPresentedAsSuccess));
});

/** Sections 50 and 51. */
test('an agent is told when a node carries presentation it cannot analyze', () => {
  const graph = buildGraph();
  assert.deepEqual(new AgentAPI(graph).getOpaquePresentationNodes(), []);

  const title = graph.getNode<TextNode>(TITLE);
  assert.ok(title);
  graph.updateNode({
    ...title,
    presentation: { ...title.presentation, rendererOverrides: { web: { className: 'legacy' } } },
  });

  const opaque = new AgentAPI(graph).getOpaquePresentationNodes();
  assert.deepEqual(
    opaque.map((node) => node.id),
    [TITLE],
  );
});

/** Section 76. */
test('an agent can tell presentation state from domain state', () => {
  assert.deepEqual(
    api()
      .getEphemeralStates()
      .map((state) => state.name),
    ['panelOpen'],
  );
});

test('an agent reads the theme without the graph declaring one', () => {
  const agent = api();
  assert.equal(agent.getTheme().id, DEFAULT_THEME.id);
  assert.equal(agent.getTheme().defaults.density, 'comfortable');
});

// ---------------------------------------------------------- transformations

/** Section 48: "make this form more compact" is one semantic change. */
test('an agent makes a form compact by changing its intent, not its styling', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const outcome = agent.transact(
    (transaction) => transaction.setDensity(FORM, 'compact'),
    { reason: 'Make this form more compact', actor: 'agent' },
  );

  assert.equal(outcome.committed, true);
  assert.deepEqual(graph.getNode<FormNode>(FORM)?.presentation, { density: 'compact' });

  const after = new AgentAPI(graph);
  assert.equal(after.resolvePresentation(FORM)?.density, 'compact');
  assert.equal(after.resolvePresentation(NAME_INPUT)?.density, 'compact', 'and it cascades');
  assert.equal(outcome.change?.operations.length, 1, 'one operation, not seventeen declarations');
});

test('merging presentation keeps what the node already said', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  agent.transact((transaction) => {
    transaction.mergePresentation(TITLE, { emphasis: 'strong' });
  });

  assert.deepEqual(graph.getNode<TextNode>(TITLE)?.presentation, {
    textRole: 'title',
    emphasis: 'strong',
  });
});

test('an agent sets a UX role and a value format semantically', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  agent.transact((transaction) => {
    transaction.setUxRole(CANCEL, 'navigation-action');
    transaction.setValueFormat(TITLE, { kind: 'text' });
  });

  assert.equal(new AgentAPI(graph).getUxRole(CANCEL), 'navigation-action');
  assert.deepEqual(graph.getNode<TextNode>(TITLE)?.presentation?.format, { kind: 'text' });
});

test('presentation can be removed as well as set', () => {
  const graph = buildGraph();
  new AgentAPI(graph).transact((transaction) => transaction.setPresentation(TITLE, undefined));
  assert.equal(graph.getNode<TextNode>(TITLE)?.presentation, undefined);
});

test('a transformation that would produce an unknown token is refused', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  const outcome = agent.transact((transaction) => {
    transaction.mergePresentation(FORM, { density: 'cosy' } as never);
  });

  assert.equal(outcome.committed, false);
  assert.ok(outcome.result.errors.some((e) => e.code === VALIDATION_CODES.unknownPresentationToken));
  assert.equal(graph.getNode<FormNode>(FORM)?.presentation, undefined, 'the graph is untouched');
});

/** Section 49: an application-wide change is a theme change. */
test('an agent restyles the whole application by changing the theme', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);
  const before = JSON.stringify(graph.listNodes());

  const outcome = agent.transact(
    (transaction) =>
      transaction.setTheme({
        appearance: 'dark',
        defaults: { density: 'compact' },
        spacing: { medium: 8 },
      }),
    { reason: 'Use a denser dark identity', actor: 'agent' },
  );

  assert.equal(outcome.committed, true);
  assert.equal(JSON.stringify(graph.listNodes()), before, 'not one node changed');
  assert.equal(graph.theme.appearance, 'dark');
  assert.equal(new AgentAPI(graph).resolvePresentation(FORM)?.density, 'compact');
  assert.deepEqual(outcome.change?.operations, [
    {
      kind: 'set-theme',
      after: { appearance: 'dark', defaults: { density: 'compact' }, spacing: { medium: 8 } },
    },
  ]);
});

test('a theme patch keeps the rest of what the application declared', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);

  agent.transact((transaction) => transaction.setTheme({ appearance: 'dark', spacing: { medium: 8 } }));
  agent.transact((transaction) => transaction.mergeTheme({ defaults: { density: 'spacious' } }));

  assert.deepEqual(graph.declaredTheme, {
    appearance: 'dark',
    spacing: { medium: 8 },
    defaults: { density: 'spacious' },
  });
  assert.equal(graph.theme.spacing.medium, 8);
  assert.equal(graph.theme.spacing.large, DEFAULT_THEME.spacing.large, 'the rest is still the default');
});

test('a rolled-back theme change leaves the application alone', () => {
  const graph = buildGraph();
  const agent = new AgentAPI(graph);
  const transaction = agent.beginTransaction();
  transaction.setTheme({ appearance: 'dark' });

  assert.equal(transaction.staged.theme.appearance, 'dark', 'the staged graph shows it');
  transaction.rollback();
  assert.equal(graph.declaredTheme, undefined);
});

test('a presentation change is refused on something that is not a UI node', () => {
  const agent = api();
  const transaction = agent.beginTransaction();
  assert.throws(() => transaction.setDensity(ACTION_SAVE, 'compact'), /not a UI node/);
});
