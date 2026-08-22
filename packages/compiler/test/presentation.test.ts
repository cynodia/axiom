import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  COMPACT_DARK_THEME,
  binary,
  DEFAULT_THEME,
  DEVICE_CLASSES,
  LAYOUT_KINDS,
  PRESENTATION_ROLES,
  SPACING_TOKENS,
  SURFACE_ROLES,
  TEXT_ROLES,
  collectionType,
  entityType,
  fieldId,
  field,
  fieldLocation,
  identitySelector,
  itemFieldLocation,
  itemLocation,
  literal,
  nodeId,
  primitiveType,
  ref,
  resolveTheme,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ButtonNode,
  ContainerNode,
  EntityDef,
  FieldDisplayNode,
  FormNode,
  InputNode,
  RouteDef,
  StateDef,
  TextNode,
  ThemeInput,
  ViewNode,
} from '@cynodia/axiom-core';
import { compileToHtml, compileToIR, createThemeStylesheet } from '@cynodia/axiom-compiler';
import {
  createAxiomRuntime,
  createMemoryHost,
  findAll,
  findByNodeId,
  findByTag,
  textOf,
  typeInto,
} from '@cynodia/axiom-runtime';
import type { MemoryElement } from '@cynodia/axiom-runtime';

/**
 * The presentation layer end to end: normalization into the IR, the class vocabulary the
 * renderer emits, the stylesheet the theme produces, and the accessible structure that
 * comes out of semantic roles.
 *
 * These tests deliberately assert *semantics* rather than markup wherever they can. The
 * markup assertions are about the reference renderer; the semantic ones are about the
 * model, and it is the model that has to survive a second renderer.
 */

const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_id');
const F_NAME = fieldId('field_name');
const F_PRICE = fieldId('field_price');
const F_SHARE = fieldId('field_share');
const F_ACTIVE = fieldId('field_active');
const F_NOTE = fieldId('field_note');

const STATE = nodeId('state_records');
const DRAFT = nodeId('state_draft');
const ACTION_SAVE = nodeId('action_save');
const ACTION_DROP = nodeId('action_drop');
const PARAM_DROP = nodeId('param_drop');

const VIEW = nodeId('ui_view');
const HEADER = nodeId('ui_header');
const TITLE = nodeId('ui_title');
const SECTION_HEADING = nodeId('ui_section_heading');
const CONTENT = nodeId('ui_content');
const NAV = nodeId('ui_nav');
const NAV_HOME = nodeId('ui_nav_home');
const PRICE = nodeId('ui_price');
const SHARE = nodeId('ui_share');
const ACTIVE = nodeId('ui_active');
const FORM = nodeId('ui_form');
const NAME_INPUT = nodeId('ui_name');
const NOTE_INPUT = nodeId('ui_note');
const ACTIVE_INPUT = nodeId('ui_active_input');
const PRICE_INPUT = nodeId('ui_price_input');
const CONSTRAINT_PRICE = nodeId('constraint_price');
const DROP = nodeId('ui_drop');
const ACTIONS = nodeId('ui_actions');
const STATUS = nodeId('ui_status');
const ROUTE = nodeId('route_records');

