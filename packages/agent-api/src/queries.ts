import {
  isUINode,
  locationFieldIds,
  locationRootStateId,
  locationSelectorFieldIds,
  referencedIds,
} from '@cynodia/axiom-core';
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
  Location,
  NodeId,
  StateDef,
  UINode,
  ViewNode,
} from '@cynodia/axiom-core';

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

/** What a change to a location can reach. */
export interface MutationImpact {
  location: Location;
  rootStateId: NodeId;
  fieldIds: FieldId[];
  directWriters: AnyNode[];
  dependentDerivedStates: StateDef[];
  affectedConstraints: ConstraintDef[];
  affectedViews: ViewNode[];
}

function edgeFieldIds(edge: GraphEdge): FieldId[] {
  const fieldIds = edge.metadata?.fieldIds;
  return Array.isArray(fieldIds) ? (fieldIds as FieldId[]) : [];
}

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
          return locationFieldIds(node.binding.location).some((id) => fieldIds.has(id));
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
          (action.operations ?? []).some((operation) => operation.kind === 'remove'),
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

  /** Nodes that read a specific field, from the field metadata on their read edges. */
  getFieldReaders(fieldId: FieldId): AnyNode[] {
    return this.nodesWithFieldEdge(fieldId, READ_KINDS);
  }

  /** Nodes that write a specific field — actions and the inputs bound to it. */
  getFieldWriters(fieldId: FieldId): AnyNode[] {
    return this.nodesWithFieldEdge(fieldId, WRITE_KINDS);
  }

  /**
   * What can change this location, and what observes it. The answer comes entirely from
   * graph relationships, so an agent never has to read application source to find out.
   */
  getMutationImpact(location: Location): MutationImpact {
    const rootStateId = locationRootStateId(location);
    const fieldIds = locationFieldIds(location);
    const selectorFieldIds = locationSelectorFieldIds(location);

    const directWriters = this.graph
      .getIncomingEdges(rootStateId, { kinds: WRITE_KINDS })
      .filter((edge) => {
        if (fieldIds.length === 0) {
          return true;
        }
        const edgeFields = edgeFieldIds(edge);
        // An edge with no field metadata replaces the whole value.
        return edgeFields.length === 0 || edgeFields.some((id) => fieldIds.includes(id));
      })
      .map((edge) => this.graph.getNode(edge.from))
      .filter((node): node is AnyNode => Boolean(node));

    const dependentDerivedStates = this.derivedStatesFrom(rootStateId);

    const entityIds = new Set(
      [...fieldIds, ...selectorFieldIds]
        .map((id) => this.graph.getField(id)?.entityId)
        .filter((id): id is NodeId => Boolean(id)),
    );
    if (entityIds.size === 0) {
      // Replacing a whole state affects every entity stored in it.
      for (const edge of this.graph.getOutgoingEdges(rootStateId, { kinds: ['references'] })) {
        entityIds.add(edge.to);
      }
    }
    const affectedConstraints = this.graph.getNodesByKind('constraint').filter((constraint) => {
      if (constraint.entityId && entityIds.has(constraint.entityId)) {
        return fieldIds.length === 0 || this.constraintTouches(constraint, fieldIds);
      }
      return this.graph
        .getOutgoingEdges(constraint.id, { kinds: READ_KINDS })
        .some((edge) => edge.to === rootStateId);
    });

    const observers = new Set<NodeId>([rootStateId, ...dependentDerivedStates.map((state) => state.id)]);
    const views = new Map<NodeId, ViewNode>();
    for (const node of this.graph.listNodes()) {
      if (!isUINode(node)) {
        continue;
      }
      const touches = this.graph
        .getOutgoingEdges(node.id, { kinds: [...READ_KINDS, ...WRITE_KINDS] })
        .some((edge) => observers.has(edge.to));
      if (!touches) {
        continue;
      }
      for (const view of this.enclosingViews(node.id)) {
        views.set(view.id, view);
      }
    }

    return {
      location,
      rootStateId,
      fieldIds,
      directWriters,
      dependentDerivedStates,
      affectedConstraints,
      affectedViews: [...views.values()],
    };
  }

  private constraintTouches(constraint: ConstraintDef, fieldIds: readonly FieldId[]): boolean {
    const declared = this.graph
      .getOutgoingEdges(constraint.id, { kinds: ['constrains'] })
      .flatMap((edge) => edgeFieldIds(edge));
    return declared.length === 0 || declared.some((id) => fieldIds.includes(id));
  }

  /** Derived states that depend on a state, directly or through other derived states. */
  private derivedStatesFrom(stateId: NodeId): StateDef[] {
    const found = new Map<NodeId, StateDef>();
    let frontier = [stateId];
    const seen = new Set<NodeId>([stateId]);

    while (frontier.length > 0) {
      const next: NodeId[] = [];
      for (const current of frontier) {
        for (const edge of this.graph.getIncomingEdges(current, { kinds: ['derives-from'] })) {
          if (seen.has(edge.from)) {
            continue;
          }
          seen.add(edge.from);
          const node = this.graph.getNode(edge.from);
          if (node?.kind === 'state') {
            found.set(node.id, node);
            next.push(node.id);
          }
        }
      }
      frontier = next;
    }
    return [...found.values()];
  }

  private nodesWithFieldEdge(fieldId: FieldId, kinds: readonly EdgeKind[]): AnyNode[] {
    const found = new Map<NodeId, AnyNode>();
    // Derived relationships, so an answer never depends on edges having been written.
    for (const edge of this.graph.semanticEdges()) {
      if (!kinds.includes(edge.kind) || !edgeFieldIds(edge).includes(fieldId)) {
        continue;
      }
      const node = this.graph.getNode(edge.from);
      if (node) {
        found.set(node.id, node);
      }
    }
    return [...found.values()];
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
