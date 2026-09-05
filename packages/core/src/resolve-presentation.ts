import type { FieldId, NodeId } from './ids.js';
import { actionOperations } from './nodes.js';
import type { ActionDef, EntityDef } from './nodes.js';
import type { AnyNode } from './types.js';
import type { TypeRef } from './type-ref.js';
import { formSubmitActionId, isUINode, uiChildIds } from './ui.js';
import type { UINode } from './ui.js';
import {
  TEXT_ROLE_HEADING_LEVELS,
  normalizeDensity,
  normalizeLayout,
  normalizePadding,
  normalizeRole,
} from './presentation.js';
import type {
  Density,
  DeviceClass,
  HeadingLevel,
  Presentation,
  PresentationOrigin,
  ResolvedLayout,
  ResolvedPadding,
  ResolvedPresentation,
  ResolvedResponsive,
  ResolvedSizing,
  ResponsiveOverride,
  UxRole,
  ValueFormat,
} from './presentation.js';
import { DEFAULT_THEME } from './theme.js';
import type { Theme } from './theme.js';

/**
 * Presentation resolution, §40.
 *
 * Precedence, lowest first:
 *
 *   1. renderer defaults   — a flat baseline that never depends on the node
 *   2. application theme   — `Theme.defaults`, applied application-wide
 *   3. parent/inherited    — density only; see `INHERITED_PROPERTIES`
 *   4. semantic inference  — what the node kind, its UX role and the application
 *                            semantics behind it imply, in that order
 *   5. node presentation   — what the node itself declares
 *   6. responsive override — per device class, on top of everything above
 *
 * Every resolved property records which layer decided it, so the order above is a tested
 * property of the implementation rather than a claim in a document.
 */

/** The only property that cascades from a parent. Nothing else does. */
export const INHERITED_PROPERTIES: readonly string[] = ['density'];

const DEFAULT_LAYOUT: ResolvedLayout = {
  kind: 'vertical',
  gap: 'small',
  align: 'stretch',
  justify: 'start',
  wrap: false,
};

const DEFAULT_SIZING: ResolvedSizing = { width: 'fill', height: 'content' };

const DEFAULT_PADDING: ResolvedPadding = { horizontal: 'none', vertical: 'none' };

/** A layer's contribution: whatever it has an opinion about, and nothing else. */
interface Layer {
  origin: PresentationOrigin;
  role?: ResolvedPresentation['role'];
  emphasis?: ResolvedPresentation['emphasis'];
  density?: Density;
  textRole?: ResolvedPresentation['textRole'];
  headingLevel?: HeadingLevel;
  uxRole?: UxRole;
  surface?: ResolvedPresentation['surface'];
  treatment?: ResolvedPresentation['treatment'];
  icon?: ResolvedPresentation['icon'];
  accessibleLabel?: string;
  description?: string;
  layout?: Partial<ResolvedLayout>;
  sizing?: Partial<ResolvedSizing>;
  padding?: ResolvedPadding;
  format?: ValueFormat;
  control?: ResolvedPresentation['control'];
}

export interface PresentationResolution {
  theme: Theme;
  byNode: Record<NodeId, ResolvedPresentation>;
}

interface Index {
  nodes: Map<NodeId, AnyNode>;
  parentOf: Map<NodeId, NodeId>;
  /** The nearest enclosing form of a UI node, when there is one. */
  formOf: Map<NodeId, NodeId>;
  fieldTypes: Map<FieldId, TypeRef>;
}

