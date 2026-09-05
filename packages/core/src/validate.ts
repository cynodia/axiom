import { AGGREGATE_FUNCTIONS, BUILTIN_FUNCTIONS, expressionDefsIn, walkExpression } from './expressions.js';
import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import { VALIDATION_CODES } from './diagnostics.js';
import type { RendererCapabilities } from './renderer-capabilities.js';
import type { TriggerRuntimeCapabilities } from './trigger-capabilities.js';
import type { ValidationIssue, ValidationResult } from './diagnostics.js';
import type { LiteralValue } from './nodes.js';
import { EDGE_KINDS, actionGuards, isMutationOperation, isPlainOperation, rawOperations } from './nodes.js';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  ExpressionDef,
  Operation,
  RouteDef,
  StateDef,
  TransitionConstraintDef,
} from './nodes.js';
import type { EventDef } from './events.js';
import type { IntegrationDef, IntegrationOperationDef } from './integrations.js';
import type { TriggerDef } from './triggers.js';
import {
  SUBSCRIPTION_BACKPRESSURE_POLICIES,
  subscriptionBackpressure,
  subscriptionQueueLimit,
} from './subscriptions.js';
import type { SubscriptionDef } from './subscriptions.js';
import { BLOB_REF_FIELDS } from './storage.js';
import type { StorageDef } from './storage.js';
import type { QueryDef } from './query.js';
import { queryPaginationStrategy, sortKeyDirection } from './query.js';
import { queryStateReferences } from './live-query.js';
import {
  WORKFLOW_EVENT_SCOPE,
  WORKFLOW_PRINCIPAL_SCOPE,
  WORKFLOW_STEP_TYPES,
  workflowHasCycle,
  workflowReachableSteps,
  workflowStepById,
  workflowStepExpressions,
  workflowStepSuccessors,
} from './workflows.js';
import type { WorkflowBinding, WorkflowDef, WorkflowRetryPolicy, WorkflowStepType } from './workflows.js';
import { authorizationPolicyProblems } from './authorization.js';
import type { AuthorizationPolicyDef } from './authorization.js';
import type { RelationshipDef } from './relationships.js';
import { relationshipIsToOne } from './relationships.js';
import type { ReadPolicyDef } from './read-policy.js';
import { validateMigrations } from './validate-migration.js';
import { collectionType, entityType } from './type-ref.js';
import { GROUP_ITEMS_FIELD, GROUP_KEY_FIELD, isGroupFieldId } from './group.js';
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
  /**
   * The trigger runtime the graph is intended for. Absent, every trigger kind is accepted —
   * a graph is not rejected for a trigger runtime nobody named. `compileToIR` supplies the
   * browser's real (empty) capability set, which is where a client-authority trigger kind
   * no browser runtime executes is caught, rather than silently compiling inert.
   */
  triggerRuntime?: TriggerRuntimeCapabilities;
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
  const authority = validateAuthority(allNodes, graph.principalEntityId, options.triggerRuntime);
  errors.push(...authority.errors);
  warnings.push(...authority.warnings);

  // Schema evolution: an internally inconsistent migration declaration is rejected before
  // any persisted data could be touched (spec11 §77, §78).
  const migration = validateMigrations(allNodes, graph.schemaVersion);
  errors.push(...migration.errors);
  warnings.push(...migration.warnings);

  return { valid: errors.length === 0, errors, warnings };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
    case 'expression':
      validateExpressionDef(node, context);
      return;
    case 'integration':
      validateIntegrationDef(node, context);
      return;
    case 'integration-operation':
      validateIntegrationOperation(node, context);
      return;
    case 'event':
      validateEvent(node, context);
      return;
    case 'trigger':
      validateTrigger(node, context);
      return;
    case 'subscription':
      validateSubscription(node, context);
      return;
    case 'storage':
      validateStorage(node, context);
      return;
    case 'query':
      validateQuery(node, context);
      return;
    case 'relationship':
      validateRelationship(node, context);
      return;
    case 'read-policy':
      validateReadPolicy(node, context);
      return;
    case 'workflow':
      validateWorkflow(node, context);
      return;
    case 'authorization-policy':
      validateAuthorizationPolicyNode(node, context);
      return;
    case 'migration':
      // A `MigrationDef` is validated by the graph-level `validateMigrations` pass, which
      // needs every migration and `graph.schemaVersion` at once — chain contiguity and
      // fork detection are cross-node properties.
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
    // The group positions are part of the expression vocabulary. An entity that declared
    // one would make the same id mean two things depending on where it was read.
    if (isGroupFieldId(field.id)) {
      context.errors.push({
        code: VALIDATION_CODES.reservedFieldId,
        message: `Entity ${entity.id} declares ${field.id}, which is reserved for group results`,
        nodeId: entity.id,
        fieldId: field.id,
        details: { reserved: [String(GROUP_KEY_FIELD), String(GROUP_ITEMS_FIELD)] },
      });
    }
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
  // A group is the result of an expression, and nothing can construct one. A stored state
  // declared to hold groups could therefore never be written — only derived state can.
  if (!state.derivation && containsGroupType(state.valueType)) {
    context.errors.push({
      code: VALIDATION_CODES.invalidTypeRef,
      message: `State ${state.id} is stored but declares a group type; only derived state can hold groups`,
      nodeId: state.id,
    });
  }
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
  requireAuthorizationPolicy(action.authorizationPolicy, action.id, context);
  if (action.invocation?.allowedSources && action.invocation.allowedSources.length === 0) {
    context.errors.push({
      code: VALIDATION_CODES.invalidInvocationSource,
      message: `Action ${action.name ?? action.id} declares an empty invocation.allowedSources, so it could never be invoked`,
      nodeId: action.id,
    });
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
  // spec16pt2 F1 — a candidate ActionDef.operations can arrive from AI generation,
  // deserialization or hand-tampering, so its runtime shape is checked before it is ever
  // iterated. A present-but-non-array value is a distinct, structural defect from "absent"
  // (spec16pt2 §15): absent means no operations, non-array means the graph is malformed.
  if (action.operations !== undefined && !Array.isArray(action.operations)) {
    context.errors.push({
      code: VALIDATION_CODES.invalidOperationCollection,
      message: `Action ${action.id} declares operations as ${describeOperationShape(action.operations)}, not an array`,
      nodeId: action.id,
    });
  }
  let scoped: Scoped = local;
  for (const operation of rawOperations(action)) {
    scoped = validateOperation(operation, action, context, scoped);
  }
}

/** A short, safe description of a malformed value for a diagnostic message. Never throws. */
function describeOperationShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array of the wrong shape';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

