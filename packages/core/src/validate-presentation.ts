import { VALIDATION_CODES } from './diagnostics.js';
import type { ValidationIssue } from './diagnostics.js';
import type { NodeId } from './ids.js';
import type { ActionDef } from './nodes.js';
import {
  ALIGNMENTS,
  BOUNDED_SIZES,
  CONTROL_VARIANTS,
  DENSITIES,
  DEVICE_CLASSES,
  EMPHASIS_LEVELS,
  ICON_NAMES,
  JUSTIFICATIONS,
  LAYOUT_KINDS,
  PRESENTATION_ROLES,
  SIZING_VALUES,
  SPACING_TOKENS,
  SURFACE_ROLES,
  TEXT_ROLES,
  TREATMENTS,
  UX_ROLES,
  VALUE_FORMAT_KINDS,
} from './presentation.js';
import type { Presentation, ResolvedPresentation } from './presentation.js';
import { isDestructiveAction } from './resolve-presentation.js';
import { APPEARANCES, RADIUS_TOKENS, SEMANTIC_COLOR_ROLES } from './theme.js';
import type { ThemeInput } from './theme.js';
import type { AnyNode } from './types.js';
import { isUINode, uiChildIds } from './ui.js';
import type { UINode } from './ui.js';

/**
 * Presentation validation, §36–§38 and §73.
 *
 * An unknown token is an error: a renderer cannot act on a value that is not in the
 * vocabulary, and quietly ignoring it is exactly the kind of silent semantic failure
 * Axiom forbids. Everything else here is a warning — a UX judgement is advice, not a rule that
 * may stop an application from compiling.
 */