function buildIndex(nodes: readonly AnyNode[]): Index {
  const byId = new Map<NodeId, AnyNode>();
  const parentOf = new Map<NodeId, NodeId>();
  const fieldTypes = new Map<FieldId, TypeRef>();

  for (const node of nodes) {
    byId.set(node.id, node);
    if (node.kind === 'entity') {
      for (const field of (node as EntityDef).fields) {
        fieldTypes.set(field.id, field.valueType);
      }
    }
  }
  for (const node of byId.values()) {
    if (!isUINode(node)) {
      continue;
    }
    for (const childId of uiChildIds(node)) {
      if (!parentOf.has(childId)) {
        parentOf.set(childId, node.id);
      }
    }
  }

  const formOf = new Map<NodeId, NodeId>();
  for (const node of byId.values()) {
    if (!isUINode(node)) {
      continue;
    }
    let ancestor = parentOf.get(node.id);
    const seen = new Set<NodeId>([node.id]);
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor);
      if (byId.get(ancestor)?.kind === 'form') {
        formOf.set(node.id, ancestor);
        break;
      }
      ancestor = parentOf.get(ancestor);
    }
  }

  return { nodes: byId, parentOf, formOf, fieldTypes };
}

/**
 * What a node's kind implies, before anything about the application is considered.
 *
 * A control carries its own internal arrangement — a button is a centred row containing an
 * icon and a label, not a bare box. Getting this right here is what stops every
 * application from restating the same corrective layout and padding on every button.
 */
function kindLayer(node: UINode, theme: Theme): Layer {
  switch (node.kind) {
    case 'view':
      return { origin: 'inferred', layout: { kind: 'vertical', gap: 'large' }, sizing: { width: 'fill' } };
    case 'container':
      return {
        origin: 'inferred',
        // `ContainerNode.layout` is the 0.2 spelling of the same intent.
        layout: { kind: node.layout === 'stack' ? 'stack' : node.layout ?? 'vertical' },
        sizing: { width: 'fill' },
      };
    case 'form':
      return {
        origin: 'inferred',
        layout: { kind: 'vertical', gap: 'medium' },
        surface: 'raised',
        padding: { horizontal: 'large', vertical: 'large' },
        sizing: { width: 'fill' },
      };
    case 'repeat':
      return { origin: 'inferred', layout: { kind: 'vertical', gap: 'small' }, sizing: { width: 'fill' } };
    case 'conditional':
      return { origin: 'inferred', layout: { kind: 'vertical', gap: 'medium' }, sizing: { width: 'fill' } };
    case 'diagnostic':
      return { origin: 'inferred', layout: { kind: 'vertical', gap: 'xsmall' }, sizing: { width: 'fill' } };
    case 'field-display':
      return {
        origin: 'inferred',
        layout: { kind: 'horizontal', gap: 'xsmall', align: 'center', wrap: true },
        sizing: { width: 'content' },
      };
    case 'text':
      return { origin: 'inferred', sizing: { width: 'content' } };
    case 'input':
      return { origin: 'inferred', layout: { kind: 'vertical', gap: 'xsmall' }, sizing: { width: 'fill' } };
    case 'button': {
      const buttons = theme.buttons;
      return {
        origin: 'inferred',
        role: 'secondary',
        sizing: { width: 'content' },
        layout: {
          kind: buttons.layout,
          gap: buttons.gap,
          align: buttons.align,
          justify: buttons.justify,
          wrap: false,
        },
        // Control padding comes from the theme's control metrics, not from spacing tokens.
        padding: { horizontal: 'none', vertical: 'none' },
      };
    }
    default:
      return { origin: 'inferred' };
  }
}

/**
 * What a UX role implies. This is the semantic compression of §70: `uxRole: 'toolbar'`
 * carries a layout, a gap, an alignment and a wrapping rule, and stays inspectable as a
 * toolbar rather than becoming an opaque component.
 */