function validateOperation(
  operation: unknown,
  action: ActionDef,
  context: Context,
  local: Scoped,
): Scoped {
  // spec16pt2 F1/F2 — an operation entry (top-level, or nested inside a for-each) can itself
  // be malformed: `null`, a primitive, or an object with no recognized `kind`. Establish
  // shape before the switch below ever reads `.kind`/`.target`/`.value` (spec16pt2 §20).
  if (!isPlainOperation(operation)) {
    context.errors.push({
      code: VALIDATION_CODES.invalidOperation,
      message: `Action ${action.id} declares an operation that is ${describeOperationShape(operation)}, not a recognized operation`,
      nodeId: action.id,
    });
    return local;
  }
  switch (operation.kind) {
    case 'for-each': {
      validateExpression(operation.collection, action.id, context, local);
      requireCollection(operation.collection, action.id, context, local, 'for-each');
      const scoped = iterationScope(local, operation.scopeId, operation.collection, context, action.id);
      if (operation.operations !== undefined && !Array.isArray(operation.operations)) {
        context.errors.push({
          code: VALIDATION_CODES.invalidOperationCollection,
          message: `A for-each in ${action.id} declares operations as ${describeOperationShape(operation.operations)}, not an array`,
          nodeId: action.id,
        });
      } else if (rawOperations(operation).length === 0) {
        context.warnings.push({
          code: VALIDATION_CODES.unsupportedOperation,
          message: `A for-each in ${action.id} performs no mutations`,
          nodeId: action.id,
        });
      }
      for (const nested of rawOperations(operation)) {
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
      return local;
    }
    case 'set': {
      checkLocation(operation.target, action.id, context, local, true);
      validateExpression(operation.value, action.id, context, local);
      checkAssignment(operation.target, operation.value, action.id, context, local);
      return local;
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
        return local;
      }
      if (target?.kind === 'collection') {
        reportIncompatible(
          target.itemType,
          inferExpressionType(operation.value, context.semantics, local.types),
          action.id,
          context,
        );
      }
      return local;
    }
    case 'remove':
      checkLocation(operation.target, action.id, context, local, true);
      return local;
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
      return local;
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
      return local;
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
      return local;
    case 'integration-query': {
      requireKind(
        operation.operationId,
        'integration-operation',
        action.id,
        context,
        VALIDATION_CODES.unknownIntegrationOperation,
      );
      const target = context.nodes.get(operation.operationId);
      let resultType: TypeRef | undefined;
      if (target?.kind === 'integration-operation') {
        if (target.mode !== 'query') {
          context.errors.push({
            code: VALIDATION_CODES.integrationOperationModeMismatch,
            message: `Action ${action.id} uses integration-query with ${operation.operationId}, which is an effect operation`,
            nodeId: action.id,
          });
        }
        resultType = target.resultType;
        checkIntegrationArguments(target, operation.arguments ?? {}, action.id, context);
      }
      for (const argument of Object.values(operation.arguments ?? {})) {
        validateExpression(argument, action.id, context, local);
      }
      return resultScope(local, operation.bindAs, resultType, context, action.id);
    }
    case 'integration-effect': {
      requireKind(
        operation.operationId,
        'integration-operation',
        action.id,
        context,
        VALIDATION_CODES.unknownIntegrationOperation,
      );
      const target = context.nodes.get(operation.operationId);
      if (target?.kind === 'integration-operation') {
        if (target.mode !== 'effect') {
          context.errors.push({
            code: VALIDATION_CODES.integrationOperationModeMismatch,
            message: `Action ${action.id} uses integration-effect with ${operation.operationId}, which is a query operation`,
            nodeId: action.id,
          });
        }
        checkIntegrationArguments(target, operation.arguments ?? {}, action.id, context);
      }
      for (const argument of Object.values(operation.arguments ?? {})) {
        validateExpression(argument, action.id, context, local);
      }
      if (operation.idempotencyKey) {
        validateExpression(operation.idempotencyKey, action.id, context, local);
      }
      if (operation.succeededEventId) {
        requireKind(operation.succeededEventId, 'event', action.id, context, VALIDATION_CODES.unknownEvent);
      }
      if (operation.failedEventId) {
        requireKind(operation.failedEventId, 'event', action.id, context, VALIDATION_CODES.unknownEvent);
      }
      return local;
    }
    case 'blob-metadata': {
      requireKind(operation.storageId, 'storage', action.id, context, VALIDATION_CODES.unknownStorage);
      validateExpression(operation.blobKey, action.id, context, local);
      const storage = context.nodes.get(operation.storageId);
      const resultType =
        storage?.kind === 'storage' ? entityType(storage.blobEntityId) : undefined;
      return resultScope(local, operation.bindAs, resultType, context, action.id);
    }
    case 'blob-commit':
    case 'blob-delete': {
      requireKind(operation.storageId, 'storage', action.id, context, VALIDATION_CODES.unknownStorage);
      validateExpression(operation.blobKey, action.id, context, local);
      if (operation.succeededEventId) {
        requireKind(operation.succeededEventId, 'event', action.id, context, VALIDATION_CODES.unknownEvent);
      }
      if (operation.failedEventId) {
        requireKind(operation.failedEventId, 'event', action.id, context, VALIDATION_CODES.unknownEvent);
      }
      return local;
    }
    case 'query': {
      requireKind(operation.queryId, 'query', action.id, context, VALIDATION_CODES.unknownRelationship);
      const target = context.nodes.get(operation.queryId);
      if (target?.kind === 'query') {
        const declared = new Set((target.parameters ?? []).map((parameter) => String(parameter.id)));
        for (const parameter of target.parameters ?? []) {
          if (parameter.required !== false && operation.arguments?.[String(parameter.id)] === undefined) {
            context.errors.push({
              code: VALIDATION_CODES.invalidQueryOperation,
              message: `Action ${action.id} runs ${operation.queryId} without supplying ${parameter.id}`,
              nodeId: action.id,
            });
          }
        }
        for (const key of Object.keys(operation.arguments ?? {})) {
          if (!declared.has(key)) {
            context.errors.push({
              code: VALIDATION_CODES.invalidQueryOperation,
              message: `Action ${action.id} passes unknown argument ${key} to ${operation.queryId}`,
              nodeId: action.id,
            });
          }
        }
      }
      for (const argument of Object.values(operation.arguments ?? {})) {
        validateExpression(argument, action.id, context, local);
      }
      // The result binds a `QueryPage`-shaped value; its exact type is a runtime concern.
      return resultScope(local, operation.bindAs, undefined, context, action.id);
    }
    default:
      context.errors.push({
        code: VALIDATION_CODES.danglingNodeRef,
        message: `Unknown operation kind in action ${action.id}`,
        nodeId: action.id,
      });
      return local;
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
      return `enum(${(Array.isArray(type.values) ? type.values : []).join('|')})`;
    case 'group':
      return `group of ${describeType(type.itemType)} by ${describeType(type.keyType)}`;
    default:
      return 'value of unknown type';
  }
}

/**
 * A named expression definition.
 *
 * The body is validated against a **restricted** scope: its own parameters and application
 * state, and nothing the caller happens to have in hand. That is the isolation rule
 * enforced rather than documented — a definition that could reach a caller's iteration
 * scope would mean something different in every place it was used.
 */
function validateExpressionDef(definition: ExpressionDef, context: Context): void {
  const isolated: Context = { ...context, scopes: isolatedScopeIds(context) };
  const local = emptyScope(new Set<NodeId>());
  for (const parameter of definition.parameters ?? []) {
    if (isolated.scopes.has(parameter.id) || local.ids.has(parameter.id)) {
      context.errors.push({
        code: VALIDATION_CODES.scopeCollidesWithNode,
        message: `Parameter ${parameter.id} of ${definition.id} collides with an existing id`,
        nodeId: definition.id,
      });
    }
    local.ids.add(parameter.id);
    if (parameter.valueType) {
      validateTypeRef(parameter.valueType, definition.id, context);
      local.types.set(parameter.id, parameter.valueType);
    }
  }
  if (definition.valueType) {
    validateTypeRef(definition.valueType, definition.id, context);
  }

  const cycle = expressionDefCycle(definition.id, context);
  if (cycle) {
    context.errors.push({
      code: VALIDATION_CODES.expressionDefCycle,
      message: `Expression definition ${definition.id} reaches itself: ${cycle.join(' → ')}`,
      nodeId: definition.id,
      details: { cycle: cycle.map(String) },
    });
    // Walking the body would recurse through the same cycle.
    return;
  }
  validateExpression(definition.expression, definition.id, isolated, local);
}