interface Bag {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** More than this many controls side by side stops being a group and becomes a wall. */
const HORIZONTAL_ACTION_LIMIT = 5;

/** Below this a non-wrapping row is not yet a responsive problem. */
const RIGID_ROW_LIMIT = 3;

const PRESENTATION_KEYS = [
  'role',
  'emphasis',
  'density',
  'textRole',
  'uxRole',
  'surface',
  'treatment',
  'icon',
  'accessibleLabel',
  'description',
  'layout',
  'sizing',
  'padding',
  'gap',
  'format',
  'control',
  'responsive',
  'rendererOverrides',
];

const LAYOUT_KEYS = ['kind', 'gap', 'align', 'justify', 'wrap', 'columns'];
const SIZING_KEYS = ['width', 'height', 'minWidth', 'maxWidth'];
const RESPONSIVE_KEYS = ['layout', 'sizing', 'padding', 'gap', 'density', 'hidden'];

const FORMAT_KEYS: Record<string, string[]> = {
  text: [],
  number: ['decimals', 'grouping'],
  currency: ['currency', 'decimals'],
  percentage: ['decimals', 'scale'],
  boolean: ['trueLabel', 'falseLabel'],
  date: ['style'],
  datetime: ['style'],
};

/** Legacy spellings accepted by `normalizeRole` / `normalizeDensity`. */
const ACCEPTED_ROLES = [...PRESENTATION_ROLES, 'danger'];
const ACCEPTED_DENSITIES = [...DENSITIES, 'normal'];

function unknown(bag: Bag, nodeId: NodeId | undefined, path: string, value: unknown, allowed: readonly string[]): void {
  bag.errors.push({
    code: VALIDATION_CODES.unknownPresentationToken,
    message: `${path} is "${String(value)}", which is not a presentation token. Expected one of: ${allowed.join(', ')}.`,
    ...(nodeId ? { nodeId } : {}),
    path,
    details: { value, allowed: [...allowed] },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkToken(
  bag: Bag,
  nodeId: NodeId | undefined,
  path: string,
  value: unknown,
  allowed: readonly string[],
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    unknown(bag, nodeId, path, value, allowed);
  }
}

function checkKeys(
  bag: Bag,
  nodeId: NodeId | undefined,
  path: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      unknown(bag, nodeId, `${path}.${key}`, key, allowed);
    }
  }
}

function checkLayout(bag: Bag, nodeId: NodeId | undefined, path: string, layout: unknown): void {
  if (typeof layout === 'string') {
    checkToken(bag, nodeId, path, layout, LAYOUT_KINDS);
    return;
  }
  if (!isRecord(layout)) {
    unknown(bag, nodeId, path, layout, LAYOUT_KINDS);
    return;
  }
  checkKeys(bag, nodeId, path, layout, LAYOUT_KEYS);
  checkToken(bag, nodeId, `${path}.kind`, layout.kind, LAYOUT_KINDS);
  checkToken(bag, nodeId, `${path}.gap`, layout.gap, SPACING_TOKENS);
  checkToken(bag, nodeId, `${path}.align`, layout.align, ALIGNMENTS);
  checkToken(bag, nodeId, `${path}.justify`, layout.justify, JUSTIFICATIONS);
  if (layout.wrap !== undefined && typeof layout.wrap !== 'boolean') {
    unknown(bag, nodeId, `${path}.wrap`, layout.wrap, ['true', 'false']);
  }
  const columns = layout.columns;
  if (columns !== undefined) {
    if (typeof columns === 'number') {
      if (!Number.isInteger(columns) || columns < 1) {
        unknown(bag, nodeId, `${path}.columns`, columns, ['a positive whole number', 'adaptive']);
      }
    } else if (isRecord(columns)) {
      checkKeys(bag, nodeId, `${path}.columns`, columns, ['mode', 'minimum']);
      checkToken(bag, nodeId, `${path}.columns.mode`, columns.mode, ['adaptive']);
      checkToken(bag, nodeId, `${path}.columns.minimum`, columns.minimum, BOUNDED_SIZES);
    } else {
      unknown(bag, nodeId, `${path}.columns`, columns, ['a positive whole number', 'adaptive']);
    }
  }
}

function checkSizing(bag: Bag, nodeId: NodeId | undefined, path: string, sizing: unknown): void {
  if (!isRecord(sizing)) {
    unknown(bag, nodeId, path, sizing, SIZING_KEYS);
    return;
  }
  checkKeys(bag, nodeId, path, sizing, SIZING_KEYS);
  checkToken(bag, nodeId, `${path}.width`, sizing.width, SIZING_VALUES);
  checkToken(bag, nodeId, `${path}.height`, sizing.height, SIZING_VALUES);
  checkToken(bag, nodeId, `${path}.minWidth`, sizing.minWidth, BOUNDED_SIZES);
  checkToken(bag, nodeId, `${path}.maxWidth`, sizing.maxWidth, BOUNDED_SIZES);
}

function checkPadding(bag: Bag, nodeId: NodeId | undefined, path: string, padding: unknown): void {
  if (padding === undefined) {
    return;
  }
  if (typeof padding === 'string') {
    checkToken(bag, nodeId, path, padding, SPACING_TOKENS);
    return;
  }
  if (!isRecord(padding)) {
    unknown(bag, nodeId, path, padding, SPACING_TOKENS);
    return;
  }
  checkKeys(bag, nodeId, path, padding, ['horizontal', 'vertical']);
  checkToken(bag, nodeId, `${path}.horizontal`, padding.horizontal, SPACING_TOKENS);
  checkToken(bag, nodeId, `${path}.vertical`, padding.vertical, SPACING_TOKENS);
}

function checkFormat(bag: Bag, nodeId: NodeId | undefined, path: string, format: unknown): void {
  if (format === undefined) {
    return;
  }
  if (!isRecord(format) || typeof format.kind !== 'string' || !VALUE_FORMAT_KINDS.includes(format.kind as never)) {
    unknown(bag, nodeId, `${path}.kind`, isRecord(format) ? format.kind : format, VALUE_FORMAT_KINDS);
    return;
  }
  checkKeys(bag, nodeId, path, format, ['kind', ...FORMAT_KEYS[format.kind]]);
  if (format.kind === 'currency' && typeof format.currency !== 'string') {
    bag.errors.push({
      code: VALIDATION_CODES.unknownPresentationToken,
      message: `${path} formats a currency but names none`,
      ...(nodeId ? { nodeId } : {}),
      path,
      details: { kind: 'currency' },
    });
  }
}

/** Every token a node declares, checked against the vocabulary. */
function checkPresentationTokens(bag: Bag, nodeId: NodeId, presentation: Presentation): void {
  const declared = presentation as unknown as Record<string, unknown>;
  const path = 'presentation';
  checkKeys(bag, nodeId, path, declared, PRESENTATION_KEYS);
  checkToken(bag, nodeId, `${path}.role`, declared.role, ACCEPTED_ROLES);
  checkToken(bag, nodeId, `${path}.emphasis`, declared.emphasis, EMPHASIS_LEVELS);
  checkToken(bag, nodeId, `${path}.density`, declared.density, ACCEPTED_DENSITIES);
  checkToken(bag, nodeId, `${path}.textRole`, declared.textRole, TEXT_ROLES);
  checkToken(bag, nodeId, `${path}.uxRole`, declared.uxRole, UX_ROLES);
  checkToken(bag, nodeId, `${path}.surface`, declared.surface, SURFACE_ROLES);
  checkToken(bag, nodeId, `${path}.treatment`, declared.treatment, TREATMENTS);
  checkToken(bag, nodeId, `${path}.icon`, declared.icon, ICON_NAMES);
  checkToken(bag, nodeId, `${path}.gap`, declared.gap, SPACING_TOKENS);
  checkToken(bag, nodeId, `${path}.control`, declared.control, CONTROL_VARIANTS);
  if (declared.layout !== undefined) {
    checkLayout(bag, nodeId, `${path}.layout`, declared.layout);
  }
  if (declared.sizing !== undefined) {
    checkSizing(bag, nodeId, `${path}.sizing`, declared.sizing);
  }
  checkPadding(bag, nodeId, `${path}.padding`, declared.padding);
  checkFormat(bag, nodeId, `${path}.format`, declared.format);

  const responsive = declared.responsive;
  if (responsive !== undefined) {
    if (!isRecord(responsive)) {
      unknown(bag, nodeId, `${path}.responsive`, responsive, DEVICE_CLASSES);
      return;
    }
    checkKeys(bag, nodeId, `${path}.responsive`, responsive, DEVICE_CLASSES);
    for (const [device, override] of Object.entries(responsive)) {
      if (!isRecord(override)) {
        continue;
      }
      const devicePath = `${path}.responsive.${device}`;
      checkKeys(bag, nodeId, devicePath, override, RESPONSIVE_KEYS);
      if (override.layout !== undefined) {
        checkLayout(bag, nodeId, `${devicePath}.layout`, override.layout);
      }
      if (override.sizing !== undefined) {
        checkSizing(bag, nodeId, `${devicePath}.sizing`, override.sizing);
      }
      checkPadding(bag, nodeId, `${devicePath}.padding`, override.padding);
      checkToken(bag, nodeId, `${devicePath}.gap`, override.gap, SPACING_TOKENS);
      checkToken(bag, nodeId, `${devicePath}.density`, override.density, ACCEPTED_DENSITIES);
    }
  }
}

/** A theme may carry concrete values, but only under keys the vocabulary defines. */
function checkTheme(bag: Bag, theme: ThemeInput | undefined): void {
  if (!theme) {
    return;
  }
  const declared = theme as unknown as Record<string, unknown>;
  checkKeys(bag, undefined, 'theme', declared, [
    'id',
    'name',
    'appearance',
    'locale',
    'defaults',
    'typography',
    'spacing',
    'radius',
    'sizes',
    'surfaces',
    'controls',
    'density',
    'colors',
    'responsive',
    'icons',
  ]);
  checkToken(bag, undefined, 'theme.appearance', declared.appearance, APPEARANCES);
  if (isRecord(declared.defaults)) {
    const defaults = declared.defaults;
    checkKeys(bag, undefined, 'theme.defaults', defaults, [
      'density',
      'emphasis',
      'textRole',
      'surface',
      'gap',
      'padding',
    ]);
    checkToken(bag, undefined, 'theme.defaults.density', defaults.density, ACCEPTED_DENSITIES);
    checkToken(bag, undefined, 'theme.defaults.emphasis', defaults.emphasis, EMPHASIS_LEVELS);
    checkToken(bag, undefined, 'theme.defaults.textRole', defaults.textRole, TEXT_ROLES);
    checkToken(bag, undefined, 'theme.defaults.surface', defaults.surface, SURFACE_ROLES);
    checkToken(bag, undefined, 'theme.defaults.gap', defaults.gap, SPACING_TOKENS);
    checkToken(bag, undefined, 'theme.defaults.padding', defaults.padding, SPACING_TOKENS);
  }
  const tables: Array<[string, readonly string[]]> = [
    ['spacing', SPACING_TOKENS],
    ['radius', RADIUS_TOKENS],
    ['sizes', BOUNDED_SIZES],
    ['surfaces', SURFACE_ROLES],
    ['density', DENSITIES],
    ['icons', ICON_NAMES],
  ];
  for (const [key, allowed] of tables) {
    if (isRecord(declared[key])) {
      checkKeys(bag, undefined, `theme.${key}`, declared[key], allowed);
    }
  }
  if (isRecord(declared.colors)) {
    checkKeys(bag, undefined, 'theme.colors', declared.colors, ['light', 'dark']);
    for (const [appearance, set] of Object.entries(declared.colors)) {
      if (isRecord(set)) {
        checkKeys(bag, undefined, `theme.colors.${appearance}`, set, SEMANTIC_COLOR_ROLES as string[]);
      }
    }
  }
  if (isRecord(declared.typography)) {
    checkKeys(bag, undefined, 'theme.typography', declared.typography, [
      'fontFamily',
      'headingFamily',
      'monoFamily',
      'roles',
      'emphasis',
    ]);
    if (isRecord(declared.typography.roles)) {
      checkKeys(bag, undefined, 'theme.typography.roles', declared.typography.roles, TEXT_ROLES);
    }
    if (isRecord(declared.typography.emphasis)) {
      checkKeys(bag, undefined, 'theme.typography.emphasis', declared.typography.emphasis, EMPHASIS_LEVELS);
    }
  }
  if (isRecord(declared.responsive)) {
    checkKeys(bag, undefined, 'theme.responsive', declared.responsive, DEVICE_CLASSES);
  }
}

interface Index {
  nodes: Map<NodeId, AnyNode>;
  children: Map<NodeId, NodeId[]>;
}

function buildIndex(nodes: readonly AnyNode[]): Index {
  const byId = new Map<NodeId, AnyNode>();
  const children = new Map<NodeId, NodeId[]>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }
  for (const node of byId.values()) {
    if (isUINode(node)) {
      children.set(node.id, uiChildIds(node));
    }
  }
  return { nodes: byId, children };
}

