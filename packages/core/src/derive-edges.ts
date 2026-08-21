import { expressionFieldIds, walkExpression } from './expressions.js';
import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type {
  ActionDef,
  ConstraintDef,
  EdgeKind,
  EntityDef,
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
import { isUINode } from './ui.js';
import type { UINode } from './ui.js';
import type { AnyNode } from './types.js';
import type { ApplicationGraph } from './graph.js';

/** Ids a `ref` expression mentions anywhere in the tree. */
export function referencedIds(expression: Expression): NodeId[] {
  const found: NodeId[] = [];
  walkExpression(expression, (node) => {
    if (node.kind === 'ref') {
      found.push(node.targetId);
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

  // A repeat's template refers to the current item by the repeat node's own id.
  const rootScope = new Map<NodeId, readonly NodeId[]>();
  for (const node of nodes) {
    if (node.kind === 'repeat') {
      rootScope.set(node.id, statesOf(node.source, new Map(), states));
    }
  }

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
    for (const [stateId, fieldIds] of collectReads(expression, scope, states)) {
      link(from, stateId, kind, [...fieldIds]);
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
          link(node.id, node.entityId, 'constrains', expressionFieldIds(node.expression));
        }
        reads(node.id, node.expression, rootScope);
        break;
      case 'route':
        link(node.id, node.viewId, 'routes-to');
        break;
      default:
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

/** The states an expression ultimately draws its members from. */
function statesOf(expression: Expression, scope: ScopeBindings, states: ReadonlySet<NodeId>): NodeId[] {
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
      return statesOf(expression.source, scope, states);
    default:
      return [];
  }
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
      for (const stateId of statesOf(expression, scope, states)) {
        record(stateId);
      }
      return found;
    case 'field':
      for (const stateId of statesOf(expression.source, scope, states)) {
        record(stateId, expression.fieldId);
      }
      collectReads(expression.source, scope, states, found);
      return found;
    case 'object':
      for (const entry of expression.entries) {
        collectReads(entry.value, scope, states, found);
      }
      return found;
    case 'binary':
      collectReads(expression.left, scope, states, found);
      collectReads(expression.right, scope, states, found);
      return found;
    case 'unary':
      collectReads(expression.operand, scope, states, found);
      return found;
    case 'call':
      for (const argument of expression.arguments) {
        collectReads(argument, scope, states, found);
      }
      return found;
    case 'filter':
    case 'find':
    case 'map':
    case 'sort': {
      collectReads(expression.source, scope, states, found);
      const inner = bind(scope, expression.scopeId, statesOf(expression.source, scope, states));
      const body =
        expression.kind === 'map'
          ? expression.projection
          : expression.kind === 'sort'
            ? expression.by
            : expression.predicate;
      collectReads(body, inner, states, found);
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
        // Inserting a constructed record writes every field the record declares.
        linker.writes(actionId, operation.target, scope, 'writes', expressionFieldIds(operation.value));
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