/** The ids an expression definition's body may resolve: application state, and no more. */
function isolatedScopeIds(context: Context): Set<NodeId> {
  const ids = new Set<NodeId>();
  for (const node of context.nodes.values()) {
    if (node.kind === 'state') {
      ids.add(node.id);
    }
  }
  return ids;
}

/**
 * The chain by which a definition reaches itself, if it does.
 *
 * Reported per definition rather than per reference so the error names the loop once.
 */
function expressionDefCycle(
  start: NodeId,
  context: Context,
  current: NodeId = start,
  path: NodeId[] = [start],
  seen: Set<NodeId> = new Set([start]),
): NodeId[] | undefined {
  const definition = context.nodes.get(current);
  if (!definition || definition.kind !== 'expression') {
    return undefined;
  }
  for (const referenced of expressionDefsIn(definition.expression)) {
    if (referenced === start) {
      return [...path, start];
    }
    if (seen.has(referenced)) {
      continue;
    }
    seen.add(referenced);
    const found = expressionDefCycle(start, context, referenced, [...path, referenced], seen);
    if (found) {
      return found;
    }
  }
  return undefined;
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

function validateIntegrationDef(_integration: IntegrationDef, _context: Context): void {
  // A capability-domain marker with no fields to check beyond the shared node identity
  // checks already applied — declared explicitly so a new node kind never falls to the
  // erroring `default:` branch of `validateNode`.
}

function validateIntegrationOperation(operation: IntegrationOperationDef, context: Context): void {
  requireKind(operation.integrationId, 'integration', operation.id, context, VALIDATION_CODES.unknownIntegration);
  for (const parameter of operation.parameters ?? []) {
    validateTypeRef(parameter.valueType, operation.id, context);
  }
  validateTypeRef(operation.resultType, operation.id, context);
}

function validateEvent(event: EventDef, context: Context): void {
  validateTypeRef(event.payloadType, event.id, context);
}

function validateTrigger(trigger: TriggerDef, context: Context): void {
  requireKind(trigger.actionId, 'action', trigger.id, context, VALIDATION_CODES.triggerActionNotFound);
  const action = context.nodes.get(trigger.actionId);

  if (trigger.when.kind === 'interval' && !(trigger.when.everyMs > 0)) {
    context.errors.push({
      code: VALIDATION_CODES.triggerIntervalNotPositive,
      message: `Trigger ${trigger.id} declares a non-positive interval`,
      nodeId: trigger.id,
    });
  }
  if (trigger.when.kind === 'delay' && !(trigger.when.afterMs > 0)) {
    context.errors.push({
      code: VALIDATION_CODES.triggerIntervalNotPositive,
      message: `Trigger ${trigger.id} declares a non-positive delay`,
      nodeId: trigger.id,
    });
  }
  if (trigger.when.kind === 'lifecycle' && trigger.when.routeId) {
    requireKind(trigger.when.routeId, 'route', trigger.id, context, VALIDATION_CODES.danglingNodeRef);
  }

  // An `event` trigger's arguments/enabledWhen may `ref` the trigger's own id to read the
  // event payload — the same mechanism a `for-each`/`map` scopeId provides.
  let local = emptyScope();
  if (trigger.when.kind === 'event') {
    requireKind(trigger.when.eventId, 'event', trigger.id, context, VALIDATION_CODES.unknownEvent);
    const event = context.nodes.get(trigger.when.eventId);
    local = emptyScope(new Set([trigger.id]));
    if (event?.kind === 'event') {
      local.types.set(trigger.id, event.payloadType);
    }
  }

  if (trigger.enabledWhen) {
    validateExpression(trigger.enabledWhen, trigger.id, context, local);
  }

  if (action?.kind === 'action') {
    requireArguments(trigger.actionId, trigger.arguments ?? {}, trigger.id, context, `Trigger ${trigger.id} supplies`);
    for (const [parameterId, argument] of Object.entries(trigger.arguments ?? {})) {
      validateExpression(argument, trigger.id, context, local);
      if (!(action.parameters ?? []).some((p) => p.id === parameterId)) {
        context.errors.push({
          code: VALIDATION_CODES.danglingNodeRef,
          message: `Trigger ${trigger.id} passes unknown parameter ${parameterId} to ${trigger.actionId}`,
          nodeId: trigger.id,
        });
      }
    }
  }
}

/** Missing required arguments, and arguments the operation declares no parameter for. */
/**
 * A subscription's own declaration. Whether it can actually reach an action — and whether
 * this graph even has an authority to activate it — is decided in `validate-authority.ts`,
 * with the rest of the authority boundary.
 */
function validateSubscription(subscription: SubscriptionDef, context: Context): void {
  requireKind(
    subscription.integrationId,
    'integration',
    subscription.id,
    context,
    VALIDATION_CODES.unknownIntegration,
  );
  requireKind(subscription.eventId, 'event', subscription.id, context, VALIDATION_CODES.unknownEvent);

  // Configuration is evaluated once, at activation, in the root scope: there is no delivery
  // to read yet, so nothing beyond state can be in scope.
  for (const argument of Object.values(subscription.arguments ?? {})) {
    validateExpression(argument, subscription.id, context, emptyScope());
  }

  if (subscriptionQueueLimit(subscription) < 1) {
    context.errors.push({
      code: VALIDATION_CODES.subscriptionInvalidPolicy,
      message: `Subscription ${subscription.name ?? subscription.id} declares a queue depth below one, which could hold no delivery at all`,
      nodeId: subscription.id,
      details: { maxQueued: subscription.delivery?.maxQueued },
    });
  }
  const backpressure = subscriptionBackpressure(subscription);
  if (!SUBSCRIPTION_BACKPRESSURE_POLICIES.includes(backpressure)) {
    context.errors.push({
      code: VALIDATION_CODES.subscriptionInvalidPolicy,
      message: `Subscription ${subscription.name ?? subscription.id} declares an unknown backpressure policy "${String(backpressure)}"`,
      nodeId: subscription.id,
      details: { known: [...SUBSCRIPTION_BACKPRESSURE_POLICIES] },
    });
  }
  if ((subscription.delivery?.maxAttempts ?? 1) < 1) {
    context.errors.push({
      code: VALIDATION_CODES.subscriptionInvalidPolicy,
      message: `Subscription ${subscription.name ?? subscription.id} declares fewer than one delivery attempt, so no delivery could ever be processed`,
      nodeId: subscription.id,
    });
  }

  // A deduplication key names a field of the payload, so it has to be one. A key that
  // resolved to nothing would silently deduplicate every delivery against `undefined`.
  const deduplicateBy = subscription.delivery?.deduplicateBy;
  if (deduplicateBy !== undefined) {
    const event = context.nodes.get(subscription.eventId);
    const payloadType = event?.kind === 'event' ? event.payloadType : undefined;
    const resolved = payloadType ? resolveKnownType(payloadType) : undefined;
    const entity = resolved?.kind === 'entity' ? context.nodes.get(resolved.entityId) : undefined;
    const declared = entity?.kind === 'entity' && entity.fields.some((field) => field.id === deduplicateBy);
    if (!declared) {
      context.errors.push({
        code: VALIDATION_CODES.subscriptionInvalidPolicy,
        message: `Subscription ${subscription.name ?? subscription.id} deduplicates on ${deduplicateBy}, which is not a field of ${subscription.eventId}'s payload entity`,
        nodeId: subscription.id,
        fieldId: deduplicateBy,
      });
    }
  }
}

/** A store's own declaration: a canonical blob entity, and rules written over real state. */
function validateStorage(storage: StorageDef, context: Context): void {
  requireKind(storage.blobEntityId, 'entity', storage.id, context, VALIDATION_CODES.unknownStorage);
  const entity = context.nodes.get(storage.blobEntityId);
  if (entity?.kind === 'entity') {
    const declared = new Set(entity.fields.map((field) => field.id));
    const missing = BLOB_REF_FIELDS.filter((field) => !declared.has(field));
    if (missing.length > 0) {
      context.errors.push({
        code: VALIDATION_CODES.invalidBlobEntity,
        message: `Storage ${storage.name ?? storage.id} names ${storage.blobEntityId} as its BlobRef entity, but it does not declare ${missing.join(', ')}; build it with blobRefEntity()`,
        nodeId: storage.id,
        details: { missing: missing.map(String) },
      });
    }
  }
  // The requested blob is bound to the store's own id, the way an event trigger binds its
  // payload to the trigger's id.
  const scope = emptyScope(new Set([storage.id]));
  if (entity?.kind === 'entity') {
    scope.types.set(storage.id, entityType(storage.blobEntityId));
  }
  if (storage.readAuthorization) {
    validateExpression(storage.readAuthorization, storage.id, context, scope);
  }
  if (storage.uploadAuthorization) {
    validateExpression(storage.uploadAuthorization, storage.id, context, emptyScope());
  }
}

/**
 * A read policy's own declaration: it governs a real entity, its predicate is boolean, and
 * its row scope does not collide. Whether the predicate may read `PRINCIPAL` is the
 * authority boundary's job, checked in `validate-authority.ts`.
 */
/**
 * spec15 — an `AuthorizationPolicyDef`. Total over any input: a malformed policy produces a
 * structured `AUTHORIZATION_*` diagnostic, never a native exception (spec15 §36, §37).
 * `authorizationPolicyProblems` (core) covers structure + closed scope + determinism; the
 * cross-node ref check (does an `authorizationPolicy` id point here) is on the referencing
 * node's validator.
 */
function validateAuthorizationPolicyNode(policy: AuthorizationPolicyDef, context: Context): void {
  for (const problem of authorizationPolicyProblems(policy)) {
    context.errors.push({
      code: problem.code,
      message: problem.message,
      nodeId: (policy as { id?: NodeId })?.id,
    });
  }
}

/** Resolve an `authorizationPolicy` / `startPolicy` / `instanceAccessPolicy` id, if present. */
function requireAuthorizationPolicy(id: unknown, ownerId: NodeId, context: Context): void {
  if (id === undefined || id === null) return;
  const node = typeof id === 'string' ? context.nodes.get(id as NodeId) : undefined;
  if (!node || node.kind !== 'authorization-policy') {
    context.errors.push({
      code: VALIDATION_CODES.authorizationUnknownPolicy,
      message: `${ownerId} references authorization policy ${String(id)}, which is not an authorization-policy node`,
      nodeId: ownerId,
    });
  }
}

function validateReadPolicy(policy: ReadPolicyDef, context: Context): void {
  requireKind(policy.entityId, 'entity', policy.id, context, VALIDATION_CODES.unknownQueryEntity);
  const entity = context.nodes.get(policy.entityId);

  // At most one read policy per entity — two would mean the effective filter depends on
  // which the compiler happened to pick.
  const governing = [...context.nodes.values()].filter(
    (node): node is ReadPolicyDef => node.kind === 'read-policy' && node.entityId === policy.entityId,
  );
  if (governing.length > 1 && governing[0].id !== policy.id) {
    context.errors.push({
      code: VALIDATION_CODES.duplicateReadPolicy,
      message: `Read policy ${policy.id} governs ${policy.entityId}, which is already governed by ${governing[0].id}`,
      nodeId: policy.id,
      details: { entityId: String(policy.entityId), first: String(governing[0].id) },
    });
  }

  const scope = policyRowScope(policy.rowScopeId, policy.entityId, policy.id, context, entity);
  validateExpression(policy.predicate, policy.id, context, scope);
  if (isKnownNonBoolean(inferExpressionType(policy.predicate, context.semantics, scope.types))) {
    context.errors.push({
      code: VALIDATION_CODES.invalidReadPolicy,
      message: `Read policy ${policy.id}'s predicate is ${describeType(inferExpressionType(policy.predicate, context.semantics, scope.types))}, not a boolean`,
      nodeId: policy.id,
    });
  }
  // A read policy predicate is AND-ed into a query filter and evaluated by the data
  // provider, in the same state-free scope as the query itself (spec13.1 F2, §82).
  for (const [id, node] of context.nodes) {
    if (node.kind !== 'state') continue;
    let referenced = false;
    walkExpression(policy.predicate, (expr) => {
      if (expr.kind === 'ref' && expr.targetId === id && expr.targetId !== policy.rowScopeId) referenced = true;
    });
    if (referenced) {
      context.errors.push({
        code: VALIDATION_CODES.queryStateRefNotAllowed,
        message: `Read policy ${policy.id} references StateDef ${String(id)}; a policy predicate runs on the data provider and cannot bind authority state.`,
        nodeId: policy.id,
      });
    }
  }
}

/** Builds the single-row scope a read policy or a query filter is evaluated in. */
function policyRowScope(
  rowScopeId: NodeId,
  entityId: NodeId,
  ownerId: NodeId,
  context: Context,
  entity: AnyNode | undefined,
): Scoped {
  if (context.nodes.has(rowScopeId)) {
    context.errors.push({
      code: VALIDATION_CODES.scopeCollidesWithNode,
      message: `Row scope ${rowScopeId} in ${ownerId} has the same id as a graph node`,
      nodeId: ownerId,
    });
  }
  const scope = emptyScope(new Set([rowScopeId]));
  if (entity?.kind === 'entity') {
    scope.types.set(rowScopeId, entityType(entityId));
  }
  return scope;
}

/**
 * A relationship's own declaration: two real entities, two real fields on them, and
 * endpoints consistent with the declared cardinality. Axiom never *infers* a link, so this
 * is where an inconsistent explicit one is caught.
 */
/**
 * A `WorkflowDef`'s structural soundness (spec14 §121-§125). Every failure is a structured
 * diagnostic — never a thrown `TypeError` on a malformed step.
 */
function validateWorkflow(workflow: WorkflowDef, context: Context): void {
  requireAuthorizationPolicy((workflow as { startPolicy?: unknown }).startPolicy, workflow.id, context);
  requireAuthorizationPolicy((workflow as { instanceAccessPolicy?: unknown }).instanceAccessPolicy, workflow.id, context);
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object' || typeof (step as { id?: unknown }).id !== 'string') {
      context.errors.push({
        code: VALIDATION_CODES.workflowInvalidStep,
        message: `Workflow ${workflow.id} has a step with no id`,
        nodeId: workflow.id,
      });
      continue;
    }
    const id = String(step.id);
    if (stepIds.has(id) || context.nodes.has(step.id)) {
      context.errors.push({
        code: VALIDATION_CODES.workflowDuplicateStepId,
        message: `Workflow ${workflow.id} step id ${id} is declared twice, or collides with a graph node`,
        nodeId: workflow.id,
      });
    }
    stepIds.add(id);
    if (!WORKFLOW_STEP_TYPES.includes((step as { type?: WorkflowStepType }).type as WorkflowStepType)) {
      context.errors.push({
        code: VALIDATION_CODES.workflowInvalidStep,
        message: `Workflow ${workflow.id} step ${id} has an unknown type ${String((step as { type?: unknown }).type)}`,
        nodeId: workflow.id,
      });
    }
  }

  if (!workflow.entry || !stepIds.has(String(workflow.entry))) {
    context.errors.push({
      code: VALIDATION_CODES.workflowEntryNotFound,
      message: `Workflow ${workflow.id} entry ${String(workflow.entry)} is not one of its steps`,
      nodeId: workflow.id,
    });
  }

  const edge = (target: unknown, from: string): void => {
    if (target !== undefined && !stepIds.has(String(target))) {
      context.errors.push({
        code: VALIDATION_CODES.workflowStepNotFound,
        message: `Workflow ${workflow.id} step ${from} points at ${String(target)}, which is not a step`,
        nodeId: workflow.id,
      });
    }
  };

  // Bindings: declared once, produced by exactly one declared step.
  const declaredBindings = new Map<string, WorkflowBinding>();
  for (const binding of workflow.bindings ?? []) {
    const bid = String(binding.id);
    if (declaredBindings.has(bid)) {
      context.errors.push({
        code: VALIDATION_CODES.workflowDuplicateBinding,
        message: `Workflow ${workflow.id} declares binding ${bid} twice`,
        nodeId: workflow.id,
      });
    }
    declaredBindings.set(bid, binding);
    if (!stepIds.has(String(binding.producedBy))) {
      context.errors.push({
        code: VALIDATION_CODES.workflowStepNotFound,
        message: `Workflow ${workflow.id} binding ${bid} is producedBy ${String(binding.producedBy)}, which is not a step`,
        nodeId: workflow.id,
      });
    }
    validateTypeRef(binding.valueType, workflow.id, context);
  }

  const inputIds = new Set((workflow.inputs ?? []).map((input) => String(input.id)));
  for (const input of workflow.inputs ?? []) validateTypeRef(input.valueType, workflow.id, context);

  const boundBy = new Map<string, string>(); // bindingId -> step id that binds it
  for (const step of steps) {
    if (!step || typeof (step as { id?: unknown }).id !== 'string') continue;
    const from = String(step.id);
    const eventScopeOk = step.type === 'wait-event';

    // Control-flow edges resolve.
    if (step.type === 'action') {
      edge(step.next, from);
      edge(step.onError, from);
      requireKind(step.action, 'action', workflow.id, context, VALIDATION_CODES.workflowActionNotFound);
      if (step.retry) validateWorkflowRetry(step.retry, workflow.id, from, context);
    } else if (step.type === 'wait-event') {
      edge(step.next, from);
      edge(step.onTimeout, from);
      requireKind(step.event, 'event', workflow.id, context, VALIDATION_CODES.workflowEventNotFound);
      if (step.timeout && !(step.timeout.seconds > 0)) {
        context.errors.push({
          code: VALIDATION_CODES.workflowInvalidTimer,
          message: `Workflow ${workflow.id} step ${from} has a non-positive timeout`,
          nodeId: workflow.id,
        });
      }
      for (const bindingId of Object.keys(step.bind ?? {})) {
        if (!declaredBindings.has(bindingId)) {
          context.errors.push({
            code: VALIDATION_CODES.workflowBindingNotFound,
            message: `Workflow ${workflow.id} step ${from} binds ${bindingId}, which is not a declared WorkflowBinding`,
            nodeId: workflow.id,
          });
        } else if (String(declaredBindings.get(bindingId)!.producedBy) !== from) {
          context.errors.push({
            code: VALIDATION_CODES.workflowDuplicateBinding,
            message: `Workflow ${workflow.id} step ${from} binds ${bindingId}, but its declared producer is ${String(declaredBindings.get(bindingId)!.producedBy)}`,
            nodeId: workflow.id,
          });
        }
        if (boundBy.has(bindingId)) {
          context.errors.push({
            code: VALIDATION_CODES.workflowDuplicateBinding,
            message: `Workflow ${workflow.id} binding ${bindingId} is assigned by more than one step`,
            nodeId: workflow.id,
          });
        }
        boundBy.set(bindingId, from);
      }
    } else if (step.type === 'timer') {
      edge(step.next, from);
      const hasAfter = step.after !== undefined;
      const hasAt = step.at !== undefined;
      if (hasAfter === hasAt) {
        context.errors.push({
          code: VALIDATION_CODES.workflowInvalidTimer,
          message: `Workflow ${workflow.id} timer ${from} must declare exactly one of after / at`,
          nodeId: workflow.id,
        });
      } else if (hasAfter && !(step.after!.seconds > 0)) {
        context.errors.push({
          code: VALIDATION_CODES.workflowInvalidTimer,
          message: `Workflow ${workflow.id} timer ${from} has a non-positive after.seconds`,
          nodeId: workflow.id,
        });
      }
    } else if (step.type === 'branch') {
      edge(step.then, from);
      edge(step.else, from);
    }

    // Expression scope — inputs / bindings / (EVENT inside wait-event) / PRINCIPAL only.
    for (const expression of workflowStepExpressions(step)) {
      validateWorkflowExpression(expression, workflow.id, from, inputIds, declaredBindings, eventScopeOk, context);
    }
  }

  // Reachability + acyclicity + terminal reachability.
  const reachable = workflowReachableSteps(workflow);
  for (const step of steps) {
    const sid = step && typeof step === 'object' ? (step as { id?: unknown }).id : undefined;
    if (typeof sid === 'string' && !reachable.has(sid)) {
      context.errors.push({
        code: VALIDATION_CODES.workflowUnreachableStep,
        message: `Workflow ${workflow.id} step ${sid} is unreachable from entry`,
        nodeId: workflow.id,
      });
    }
  }
  if (stepIds.has(String(workflow.entry)) && workflowHasCycle(workflow)) {
    context.errors.push({
      code: VALIDATION_CODES.workflowCycleNotAllowed,
      message: `Workflow ${workflow.id} has a control-flow cycle; retries are runtime policy, not graph edges`,
      nodeId: workflow.id,
    });
  }
  // Every reachable non-terminal step must be able to reach a terminal step (or an
  // intentional wait-event with no timeout is an acceptable "may never resolve" leaf).
  if (stepIds.has(String(workflow.entry)) && !workflowHasCycle(workflow)) {
    const canTerminate = new Map<string, boolean>();
    const reaches = (id: string, seen: Set<string>): boolean => {
      if (canTerminate.has(id)) return canTerminate.get(id)!;
      if (seen.has(id)) return false;
      seen.add(id);
      const step = workflowStepById(workflow, id);
      if (!step) return false;
      if (step.type === 'complete' || step.type === 'fail') {
        canTerminate.set(id, true);
        return true;
      }
      if (step.type === 'wait-event' && !step.timeout) {
        // An unbounded wait is an intentional durable leaf (spec14 §123).
        const ok = workflowStepSuccessors(step).some((n) => reaches(String(n), new Set(seen)));
        canTerminate.set(id, ok || true);
        return true;
      }
      const ok = workflowStepSuccessors(step).some((n) => reaches(String(n), new Set(seen)));
      canTerminate.set(id, ok);
      return ok;
    };
    for (const id of reachable) {
      if (!reaches(id, new Set())) {
        context.errors.push({
          code: VALIDATION_CODES.workflowNoTerminal,
          message: `Workflow ${workflow.id} step ${id} cannot reach complete or fail`,
          nodeId: workflow.id,
        });
      }
    }
  }
}

