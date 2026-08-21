import type { NodeId } from './ids.js';

/**
 * The presentation and UX vocabulary of 0.5.
 *
 * Everything here describes *intent*, never rendering. `role: 'destructive'` says what a
 * control means; a theme and a renderer decide what that looks like. No entry in this
 * module names a colour, a pixel, a font or a CSS property, and nothing in it can hold a
 * function — presentation stays serializable and analyzable like the rest of the graph.
 */

/** What a control or region *means*. A theme decides how each role is rendered. */
export type PresentationRole =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'destructive'
  | 'success'
  | 'warning'
  | 'informational'
  | 'muted';

export const PRESENTATION_ROLES: readonly PresentationRole[] = [
  'primary',
  'secondary',
  'tertiary',
  'destructive',
  'success',
  'warning',
  'informational',
  'muted',
];

/** 0.2 called the destructive role "danger". It is accepted and normalized, not an error. */
export type LegacyPresentationRole = 'danger';

export type Emphasis = 'subtle' | 'normal' | 'strong';

export const EMPHASIS_LEVELS: readonly Emphasis[] = ['subtle', 'normal', 'strong'];

export type Density = 'compact' | 'comfortable' | 'spacious';

export const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'spacious'];

/** 0.2 called the comfortable density "normal". Accepted and normalized. */
export type LegacyDensity = 'normal';

/** Semantic spacing. A theme maps each token to a renderer value. */
export type SpacingToken = 'none' | 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';

export const SPACING_TOKENS: readonly SpacingToken[] = [
  'none',
  'xsmall',
  'small',
  'medium',
  'large',
  'xlarge',
];

/** How a node relates to the space it is given. */
export type SizingToken = 'fit' | 'fill' | 'content';

/** A bounded semantic size, used where a measurement would otherwise be needed. */
export type BoundedSize = 'narrow' | 'medium' | 'wide';

export type SizingValue = SizingToken | BoundedSize;

export const SIZING_TOKENS: readonly SizingToken[] = ['fit', 'fill', 'content'];

export const BOUNDED_SIZES: readonly BoundedSize[] = ['narrow', 'medium', 'wide'];

export const SIZING_VALUES: readonly SizingValue[] = [...SIZING_TOKENS, ...BOUNDED_SIZES];

export type Alignment = 'start' | 'center' | 'end' | 'stretch';

export const ALIGNMENTS: readonly Alignment[] = ['start', 'center', 'end', 'stretch'];

/** Distribution along the layout direction. `between` spreads the free space out. */
export type Justification = Alignment | 'between';

export const JUSTIFICATIONS: readonly Justification[] = [...ALIGNMENTS, 'between'];

export type LayoutKind = 'vertical' | 'horizontal' | 'grid' | 'stack';

export const LAYOUT_KINDS: readonly LayoutKind[] = ['vertical', 'horizontal', 'grid', 'stack'];

/**
 * Columns of a grid, stated semantically. `adaptive` says "as many columns of at least
 * this width as fit", which is what a responsive card list actually means; a number says
 * exactly how many. Neither form exposes a track template.
 */
export type GridColumns = number | { mode: 'adaptive'; minimum: BoundedSize };

export interface LayoutPresentation {
  kind: LayoutKind;
  gap?: SpacingToken;
  /** Across the layout direction. */
  align?: Alignment;
  /** Along the layout direction. */
  justify?: Justification;
  wrap?: boolean;
  columns?: GridColumns;
}

/** `layout: 'horizontal'` is shorthand for `layout: { kind: 'horizontal' }`. */
export type LayoutIntent = LayoutKind | LayoutPresentation;

export interface SizingPresentation {
  width?: SizingValue;
  height?: SizingValue;
  minWidth?: BoundedSize;
  maxWidth?: BoundedSize;
}

/** `padding: 'medium'` is shorthand for the same amount on every side. */
export type PaddingIntent = SpacingToken | { horizontal?: SpacingToken; vertical?: SpacingToken };

export type SurfaceRole = 'transparent' | 'base' | 'subtle' | 'raised' | 'inset';

