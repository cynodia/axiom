import {
  ALIGNMENTS,
  BOUNDED_SIZES,
  DENSITIES,
  EMPHASIS_LEVELS,
  JUSTIFICATIONS,
  LAYOUT_KINDS,
  PRESENTATION_ROLES,
  SPACING_TOKENS,
  SURFACE_ROLES,
  TEXT_ROLES,
} from '@cynodia/axiom-core';
import type {
  Alignment,
  Appearance,
  BoundedSize,
  Density,
  DeviceClass,
  Justification,
  LayoutKind,
  PresentationRole,
  SemanticColorSet,
  SpacingToken,
  SurfaceRole,
  TextRole,
  Theme,
} from '@cynodia/axiom-core';

/**
 * The web renderer's half of the presentation layer: it turns a theme and the semantic
 * class vocabulary the runtime emits into CSS.
 *
 * Nothing here is reachable from an application graph. A graph says `role: 'destructive'`
 * and `gap: 'medium'`; this file is the only place that decides those are a colour and a
 * length, which is what keeps a second renderer possible.
 */

/** The maximum fixed column count the generated sheet supports. */
const MAX_FIXED_COLUMNS = 6;

const ELEVATION_SHADOWS_LIGHT = [
  'none',
  '0 1px 2px rgba(15, 23, 42, 0.06)',
  '0 10px 28px rgba(15, 23, 42, 0.08)',
  '0 24px 60px rgba(15, 23, 42, 0.14)',
];

const ELEVATION_SHADOWS_DARK = [
  'none',
  '0 1px 2px rgba(0, 0, 0, 0.35)',
  '0 12px 30px rgba(0, 0, 0, 0.45)',
  '0 26px 64px rgba(0, 0, 0, 0.55)',
];

/** Semantic alignment becomes flex/grid alignment here and nowhere else. */
const ALIGN_VALUES: Record<Alignment, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

const JUSTIFY_VALUES: Record<Justification, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  between: 'space-between',
};

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** A spacing token as a density-scaled length. */
function space(token: SpacingToken): string {
  return token === 'none' ? '0px' : `calc(var(--axiom-space-${token}) * var(--axiom-density-scale))`;
}

function colorVariables(colors: SemanticColorSet, shadows: string[]): string[] {
  const lines = Object.entries(colors).map(([role, value]) => `  --axiom-color-${kebab(role)}: ${value};`);
  shadows.forEach((shadow, level) => {
    lines.push(`  --axiom-shadow-${level}: ${shadow};`);
  });
  return lines;
}

function appearanceBlocks(theme: Theme): string {
  const light = colorVariables(theme.colors.light, ELEVATION_SHADOWS_LIGHT).join('\n');
  const dark = colorVariables(theme.colors.dark, ELEVATION_SHADOWS_DARK).join('\n');
  const appearance: Appearance = theme.appearance;

  if (appearance === 'dark') {
    return [`:root {\n  color-scheme: dark;\n${dark}\n}`].join('\n');
  }
  const blocks = [`:root {\n  color-scheme: light;\n${light}\n}`];
  if (appearance === 'system') {
    blocks.push(':root { color-scheme: light dark; }');
    blocks.push(
      `@media (prefers-color-scheme: dark) {\n  :root:not([data-axiom-appearance="light"]) {\n${dark}\n  }\n}`,
    );
  }
  // A host may pin an appearance without the graph changing at all.
  blocks.push(`:root[data-axiom-appearance="dark"] {\n  color-scheme: dark;\n${dark}\n}`);
  blocks.push(`:root[data-axiom-appearance="light"] {\n  color-scheme: light;\n${light}\n}`);
  return blocks.join('\n');
}

