import type { DeviceClass, ResolvedPresentation, ResolvedResponsive, UxRole } from '@cynodia/axiom-core';

/**
 * The web renderer's translation of resolved presentation into class names.
 *
 * The renderer emits semantic classes and nothing else — no inline styles, no computed
 * lengths, no colours. What those classes mean is decided by the generated stylesheet, so
 * the same resolved presentation can drive an entirely different renderer.
 */

function layoutClasses(prefix: string, layout: ResolvedPresentation['layout']): string[] {
  // A `none` token is the absence of the property, not a value to assert. Emitting it
  // would override the component rules that give a control its own metrics.
  const classes = [`axiom-${prefix}layout-${layout.kind}`];
  if (layout.gap !== 'none') {
    classes.push(`axiom-${prefix}gap-${layout.gap}`);
  }
  if (!prefix) {
    classes.push(`axiom-align-${layout.align}`, `axiom-justify-${layout.justify}`);
    classes.push(layout.wrap ? 'axiom-wrap' : 'axiom-nowrap');
    if (layout.columns !== undefined) {
      classes.push(
        typeof layout.columns === 'number'
          ? `axiom-columns-${layout.columns}`
          : `axiom-columns-adaptive-${layout.columns.minimum}`,
      );
    }
  }
  return classes;
}

function sizingClasses(prefix: string, sizing: ResolvedPresentation['sizing']): string[] {
  const classes = [`axiom-${prefix}width-${sizing.width}`];
  if (!prefix) {
    classes.push(`axiom-height-${sizing.height}`);
    if (sizing.minWidth) {
      classes.push(`axiom-minwidth-${sizing.minWidth}`);
    }
    if (sizing.maxWidth) {
      classes.push(`axiom-maxwidth-${sizing.maxWidth}`);
    }
  }
  return classes;
}

function paddingClasses(prefix: string, padding: ResolvedPresentation['padding']): string[] {
  const classes: string[] = [];
  if (padding.horizontal !== 'none') {
    classes.push(`axiom-${prefix}pad-x-${padding.horizontal}`);
  }
  if (padding.vertical !== 'none') {
    classes.push(`axiom-${prefix}pad-y-${padding.vertical}`);
  }
  return classes;
}

function responsiveClasses(device: DeviceClass, override: ResolvedResponsive): string[] {
  const prefix = `${device}-`;
  const classes: string[] = [];
  if (override.hidden) {
    classes.push(`axiom-${prefix}hidden`);
  }
  if (override.layout) {
    classes.push(...layoutClasses(prefix, override.layout));
  }
  if (override.sizing) {
    classes.push(...sizingClasses(prefix, override.sizing));
  }
  if (override.padding) {
    classes.push(...paddingClasses(prefix, override.padding));
  }
  if (override.density) {
    classes.push(`axiom-${prefix}density-${override.density}`);
  }
  return classes;
}

/** Every class a node's resolved presentation implies, in a stable order. */
export function presentationClassList(resolved: ResolvedPresentation | undefined): string[] {
  if (!resolved) {
    return [];
  }
  const classes: string[] = [
    `axiom-density-${resolved.density}`,
    `axiom-emphasis-${resolved.emphasis}`,
    `axiom-surface-${resolved.surface}`,
    `axiom-text-${resolved.textRole}`,
    `axiom-treatment-${resolved.treatment}`,
  ];
  if (resolved.role) {
    classes.push(`axiom-role-${resolved.role}`);
  }
  if (resolved.uxRole) {
    classes.push(`axiom-ux-${resolved.uxRole}`);
  }
  classes.push(...layoutClasses('', resolved.layout));
  classes.push(...sizingClasses('', resolved.sizing));
  classes.push(...paddingClasses('', resolved.padding));
  for (const device of ['compact', 'regular', 'wide'] as DeviceClass[]) {
    const override = resolved.responsive[device];
    if (override) {
      classes.push(...responsiveClasses(device, override));
    }
  }
  // The escape hatch: a renderer-specific class, attached and otherwise not understood.
  const override = resolved.rendererOverrides?.web;
  if (override && typeof override.className === 'string' && override.className.trim()) {
    classes.push('axiom-opaque', ...override.className.trim().split(/\s+/));
  }
  return classes;
}

export function presentationClasses(resolved: ResolvedPresentation | undefined, ...extra: string[]): string {
  return [...extra, ...presentationClassList(resolved)].filter(Boolean).join(' ');
}

/**
 * Landmarks. A UX role that names a region of the page becomes the element that means
 * that region, so assistive technology gets the structure the graph declared.
 */
export function landmarkTag(uxRole: UxRole | undefined): string | undefined {
  switch (uxRole) {
    case 'header-region':
      return 'header';
    case 'footer-region':
      return 'footer';
    case 'navigation-group':
      return 'nav';
    case 'content-region':
      return 'main';
    case 'sidebar':
      return 'aside';
    case 'form-section':
      return 'section';
    default:
      return undefined;
  }
}

/**
 * Headings are real headings, so the document has an outline rather than a set of large
 * words.
 *
 * The element follows the resolved **`headingLevel`**, never the type scale: a value drawn
 * at `display` size with `headingLevel: 'none'` is a `<span>`, which is what a monetary
 * total or a dashboard statistic should be.
 */
export function headingTag(resolved: ResolvedPresentation | undefined): string | undefined {
  const level = resolved?.headingLevel;
  return typeof level === 'number' ? `h${level}` : undefined;
}

/** The ARIA role a UX role implies, where one is warranted. */
export function ariaRoleFor(uxRole: UxRole | undefined): string | undefined {
  switch (uxRole) {
    case 'toolbar':
      return 'toolbar';
    case 'error-state':
      return 'alert';
    case 'warning-state':
    case 'success-state':
    case 'informational-state':
      return 'status';
    default:
      return undefined;
  }
}
