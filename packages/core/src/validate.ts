import { AGGREGATE_FUNCTIONS, BUILTIN_FUNCTIONS } from './expressions.js';
import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import { VALIDATION_CODES } from './diagnostics.js';
import type { RendererCapabilities } from './renderer-capabilities.js';
import type { ValidationIssue, ValidationResult } from './diagnostics.js';
import type { LiteralValue } from './nodes.js';
import { EDGE_KINDS, actionGuards, isMutationOperation } from './nodes.js';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  Operation,
  RouteDef,
  StateDef,
  TransitionConstraintDef,
} from './nodes.js';
import { entityType } from './type-ref.js';
import type { TypeRef } from './type-ref.js';
import { isUINode, uiChildIds } from './ui.js';
import type { UINode } from './ui.js';
import type { AnyNode } from './types.js';
import type { ApplicationGraph } from './graph.js';
import { semanticContextFromGraph } from './context.js';
import {
  inferExpressionType,
  inferLocationType,
  isNonNumericCollection,
  isObviouslyIncompatible,
  itemTypeOf,
} from './infer.js';
import type { SemanticContext } from './infer.js';
import { locationExpressions } from './location.js';
import type { Location } from './location.js';
import { validateLocation } from './validate-location.js';
import { resolvePresentationMap } from './resolve-presentation.js';
import { validatePresentation } from './validate-presentation.js';
import { validateAuthority } from './validate-authority.js';
import { validateValueAgainstType } from './validate-value.js';
import { PRINCIPAL } from './authority.js';