function tokenVariables(theme: Theme): string {
  const lines: string[] = [];
  for (const token of SPACING_TOKENS) {
    lines.push(`  --axiom-space-${token}: ${theme.spacing[token]}px;`);
  }
  for (const [token, value] of Object.entries(theme.radius)) {
    lines.push(`  --axiom-radius-${token}: ${value}px;`);
  }
  for (const size of BOUNDED_SIZES) {
    lines.push(`  --axiom-size-${size}: ${theme.sizes[size]}px;`);
  }
  lines.push(`  --axiom-font-family: ${theme.typography.fontFamily};`);
  lines.push(`  --axiom-font-heading: ${theme.typography.headingFamily ?? theme.typography.fontFamily};`);
  lines.push(`  --axiom-font-mono: ${theme.typography.monoFamily};`);
  lines.push('  --axiom-density-scale: 1;');
  lines.push('  --axiom-weight-shift: 0;');
  lines.push(`  --axiom-control-height: ${theme.controls.height.comfortable}px;`);
  lines.push(`  --axiom-control-padding-x: ${theme.controls.paddingX.comfortable}px;`);
  lines.push(`  --axiom-control-radius: var(--axiom-radius-${theme.controls.radius});`);
  lines.push(`  --axiom-control-border: ${theme.controls.borderWidth}px;`);
  lines.push(`  --axiom-focus-width: ${theme.controls.focusWidth}px;`);
  return `:root {\n${lines.join('\n')}\n}`;
}

/** Density is the one property that cascades, so it cascades as CSS variables. */
function densityRules(theme: Theme, prefix = ''): string {
  return DENSITIES.map((density: Density) =>
    [
      `.axiom-${prefix}density-${density} {`,
      `  --axiom-density-scale: ${theme.density[density].scale};`,
      `  --axiom-control-height: ${theme.controls.height[density]}px;`,
      `  --axiom-control-padding-x: ${theme.controls.paddingX[density]}px;`,
      '}',
    ].join('\n'),
  ).join('\n');
}

/**
 * One layout kind, plus how children of that layout interpret their own sizing intent.
 * Sizing has to be scoped to the parent's direction: "fill" means grow along the main
 * axis and stretch across the cross axis, and only the parent knows which is which.
 */
function layoutBlock(cls: string, kind: LayoutKind): string {
  const rules: string[] = [];
  switch (kind) {
    case 'horizontal':
      rules.push(`${cls} { display: flex; flex-direction: row; }`);
      rules.push(`${cls} > .axiom-width-fill { flex: 1 1 0%; min-width: 0; }`);
      rules.push(`${cls} > .axiom-width-fit { flex: 0 1 auto; min-width: 0; }`);
      rules.push(`${cls} > .axiom-width-content { flex: 0 0 auto; }`);
      rules.push(`${cls} > .axiom-height-fill { align-self: stretch; }`);
      break;
    case 'grid':
      rules.push(`${cls} { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--axiom-size-narrow), 1fr)); }`);
      rules.push(`${cls} > * { min-width: 0; }`);
      break;
    case 'stack':
    case 'vertical':
    default:
      rules.push(`${cls} { display: flex; flex-direction: column; }`);
      rules.push(`${cls} > .axiom-width-fill { align-self: stretch; }`);
      rules.push(`${cls} > .axiom-width-fit { align-self: flex-start; max-width: 100%; }`);
      rules.push(`${cls} > .axiom-width-content { align-self: flex-start; }`);
      rules.push(`${cls} > .axiom-height-fill { flex: 1 1 0%; }`);
      break;
  }
  return rules.join('\n');
}

function layoutRules(prefix = ''): string {
  return LAYOUT_KINDS.map((kind) => layoutBlock(`.axiom-${prefix}layout-${kind}`, kind)).join('\n');
}

function spacingRules(prefix = ''): string {
  const rules: string[] = [];
  for (const token of SPACING_TOKENS) {
    rules.push(`.axiom-${prefix}gap-${token} { gap: ${space(token)}; }`);
    rules.push(`.axiom-${prefix}pad-x-${token} { padding-left: ${space(token)}; padding-right: ${space(token)}; }`);
    rules.push(`.axiom-${prefix}pad-y-${token} { padding-top: ${space(token)}; padding-bottom: ${space(token)}; }`);
  }
  return rules.join('\n');
}

function alignmentRules(): string {
  const rules: string[] = [];
  for (const align of ALIGNMENTS) {
    rules.push(`.axiom-align-${align} { align-items: ${ALIGN_VALUES[align]}; }`);
  }
  for (const justify of JUSTIFICATIONS) {
    rules.push(`.axiom-justify-${justify} { justify-content: ${JUSTIFY_VALUES[justify]}; }`);
  }
  rules.push('.axiom-wrap { flex-wrap: wrap; }');
  rules.push('.axiom-nowrap { flex-wrap: nowrap; }');
  return rules.join('\n');
}