export const SURFACE_ROLES: readonly SurfaceRole[] = ['transparent', 'base', 'subtle', 'raised', 'inset'];

/**
 * Semantic text roles. A theme maps each to font metrics; the graph names no sizes.
 *
 * A text role is a **typographic** decision only. Whether the value is a document heading
 * is `headingLevel`, which is separate on purpose: a large monetary total or a dashboard
 * statistic wants `display` type at `headingLevel: 'none'`.
 */
export type TextRole = 'body' | 'caption' | 'label' | 'heading' | 'title' | 'display';

export const TEXT_ROLES: readonly TextRole[] = ['body', 'caption', 'label', 'heading', 'title', 'display'];

/**
 * Where a value sits in the document outline, independently of how large it is drawn.
 * `'none'` means the value is not a heading at all.
 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6 | 'none';

export const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6, 'none'];

/**
 * The outline level a text role implies when nothing says otherwise.
 *
 * This is the 0.5.0 mapping, kept so existing applications do not lose their heading
 * structure. An explicit `headingLevel` always wins.
 */
export const TEXT_ROLE_HEADING_LEVELS: Readonly<Record<TextRole, HeadingLevel>> = {
  display: 1,
  title: 2,
  heading: 3,
  body: 'none',
  caption: 'none',
  label: 'none',
};

/**
 * Why a node exists in the interface. A UX role is high-information: `toolbar` implies a
 * horizontal, wrapping, centre-aligned group, so an author states the role rather than
 * six layout properties. It stays inspectable — nothing compiles it into an opaque
 * component.
 */
export type UxRole =
  | 'primary-action'
  | 'secondary-action'
  | 'destructive-action'
  | 'navigation-action'
  | 'form-section'
  | 'action-group'
  | 'navigation-group'
  | 'empty-state'
  | 'error-state'
  | 'warning-state'
  | 'success-state'
  | 'informational-state'
  | 'toolbar'
  | 'sidebar'
  | 'content-region'
  | 'header-region'
  | 'footer-region';

export const UX_ROLES: readonly UxRole[] = [
  'primary-action',
  'secondary-action',
  'destructive-action',
  'navigation-action',
  'form-section',
  'action-group',
  'navigation-group',
  'empty-state',
  'error-state',
  'warning-state',
  'success-state',
  'informational-state',
  'toolbar',
  'sidebar',
  'content-region',
  'header-region',
  'footer-region',
];

/** UX roles that name an action's place in the hierarchy rather than a region. */
export const ACTION_UX_ROLES: readonly UxRole[] = [
  'primary-action',
  'secondary-action',
  'destructive-action',
  'navigation-action',
];

/** UX roles that report a condition, and which a renderer may announce. */
export const STATUS_UX_ROLES: readonly UxRole[] = [
  'empty-state',
  'error-state',
  'warning-state',
  'success-state',
  'informational-state',
];

/** How a value is presented once it has been formatted. */
export type Treatment = 'plain' | 'badge' | 'pill';

export const TREATMENTS: readonly Treatment[] = ['plain', 'badge', 'pill'];

/**
 * The kind of control a value should be edited with, stated as intent. The renderer maps
 * it onto whatever the platform offers; the graph never names an HTML input type.
 */
export type ControlVariant =
  | 'default'
  | 'switch'
  | 'checkbox'
  | 'radio-group'
  | 'select'
  | 'multiline'
  | 'stepper';

export const CONTROL_VARIANTS: readonly ControlVariant[] = [
  'default',
  'switch',
  'checkbox',
  'radio-group',
  'select',
  'multiline',
  'stepper',
];

/** Semantic icon names. A theme supplies the glyphs; the graph stores no artwork. */
export type IconName =
  | 'add'
  | 'delete'
  | 'edit'
  | 'save'
  | 'close'
  | 'warning'
  | 'success'
  | 'error'
  | 'information'
  | 'navigation-back'
  | 'navigation-forward'
  | 'menu'
  | 'search'
  | 'refresh'
  | 'settings'
  | 'more';

