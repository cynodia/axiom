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
    arguments: { [PARAM_DROP]: literal('r1') },
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

/**
 * Sections 19 and 20: the outline is checked on resolved heading levels, not on rendered
 * markup, and a level comes from `headingLevel` when it is stated.
 */
function withHeadings(levels: Array<number | 'none'>): ApplicationGraph {
  const graph = baseGraph();
  const ids = levels.map((level, index) => {
    const id = nodeId(`ui_heading_${index}`);
    graph.addNode<TextNode>({
      id,
      kind: 'text',
      value: `Heading ${index}`,
      presentation: { headingLevel: level as never },
    });
    return id;
  });
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  graph.updateNode({ ...view, children: [...ids, ...view.children] });
  return graph;
}

function headingFindings(graph: ApplicationGraph): string[] {
  return validateGraph(graph)
    .warnings.filter((finding) => finding.code === VALIDATION_CODES.invalidHeadingStructure)
    .map((finding) => finding.message);
}

test('a well-formed outline is not reported', () => {
  assert.deepEqual(headingFindings(withHeadings([1, 2, 3, 2])), []);
});

test('a view with no headings at all has no outline to be wrong about', () => {
  assert.deepEqual(headingFindings(withHeadings([])), []);
  assert.deepEqual(headingFindings(withHeadings(['none', 'none'])), []);
});

test('a missing level-1 heading is reported', () => {
  const findings = headingFindings(withHeadings([2, 3]));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /no level-1 heading/);
});

test('more than one level-1 heading is reported', () => {
  const findings = headingFindings(withHeadings([1, 1, 2]));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /2 level-1 headings/);
});

test('a skipped heading level is reported', () => {
  const findings = headingFindings(withHeadings([1, 3]));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /skips from heading level 1 to 3/);
});

/** Section 16. */
test('a large value that is not a heading does not enter the outline', () => {
  const graph = baseGraph();
  graph.addNode<TextNode>({
    id: nodeId('ui_total'),
    kind: 'text',
    value: 'NOK 1,250.00',
    presentation: { textRole: 'display', headingLevel: 'none' },
  });
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  graph.updateNode({ ...view, children: [nodeId('ui_total'), ...view.children] });

  assert.deepEqual(headingFindings(graph), [], 'it is not a heading, so there is no outline');
});

/** Section 18. */
test('the 0.5.0 mapping from text role to heading level still applies', () => {
  const graph = baseGraph();
  for (const [index, role] of (['display', 'title', 'heading'] as const).entries()) {
    graph.addNode<TextNode>({
      id: nodeId(`ui_role_${index}`),
      kind: 'text',
      value: role,
      presentation: { textRole: role },
    });
  }
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  graph.updateNode({
    ...view,
    children: [nodeId('ui_role_0'), nodeId('ui_role_1'), nodeId('ui_role_2'), ...view.children],
  });
  assert.deepEqual(headingFindings(graph), [], 'display, title and heading are levels 1, 2 and 3');
});

test('an outline is read along the primary render path only', () => {
  const graph = baseGraph();
  graph.addNode<TextNode>({ id: nodeId('ui_row'), kind: 'text', value: 'Row' });
  graph.addNode<TextNode>({
    id: nodeId('ui_empty_heading'),
    kind: 'text',
    value: 'Nothing yet',
    presentation: { headingLevel: 1 },
  });
  graph.addNode({
    id: nodeId('ui_rows'),
    kind: 'repeat',
    source: ref(STATE),
    templateId: nodeId('ui_row'),
    emptyTemplateId: nodeId('ui_empty_heading'),
  } as never);
  graph.addNode<TextNode>({
    id: nodeId('ui_page_title'),
    kind: 'text',
    value: 'Records',
    presentation: { headingLevel: 1 },
  });
  const view = graph.getNode<ViewNode>(VIEW);
  assert.ok(view);
  graph.updateNode({
    ...view,
    children: [nodeId('ui_page_title'), nodeId('ui_rows'), ...view.children],
  });

  // Two level-1 headings exist in the graph, but never on screen at the same time.
  assert.deepEqual(headingFindings(graph), []);
});

/**
 * Section 21: the conflict diagnostic had no reachable condition beyond two narrow cases.
 * Every check below is decided from the graph alone — no heuristics about taste.
 */
function conflicts(graph: ApplicationGraph): string[] {
  return validateGraph(graph)
    .warnings.filter((finding) => finding.code === VALIDATION_CODES.presentationSemanticConflict)
    .map((finding) => finding.message);
}

test('a control-only UX role on something that is not a control is reported', () => {
  const graph = present(baseGraph(), 'ui_input', { uxRole: 'primary-action' });
  assert.equal(conflicts(graph).length, 1);
  assert.match(conflicts(graph)[0], /cannot be a "primary-action"/);
});