function validateWorkflowRetry(
  retry: WorkflowRetryPolicy,
  workflowId: NodeId,
  stepId: string,
  context: Context,
): void {
  const bad =
    !(retry.maxAttempts >= 1) ||
    !(retry.initialDelaySeconds >= 0) ||
    !(retry.backoffMultiplier >= 1) ||
    !(retry.maxDelaySeconds >= retry.initialDelaySeconds);
  if (bad) {
    context.errors.push({
      code: VALIDATION_CODES.workflowInvalidRetryPolicy,
      message: `Workflow ${workflowId} step ${stepId} has an invalid retry policy`,
      nodeId: workflowId,
    });
  }
}

const WORKFLOW_NONDETERMINISTIC_BUILTINS = new Set(['now', 'uuid', 'random']);

function validateWorkflowExpression(
  expression: Expression,
  workflowId: NodeId,
  stepId: string,
  inputIds: ReadonlySet<string>,
  bindings: ReadonlyMap<string, WorkflowBinding>,
  eventScopeOk: boolean,
  context: Context,
): void {
  walkExpression(expression, (node) => {
    if (node.kind === 'ref') {
      const id = String(node.targetId);
      const inScope =
        inputIds.has(id) ||
        bindings.has(id) ||
        id === WORKFLOW_PRINCIPAL_SCOPE ||
        (eventScopeOk && id === WORKFLOW_EVENT_SCOPE);
      if (!inScope) {
        context.errors.push({
          code: VALIDATION_CODES.workflowExpressionScope,
          message: `Workflow ${workflowId} step ${stepId} references ${id}, which is outside workflow expression scope (inputs / bindings${eventScopeOk ? ' / EVENT' : ''} / PRINCIPAL)`,
          nodeId: workflowId,
        });
      }
    }
    if (node.kind === 'call' && WORKFLOW_NONDETERMINISTIC_BUILTINS.has(node.function)) {
      context.errors.push({
        code: VALIDATION_CODES.workflowNondeterministic,
        message: `Workflow ${workflowId} step ${stepId} calls ${node.function}; workflow expressions must be deterministic`,
        nodeId: workflowId,
      });
    }
  });
}

