import { SEMANTIC_NODE_KINDS, UI_NODE_KINDS } from '@cynodia/axiom-core';
import type { ApplicationGraph, NodeKind } from '@cynodia/axiom-core';

/**
 * A canonical semantic inventory (spec16 §9-11, §113-115): every graph node, by id and kind,
 * with enough relationship-shape metadata for an agent to decide what to inspect next
 * without retrieving the whole graph. Every field is one the graph already represents —
 * nothing here is invented (spec16 §10 "must not invent fields that are not represented
 * semantically").
 */

export interface InventoryEntry {
  id: string;
  kind: string;
  name?: string;
  /** How many other nodes this one points at, and how many point at it. */
  dependencyCount: number;
  dependentCount: number;
}

export interface SemanticInventory {
  countsByKind: Record<string, number>;
  entries: InventoryEntry[];
  /** Present when `limit` truncated the result — pass back as `cursor` to continue (spec16 §114). */
  nextCursor?: string;
}

export interface InventoryQuery {
  /** Restrict to these node kinds. Absent means every graph-model and UI kind. */
  kinds?: readonly string[];
  /** Keyset pagination: only entries whose id sorts after this one. */
  cursor?: string;
  /** Maximum entries to return. Ordering is canonical (by id), so pagination is deterministic. */
  limit?: number;
}

const ALL_KINDS: readonly string[] = [...SEMANTIC_NODE_KINDS, ...UI_NODE_KINDS];

/** Every node kind the inventory can enumerate — the graph-model kinds plus every UI kind. */
export function inventoryKinds(): readonly string[] {
  return ALL_KINDS;
}

export function semanticInventory(graph: ApplicationGraph, query: InventoryQuery = {}): SemanticInventory {
  const kinds = query.kinds ?? ALL_KINDS;
  const countsByKind: Record<string, number> = {};
  const entries: InventoryEntry[] = [];
  for (const kind of kinds) {
    const nodes = graph.getNodesByKind(kind as NodeKind);
    countsByKind[kind] = nodes.length;
    for (const node of nodes) {
      entries.push({
        id: String(node.id),
        kind,
        ...(node.name ? { name: node.name } : {}),
        dependencyCount: graph.getOutgoingEdges(node.id).length,
        dependentCount: graph.getIncomingEdges(node.id).length,
      });
    }
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let page = entries;
  if (query.cursor !== undefined) {
    page = page.filter((entry) => entry.id > query.cursor!);
  }
  let nextCursor: string | undefined;
  if (query.limit !== undefined && page.length > query.limit) {
    nextCursor = page[query.limit - 1].id;
    page = page.slice(0, query.limit);
  }

  return { countsByKind, entries: page, ...(nextCursor ? { nextCursor } : {}) };
}
