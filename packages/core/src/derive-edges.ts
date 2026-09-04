import { constructedFieldIds, expressionDefsIn, expressionFieldIds, walkExpression } from './expressions.js';
import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type {
  ActionDef,
  ConstraintDef,
  EdgeKind,
  EntityDef,
  ExpressionDef,
  GraphEdge,
  MutationOperation,
  Operation,
  StateDef,
} from './nodes.js';
import {
  locationExpressions,
  locationFieldIds,
  locationRootStateId,
  locationSelectorFieldIds,
} from './location.js';
import type { Location } from './location.js';
import type { TypeRef } from './type-ref.js';
import { isGroupFieldId } from './group.js';
import { isUINode } from './ui.js';
import type { UINode } from './ui.js';
import type { AnyNode } from './types.js';
import type { ApplicationGraph } from './graph.js';
import type { RelationshipDef } from './relationships.js';
import { queryExpressions } from './query.js';
import { workflowActionIds, workflowEventIds } from './workflows.js';
import { nodeAuthorizationPolicyRefs } from './authorization.js';

/**
 * Ids a `ref` expression mentions anywhere in the tree.
 *
 * A `resolve` function makes the walk follow `expression-ref` into the definition's body, so
 * a caller that asks "what does this expression read" gets the same answer whether the
 * calculation was written inline or named. Without one, only the arguments are seen —
 * which is right for a caller that is asking about this tree alone.
 */
export function referencedIds(
  expression: Expression,
  resolve?: (id: NodeId) => ExpressionDef | undefined,
  seen: Set<NodeId> = new Set(),
): NodeId[] {
  const found: NodeId[] = [];
  walkExpression(expression, (node) => {
    if (node.kind === 'ref') {
      found.push(node.targetId);
    }
    if (node.kind === 'expression-ref' && resolve && !seen.has(node.expressionId)) {
      seen.add(node.expressionId);
      const definition = resolve(node.expressionId);
      if (definition) {
        found.push(...referencedIds(definition.expression, resolve, seen));
      }
    }
  });
  return found;
}

function entityIdsIn(type: TypeRef): NodeId[] {
  switch (type.kind) {
    case 'entity':
      return [type.entityId];
    case 'collection':
      return entityIdsIn(type.itemType);
    case 'optional':
      return entityIdsIn(type.valueType);
    default:
      return [];
  }
}

interface PendingEdge {
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  fieldIds: Set<FieldId>;
}

/**
 * Which states an iteration scope stands for. An item of `filter(records, …)` is still an
 * item of `records`, so reading one of its fields is a read of `records`.
 */
type ScopeBindings = ReadonlyMap<NodeId, readonly NodeId[]>;

/**
 * Recomputes the structural edges implied by node definitions. Edges index semantics that
 * already exist in the nodes, so they are derived rather than hand maintained — see
 * `ApplicationGraph.semanticEdges()`, which keeps them current automatically.
 *
 * Write edges carry the fields they touch, so writing one field of a record is
 * distinguishable from writing another.
 */