export const ICON_NAMES: readonly IconName[] = [
  'add',
  'delete',
  'edit',
  'save',
  'close',
  'warning',
  'success',
  'error',
  'information',
  'navigation-back',
  'navigation-forward',
  'menu',
  'search',
  'refresh',
  'settings',
  'more',
];

/**
 * Viewport classes, not pixels. An author says what should happen on a compact display;
 * the renderer decides where compact begins.
 */
export type DeviceClass = 'compact' | 'regular' | 'wide';

export const DEVICE_CLASSES: readonly DeviceClass[] = ['compact', 'regular', 'wide'];

export type DateStyle = 'short' | 'medium' | 'long';

/**
 * Structured value formatting. Formatting is presentation: the stored value is unchanged,
 * and there is deliberately no way to supply a function.
 */
export type ValueFormat =
  | { kind: 'text' }
  | { kind: 'number'; decimals?: number; grouping?: boolean }
  | { kind: 'currency'; currency: string; decimals?: number }
  | { kind: 'percentage'; decimals?: number; scale?: 'fraction' | 'percent' }
  | { kind: 'boolean'; trueLabel?: string; falseLabel?: string }
  | { kind: 'date'; style?: DateStyle }
  | { kind: 'datetime'; style?: DateStyle };

export type ValueFormatKind = ValueFormat['kind'];

export const VALUE_FORMAT_KINDS: readonly ValueFormatKind[] = [
  'text',
  'number',
  'currency',
  'percentage',
  'boolean',
  'date',
  'datetime',
];

/** What a device class changes. Anything absent keeps its resolved value. */
export interface ResponsiveOverride {
  layout?: LayoutIntent;
  sizing?: SizingPresentation;
  padding?: PaddingIntent;
  gap?: SpacingToken;
  density?: Density | LegacyDensity;
  hidden?: boolean;
}

export type ResponsivePresentation = Partial<Record<DeviceClass, ResponsiveOverride>>;

/**
 * The escape hatch of §50. It is explicitly keyed by renderer, it is reported by
 * `AgentAPI`, and semantic analysis makes no claim to understand it. Ordinary
 * applications — including every acceptance fixture — use none of it.
 */
export interface RendererOverride {
  /** A renderer-specific class name. The renderer attaches it and nothing else. */
  className?: string;
  [key: string]: unknown;
}

/**
 * Presentation and UX intent attached to a UI node. Every field is optional: defaults,
 * inheritance, semantic inference and the theme are expected to do most of the work, and
 * a graph with no presentation at all still renders as a usable application.
 */
export interface Presentation {
  role?: PresentationRole | LegacyPresentationRole;
  emphasis?: Emphasis;
  density?: Density | LegacyDensity;
  textRole?: TextRole;
  /**
   * The document-outline level, independent of `textRole`. `'none'` renders the value as
   * ordinary text however large it is drawn. Omitted, it is inferred from `textRole` by
   * `TEXT_ROLE_HEADING_LEVELS`.
   */
  headingLevel?: HeadingLevel;
  uxRole?: UxRole;
  surface?: SurfaceRole;
  treatment?: Treatment;
  icon?: IconName;
  /** An accessible name, for a control whose visible label is an icon or is empty. */
  accessibleLabel?: string;
  /** Help text. UX affordance, not business data. */
  description?: string;
  layout?: LayoutIntent;
  sizing?: SizingPresentation;
  padding?: PaddingIntent;
  gap?: SpacingToken;
  format?: ValueFormat;
  control?: ControlVariant;
  responsive?: ResponsivePresentation;
  rendererOverrides?: Record<string, RendererOverride>;
}

/**
 * The 0.2 name for presentation intent. Kept so 0.4 graphs compile unchanged.
 *
 * @deprecated Use `Presentation`.
 */
export type PresentationHints = Presentation;

/**
 * How a confirmation is presented. `ActionDef.requiresConfirmation` already states that a
 * confirmation is required; this states what the person is asked. It carries no browser
 * dialog markup, so a renderer with no dialogs can still present it.
 */