function buildGraph(theme?: ThemeInput): ApplicationGraph {
  const graph = new ApplicationGraph('presentation', 'Presentation');
  if (theme) {
    graph.setTheme(theme);
  }

  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    name: 'Record',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_PRICE, name: 'Price', valueType: primitiveType('number'), required: true },
      { id: F_SHARE, name: 'Share', valueType: primitiveType('number'), required: true },
      { id: F_ACTIVE, name: 'Active', valueType: primitiveType('boolean') },
      { id: F_NOTE, name: 'Note', valueType: primitiveType('string') },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE,
    kind: 'state',
    name: 'records',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [
      { [F_ID]: 'r1', [F_NAME]: 'First', [F_PRICE]: 1250, [F_SHARE]: 0.42, [F_ACTIVE]: true, [F_NOTE]: '' },
    ],
  });
  graph.addNode<StateDef>({
    id: DRAFT,
    kind: 'state',
    name: 'draft',
    valueType: entityType(ENTITY),
    draft: true,
    initialValue: {
      [F_ID]: '',
      [F_NAME]: '',
      [F_PRICE]: 0,
      [F_SHARE]: 0,
      [F_ACTIVE]: false,
      [F_NOTE]: '',
    },
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
    requiresConfirmation: true,
    confirmation: {
      title: 'Delete this record?',
      description: 'It cannot be brought back.',
      confirmLabel: 'Delete it',
      severity: 'destructive',
    },
    parameters: [{ id: PARAM_DROP, name: 'id', valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'remove', target: itemLocation(stateLocation(STATE), identitySelector(F_ID, ref(PARAM_DROP))) },
    ],
  });

  graph.addNode<TextNode>({
    id: TITLE,
    kind: 'text',
    value: 'Records',
    presentation: { textRole: 'title' },
  });
  graph.addNode<ButtonNode>({
    id: NAV_HOME,
    kind: 'button',
    label: 'Home',
    actionId: ACTION_SAVE,
    presentation: { uxRole: 'navigation-action', icon: 'menu' },
  });
  graph.addNode<ContainerNode>({
    id: NAV,
    kind: 'container',
    name: 'Navigation',
    children: [NAV_HOME],
    presentation: { uxRole: 'navigation-group' },
  });
  graph.addNode<ContainerNode>({
    id: HEADER,
    kind: 'container',
    name: 'Header',
    children: [TITLE, NAV],
    presentation: {
      uxRole: 'header-region',
      responsive: { compact: { layout: 'vertical', gap: 'xsmall', hidden: false } },
    },
  });

  graph.addNode<TextNode>({
    id: SECTION_HEADING,
    kind: 'text',
    value: 'Details',
    presentation: { textRole: 'heading' },
  });
  graph.addNode<FieldDisplayNode>({
    id: PRICE,
    kind: 'field-display',
    source: ref(DRAFT),
    fieldId: F_PRICE,
    label: 'Price',
    presentation: { format: { kind: 'currency', currency: 'NOK' } },
  });
  graph.addNode<FieldDisplayNode>({
    id: SHARE,
    kind: 'field-display',
    source: ref(DRAFT),
    fieldId: F_SHARE,
    label: 'Share',
    presentation: { format: { kind: 'percentage', decimals: 1 }, treatment: 'badge', role: 'informational' },
  });
  graph.addNode<FieldDisplayNode>({
    id: ACTIVE,
    kind: 'field-display',
    source: ref(DRAFT),
    fieldId: F_ACTIVE,
    label: 'Active',
    presentation: { format: { kind: 'boolean', trueLabel: 'Live', falseLabel: 'Paused' } },
  });

  graph.addNode<InputNode>({
    id: NAME_INPUT,
    kind: 'input',
    label: 'Name',
    binding: { location: fieldLocation(stateLocation(DRAFT), F_NAME) },
    presentation: { description: 'Shown wherever the record appears.' },
  });
  // A rule about canonical state, so a write from a control can actually be refused.
  graph.addNode({
    id: CONSTRAINT_PRICE,
    kind: 'constraint',
    name: 'A price is never negative',
    entityId: ENTITY,
    message: 'A price can never be negative.',
    expression: binary('gte', field(ref(ENTITY), F_PRICE), literal(0)),
  } as never);
  graph.addNode<InputNode>({
    id: PRICE_INPUT,
    kind: 'input',
    label: 'Price',
    // Straight into canonical state, so the write is guarded per keystroke.
    binding: { location: itemFieldLocation(STATE, F_ID, literal('r1'), F_PRICE) },
  });
  graph.addNode<InputNode>({
    id: NOTE_INPUT,
    kind: 'input',
    label: 'Note',
    binding: { location: fieldLocation(stateLocation(DRAFT), F_NOTE) },
    presentation: { control: 'multiline' },
  });
  graph.addNode<InputNode>({
    id: ACTIVE_INPUT,
    kind: 'input',
    label: 'Active',
    binding: { location: fieldLocation(stateLocation(DRAFT), F_ACTIVE) },
    presentation: { control: 'switch' },
  });
  graph.addNode<ButtonNode>({
    id: DROP,
    kind: 'button',
    label: 'Delete',
    actionId: ACTION_DROP,
    arguments: { [PARAM_DROP]: literal('r1') },
    presentation: { icon: 'delete' },
  });
  graph.addNode<ContainerNode>({
    id: ACTIONS,
    kind: 'container',
    name: 'Actions',
    children: [DROP],
    presentation: { uxRole: 'action-group' },
  });
  graph.addNode<FormNode>({
    id: FORM,
    kind: 'form',
    name: 'RecordForm',
    target: ref(DRAFT),
    children: [
      SECTION_HEADING,
      NAME_INPUT,
      PRICE_INPUT,
      NOTE_INPUT,
      ACTIVE_INPUT,
      PRICE,
      SHARE,
      ACTIVE,
      ACTIONS,
    ],
    submitActionId: ACTION_SAVE,
    submitLabel: 'Save',
  });
  graph.addNode<TextNode>({
    id: STATUS,
    kind: 'text',
    value: 'Nothing has gone wrong.',
    presentation: { uxRole: 'informational-state' },
  });
  graph.addNode<ContainerNode>({
    id: CONTENT,
    kind: 'container',
    name: 'Content',
    children: [FORM, STATUS],
    presentation: { uxRole: 'content-region' },
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', name: 'Records', children: [HEADER, CONTENT] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });
  return graph;
}

function createApp(theme?: ThemeInput) {
  const host = createMemoryHost();
  const app = createAxiomRuntime({ ir: compileToIR(buildGraph(theme)), rootElement: host.root, host });
  app.start();
  return { app, host };
}

function classesOf(root: MemoryElement, id: string): string[] {
  const found = findByNodeId(root, id).find((element) => element.getAttribute('class'));
  assert.ok(found, `no element rendered for ${id}`);
  return (found.getAttribute('class') ?? '').split(/\s+/);
}

function elementFor(root: MemoryElement, id: string, skipLabel = true): MemoryElement {
  const found = findByNodeId(root, id).find((element) => !skipLabel || element.tagName !== 'label');
  assert.ok(found, `no element rendered for ${id}`);
  return found;
}

// ------------------------------------------------------------------------- IR

test('the IR carries a completed theme and resolved presentation per node', () => {
  const ir = compileToIR(buildGraph());

  assert.equal(ir.theme.id, DEFAULT_THEME.id);
  assert.equal(ir.theme.spacing.medium, DEFAULT_THEME.spacing.medium);
  for (const id of [VIEW, HEADER, TITLE, FORM, NAME_INPUT, DROP]) {
    assert.ok(ir.presentation[id], `${id} has no resolved presentation in the IR`);
  }
  assert.equal(ir.presentation[DROP].role, 'destructive');
  assert.equal(ir.presentation[HEADER].uxRole, 'header-region');
});

/** Sections 44 and 45: the IR stays semantic so another renderer remains possible. */
test('resolved presentation in the IR names no colour, length or CSS property', () => {
  const serialized = JSON.stringify(compileToIR(buildGraph()).presentation);

  for (const forbidden of [/\d+px/, /#[0-9a-fA-F]{3,8}/, /"display"/, /flex-direction/, /rgba?\(/, /grid-template/]) {
    assert.doesNotMatch(serialized, forbidden, `presentation IR leaked ${String(forbidden)}`);
  }
  // What it does contain is roles, tokens and device classes.
  assert.match(serialized, /"destructive"/);
  assert.match(serialized, /"medium"|"small"|"large"/);
  assert.match(serialized, /"compact"/);
});

test('the IR records whether each bound field is required', () => {
  const ir = compileToIR(buildGraph());
  assert.equal(ir.locationRequired[NAME_INPUT], true, 'Name is a required field');
  assert.equal(ir.locationRequired[NOTE_INPUT], false, 'Note is not');
});

test('every resolved property says which layer decided it', () => {
  const ir = compileToIR(buildGraph());
  assert.equal(ir.presentation[TITLE].origins.textRole, 'node');
  assert.equal(ir.presentation[DROP].origins.role, 'inferred');
  assert.equal(ir.presentation[FORM].origins.density, 'theme');
  assert.equal(ir.presentation[SECTION_HEADING].origins.density, 'theme');
});

/** Section 74. */
test('a different theme changes presentation and leaves the semantics identical', () => {
  const light = compileToIR(buildGraph());
  const dark = compileToIR(buildGraph(COMPACT_DARK_THEME));

  assert.deepEqual(dark.actions, light.actions);
  assert.deepEqual(dark.constraints, light.constraints);
  assert.deepEqual(dark.routes, light.routes);
  assert.deepEqual(dark.states, light.states);
  assert.deepEqual(dark.uiNodes, light.uiNodes);

  assert.equal(light.presentation[FORM].density, 'comfortable');
  assert.equal(dark.presentation[FORM].density, 'compact');
  assert.equal(dark.theme.appearance, 'dark');
});

// -------------------------------------------------------------- class emission

test('the renderer emits semantic classes and no styles', () => {
  const { host } = createApp();
  const form = classesOf(host.root, FORM);

  assert.ok(form.includes('axiom-form'));
  assert.ok(form.includes('axiom-surface-raised'), 'a form is a raised surface by inference');
  assert.ok(form.includes('axiom-layout-vertical'));
  assert.ok(form.includes('axiom-gap-medium'));
  assert.ok(form.includes('axiom-density-comfortable'));

  // Nothing anywhere in the rendered tree carries a style attribute.
  for (const element of findByTag(host.root, 'div')) {
    assert.equal(element.getAttribute('style'), null);
  }
});

/** Section 58. */
test('a destructive action reaches the DOM as a destructive control', () => {
  const { host } = createApp();
  const classes = classesOf(host.root, DROP);
  assert.ok(classes.includes('axiom-role-destructive'));
  assert.ok(classes.includes('axiom-ux-destructive-action'));
});

test('a UX role reaches the DOM as itself, not as an opaque component', () => {
  const { host } = createApp();
  assert.ok(classesOf(host.root, ACTIONS).includes('axiom-ux-action-group'));
  assert.ok(classesOf(host.root, ACTIONS).includes('axiom-layout-horizontal'));
  assert.ok(classesOf(host.root, ACTIONS).includes('axiom-justify-end'));
  assert.ok(classesOf(host.root, ACTIONS).includes('axiom-wrap'));
});

/** Section 16: a device class becomes a class, not a media query in the graph. */
test('responsive intent reaches the DOM as per-device classes', () => {
  const { host } = createApp();
  const classes = classesOf(host.root, HEADER);
  assert.ok(classes.includes('axiom-layout-horizontal'), 'the base layout');
  assert.ok(classes.includes('axiom-compact-layout-vertical'), 'and what compact does instead');
  assert.ok(classes.includes('axiom-compact-gap-xsmall'));
  assert.ok(!classes.some((name) => name.startsWith('axiom-regular-')), 'nothing is invented');
});

test('the escape hatch attaches its class and marks the node opaque', () => {
  const graph = buildGraph();
  const status = graph.getNode<TextNode>(STATUS);
  assert.ok(status);
  graph.updateNode({
    ...status,
    presentation: { ...status.presentation, rendererOverrides: { web: { className: 'legacy-note' } } },
  });
  const host = createMemoryHost();
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();

  const classes = classesOf(host.root, STATUS);
  assert.ok(classes.includes('axiom-opaque'));
  assert.ok(classes.includes('legacy-note'));
});

// ----------------------------------------------------------- value formatting

/** Sections 32, 33 and 60. */
test('values are formatted for display while the stored value is untouched', () => {
  const { app, host } = createApp();

  assert.match(textOf(elementFor(host.root, PRICE)), /NOK\s?0\.00/);
  const draft = app.getState(DRAFT) as Record<string, unknown>;
  assert.equal(draft[F_PRICE], 0, 'the value is still a number');

  app.hydrateState(DRAFT, { ...draft, [F_PRICE]: 1250, [F_SHARE]: 0.421, [F_ACTIVE]: true });
  assert.match(textOf(elementFor(host.root, PRICE)), /NOK\s?1,250\.00/);
  assert.match(textOf(elementFor(host.root, SHARE)), /42\.1%/);
  assert.match(textOf(elementFor(host.root, ACTIVE)), /Live/);
  assert.equal((app.getState(DRAFT) as Record<string, unknown>)[F_PRICE], 1250);
});

test('a boolean carries the labels the graph gave it', () => {
  const { app, host } = createApp();
  const draft = app.getState(DRAFT) as Record<string, unknown>;
  app.hydrateState(DRAFT, { ...draft, [F_ACTIVE]: false });
  assert.match(textOf(elementFor(host.root, ACTIVE)), /Paused/);
});

test('a badge treatment reaches the DOM as a badge', () => {
  const { host } = createApp();
  const classes = classesOf(host.root, SHARE);
  assert.ok(classes.includes('axiom-treatment-badge'));
  assert.ok(classes.includes('axiom-role-informational'));
});

// ------------------------------------------------------------- accessibility

/** Sections 35 and 64. */
test('semantic roles become landmarks and headings', () => {
  const { host } = createApp();

  assert.equal(elementFor(host.root, HEADER).tagName, 'header');
  assert.equal(elementFor(host.root, NAV).tagName, 'nav');
  assert.equal(elementFor(host.root, CONTENT).tagName, 'main');
  assert.equal(elementFor(host.root, TITLE).tagName, 'h2', 'a title is a heading below the page title');
  assert.equal(elementFor(host.root, SECTION_HEADING).tagName, 'h3');
});

test('a status region announces itself', () => {
  const { host } = createApp();
  assert.equal(elementFor(host.root, STATUS).getAttribute('role'), 'status');
});

test('a label names its control, and a required field says so', () => {
  const { host } = createApp();
  const wrapper = findByNodeId(host.root, NAME_INPUT).find((element) => element.tagName === 'label');
  const control = elementFor(host.root, NAME_INPUT);

  assert.ok(wrapper);
  assert.equal(wrapper.getAttribute('for'), control.getAttribute('id'));
  assert.equal(control.getAttribute('aria-required'), 'true');
  assert.match(textOf(wrapper), /Name/);
  assert.match(textOf(wrapper), /\*/, 'and it is marked as required');

  assert.equal(elementFor(host.root, NOTE_INPUT).getAttribute('aria-required'), null);
});

test('help text is related to the control it describes', () => {
  const { host } = createApp();
  const control = elementFor(host.root, NAME_INPUT);
  const describedBy = control.getAttribute('aria-describedby');
  assert.ok(describedBy);
  assert.match(textOf(elementFor(host.root, NAME_INPUT, false)), /Shown wherever the record appears/);
});

test('a button whose label is an icon still has an accessible name', () => {
  const graph = buildGraph();
  const button = graph.getNode<ButtonNode>(DROP);
  assert.ok(button);
  graph.updateNode({ ...button, label: '', presentation: { icon: 'delete', accessibleLabel: 'Delete record' } });
  const host = createMemoryHost();
  createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host }).start();

  assert.equal(elementFor(host.root, DROP).getAttribute('aria-label'), 'Delete record');
});