export function deriveEdges(nodes: readonly AnyNode[]): GraphEdge[] {
  const known = new Set<NodeId>(nodes.map((node) => node.id));
  const states = new Set<NodeId>(nodes.filter((node) => node.kind === 'state').map((node) => node.id));
  const pending = new Map<string, PendingEdge>();

  // Named expressions, so a consumer's reads include what the definition reads.
  const defs = new Map<NodeId, ExpressionDef>(
    nodes.filter((node): node is ExpressionDef => node.kind === 'expression').map((node) => [node.id, node]),
  );

  // A repeat's template refers to the current item by the repeat node's own id.
  const rootScope = new Map<NodeId, readonly NodeId[]>();
  for (const node of nodes) {
    if (node.kind === 'repeat') {
      rootScope.set(node.id, statesOf(node.source, new Map(), states, defs));
    }
  }

  // Which states can hold instances of an entity, including nested ones. An entity-scoped
  // constraint reads its fields wherever those instances actually live.
  const entities = new Map<NodeId, EntityDef>(
    nodes.filter((node): node is EntityDef => node.kind === 'entity').map((node) => [node.id, node]),
  );
  const statesByEntity = new Map<NodeId, NodeId[]>();
  for (const node of nodes) {
    if (node.kind !== 'state' || node.draft || node.derivation) {
      continue;
    }
    for (const entityId of reachableEntities(node.valueType, entities)) {
      statesByEntity.set(entityId, [...(statesByEntity.get(entityId) ?? []), node.id]);
    }
  }
  const entityScope = (entityId: NodeId): ScopeBindings =>
    new Map([...rootScope, [entityId, statesByEntity.get(entityId) ?? []]]);

  const relationshipsById = new Map<NodeId, RelationshipDef>(
    nodes
      .filter((node): node is RelationshipDef => node.kind === 'relationship')
      .map((node) => [node.id, node]),
  );

  const link = (from: NodeId, to: NodeId, kind: EdgeKind, fieldIds: readonly FieldId[] = []): void => {
    if (from === to || !known.has(from) || !known.has(to)) {
      return;
    }
    const key = `${from}|${to}|${kind}`;
    const entry = pending.get(key) ?? { from, to, kind, fieldIds: new Set<FieldId>() };
    for (const fieldId of fieldIds) {
      entry.fieldIds.add(fieldId);
    }
    pending.set(key, entry);
  };

  const reads = (from: NodeId, expression: Expression, scope: ScopeBindings, kind: EdgeKind = 'reads'): void => {
    for (const [stateId, fieldIds] of collectReads(expression, scope, states, new Map(), defs)) {
      link(from, stateId, kind, [...fieldIds]);
    }
    // Using a named expression is a relationship in its own right: it is how "what depends
    // on this calculation" is answerable without re-walking every expression in the graph.
    for (const expressionId of expressionDefsIn(expression)) {
      link(from, expressionId, 'references');
    }
  };

  const writes = (
    from: NodeId,
    location: Location,
    scope: ScopeBindings,
    kind: EdgeKind = 'writes',
    extraFields: readonly FieldId[] = [],
  ): void => {
    link(from, locationRootStateId(location), kind, [...locationFieldIds(location), ...extraFields]);
    // Addressing the location is itself a read of whatever the selectors consult.
    for (const expression of locationExpressions(location)) {
      reads(from, expression, scope);
    }
    const selectorFields = locationSelectorFieldIds(location);
    if (selectorFields.length > 0) {
      link(from, locationRootStateId(location), 'reads', selectorFields);
    }
  };

  for (const node of nodes) {
    if (isUINode(node)) {
      linkUiNode(node, { link, reads, writes, scope: rootScope, states });
      continue;
    }
    switch (node.kind) {
      case 'entity':
        for (const field of node.fields) {
          for (const target of entityIdsIn(field.valueType)) {
            link(node.id, target, 'references', [field.id]);
          }
        }
        break;
      case 'state':
        linkState(node, link, reads, rootScope);
        break;
      case 'action':
        linkAction(node, { link, reads, writes, scope: rootScope, states });
        break;
      case 'constraint':
        if (node.entityId) {
          link(node.id, node.entityId, 'constrains', fieldsRead(node.expression, defs));
        }
        reads(node.id, node.expression, node.entityId ? entityScope(node.entityId) : rootScope);
        break;
      case 'transition-constraint': {
        link(node.id, node.entityId, 'constrains', fieldsRead(node.expression, defs));
        const holders = statesByEntity.get(node.entityId) ?? [];
        reads(
          node.id,
          node.expression,
          new Map([...rootScope, [node.previousScopeId, holders], [node.proposedScopeId, holders]]),
        );
        break;
      }
      case 'route':
        link(node.id, node.viewId, 'routes-to');
        break;
      case 'expression':
        // The body is evaluated in isolation, so it is analyzed in isolation: no repeat
        // bindings, no caller scope. Its parameters resolve to nothing here by design.
        reads(node.id, node.expression, new Map());
        break;
      case 'integration-operation':
        link(node.id, node.integrationId, 'references');
        break;
      case 'trigger':
        link(node.id, node.actionId, 'invokes');
        if (node.when.kind === 'event') {
          link(node.id, node.when.eventId, 'references');
        }
        if (node.when.kind === 'lifecycle' && node.when.routeId) {
          link(node.id, node.when.routeId, 'depends-on');
        }
        for (const argument of Object.values(node.arguments ?? {})) {
          reads(node.id, argument, rootScope);
        }
        if (node.enabledWhen) {
          reads(node.id, node.enabledWhen, rootScope);
        }
        break;
      case 'subscription':
        link(node.id, node.integrationId, 'references');
        link(node.id, node.eventId, 'references');
        for (const argument of Object.values(node.arguments ?? {})) {
          reads(node.id, argument, rootScope);
        }
        break;
      case 'storage':
        link(node.id, node.blobEntityId, 'references');
        if (node.readAuthorization) {
          reads(node.id, node.readAuthorization, new Map([...rootScope, [node.id, []]]));
        }
        if (node.uploadAuthorization) {
          reads(node.id, node.uploadAuthorization, rootScope);
        }
        break;
      case 'query': {
        link(node.id, node.source, 'references');
        if (node.readPolicyId) {
          link(node.id, node.readPolicyId, 'depends-on');
        }
        const scope = new Map<NodeId, readonly NodeId[]>([
          ...rootScope,
          [node.rowScopeId, statesByEntity.get(node.source) ?? []],
        ]);
        for (const use of node.relationships ?? []) {
          link(node.id, use.relationshipId, 'references');
          const relationship = relationshipsById.get(use.relationshipId);
          if (relationship) {
            scope.set(use.bindAs, statesByEntity.get(relationship.to.entityId) ?? []);
          }
        }
        for (const expression of queryExpressions(node)) {
          reads(node.id, expression, scope);
        }
        break;
      }
      case 'relationship':
        link(node.id, node.from.entityId, 'references', [node.from.fieldId]);
        link(node.id, node.to.entityId, 'references', [node.to.fieldId]);
        break;
      case 'read-policy':
        link(node.id, node.entityId, 'constrains');
        reads(
          node.id,
          node.predicate,
          new Map([...rootScope, [node.rowScopeId, statesByEntity.get(node.entityId) ?? []]]),
        );
        break;
      case 'workflow':
        // Workflow expressions are closed-scope (inputs / bindings / EVENT / PRINCIPAL —
        // spec14 §—, never StateDef), so there is nothing to attribute as a state read here.
        // What the graph *can* say is which actions a step may invoke and which events it
        // waits on, which is exactly what dependency/impact analysis needs (spec16 §12).
        for (const actionId of workflowActionIds(node)) {
          link(node.id, actionId, 'invokes');
        }
        for (const eventId of workflowEventIds(node)) {
          link(node.id, eventId, 'references');
        }
        break;
      case 'authorization-policy':
      case 'integration':
      case 'event':
        break;
      default:
    }
  }

  // Any node that references an `AuthorizationPolicyDef` (an action's or query's
  // `authorizationPolicy`, a workflow's `startPolicy` / `instanceAccessPolicy`) depends on
  // it — one generic pass over the closed set of policy-reference fields (spec15,
  // spec16 §12), rather than a hand-maintained case per node kind that references one.
  for (const node of nodes) {
    for (const policyId of nodeAuthorizationPolicyRefs(node)) {
      link(node.id, policyId as NodeId, 'references');
    }
  }

  return [...pending.values()].map((entry) => ({
    id: `${entry.from}:${entry.kind}:${entry.to}` as GraphEdge['id'],
    from: entry.from,
    to: entry.to,
    kind: entry.kind,
    metadata: {
      derived: true,
      ...(entry.fieldIds.size > 0 ? { fieldIds: [...entry.fieldIds] } : {}),
    },
  }));
}