function descendants(index: Index, id: NodeId): UINode[] {
  const found: UINode[] = [];
  const seen = new Set<NodeId>([id]);
  const visit = (current: NodeId): void => {
    for (const childId of index.children.get(current) ?? []) {
      if (seen.has(childId)) {
        continue;
      }
      seen.add(childId);
      const child = index.nodes.get(childId);
      if (child && isUINode(child)) {
        found.push(child);
        visit(childId);
      }
    }
  };
  visit(id);
  return found;
}

function directChildren(index: Index, id: NodeId): UINode[] {
  return (index.children.get(id) ?? [])
    .map((childId) => index.nodes.get(childId))
    .filter((node): node is UINode => Boolean(node) && isUINode(node as AnyNode));
}

/** Accessible name of a control, from whatever the graph offers. */
function hasAccessibleName(node: UINode): boolean {
  if (node.presentation?.accessibleLabel?.trim()) {
    return true;
  }
  if (node.kind === 'button') {
    return typeof node.label === 'string' ? node.label.trim().length > 0 : true;
  }
  if (node.kind === 'input') {
    return Boolean(node.label?.trim());
  }
  return true;
}

/**
 * Checks presentation and UX intent. It never rejects an application over a matter of
 * taste: only a token outside the vocabulary is an error.
 */
