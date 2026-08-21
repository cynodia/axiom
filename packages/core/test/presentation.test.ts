import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  COMPACT_DARK_THEME,
  DEFAULT_THEME,
  INHERITED_PROPERTIES,
  collectionType,
  entityType,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  resolvePresentation,
  resolvePresentationMap,
  resolveTheme,
  stateLocation,
  uxRoleLayer,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  AnyNode,
  ButtonNode,
  ContainerNode,
  EntityDef,
  FieldDisplayNode,
  FormNode,
  InputNode,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';

/**
 * Presentation resolution, sections 39–41 and 72. The point of recording an origin for
 * every resolved property is that the documented precedence can be asserted rather than
 * described, so most of these tests read an origin as well as a value.
 */

const ENTITY = nodeId('entity_record');
const F_ID = fieldId('field_id');
const F_DONE = fieldId('field_done');
const F_DUE = fieldId('field_due');
const STATE = nodeId('state_records');
const ACTION_SAVE = nodeId('action_save');
const ACTION_DROP = nodeId('action_drop');

const VIEW = nodeId('ui_view');
const HEADER = nodeId('ui_header');
const TITLE = nodeId('ui_title');
const FORM = nodeId('ui_form');
const INPUT = nodeId('ui_input');
const SAVE = nodeId('ui_save');
const DROP = nodeId('ui_drop');
const DONE = nodeId('ui_done');
const DUE = nodeId('ui_due');

function baseNodes(): AnyNode[] {
  return [
    {
      id: ENTITY,
      kind: 'entity',
      name: 'Record',
      identityFieldId: F_ID,
      fields: [
        { id: F_ID, name: 'Id', valueType: primitiveType('string'), required: true },
        { id: F_DONE, name: 'Done', valueType: primitiveType('boolean') },
        { id: F_DUE, name: 'Due', valueType: primitiveType('date') },
      ],
    } as EntityDef,
    {
      id: STATE,
      kind: 'state',
      name: 'records',
      valueType: collectionType(entityType(ENTITY)),
      initialValue: [],
    } as StateDef,
    { id: ACTION_SAVE, kind: 'action', name: 'save', operations: [] } as ActionDef,
    {
      id: ACTION_DROP,
      kind: 'action',
      name: 'drop',
      destructive: true,
      operations: [],
    } as ActionDef,
    { id: TITLE, kind: 'text', value: 'Records' } as TextNode,
    { id: HEADER, kind: 'container', children: [TITLE] } as ContainerNode,
    { id: INPUT, kind: 'input', label: 'Name', binding: { location: stateLocation(STATE) } } as InputNode,
    { id: SAVE, kind: 'button', label: 'Save', actionId: ACTION_SAVE } as ButtonNode,
    { id: DROP, kind: 'button', label: 'Delete', actionId: ACTION_DROP } as ButtonNode,
    { id: DONE, kind: 'field-display', source: ref(STATE), fieldId: F_DONE } as FieldDisplayNode,
    { id: DUE, kind: 'field-display', source: ref(STATE), fieldId: F_DUE } as FieldDisplayNode,
    {
      id: FORM,
      kind: 'form',
      target: ref(STATE),
      children: [INPUT, SAVE, DROP, DONE, DUE],
      submitActionId: ACTION_SAVE,
    } as FormNode,
    { id: VIEW, kind: 'view', name: 'Records', children: [HEADER, FORM] } as ViewNode,
  ];
}

/** Replaces one node in the fixture, which is how a single declaration is varied. */
function withNode(replacement: Partial<AnyNode> & { id: string }): AnyNode[] {
  return baseNodes().map((node) =>
    node.id === replacement.id ? ({ ...node, ...replacement } as AnyNode) : node,
  );
}

test('a graph with no presentation at all still resolves to something usable', () => {
  const resolved = resolvePresentationMap(baseNodes());

  for (const node of baseNodes()) {
    if (!String(node.id).startsWith('ui_')) {
      continue;
    }
    const view = resolved[node.id];
    assert.ok(view, `${node.id} has no resolved presentation`);
    assert.ok(view.layout.kind);
    assert.ok(view.sizing.width);
    assert.equal(view.density, 'comfortable');
    assert.equal(view.textRole, 'body');
  }
});

