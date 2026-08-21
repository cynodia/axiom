import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
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
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ButtonNode,
  ContainerNode,
  EntityDef,
  FormNode,
  InputNode,
  Presentation,
  RouteDef,
  StateDef,
  TextNode,
  ThemeInput,
  ViewNode,
} from '@cynodia/axiom-core';

/**
 * Presentation validation, sections 36–38, 61 and 73.
 *
 * A UX judgement is advice: it is reported as a warning and never stops an application
 * from compiling. A token outside the vocabulary is different — a renderer cannot act on
 * it, so ignoring it would be a silent semantic failure.
 */

const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_id');
const F_NAME = fieldId('field_name');
const STATE = nodeId('state_records');
const DRAFT = nodeId('state_draft');
const ACTION_SAVE = nodeId('action_save');
const ACTION_DROP = nodeId('action_drop');
const PARAM_DROP = nodeId('param_drop');

const VIEW = nodeId('ui_view');
const FORM = nodeId('ui_form');
const INPUT = nodeId('ui_input');
const DROP = nodeId('ui_drop');
const ROUTE = nodeId('route_records');

/** A valid graph that reports no presentation findings at all. */
function baseGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('presentation', 'Presentation');

  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [{ [F_ID]: 'r1', [F_NAME]: 'First' }],
  });
  graph.addNode<StateDef>({
    id: DRAFT,
    kind: 'state',
    name: 'draft',
    valueType: entityType(ENTITY),
    draft: true,
    initialValue: { [F_ID]: '', [F_NAME]: '' },
  });
  graph.addNode<ActionDef>({
    id: ACTION_SAVE,
    kind: 'action',
    name: 'save',
    operations: [{ kind: 'set', target: fieldLocation(stateLocation(DRAFT), F_NAME), value: literal('') }],
  });
  graph.addNode<ActionDef>({
    id: ACTION_DROP,
    kind: 'action',
    name: 'drop',
    // Declared, so the graph is not merely inferred to be dangerous.
    destructive: true,
    parameters: [{ id: PARAM_DROP, name: 'id', valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'remove',
        target: itemLocation(stateLocation(STATE), identitySelector(F_ID, ref(PARAM_DROP))),
      },
    ],
  });
  graph.addNode<InputNode>({
    id: INPUT,
    kind: 'input',
    label: 'Name',
    binding: { location: fieldLocation(stateLocation(DRAFT), F_NAME) },
  });
  graph.addNode<ButtonNode>({
    id: DROP,
    kind: 'button',
    label: 'Delete',
    actionId: ACTION_DROP,
    arguments: { [PARAM_DROP]: literal('r1') },
  });
  graph.addNode<FormNode>({
    id: FORM,
    kind: 'form',
    name: 'RecordForm',
    target: ref(DRAFT),
    children: [INPUT, DROP],
    submitActionId: ACTION_SAVE,
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', name: 'Records', children: [FORM] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

const PRESENTATION_CODES = new Set<string>([
  VALIDATION_CODES.unknownPresentationToken,
  VALIDATION_CODES.presentationSemanticConflict,
  VALIDATION_CODES.multiplePrimaryActions,
  VALIDATION_CODES.formWithoutPrimaryAction,
  VALIDATION_CODES.destructiveActionPresentedAsSuccess,
  VALIDATION_CODES.destructiveActionUnmarked,
  VALIDATION_CODES.excessiveHorizontalActions,
  VALIDATION_CODES.emptyStateWithoutRecoveryAction,
  VALIDATION_CODES.rigidHorizontalLayout,
  VALIDATION_CODES.conflictingSizing,
  VALIDATION_CODES.interactiveElementMissingLabel,
  VALIDATION_CODES.formInputMissingLabel,
  VALIDATION_CODES.invalidHeadingStructure,
  VALIDATION_CODES.opaquePresentation,
]);

/** Presentation findings only, so an unrelated warning cannot pass for one. */
function findings(graph: ApplicationGraph): { errors: string[]; warnings: string[] } {
  const result = validateGraph(graph);
  return {
    errors: result.errors.filter((finding) => PRESENTATION_CODES.has(finding.code)).map((f) => f.code),
    warnings: result.warnings.filter((finding) => PRESENTATION_CODES.has(finding.code)).map((f) => f.code),
  };
}

function present(graph: ApplicationGraph, id: string, presentation: Presentation): ApplicationGraph {
  const node = graph.getNode(nodeId(id));
  assert.ok(node);
  graph.updateNode({ ...node, presentation } as never);
  return graph;
}

test('a well-formed graph reports no presentation findings at all', () => {
  const graph = baseGraph();
  assert.deepEqual(findings(graph), { errors: [], warnings: [] });
  assert.equal(validateGraph(graph).valid, true);
});

/** Section 61.1. */
test('two primary actions in one form are reported', () => {
  const graph = baseGraph();
  graph.addNode<ButtonNode>({
    id: nodeId('ui_other_primary'),
    kind: 'button',
    label: 'Publish',
    actionId: ACTION_DROP,
    presentation: { uxRole: 'primary-action' },
  });
  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  graph.updateNode({ ...form, children: [...form.children, nodeId('ui_other_primary')] });

  assert.deepEqual(findings(graph).warnings, [VALIDATION_CODES.multiplePrimaryActions]);
  assert.equal(validateGraph(graph).valid, true, 'a UX judgement never blocks compilation');
});

test('a form with no primary action is reported', () => {
  const graph = baseGraph();
  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  const { submitActionId, ...withoutSubmit } = form;
  void submitActionId;
  graph.updateNode(withoutSubmit as FormNode);

  assert.deepEqual(findings(graph).warnings, [VALIDATION_CODES.formWithoutPrimaryAction]);
});

/** Sections 27, 61.2 and 73. */
test('a destructive action presented as a success is reported', () => {
  const graph = present(baseGraph(), 'ui_drop', { role: 'success' });
  assert.deepEqual(findings(graph).warnings, [VALIDATION_CODES.destructiveActionPresentedAsSuccess]);
});

test('a control presented as destructive over an action that is not is reported', () => {
  const graph = baseGraph();
  graph.addNode<ButtonNode>({
    id: nodeId('ui_pretend'),
    kind: 'button',
    label: 'Save',
    actionId: ACTION_SAVE,
    presentation: { uxRole: 'destructive-action' },
  });
  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  graph.updateNode({ ...form, children: [...form.children, nodeId('ui_pretend')] });

  assert.ok(findings(graph).warnings.includes(VALIDATION_CODES.presentationSemanticConflict));
});

test('an action that removes data without declaring it is reported', () => {
  const graph = baseGraph();
  const action = graph.getNode<ActionDef>(ACTION_DROP);
  assert.ok(action);
  const { destructive, ...undeclared } = action;
  void destructive;
  graph.updateNode(undeclared as ActionDef);

  assert.deepEqual(findings(graph).warnings, [VALIDATION_CODES.destructiveActionUnmarked]);
});

/** Sections 36 and 61.3. */
test('a control with no accessible name is reported', () => {
  const withoutLabel = baseGraph();
  const input = withoutLabel.getNode<InputNode>(INPUT);
  assert.ok(input);
  const { label, ...unlabelled } = input;
  void label;
  withoutLabel.updateNode(unlabelled as InputNode);
  assert.deepEqual(findings(withoutLabel).warnings, [VALIDATION_CODES.formInputMissingLabel]);

  const iconOnly = baseGraph();
  const button = iconOnly.getNode<ButtonNode>(DROP);
  assert.ok(button);
  iconOnly.updateNode({ ...button, label: '', presentation: { icon: 'delete' } });
  assert.deepEqual(findings(iconOnly).warnings, [VALIDATION_CODES.interactiveElementMissingLabel]);
});

test('an accessible label satisfies a control whose visible label is an icon', () => {
  const graph = baseGraph();
  const button = graph.getNode<ButtonNode>(DROP);
  assert.ok(button);
  graph.updateNode({
    ...button,
    label: '',
    presentation: { icon: 'delete', accessibleLabel: 'Delete this record' },
  });
  assert.deepEqual(findings(graph).warnings, []);
});

/** Section 61.4. */
test('a rigid horizontal layout that says nothing about compact displays is reported', () => {
  const graph = baseGraph();
  graph.addNode<ContainerNode>({
    id: nodeId('ui_row'),
    kind: 'container',
    name: 'Row',
    children: [INPUT, DROP, nodeId('ui_note')],
    presentation: { layout: { kind: 'horizontal', wrap: false } },
  });
  graph.addNode<TextNode>({ id: nodeId('ui_note'), kind: 'text', value: 'Note' });
  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  graph.updateNode({ ...form, children: [nodeId('ui_row')] });

  assert.deepEqual(findings(graph).warnings, [VALIDATION_CODES.rigidHorizontalLayout]);
});

test('the same layout with compact behaviour declared is not reported', () => {
  const graph = baseGraph();
  graph.addNode<TextNode>({ id: nodeId('ui_note'), kind: 'text', value: 'Note' });
  graph.addNode<ContainerNode>({
    id: nodeId('ui_row'),
    kind: 'container',
    name: 'Row',
    children: [INPUT, DROP, nodeId('ui_note')],
    presentation: {
      layout: { kind: 'horizontal', wrap: false },
      responsive: { compact: { layout: 'vertical' } },
    },
  });
  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  graph.updateNode({ ...form, children: [nodeId('ui_row')] });

  assert.deepEqual(findings(graph).warnings, []);
});

test('a wall of controls side by side is reported', () => {
  const graph = baseGraph();
  const buttonIds = [0, 1, 2, 3, 4, 5].map((index) => nodeId(`ui_extra_${index}`));
  for (const id of buttonIds) {
    graph.addNode<ButtonNode>({ id, kind: 'button', label: `Action ${id}`, actionId: ACTION_SAVE });
  }
  graph.addNode<ContainerNode>({
    id: nodeId('ui_bar'),
    kind: 'container',
    name: 'Bar',
    children: buttonIds,
    presentation: { uxRole: 'toolbar' },
  });
  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  graph.updateNode({ ...form, children: [...form.children, nodeId('ui_bar')] });

  assert.ok(findings(graph).warnings.includes(VALIDATION_CODES.excessiveHorizontalActions));
});

/** Section 28: an empty state that offers nothing to do about it. */
test('an empty state with no recovery action is reported', () => {
  const graph = baseGraph();
  graph.addNode<TextNode>({ id: nodeId('ui_empty_text'), kind: 'text', value: 'Nothing here yet.' });
  graph.addNode<ContainerNode>({
    id: nodeId('ui_empty'),
    kind: 'container',
    name: 'Empty',
    children: [nodeId('ui_empty_text')],
    presentation: { uxRole: 'empty-state' },
  });
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  graph.updateNode({ ...view, children: [...view.children, nodeId('ui_empty')] });

  assert.deepEqual(findings(graph).warnings, [VALIDATION_CODES.emptyStateWithoutRecoveryAction]);
});

test('conflicting sizing is reported', () => {
  const graph = present(baseGraph(), 'ui_form', { sizing: { minWidth: 'wide', maxWidth: 'narrow' } });
  assert.deepEqual(findings(graph).warnings, [VALIDATION_CODES.conflictingSizing]);
});

/** Section 36: a view with section headings and no title has no top to its outline. */
test('headings with no title above them are reported', () => {
  const graph = baseGraph();
  graph.addNode<TextNode>({
    id: nodeId('ui_heading'),
    kind: 'text',
    value: 'Details',
    presentation: { textRole: 'heading' },
  });
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  graph.updateNode({ ...view, children: [nodeId('ui_heading'), ...view.children] });
  assert.deepEqual(findings(graph).warnings, [VALIDATION_CODES.invalidHeadingStructure]);

  graph.addNode<TextNode>({
    id: nodeId('ui_title'),
    kind: 'text',
    value: 'Records',
    presentation: { textRole: 'title' },
  });
  const withTitle = graph.getNode<ViewNode>(VIEW);
  assert.ok(withTitle);
  graph.updateNode({ ...withTitle, children: [nodeId('ui_title'), ...withTitle.children] });
  assert.deepEqual(findings(graph).warnings, []);
});

/** Sections 50 and 51. */
test('renderer-specific presentation is reported as unanalyzable, not rejected', () => {
  const graph = present(baseGraph(), 'ui_form', {
    rendererOverrides: { web: { className: 'legacy-panel' } },
  });
  const result = validateGraph(graph);
  assert.equal(result.valid, true);
  const finding = result.warnings.find((w) => w.code === VALIDATION_CODES.opaquePresentation);
  assert.ok(finding);
  assert.deepEqual(finding.details?.renderers, ['web']);
});

// ------------------------------------------------------------- unknown tokens

/** Section 61.5. */
test('an unknown presentation token is an error, not a warning', () => {
  const graph = present(baseGraph(), 'ui_form', { density: 'cosy' } as never);
  const result = validateGraph(graph);

  assert.equal(result.valid, false);
  const finding = result.errors.find((e) => e.code === VALIDATION_CODES.unknownPresentationToken);
  assert.ok(finding);
  assert.equal(finding.path, 'presentation.density');
  assert.equal(finding.details?.value, 'cosy');
  assert.ok(Array.isArray(finding.details?.allowed));
});

test('an unknown property name is caught as well as an unknown value', () => {
  const graph = present(baseGraph(), 'ui_form', { margin: 'medium' } as never);
  const errors = validateGraph(graph).errors.filter(
    (e) => e.code === VALIDATION_CODES.unknownPresentationToken,
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, 'presentation.margin');
});

test('unknown tokens are caught inside layout, sizing and responsive blocks', () => {
  const graph = present(baseGraph(), 'ui_form', {
    layout: { kind: 'diagonal' },
    sizing: { width: 'enormous' },
    responsive: { tiny: { layout: 'vertical' } },
  } as never);
  const paths = validateGraph(graph)
    .errors.filter((e) => e.code === VALIDATION_CODES.unknownPresentationToken)
    .map((e) => e.path)
    .sort();

  assert.deepEqual(paths, [
    'presentation.layout.kind',
    'presentation.responsive.tiny',
    'presentation.sizing.width',
  ]);
});

test('a currency format must name a currency', () => {
  const graph = present(baseGraph(), 'ui_form', { format: { kind: 'currency' } } as never);
  assert.ok(
    validateGraph(graph).errors.some((e) => e.code === VALIDATION_CODES.unknownPresentationToken),
  );
});

test('an unknown theme token is an error', () => {
  const graph = baseGraph();
  graph.setTheme({ spacing: { enormous: 40 }, appearance: 'twilight' } as unknown as ThemeInput);
  const errors = validateGraph(graph).errors.filter(
    (e) => e.code === VALIDATION_CODES.unknownPresentationToken,
  );
  const paths = errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['theme.appearance', 'theme.spacing.enormous']);
});

test('a theme that only says what differs is accepted', () => {
  const graph = baseGraph();
  graph.setTheme({ appearance: 'dark', defaults: { density: 'compact' }, spacing: { medium: 10 } });
  assert.deepEqual(findings(graph), { errors: [], warnings: [] });
  assert.equal(validateGraph(graph).valid, true);
});

/** Section 76: ephemeral presentation state is not a domain fact and is not persisted. */
test('ephemeral state cannot be persisted', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_panel_open'),
    kind: 'state',
    name: 'panelOpen',
    valueType: primitiveType('boolean'),
    ephemeral: true,
    initialValue: false,
    persistence: { kind: 'local-storage' },
  });
  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === VALIDATION_CODES.ephemeralStatePersisted));
});

test('ephemeral state without persistence is valid', () => {
  const graph = baseGraph();
  graph.addNode<StateDef>({
    id: nodeId('state_panel_open'),
    kind: 'state',
    name: 'panelOpen',
    valueType: primitiveType('boolean'),
    ephemeral: true,
    initialValue: false,
  });
  assert.equal(validateGraph(graph).valid, true);
});