function sizingRules(prefix = ''): string {
  const rules: string[] = [];
  for (const size of BOUNDED_SIZES) {
    rules.push(`.axiom-${prefix}width-${size} { flex: 0 0 auto; width: var(--axiom-size-${size}); max-width: 100%; }`);
    rules.push(`.axiom-${prefix}minwidth-${size} { min-width: min(100%, var(--axiom-size-${size})); }`);
    rules.push(`.axiom-${prefix}maxwidth-${size} { max-width: var(--axiom-size-${size}); }`);
  }
  if (!prefix) {
    rules.push('.axiom-height-content { height: auto; }');
  } else {
    // A responsive width override has to be able to undo a bounded base width.
    rules.push(`.axiom-${prefix}width-fill { width: auto; align-self: stretch; flex: 1 1 0%; min-width: 0; }`);
    rules.push(`.axiom-${prefix}width-content { width: auto; flex: 0 0 auto; }`);
    rules.push(`.axiom-${prefix}width-fit { width: auto; flex: 0 1 auto; min-width: 0; }`);
  }
  return rules.join('\n');
}

function columnRules(): string {
  const rules: string[] = [];
  for (let count = 1; count <= MAX_FIXED_COLUMNS; count += 1) {
    rules.push(`.axiom-columns-${count} { grid-template-columns: repeat(${count}, minmax(0, 1fr)); }`);
  }
  for (const size of BOUNDED_SIZES) {
    rules.push(
      `.axiom-columns-adaptive-${size} { grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--axiom-size-${size})), 1fr)); }`,
    );
  }
  return rules.join('\n');
}

function surfaceRules(theme: Theme): string {
  return SURFACE_ROLES.map((role: SurfaceRole) => {
    const style = theme.surfaces[role];
    const background = style.color === 'transparent' ? 'transparent' : `var(--axiom-color-${style.color})`;
    const border =
      style.border === 'none'
        ? 'border: 0;'
        : `border: 1px solid var(--axiom-color-border);${style.border === 'strong' ? ' border-width: 2px;' : ''}`;
    return [
      `.axiom-surface-${role} {`,
      `  background: ${background};`,
      `  ${border}`,
      `  border-radius: var(--axiom-radius-${style.radius});`,
      `  box-shadow: var(--axiom-shadow-${style.elevation});`,
      '}',
    ].join('\n');
  }).join('\n');
}

function typographyRules(theme: Theme): string {
  const rules = TEXT_ROLES.map((role: TextRole) => {
    const style = theme.typography.roles[role];
    const heading = role === 'heading' || role === 'title' || role === 'display';
    return [
      `.axiom-text-${role} {`,
      `  --axiom-font-weight: ${style.weight};`,
      `  font-family: ${heading ? 'var(--axiom-font-heading)' : 'var(--axiom-font-family)'};`,
      `  font-size: ${style.size}px;`,
      '  font-weight: calc(var(--axiom-font-weight) + var(--axiom-weight-shift));',
      `  line-height: ${style.lineHeight};`,
      style.tracking === undefined ? '' : `  letter-spacing: ${style.tracking / 100}em;`,
      style.transform === undefined ? '' : `  text-transform: ${style.transform};`,
      '  margin: 0;',
      '}',
    ]
      .filter(Boolean)
      .join('\n');
  });
  for (const level of EMPHASIS_LEVELS) {
    const emphasis = theme.typography.emphasis[level];
    rules.push(
      `.axiom-emphasis-${level} { --axiom-weight-shift: ${emphasis.weightShift}; opacity: ${emphasis.opacity}; }`,
    );
  }
  rules.push('.axiom-text-label { color: var(--axiom-color-text-muted); }');
  rules.push('.axiom-text-caption { color: var(--axiom-color-text-muted); }');
  return rules.join('\n');
}

/** A filled role: background, its own text colour, no border. */
function filledRole(role: PresentationRole): string {
  const token = kebab(role);
  return `background: var(--axiom-color-${token}); color: var(--axiom-color-${token}-text); border-color: transparent;`;
}