test('the theme decides what renderer defaults left open', () => {
  const dense = resolveTheme({ defaults: { density: 'compact', gap: 'large' } });
  const resolved = resolvePresentationMap(baseNodes(), dense);

  assert.equal(resolved[HEADER].density, 'compact');
  assert.equal(resolved[HEADER].origins.density, 'theme');
  assert.equal(resolved[TITLE].layout.gap, 'large');
});

test('density is the only property that cascades, and it says where it came from', () => {
  assert.deepEqual(INHERITED_PROPERTIES, ['density']);

  const nodes = withNode({ id: HEADER, presentation: { density: 'spacious' } } as never);
  const resolved = resolvePresentationMap(nodes);

  assert.equal(resolved[HEADER].density, 'spacious');
  assert.equal(resolved[HEADER].origins.density, 'node');
  assert.equal(resolved[TITLE].density, 'spacious', 'the child inherits it');
  assert.equal(resolved[TITLE].origins.density, 'inherited');

  // Nothing else cascades: the parent's emphasis is its own business.
  const emphatic = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { emphasis: 'strong' } } as never),
  );
  assert.equal(emphatic[HEADER].emphasis, 'strong');
  assert.equal(emphatic[TITLE].emphasis, 'normal');
});

test('an inherited density is overridden by the child that declares one', () => {
  const nodes = withNode({ id: HEADER, presentation: { density: 'spacious' } } as never).map((node) =>
    node.id === TITLE ? ({ ...node, presentation: { density: 'compact' } } as AnyNode) : node,
  );
  const resolved = resolvePresentationMap(nodes);
  assert.equal(resolved[TITLE].density, 'compact');
  assert.equal(resolved[TITLE].origins.density, 'node');
});

/** Sections 7 and 58. */
test('a button bound to a destructive action is presented as destructive without being told', () => {
  const resolved = resolvePresentationMap(baseNodes());

  assert.equal(resolved[DROP].role, 'destructive');
  assert.equal(resolved[DROP].origins.role, 'inferred');
  assert.equal(resolved[DROP].uxRole, 'destructive-action');
});

test('an explicit role overrides what the application semantics implied', () => {
  const resolved = resolvePresentationMap(
    withNode({ id: DROP, presentation: { role: 'secondary' } } as never),
  );
  assert.equal(resolved[DROP].role, 'secondary');
  assert.equal(resolved[DROP].origins.role, 'node');
});

test('a button that submits its form becomes the primary action', () => {
  const resolved = resolvePresentationMap(baseNodes());
  assert.equal(resolved[SAVE].uxRole, 'primary-action');
  assert.equal(resolved[SAVE].role, 'primary');
  assert.equal(resolved[SAVE].emphasis, 'strong');
});

test('destructive intent wins over primary placement', () => {
  const resolved = resolvePresentationMap(
    withNode({ id: DROP, presentation: { uxRole: 'primary-action' } } as never),
  );
  assert.equal(resolved[DROP].role, 'destructive');
  assert.equal(resolved[DROP].emphasis, 'strong', 'it is still the emphasised control');
});

/** Section 70: a UX role carries a whole layout, not a single property. */
test('a UX role implies a layout, a gap, an alignment and a wrapping rule', () => {
  const resolved = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { uxRole: 'toolbar' } } as never),
  );
  const toolbar = resolved[HEADER];

  assert.equal(toolbar.uxRole, 'toolbar');
  assert.equal(toolbar.layout.kind, 'horizontal');
  assert.equal(toolbar.layout.align, 'center');
  assert.equal(toolbar.layout.wrap, true);
  assert.equal(toolbar.surface, 'base');
  assert.equal(toolbar.origins['layout.kind'], 'inferred');

  // And it stays inspectable as a toolbar rather than becoming an opaque component.
  assert.equal(uxRoleLayer('toolbar').layout?.kind, 'horizontal');
  assert.equal(toolbar.opaque, false);
});