export function uxRoleLayer(uxRole: UxRole): Layer {
  switch (uxRole) {
    case 'primary-action':
      return { origin: 'inferred', role: 'primary', emphasis: 'strong' };
    case 'secondary-action':
      return { origin: 'inferred', role: 'secondary' };
    case 'destructive-action':
      return { origin: 'inferred', role: 'destructive' };
    case 'navigation-action':
      return { origin: 'inferred', role: 'tertiary' };
    case 'toolbar':
      return {
        origin: 'inferred',
        layout: { kind: 'horizontal', gap: 'small', align: 'center', justify: 'start', wrap: true },
        surface: 'base',
        padding: { horizontal: 'small', vertical: 'small' },
        sizing: { width: 'fill' },
      };
    case 'action-group':
      return {
        origin: 'inferred',
        layout: { kind: 'horizontal', gap: 'small', align: 'center', justify: 'end', wrap: true },
        sizing: { width: 'fill' },
      };
    case 'navigation-group':
      return {
        origin: 'inferred',
        layout: { kind: 'horizontal', gap: 'small', align: 'center', justify: 'start', wrap: true },
        sizing: { width: 'fill' },
      };
    case 'form-section':
      return {
        origin: 'inferred',
        layout: { kind: 'vertical', gap: 'small' },
        surface: 'transparent',
        sizing: { width: 'fill' },
      };
    case 'content-region':
      return { origin: 'inferred', layout: { kind: 'vertical', gap: 'large' }, sizing: { width: 'fill' } };
    case 'header-region':
      return {
        origin: 'inferred',
        layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between', wrap: true },
        surface: 'base',
        padding: { horizontal: 'large', vertical: 'medium' },
        sizing: { width: 'fill' },
      };
    case 'footer-region':
      return {
        origin: 'inferred',
        layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'start', wrap: true },
        padding: { horizontal: 'medium', vertical: 'medium' },
        emphasis: 'subtle',
        sizing: { width: 'fill' },
      };
    case 'sidebar':
      return {
        origin: 'inferred',
        layout: { kind: 'vertical', gap: 'small' },
        surface: 'subtle',
        padding: { horizontal: 'medium', vertical: 'medium' },
        sizing: { width: 'fill', maxWidth: 'narrow' },
      };
    case 'empty-state':
      return {
        origin: 'inferred',
        layout: { kind: 'vertical', gap: 'small', align: 'center', justify: 'center' },
        surface: 'subtle',
        padding: { horizontal: 'large', vertical: 'xlarge' },
        emphasis: 'subtle',
        sizing: { width: 'fill' },
      };
    case 'error-state':
      return statusLayer('destructive', 'error');
    case 'warning-state':
      return statusLayer('warning', 'warning');
    case 'success-state':
      return statusLayer('success', 'success');
    case 'informational-state':
      return statusLayer('informational', 'information');
    default:
      return { origin: 'inferred' };
  }
}

function statusLayer(role: NonNullable<ResolvedPresentation['role']>, icon: ResolvedPresentation['icon']): Layer {
  return {
    origin: 'inferred',
    role,
    icon,
    layout: { kind: 'horizontal', gap: 'small', align: 'center', wrap: true },
    surface: 'inset',
    padding: { horizontal: 'medium', vertical: 'small' },
    sizing: { width: 'fill' },
  };
}

/**
 * What the application semantics behind a node imply — §7 and §58. A button bound to a
 * destructive action is presented as destructive without the graph saying so twice.
 */
function semanticLayer(node: UINode, index: Index): Layer {
  if (node.kind === 'diagnostic') {
    // A region that reports a refusal is a status region of the matching severity.
    return {
      origin: 'inferred',
      uxRole: node.severity === 'warning' ? 'warning-state' : 'error-state',
    };
  }
  if (node.kind !== 'button') {
    return { origin: 'inferred' };
  }
  const layer: Layer = { origin: 'inferred' };
  const formId = index.formOf.get(node.id);
  const form = formId ? index.nodes.get(formId) : undefined;
  const submitActionId =
    form && form.kind === 'form'
      ? formSubmitActionId(form, (id) => index.nodes.get(id) as never)
      : undefined;
  if (submitActionId !== undefined && submitActionId === node.actionId) {
    layer.role = 'primary';
    layer.emphasis = 'strong';
    layer.uxRole = 'primary-action';
  }
  const action = index.nodes.get(node.actionId);
  const destructive =
    node.destructive === true ||
    (action?.kind === 'action' && isDestructiveAction(action));
  if (destructive) {
    // Destructive intent is decided last: a destructive primary action is still destructive.
    layer.role = 'destructive';
    layer.uxRole = 'destructive-action';
  }
  return layer;
}