function roleRules(): string {
  const rules: string[] = [];
  rules.push(
    `.axiom-button.axiom-role-primary { background: var(--axiom-color-accent); color: var(--axiom-color-accent-text); border-color: transparent; }`,
  );
  rules.push(
    '.axiom-button.axiom-role-secondary { background: var(--axiom-color-surface); color: var(--axiom-color-text); border-color: var(--axiom-color-border); }',
  );
  rules.push(
    '.axiom-button.axiom-role-tertiary { background: transparent; color: var(--axiom-color-accent); border-color: transparent; }',
  );
  rules.push(
    '.axiom-button.axiom-role-muted { background: var(--axiom-color-muted); color: var(--axiom-color-muted-text); border-color: transparent; }',
  );
  for (const role of ['destructive', 'success', 'warning', 'informational'] as PresentationRole[]) {
    rules.push(`.axiom-button.axiom-role-${role} { ${filledRole(role)} }`);
  }

  // Away from controls, a role tints text and separates a region from its ground.
  for (const role of ['destructive', 'success', 'warning', 'informational'] as PresentationRole[]) {
    const token = kebab(role);
    rules.push(`.axiom-text.axiom-role-${role}, .axiom-field.axiom-role-${role} { color: var(--axiom-color-${token}); }`);
    rules.push(
      `.axiom-container.axiom-role-${role}, .axiom-conditional.axiom-role-${role} {\n` +
        `  border-color: var(--axiom-color-${token});\n` +
        `  background: color-mix(in srgb, var(--axiom-color-${token}) 10%, var(--axiom-color-surface));\n` +
        '}',
    );
    rules.push(`.axiom-role-${role} > .axiom-icon { color: var(--axiom-color-${token}); }`);
  }
  rules.push('.axiom-text.axiom-role-muted, .axiom-field.axiom-role-muted { color: var(--axiom-color-text-muted); }');
  rules.push('.axiom-text.axiom-role-primary { color: var(--axiom-color-accent); }');

  // Badges and pills, so a status value need not be a bare word.
  rules.push(
    [
      '.axiom-treatment-badge > .axiom-field-value,',
      '.axiom-treatment-pill > .axiom-field-value,',
      '.axiom-text.axiom-treatment-badge,',
      '.axiom-text.axiom-treatment-pill {',
      '  display: inline-block;',
      `  padding: 2px ${space('small')};`,
      '  background: var(--axiom-color-muted);',
      '  color: var(--axiom-color-muted-text);',
      '  font-weight: 600;',
      '  white-space: nowrap;',
      '}',
    ].join('\n'),
  );
  rules.push('.axiom-treatment-badge > .axiom-field-value, .axiom-text.axiom-treatment-badge { border-radius: var(--axiom-radius-small); }');
  rules.push('.axiom-treatment-pill > .axiom-field-value, .axiom-text.axiom-treatment-pill { border-radius: var(--axiom-radius-pill); }');
  for (const role of PRESENTATION_ROLES) {
    if (role === 'muted' || role === 'secondary' || role === 'tertiary') {
      continue;
    }
    const token = role === 'primary' ? 'accent' : kebab(role);
    rules.push(
      `.axiom-treatment-badge.axiom-role-${role} > .axiom-field-value,\n` +
        `.axiom-treatment-pill.axiom-role-${role} > .axiom-field-value,\n` +
        `.axiom-text.axiom-treatment-badge.axiom-role-${role},\n` +
        `.axiom-text.axiom-treatment-pill.axiom-role-${role} {\n` +
        `  background: color-mix(in srgb, var(--axiom-color-${token}) 16%, var(--axiom-color-surface));\n` +
        `  color: var(--axiom-color-${token});\n` +
        '}',
    );
  }
  return rules.join('\n');
}

