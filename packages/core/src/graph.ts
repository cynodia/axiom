import { deriveEdges } from './derive-edges.js';
import { createEdgeId, createNodeId } from './ids.js';
import type { EdgeId, FieldId, NodeId } from './ids.js';
import type { EdgeKind, EntityDef, FieldDef, GraphEdge } from './nodes.js';
import type { AnyNode, ApplicationGraphData, NodeInput, NodeKind, NodeOfKind } from './types.js';
import { resolveTheme } from './theme.js';
import type { Theme, ThemeInput } from './theme.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface FieldIndexEntry {
  entityId: NodeId;
  field: FieldDef;
}

export interface EdgeQuery {
  kinds?: readonly EdgeKind[];
}

/**
 * The Application Graph is the canonical representation of an application. Everything else
 * — the IR, the emitted page, the DOM — is derived from it and is never edited.
 *
 * Reads return **deep clones**, so a node retrieved from the graph must be written back
 * with `updateNode` for the change to take effect.
 *
 * Relationships are derived from the current nodes on demand and cached against a revision
 * counter, so an edge cannot fall out of step with the nodes it describes and no
 * correctness property depends on resynchronizing anything.
 */
export class ApplicationGraph {
  private data: ApplicationGraphData;
  private outgoing = new Map<NodeId, GraphEdge[]>();
  private incoming = new Map<NodeId, GraphEdge[]>();
  private fieldIndex = new Map<FieldId, FieldIndexEntry>();
  /** Bumped by every change, so the derived edge index can never serve stale data. */
  private revision = 0;
  private semanticIndex?: {
    revision: number;
    edges: GraphEdge[];
    outgoing: Map<NodeId, GraphEdge[]>;
    incoming: Map<NodeId, GraphEdge[]>;
  };

  constructor(id: string, name: string, version = '0.8.1') {
    this.data = { id, name, version, nodes: {}, edges: {} };
  }

  get id(): string {
    return this.data.id;
  }

  get name(): string {
    return this.data.name;
  }

  get version(): string {
    return this.data.version;
  }

  /**
   * The application's visual identity, completed against the default theme. A theme is
   * presentation only: changing it cannot change an action, a constraint or a route.
   */
  get theme(): Theme {
    return resolveTheme(this.data.theme);
  }

  /** Exactly what the application declared, before defaults were filled in. */
  get declaredTheme(): ThemeInput | undefined {
    return this.data.theme ? structuredClone(this.data.theme) : undefined;
  }

  /**
   * The entity an authorization expression reads the caller through, bound to `PRINCIPAL`
   * when the authority evaluates the rule.
   */
  get principalEntityId(): NodeId | undefined {
    return this.data.principalEntityId;
  }

  setPrincipalEntity(entityId: NodeId | undefined): void {
    if (entityId === undefined) {
      delete this.data.principalEntityId;
    } else {
      this.data.principalEntityId = entityId;
    }
    this.revision += 1;
  }

  setTheme(theme: ThemeInput | undefined): void {
    if (theme === undefined) {
      delete this.data.theme;
    } else {
      this.data.theme = structuredClone(theme);
    }
    this.revision += 1;
  }

  addNode<T extends AnyNode>(node: NodeInput<T>): NodeId {
    const id = (node.id ?? createNodeId(node.kind)) as NodeId;
    if (this.data.nodes[id]) {
      throw new Error(`Node ${id} already exists`);
    }
    this.data.nodes[id] = clone({ ...node, id } as unknown as AnyNode);
    this.indexNodeFields(this.data.nodes[id]);
    this.revision += 1;
    return id;
  }

  getNode<T extends AnyNode = AnyNode>(id: NodeId): T | undefined {
    const node = this.data.nodes[id];
    return node ? (clone(node) as T) : undefined;
  }

  hasNode(id: NodeId): boolean {
    return Boolean(this.data.nodes[id]);
  }

  updateNode(node: AnyNode): void {
    if (!this.data.nodes[node.id]) {
      throw new Error(`Node ${node.id} does not exist`);
    }
    this.data.nodes[node.id] = clone(node);
    this.rebuildFieldIndex();
    this.revision += 1;
  }

  removeNode(id: NodeId): boolean {
    if (!this.data.nodes[id]) {
      return false;
    }
    delete this.data.nodes[id];
    for (const [edgeKey, edge] of Object.entries(this.data.edges)) {
      if (edge.from === id || edge.to === id) {
        delete this.data.edges[edgeKey];
      }
    }
    this.rebuildIndexes();
    this.revision += 1;
    return true;
  }

  getNodesByKind<K extends NodeKind>(kind: K): NodeOfKind<K>[] {
    return Object.values(this.data.nodes)
      .filter((node): node is NodeOfKind<K> => node.kind === kind)
      .map((node) => clone(node));
  }

  listNodes(): AnyNode[] {
    return Object.values(this.data.nodes).map((node) => clone(node));
  }

  /** Resolves a field id to its owning entity. Fields are globally identifiable. */
  getField(id: FieldId): FieldIndexEntry | undefined {
    const location = this.fieldIndex.get(id);
    return location ? clone(location) : undefined;
  }

  listFields(): FieldIndexEntry[] {
    return [...this.fieldIndex.values()].map((location) => clone(location));
  }