/** Declared destructive intent, or a removal the graph performs. */
export function isDestructiveAction(action: ActionDef): boolean {
  return action.destructive === true || actionOperations(action).some((op) => op.kind === 'remove');
}

/** Boolean and temporal values read better formatted than printed raw — §32, §33. */
function formatLayer(node: UINode, index: Index): Layer {
  if (node.kind !== 'field-display') {
    return { origin: 'inferred' };
  }
  const type = index.fieldTypes.get(node.fieldId);
  const resolved = type?.kind === 'optional' ? type.valueType : type;
  if (resolved?.kind !== 'primitive') {
    return { origin: 'inferred' };
  }
  switch (resolved.primitive) {
    case 'boolean':
      return { origin: 'inferred', format: { kind: 'boolean' } };
    case 'date':
      return { origin: 'inferred', format: { kind: 'date' } };
    case 'datetime':
      return { origin: 'inferred', format: { kind: 'datetime' } };
    default:
      return { origin: 'inferred' };
  }
}

/** The node's own declaration, with legacy spellings normalized. */
function nodeLayer(presentation: Presentation | undefined): Layer {
  const layer: Layer = { origin: 'node' };
  if (!presentation) {
    return layer;
  }
  const role = normalizeRole(presentation.role);
  if (role) {
    layer.role = role;
  }
  const density = normalizeDensity(presentation.density);
  if (density) {
    layer.density = density;
  }
  if (presentation.emphasis) {
    layer.emphasis = presentation.emphasis;
  }
  if (presentation.textRole) {
    layer.textRole = presentation.textRole;
  }
  if (presentation.headingLevel !== undefined) {
    layer.headingLevel = presentation.headingLevel;
  }
  if (presentation.uxRole) {
    layer.uxRole = presentation.uxRole;
  }
  if (presentation.surface) {
    layer.surface = presentation.surface;
  }
  if (presentation.treatment) {
    layer.treatment = presentation.treatment;
  }
  if (presentation.icon) {
    layer.icon = presentation.icon;
  }
  if (presentation.accessibleLabel !== undefined) {
    layer.accessibleLabel = presentation.accessibleLabel;
  }
  if (presentation.description !== undefined) {
    layer.description = presentation.description;
  }
  if (presentation.format) {
    layer.format = presentation.format;
  }
  if (presentation.control) {
    layer.control = presentation.control;
  }
  if (presentation.sizing) {
    layer.sizing = { ...presentation.sizing };
  }
  const padding = normalizePadding(presentation.padding);
  if (padding) {
    layer.padding = padding;
  }
  const layout = normalizeLayout(presentation.layout);
  if (layout || presentation.gap) {
    layer.layout = {
      ...(layout ?? {}),
      ...(presentation.gap && !layout?.gap ? { gap: presentation.gap } : {}),
    };
  }
  return layer;
}

/**
 * A horizontal arrangement wraps unless the author says otherwise: a group of controls
 * that cannot wrap is the most common way a layout becomes unusable on a narrow display.
 */
function wrapDefault(kind: ResolvedLayout['kind']): boolean {
  return kind === 'horizontal' || kind === 'grid';
}