test('a region role on something that holds no children is reported', () => {
  const graph = present(baseGraph(), 'ui_input', { uxRole: 'form-section' });
  assert.equal(conflicts(graph).length, 1);
  assert.match(conflicts(graph)[0], /holds no children/);
});

test('a navigation role over an action that does not navigate is reported', () => {
  const graph = present(baseGraph(), 'ui_drop', { uxRole: 'navigation-action' });
  assert.match(conflicts(graph).join(' '), /does not navigate/);

  // An action that navigates is not reported.
  const navigating = baseGraph();
  navigating.addNode<ActionDef>({
    id: nodeId('action_go'),
    kind: 'action',
    name: 'go',
    operations: [{ kind: 'navigate', routeId: ROUTE }],
  });
  const button = navigating.getNode<ButtonNode>(DROP);
  assert.ok(button);
  navigating.updateNode({
    ...button,
    actionId: nodeId('action_go'),
    arguments: {},
    presentation: { uxRole: 'navigation-action' },
  });
  assert.deepEqual(conflicts(navigating), []);
});

test('a navigation role over an action that navigates indirectly is not reported', () => {
  const graph = baseGraph();
  graph.addNode<ActionDef>({
    id: nodeId('action_go'),
    kind: 'action',
    name: 'go',
    operations: [{ kind: 'navigate', routeId: ROUTE }],
  });
  graph.addNode<ActionDef>({
    id: nodeId('action_finish'),
    kind: 'action',
    name: 'finish',
    operations: [{ kind: 'invoke', actionId: nodeId('action_go') }],
  });
  const button = graph.getNode<ButtonNode>(DROP);
  assert.ok(button);
  graph.updateNode({
    ...button,
    actionId: nodeId('action_finish'),
    arguments: {},
    presentation: { uxRole: 'navigation-action' },
  });
  assert.deepEqual(conflicts(graph), []);
});

test('a value treatment or format on a node that renders no value is reported', () => {
  assert.match(conflicts(present(baseGraph(), 'ui_form', { treatment: 'badge' }))[0], /renders no value/);
  assert.match(
    conflicts(present(baseGraph(), 'ui_form', { format: { kind: 'text' } }))[0],
    /renders no value to format/,
  );
});

test('a format the declared type could never be is reported', () => {
  const graph = baseGraph();
  graph.addNode({
    id: nodeId('ui_name_display'),
    kind: 'field-display',
    source: ref(DRAFT),
    fieldId: F_NAME,
    // Name is a string; a currency it is not.
    presentation: { format: { kind: 'currency', currency: 'NOK' } },
  } as never);
  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  graph.updateNode({ ...form, children: [...form.children, nodeId('ui_name_display')] });

  assert.equal(conflicts(graph).length, 1);
  assert.match(conflicts(graph)[0], /which its declared type is not/);
});

test('a format the declared type can be is not reported', () => {
  const graph = baseGraph();
  graph.addNode({
    id: nodeId('ui_name_display'),
    kind: 'field-display',
    source: ref(DRAFT),
    fieldId: F_NAME,
    presentation: { format: { kind: 'text' } },
  } as never);
  const form = graph.getNode<FormNode>(FORM);
  assert.ok(form);
  graph.updateNode({ ...form, children: [...form.children, nodeId('ui_name_display')] });
  assert.deepEqual(conflicts(graph), []);
});

test('a control variant on something that is not edited is reported', () => {
  assert.match(conflicts(present(baseGraph(), 'ui_drop', { control: 'switch' }))[0], /not edited by a control/);
});

test('a heading level on something that is not text is reported', () => {
  assert.match(conflicts(present(baseGraph(), 'ui_form', { headingLevel: 2 }))[0], /cannot be a heading/);
});

test('the two 0.5.0 conflict cases still hold', () => {
  const pretending = baseGraph();
  const save = pretending.getNode<InputNode>(INPUT);
  void save;
  pretending.addNode<ButtonNode>({
    id: nodeId('ui_pretend'),
    kind: 'button',
    label: 'Save',
    actionId: ACTION_SAVE,
    presentation: { uxRole: 'destructive-action' },
  });
  const form = pretending.getNode<FormNode>(FORM);
  assert.ok(form);
  pretending.updateNode({ ...form, children: [...form.children, nodeId('ui_pretend')] });
  assert.match(conflicts(pretending).join(' '), /declares no destructive intent/);

  const muted = present(baseGraph(), 'ui_drop', { uxRole: 'primary-action', role: 'muted' });
  assert.match(conflicts(muted).join(' '), /primary action but is presented as muted/);
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
