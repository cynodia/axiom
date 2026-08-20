import { walkExpression } from './expressions.js';
import type { Expression } from './expressions.js';
import type { NodeId } from './ids.js';
import type { ActionDef, ConstraintDef, EdgeKind, EntityDef, GraphEdge, StateDef } from './nodes.js';
import type { TypeRef } from './type-ref.js';
import { isUINode } from './ui.js';
import type { UINode } from './ui.js';
import type { ApplicationGraph } from './graph.js';

const DERIVED = { derived: true } as const;

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

/**
 * Recomputes the structural edges implied by node definitions. Edges are an index over
 * the semantics already present in the nodes, so they are derived rather than hand
 * maintained: any transformation that changes a node can simply re-run this pass.
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

  const link = (from: NodeId, to: NodeId, kind: EdgeKind): void => {
    if (from === to || !known.has(from) || !known.has(to)) {
      return;
    }
    graph.addEdge(from, to, kind, { metadata: { ...DERIVED } });
  };

  const linkReads = (from: NodeId, expression: Expression, kind: EdgeKind = 'reads'): void => {
    for (const id of referencedIds(expression)) {
      if (states.has(id)) {
        link(from, id, kind);
      }
    }
  };

  for (const node of nodes) {
    if (isUINode(node)) {
      linkUiNode(node, link, linkReads);
      continue;
    }
    switch (node.kind) {
      case 'entity':
        linkEntity(node, link);
        break;
      case 'state':
        linkState(node, link, linkReads);
        break;
      case 'action':
        linkAction(node, link, linkReads);
        break;
      case 'constraint':
        linkConstraint(node, link, linkReads);
        break;
      case 'route':
        link(node.id, node.viewId, 'routes-to');
        break;
      default:
    }
  }

  return graph.listEdges();
}

type Link = (from: NodeId, to: NodeId, kind: EdgeKind) => void;
type LinkReads = (from: NodeId, expression: Expression, kind?: EdgeKind) => void;

function linkEntity(entity: EntityDef, link: Link): void {
  for (const field of entity.fields) {
    for (const target of entityIdsIn(field.valueType)) {
      link(entity.id, target, 'references');
    }
  }
}

function linkState(state: StateDef, link: Link, linkReads: LinkReads): void {
  for (const target of entityIdsIn(state.valueType)) {
    link(state.id, target, 'references');
  }
  if (state.derivation) {
    linkReads(state.id, state.derivation, 'derives-from');
  }
}

function linkAction(action: ActionDef, link: Link, linkReads: LinkReads): void {
  for (const expression of [...(action.preconditions ?? []), ...(action.postconditions ?? [])]) {
    linkReads(action.id, expression);
  }
  for (const operation of action.operations ?? []) {
    switch (operation.kind) {
      case 'set-state':
        link(action.id, operation.stateId, 'writes');
        linkReads(action.id, operation.value);
        break;
      case 'add-item':
        link(action.id, operation.collectionId, 'writes');
        linkReads(action.id, operation.value);
        break;
      case 'remove-item':
        link(action.id, operation.collectionId, 'writes');
        linkReads(action.id, operation.item);
        break;
      case 'update-field':
        linkReads(action.id, operation.target, 'writes');
        linkReads(action.id, operation.value);
        break;
      case 'invoke':
        link(action.id, operation.actionId, 'depends-on');
        for (const argument of Object.values(operation.arguments ?? {})) {
          linkReads(action.id, argument);
        }
        break;
      case 'navigate':
        if (operation.routeId) {
          link(action.id, operation.routeId, 'depends-on');
        }
        for (const argument of Object.values(operation.parameters ?? {})) {
          linkReads(action.id, argument);
        }
        break;
      case 'native':
        for (const effect of operation.declaredEffects ?? []) {
          if (effect.kind === 'reads-state') {
            link(action.id, effect.stateId, 'reads');
          }
          if (effect.kind === 'writes-state') {
            link(action.id, effect.stateId, 'writes');
          }
        }
        break;
      default:
    }
  }
}

function linkConstraint(constraint: ConstraintDef, link: Link, linkReads: LinkReads): void {
  if (constraint.entityId) {
    link(constraint.id, constraint.entityId, 'constrains');
  }
  linkReads(constraint.id, constraint.expression);
}

function linkUiNode(node: UINode, link: Link, linkReads: LinkReads): void {
  if (node.visibleWhen) {
    linkReads(node.id, node.visibleWhen);
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
      linkReads(node.id, node.target);
      if (node.submitActionId) {
        link(node.id, node.submitActionId, 'invokes');
      }
      return;
    case 'conditional':
      for (const childId of [...node.whenTrue, ...(node.whenFalse ?? [])]) {
        link(node.id, childId, 'contains');
      }
      linkReads(node.id, node.condition);
      return;
    case 'repeat':
      link(node.id, node.templateId, 'renders');
      if (node.emptyTemplateId) {
        link(node.id, node.emptyTemplateId, 'renders');
      }
      linkReads(node.id, node.source);
      return;
    case 'text':
      if (typeof node.value !== 'string') {
        linkReads(node.id, node.value);
      }
      return;
    case 'field-display':
      linkReads(node.id, node.source);
      return;
    case 'input':
      linkReads(node.id, node.binding.target, 'binds');
      if (node.options) {
        linkReads(node.id, node.options.source);
      }
      return;
    case 'button':
      link(node.id, node.actionId, 'invokes');
      if (typeof node.label !== 'string') {
        linkReads(node.id, node.label);
      }
      for (const argument of Object.values(node.arguments ?? {})) {
        linkReads(node.id, argument);
      }
      return;
    default:
  }
}