/**
 * The states an expression ultimately draws its members from. Following `field` and calls
 * matters: a collection reached as `coalesce(field(ref(state), lines), [])` still comes
 * from that state, and its members' fields are still reads of it.
 */
function statesOf(
  expression: Expression,
  scope: ScopeBindings,
  states: ReadonlySet<NodeId>,
  defs: Definitions = new Map(),
): NodeId[] {
  switch (expression.kind) {
    case 'ref': {
      const bound = scope.get(expression.targetId);
      if (bound) {
        return [...bound];
      }
      return states.has(expression.targetId) ? [expression.targetId] : [];
    }
    case 'filter':
    case 'find':
    case 'sort':
    case 'map':
    case 'flatten':
    case 'group':
      return statesOf(expression.source, scope, states, defs);
    case 'conditional':
      return [
        ...new Set([
          ...statesOf(expression.whenTrue, scope, states, defs),
          ...statesOf(expression.whenFalse, scope, states, defs),
        ]),
      ];
    case 'field':
      return statesOf(expression.source, scope, states, defs);
    case 'call':
      return [
        ...new Set(expression.arguments.flatMap((argument) => statesOf(argument, scope, states, defs))),
      ];
    case 'expression-ref': {
      // A named calculation's members come from wherever its body draws them, which may be
      // an argument the caller supplied. Following it is what keeps a repeat over a reused
      // expression attributable to the state its rows actually live in.
      const definition = defs.get(expression.expressionId);
      if (!definition) {
        return [];
      }
      return statesOf(
        definition.expression,
        definitionScope(expression, definition, scope, states, defs),
        states,
        withoutDefinition(defs, expression.expressionId),
      );
    }
    default:
      return [];
  }
}