function validateRelationship(relationship: RelationshipDef, context: Context): void {
  const fromEntity = requireRelationshipEndpoint(relationship.from, relationship.id, context);
  const toEntity = requireRelationshipEndpoint(relationship.to, relationship.id, context);

  // A to-one traversal that did not land on the target's identity could match many rows;
  // a to-many traversal's source key must be the source identity for the same reason.
  if (relationshipIsToOne(relationship)) {
    if (toEntity && toEntity.identityFieldId !== relationship.to.fieldId) {
      context.errors.push({
        code: VALIDATION_CODES.invalidRelationship,
        message: `Relationship ${relationship.id} is to-one but ${relationship.to.fieldId} is not ${relationship.to.entityId}'s identity field`,
        nodeId: relationship.id,
      });
    }
  } else if (fromEntity && fromEntity.identityFieldId !== relationship.from.fieldId) {
    context.errors.push({
      code: VALIDATION_CODES.invalidRelationship,
      message: `Relationship ${relationship.id} is to-many but ${relationship.from.fieldId} is not ${relationship.from.entityId}'s identity field`,
      nodeId: relationship.id,
    });
  }

  // The linked fields must be comparable — a foreign key and an identity of different
  // primitive types can never match.
  const fromType = resolveKnownType(fieldTypeOf(relationship.from.fieldId, context));
  const toType = resolveKnownType(fieldTypeOf(relationship.to.fieldId, context));
  if (
    fromType?.kind === 'primitive' &&
    toType?.kind === 'primitive' &&
    fromType.primitive !== toType.primitive
  ) {
    context.errors.push({
      code: VALIDATION_CODES.invalidRelationship,
      message: `Relationship ${relationship.id} links ${describeType(fromType)} to ${describeType(toType)}; the two sides can never be equal`,
      nodeId: relationship.id,
    });
  }
}