function applyLayers(nodeId: NodeId, layers: Layer[]): ResolvedPresentation {
  const origins: Record<string, PresentationOrigin> = {};
  const resolved: ResolvedPresentation = {
    nodeId,
    emphasis: 'normal',
    density: 'comfortable',
    textRole: 'body',
    headingLevel: 'none',
    surface: 'transparent',
    treatment: 'plain',
    layout: { ...DEFAULT_LAYOUT },
    sizing: { ...DEFAULT_SIZING },
    padding: { ...DEFAULT_PADDING },
    control: 'default',
    responsive: {},
    opaque: false,
    origins,
  };

  const scalarKeys = [
    'role',
    'emphasis',
    'density',
    'textRole',
    'headingLevel',
    'uxRole',
    'surface',
    'treatment',
    'icon',
    'accessibleLabel',
    'description',
    'format',
    'control',
  ] as const;

  let layoutKindDeclared = false;
  let wrapDeclared = false;

  for (const layer of layers) {
    for (const key of scalarKeys) {
      const value = layer[key];
      if (value === undefined) {
        continue;
      }
      (resolved as unknown as Record<string, unknown>)[key] = value;
      origins[key] = layer.origin;
    }
    if (layer.layout) {
      for (const [key, value] of Object.entries(layer.layout)) {
        if (value === undefined) {
          continue;
        }
        (resolved.layout as unknown as Record<string, unknown>)[key] = value;
        origins[`layout.${key}`] = layer.origin;
        if (key === 'kind') {
          layoutKindDeclared = true;
        }
        if (key === 'wrap') {
          wrapDeclared = true;
        }
      }
      // A newly chosen direction brings its own wrapping default with it.
      if (layer.layout.kind !== undefined && layer.layout.wrap === undefined && !wrapDeclared) {
        resolved.layout.wrap = wrapDefault(layer.layout.kind);
        origins['layout.wrap'] = layer.origin;
      }
    }
    if (layer.sizing) {
      for (const [key, value] of Object.entries(layer.sizing)) {
        if (value === undefined) {
          continue;
        }
        (resolved.sizing as unknown as Record<string, unknown>)[key] = value;
        origins[`sizing.${key}`] = layer.origin;
      }
    }
    if (layer.padding) {
      resolved.padding = { ...layer.padding };
      origins.padding = layer.origin;
    }
  }

  // The outline level follows the type scale unless something stated it. This is the
  // 0.5.0 mapping, kept so an existing application does not lose its heading structure.
  if (origins.headingLevel === undefined) {
    resolved.headingLevel = TEXT_ROLE_HEADING_LEVELS[resolved.textRole];
    if (resolved.headingLevel !== 'none') {
      origins.headingLevel = 'inferred';
    }
  }

  // Anything no layer had an opinion about came from the renderer's own baseline.
  void layoutKindDeclared;
  const record = (key: string, value: unknown): void => {
    if (value !== undefined && origins[key] === undefined) {
      origins[key] = 'renderer-default';
    }
  };
  for (const key of scalarKeys) {
    record(key, resolved[key]);
  }
  record('padding', resolved.padding);
  for (const [key, value] of Object.entries(resolved.layout)) {
    record(`layout.${key}`, value);
  }
  for (const [key, value] of Object.entries(resolved.sizing)) {
    record(`sizing.${key}`, value);
  }
  return resolved;
}

function themeLayer(theme: Theme): Layer {
  return {
    origin: 'theme',
    density: theme.defaults.density,
    emphasis: theme.defaults.emphasis,
    textRole: theme.defaults.textRole,
    surface: theme.defaults.surface,
    layout: { gap: theme.defaults.gap },
    padding: { horizontal: theme.defaults.padding, vertical: theme.defaults.padding },
  };
}

/**
 * Density is the one property that cascades. It is taken from the parent only when the
 * parent's own density was actually decided by something — otherwise the child keeps the
 * same baseline the parent had, and reports the same origin for it.
 */
function inheritedLayer(parent: ResolvedPresentation | undefined): Layer | undefined {
  if (!parent) {
    return undefined;
  }
  const origin = parent.origins.density;
  const decided = origin === 'node' || origin === 'inferred' || origin === 'inherited' || origin === 'responsive';
  return { origin: decided ? 'inherited' : origin ?? 'renderer-default', density: parent.density };
}