test('an action group and a form section imply different structure', () => {
  const group = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { uxRole: 'action-group' } } as never),
  )[HEADER];
  assert.equal(group.layout.kind, 'horizontal');
  assert.equal(group.layout.justify, 'end');

  const section = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { uxRole: 'form-section' } } as never),
  )[HEADER];
  assert.equal(section.layout.kind, 'vertical');
});

test('a status role carries a role and an icon of its own', () => {
  const resolved = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { uxRole: 'error-state' } } as never),
  )[HEADER];
  assert.equal(resolved.role, 'destructive');
  assert.equal(resolved.icon, 'error');
});

test('a horizontal layout wraps unless the author refuses', () => {
  const wrapping = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { layout: 'horizontal' } } as never),
  )[HEADER];
  assert.equal(wrapping.layout.wrap, true);

  const rigid = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { layout: { kind: 'horizontal', wrap: false } } } as never),
  )[HEADER];
  assert.equal(rigid.layout.wrap, false);
});

/** Section 16. */
test('responsive overrides resolve per device class on top of the base', () => {
  const resolved = resolvePresentationMap(
    withNode({
      id: HEADER,
      presentation: {
        layout: { kind: 'horizontal', gap: 'large' },
        responsive: { compact: { layout: 'vertical' }, wide: { padding: 'xlarge' } },
      },
    } as never),
  )[HEADER];

  assert.equal(resolved.layout.kind, 'horizontal');
  assert.equal(resolved.responsive.compact?.layout?.kind, 'vertical');
  assert.equal(resolved.responsive.compact?.layout?.gap, 'large', 'the base gap is kept');
  assert.equal(resolved.responsive.compact?.layout?.wrap, false, 'a column does not wrap');
  assert.deepEqual(resolved.responsive.wide?.padding, { horizontal: 'xlarge', vertical: 'xlarge' });
  assert.equal(resolved.origins['responsive.compact'], 'responsive');
  assert.equal(resolved.responsive.regular, undefined, 'nothing is invented for a class not mentioned');
});

test('a grid states its columns semantically', () => {
  const adaptive = resolvePresentationMap(
    withNode({
      id: HEADER,
      presentation: { layout: { kind: 'grid', columns: { mode: 'adaptive', minimum: 'medium' } } },
    } as never),
  )[HEADER];
  assert.deepEqual(adaptive.layout.columns, { mode: 'adaptive', minimum: 'medium' });

  const fixed = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { layout: { kind: 'grid', columns: 3 } } } as never),
  )[HEADER];
  assert.equal(fixed.layout.columns, 3);
});

test('bounded sizing needs no measurement', () => {
  const resolved = resolvePresentationMap(
    withNode({ id: HEADER, presentation: { sizing: { width: 'fill', maxWidth: 'wide' } } } as never),
  )[HEADER];
  assert.equal(resolved.sizing.width, 'fill');
  assert.equal(resolved.sizing.maxWidth, 'wide');
});

/** Sections 32 and 33: a boolean or a date reads better than it prints. */
test('a display of a boolean or a date is formatted by inference', () => {
  const resolved = resolvePresentationMap(baseNodes());
  assert.deepEqual(resolved[DONE].format, { kind: 'boolean' });
  assert.deepEqual(resolved[DUE].format, { kind: 'date' });

  const labelled = resolvePresentationMap(
    withNode({
      id: DONE,
      presentation: { format: { kind: 'boolean', trueLabel: 'Read', falseLabel: 'Unread' } },
    } as never),
  )[DONE];
  assert.deepEqual(labelled.format, { kind: 'boolean', trueLabel: 'Read', falseLabel: 'Unread' });
  assert.equal(labelled.origins.format, 'node');
});

/** Section 79: a 0.4 graph keeps working, and gets better defaults. */
test('the 0.2 spellings of role and density are accepted and normalized', () => {
  const resolved = resolvePresentationMap([
    ...withNode({ id: DROP, presentation: { role: 'danger', density: 'normal' } } as never),
  ])[DROP];
  assert.equal(resolved.role, 'destructive');
  assert.equal(resolved.density, 'comfortable');
});