type Definitions = ReadonlyMap<NodeId, ExpressionDef>;

/**
 * Fields an expression reads, including those a named expression reads on its behalf.
 *
 * A rule that reuses a calculation constrains the same fields as one that inlined it, so
 * "which fields does this rule watch" must not depend on how it was written.
 */
function fieldsRead(expression: Expression, defs: Definitions, seen: Set<NodeId> = new Set()): FieldId[] {
  const found = new Set<FieldId>(expressionFieldIds(expression));
  for (const id of expressionDefsIn(expression)) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const definition = defs.get(id);
    if (definition) {
      for (const fieldId of fieldsRead(definition.expression, defs, seen)) {
        found.add(fieldId);
      }
    }
  }
  return [...found];
}

/** Stops a cyclic definition — which validation rejects — from recursing here. */
function withoutDefinition(defs: Definitions, id: NodeId): Definitions {
  const next = new Map(defs);
  next.delete(id);
  return next;
}

/**
 * The bindings a definition's body sees: its parameters bound to what the caller passed,
 * and nothing of the caller's own scope. The same isolation validation enforces.
 */
function definitionScope(
  reference: Expression & { kind: 'expression-ref' },
  definition: ExpressionDef,
  callerScope: ScopeBindings,
  states: ReadonlySet<NodeId>,
  defs: Definitions,
): ScopeBindings {
  const bindings = new Map<NodeId, readonly NodeId[]>();
  for (const parameter of definition.parameters ?? []) {
    const argument = reference.arguments?.[String(parameter.id)];
    bindings.set(parameter.id, argument ? statesOf(argument, callerScope, states, defs) : []);
  }
  return bindings;
}

/** Entities reachable from a type, following entity fields as well as collections. */
function reachableEntities(
  type: TypeRef,
  entities: ReadonlyMap<NodeId, EntityDef>,
  seen: Set<NodeId> = new Set(),
): NodeId[] {
  const found: NodeId[] = [];
  for (const entityId of entityIdsIn(type)) {
    if (seen.has(entityId)) {
      continue;
    }
    seen.add(entityId);
    found.push(entityId);
    for (const field of entities.get(entityId)?.fields ?? []) {
      found.push(...reachableEntities(field.valueType, entities, seen));
    }
  }
  return found;
}

function bind(scope: ScopeBindings, id: NodeId, targets: readonly NodeId[]): ScopeBindings {
  const next = new Map(scope);
  next.set(id, targets);
  return next;
}

/**
 * Reads an expression performs, as state id → fields. Iteration scopes are followed, so
 * projecting a field of each member is recorded as a read of that field of the state the
 * members came from.
 */