function resolveResponsive(
  base: ResolvedPresentation,
  overrides: Presentation['responsive'],
): Partial<Record<DeviceClass, ResolvedResponsive>> {
  const resolved: Partial<Record<DeviceClass, ResolvedResponsive>> = {};
  for (const [device, override] of Object.entries(overrides ?? {}) as [DeviceClass, ResponsiveOverride][]) {
    if (!override) {
      continue;
    }
    const entry: ResolvedResponsive = {};
    const layout = normalizeLayout(override.layout);
    if (layout || override.gap) {
      const kind = layout?.kind ?? base.layout.kind;
      entry.layout = {
        ...base.layout,
        ...(layout?.kind !== undefined && layout.wrap === undefined ? { wrap: wrapDefault(kind) } : {}),
        ...layout,
        ...(override.gap && !layout?.gap ? { gap: override.gap } : {}),
      };
    }
    if (override.sizing) {
      entry.sizing = { ...base.sizing, ...override.sizing };
    }
    const padding = normalizePadding(override.padding);
    if (padding) {
      entry.padding = padding;
    }
    const density = normalizeDensity(override.density);
    if (density) {
      entry.density = density;
    }
    if (override.hidden !== undefined) {
      entry.hidden = override.hidden;
    }
    resolved[device] = entry;
  }
  return resolved;
}

/**
 * Resolves presentation for every UI node in a set of nodes. Resolution runs top-down so
 * a child always sees its parent's answer, and unreachable nodes still resolve — with no
 * parent to inherit from.
 */
export function resolvePresentationMap(
  nodes: readonly AnyNode[],
  theme: Theme = DEFAULT_THEME,
): Record<NodeId, ResolvedPresentation> {
  const index = buildIndex(nodes);
  const byNode: Record<NodeId, ResolvedPresentation> = {};
  const inProgress = new Set<NodeId>();

  const resolve = (id: NodeId): ResolvedPresentation | undefined => {
    const existing = byNode[id];
    if (existing) {
      return existing;
    }
    const node = index.nodes.get(id);
    if (!node || !isUINode(node)) {
      return undefined;
    }
    if (inProgress.has(id)) {
      // Containment cycles are rejected by validation; resolution refuses to hang on one.
      return undefined;
    }
    inProgress.add(id);
    const parentId = index.parentOf.get(id);
    const parent = parentId ? resolve(parentId) : undefined;
    inProgress.delete(id);

    const declared = node.presentation;
    const layers: Layer[] = [themeLayer(theme)];
    const inherited = inheritedLayer(parent);
    if (inherited) {
      layers.push(inherited);
    }
    layers.push(kindLayer(node, theme));
    const uxRole = declared?.uxRole ?? semanticLayer(node, index).uxRole;
    if (uxRole) {
      layers.push(uxRoleLayer(uxRole));
    }
    layers.push(semanticLayer(node, index));
    layers.push(formatLayer(node, index));
    layers.push(nodeLayer(declared));

    const resolved = applyLayers(id, layers);
    resolved.responsive = resolveResponsive(resolved, declared?.responsive);
    for (const device of Object.keys(resolved.responsive)) {
      resolved.origins[`responsive.${device}`] = 'responsive';
    }
    if (declared?.rendererOverrides && Object.keys(declared.rendererOverrides).length > 0) {
      resolved.rendererOverrides = structuredClone(declared.rendererOverrides);
      resolved.opaque = true;
    }
    byNode[id] = resolved;
    return resolved;
  };

  for (const node of index.nodes.values()) {
    if (isUINode(node)) {
      resolve(node.id);
    }
  }
  return byNode;
}

/** The resolved presentation of one node, for callers that hold a whole node set. */
export function resolvePresentation(
  nodeId: NodeId,
  nodes: readonly AnyNode[],
  theme: Theme = DEFAULT_THEME,
): ResolvedPresentation | undefined {
  return resolvePresentationMap(nodes, theme)[nodeId];
}
