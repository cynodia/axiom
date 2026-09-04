import type { ApplicationGraph, EdgeKind, GraphEdge, NodeId } from '@cynodia/axiom-core';

/**
 * Transitive dependency/dependent analysis and edge provenance (spec16 §12-14). Cycle-safe
 * — a graph edge can form a cycle (a workflow branch, a mutual `invoke`) and this must still
 * terminate with a deterministic, canonically-ordered answer (spec16 §13).
 */

export interface TransitiveDependencyResult {
  root: string;
  /** Ids reachable from the root, canonically sorted, root excluded. */
  ids: string[];
}

function walk(graph: ApplicationGraph, root: NodeId, kinds: readonly EdgeKind[] | undefined, direction: 'out' | 'in'): string[] {
  const seen = new Set<NodeId>([root]);
  const found: NodeId[] = [];
  let frontier: NodeId[] = [root];
  while (frontier.length > 0) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      const edges: GraphEdge[] =
        direction === 'out'
          ? graph.getOutgoingEdges(id, kinds ? { kinds } : {})
          : graph.getIncomingEdges(id, kinds ? { kinds } : {});
      for (const edge of edges) {
        const neighbour = direction === 'out' ? edge.to : edge.from;
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          found.push(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  return found.sort();
}

/** Every node transitively reachable by following outgoing edges from `root` (spec16 §13). */
export function transitiveDependencies(
  graph: ApplicationGraph,
  root: NodeId,
  kinds?: readonly EdgeKind[],
): TransitiveDependencyResult {
  return { root: String(root), ids: walk(graph, root, kinds, 'out') };
}

/** Every node that transitively depends on `root`, by following incoming edges (spec16 §13). */
export function transitiveDependents(
  graph: ApplicationGraph,
  root: NodeId,
  kinds?: readonly EdgeKind[],
): TransitiveDependencyResult {
  return { root: String(root), ids: walk(graph, root, kinds, 'in') };
}

export interface DependencyProvenance {
  from: string;
  to: string;
  edges: GraphEdge[];
  /** One rendered reason per edge, structural rather than free prose (spec16 §14). */
  reasons: string[];
}

function renderReason(graph: ApplicationGraph, edge: GraphEdge): string {
  const fromNode = graph.getNode(edge.from);
  const toNode = graph.getNode(edge.to);
  const fieldIds = (edge.metadata?.fieldIds as string[] | undefined) ?? [];
  const fields = fieldIds.length > 0 ? ` (fields: ${[...fieldIds].sort().join(', ')})` : '';
  const fromDesc = fromNode ? `${fromNode.kind} ${edge.from}` : String(edge.from);
  const toDesc = toNode ? `${toNode.kind} ${edge.to}` : String(edge.to);
  const verbs: Partial<Record<EdgeKind, string>> = {
    reads: 'reads',
    writes: 'writes',
    invokes: 'invokes',
    renders: 'renders',
    binds: 'binds into',
    'depends-on': 'depends on',
    'derives-from': 'derives from',
    constrains: 'constrains',
    'routes-to': 'routes to',
    references: 'references',
    contains: 'contains',
  };
  return `${fromDesc} ${verbs[edge.kind] ?? edge.kind} ${toDesc}${fields}`;
}

/** Why a dependency edge exists between two nodes, in structural (not fabricated) terms (spec16 §14). */
export function explainDependency(graph: ApplicationGraph, from: NodeId, to: NodeId): DependencyProvenance | undefined {
  const edges = graph.getOutgoingEdges(from, {}).filter((edge) => edge.to === to);
  if (edges.length === 0) {
    return undefined;
  }
  return { from: String(from), to: String(to), edges, reasons: edges.map((edge) => renderReason(graph, edge)) };
}