function collectReads(
  expression: Expression,
  scope: ScopeBindings,
  states: ReadonlySet<NodeId>,
  found: Map<NodeId, Set<FieldId>> = new Map(),
  defs: Definitions = new Map(),
): Map<NodeId, Set<FieldId>> {
  const record = (stateId: NodeId, fieldId?: FieldId): void => {
    const entry = found.get(stateId) ?? new Set<FieldId>();
    if (fieldId) {
      entry.add(fieldId);
    }
    found.set(stateId, entry);
  };

  switch (expression.kind) {
    case 'ref':
      for (const stateId of statesOf(expression, scope, states, defs)) {
        record(stateId);
      }
      return found;
    case 'field':
      for (const stateId of statesOf(expression.source, scope, states, defs)) {
        // A group's own positions belong to no entity, so they are not recorded as field
        // reads; reading them is still a read of the state the group was built from.
        record(stateId, isGroupFieldId(expression.fieldId) ? undefined : expression.fieldId);
      }
      collectReads(expression.source, scope, states, found, defs);
      return found;
    case 'object':
      for (const entry of expression.entries) {
        collectReads(entry.value, scope, states, found, defs);
      }
      return found;
    case 'binary':
      collectReads(expression.left, scope, states, found, defs);
      collectReads(expression.right, scope, states, found, defs);
      return found;
    case 'unary':
      collectReads(expression.operand, scope, states, found, defs);
      return found;
    case 'call':
      for (const argument of expression.arguments) {
        collectReads(argument, scope, states, found, defs);
      }
      return found;
    case 'filter':
    case 'find':
    case 'map':
    case 'sort':
    case 'every':
    case 'some':
    case 'group': {
      collectReads(expression.source, scope, states, found, defs);
      const inner = bind(scope, expression.scopeId, statesOf(expression.source, scope, states, defs));
      const body =
        expression.kind === 'map'
          ? expression.projection
          : expression.kind === 'sort' || expression.kind === 'group'
            ? expression.by
            : expression.predicate;
      collectReads(body, inner, states, found, defs);
      return found;
    }
    case 'flatten':
      collectReads(expression.source, scope, states, found, defs);
      return found;
    case 'conditional':
      collectReads(expression.condition, scope, states, found, defs);
      collectReads(expression.whenTrue, scope, states, found, defs);
      collectReads(expression.whenFalse, scope, states, found, defs);
      return found;
    case 'expression-ref': {
      // The arguments are read in the caller's scope; the body in the definition's own.
      for (const argument of Object.values(expression.arguments ?? {})) {
        collectReads(argument, scope, states, found, defs);
      }
      const definition = defs.get(expression.expressionId);
      if (definition) {
        collectReads(
          definition.expression,
          definitionScope(expression, definition, scope, states, defs),
          states,
          found,
          withoutDefinition(defs, expression.expressionId),
        );
      }
      return found;
    }
    default:
      return found;
  }
}

interface Linker {
  link(from: NodeId, to: NodeId, kind: EdgeKind, fieldIds?: readonly FieldId[]): void;
  reads(from: NodeId, expression: Expression, scope: ScopeBindings, kind?: EdgeKind): void;
  writes(
    from: NodeId,
    location: Location,
    scope: ScopeBindings,
    kind?: EdgeKind,
    extraFields?: readonly FieldId[],
  ): void;
  scope: ScopeBindings;
  states: ReadonlySet<NodeId>;
}

function linkState(
  state: StateDef,
  link: Linker['link'],
  reads: Linker['reads'],
  scope: ScopeBindings,
): void {
  for (const target of entityIdsIn(state.valueType)) {
    link(state.id, target, 'references');
  }
  if (state.derivation) {
    reads(state.id, state.derivation, scope, 'derives-from');
  }
}

function linkAction(action: ActionDef, linker: Linker): void {
  for (const expression of [...(action.preconditions ?? []), ...(action.postconditions ?? [])]) {
    linker.reads(action.id, expression, linker.scope);
  }
  linkOperations(action.id, action.operations ?? [], linker, linker.scope);
}