test("a container's 0.2 layout property is still read", () => {
  const resolved = resolvePresentationMap(
    withNode({ id: HEADER, layout: 'horizontal' } as never),
  )[HEADER];
  assert.equal(resolved.layout.kind, 'horizontal');
  assert.equal(resolved.origins['layout.kind'], 'inferred');
});

/** Section 50: the escape hatch is detectable and understood by nothing. */
test('renderer-specific presentation is reported as opaque', () => {
  const resolved = resolvePresentationMap(
    withNode({
      id: HEADER,
      presentation: { rendererOverrides: { web: { className: 'legacy-panel' } } },
    } as never),
  )[HEADER];
  assert.equal(resolved.opaque, true);
  assert.equal(resolved.rendererOverrides?.web.className, 'legacy-panel');
});

test('resolvePresentation answers for a single node', () => {
  const one = resolvePresentation(DROP, baseNodes());
  assert.equal(one?.role, 'destructive');
  assert.equal(resolvePresentation(ACTION_SAVE, baseNodes()), undefined, 'only UI nodes have presentation');
});

// ------------------------------------------------------------------------ theme

test('a partial theme is completed against the default one', () => {
  const theme = resolveTheme({ name: 'Dense', defaults: { density: 'compact' } });
  assert.equal(theme.name, 'Dense');
  assert.equal(theme.defaults.density, 'compact');
  assert.equal(theme.defaults.emphasis, DEFAULT_THEME.defaults.emphasis);
  assert.equal(theme.spacing.medium, DEFAULT_THEME.spacing.medium);
  assert.deepEqual(theme.colors.light, DEFAULT_THEME.colors.light);
});

test('a theme is data, with no callback anywhere in it', () => {
  const seen: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'function') {
      seen.push(path);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(DEFAULT_THEME, 'theme');
  assert.deepEqual(seen, []);
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_THEME)), DEFAULT_THEME);
});

/** Section 74. */
test('changing the theme changes presentation and nothing else', () => {
  const graph = new ApplicationGraph('t', 'Themed');
  for (const node of baseNodes()) {
    graph.addNode(node as never);
  }
  const before = JSON.stringify(graph.listNodes());

  graph.setTheme({ appearance: 'dark', defaults: { density: 'compact' } });

  assert.equal(JSON.stringify(graph.listNodes()), before, 'not one node changed');
  assert.equal(graph.theme.appearance, 'dark');
  assert.equal(resolvePresentationMap(graph.listNodes(), graph.theme)[HEADER].density, 'compact');
});

test('two themes render the same graph at different densities', () => {
  const nodes = baseNodes();
  const light = resolvePresentationMap(nodes, DEFAULT_THEME);
  const dark = resolvePresentationMap(nodes, COMPACT_DARK_THEME);

  assert.equal(light[FORM].density, 'comfortable');
  assert.equal(dark[FORM].density, 'compact');
  assert.equal(light[FORM].uxRole, dark[FORM].uxRole, 'the UX meaning is identical');
  assert.equal(COMPACT_DARK_THEME.appearance, 'dark');
  assert.equal(COMPACT_DARK_THEME.spacing.medium < DEFAULT_THEME.spacing.medium, true);
});

test('a theme declared on a graph survives serialization', () => {
  const graph = new ApplicationGraph('t', 'Themed');
  graph.addNode({ id: nodeId('state_x'), kind: 'state', valueType: primitiveType('string'), initialValue: '' } as never);
  graph.setTheme({ appearance: 'dark' });

  const restored = ApplicationGraph.deserialize(graph.serialize());
  assert.equal(restored.theme.appearance, 'dark');
  assert.deepEqual(restored.declaredTheme, { appearance: 'dark' });

  graph.setTheme(undefined);
  assert.equal(graph.declaredTheme, undefined);
  assert.equal(graph.theme.appearance, DEFAULT_THEME.appearance);
});

test('unused imports stay honest', () => {
  assert.equal(typeof literal, 'function');
});