/** Landmarks, controls, forms and the rest of the visual baseline of §55. */
function baselineRules(theme: Theme): string {
  return `
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--axiom-color-background);
  color: var(--axiom-color-text);
  font-family: var(--axiom-font-family);
  font-size: ${theme.typography.roles.body.size}px;
  line-height: ${theme.typography.roles.body.lineHeight};
  -webkit-font-smoothing: antialiased;
}
#app { padding: ${space('large')}; max-width: 1180px; margin: 0 auto; }
.axiom-view { width: 100%; }
.axiom-repeat > * { min-width: 0; }
.axiom-icon { flex: 0 0 auto; font-style: normal; line-height: 1; }

.axiom-field-label { color: var(--axiom-color-text-muted); font-size: ${theme.typography.roles.label.size}px; font-weight: ${theme.typography.roles.label.weight}; }
.axiom-field-value { color: var(--axiom-color-text); }

.axiom-input-label { color: var(--axiom-color-text-muted); font-size: ${theme.typography.roles.label.size}px; font-weight: ${theme.typography.roles.label.weight}; }
.axiom-input-description { color: var(--axiom-color-text-muted); font-size: ${theme.typography.roles.caption.size}px; }
.axiom-required-marker { color: var(--axiom-color-destructive); margin-left: 2px; }

input.axiom-control, select.axiom-control, textarea.axiom-control, .axiom-control {
  font: inherit;
  color: var(--axiom-color-text);
  background: var(--axiom-color-surface);
  border: var(--axiom-control-border) solid var(--axiom-color-border);
  border-radius: var(--axiom-control-radius);
  min-height: var(--axiom-control-height);
  padding: 0 var(--axiom-control-padding-x);
  width: 100%;
}
select.axiom-control { appearance: auto; }
textarea.axiom-control { min-height: calc(var(--axiom-control-height) * 3); padding: ${space('small')} var(--axiom-control-padding-x); resize: vertical; line-height: inherit; }
input[type="checkbox"].axiom-control { width: 1.15em; height: 1.15em; min-height: 0; padding: 0; accent-color: var(--axiom-color-accent); }
.axiom-control-switch { display: inline-flex; align-items: center; gap: ${space('xsmall')}; }
.axiom-radio-group { display: flex; flex-wrap: wrap; gap: ${space('small')}; }
.axiom-radio-option { display: inline-flex; align-items: center; gap: ${space('xsmall')}; }
.axiom-control:disabled { opacity: 0.6; }
.axiom-control[aria-invalid="true"] { border-color: var(--axiom-color-destructive); }

button.axiom-button {
  font: inherit;
  font-weight: 560;
  /* The internal arrangement comes from the theme's button metrics, so no application
     has to restate layout and padding on every control. */
  display: inline-flex;
  flex-direction: ${theme.buttons.layout === 'vertical' ? 'column' : 'row'};
  align-items: ${ALIGN_VALUES[theme.buttons.align]};
  justify-content: ${JUSTIFY_VALUES[theme.buttons.justify]};
  gap: ${space(theme.buttons.gap)};
  min-height: var(--axiom-control-height);
  padding: 0 calc(var(--axiom-control-padding-x) * ${theme.buttons.paddingScale});
  border: var(--axiom-control-border) solid transparent;
  border-radius: var(--axiom-control-radius);
  background: var(--axiom-color-surface);
  color: var(--axiom-color-text);
  cursor: pointer;
  white-space: nowrap;
  text-align: center;
}
button.axiom-button:hover { filter: brightness(0.96); }
button.axiom-button:active { transform: translateY(1px); }
/* A button's own contents are laid out by the theme; a layout token on the node refines
   the direction without giving up the control's metrics. */
button.axiom-button.axiom-layout-vertical { flex-direction: column; }
button.axiom-button.axiom-layout-horizontal { flex-direction: row; }
.axiom-button > .axiom-button-label { white-space: nowrap; }

:focus-visible { outline: var(--axiom-focus-width) solid var(--axiom-color-focus); outline-offset: 1px; }

.axiom-ux-header-region { position: sticky; top: 0; z-index: 5; backdrop-filter: blur(6px); }
.axiom-ux-empty-state { text-align: center; }
.axiom-ux-form-section + .axiom-ux-form-section { padding-top: ${space('small')}; border-top: 1px solid var(--axiom-color-border); }

/*
 * A dialog. The renderer emits the semantics — role, aria-modal, the title relationship — and
 * these are the affordances that make it read as a modal: a backdrop, elevation, centring and
 * a scroll bound. They belong here for the same reason button metrics do: every application
 * would otherwise have to correct the same thing, which is what makes a default a framework's
 * job rather than an author's.
 */
.axiom-dialog {
  position: fixed;
  inset: 0;
  z-index: 100;
  margin: auto;
  width: min(32rem, calc(100vw - ${space('large')} * 2));
  max-height: calc(100vh - ${space('large')} * 2);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: ${space('medium')};
  padding: ${space('large')};
  background: var(--axiom-color-surface-raised);
  color: var(--axiom-color-text);
  border: 1px solid var(--axiom-color-border);
  border-radius: var(--axiom-radius-large);
  box-shadow: var(--axiom-elevation-raised);
}
.axiom-dialog::backdrop { background: rgb(0 0 0 / 0.45); }
.axiom-dialog > .axiom-dialog-title { margin: 0; }
.axiom-dialog > .axiom-dialog-description { margin: 0; color: var(--axiom-color-text-subtle); }

.axiom-diagnostic[data-empty="true"] { display: none; }
.axiom-diagnostic-entry { color: inherit; }
.axiom-no-route { padding: ${space('large')}; background: var(--axiom-color-surface); border-radius: var(--axiom-radius-medium); }
.axiom-diagnostics { list-style: none; margin: 0; padding: 0; }
`.trim();
}

