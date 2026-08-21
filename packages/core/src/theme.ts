import type {
  Alignment,
  BoundedSize,
  Density,
  DeviceClass,
  Emphasis,
  IconName,
  Justification,
  LayoutKind,
  SpacingToken,
  SurfaceRole,
  TextRole,
} from './presentation.js';

/**
 * A theme is the translation layer between semantic presentation intent and visual
 * rendering. It is the one place concrete values are allowed to live, because it is not
 * part of the application's semantics: changing it cannot change an action, a constraint,
 * a location, a route or any behaviour at all.
 *
 * A theme is plain data. There are no callbacks anywhere in it, so a complete
 * application — including its visual identity — is representable as JSON.
 */

export type Appearance = 'light' | 'dark' | 'system';

export const APPEARANCES: readonly Appearance[] = ['light', 'dark', 'system'];

export type RadiusToken = 'none' | 'small' | 'medium' | 'large' | 'pill';

export const RADIUS_TOKENS: readonly RadiusToken[] = ['none', 'small', 'medium', 'large', 'pill'];

/**
 * Role-based colours. Application nodes never name a colour; they name a role, and this
 * is where a role becomes a value.
 *
 * Each filled role carries the colour of text drawn on top of it, so contrast is a theme
 * decision rather than something a renderer guesses.
 */
export interface SemanticColorSet {
  background: string;
  surface: string;
  elevated: string;
  inset: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
  destructive: string;
  destructiveText: string;
  warning: string;
  warningText: string;
  success: string;
  successText: string;
  informational: string;
  informationalText: string;
  muted: string;
  mutedText: string;
  focus: string;
}

export const SEMANTIC_COLOR_ROLES: readonly (keyof SemanticColorSet)[] = [
  'background',
  'surface',
  'elevated',
  'inset',
  'text',
  'textMuted',
  'border',
  'accent',
  'accentText',
  'destructive',
  'destructiveText',
  'warning',
  'warningText',
  'success',
  'successText',
  'informational',
  'informationalText',
  'muted',
  'mutedText',
  'focus',
];

export interface TextStyle {
  size: number;
  weight: number;
  lineHeight: number;
  /** Letter spacing, in the same units as `size`. */
  tracking?: number;
  transform?: 'none' | 'uppercase';
}

export interface TypographyTheme {
  fontFamily: string;
  headingFamily?: string;
  monoFamily: string;
  roles: Record<TextRole, TextStyle>;
  /** How emphasis shifts weight and contrast, relative to the text role. */
  emphasis: Record<Emphasis, { weightShift: number; opacity: number }>;
}

/** Which colour a surface is drawn in, and how it is separated from its ground. */
export interface SurfaceStyle {
  color: 'transparent' | 'background' | 'surface' | 'elevated' | 'inset';
  border: 'none' | 'subtle' | 'strong';
  /** 0 is flat; higher values lift the surface further off the page. */
  elevation: 0 | 1 | 2 | 3;
  radius: RadiusToken;
}

/**
 * How an ordinary button is put together internally.
 *
 * These are the affordances every button needs and none should have to restate. An
 * application annotates a button only where it differs from this.
 */
export interface ButtonTheme {
  /** Direction of a button's own contents. Horizontal keeps an icon beside its label. */
  layout: LayoutKind;
  gap: SpacingToken;
  align: Alignment;
  justify: Justification;
  /** Horizontal padding, relative to `controls.paddingX`. */
  paddingScale: number;
  /** Where an icon sits relative to the label. */
  iconPlacement: 'leading' | 'trailing';
}

export interface ControlTheme {
  /** Control height per density. */
  height: Record<Density, number>;
  /** Horizontal padding inside a control, per density. */
  paddingX: Record<Density, number>;
  radius: RadiusToken;
  borderWidth: number;
  focusWidth: number;
}

/** Where each device class begins and ends. Renderers own the actual breakpoints. */
export interface ResponsiveTheme {
  compact: { maxWidth: number };
  regular: { minWidth: number; maxWidth: number };
  wide: { minWidth: number };
}