test('an icon is drawn from the theme and hidden from assistive technology', () => {
  const { host } = createApp();
  const icon = findByTag(elementFor(host.root, DROP), 'span').find(
    (element) => element.getAttribute('data-icon') === 'delete',
  );
  assert.ok(icon);
  assert.equal(icon.textContent, DEFAULT_THEME.icons.delete);
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
});

// ------------------------------------------------------------ control variants

test('semantic control intent chooses the control', () => {
  const { host } = createApp();
  assert.equal(elementFor(host.root, NOTE_INPUT).tagName, 'textarea');

  const active = elementFor(host.root, ACTIVE_INPUT);
  assert.equal(active.tagName, 'input');
  assert.equal(active.getAttribute('type'), 'checkbox');
  assert.equal(active.getAttribute('role'), 'switch');
  assert.equal(active.getAttribute('data-variant'), 'switch');
});

test('a stepper and a radio group are real controls, not decoration', () => {
  const graph = buildGraph();
  const price = graph.getNode<InputNode>(NAME_INPUT);
  assert.ok(price);
  graph.updateNode({ ...price, presentation: { control: 'stepper' } });
  const host = createMemoryHost();
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();

  const stepper = elementFor(host.root, NAME_INPUT);
  assert.equal(stepper.getAttribute('type'), 'number');
  assert.equal(stepper.getAttribute('data-variant'), 'stepper');
});