function requireRelationshipEndpoint(
  endpoint: RelationshipDef['from'],
  ownerId: NodeId,
  context: Context,
): EntityDef | undefined {
  const node = context.nodes.get(endpoint.entityId);
  if (!node || node.kind !== 'entity') {
    context.errors.push({
      code: VALIDATION_CODES.unknownQueryEntity,
      message: `Relationship ${ownerId} names ${endpoint.entityId}, which is not an entity`,
      nodeId: ownerId,
    });
    return undefined;
  }
  if (context.fields.get(endpoint.fieldId) !== endpoint.entityId) {
    context.errors.push({
      code: VALIDATION_CODES.invalidRelationship,
      message: `Relationship ${ownerId} names ${endpoint.fieldId}, which is not a field of ${endpoint.entityId}`,
      nodeId: ownerId,
      fieldId: endpoint.fieldId,
    });
  }
  return node;
}

function fieldTypeOf(fieldId: FieldId, context: Context): TypeRef | undefined {
  const owner = context.fields.get(fieldId);
  const entity = owner ? context.nodes.get(owner) : undefined;
  if (entity?.kind !== 'entity') {
    return undefined;
  }
  return entity.fields.find((field) => field.id === fieldId)?.valueType;
}

/**
 * A query's own declaration. `validateGraph` rejects a query that could not execute rather
 * than letting it validate and fail at the provider (spec 0.10 §83-84): a dangling source,
 * a non-boolean filter, an unorderable sort key, a projection field that is not on the
 * projection entity, an aggregate over the wrong type, grouping without aggregation, an
 * unstable cursor ordering.
 */