function linkOperations(
  actionId: NodeId,
  operations: readonly Operation[],
  linker: Linker,
  scope: ScopeBindings,
): void {
  for (const operation of operations) {
    switch (operation.kind) {
      case 'set':
        linker.writes(actionId, operation.target, scope);
        linker.reads(actionId, operation.value, scope);
        break;
      case 'insert':
        // A constructed record writes the fields it declares. Fields consulted while
        // computing those values are reads, and must not be reported as writes.
        linker.writes(actionId, operation.target, scope, 'writes', constructedFieldIds(operation.value));
        linker.reads(actionId, operation.value, scope);
        break;
      case 'remove':
        linker.writes(actionId, operation.target, scope);
        break;
      case 'for-each': {
        linker.reads(actionId, operation.collection, scope);
        const inner = bind(scope, operation.scopeId, statesOf(operation.collection, scope, linker.states));
        linkOperations(actionId, operation.operations as MutationOperation[], linker, inner);
        break;
      }
      case 'invoke':
        linker.link(actionId, operation.actionId, 'depends-on');
        for (const argument of Object.values(operation.arguments ?? {})) {
          linker.reads(actionId, argument, scope);
        }
        break;
      case 'navigate':
        if (operation.routeId) {
          linker.link(actionId, operation.routeId, 'depends-on');
        }
        for (const argument of Object.values(operation.parameters ?? {})) {
          linker.reads(actionId, argument, scope);
        }
        break;
      case 'native':
        for (const input of Object.values(operation.inputs ?? {})) {
          linker.reads(actionId, input, scope);
        }
        if (operation.resultTarget) {
          linker.writes(actionId, operation.resultTarget, scope);
        }
        for (const effect of operation.declaredEffects ?? []) {
          if (effect.kind === 'reads-state') {
            linker.link(actionId, effect.stateId, 'reads');
          }
          if (effect.kind === 'writes-state') {
            linker.link(actionId, effect.stateId, 'writes');
          }
        }
        break;
      case 'integration-query':
        linker.link(actionId, operation.operationId, 'references');
        for (const argument of Object.values(operation.arguments ?? {})) {
          linker.reads(actionId, argument, scope);
        }
        break;
      case 'integration-effect':
        linker.link(actionId, operation.operationId, 'references');
        for (const argument of Object.values(operation.arguments ?? {})) {
          linker.reads(actionId, argument, scope);
        }
        if (operation.idempotencyKey) {
          linker.reads(actionId, operation.idempotencyKey, scope);
        }
        if (operation.succeededEventId) {
          linker.link(actionId, operation.succeededEventId, 'references');
        }
        if (operation.failedEventId) {
          linker.link(actionId, operation.failedEventId, 'references');
        }
        break;
      case 'blob-metadata':
        linker.link(actionId, operation.storageId, 'references');
        linker.reads(actionId, operation.blobKey, scope);
        break;
      case 'blob-commit':
      case 'blob-delete':
        linker.link(actionId, operation.storageId, 'references');
        linker.reads(actionId, operation.blobKey, scope);
        if (operation.succeededEventId) {
          linker.link(actionId, operation.succeededEventId, 'references');
        }
        if (operation.failedEventId) {
          linker.link(actionId, operation.failedEventId, 'references');
        }
        break;
      case 'query':
        linker.link(actionId, operation.queryId, 'references');
        for (const argument of Object.values(operation.arguments ?? {})) {
          linker.reads(actionId, argument, scope);
        }
        break;
      default:
    }
  }
}

function linkUiNode(node: UINode, linker: Linker): void {
  const { link, reads, writes, scope } = linker;
  if (node.visibleWhen) {
    reads(node.id, node.visibleWhen, scope);
  }
  switch (node.kind) {
    case 'view':
    case 'container':
      for (const childId of node.children) {
        link(node.id, childId, 'contains');
      }
      return;
    case 'form':
      for (const childId of node.children) {
        link(node.id, childId, 'contains');
      }
      reads(node.id, node.target, scope);
      if (node.submitActionId) {
        link(node.id, node.submitActionId, 'invokes');
      }
      return;
    case 'conditional':
      for (const childId of [...node.whenTrue, ...(node.whenFalse ?? [])]) {
        link(node.id, childId, 'contains');
      }
      reads(node.id, node.condition, scope);
      return;
    case 'repeat':
      link(node.id, node.templateId, 'renders');
      if (node.emptyTemplateId) {
        link(node.id, node.emptyTemplateId, 'renders');
      }
      reads(node.id, node.source, scope);
      return;
    case 'text':
      if (typeof node.value !== 'string') {
        reads(node.id, node.value, scope);
      }
      return;
    case 'field-display':
      for (const stateId of statesOf(node.source, scope, linker.states)) {
        link(node.id, stateId, 'reads', [node.fieldId]);
      }
      reads(node.id, node.source, scope);
      return;
    case 'input':
      // An input both reads and writes the location it is bound to.
      if (node.binding?.location) {
        writes(node.id, node.binding.location, scope, 'binds');
        writes(node.id, node.binding.location, scope, 'writes');
      }
      if (node.options) {
        reads(node.id, node.options.source, scope);
      }
      return;
    case 'button':
      link(node.id, node.actionId, 'invokes');
      if (typeof node.label !== 'string') {
        reads(node.id, node.label, scope);
      }
      for (const argument of Object.values(node.arguments ?? {})) {
        reads(node.id, argument, scope);
      }
      return;
    default:
  }
}

/**
 * Writes the derived edges into the graph. Queries derive them on demand, so this is only
 * needed to materialize edges into serialized graph data.
 */
export function synchronizeEdges(graph: ApplicationGraph): GraphEdge[] {
  for (const edge of graph.listEdges()) {
    if (edge.metadata?.derived === true) {
      graph.removeEdge(edge.id);
    }
  }
  for (const edge of deriveEdges(graph.listNodes())) {
    graph.addEdge(edge.from, edge.to, edge.kind, { id: edge.id, metadata: edge.metadata });
  }
  return graph.listEdges();
}