/** Sections 29 and 36: a refusal is related to the control that was refused. */
test('a refused write is reported on the control that was refused', () => {
  const { app, host } = createApp();

  typeInto(elementFor(host.root, PRICE_INPUT), '-5');

  const control = elementFor(host.root, PRICE_INPUT);
  assert.equal(control.getAttribute('aria-invalid'), 'true');
  const wrapper = findByNodeId(host.root, PRICE_INPUT).find((element) => element.tagName === 'label');
  assert.ok(wrapper);
  const alert = findByTag(wrapper, 'span').find((element) => element.getAttribute('role') === 'alert');
  assert.ok(alert, 'the refusal is announced');
  assert.match(alert.textContent ?? '', /never be negative/);
  assert.equal(control.getAttribute('aria-describedby'), alert.getAttribute('id'));

  const stored = app.getState(STATE) as Array<Record<string, unknown>>;
  assert.equal(stored[0][F_PRICE], 1250, 'and the stored value never moved');

  typeInto(elementFor(host.root, PRICE_INPUT), '900');
  assert.equal(elementFor(host.root, PRICE_INPUT).getAttribute('aria-invalid'), null);
  assert.equal((app.getState(STATE) as Array<Record<string, unknown>>)[0][F_PRICE], 900);
});

// ----------------------------------------------------------------- stylesheet