function validateQuery(query: QueryDef, context: Context): void {
  requireKind(query.source, 'entity', query.id, context, VALIDATION_CODES.unknownQueryEntity);
  requireAuthorizationPolicy((query as { authorizationPolicy?: unknown }).authorizationPolicy, query.id, context);
  const source = context.nodes.get(query.source);
  const sourceEntity = source?.kind === 'entity' ? source : undefined;

  // The base scope every query expression is evaluated in: one source row, plus the typed
  // parameters. `PRINCIPAL` is resolvable through `context.scopes`.
  const scope = policyRowScope(query.rowScopeId, query.source, query.id, context, source);
  const seenParameters = new Set<string>();
  for (const parameter of query.parameters ?? []) {
    const key = String(parameter.id);
    if (seenParameters.has(key)) {
      context.errors.push({
        code: VALIDATION_CODES.invalidQueryParameter,
        message: `Query ${query.id} declares parameter ${parameter.id} more than once`,
        nodeId: query.id,
      });
    }
    seenParameters.add(key);
    if (context.nodes.has(parameter.id) || context.scopes.has(parameter.id) || scope.ids.has(parameter.id)) {
      context.errors.push({
        code: VALIDATION_CODES.invalidQueryParameter,
        message: `Query ${query.id} parameter ${parameter.id} collides with an existing id`,
        nodeId: query.id,
      });
    }
    validateTypeRef(parameter.valueType, query.id, context);
    scope.ids.add(parameter.id);
    scope.types.set(parameter.id, parameter.valueType);
  }

  // Relationships bind before the expression clauses that read them.
  for (const use of query.relationships ?? []) {
    requireKind(use.relationshipId, 'relationship', query.id, context, VALIDATION_CODES.unknownRelationship);
    const relationship = context.nodes.get(use.relationshipId);
    if (context.nodes.has(use.bindAs) || scope.ids.has(use.bindAs)) {
      context.errors.push({
        code: VALIDATION_CODES.invalidQueryParameter,
        message: `Query ${query.id} relationship bind ${use.bindAs} collides with an existing id`,
        nodeId: query.id,
      });
    }
    if (relationship?.kind === 'relationship') {
      if (relationship.from.entityId !== query.source) {
        context.errors.push({
          code: VALIDATION_CODES.invalidRelationship,
          message: `Query ${query.id} traverses ${use.relationshipId}, which starts from ${relationship.from.entityId}, not the query source ${query.source}`,
          nodeId: query.id,
        });
      }
      const target = entityType(relationship.to.entityId);
      scope.ids.add(use.bindAs);
      scope.types.set(use.bindAs, relationshipIsToOne(relationship) ? target : collectionType(target));
    }
  }

  // A QueryDef executes on the DataProvider, which binds no authority state. A `ref` to a
  // `StateDef` in any clause would evaluate to nothing at run time, so every layer — this
  // validator, the compiler, dependency analysis, live-capability, AgentAPI and the runtime
  // — must reject it rather than one accepting what the others cannot execute (spec13.1 F2).
  const knownStateIds = new Set<string>(
    [...context.nodes.values()].filter((node) => node.kind === 'state').map((node) => String(node.id)),
  );
  for (const stateId of queryStateReferences(query, knownStateIds)) {
    context.errors.push({
      code: VALIDATION_CODES.queryStateRefNotAllowed,
      message: `Query ${query.id} references StateDef ${stateId}; a QueryDef clause runs on the data provider and cannot bind authority state. Pass a runtime-varying value as a query parameter instead.`,
      nodeId: query.id,
    });
  }

  if (query.filter) {
    validateExpression(query.filter, query.id, context, scope);
    if (isKnownNonBoolean(inferExpressionType(query.filter, context.semantics, scope.types))) {
      context.errors.push({
        code: VALIDATION_CODES.invalidQueryPredicate,
        message: `Query ${query.id}'s filter is ${describeType(inferExpressionType(query.filter, context.semantics, scope.types))}, not a boolean`,
        nodeId: query.id,
      });
    }
  }

  for (const key of query.sort ?? []) {
    validateExpression(key.key, query.id, context, scope);
    const keyType = resolveKnownType(inferExpressionType(key.key, context.semantics, scope.types));
    if (keyType && !isOrderableType(keyType)) {
      context.errors.push({
        code: VALIDATION_CODES.invalidQuerySort,
        message: `Query ${query.id} sorts by ${describeType(keyType)}, which has no ordering`,
        nodeId: query.id,
      });
    }
    void sortKeyDirection(key);
  }

  if (query.projection) {
    requireKind(query.projection.entityId, 'entity', query.id, context, VALIDATION_CODES.invalidQueryProjection);
    for (const projected of query.projection.fields) {
      if (context.fields.get(projected.id) !== query.projection.entityId) {
        context.errors.push({
          code: VALIDATION_CODES.invalidQueryProjection,
          message: `Query ${query.id} projects ${projected.id}, which is not a field of ${query.projection.entityId}`,
          nodeId: query.id,
          fieldId: projected.id,
        });
      }
      validateExpression(projected.value, query.id, context, scope);
      const declaredType = fieldTypeOf(projected.id, context);
      const valueType = inferExpressionType(projected.value, context.semantics, scope.types);
      if (isObviouslyIncompatible(declaredType, valueType)) {
        context.errors.push({
          code: VALIDATION_CODES.invalidQueryProjection,
          message: `Query ${query.id} projects ${describeType(valueType)} into ${projected.id} (${describeType(declaredType)})`,
          nodeId: query.id,
          fieldId: projected.id,
        });
      }
    }
  }

  if ((query.groupBy?.length ?? 0) > 0 && (query.aggregate?.length ?? 0) === 0) {
    context.errors.push({
      code: VALIDATION_CODES.invalidQueryGrouping,
      message: `Query ${query.id} declares groupBy but no aggregate to compute per group`,
      nodeId: query.id,
    });
  }
  for (const key of query.groupBy ?? []) {
    validateExpression(key, query.id, context, scope);
    const keyType = resolveKnownType(inferExpressionType(key, context.semantics, scope.types));
    if (keyType && !isOrderableType(keyType)) {
      context.errors.push({
        code: VALIDATION_CODES.invalidQueryGrouping,
        message: `Query ${query.id} groups by ${describeType(keyType)}, which cannot be a group key`,
        nodeId: query.id,
      });
    }
  }

  for (const aggregate of query.aggregate ?? []) {
    if (aggregate.function === 'count') {
      if (aggregate.key) {
        context.errors.push({
          code: VALIDATION_CODES.invalidQueryAggregate,
          message: `Query ${query.id}'s count aggregate carries a key; count reduces rows, not a projection`,
          nodeId: query.id,
        });
      }
    } else if (!aggregate.key) {
      context.errors.push({
        code: VALIDATION_CODES.invalidQueryAggregate,
        message: `Query ${query.id}'s ${aggregate.function} aggregate needs a key expression to reduce`,
        nodeId: query.id,
      });
    } else {
      validateExpression(aggregate.key, query.id, context, scope);
      const keyType = resolveKnownType(inferExpressionType(aggregate.key, context.semantics, scope.types));
      const numericOnly = aggregate.function === 'sum' || aggregate.function === 'average';
      if (numericOnly && keyType && !(keyType.kind === 'primitive' && keyType.primitive === 'number')) {
        context.errors.push({
          code: VALIDATION_CODES.invalidQueryAggregate,
          message: `Query ${query.id}'s ${aggregate.function} aggregate reduces ${describeType(keyType)}, which is not numeric`,
          nodeId: query.id,
        });
      }
      if (!numericOnly && keyType && !isOrderableType(keyType)) {
        context.errors.push({
          code: VALIDATION_CODES.invalidQueryAggregate,
          message: `Query ${query.id}'s ${aggregate.function} aggregate reduces ${describeType(keyType)}, which has no ordering`,
          nodeId: query.id,
        });
      }
    }
    if (!aggregate.as) {
      context.errors.push({
        code: VALIDATION_CODES.invalidQueryAggregate,
        message: `Query ${query.id} has an aggregate with no result field`,
        nodeId: query.id,
      });
    }
  }

  // Cursor pagination requires a deterministic total order. Axiom appends canonical
  // identity as the tie-breaker (spec §11), so a source with no identity field and no
  // provably-unique sort key cannot paginate stably.
  const maxPageSize = query.pagination?.maxPageSize;
  if (maxPageSize !== undefined && !(maxPageSize > 0)) {
    context.errors.push({
      code: VALIDATION_CODES.invalidQueryParameter,
      message: `Query ${query.id} declares a non-positive maxPageSize`,
      nodeId: query.id,
    });
  }
  if (queryPaginationStrategy(query) === 'cursor' && sourceEntity && !sourceEntity.identityFieldId) {
    context.errors.push({
      code: VALIDATION_CODES.unstablePagination,
      message: `Query ${query.id} uses cursor pagination but ${query.source} has no identity field to break ties on`,
      nodeId: query.id,
    });
  }

  if (query.readPolicyId !== undefined) {
    requireKind(query.readPolicyId, 'read-policy', query.id, context, VALIDATION_CODES.unknownReadPolicy);
    const policy = context.nodes.get(query.readPolicyId);
    if (policy?.kind === 'read-policy' && policy.entityId !== query.source) {
      context.errors.push({
        code: VALIDATION_CODES.invalidReadPolicy,
        message: `Query ${query.id} names read policy ${query.readPolicyId}, which governs ${policy.entityId}, not the query source ${query.source}`,
        nodeId: query.id,
      });
    }
  }
}

/** A resolved type that is known and is not a boolean primitive. */
function isKnownNonBoolean(type: TypeRef | undefined): boolean {
  const resolved = resolveKnownType(type);
  return resolved !== undefined && !(resolved.kind === 'primitive' && resolved.primitive === 'boolean');
}

/** Types that carry a total order a provider can sort or compare by. */
function isOrderableType(type: TypeRef | undefined): boolean {
  const resolved = resolveKnownType(type);
  if (!resolved) {
    return true;
  }
  if (resolved.kind === 'enum') {
    return true;
  }
  return (
    resolved.kind === 'primitive' &&
    ['string', 'number', 'boolean', 'date', 'datetime'].includes(resolved.primitive)
  );
}