export function validatePresentation(
  nodes: readonly AnyNode[],
  theme: ThemeInput | undefined,
  resolved: Record<NodeId, ResolvedPresentation>,
): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const bag: Bag = { errors: [], warnings: [] };
  const index = buildIndex(nodes);

  checkTheme(bag, theme);

  const actions = new Map<NodeId, ActionDef>();
  for (const node of index.nodes.values()) {
    if (node.kind === 'action') {
      actions.set(node.id, node);
    }
  }

  for (const node of index.nodes.values()) {
    if (!isUINode(node)) {
      continue;
    }
    const declared = node.presentation;
    const view = resolved[node.id];
    if (declared) {
      checkPresentationTokens(bag, node.id, declared);
    }
    if (!view) {
      continue;
    }

    if (view.opaque) {
      bag.warnings.push({
        code: VALIDATION_CODES.opaquePresentation,
        message: `${node.name ?? node.id} carries renderer-specific presentation that cannot be analyzed semantically`,
        nodeId: node.id,
        details: { renderers: Object.keys(view.rendererOverrides ?? {}) },
      });
    }

    checkSizingConflict(bag, node, view);
    checkRigidLayout(bag, index, node, view);
    checkAccessibleName(bag, node);
    checkDestructive(bag, node, view, actions);
    checkEmptyState(bag, index, node, view);
  }

  checkPrimaryActions(bag, index, resolved);
  checkHeadingStructure(bag, index, resolved);
  checkUnmarkedDestructiveActions(bag, index, actions);

  return bag;
}

