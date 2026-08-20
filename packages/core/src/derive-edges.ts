import { expressionFieldIds, walkExpression } from './expressions.js';
import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type { ActionDef, ConstraintDef, EdgeKind, EntityDef, GraphEdge, StateDef } from './nodes.js';
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

interface Linker {
  /** Links two nodes, optionally recording which fields the relationship concerns. */
  link(from: NodeId, to: NodeId, kind: EdgeKind, fieldIds?: readonly FieldId[]): void;
  /** Links a node to every state an expression reads. */
  reads(from: NodeId, expression: Expression, kind?: EdgeKind): void;
  /** Links a node to the state a location is rooted in. */
  writes(from: NodeId, location: Location, kind?: EdgeKind, extraFields?: readonly FieldId[]): void;
  /** States an id stands for: itself, or the collection an iteration scope iterates. */
  statesFor(id: NodeId): NodeId[];
}

/**
 * Recomputes the structural edges implied by node definitions. Edges index semantics
 * that already exist in the nodes, so they are derived rather than hand maintained:
 * any transformation that changes a node can simply re-run this pass.
 *
 * Write edges carry the fields they touch, so an agent can distinguish an action that
 * writes one field of a record from one that replaces the record.
 *
 * Edges added by hand (without the `derived` marker) are preserved.
 */
export function synchronizeEdges(graph: ApplicationGraph): GraphEdge[] {
  for (const edge of graph.listEdges()) {
    if (edge.metadata?.derived === true) {
      graph.removeEdge(edge.id);
    }
  }

  const nodes = graph.listNodes();
  const known = new Set<NodeId>(nodes.map((node) => node.id));
  const states = new Set<NodeId>(nodes.filter((node) => node.kind === 'state').map((node) => node.id));
  const pending = new Map<string, PendingEdge>();

  // An iteration scope stands for an item of whatever collection its repeat reads, so a
  // template that shows a field of the item still reads that field of the state.
  const scopeStates = new Map<NodeId, NodeId[]>();
  for (const node of nodes) {
    if (node.kind === 'repeat') {
      scopeStates.set(
        node.id,
        referencedIds(node.source).filter((id) => states.has(id)),
      );
    }
  }
  const resolveStates = (id: NodeId): NodeId[] => {
    if (states.has(id)) {
      return [id];
    }
    return scopeStates.get(id) ?? [];
  };

  const linker: Linker = {
    statesFor: resolveStates,
    link(from, to, kind, fieldIds = []) {
      if (from === to || !known.has(from) || !known.has(to)) {
        return;
      }
      const key = `${from}|${to}|${kind}`;
      const entry = pending.get(key) ?? { from, to, kind, fieldIds: new Set<FieldId>() };
      for (const fieldId of fieldIds) {
        entry.fieldIds.add(fieldId);
      }
      pending.set(key, entry);
    },
    reads(from, expression, kind = 'reads') {
      // Attribute a field to a state only where the expression actually reads that
      // state's field, so "reads X.name" never over-reports.
      const perState = new Map<NodeId, Set<FieldId>>();
      const referenced = new Set<NodeId>();
      walkExpression(expression, (node) => {
        if (node.kind === 'ref') {
          for (const stateId of resolveStates(node.targetId)) {
            referenced.add(stateId);
          }
        }
        if (node.kind === 'field' && node.source.kind === 'ref') {
          for (const stateId of resolveStates(node.source.targetId)) {
            const existing = perState.get(stateId) ?? new Set<FieldId>();
            existing.add(node.fieldId);
            perState.set(stateId, existing);
          }
        }
      });
      for (const id of referenced) {
        linker.link(from, id, kind, [...(perState.get(id) ?? [])]);
      }
    },
    writes(from, location, kind = 'writes', extraFields = []) {
      linker.link(from, locationRootStateId(location), kind, [
        ...locationFieldIds(location),
        ...extraFields,
      ]);
      // Addressing the location is itself a read of whatever the selectors consult.
      for (const expression of locationExpressions(location)) {
        linker.reads(from, expression);
      }
      const selectorFields = locationSelectorFieldIds(location);
      if (selectorFields.length > 0) {
        linker.link(from, locationRootStateId(location), 'reads', selectorFields);
      }
    },
  };

  for (const node of nodes) {
    if (isUINode(node)) {
      linkUiNode(node, linker);
      continue;
    }
    switch (node.kind) {
      case 'entity':
        linkEntity(node, linker);
        break;
      case 'state':
        linkState(node, linker);
        break;
      case 'action':
        linkAction(node, linker);
        break;
      case 'constraint':
        linkConstraint(node, linker);
        break;
      case 'route':
        linker.link(node.id, node.viewId, 'routes-to');
        break;
      default:
    }
  }

  for (const entry of pending.values()) {
    graph.addEdge(entry.from, entry.to, entry.kind, {
      metadata: {
        derived: true,
        ...(entry.fieldIds.size > 0 ? { fieldIds: [...entry.fieldIds] } : {}),
      },
    });
  }

  return graph.listEdges();
}