function checkIntegrationArguments(
  operation: IntegrationOperationDef,
  args: Record<string, Expression>,
  ownerId: NodeId,
  context: Context,
): void {
  const declared = new Set((operation.parameters ?? []).map((parameter) => String(parameter.id)));
  const missing = (operation.parameters ?? [])
    .filter((parameter) => parameter.required && !(String(parameter.id) in args))
    .map((parameter) => String(parameter.id));
  if (missing.length > 0) {
    context.errors.push({
      code: VALIDATION_CODES.integrationArgumentMismatch,
      message: `${ownerId} calls ${operation.id} without ${missing.join(', ')}`,
      nodeId: ownerId,
      details: { operationId: String(operation.id), missing },
    });
  }
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) {
      context.errors.push({
        code: VALIDATION_CODES.integrationArgumentMismatch,
        message: `${ownerId} supplies unknown argument ${key} to ${operation.id}`,
        nodeId: ownerId,
        details: { operationId: String(operation.id), argument: key },
      });
    }
  }
}

/**
 * Extends a scope with an integration query's whole result type — unlike `iterationScope`,
 * the bound value is not unwrapped to a collection member.
 */
function resultScope(scope: Scoped, scopeId: NodeId, resultType: TypeRef | undefined, context: Context, ownerId: NodeId): Scoped {
  if (scope.ids.has(scopeId)) {
    context.errors.push({
      code: VALIDATION_CODES.scopeShadowing,
      message: `Scope ${scopeId} in ${ownerId} is already bound by an enclosing scope`,
      nodeId: ownerId,
    });
  }
  if (context.nodes.has(scopeId)) {
    context.errors.push({
      code: VALIDATION_CODES.scopeCollidesWithNode,
      message: `Scope ${scopeId} in ${ownerId} has the same id as a graph node`,
      nodeId: ownerId,
    });
  }
  const types = new Map(scope.types);
  if (resultType) {
    types.set(scopeId, resultType);
  } else {
    types.delete(scopeId);
  }
  return { ids: new Set([...scope.ids, scopeId]), types };
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
  // spec12.1 §52 (F3): malformed user graph data must produce a structured diagnostic, not
  // a JavaScript `TypeError`. A missing `TypeRef`, a non-object, or a missing `kind` — and,
  // in the branches below, a missing nested `itemType` / `valueType` / `keyType` or a
  // non-array `enum.values` — is reported and does not throw.
  if (type === null || typeof type !== 'object' || typeof (type as { kind?: unknown }).kind !== 'string') {
    context.errors.push({
      code: VALIDATION_CODES.invalidTypeRef,
      message: `Type reference in ${ownerId} is missing or malformed`,
      nodeId: ownerId,
      ...(field ? { fieldId: field } : {}),
    });
    return;
  }
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
    case 'group':
      validateTypeRef(type.keyType, ownerId, context, field);
      validateTypeRef(type.itemType, ownerId, context, field, true);
      return;
    case 'enum':
      if (!Array.isArray(type.values) || type.values.length === 0) {
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

function containsGroupType(type: TypeRef): boolean {
  // Null-safe: a malformed `TypeRef` is reported by `validateTypeRef`; this must not throw
  // (spec12.1 §52).
  if (type === null || typeof type !== 'object') {
    return false;
  }
  switch (type.kind) {
    case 'group':
      return true;
    case 'collection':
      return type.itemType !== undefined && containsGroupType(type.itemType);
    case 'optional':
      return type.valueType !== undefined && containsGroupType(type.valueType);
    default:
      return false;
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
  expressionInput: unknown,
  ownerId: NodeId,
  context: Context,
  local: Set<NodeId> | Scoped,
): void {
  const scope: Scoped = local instanceof Set ? emptyScope(local) : local;

  // spec16pt2 §12-24 — a candidate expression can be malformed (a deleted/tampered field,
  // an array-for-object mutation): establish shape before the switch below ever reads
  // `.kind`, exactly like the operation/location totality fix above.
  if (!isPlainObject(expressionInput) || typeof (expressionInput as { kind?: unknown }).kind !== 'string') {
    context.errors.push({
      code: VALIDATION_CODES.unsupportedExpression,
      message: `${ownerId} contains an expression that is not a recognized structure`,
      nodeId: ownerId,
    });
    return;
  }
  const expression = expressionInput as unknown as Expression;

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
    case 'field': {
      validateExpression(expression.source, ownerId, context, scope);
      const sourceType = resolveKnownType(
        inferExpressionType(expression.source, context.semantics, scope.types),
      );
      if (isGroupFieldId(expression.fieldId)) {
        // A group position is not a field of any entity, so it may only be read from a
        // group. Where the source type is unknown nothing is claimed, as everywhere else.
        if (sourceType && sourceType.kind !== 'group') {
          context.errors.push({
            code: VALIDATION_CODES.invalidGroupField,
            message: `${ownerId} reads ${expression.fieldId} from ${describeType(sourceType)}, which is not a group`,
            nodeId: ownerId,
            fieldId: expression.fieldId,
          });
        }
        return;
      }
      if (sourceType?.kind === 'group') {
        context.errors.push({
          code: VALIDATION_CODES.invalidGroupField,
          message:
            `${ownerId} reads ${expression.fieldId} from a group; a group has only ` +
            `${String(GROUP_KEY_FIELD)} and ${String(GROUP_ITEMS_FIELD)}. Read the members first.`,
          nodeId: ownerId,
          fieldId: expression.fieldId,
        });
        return;
      }
      requireField(expression.fieldId, ownerId, context);
      return;
    }
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
    case 'group': {
      validateExpression(expression.source, ownerId, context, scope);
      requireCollection(expression.source, ownerId, context, scope, 'group');
      validateExpression(
        expression.by,
        ownerId,
        context,
        iterationScope(scope, expression.scopeId, expression.source, context, ownerId),
      );
      return;
    }
    case 'expression-ref': {
      const definition = context.nodes.get(expression.expressionId);
      if (!definition || definition.kind !== 'expression') {
        context.errors.push({
          code: VALIDATION_CODES.unknownExpressionDef,
          message: `${ownerId} references ${expression.expressionId}, which is not an expression definition`,
          nodeId: ownerId,
          details: { expressionId: String(expression.expressionId) },
        });
        return;
      }
      const parameters = definition.parameters ?? [];
      const supplied = expression.arguments ?? {};
      for (const parameter of parameters) {
        // Every parameter must be supplied: an unbound one would resolve nothing at run
        // time, which is a construct that validates and then fails.
        if (supplied[String(parameter.id)] === undefined) {
          context.errors.push({
            code: VALIDATION_CODES.missingExpressionArgument,
            message: `${ownerId} uses ${definition.id} without supplying ${parameter.id}`,
            nodeId: ownerId,
            details: { expressionId: String(definition.id), parameterId: String(parameter.id) },
          });
        }
      }
      const declared = new Set(parameters.map((parameter) => String(parameter.id)));
      for (const [key, argument] of Object.entries(supplied)) {
        if (!declared.has(key)) {
          context.errors.push({
            code: VALIDATION_CODES.unknownExpressionArgument,
            message: `${ownerId} supplies ${key} to ${definition.id}, which declares no such parameter`,
            nodeId: ownerId,
            details: { expressionId: String(definition.id), parameterId: key },
          });
        }
        // Arguments are evaluated in the caller's scope, so they are validated in it.
        validateExpression(argument, ownerId, context, scope);
      }
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
