import {
  actionOperations,
  allowedInvocationSources,
  isClientInvocable as actionIsClientInvocable,
  isSystemOnlyAction,
  isUINode,
  locationFieldIds,
  locationRootStateId,
  locationSelectorFieldIds,
  referencedIds,
} from '@cynodia/axiom-core';
import {
  expressionFieldIds,
  queryExpressions,
  queryIsAggregate,
  queryRowEntityId,
  sortKeyDirection,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  AnyNode,
  ApplicationGraph,
  ConstraintDef,
  EdgeKind,
  EntityDef,
  EventDef,
  Expression,
  ExpressionDef,
  FieldId,
  FormNode,
  GraphEdge,
  IntegrationDef,
  IntegrationOperationDef,
  Location,
  NodeId,
  QueryAggregate,
  QueryDef,
  QueryParameter,
  ReadPolicyDef,
  RelationshipDef,
  StateDef,
  StorageDef,
  SubscriptionDef,
  TransitionConstraintDef,
  TriggerDef,
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
  /** Rules that govern how this state may change, whatever writes it. */
  affectedTransitionConstraints: TransitionConstraintDef[];
  affectedViews: ViewNode[];
  /**
   * Registered queries a write to this location may invalidate — conservatively, every
   * query that reads an entity stored in the affected state (spec 0.10 §72-74).
   */
  affectedQueries: QueryDef[];
  /**
   * False when something in the graph cannot be analyzed — a native operation that does
   * not declare its effects, for instance. An incomplete answer says so rather than
   * presenting itself as exhaustive.
   */
  analysisComplete: boolean;
  /** Why the analysis is incomplete, when it is. */
  analysisGaps: string[];
}

/** A structured, agent-readable account of what a query does (spec 0.10 §86). */
export interface QueryExplanation {
  queryId: NodeId;
  /** The authoritative source entity. */
  source: NodeId;
  parameters: QueryParameter[];
  /** The requested predicate, in prose-free structural form. Absent means "every row". */
  filter?: Expression;
  /** The read policy predicate AND-ed into the effective filter, if one governs the source. */
  readPolicyPredicate?: Expression;
  /** Sort keys, most significant first, plus the appended canonical-identity tie-breaker. */
  sort: Array<{ key: Expression; direction: 'asc' | 'desc'; nulls: 'first' | 'last' }>;
  identityTieBreaker?: FieldId;
  /** Relationship traversals: relationship id, cardinality, bound alias. */
  relationships: Array<{ relationshipId: NodeId; cardinality: 'to-one' | 'to-many'; bindAs: NodeId }>;
  /** Projected result fields, or `undefined` for a query that returns whole source rows. */
  projection?: { entityId: NodeId; fields: FieldId[] };
  aggregates: QueryAggregate[];
  groupBy: Expression[];
  pagination: { strategy: 'cursor' | 'offset'; maxPageSize: number };
  /** Entities the query reads, transitively through its relationships. */
  entities: NodeId[];
  /** Fields the query reads across all its clauses. */
  fields: FieldId[];
  /** Actions that may invalidate this query when they commit. */
  invalidatingActions: NodeId[];
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

  /** Rules governing how instances of this entity may change. */
  getTransitionConstraintsForEntity(entityId: NodeId): TransitionConstraintDef[] {
    return this.graph
      .getNodesByKind('transition-constraint')
      .filter((constraint) => constraint.entityId === entityId);
  }

  /** Every rule that protects a location, whichever path attempts the write. */
  getRulesProtecting(location: Location): {
    constraints: ConstraintDef[];
    transitionConstraints: TransitionConstraintDef[];
  } {
    const impact = this.getMutationImpact(location);
    return {
      constraints: impact.affectedConstraints,
      transitionConstraints: impact.affectedTransitionConstraints,
    };
  }