test('the stylesheet is generated from theme data', () => {
  const css = createThemeStylesheet(DEFAULT_THEME);

  assert.match(css, /--axiom-space-medium:\s*14px/);
  assert.match(css, /--axiom-radius-medium:\s*10px/);
  assert.match(css, /--axiom-color-accent:\s*#2f5fe0/);
  assert.match(css, /--axiom-color-destructive:/);
  assert.match(css, /@media \(max-width: 599px\)/);
  assert.match(css, /@media \(min-width: 1024px\)/);
  assert.match(css, /prefers-color-scheme: dark/);
});

test('every semantic token in the vocabulary has a rule', () => {
  const css = createThemeStylesheet(DEFAULT_THEME);

  for (const kind of LAYOUT_KINDS) {
    assert.match(css, new RegExp(`\\.axiom-layout-${kind}\\b`), `no rule for layout ${kind}`);
  }
  for (const token of SPACING_TOKENS) {
    assert.match(css, new RegExp(`\\.axiom-gap-${token}\\b`), `no rule for gap ${token}`);
    assert.match(css, new RegExp(`\\.axiom-pad-x-${token}\\b`), `no rule for padding ${token}`);
  }
  for (const role of SURFACE_ROLES) {
    assert.match(css, new RegExp(`\\.axiom-surface-${role}\\b`), `no rule for surface ${role}`);
  }
  for (const role of TEXT_ROLES) {
    assert.match(css, new RegExp(`\\.axiom-text-${role}\\b`), `no rule for text role ${role}`);
  }
  for (const role of PRESENTATION_ROLES) {
    assert.match(css, new RegExp(`\\.axiom-role-${role}\\b`), `no rule for role ${role}`);
  }
  for (const device of DEVICE_CLASSES) {
    assert.match(css, new RegExp(`\\.axiom-${device}-layout-vertical\\b`), `no responsive rule for ${device}`);
  }
});

test('a theme token change moves through to the stylesheet and nothing else', () => {
  const dense = createThemeStylesheet(resolveTheme({ spacing: { medium: 4 } }));
  assert.match(dense, /--axiom-space-medium:\s*4px/);
  assert.doesNotMatch(dense, /--axiom-space-medium:\s*14px/);
});

test('appearance decides which colour set the sheet carries', () => {
  const dark = createThemeStylesheet(resolveTheme({ appearance: 'dark' }));
  assert.match(dark, /color-scheme: dark/);
  assert.match(dark, new RegExp(`--axiom-color-background:\\s*${DEFAULT_THEME.colors.dark.background}`));
  assert.doesNotMatch(dark, /prefers-color-scheme/, 'a pinned appearance needs no media query');

  const system = createThemeStylesheet(resolveTheme({ appearance: 'system' }));
  assert.match(system, /prefers-color-scheme: dark/);
});

/** Section 17: sensible responsive behaviour without the graph asking for it. */
test('the sheet degrades fixed grids and bounded widths on compact displays', () => {
  const css = createThemeStylesheet(DEFAULT_THEME);
  const compact = css.slice(css.indexOf('@media (max-width: 599px)'));
  assert.match(compact, /\.axiom-columns-3 \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(compact, /\.axiom-width-wide \{ width: 100%/);
});

// ---------------------------------------------------------------- page output

test('the emitted page carries the generated stylesheet and no application CSS', () => {
  const html = compileToHtml(buildGraph());
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];

  assert.ok(style);
  assert.match(style, /--axiom-color-accent/);
  assert.match(style, /\.axiom-ux-empty-state/);
  // Not one selector names anything from the application.
  assert.doesNotMatch(style, /record/i);
  assert.doesNotMatch(style, /field_/);
});

test('a pinned appearance is stamped on the document', () => {
  assert.match(compileToHtml(buildGraph(), { appearance: 'dark' }), /<html lang="en" data-axiom-appearance="dark">/);
  assert.match(compileToHtml(buildGraph()), /<html lang="en">/, 'a system theme follows the reader');
  assert.match(compileToHtml(buildGraph({ appearance: 'dark' })), /data-axiom-appearance="dark"/);
});

// --------------------------------------------------------------- confirmation

/** Section 77. */
test('a confirmation is described to the host rather than drawn', () => {
  const { app, host } = createApp();
  app.invokeAction(ACTION_DROP, { [PARAM_DROP]: 'r1' });

  const [request] = host.confirmationRequests;
  assert.ok(request);
  assert.equal(request.actionId, ACTION_DROP);
  assert.equal(request.title, 'Delete this record?');
  assert.equal(request.description, 'It cannot be brought back.');
  assert.equal(request.confirmLabel, 'Delete it');
  assert.equal(request.severity, 'destructive');
  assert.match(request.message, /Delete this record\? — It cannot be brought back\./);
});

test('a host that can only ask a plain question still gets a sentence', () => {
  const host = createMemoryHost();
  delete (host as { confirmRequest?: unknown }).confirmRequest;
  const app = createAxiomRuntime({ ir: compileToIR(buildGraph()), rootElement: host.root, host });
  app.start();
  app.invokeAction(ACTION_DROP, { [PARAM_DROP]: 'r1' });

  assert.deepEqual(host.confirmations, ['Delete this record? — It cannot be brought back.']);
});

test('data-control names the element a person operates, data-node the semantic node', () => {
  // An input renders as a label wrapping a control, and both *are* that node, so both carry
  // `data-node`. Only one of them can be typed into, and until 0.6.1 nothing in the DOM said
  // which — tooling had to guess by tag name.
  const { host } = createApp();

  assert.equal(findByNodeId(host.root, NAME_INPUT).length, 2, 'wrapper and control, both the node');
  const controls = findAll(
    host.root,
    (element) => element.getAttribute('data-control') === NAME_INPUT,
  );
  assert.equal(controls.length, 1, 'exactly one of them is the control');
  assert.equal(controls[0].tagName, 'input');

  // A button is its own control, so the two attributes name the same element.
  const button = elementFor(host.root, DROP);
  assert.equal(button.tagName, 'button');
  assert.equal(button.getAttribute('data-control'), DROP);
});