/** The layer between renderer defaults and the node: application-wide presentation. */
export interface ThemeDefaults {
  density: Density;
  emphasis: Emphasis;
  textRole: TextRole;
  surface: SurfaceRole;
  gap: SpacingToken;
  padding: SpacingToken;
}

export interface Theme {
  id: string;
  name: string;
  appearance: Appearance;
  /** BCP 47 tag used when formatting values. Formatting is presentation, not data. */
  locale: string;
  defaults: ThemeDefaults;
  typography: TypographyTheme;
  spacing: Record<SpacingToken, number>;
  radius: Record<RadiusToken, number>;
  /** Bounded semantic widths, so no node has to name a measurement. */
  sizes: Record<BoundedSize, number>;
  surfaces: Record<SurfaceRole, SurfaceStyle>;
  controls: ControlTheme;
  /** Internal arrangement of an ordinary button. See `ButtonTheme`. */
  buttons: ButtonTheme;
  /** How much the density scales spacing and control metrics. */
  density: Record<Density, { scale: number }>;
  colors: Record<'light' | 'dark', SemanticColorSet>;
  responsive: ResponsiveTheme;
  /** Glyph for each semantic icon. A renderer may substitute its own icon set. */
  icons: Record<IconName, string>;
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** A theme as an author declares it: anything omitted comes from the default theme. */
export type ThemeInput = DeepPartial<Theme>;

/**
 * The default theme: neutral, modern and accessible, meant to make an unannotated graph
 * look intentionally designed rather than like unstyled markup.
 */
export const DEFAULT_THEME: Theme = {
  id: 'axiom-default',
  name: 'Axiom Default',
  appearance: 'system',
  locale: 'en-US',
  defaults: {
    density: 'comfortable',
    emphasis: 'normal',
    textRole: 'body',
    surface: 'transparent',
    gap: 'small',
    padding: 'none',
  },
  typography: {
    fontFamily: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
    monoFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
    roles: {
      display: { size: 32, weight: 700, lineHeight: 1.15, tracking: -0.6 },
      title: { size: 24, weight: 680, lineHeight: 1.2, tracking: -0.3 },
      heading: { size: 17, weight: 620, lineHeight: 1.3 },
      body: { size: 15, weight: 420, lineHeight: 1.5 },
      label: { size: 13, weight: 560, lineHeight: 1.4 },
      caption: { size: 12, weight: 420, lineHeight: 1.4 },
    },
    emphasis: {
      subtle: { weightShift: -40, opacity: 0.68 },
      normal: { weightShift: 0, opacity: 1 },
      strong: { weightShift: 160, opacity: 1 },
    },
  },
  spacing: { none: 0, xsmall: 4, small: 8, medium: 14, large: 22, xlarge: 36 },
  radius: { none: 0, small: 6, medium: 10, large: 16, pill: 999 },
  sizes: { narrow: 260, medium: 440, wide: 760 },
  surfaces: {
    transparent: { color: 'transparent', border: 'none', elevation: 0, radius: 'none' },
    base: { color: 'surface', border: 'subtle', elevation: 0, radius: 'medium' },
    subtle: { color: 'inset', border: 'none', elevation: 0, radius: 'medium' },
    raised: { color: 'elevated', border: 'subtle', elevation: 2, radius: 'large' },
    inset: { color: 'inset', border: 'subtle', elevation: 0, radius: 'small' },
  },
  controls: {
    height: { compact: 32, comfortable: 40, spacious: 48 },
    paddingX: { compact: 10, comfortable: 14, spacious: 18 },
    radius: 'small',
    borderWidth: 1,
    focusWidth: 3,
  },
  buttons: {
    layout: 'horizontal',
    gap: 'xsmall',
    align: 'center',
    justify: 'center',
    paddingScale: 1.15,
    iconPlacement: 'leading',
  },
  density: { compact: { scale: 0.7 }, comfortable: { scale: 1 }, spacious: { scale: 1.35 } },
  colors: {
    light: {
      background: '#f5f7fb',
      surface: '#ffffff',
      elevated: '#ffffff',
      inset: '#f1f5f9',
      text: '#0f172a',
      textMuted: '#5b6b82',
      border: '#e2e8f0',
      accent: '#2f5fe0',
      accentText: '#ffffff',
      destructive: '#c62a20',
      destructiveText: '#ffffff',
      warning: '#96530a',
      warningText: '#ffffff',
      success: '#05663d',
      successText: '#ffffff',
      informational: '#15489f',
      informationalText: '#ffffff',
      muted: '#eef2f7',
      mutedText: '#475569',
      focus: '#8fb0ff',
    },
    dark: {
      background: '#0b1220',
      surface: '#141d2f',
      elevated: '#1b2740',
      inset: '#0f1828',
      text: '#e9eff9',
      textMuted: '#98a8c0',
      border: '#26324a',
      accent: '#7c9dfd',
      accentText: '#0a1120',
      destructive: '#f47a6f',
      destructiveText: '#220906',
      warning: '#f2ad4f',
      warningText: '#231603',
      success: '#5cd396',
      successText: '#03200f',
      informational: '#8dbaff',
      informationalText: '#061327',
      muted: '#1d2840',
      mutedText: '#adbcd4',
      focus: '#4869b8',
    },
  },
  responsive: {
    compact: { maxWidth: 599 },
    regular: { minWidth: 600, maxWidth: 1023 },
    wide: { minWidth: 1024 },
  },
  icons: {
    add: '+',
    delete: '✕',
    edit: '✎',
    save: '✓',
    close: '✕',
    warning: '⚠',
    success: '✓',
    error: '⚠',
    information: 'ℹ',
    'navigation-back': '←',
    'navigation-forward': '→',
    menu: '☰',
    search: '⌕',
    refresh: '⟳',
    settings: '⚙',
    more: '⋯',
  },
};

/**
 * A denser theme, kept here as the second half of the "same graph, different identity"
 * demonstration of §83. It changes nothing but presentation.
 */
export const COMPACT_DARK_THEME: Theme = resolveTheme({
  id: 'axiom-compact-dark',
  name: 'Axiom Compact Dark',
  appearance: 'dark',
  defaults: { density: 'compact', gap: 'xsmall' },
  spacing: { none: 0, xsmall: 3, small: 6, medium: 10, large: 16, xlarge: 24 },
  radius: { none: 0, small: 3, medium: 5, large: 8, pill: 999 },
  typography: {
    roles: {
      display: { size: 26, weight: 700, lineHeight: 1.15 },
      title: { size: 20, weight: 660, lineHeight: 1.2 },
      heading: { size: 15, weight: 620, lineHeight: 1.3 },
      body: { size: 13, weight: 420, lineHeight: 1.45 },
      label: { size: 12, weight: 560, lineHeight: 1.35 },
      caption: { size: 11, weight: 420, lineHeight: 1.35 },
    },
  },
  surfaces: { raised: { radius: 'medium', elevation: 1 } },
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeInto<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) {
    return patch === undefined ? base : (patch as T);
  }
  const result: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    result[key] = isPlainObject(value) && isPlainObject(current) ? mergeInto(current, value) : value;
  }
  return result as T;
}

/**
 * Completes a partial theme against the default one. An author states only what differs,
 * which is how "use a denser enterprise identity" becomes a handful of tokens rather than
 * a rewritten stylesheet.
 */
export function resolveTheme(input?: ThemeInput | Theme): Theme {
  if (!input) {
    return structuredClone(DEFAULT_THEME);
  }
  return mergeInto(structuredClone(DEFAULT_THEME), structuredClone(input));
}

/** The colour set an appearance uses. `system` resolves to light for static emission. */
export function themeColors(theme: Theme, appearance?: Appearance): SemanticColorSet {
  const effective = appearance ?? theme.appearance;
  return effective === 'dark' ? theme.colors.dark : theme.colors.light;
}

/** Spacing in theme units, scaled by density. Density is a multiplier, never a table. */
export function spacingValue(theme: Theme, token: SpacingToken, density: Density): number {
  const base = theme.spacing[token] ?? 0;
  return Math.round(base * (theme.density[density]?.scale ?? 1));
}
