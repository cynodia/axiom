import { isUINode, referencedIds } from '@axiom/core';
import type {
  ActionDef,
  AnyNode,
  ApplicationGraph,
  ConstraintDef,
  EdgeKind,
  EntityDef,
  Expression,
  FieldId,
  FormNode,
  GraphEdge,
  NodeId,
  StateDef,
  UINode,
  ViewNode,
} from '@axiom/core';

export interface SubgraphRequest {
  root: NodeId;
  depth?: number;
  edgeKinds?: readonly EdgeKind[];
}

export interface Subgraph {
  nodes: AnyNode[];
  edges: GraphEdge[];
}

const READ_KINDS: readonly EdgeKind[] = ['reads', 'binds', 'derives-from'];
const WRITE_KINDS: readonly EdgeKind[] = ['writes'];
const CONTAINMENT_KINDS: readonly EdgeKind[] = ['contains', 'renders'];

export class GraphQueries {
  constructor(protected graph: ApplicationGraph) {}

  getNode(id: NodeId): AnyNode | undefined {
    return this.graph.getNode(id);
  }

  getField(id: FieldId) {
    return this.graph.getField(id);
  }

  getEdges(id: NodeId, kinds?: readonly EdgeKind[]): GraphEdge[] {
    return this.graph.getEdges(id, kinds ? { kinds } : {});
  }

  getDependencies(id: NodeId, kinds?: readonly EdgeKind[]): AnyNode[] {
    return this.resolve(this.graph.getOutgoingEdges(id, kinds ? { kinds } : {}).map((edge) => edge.to));
  }

  getDependents(id: NodeId, kinds?: readonly EdgeKind[]): AnyNode[] {
    return this.resolve(this.graph.getIncomingEdges(id, kinds ? { kinds } : {}).map((edge) => edge.from));
  }

  /** Nodes that read a state: views, derived state and action conditions. */
  getReaders(stateId: NodeId): AnyNode[] {
    return this.getDependents(stateId, READ_KINDS);
  }

  /** Actions that mutate a state. */
  getWriters(stateId: NodeId): ActionDef[] {
    return this.getDependents(stateId, WRITE_KINDS).filter(
      (node): node is ActionDef => node.kind === 'action',
    );
  }

  /** States whose value type mentions the entity. */
  getStatesForEntity(entityId: NodeId): StateDef[] {
    return this.graph
      .getNodesByKind('state')
      .filter((state) =>
        this.graph
          .getOutgoingEdges(state.id, { kinds: ['references'] })
          .some((edge) => edge.to === entityId),
      );
  }

  getConstraintsForEntity(entityId: NodeId): ConstraintDef[] {
    return this.graph.getNodesByKind('constraint').filter((constraint) => constraint.entityId === entityId);
  }

  /** Actions that write a state holding the entity, or that construct instances of it. */
  getActionsForEntity(entityId: NodeId): ActionDef[] {
    const stateIds = new Set(this.getStatesForEntity(entityId).map((state) => state.id));
    return this.graph.getNodesByKind('action').filter((action) => {
      const touchesState = this.graph
        .getOutgoingEdges(action.id, { kinds: ['writes'] })
        .some((edge) => stateIds.has(edge.to));
      if (touchesState) {
        return true;
      }
      return (action.operations ?? []).some((operation) =>
        'value' in operation && operation.value.kind === 'object'
          ? operation.value.entityId === entityId
          : false,
      );
    });
  }

  /** Every UI node that binds or displays one of the entity's fields. */
  getUiNodesForEntity(entityId: NodeId): UINode[] {
    const fieldIds = new Set<FieldId>(
      (this.graph.getNode<EntityDef>(entityId)?.fields ?? []).map((field) => field.id),
    );
    return this.graph
      .listNodes()
      .filter((node): node is UINode => isUINode(node))
      .filter((node) => {
        if (node.kind === 'input') {
          return fieldIds.has(node.binding.fieldId);
        }
        if (node.kind === 'field-display') {
          return fieldIds.has(node.fieldId);
        }
        return false;
      });
  }

  /** Views that render any UI node touching the entity. */
  getViewsForEntity(entityId: NodeId): ViewNode[] {
    const views = new Map<NodeId, ViewNode>();
    for (const node of this.getUiNodesForEntity(entityId)) {
      for (const view of this.enclosingViews(node.id)) {
        views.set(view.id, view);
      }
    }
    return [...views.values()];
  }

  /** Forms that edit the entity — where a new field usually needs an input. */
  getFormsForEntity(entityId: NodeId): FormNode[] {
    const forms = new Map<NodeId, FormNode>();
    for (const node of this.getUiNodesForEntity(entityId)) {
      if (node.kind !== 'input') {
        continue;
      }
      for (const ancestor of this.ancestors(node.id)) {
        if (ancestor.kind === 'form') {
          forms.set(ancestor.id, ancestor);
        }
      }
    }
    return [...forms.values()];
  }

  /** Actions an agent should treat as destructive, declared or inferred. */
  findDestructiveActions(): ActionDef[] {
    return this.graph
      .getNodesByKind('action')
      .filter(
        (action) =>
          action.destructive === true ||
          (action.operations ?? []).some((operation) => operation.kind === 'remove-item'),
      );
  }

  /**
   * The neighbourhood of a node, optionally restricted to particular relationships.
   * This is the query an agent uses instead of reading files.
   */
  getSubgraph(request: SubgraphRequest): Subgraph {
    const depth = request.depth ?? 1;
    const query = request.edgeKinds ? { kinds: request.edgeKinds } : {};
    const visited = new Set<NodeId>([request.root]);
    const edges = new Map<string, GraphEdge>();
    let frontier: NodeId[] = [request.root];

    for (let level = 0; level < depth; level += 1) {
      const next: NodeId[] = [];
      for (const id of frontier) {
        for (const edge of this.graph.getEdges(id, query)) {
          edges.set(edge.id, edge);
          const neighbour = edge.from === id ? edge.to : edge.from;
          if (!visited.has(neighbour)) {
            visited.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) {
        break;
      }
    }

    return { nodes: this.resolve([...visited]), edges: [...edges.values()] };
  }

  /** Ids a node's expressions reference, for dependency reporting. */
  referencedBy(expression: Expression): NodeId[] {
    return referencedIds(expression);
  }

  protected ancestors(id: NodeId): UINode[] {
    const found: UINode[] = [];
    const seen = new Set<NodeId>([id]);
    let frontier = [id];
    while (frontier.length > 0) {
      const next: NodeId[] = [];
      for (const current of frontier) {
        for (const edge of this.graph.getIncomingEdges(current, { kinds: CONTAINMENT_KINDS })) {
          if (seen.has(edge.from)) {
            continue;
          }
          seen.add(edge.from);
          const parent = this.graph.getNode(edge.from);
          if (parent && isUINode(parent)) {
            found.push(parent);
            next.push(parent.id);
          }
        }
      }
      frontier = next;
    }
    return found;
  }

  protected enclosingViews(id: NodeId): ViewNode[] {
    const node = this.graph.getNode(id);
    const self = node && node.kind === 'view' ? [node] : [];
    return [...self, ...this.ancestors(id).filter((ancestor): ancestor is ViewNode => ancestor.kind === 'view')];
  }

  private resolve(ids: NodeId[]): AnyNode[] {
    return ids
      .map((id) => this.graph.getNode(id))
      .filter((node): node is AnyNode => Boolean(node));
  }
}