function mediaQuery(theme: Theme, device: DeviceClass): string {
  const responsive = theme.responsive;
  if (device === 'compact') {
    return `@media (max-width: ${responsive.compact.maxWidth}px)`;
  }
  if (device === 'wide') {
    return `@media (min-width: ${responsive.wide.minWidth}px)`;
  }
  return `@media (min-width: ${responsive.regular.minWidth}px) and (max-width: ${responsive.regular.maxWidth}px)`;
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join('\n');
}

/**
 * Responsive behaviour a graph does not have to ask for: rows keep their wrapping, fixed
 * grids give up columns, bounded widths stop being bounded, and controls go full width.
 * An agent should not have to design every breakpoint by hand.
 */
function compactDefaults(): string {
  const rules: string[] = [];
  for (let count = 2; count <= MAX_FIXED_COLUMNS; count += 1) {
    rules.push(`.axiom-columns-${count} { grid-template-columns: minmax(0, 1fr); }`);
  }
  for (const size of BOUNDED_SIZES) {
    rules.push(`.axiom-width-${size} { width: 100%; }`);
    rules.push(`.axiom-maxwidth-${size} { max-width: 100%; }`);
    rules.push(`.axiom-minwidth-${size} { min-width: 0; }`);
  }
  rules.push('.axiom-layout-horizontal.axiom-nowrap { overflow-x: auto; }');
  rules.push('.axiom-button { flex: 1 1 auto; }');
  rules.push('.axiom-ux-action-group { justify-content: stretch; }');
  rules.push('#app { padding: ' + space('medium') + '; }');
  return rules.join('\n');
}

function regularDefaults(): string {
  const rules: string[] = [];
  for (let count = 3; count <= MAX_FIXED_COLUMNS; count += 1) {
    rules.push(`.axiom-columns-${count} { grid-template-columns: repeat(2, minmax(0, 1fr)); }`);
  }
  return rules.join('\n');
}

/** The per-device overrides a graph asks for explicitly. */
function responsiveOverrides(theme: Theme, device: DeviceClass): string {
  const prefix = `${device}-`;
  return [
    layoutRules(prefix),
    spacingRules(prefix),
    sizingRules(prefix),
    densityRules(theme, prefix),
    `.axiom-${prefix}hidden { display: none !important; }`,
  ].join('\n');
}

/**
 * The complete stylesheet for a theme. It is derived entirely from theme data and the
 * semantic class vocabulary, so a different theme is a different sheet and never a
 * different application.
 */
export function createThemeStylesheet(theme: Theme): string {
  const sections: string[] = [
    `/* ${theme.name} (${theme.id}) — generated from theme data; do not edit. */`,
    appearanceBlocks(theme),
    tokenVariables(theme),
    baselineRules(theme),
    densityRules(theme),
    layoutRules(),
    spacingRules(),
    alignmentRules(),
    sizingRules(),
    columnRules(),
    surfaceRules(theme),
    typographyRules(theme),
    roleRules(),
  ];

  for (const device of ['compact', 'regular', 'wide'] as DeviceClass[]) {
    const defaults = device === 'compact' ? compactDefaults() : device === 'regular' ? regularDefaults() : '';
    const body = [defaults, responsiveOverrides(theme, device)].filter(Boolean).join('\n');
    sections.push(`${mediaQuery(theme, device)} {\n${indent(body)}\n}`);
  }

  sections.push('@media (prefers-reduced-motion: reduce) {\n  * { transition: none !important; animation: none !important; }\n}');
  return sections.join('\n\n');
}