  addEdge(
    from: NodeId,
    to: NodeId,
    kind: EdgeKind,
    options: { id?: EdgeId; metadata?: Record<string, unknown> } = {},
  ): EdgeId {
    if (!this.data.nodes[from]) {
      throw new Error(`Cannot add edge from missing node ${from}`);
    }
    if (!this.data.nodes[to]) {
      throw new Error(`Cannot add edge to missing node ${to}`);
    }
    const existing = Object.values(this.data.edges).find(
      (edge) => edge.from === from && edge.to === to && edge.kind === kind,
    );
    if (existing) {
      return existing.id;
    }
    const id = options.id ?? createEdgeId();
    const edge: GraphEdge = { id, from, to, kind, ...(options.metadata ? { metadata: options.metadata } : {}) };
    this.data.edges[id] = edge;
    this.indexEdge(edge);
    this.revision += 1;
    return id;
  }

  removeEdge(id: EdgeId): boolean {
    if (!this.data.edges[id]) {
      return false;
    }
    delete this.data.edges[id];
    this.rebuildEdgeIndexes();
    this.revision += 1;
    return true;
  }

  getEdge(id: EdgeId): GraphEdge | undefined {
    const edge = this.data.edges[id];
    return edge ? clone(edge) : undefined;
  }

  listEdges(): GraphEdge[] {
    return Object.values(this.data.edges).map((edge) => clone(edge));
  }

  getEdges(nodeId: NodeId, query: EdgeQuery = {}): GraphEdge[] {
    return [...this.getOutgoingEdges(nodeId, query), ...this.getIncomingEdges(nodeId, query)];
  }

  getOutgoingEdges(nodeId: NodeId, query: EdgeQuery = {}): GraphEdge[] {
    return filterEdges(this.index().outgoing.get(nodeId) ?? [], query).map((edge) => clone(edge));
  }

  getIncomingEdges(nodeId: NodeId, query: EdgeQuery = {}): GraphEdge[] {
    return filterEdges(this.index().incoming.get(nodeId) ?? [], query).map((edge) => clone(edge));
  }

  /**
   * Every relationship the current nodes imply, derived on demand. Edges cannot fall out
   * of step with the nodes they describe, so nothing has to remember to resynchronize
   * them after a change.
   */
  semanticEdges(): GraphEdge[] {
    return this.index().edges.map((edge) => clone(edge));
  }

  private index(): NonNullable<ApplicationGraph['semanticIndex']> {
    if (this.semanticIndex?.revision === this.revision) {
      return this.semanticIndex;
    }

    const byKey = new Map<string, GraphEdge>();
    for (const edge of deriveEdges(Object.values(this.data.nodes))) {
      byKey.set(`${edge.from}|${edge.to}|${edge.kind}`, edge);
    }
    // An edge written into the graph by hand wins over the derived one it duplicates.
    for (const edge of Object.values(this.data.edges)) {
      byKey.set(`${edge.from}|${edge.to}|${edge.kind}`, edge);
    }

    const edges = [...byKey.values()];
    const outgoing = new Map<NodeId, GraphEdge[]>();
    const incoming = new Map<NodeId, GraphEdge[]>();
    for (const edge of edges) {
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
      incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
    }

    this.semanticIndex = { revision: this.revision, edges, outgoing, incoming };
    return this.semanticIndex;
  }

  toJSON(): ApplicationGraphData {
    return clone(this.data);
  }

  serialize(): string {
    return JSON.stringify(this.data, null, 2);
  }

  restore(input: string | ApplicationGraphData): void {
    this.data = typeof input === 'string' ? (JSON.parse(input) as ApplicationGraphData) : clone(input);
    this.rebuildIndexes();
    this.revision += 1;
  }

  static deserialize(input: string | ApplicationGraphData): ApplicationGraph {
    const data = typeof input === 'string' ? (JSON.parse(input) as ApplicationGraphData) : clone(input);
    const graph = new ApplicationGraph(data.id, data.name, data.version);
    graph.restore(data);
    return graph;
  }

  private indexEdge(edge: GraphEdge): void {
    const outgoing = this.outgoing.get(edge.from) ?? [];
    outgoing.push(edge);
    this.outgoing.set(edge.from, outgoing);

    const incoming = this.incoming.get(edge.to) ?? [];
    incoming.push(edge);
    this.incoming.set(edge.to, incoming);
  }

  private indexNodeFields(node: AnyNode): void {
    if (node.kind !== 'entity') {
      return;
    }
    for (const field of (node as EntityDef).fields) {
      this.fieldIndex.set(field.id, { entityId: node.id, field });
    }
  }

  private rebuildFieldIndex(): void {
    this.fieldIndex.clear();
    for (const node of Object.values(this.data.nodes)) {
      this.indexNodeFields(node);
    }
  }

  private rebuildEdgeIndexes(): void {
    this.outgoing.clear();
    this.incoming.clear();
    for (const edge of Object.values(this.data.edges)) {
      this.indexEdge(edge);
    }
  }

  private rebuildIndexes(): void {
    this.rebuildEdgeIndexes();
    this.rebuildFieldIndex();
  }
}

function filterEdges(edges: GraphEdge[], query: EdgeQuery): GraphEdge[] {
  if (!query.kinds) {
    return edges;
  }
  const kinds = new Set(query.kinds);
  return edges.filter((edge) => kinds.has(edge.kind));
}