  /** Parts of the graph whose reads and writes cannot be derived. */
  private analysisGaps(): string[] {
    const gaps: string[] = [];
    for (const action of this.graph.getNodesByKind('action')) {
      for (const operation of actionOperations(action)) {
        if (operation.kind === 'native' && (operation.declaredEffects ?? []).length === 0) {
          gaps.push(
            `${action.name ?? action.id} runs the native operation "${operation.implementationId}" without declaring its effects`,
          );
        }
      }
    }
    return gaps;
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
      return actionOperations(action).some((operation) =>
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
          actionOperations(action).some((operation) => operation.kind === 'remove'),
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

  /**
   * Ids a node's expressions reference, for dependency reporting.
   *
   * Named expressions are followed, so an answer does not change because a calculation was
   * given a name instead of being written out.
   */
  referencedBy(expression: Expression): NodeId[] {
    return referencedIds(expression, (id) => this.getExpressionDefinition(id));
  }

  /** Every named, reusable expression in the graph. */
  listExpressionDefinitions(): ExpressionDef[] {
    return this.graph.getNodesByKind('expression');
  }

  getExpressionDefinition(id: NodeId): ExpressionDef | undefined {
    const node = this.graph.getNode(id);
    return node?.kind === 'expression' ? node : undefined;
  }

  /**
   * What uses a named expression — the question a reuse mechanism exists to make answerable.
   *
   * A definition with no consumers is dead weight, and one with many is a place where an
   * edit reaches further than it looks.
   */
  getExpressionConsumers(id: NodeId): AnyNode[] {
    return this.resolve(
      this.graph
        .getIncomingEdges(id, { kinds: ['references'] })
        .map((edge) => edge.from),
    ).filter((node) => node.id !== id);
  }

  /** The states a named expression reads, its own and those of the definitions it uses. */
  getExpressionDependencies(id: NodeId): StateDef[] {
    const definition = this.getExpressionDefinition(id);
    if (!definition) {
      return [];
    }
    return this.getDependencies(id, READ_KINDS).filter((node): node is StateDef => node.kind === 'state');
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

    const affectedTransitionConstraints = this.graph
      .getNodesByKind('transition-constraint')
      .filter((constraint) => entityIds.has(constraint.entityId));
    const gaps = this.analysisGaps();

    const affectedQueries = this.listQueries().filter((query) =>
      this.queryReadEntities(query).some((entityId) => entityIds.has(entityId)),
    );

    return {
      location,
      rootStateId,
      fieldIds,
      directWriters,
      dependentDerivedStates,
      affectedConstraints,
      affectedTransitionConstraints,
      affectedViews: [...views.values()],
      affectedQueries,
      analysisComplete: gaps.length === 0,
      analysisGaps: gaps,
    };
  }

  // ------------------------------------------------- queries, relationships, read policies

  /** Every registered query the application declares (spec 0.10 §85). */
  listQueries(): QueryDef[] {
    return this.graph.getNodesByKind('query');
  }

  getQuery(id: NodeId): QueryDef | undefined {
    const node = this.graph.getNode(id);
    return node?.kind === 'query' ? node : undefined;
  }

  /** Every explicit entity-to-entity relationship. */
  listRelationships(): RelationshipDef[] {
    return this.graph.getNodesByKind('relationship');
  }

  getRelationship(id: NodeId): RelationshipDef | undefined {
    const node = this.graph.getNode(id);
    return node?.kind === 'relationship' ? node : undefined;
  }

  /** Relationships that start from or reach an entity. */
  getRelationshipsForEntity(entityId: NodeId): RelationshipDef[] {
    return this.listRelationships().filter(
      (relationship) => relationship.from.entityId === entityId || relationship.to.entityId === entityId,
    );
  }

  /** Every row-level read policy. */
  listReadPolicies(): ReadPolicyDef[] {
    return this.graph.getNodesByKind('read-policy');
  }

  /** The read policy governing an entity's rows, if one is declared. */
  getReadPolicyForEntity(entityId: NodeId): ReadPolicyDef | undefined {
    return this.listReadPolicies().find((policy) => policy.entityId === entityId);
  }

  /** The read policy a query's rows are filtered by — named on the query, or over its source. */
  getReadPolicyForQuery(id: NodeId): ReadPolicyDef | undefined {
    const query = this.getQuery(id);
    if (!query) {
      return undefined;
    }
    if (query.readPolicyId) {
      const policy = this.graph.getNode(query.readPolicyId);
      return policy?.kind === 'read-policy' ? policy : undefined;
    }
    return this.getReadPolicyForEntity(query.source);
  }

  getQueryParameters(id: NodeId): QueryParameter[] {
    return this.getQuery(id)?.parameters ?? [];
  }

  /** Whether this query reduces rows to aggregate scalars rather than returning them. */
  isAggregateQuery(id: NodeId): boolean {
    const query = this.getQuery(id);
    return query ? queryIsAggregate(query) : false;
  }

  /** The entity a non-aggregate result row conforms to (the projection entity, else the source). */
  getQueryResultEntity(id: NodeId): NodeId | undefined {
    const query = this.getQuery(id);
    return query ? queryRowEntityId(query) : undefined;
  }

  /** Every entity a query reads, including relationship targets it traverses. */
  getQueryEntities(id: NodeId): EntityDef[] {
    const query = this.getQuery(id);
    if (!query) {
      return [];
    }
    return this.queryReadEntities(query)
      .map((entityId) => this.graph.getNode(entityId))
      .filter((node): node is EntityDef => node?.kind === 'entity');
  }

  private queryReadEntities(query: QueryDef): NodeId[] {
    const entities = new Set<NodeId>([query.source]);
    for (const use of query.relationships ?? []) {
      const relationship = this.getRelationship(use.relationshipId);
      if (relationship) {
        entities.add(relationship.to.entityId);
      }
    }
    return [...entities];
  }

  /** Relationships a query traverses. */
  getQueryRelationships(id: NodeId): RelationshipDef[] {
    const query = this.getQuery(id);
    if (!query) {
      return [];
    }
    return (query.relationships ?? [])
      .map((use) => this.getRelationship(use.relationshipId))
      .filter((relationship): relationship is RelationshipDef => Boolean(relationship));
  }

  /** Every field a query reads across its filter, sort, projection, group and aggregate clauses. */
  getQueryFields(id: NodeId): FieldId[] {
    const query = this.getQuery(id);
    if (!query) {
      return [];
    }
    const fields = new Set<FieldId>();
    for (const expression of queryExpressions(query)) {
      for (const fieldId of expressionFieldIds(expression)) {
        fields.add(fieldId);
      }
    }
    return [...fields];
  }

  /**
   * Actions that may invalidate a query's results when they commit — conservatively, every
   * action that writes a state holding an entity the query reads, or that mutates a
   * provider-backed row of one (spec 0.10 §73-74). Over-inclusion is acceptable; a
   * known-stale result is not (spec §72).
   */
  getActionsInvalidatingQuery(id: NodeId): ActionDef[] {
    const query = this.getQuery(id);
    if (!query) {
      return [];
    }
    const readEntities = new Set(this.queryReadEntities(query));
    return this.graph.getNodesByKind('action').filter((action) => {
      for (const edge of this.graph.getOutgoingEdges(action.id, { kinds: WRITE_KINDS })) {
        if (readEntities.has(edge.to)) {
          return true; // a provider-record write links the action straight to the entity
        }
        const target = this.graph.getNode(edge.to);
        if (target?.kind !== 'state') {
          continue;
        }
        const holds = this.graph
          .getOutgoingEdges(target.id, { kinds: ['references'] })
          .some((reference) => readEntities.has(reference.to));
        if (holds) {
          return true;
        }
      }
      return false;
    });
  }

  /** The inverse: every query an action's commit may invalidate. */
  getQueriesInvalidatedByAction(actionId: NodeId): QueryDef[] {
    return this.listQueries().filter((query) =>
      this.getActionsInvalidatingQuery(query.id).some((action) => action.id === actionId),
    );
  }

  /**
   * A structured explanation of a query — source, effective filter (with the read-policy
   * conjunct called out), ordering with its identity tie-breaker, projection, pagination,
   * the entities and fields it reads, and the actions that can invalidate it (spec §86).
   */
  explainQuery(id: NodeId): QueryExplanation | undefined {
    const query = this.getQuery(id);
    if (!query) {
      return undefined;
    }
    const source = this.graph.getNode(query.source);
    const identityTieBreaker =
      source?.kind === 'entity' ? source.identityFieldId : undefined;
    return {
      queryId: query.id,
      source: query.source,
      parameters: query.parameters ?? [],
      ...(query.filter ? { filter: query.filter } : {}),
      ...(this.getReadPolicyForQuery(id)
        ? { readPolicyPredicate: this.getReadPolicyForQuery(id)!.predicate }
        : {}),
      sort: (query.sort ?? []).map((key) => ({
        key: key.key,
        direction: sortKeyDirection(key),
        nulls: key.nulls ?? (sortKeyDirection(key) === 'asc' ? 'last' : 'first'),
      })),
      ...(identityTieBreaker ? { identityTieBreaker } : {}),
      relationships: (query.relationships ?? []).flatMap((use) => {
        const relationship = this.getRelationship(use.relationshipId);
        return relationship
          ? [{ relationshipId: use.relationshipId, cardinality: relationship.cardinality, bindAs: use.bindAs }]
          : [];
      }),
      ...(query.projection
        ? { projection: { entityId: query.projection.entityId, fields: query.projection.fields.map((field) => field.id) } }
        : {}),
      aggregates: query.aggregate ?? [],
      groupBy: query.groupBy ?? [],
      pagination: {
        strategy: query.pagination?.strategy ?? 'cursor',
        maxPageSize: query.pagination?.maxPageSize ?? 100,
      },
      entities: this.queryReadEntities(query),
      fields: this.getQueryFields(id),
      invalidatingActions: this.getActionsInvalidatingQuery(id).map((action) => action.id),
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

  // ------------------------------------------- integrations, effects, triggers, events

  /** Every external capability domain the application declares. */
  listIntegrations(): IntegrationDef[] {
    return this.graph.getNodesByKind('integration');
  }

  /** The typed operations an integration exposes, or every operation of every integration. */
  listIntegrationOperations(integrationId?: NodeId): IntegrationOperationDef[] {
    const all = this.graph.getNodesByKind('integration-operation');
    return integrationId ? all.filter((operation) => operation.integrationId === integrationId) : all;
  }

  getIntegrationOperation(id: NodeId): IntegrationOperationDef | undefined {
    const node = this.graph.getNode(id);
    return node?.kind === 'integration-operation' ? node : undefined;
  }

  /** Actions that call an operation of this integration, directly. */
  getActionsUsingIntegration(integrationId: NodeId): ActionDef[] {
    const operationIds = new Set(this.listIntegrationOperations(integrationId).map((operation) => operation.id));
    return this.graph
      .getNodesByKind('action')
      .filter((action) =>
        this.graph.getOutgoingEdges(action.id, { kinds: ['references'] }).some((edge) => operationIds.has(edge.to)),
      );
  }

  /** The effect-mode operations an action calls — what it can do to an external system. */
  getEffectsForAction(actionId: NodeId): IntegrationOperationDef[] {
    return this.graph
      .getOutgoingEdges(actionId, { kinds: ['references'] })
      .map((edge) => this.getIntegrationOperation(edge.to))
      .filter((operation): operation is IntegrationOperationDef => operation?.mode === 'effect');
  }

  /** Triggers that invoke this action. */
  getTriggersForAction(actionId: NodeId): TriggerDef[] {
    return this.graph.getNodesByKind('trigger').filter((trigger) => trigger.actionId === actionId);
  }

  /** The actions an event, once dispatched, invokes — following every trigger bound to it. */
  getActionsTriggeredByEvent(eventId: NodeId): ActionDef[] {
    const triggers = this.graph
      .getNodesByKind('trigger')
      .filter((trigger) => trigger.when.kind === 'event' && trigger.when.eventId === eventId);
    return this.resolve(triggers.map((trigger) => trigger.actionId)).filter(
      (node): node is ActionDef => node.kind === 'action',
    );
  }

  /** Every external capability this application can reach, and what it can do with each. */
  getExternalDependencies(): { integrations: IntegrationDef[]; operations: IntegrationOperationDef[] } {
    return { integrations: this.listIntegrations(), operations: this.graph.getNodesByKind('integration-operation') };
  }

  /** Triggers that fire on a schedule rather than on an event or a lifecycle moment. */
  getTimedTriggers(): TriggerDef[] {
    return this.graph
      .getNodesByKind('trigger')
      .filter((trigger) => trigger.when.kind === 'interval' || trigger.when.kind === 'delay');
  }

  /**
   * Events at least one trigger reacts to — the internal/external facts this application
   * listens for.
   *
   * This is a **graph-static** query: it answers "which `EventDef`s have a `TriggerDef`
   * bound to them", not "which webhook deliveries has this server received". An event
   * returned here may be dispatched by a verified external webhook, by an effect's
   * `succeededEventId`/`failedEventId`, or by any other internal source — "webhook-ness" is
   * not a property the graph records, so a name implying it overstates what this answers
   * (spec 8.2 §34-35).
   */
  getTriggeredEvents(): EventDef[] {
    const referenced = new Set(
      this.graph
        .getNodesByKind('trigger')
        .filter((trigger) => trigger.when.kind === 'event')
        .map((trigger) => (trigger.when as { kind: 'event'; eventId: NodeId }).eventId),
    );
    return this.graph.getNodesByKind('event').filter((event) => referenced.has(event.id));
  }

  /**
   * @deprecated Renamed to {@link getTriggeredEvents} (spec 8.2 §34-36): this answers
   * "which events have a trigger bound to them", not "which webhook deliveries were
   * received" — the two are not the same, since the same query covers effect-outcome
   * events too. Kept as an alias for backward compatibility; new code should call
   * `getTriggeredEvents()` directly.
   */
  getWebhookEvents(): EventDef[] {
    return this.getTriggeredEvents();
  }

  // -------------------------------------------- subscriptions and object storage

  /** Every long-lived external event source this application declares. */
  listSubscriptions(): SubscriptionDef[] {
    return this.graph.getNodesByKind('subscription');
  }

  /** The subscriptions an integration's adapter is responsible for maintaining. */
  getSubscriptionsForIntegration(integrationId: NodeId): SubscriptionDef[] {
    return this.listSubscriptions().filter(
      (subscription) => subscription.integrationId === integrationId,
    );
  }

  /** The `EventDef` a subscription's deliveries become. */
  getEventForSubscription(subscriptionId: NodeId): EventDef | undefined {
    const subscription = this.graph.getNode(subscriptionId);
    if (subscription?.kind !== 'subscription') {
      return undefined;
    }
    const event = this.graph.getNode(subscription.eventId);
    return event?.kind === 'event' ? event : undefined;
  }

  /**
   * Every action a delivery on this subscription can reach, following its event through the
   * triggers bound to it. The answer to "what can this feed actually change" without
   * walking the graph by hand.
   */
  getActionsReachableFromSubscription(subscriptionId: NodeId): ActionDef[] {
    const event = this.getEventForSubscription(subscriptionId);
    return event ? this.getActionsTriggeredByEvent(event.id) : [];
  }

  /**
   * Every way the outside world can reach this application, in one answer: the integrations
   * it calls, the operations it calls on them, the live sources it listens to, the events
   * those deliver, and the object stores it reads or writes.
   *
   * Graph-static, like every other query here — it says what the application *can* do, not
   * what any running authority has done.
   */
  getExternalEventSources(): {
    subscriptions: SubscriptionDef[];
    events: EventDef[];
    integrations: IntegrationDef[];
  } {
    const subscriptions = this.listSubscriptions();
    const eventIds = new Set(subscriptions.map((subscription) => subscription.eventId));
    const integrationIds = new Set(subscriptions.map((subscription) => subscription.integrationId));
    return {
      subscriptions,
      events: this.graph.getNodesByKind('event').filter((event) => eventIds.has(event.id)),
      integrations: this.listIntegrations().filter((integration) => integrationIds.has(integration.id)),
    };
  }

  /** Every object store this application declares. */
  listStorages(): StorageDef[] {
    return this.graph.getNodesByKind('storage');
  }

  /** Actions that read from, commit into or delete from this store. */
  getActionsUsingStorage(storageId: NodeId): ActionDef[] {
    return this.graph
      .getNodesByKind('action')
      .filter((action) =>
        actionOperations(action).some(
          (operation) =>
            (operation.kind === 'blob-metadata' ||
              operation.kind === 'blob-commit' ||
              operation.kind === 'blob-delete') &&
            operation.storageId === storageId,
        ),
      );
  }

  /**
   * Stores that would serve nothing and accept nothing, because they declare no access
   * rule. A missing rule is refusal, so this reports dead capability rather than a hole.
   */
  getStoragesWithoutAccessRules(): StorageDef[] {
    return this.listStorages().filter(
      (storage) => !storage.readAuthorization && !storage.uploadAuthorization,
    );
  }

  /** Whether an ordinary client `InvokeRequest` may name this action at all. */
  isClientInvocable(actionId: NodeId): boolean {
    const action = this.graph.getNode(actionId);
    return action?.kind === 'action' ? actionIsClientInvocable(action) : false;
  }

  /** Whether this action accepts only trigger-, event- or effect-outcome-originated calls. */
  isSystemOnly(actionId: NodeId): boolean {
    const action = this.graph.getNode(actionId);
    return action?.kind === 'action' ? isSystemOnlyAction(action) : false;
  }

  /** Every action reachable only through a trigger, event or effect outcome — never a client. */
  getSystemOnlyActions(): ActionDef[] {
    return this.graph.getNodesByKind('action').filter((action) => isSystemOnlyAction(action));
  }

  /** Triggers whose target action cannot accept the `'system'`-sourced invocation the trigger always makes. */
  getTriggersTargetingClientOnlyActions(): TriggerDef[] {
    return this.graph.getNodesByKind('trigger').filter((trigger) => {
      const action = this.graph.getNode(trigger.actionId);
      return action?.kind === 'action' && !allowedInvocationSources(action).includes('system');
    });
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
