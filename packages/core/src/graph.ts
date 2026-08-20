import { createEdgeId, createNodeId } from './ids.js';
import type { EdgeId, FieldId, NodeId } from './ids.js';
import type { EdgeKind, EntityDef, FieldDef, GraphEdge } from './nodes.js';
import type { AnyNode, ApplicationGraphData, NodeInput, NodeKind, NodeOfKind } from './types.js';

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
 * The Application Graph is the canonical representation of an application. Reads return
 * deep clones, so a node retrieved from the graph must be written back with
 * `updateNode` for the change to take effect.
 */
export class ApplicationGraph {
  private data: ApplicationGraphData;
  private outgoing = new Map<NodeId, GraphEdge[]>();
  private incoming = new Map<NodeId, GraphEdge[]>();
  private fieldIndex = new Map<FieldId, FieldIndexEntry>();

  constructor(id: string, name: string, version = '0.3.0') {
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

  addNode<T extends AnyNode>(node: NodeInput<T>): NodeId {
    const id = (node.id ?? createNodeId(node.kind)) as NodeId;
    if (this.data.nodes[id]) {
      throw new Error(`Node ${id} already exists`);
    }
    this.data.nodes[id] = clone({ ...node, id } as unknown as AnyNode);
    this.indexNodeFields(this.data.nodes[id]);
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
    return id;
  }

  removeEdge(id: EdgeId): boolean {
    if (!this.data.edges[id]) {
      return false;
    }
    delete this.data.edges[id];
    this.rebuildEdgeIndexes();
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
    return filterEdges(this.outgoing.get(nodeId) ?? [], query).map((edge) => clone(edge));
  }

  getIncomingEdges(nodeId: NodeId, query: EdgeQuery = {}): GraphEdge[] {
    return filterEdges(this.incoming.get(nodeId) ?? [], query).map((edge) => clone(edge));
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