function checkSizingConflict(bag: Bag, node: UINode, view: ResolvedPresentation): void {
  const { minWidth, maxWidth } = view.sizing;
  if (!minWidth || !maxWidth) {
    return;
  }
  if (BOUNDED_SIZES.indexOf(minWidth) > BOUNDED_SIZES.indexOf(maxWidth)) {
    bag.warnings.push({
      code: VALIDATION_CODES.conflictingSizing,
      message: `${node.name ?? node.id} asks for a minimum width of ${minWidth} and a maximum of ${maxWidth}`,
      nodeId: node.id,
      details: { minWidth, maxWidth },
    });
  }
}

function checkRigidLayout(bag: Bag, index: Index, node: UINode, view: ResolvedPresentation): void {
  const children = directChildren(index, node.id);
  const interactive = children.filter((child) => child.kind === 'button').length;

  if (view.layout.kind === 'horizontal' && interactive > HORIZONTAL_ACTION_LIMIT) {
    bag.warnings.push({
      code: VALIDATION_CODES.excessiveHorizontalActions,
      message: `${node.name ?? node.id} places ${interactive} controls side by side`,
      nodeId: node.id,
      details: { controls: interactive, limit: HORIZONTAL_ACTION_LIMIT },
    });
  }

  const declaredLayout = node.presentation?.layout;
  const declaresNoWrap = typeof declaredLayout === 'object' && declaredLayout.wrap === false;
  const hasCompactBehaviour = node.presentation?.responsive?.compact !== undefined;
  if (
    declaresNoWrap &&
    view.layout.kind === 'horizontal' &&
    children.length >= RIGID_ROW_LIMIT &&
    !hasCompactBehaviour
  ) {
    bag.warnings.push({
      code: VALIDATION_CODES.rigidHorizontalLayout,
      message: `${node.name ?? node.id} lays ${children.length} children out horizontally without wrapping and says nothing about compact displays`,
      nodeId: node.id,
      details: { children: children.length },
    });
  }
}

function checkAccessibleName(bag: Bag, node: UINode): void {
  if (hasAccessibleName(node)) {
    return;
  }
  if (node.kind === 'input') {
    bag.warnings.push({
      code: VALIDATION_CODES.formInputMissingLabel,
      message: `Input ${node.name ?? node.id} has no label and no accessible label`,
      nodeId: node.id,
    });
    return;
  }
  bag.warnings.push({
    code: VALIDATION_CODES.interactiveElementMissingLabel,
    message: `${node.kind} ${node.name ?? node.id} has no accessible name`,
    nodeId: node.id,
  });
}

function checkDestructive(
  bag: Bag,
  node: UINode,
  view: ResolvedPresentation,
  actions: Map<NodeId, ActionDef>,
): void {
  if (node.kind !== 'button') {
    return;
  }
  const action = actions.get(node.actionId);
  const destructive = node.destructive === true || (action ? isDestructiveAction(action) : false);
  const declaredRole = node.presentation?.role;

  if (destructive && (declaredRole === 'success' || declaredRole === 'informational')) {
    bag.warnings.push({
      code: VALIDATION_CODES.destructiveActionPresentedAsSuccess,
      message: `${node.name ?? node.id} runs a destructive action but is presented as "${declaredRole}"`,
      nodeId: node.id,
      details: { actionId: node.actionId, role: declaredRole },
    });
  }
  if (!destructive && node.presentation?.uxRole === 'destructive-action') {
    bag.warnings.push({
      code: VALIDATION_CODES.presentationSemanticConflict,
      message: `${node.name ?? node.id} is presented as a destructive action but ${node.actionId} declares no destructive intent`,
      nodeId: node.id,
      details: { actionId: node.actionId, uxRole: 'destructive-action' },
    });
  }
  if (view.uxRole === 'primary-action' && node.presentation?.role === 'muted') {
    bag.warnings.push({
      code: VALIDATION_CODES.presentationSemanticConflict,
      message: `${node.name ?? node.id} is the primary action but is presented as muted`,
      nodeId: node.id,
      details: { uxRole: 'primary-action', role: 'muted' },
    });
  }
}