export interface ConfirmationPresentation {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  severity?: 'informational' | 'warning' | 'destructive';
}

// ------------------------------------------------------------------ resolution

/**
 * Which layer of §40 gave a resolved property its value. Recording it is what makes
 * precedence testable instead of a claim in a document.
 */
export type PresentationOrigin =
  | 'renderer-default'
  | 'theme'
  | 'inherited'
  | 'inferred'
  | 'node'
  | 'responsive';

export const PRESENTATION_ORIGINS: readonly PresentationOrigin[] = [
  'renderer-default',
  'theme',
  'inherited',
  'inferred',
  'node',
  'responsive',
];

export interface ResolvedLayout {
  kind: LayoutKind;
  gap: SpacingToken;
  align: Alignment;
  justify: Justification;
  wrap: boolean;
  columns?: GridColumns;
}

export interface ResolvedSizing {
  width: SizingValue;
  height: SizingValue;
  minWidth?: BoundedSize;
  maxWidth?: BoundedSize;
}

export interface ResolvedPadding {
  horizontal: SpacingToken;
  vertical: SpacingToken;
}

export interface ResolvedResponsive {
  layout?: ResolvedLayout;
  sizing?: ResolvedSizing;
  padding?: ResolvedPadding;
  density?: Density;
  hidden?: boolean;
}

/**
 * Presentation with every question answered. The renderer reads this and nothing else,
 * so a renderer needs no knowledge of themes, inheritance or inference.
 */
export interface ResolvedPresentation {
  nodeId: NodeId;
  role?: PresentationRole;
  emphasis: Emphasis;
  density: Density;
  textRole: TextRole;
  /** `'none'` when the value is not part of the document outline. */
  headingLevel: HeadingLevel;
  uxRole?: UxRole;
  surface: SurfaceRole;
  treatment: Treatment;
  icon?: IconName;
  accessibleLabel?: string;
  description?: string;
  layout: ResolvedLayout;
  sizing: ResolvedSizing;
  padding: ResolvedPadding;
  format?: ValueFormat;
  control: ControlVariant;
  responsive: Partial<Record<DeviceClass, ResolvedResponsive>>;
  rendererOverrides?: Record<string, RendererOverride>;
  /** True when the node carries renderer-specific presentation nothing here understands. */
  opaque: boolean;
  /** Property name → the layer that decided it. */
  origins: Record<string, PresentationOrigin>;
}

// --------------------------------------------------------------- normalization

/** Legacy role names, mapped onto the 0.5 vocabulary. */
export function normalizeRole(role: Presentation['role']): PresentationRole | undefined {
  if (role === undefined) {
    return undefined;
  }
  if (role === 'danger') {
    return 'destructive';
  }
  return PRESENTATION_ROLES.includes(role) ? role : undefined;
}

/** Legacy density names, mapped onto the 0.5 vocabulary. */
export function normalizeDensity(density: Presentation['density']): Density | undefined {
  if (density === undefined) {
    return undefined;
  }
  if (density === 'normal') {
    return 'comfortable';
  }
  return DENSITIES.includes(density) ? density : undefined;
}

export function normalizeLayout(layout: LayoutIntent | undefined): LayoutPresentation | undefined {
  if (layout === undefined) {
    return undefined;
  }
  return typeof layout === 'string' ? { kind: layout } : layout;
}

export function normalizePadding(padding: PaddingIntent | undefined): ResolvedPadding | undefined {
  if (padding === undefined) {
    return undefined;
  }
  if (typeof padding === 'string') {
    return { horizontal: padding, vertical: padding };
  }
  if (padding.horizontal === undefined && padding.vertical === undefined) {
    return undefined;
  }
  return { horizontal: padding.horizontal ?? 'none', vertical: padding.vertical ?? 'none' };
}

/** True when a node carries renderer-specific presentation that cannot be analyzed. */
export function hasOpaquePresentation(presentation: Presentation | undefined): boolean {
  const overrides = presentation?.rendererOverrides;
  return Boolean(overrides && Object.keys(overrides).length > 0);
}