interface Context {
  graph: ApplicationGraph;
  semantics: SemanticContext;
  nodes: Map<NodeId, AnyNode>;
  fields: Map<FieldId, NodeId>;
  /** Ids that a `ref` expression is allowed to resolve at runtime. */
  scopes: Set<NodeId>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Verifies referential integrity of an application graph. An invalid graph must never
 * be executed, so every reference — nodes, fields, edges, expressions, UI children —
 * is resolved here.
 */
export interface ValidateOptions {
  /**
   * The renderer the graph is intended for. Absent, every UI node kind is accepted — a graph
   * is not rejected for a target nobody named. Compiling for a real renderer supplies its
   * real capabilities, which is where an unrenderable node kind is caught.
   */
  renderer?: RendererCapabilities;
}

export function validateGraph(graph: ApplicationGraph, options: ValidateOptions = {}): ValidationResult {
  const nodes = new Map<NodeId, AnyNode>();
  const fields = new Map<FieldId, NodeId>();
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const context: Context = {
    graph,
    semantics: semanticContextFromGraph(graph),
    nodes,
    fields,
    scopes: new Set(),
    errors,
    warnings,
  };

  for (const node of graph.listNodes()) {
    if (nodes.has(node.id)) {
      errors.push({ code: VALIDATION_CODES.duplicateNodeId, message: `Duplicate node id ${node.id}`, nodeId: node.id });
      continue;
    }
    nodes.set(node.id, node);
  }

  // A UI node kind the intended renderer cannot draw is an authoring error, not a runtime
  // surprise. Without this a graph can validate and then render nothing.
  const renderer = options.renderer;
  if (renderer) {
    const supported = new Set<string>(renderer.supportedUiKinds);
    for (const node of nodes.values()) {
      if (isUINode(node) && !supported.has(node.kind)) {
        errors.push({
          code: VALIDATION_CODES.unsupportedUiNodeKind,
          message: `The ${renderer.target} renderer cannot render a ${node.kind} node`,
          nodeId: node.id,
          details: { kind: node.kind, target: renderer.target },
        });
      }
    }
  }

  // Only these ids can be resolved by a `ref` expression at runtime. The principal is
  // bound by an authority; `validateAuthority` rejects reading it anywhere else.
  context.scopes.add(PRINCIPAL);
  for (const node of nodes.values()) {
    if (node.kind === 'state' || node.kind === 'entity' || node.kind === 'repeat') {
      context.scopes.add(node.id);
      continue;
    }
    if (node.kind === 'route') {
      for (const parameter of node.parameters ?? []) {
        context.scopes.add(parameter.id);
      }
      continue;
    }
    if (node.kind === 'action') {
      for (const parameter of node.parameters ?? []) {
        context.scopes.add(parameter.id);
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== 'entity') {
      continue;
    }
    for (const field of node.fields) {
      const owner = fields.get(field.id);
      if (owner) {
        errors.push({
          code: VALIDATION_CODES.duplicateFieldId,
          message: `Field id ${field.id} is declared by both ${owner} and ${node.id}`,
          nodeId: node.id,
          fieldId: field.id,
        });
        continue;
      }
      fields.set(field.id, node.id);
    }
  }

  for (const node of nodes.values()) {
    validateNode(node, context);
  }

  validateEdges(context);
  validateRoutes(context);
  reportUnreachableUiNodes(context);

  // Presentation is validated against the same graph, with the theme completed. Only an
  // unknown token is an error here; UX findings are advice.
  const allNodes = [...nodes.values()];
  const presentation = validatePresentation(
    allNodes,
    graph.declaredTheme,
    resolvePresentationMap(allNodes, graph.theme),
  );
  errors.push(...presentation.errors);
  warnings.push(...presentation.warnings);

  // The authority boundary. A graph that could let a client commit server state, or that
  // would make an authority read state it does not own, cannot execute safely.
  const authority = validateAuthority(allNodes, graph.principalEntityId);
  errors.push(...authority.errors);
  warnings.push(...authority.warnings);

  return { valid: errors.length === 0, errors, warnings };
}

function validateNode(node: AnyNode, context: Context): void {
  if (isUINode(node)) {
    validateUiNode(node, context);
    return;
  }
  switch (node.kind) {
    case 'entity':
      validateEntity(node, context);
      return;
    case 'state':
      validateState(node, context);
      return;
    case 'action':
      validateAction(node, context);
      return;
    case 'constraint':
      validateConstraint(node, context);
      return;
    case 'transition-constraint':
      validateTransitionConstraint(node, context);
      return;
    case 'route':
      validateRoute(node, context);
      return;
    default:
      context.errors.push({
        code: VALIDATION_CODES.danglingNodeRef,
        message: `Unknown node kind ${(node as { kind: string }).kind}`,
        nodeId: (node as AnyNode).id,
      });
  }
}

function validateEntity(entity: EntityDef, context: Context): void {
  for (const field of entity.fields) {
    validateTypeRef(field.valueType, entity.id, context, field.id);
  }
  if (entity.identityFieldId && !entity.fields.some((field) => field.id === entity.identityFieldId)) {
    context.errors.push({
      code: VALIDATION_CODES.danglingFieldRef,
      message: `Identity field ${entity.identityFieldId} is not declared by entity ${entity.id}`,
      nodeId: entity.id,
      fieldId: entity.identityFieldId,
    });
  }
}

function validateState(state: StateDef, context: Context): void {
  validateTypeRef(state.valueType, state.id, context);
  if (state.initialValue !== undefined) {
    validateValue(state.initialValue, state.valueType, String(state.id), state, context);
  }
  if (state.derivation) {
    validateExpression(state.derivation, state.id, context, new Set());
  }
  if (state.ephemeral && state.persistence) {
    context.errors.push({
      code: VALIDATION_CODES.ephemeralStatePersisted,
      message: `State ${state.id} is ephemeral presentation state and cannot be persisted`,
      nodeId: state.id,
      details: { persistence: state.persistence.kind },
    });
  }
  if (state.persistence?.kind === 'remote' && !context.nodes.has(state.persistence.sourceId)) {
    context.errors.push({
      code: VALIDATION_CODES.danglingNodeRef,
      message: `State ${state.id} persists to unknown source ${state.persistence.sourceId}`,
      nodeId: state.id,
    });
  }
}

/**
 * Checks seed data against the type it is declared to have, recursively. Entity values
 * are keyed by field id, so data keyed by field *name* is a mistake this catches rather
 * than one that surfaces later as a mysteriously empty UI.
 */
function validateValue(
  value: LiteralValue | undefined,
  type: TypeRef,
  path: string,
  state: StateDef,
  context: Context,
): void {
  const problems = validateValueAgainstType(value, type, {
    path,
    getEntity: (id) => context.semantics.getEntity(id),
    allowIncomplete: state.draft === true,
  });
  for (const problem of problems) {
    context.errors.push({ ...problem, nodeId: state.id });
  }
}

function validateAction(action: ActionDef, context: Context): void {
  if (action.authorization) {
    validateExpression(action.authorization, action.id, context, new Set());
  }
  const local = emptyScope(new Set<NodeId>((action.parameters ?? []).map((parameter) => parameter.id)));
  for (const parameter of action.parameters ?? []) {
    if (parameter.valueType) {
      validateTypeRef(parameter.valueType, action.id, context);
      local.types.set(parameter.id, parameter.valueType);
    }
  }
  if (action.guards?.length && action.preconditions?.length) {
    context.errors.push({
      code: VALIDATION_CODES.unsupportedOperation,
      message: `Action ${action.id} declares both guards and preconditions; use guards alone`,
      nodeId: action.id,
    });
  }
  for (const guard of actionGuards(action)) {
    validateExpression(guard.condition, action.id, context, local);
  }
  for (const postcondition of action.postconditions ?? []) {
    validateExpression(postcondition, action.id, context, local);
  }
  for (const operation of action.operations ?? []) {
    validateOperation(operation, action, context, local);
  }
}

function validateOperation(
  operation: Operation,
  action: ActionDef,
  context: Context,
  local: Scoped,
): void {
  switch (operation.kind) {
    case 'for-each': {
      validateExpression(operation.collection, action.id, context, local);
      requireCollection(operation.collection, action.id, context, local, 'for-each');
      const scoped = iterationScope(local, operation.scopeId, operation.collection, context, action.id);
      if ((operation.operations ?? []).length === 0) {
        context.warnings.push({
          code: VALIDATION_CODES.unsupportedOperation,
          message: `A for-each in ${action.id} performs no mutations`,
          nodeId: action.id,
        });
      }
      for (const nested of operation.operations ?? []) {
        if (!isMutationOperation(nested)) {
          context.errors.push({
            code: VALIDATION_CODES.unsupportedOperation,
            message: `A for-each in ${action.id} may only contain set, insert and remove operations`,
            nodeId: action.id,
          });
          continue;
        }
        validateOperation(nested, action, context, scoped);
      }
      return;
    }
    case 'set': {
      checkLocation(operation.target, action.id, context, local, true);
      validateExpression(operation.value, action.id, context, local);
      checkAssignment(operation.target, operation.value, action.id, context, local);
      return;
    }
    case 'insert': {
      checkLocation(operation.target, action.id, context, local, true);
      validateExpression(operation.value, action.id, context, local);
      const target = resolveKnownType(inferLocationType(operation.target, context.semantics));
      if (target && target.kind !== 'collection') {
        context.errors.push({
          code: VALIDATION_CODES.selectorOnNonCollection,
          message: `Action ${action.id} inserts into a ${target.kind} location, which is not a collection`,
          nodeId: action.id,
        });
        return;
      }
      if (target?.kind === 'collection') {
        reportIncompatible(
          target.itemType,
          inferExpressionType(operation.value, context.semantics, local.types),
          action.id,
          context,
        );
      }
      return;
    }
    case 'remove':
      checkLocation(operation.target, action.id, context, local, true);
      return;
    case 'invoke': {
      requireKind(operation.actionId, 'action', action.id, context, VALIDATION_CODES.invalidActionRef);
      const target = context.nodes.get(operation.actionId);
      for (const [parameterId, argument] of Object.entries(operation.arguments ?? {})) {
        validateExpression(argument, action.id, context, local);
        if (target && target.kind === 'action' && !(target.parameters ?? []).some((p) => p.id === parameterId)) {
          context.errors.push({
            code: VALIDATION_CODES.danglingNodeRef,
            message: `Action ${action.id} passes unknown parameter ${parameterId} to ${operation.actionId}`,
            nodeId: action.id,
          });
        }
      }
      return;
    }
    case 'navigate':
      if (operation.routeId) {
        requireKind(operation.routeId, 'route', action.id, context, VALIDATION_CODES.danglingNodeRef);
      }
      if (!operation.routeId && !operation.path) {
        context.errors.push({
          code: VALIDATION_CODES.danglingNodeRef,
          message: `Navigate operation in ${action.id} declares neither a route nor a path`,
          nodeId: action.id,
        });
      }
      for (const argument of Object.values(operation.parameters ?? {})) {
        validateExpression(argument, action.id, context, local);
      }
      return;
    case 'native':
      for (const input of Object.values(operation.inputs ?? {})) {
        validateExpression(input, action.id, context, local);
      }
      if (operation.resultTarget) {
        checkLocation(operation.resultTarget, action.id, context, local, true);
      }
      for (const effect of operation.declaredEffects ?? []) {
        if (effect.kind !== 'external') {
          requireKind(effect.stateId, 'state', action.id, context, VALIDATION_CODES.invalidStateRef);
        }
      }
      return;
    default:
      context.errors.push({
        code: VALIDATION_CODES.danglingNodeRef,
        message: `Unknown operation kind in action ${action.id}`,
        nodeId: action.id,
      });
  }
}

function resolveKnownType(type: TypeRef | undefined): TypeRef | undefined {
  return type?.kind === 'optional' ? resolveKnownType(type.valueType) : type;
}

/** Validates a location structurally and validates the expressions inside it. */
function checkLocation(
  location: Location,
  ownerId: NodeId,
  context: Context,
  local: Set<NodeId> | Scoped,
  requireWritable: boolean,
): void {
  context.errors.push(
    ...validateLocation(location, context.semantics, { ownerId, requireWritable }),
  );
  for (const expression of locationExpressions(location)) {
    validateExpression(expression, ownerId, context, local);
  }
}

function checkAssignment(
  target: Location,
  value: Expression,
  ownerId: NodeId,
  context: Context,
  scope: Scoped,
): void {
  reportIncompatible(
    inferLocationType(target, context.semantics),
    inferExpressionType(value, context.semantics, scope.types),
    ownerId,
    context,
  );
}

function reportIncompatible(
  target: TypeRef | undefined,
  value: TypeRef | undefined,
  ownerId: NodeId,
  context: Context,
): void {
  if (isObviouslyIncompatible(target, value)) {
    context.errors.push({
      code: VALIDATION_CODES.assignmentTypeMismatch,
      message: `${ownerId} assigns a ${describeType(value)} to a ${describeType(target)} location`,
      nodeId: ownerId,
    });
  }
}

function describeType(type: TypeRef | undefined): string {
  if (!type) {
    return 'value of unknown type';
  }
  switch (type.kind) {
    case 'primitive':
      return type.primitive;
    case 'entity':
      return `entity ${type.entityId}`;
    case 'collection':
      return `collection of ${describeType(type.itemType)}`;
    case 'optional':
      return `optional ${describeType(type.valueType)}`;
    case 'enum':
      return `enum(${type.values.join('|')})`;
    default:
      return 'value of unknown type';
  }
}

function validateConstraint(constraint: ConstraintDef, context: Context): void {
  const local = new Set<NodeId>();
  if (constraint.entityId) {
    requireKind(constraint.entityId, 'entity', constraint.id, context, VALIDATION_CODES.danglingNodeRef);
    local.add(constraint.entityId);
  }
  validateExpression(constraint.expression, constraint.id, context, local);
}

function validateTransitionConstraint(constraint: TransitionConstraintDef, context: Context): void {
  requireKind(constraint.entityId, 'entity', constraint.id, context, VALIDATION_CODES.danglingNodeRef);
  const entity = context.nodes.get(constraint.entityId);

  // Without an identity field there is no way to say which previous instance a proposed
  // instance corresponds to, so the rule could not be evaluated at all.
  if (entity?.kind === 'entity' && !entity.identityFieldId) {
    context.errors.push({
      code: VALIDATION_CODES.unsupportedConstraintScope,
      message: `Transition constraint ${constraint.id} governs ${entity.id}, which has no identity field to match instances by`,
      nodeId: constraint.id,
    });
  }

  if (constraint.previousScopeId === constraint.proposedScopeId) {
    context.errors.push({
      code: VALIDATION_CODES.unsupportedConstraintScope,
      message: `Transition constraint ${constraint.id} uses one scope for both the previous and the proposed instance`,
      nodeId: constraint.id,
    });
  }

  const scope = emptyScope(new Set([constraint.previousScopeId, constraint.proposedScopeId]));
  if (entity?.kind === 'entity') {
    scope.types.set(constraint.previousScopeId, entityType(entity.id));
    scope.types.set(constraint.proposedScopeId, entityType(entity.id));
  }
  validateExpression(constraint.expression, constraint.id, context, scope);
}

function validateRoute(route: RouteDef, context: Context): void {
  const view = context.nodes.get(route.viewId);
  if (!view || view.kind !== 'view') {
    context.errors.push({
      code: VALIDATION_CODES.invalidRouteView,
      message: `Route ${route.id} does not resolve to a view node`,
      nodeId: route.id,
    });
  }
  const placeholders = route.path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
  for (const placeholder of placeholders) {
    if (!(route.parameters ?? []).some((parameter) => parameter.name === placeholder)) {
      context.errors.push({
        code: VALIDATION_CODES.invalidRouteParameter,
        message: `Route ${route.id} has no parameter declared for ":${placeholder}"`,
        nodeId: route.id,
      });
    }
  }
  for (const parameter of route.parameters ?? []) {
    if (!placeholders.includes(parameter.name)) {
      context.warnings.push({
        code: VALIDATION_CODES.invalidRouteParameter,
        message: `Route ${route.id} declares parameter "${parameter.name}" that its path never uses`,
        nodeId: route.id,
      });
    }
  }
}

function validateUiNode(node: UINode, context: Context): void {
  if (node.visibleWhen) {
    validateExpression(node.visibleWhen, node.id, context, new Set());
  }
  for (const childId of uiChildIds(node)) {
    const child = context.nodes.get(childId);
    if (!child || !isUINode(child)) {
      context.errors.push({
        code: VALIDATION_CODES.invalidUiChild,
        message: `UI node ${node.id} references ${childId}, which is not a UI node`,
        nodeId: node.id,
      });
    }
  }
  switch (node.kind) {
    case 'text':
      if (typeof node.value !== 'string') {
        validateExpression(node.value, node.id, context, new Set());
      }
      return;
    case 'repeat':
      validateExpression(node.source, node.id, context, new Set());
      return;
    case 'field-display':
      validateExpression(node.source, node.id, context, new Set());
      requireField(node.fieldId, node.id, context);
      return;
    case 'form': {
      validateExpression(node.target, node.id, context, new Set());
      if (node.submitActionId) {
        requireKind(node.submitActionId, 'action', node.id, context, VALIDATION_CODES.invalidActionRef);
      }
      if (!node.submitButtonId && node.submitActionId) {
        // A generated submit button carries no arguments, so an action needing any of them
        // could never be satisfied. Silent omission is what produced ARGUMENT_TYPE_MISMATCH
        // at run time; it is rejected here instead.
        requireArguments(
          node.submitActionId,
          {},
          node.id,
          context,
          `Form ${node.id} submits ${node.submitActionId}, whose generated button cannot supply arguments;` +
            ' declare a submit button with submitButtonId and give it',
        );
      }
      if (node.submitButtonId) {
        const button = context.nodes.get(node.submitButtonId);
        if (button?.kind !== 'button') {
          context.errors.push({
            code: VALIDATION_CODES.invalidUiChild,
            message: `Form ${node.id} names ${node.submitButtonId} as its submit control, which is not a button`,
            nodeId: node.id,
          });
        } else {
          if (!uiDescendants(node.id, context).has(node.submitButtonId)) {
            context.errors.push({
              code: VALIDATION_CODES.invalidUiChild,
              message: `Form ${node.id} names ${node.submitButtonId} as its submit control, but that button is not inside the form`,
              nodeId: node.id,
            });
          }
          if (node.submitActionId && button.actionId !== node.submitActionId) {
            context.errors.push({
              code: VALIDATION_CODES.invalidActionRef,
              message: `Form ${node.id} submits ${node.submitActionId} but its submit control invokes ${button.actionId}`,
              nodeId: node.id,
            });
          }
        }
      }
      return;
    }
    case 'input':
      if (!node.binding?.location) {
        context.errors.push({
          code: VALIDATION_CODES.unknownStateRef,
          message: `Input ${node.id} has no bound location`,
          nodeId: node.id,
        });
        return;
      }
      checkLocation(node.binding.location, node.id, context, new Set(), true);
      if (node.options) {
        validateExpression(node.options.source, node.id, context, new Set());
        requireField(node.options.valueFieldId, node.id, context);
        if (node.options.labelFieldId) {
          requireField(node.options.labelFieldId, node.id, context);
        }
      }
      return;
    case 'button': {
      requireKind(node.actionId, 'action', node.id, context, VALIDATION_CODES.invalidActionRef);
      requireArguments(node.actionId, node.arguments ?? {}, node.id, context, `Button ${node.id}`);
      if (typeof node.label !== 'string') {
        validateExpression(node.label, node.id, context, new Set());
      }
      const action = context.nodes.get(node.actionId);
      for (const [parameterId, argument] of Object.entries(node.arguments ?? {})) {
        validateExpression(argument, node.id, context, new Set());
        if (action && action.kind === 'action' && !(action.parameters ?? []).some((p) => p.id === parameterId)) {
          context.errors.push({
            code: VALIDATION_CODES.danglingNodeRef,
            message: `Button ${node.id} passes unknown parameter ${parameterId} to action ${node.actionId}`,
            nodeId: node.id,
          });
        }
      }
      return;
    }
    case 'conditional':
      validateExpression(node.condition, node.id, context, new Set());
      return;
    case 'diagnostic':
      requireKind(node.actionId, 'action', node.id, context, VALIDATION_CODES.invalidActionRef);
      return;
    case 'dialog': {
      validateExpression(node.openWhen, node.id, context, new Set());
      if (typeof node.title !== 'string') {
        validateExpression(node.title, node.id, context, new Set());
      } else if (node.title.trim().length === 0) {
        // An empty accessible name is worse than a missing one: it validates and announces
        // nothing.
        context.errors.push({
          code: VALIDATION_CODES.invalidDialog,
          message: `Dialog ${node.name ?? node.id} has an empty title, so it has no accessible name`,
          nodeId: node.id,
          details: { reason: 'empty-title' },
        });
      }
      if (node.description !== undefined && typeof node.description !== 'string') {
        validateExpression(node.description, node.id, context, new Set());
      }
      requireKind(node.closeActionId, 'action', node.id, context, VALIDATION_CODES.invalidActionRef);
      // Focus targets must be inside the dialog. A focus target outside it would move focus
      // out of a modal at the moment it opens, which is the opposite of containment.
      const descendants = collectUiDescendants(node.children, context);
      for (const [label, target] of [
        ['initialFocusId', node.initialFocusId],
        ['returnFocusId', node.returnFocusId],
      ] as const) {
        if (target === undefined) {
          continue;
        }
        if (!context.nodes.has(target)) {
          context.errors.push({
            code: VALIDATION_CODES.invalidDialog,
            message: `Dialog ${node.name ?? node.id} names ${String(target)} as ${label}, which is not a node`,
            nodeId: node.id,
            details: { reason: 'unknown-focus-target', target },
          });
          continue;
        }
        if (label === 'initialFocusId' && !descendants.has(target)) {
          context.errors.push({
            code: VALIDATION_CODES.invalidDialog,
            message:
              `Dialog ${node.name ?? node.id} sets initial focus to ${String(target)}, which is not inside it`,
            nodeId: node.id,
            details: { reason: 'focus-target-outside', target },
          });
        }
        if (label === 'returnFocusId' && descendants.has(target)) {
          context.errors.push({
            code: VALIDATION_CODES.invalidDialog,
            message:
              `Dialog ${node.name ?? node.id} returns focus to ${String(target)}, which is inside it and will not exist once it closes`,
            nodeId: node.id,
            details: { reason: 'return-focus-inside', target },
          });
        }
      }
      if (node.modal === false && node.initialFocusId !== undefined) {
        context.warnings.push({
          code: VALIDATION_CODES.invalidDialog,
          message:
            `Dialog ${node.name ?? node.id} is non-modal but moves focus on open, which takes focus from wherever the person was`,
          nodeId: node.id,
          details: { reason: 'non-modal-initial-focus' },
        });
      }
      return;
    }
    default:
  }
}

/** Every UI node reachable from these children, for containment checks. */
function collectUiDescendants(children: readonly NodeId[], context: Context): Set<NodeId> {
  const found = new Set<NodeId>();
  const walk = (ids: readonly NodeId[]): void => {
    for (const id of ids) {
      if (found.has(id)) {
        continue;
      }
      found.add(id);
      const child = context.nodes.get(id);
      if (!child) {
        continue;
      }
      if (child.kind === 'container' || child.kind === 'view' || child.kind === 'form' || child.kind === 'dialog') {
        walk((child as { children: NodeId[] }).children);
      }
      if (child.kind === 'conditional') {
        walk([...child.whenTrue, ...(child.whenFalse ?? [])]);
      }
      if (child.kind === 'repeat') {
        walk([child.templateId, ...(child.emptyTemplateId ? [child.emptyTemplateId] : [])]);
      }
    }
  };
  walk(children);
  return found;
}

/**
 * Every required parameter of an action must have an argument. A missing one is statically
 * knowable, and would otherwise surface as a refusal at invocation time — on the authority,
 * for a remote action.
 */
function requireArguments(
  actionId: NodeId,
  args: Record<string, unknown>,
  ownerId: NodeId,
  context: Context,
  where: string,
): void {
  const action = context.nodes.get(actionId);
  if (action?.kind !== 'action') {
    return;
  }
  const missing = (action.parameters ?? [])
    .filter((parameter) => parameter.required && !(String(parameter.id) in args))
    .map((parameter) => String(parameter.id));
  if (missing.length > 0) {
    context.errors.push({
      code: VALIDATION_CODES.missingActionArgument,
      message: `${where} ${missing.length === 1 ? 'no argument for' : 'no arguments for'} ${missing.join(', ')}`,
      nodeId: ownerId,
      details: { actionId, missing },
    });
  }
}

/** Every UI node beneath this one, for checks that must know what a subtree contains. */
function uiDescendants(id: NodeId, context: Context): Set<NodeId> {
  const found = new Set<NodeId>();
  const visit = (current: NodeId): void => {
    const node = context.nodes.get(current);
    if (!node || !isUINode(node)) {
      return;
    }
    for (const childId of uiChildIds(node)) {
      if (found.has(childId)) {
        continue;
      }
      found.add(childId);
      visit(childId);
    }
  };
  visit(id);
  return found;
}

function validateEdges(context: Context): void {
  for (const edge of context.graph.listEdges()) {
    if (!EDGE_KINDS.includes(edge.kind)) {
      context.errors.push({
        code: VALIDATION_CODES.invalidEdgeKind,
        message: `Edge ${edge.id} uses unknown kind "${edge.kind}"`,
        edgeId: edge.id,
      });
    }
    for (const endpoint of [edge.from, edge.to]) {
      if (!context.nodes.has(endpoint)) {
        context.errors.push({
          code: VALIDATION_CODES.danglingNodeRef,
          message: `Edge ${edge.id} references unknown node ${endpoint}`,
          edgeId: edge.id,
        });
      }
    }
  }
}

function validateRoutes(context: Context): void {
  const seen = new Map<string, NodeId>();
  for (const node of context.nodes.values()) {
    if (node.kind !== 'route') {
      continue;
    }
    const owner = seen.get(node.path);
    if (owner) {
      context.errors.push({
        code: VALIDATION_CODES.duplicateRoutePath,
        message: `Route path ${node.path} is declared by both ${owner} and ${node.id}`,
        nodeId: node.id,
      });
      continue;
    }
    seen.set(node.path, node.id);
  }
}

function reportUnreachableUiNodes(context: Context): void {
  const reachable = new Set<NodeId>();
  const visit = (id: NodeId): void => {
    if (reachable.has(id)) {
      return;
    }
    const node = context.nodes.get(id);
    if (!node || !isUINode(node)) {
      return;
    }
    reachable.add(id);
    for (const childId of uiChildIds(node)) {
      visit(childId);
    }
  };

  for (const node of context.nodes.values()) {
    if (node.kind === 'route') {
      visit(node.viewId);
    }
  }

  for (const node of context.nodes.values()) {
    if (isUINode(node) && !reachable.has(node.id)) {
      context.warnings.push({
        code: VALIDATION_CODES.unreachableUiNode,
        message: `UI node ${node.id} is not reachable from any route`,
        nodeId: node.id,
      });
    }
  }
}

function validateTypeRef(
  type: TypeRef,
  ownerId: NodeId,
  context: Context,
  field?: FieldId,
  inCollection = false,
): void {
  switch (type.kind) {
    case 'primitive':
      return;
    case 'entity': {
      const target = context.nodes.get(type.entityId);
      if (!target || target.kind !== 'entity') {
        context.errors.push({
          code: VALIDATION_CODES.invalidTypeRef,
          message: `Type reference in ${ownerId} points to ${type.entityId}, which is not an entity`,
          nodeId: ownerId,
          ...(field ? { fieldId: field } : {}),
        });
        return;
      }
      if (!target.identityFieldId && inCollection) {
        context.warnings.push({
          code: VALIDATION_CODES.missingIdentityField,
          message: `Entity ${target.id} has no identity field; item-level operations cannot match instances`,
          nodeId: target.id,
        });
      }
      return;
    }
    case 'collection':
      validateTypeRef(type.itemType, ownerId, context, field, true);
      return;
    case 'optional':
      validateTypeRef(type.valueType, ownerId, context, field, inCollection);
      return;
    case 'enum':
      if (type.values.length === 0) {
        context.errors.push({
          code: VALIDATION_CODES.invalidTypeRef,
          message: `Enum type in ${ownerId} declares no values`,
          nodeId: ownerId,
          ...(field ? { fieldId: field } : {}),
        });
      }
      return;
    default:
      context.errors.push({
        code: VALIDATION_CODES.invalidTypeRef,
        message: `Unknown type kind in ${ownerId}`,
        nodeId: ownerId,
      });
  }
}

interface Scoped {
  /** Ids a `ref` may resolve. */
  ids: Set<NodeId>;
  /** Types those ids carry, where known. */
  types: Map<NodeId, TypeRef>;
}

function emptyScope(ids: Set<NodeId> = new Set()): Scoped {
  return { ids, types: new Map() };
}

/**
 * Extends a scope with the member type of the collection an iteration walks.
 *
 * An iteration binder is not a graph node, and reusing an id that is already bound — or
 * one that names a node — makes a reference ambiguous to read and to analyze.
 */
function iterationScope(
  scope: Scoped,
  scopeId: NodeId,
  source: Expression,
  context: Context,
  ownerId?: NodeId,
): Scoped {
  if (scope.ids.has(scopeId)) {
    context.errors.push({
      code: VALIDATION_CODES.scopeShadowing,
      message: `Scope ${scopeId} in ${ownerId ?? 'an expression'} is already bound by an enclosing iteration`,
      ...(ownerId ? { nodeId: ownerId } : {}),
    });
  }
  if (context.nodes.has(scopeId)) {
    context.errors.push({
      code: VALIDATION_CODES.scopeCollidesWithNode,
      message: `Scope ${scopeId} in ${ownerId ?? 'an expression'} has the same id as a graph node`,
      ...(ownerId ? { nodeId: ownerId } : {}),
    });
  }
  const item = itemTypeOf(inferExpressionType(source, context.semantics, scope.types));
  const types = new Map(scope.types);
  if (item) {
    types.set(scopeId, item);
  } else {
    types.delete(scopeId);
  }
  return { ids: new Set([...scope.ids, scopeId]), types };
}

function validateExpression(
  expression: Expression,
  ownerId: NodeId,
  context: Context,
  local: Set<NodeId> | Scoped,
): void {
  const scope: Scoped = local instanceof Set ? emptyScope(local) : local;

  switch (expression.kind) {
    case 'literal':
      return;
    case 'ref':
      if (!scope.ids.has(expression.targetId) && !context.scopes.has(expression.targetId)) {
        context.errors.push({
          code: VALIDATION_CODES.invalidExpressionRef,
          message: `Expression in ${ownerId} references unknown id ${expression.targetId}`,
          nodeId: ownerId,
        });
      }
      return;
    case 'field':
      requireField(expression.fieldId, ownerId, context);
      validateExpression(expression.source, ownerId, context, scope);
      return;
    case 'object':
      if (expression.entityId) {
        requireKind(expression.entityId, 'entity', ownerId, context, VALIDATION_CODES.danglingNodeRef);
      }
      for (const entry of expression.entries) {
        requireField(entry.fieldId, ownerId, context);
        validateExpression(entry.value, ownerId, context, scope);
      }
      return;
    case 'binary':
      validateExpression(expression.left, ownerId, context, scope);
      validateExpression(expression.right, ownerId, context, scope);
      return;
    case 'unary':
      validateExpression(expression.operand, ownerId, context, scope);
      return;
    case 'call': {
      if (!BUILTIN_FUNCTIONS.includes(expression.function)) {
        context.errors.push({
          code: VALIDATION_CODES.unsupportedExpression,
          message: `${ownerId} calls "${String(expression.function)}", which is not a built-in function`,
          nodeId: ownerId,
        });
        return;
      }
      for (const argument of expression.arguments) {
        validateExpression(argument, ownerId, context, scope);
      }
      // An aggregation over anything but numbers cannot mean what it says.
      if (AGGREGATE_FUNCTIONS.includes(expression.function)) {
        const argument = expression.arguments[0];
        if (!argument) {
          context.errors.push({
            code: VALIDATION_CODES.invalidAggregation,
            message: `${expression.function} in ${ownerId} needs a collection to aggregate`,
            nodeId: ownerId,
          });
          return;
        }
        const type = inferExpressionType(argument, context.semantics, scope.types);
        if (isNonNumericCollection(type)) {
          context.errors.push({
            code: VALIDATION_CODES.invalidAggregation,
            message: `${expression.function} in ${ownerId} expects a collection of numbers but was given ${describeType(type)}`,
            nodeId: ownerId,
          });
        }
      }
      return;
    }
    case 'filter':
    case 'find': {
      validateExpression(expression.source, ownerId, context, scope);
      requireCollection(expression.source, ownerId, context, scope, expression.kind);
      validateExpression(
        expression.predicate,
        ownerId,
        context,
        iterationScope(scope, expression.scopeId, expression.source, context, ownerId),
      );
      return;
    }
    case 'map': {
      validateExpression(expression.source, ownerId, context, scope);
      requireCollection(expression.source, ownerId, context, scope, 'map');
      validateExpression(
        expression.projection,
        ownerId,
        context,
        iterationScope(scope, expression.scopeId, expression.source, context, ownerId),
      );
      return;
    }
    case 'every':
    case 'some': {
      validateExpression(expression.source, ownerId, context, scope);
      requireCollection(expression.source, ownerId, context, scope, expression.kind);
      validateExpression(
        expression.predicate,
        ownerId,
        context,
        iterationScope(scope, expression.scopeId, expression.source, context, ownerId),
      );
      return;
    }
    case 'flatten': {
      validateExpression(expression.source, ownerId, context, scope);
      requireCollection(expression.source, ownerId, context, scope, 'flatten');
      const inner = itemTypeOf(inferExpressionType(expression.source, context.semantics, scope.types));
      if (inner && resolveKnownType(inner)?.kind !== 'collection') {
        context.errors.push({
          code: VALIDATION_CODES.notACollection,
          message: `flatten in ${ownerId} expects a collection of collections but its members are ${describeType(inner)}`,
          nodeId: ownerId,
        });
      }
      return;
    }
    case 'conditional': {
      validateExpression(expression.condition, ownerId, context, scope);
      validateExpression(expression.whenTrue, ownerId, context, scope);
      validateExpression(expression.whenFalse, ownerId, context, scope);
      reportIncompatible(
        inferExpressionType(expression.whenTrue, context.semantics, scope.types),
        inferExpressionType(expression.whenFalse, context.semantics, scope.types),
        ownerId,
        context,
      );
      return;
    }
    case 'sort': {
      validateExpression(expression.source, ownerId, context, scope);
      requireCollection(expression.source, ownerId, context, scope, 'sort');
      validateExpression(
        expression.by,
        ownerId,
        context,
        iterationScope(scope, expression.scopeId, expression.source, context, ownerId),
      );
      return;
    }
    default:
      context.errors.push({
        code: VALIDATION_CODES.unsupportedExpression,
        message: `Unknown expression kind "${(expression as { kind: string }).kind}" in ${ownerId}`,
        nodeId: ownerId,
      });
  }
}

/** Iterating anything that is statically known not to be a collection is an error. */
function requireCollection(
  source: Expression,
  ownerId: NodeId,
  context: Context,
  scope: Scoped,
  what: string,
): void {
  const type = resolveKnownType(inferExpressionType(source, context.semantics, scope.types));
  if (type && type.kind !== 'collection') {
    context.errors.push({
      code: VALIDATION_CODES.notACollection,
      message: `${what} in ${ownerId} iterates ${describeType(type)}, which is not a collection`,
      nodeId: ownerId,
    });
  }
}

function requireField(id: FieldId, ownerId: NodeId, context: Context): void {
  if (!context.fields.has(id)) {
    context.errors.push({
      code: VALIDATION_CODES.danglingFieldRef,
      message: `${ownerId} references unknown field ${id}`,
      nodeId: ownerId,
      fieldId: id,
    });
  }
}

function requireKind(
  id: NodeId,
  kind: AnyNode['kind'],
  ownerId: NodeId,
  context: Context,
  code: string,
): void {
  const node = context.nodes.get(id);
  if (!node || node.kind !== kind) {
    context.errors.push({
      code,
      message: `${ownerId} references ${id}, which is not a ${kind} node`,
      nodeId: ownerId,
    });
  }
}