function linkEntity(entity: EntityDef, linker: Linker): void {
  for (const field of entity.fields) {
    for (const target of entityIdsIn(field.valueType)) {
      linker.link(entity.id, target, 'references', [field.id]);
    }
  }
}

function linkState(state: StateDef, linker: Linker): void {
  for (const target of entityIdsIn(state.valueType)) {
    linker.link(state.id, target, 'references');
  }
  if (state.derivation) {
    linker.reads(state.id, state.derivation, 'derives-from');
  }
}

function linkAction(action: ActionDef, linker: Linker): void {
  for (const expression of [...(action.preconditions ?? []), ...(action.postconditions ?? [])]) {
    linker.reads(action.id, expression);
  }
  for (const operation of action.operations ?? []) {
    switch (operation.kind) {
      case 'set':
        linker.writes(action.id, operation.target);
        linker.reads(action.id, operation.value);
        break;
      case 'insert':
        // Inserting a constructed record writes every field the record declares.
        linker.writes(action.id, operation.target, 'writes', expressionFieldIds(operation.value));
        linker.reads(action.id, operation.value);
        break;
      case 'remove':
        linker.writes(action.id, operation.target);
        break;
      case 'invoke':
        linker.link(action.id, operation.actionId, 'depends-on');
        for (const argument of Object.values(operation.arguments ?? {})) {
          linker.reads(action.id, argument);
        }
        break;
      case 'navigate':
        if (operation.routeId) {
          linker.link(action.id, operation.routeId, 'depends-on');
        }
        for (const argument of Object.values(operation.parameters ?? {})) {
          linker.reads(action.id, argument);
        }
        break;
      case 'native':
        for (const input of Object.values(operation.inputs ?? {})) {
          linker.reads(action.id, input);
        }
        if (operation.resultTarget) {
          linker.writes(action.id, operation.resultTarget);
        }
        for (const effect of operation.declaredEffects ?? []) {
          if (effect.kind === 'reads-state') {
            linker.link(action.id, effect.stateId, 'reads');
          }
          if (effect.kind === 'writes-state') {
            linker.link(action.id, effect.stateId, 'writes');
          }
        }
        break;
      default:
    }
  }
}

function linkConstraint(constraint: ConstraintDef, linker: Linker): void {
  if (constraint.entityId) {
    linker.link(constraint.id, constraint.entityId, 'constrains', expressionFieldIds(constraint.expression));
  }
  linker.reads(constraint.id, constraint.expression);
}

function linkUiNode(node: UINode, linker: Linker): void {
  if (node.visibleWhen) {
    linker.reads(node.id, node.visibleWhen);
  }
  switch (node.kind) {
    case 'view':
    case 'container':
      for (const childId of node.children) {
        linker.link(node.id, childId, 'contains');
      }
      return;
    case 'form':
      for (const childId of node.children) {
        linker.link(node.id, childId, 'contains');
      }
      linker.reads(node.id, node.target);
      if (node.submitActionId) {
        linker.link(node.id, node.submitActionId, 'invokes');
      }
      return;
    case 'conditional':
      for (const childId of [...node.whenTrue, ...(node.whenFalse ?? [])]) {
        linker.link(node.id, childId, 'contains');
      }
      linker.reads(node.id, node.condition);
      return;
    case 'repeat':
      linker.link(node.id, node.templateId, 'renders');
      if (node.emptyTemplateId) {
        linker.link(node.id, node.emptyTemplateId, 'renders');
      }
      linker.reads(node.id, node.source);
      return;
    case 'text':
      if (typeof node.value !== 'string') {
        linker.reads(node.id, node.value);
      }
      return;
    case 'field-display':
      for (const id of referencedIds(node.source).flatMap((target) => linker.statesFor(target))) {
        linker.link(node.id, id, 'reads', [node.fieldId]);
      }
      return;
    case 'input':
      // An input both reads and writes the location it is bound to.
      if (node.binding?.location) {
        linker.writes(node.id, node.binding.location, 'binds');
        linker.writes(node.id, node.binding.location, 'writes');
      }
      if (node.options) {
        linker.reads(node.id, node.options.source);
      }
      return;
    case 'button':
      linker.link(node.id, node.actionId, 'invokes');
      if (typeof node.label !== 'string') {
        linker.reads(node.id, node.label);
      }
      for (const argument of Object.values(node.arguments ?? {})) {
        linker.reads(node.id, argument);
      }
      return;
    default:
  }
}