function checkEmptyState(bag: Bag, index: Index, node: UINode, view: ResolvedPresentation): void {
  if (view.uxRole !== 'empty-state') {
    return;
  }
  const hasAction = descendants(index, node.id).some((child) => child.kind === 'button');
  if (!hasAction) {
    bag.warnings.push({
      code: VALIDATION_CODES.emptyStateWithoutRecoveryAction,
      message: `The empty state ${node.name ?? node.id} offers nothing to do about it`,
      nodeId: node.id,
    });
  }
}

/**
 * A form should have exactly one primary action. Primary actions are counted by the
 * action they run, so a button bound to the form's own submit action is not a second one.
 */
function checkPrimaryActions(bag: Bag, index: Index, resolved: Record<NodeId, ResolvedPresentation>): void {
  for (const node of index.nodes.values()) {
    if (!isUINode(node)) {
      continue;
    }
    const isForm = node.kind === 'form';
    const isActionGroup = resolved[node.id]?.uxRole === 'action-group';
    if (!isForm && !isActionGroup) {
      continue;
    }
    const primary = new Set<NodeId>();
    if (isForm && node.kind === 'form' && node.submitActionId) {
      primary.add(node.submitActionId);
    }
    for (const child of descendants(index, node.id)) {
      if (child.kind === 'button' && resolved[child.id]?.uxRole === 'primary-action') {
        primary.add(child.actionId);
      }
    }
    if (primary.size > 1) {
      bag.warnings.push({
        code: VALIDATION_CODES.multiplePrimaryActions,
        message: `${node.name ?? node.id} presents ${primary.size} actions as primary`,
        nodeId: node.id,
        details: { actionIds: [...primary] },
      });
    }
    if (isForm && primary.size === 0) {
      bag.warnings.push({
        code: VALIDATION_CODES.formWithoutPrimaryAction,
        message: `Form ${node.name ?? node.id} has no primary action`,
        nodeId: node.id,
      });
    }
  }
}

/** A view that has section headings but no title of its own has no top of the outline. */
function checkHeadingStructure(bag: Bag, index: Index, resolved: Record<NodeId, ResolvedPresentation>): void {
  for (const node of index.nodes.values()) {
    if (!isUINode(node) || node.kind !== 'view') {
      continue;
    }
    const roles = descendants(index, node.id)
      .filter((child) => child.kind === 'text')
      .map((child) => resolved[child.id]?.textRole);
    if (roles.includes('heading') && !roles.includes('title') && !roles.includes('display')) {
      bag.warnings.push({
        code: VALIDATION_CODES.invalidHeadingStructure,
        message: `View ${node.name ?? node.id} has section headings but no title above them`,
        nodeId: node.id,
      });
    }
  }
}

/**
 * An action that removes something is destructive whether or not it says so. Presentation
 * is inferred either way; the warning exists because the *declaration* is what an agent
 * reads when it asks which actions are dangerous.
 */
function checkUnmarkedDestructiveActions(bag: Bag, index: Index, actions: Map<NodeId, ActionDef>): void {
  const bound = new Set<NodeId>();
  for (const node of index.nodes.values()) {
    if (isUINode(node) && node.kind === 'button') {
      bound.add(node.actionId);
    }
  }
  for (const action of actions.values()) {
    if (!bound.has(action.id) || action.destructive === true) {
      continue;
    }
    if ((action.operations ?? []).some((operation) => operation.kind === 'remove')) {
      bag.warnings.push({
        code: VALIDATION_CODES.destructiveActionUnmarked,
        message: `${action.name ?? action.id} removes data but does not declare "destructive"`,
        nodeId: action.id,
      });
    }
  }
}
