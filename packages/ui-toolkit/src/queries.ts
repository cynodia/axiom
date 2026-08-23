import type { ApplicationGraph, NodeId } from '@cynodia/axiom-core';
import type { PatternDeclaration, ToolkitProvenance } from './pattern.js';
import { provenanceOf } from './pattern.js';
import type { PatternExpansion, Toolkit } from './expand.js';
import { instancesOfPattern, nodesOfInstance } from './expand.js';

/**
 * Toolkit-aware queries, deliberately **not** part of `AgentAPI`.
 *
 * They live here for two reasons. The dependency direction forbids the other arrangement —
 * `agent-api` knows only core, and a toolkit that core knew about would stop being a toolkit.
 * And the separation is the point: canonical `AgentAPI` must answer every question about an
 * expanded application without knowing a toolkit exists, or the abstraction is opaque. These
 * are additive convenience, and an agent that never finds them loses nothing it needs.
 *
 * Everything here reads the graph. Only `getPatternExpansion` and `getPatternDeclaration`
 * need the toolkit instance, because a declaration is not stored in the graph — which is
 * itself the answer to "is the expanded graph enough": for semantics yes, for authoring
 * history no.
 */
export interface ToolkitQueries {
  /** Every pattern instance in the graph, from provenance alone. */
  getPatternInstances(): Array<{ instance: string; pattern: string; nodeIds: NodeId[] }>;
  getPatternForNode(nodeId: NodeId): ToolkitProvenance | undefined;
  getNodesForInstance(instance: string): NodeId[];
  getInstancesOfPattern(pattern: string): string[];
  /** Requires the toolkit that expanded it: the record is not in the graph. */
  getPatternExpansion(instance: string): PatternExpansion | undefined;
  getPatternDeclaration(instance: string): PatternDeclaration | undefined;
  /** Why the pattern chose what it chose, if the expansion is still in memory. */
  explainInstance(instance: string): string[];
}

export function createToolkitQueries(graph: ApplicationGraph, toolkit?: Toolkit): ToolkitQueries {
  return {
    getPatternInstances() {
      const byInstance = new Map<string, { instance: string; pattern: string; nodeIds: NodeId[] }>();
      for (const node of graph.listNodes()) {
        const provenance = provenanceOf(node as { metadata?: Record<string, unknown> });
        if (!provenance) {
          continue;
        }
        const existing = byInstance.get(provenance.instance) ?? {
          instance: provenance.instance,
          pattern: provenance.pattern,
          nodeIds: [],
        };
        existing.nodeIds.push(node.id);
        byInstance.set(provenance.instance, existing);
      }
      return [...byInstance.values()];
    },
    getPatternForNode: (nodeId) => {
      const node = graph.getNode(nodeId);
      return node ? provenanceOf(node as { metadata?: Record<string, unknown> }) : undefined;
    },
    getNodesForInstance: (instance) => nodesOfInstance(graph, instance),
    getInstancesOfPattern: (pattern) => instancesOfPattern(graph, pattern),
    getPatternExpansion: (instance) => toolkit?.inspect(graph, instance),
    getPatternDeclaration: (instance) => toolkit?.inspect(graph, instance)?.declaration,
    explainInstance: (instance) => toolkit?.inspect(graph, instance)?.explanations ?? [],
  };
}

/**
 * Rewrites a canonical validation finding so it points at the declaration that caused it.
 *
 * Toolkit `check` catches what it can before expansion. Anything it cannot — a rule that only
 * holds over the assembled graph — surfaces from `validateGraph` against a node the author
 * never wrote. Provenance is what turns `ui_product_list_row_action_0 has no argument for
 * param_product` into `product_list ▸ entity-list ▸ row-action`, which is the difference
 * between a diagnostic an agent can act on and one it has to reverse-engineer.
 */
export interface MappedIssue {
  code: string;
  message: string;
  nodeId?: NodeId;
  /** `product_list.row-action`, when the node came from a pattern. */
  declarationPath?: string;
  pattern?: string;
  instance?: string;
  /** The full chain, outermost first, for a node from a nested pattern. */
  ancestry?: string[];
}

export function mapIssuesToDeclarations(
  graph: ApplicationGraph,
  issues: readonly { code: string; message: string; nodeId?: NodeId }[],
): MappedIssue[] {
  return issues.map((issue) => {
    if (!issue.nodeId) {
      return { code: issue.code, message: issue.message };
    }
    const node = graph.getNode(issue.nodeId);
    const provenance = node ? provenanceOf(node as { metadata?: Record<string, unknown> }) : undefined;
    if (!provenance) {
      return { code: issue.code, message: issue.message, nodeId: issue.nodeId };
    }
    return {
      code: issue.code,
      message: issue.message,
      nodeId: issue.nodeId,
      declarationPath: `${provenance.instance}.${provenance.part}`,
      pattern: provenance.pattern,
      instance: provenance.instance,
      ...(provenance.ancestry ? { ancestry: provenance.ancestry } : {}),
    };
  });
}
