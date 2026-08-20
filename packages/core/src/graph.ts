import { randomBytes } from 'node:crypto';
import type { AnyNode, ApplicationGraphData, GraphEdge, NodeInput, NodeType } from './types.js';

function timestamp(): string {
  return new Date().toISOString();
}

export function randomHex(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

function createNodeId(): string {
  return [randomHex(), randomHex(), randomHex(), randomHex()].join('-');
}

function cloneNode<T>(value: T): T {
  return structuredClone(value);
}

export class ApplicationGraph {
  private data: ApplicationGraphData;
  private outgoing = new Map<string, GraphEdge[]>();
  private incoming = new Map<string, GraphEdge[]>();

  constructor(id: string, name: string, version = '0.1.0') {
    const now = timestamp();
    this.data = {
      id,
      name,
      version,
      nodes: {},
      edges: [],
      createdAt: now,
      updatedAt: now,
    };
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

  get createdAt(): string {
    return this.data.createdAt;
  }

  get updatedAt(): string {
    return this.data.updatedAt;
  }

  addNode<T extends AnyNode>(node: NodeInput<T>): string {
    const id = node.id ?? createNodeId();
    const createdAt = node.createdAt ?? timestamp();
    const storedNode = cloneNode({ ...node, id, createdAt } as unknown as T);
    this.data.nodes[id] = storedNode;
    this.touch();
    return id;
  }

  removeNode(id: string): boolean {
    if (!(id in this.data.nodes)) {
      return false;
    }
    delete this.data.nodes[id];
    this.data.edges = this.data.edges.filter((edge) => edge.from !== id && edge.to !== id);
    this.rebuildEdgeIndexes();
    this.touch();
    return true;
  }

  getNode<T extends AnyNode = AnyNode>(id: string): T | undefined {
    const node = this.data.nodes[id];
    return node ? cloneNode(node as T) : undefined;
  }

  updateNode(node: AnyNode): void {
    if (!this.data.nodes[node.id]) {
      throw new Error(`Node ${node.id} does not exist`);
    }
    this.data.nodes[node.id] = cloneNode(node);
    this.touch();
  }

  getNodesByType<T extends AnyNode = AnyNode>(type: NodeType): T[] {
    return Object.values(this.data.nodes)
      .filter((node): node is T => node.type === type)
      .map((node) => cloneNode(node));
  }

  listNodes(): AnyNode[] {
    return Object.values(this.data.nodes).map((node) => cloneNode(node));
  }

  addEdge(from: string, to: string, kind: string): void {
    if (!this.data.nodes[from]) {
      throw new Error(`Cannot add edge from missing node ${from}`);
    }
    if (!this.data.nodes[to]) {
      throw new Error(`Cannot add edge to missing node ${to}`);
    }
    const edge: GraphEdge = { from, to, kind };
    const exists = this.data.edges.some(
      (candidate) => candidate.from === from && candidate.to === to && candidate.kind === kind,
    );
    if (!exists) {
      this.data.edges.push(edge);
      this.indexEdge(edge);
      this.touch();
    }
  }

  getEdges(nodeId: string): GraphEdge[] {
    const outgoing = this.outgoing.get(nodeId) ?? [];
    const incoming = this.incoming.get(nodeId) ?? [];
    return [...outgoing, ...incoming].map((edge) => cloneNode(edge));
  }

  getOutgoingEdges(nodeId: string): GraphEdge[] {
    return (this.outgoing.get(nodeId) ?? []).map((edge) => cloneNode(edge));
  }

  getIncomingEdges(nodeId: string): GraphEdge[] {
    return (this.incoming.get(nodeId) ?? []).map((edge) => cloneNode(edge));
  }

  toJSON(): ApplicationGraphData {
    return cloneNode(this.data);
  }

  serialize(): string {
    return JSON.stringify(this.data, null, 2);
  }

  restore(input: string | ApplicationGraphData): void {
    const data = typeof input === 'string' ? (JSON.parse(input) as ApplicationGraphData) : cloneNode(input);
    this.data = data;
    this.rebuildEdgeIndexes();
  }

  static deserialize(input: string | ApplicationGraphData): ApplicationGraph {
    const data = typeof input === 'string' ? (JSON.parse(input) as ApplicationGraphData) : cloneNode(input);
    const graph = new ApplicationGraph(data.id, data.name, data.version);
    graph.restore(data);
    return graph;
  }

  private touch(): void {
    this.data.updatedAt = timestamp();
  }

  private indexEdge(edge: GraphEdge): void {
    const outgoing = this.outgoing.get(edge.from) ?? [];
    outgoing.push(edge);
    this.outgoing.set(edge.from, outgoing);

    const incoming = this.incoming.get(edge.to) ?? [];
    incoming.push(edge);
    this.incoming.set(edge.to, incoming);
  }

  private rebuildEdgeIndexes(): void {
    this.outgoing.clear();
    this.incoming.clear();
    for (const edge of this.data.edges) {
      this.indexEdge(edge);
    }
  }
}
