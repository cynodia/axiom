import type { FieldId, NodeId } from './ids.js';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  GraphEdge,
  RouteParameter,
  StateDef,
} from './nodes.js';
import type { FieldIndexEntry } from './graph.js';
import type { UINode } from './ui.js';
import type { AnyNode } from './types.js';
import type { TypeRef } from './type-ref.js';

export interface RouteSegment {
  kind: 'static' | 'parameter';
  value: string;
  parameterId?: NodeId;
}

export interface CompiledRoute {
  id: NodeId;
  path: string;
  viewId: NodeId;
  segments: RouteSegment[];
  parameters: RouteParameter[];
  /** Number of dynamic segments; routes are matched most-specific first. */
  specificity: number;
}

/**
 * The normalized form a compiler hands to a runtime: the same semantics as the graph,
 * with references resolved and lookups pre-indexed. It is the shared contract between
 * `@axiom/compiler` and `@axiom/runtime`, which is why it lives in core.
 */
export interface ApplicationIR {
  id: string;
  name: string;
  version: string;
  nodes: Record<NodeId, AnyNode>;
  fields: Record<FieldId, FieldIndexEntry>;
  entities: EntityDef[];
  states: StateDef[];
  actions: Record<NodeId, ActionDef>;
  uiNodes: Record<NodeId, UINode>;
  constraints: ConstraintDef[];
  routes: CompiledRoute[];
  edges: GraphEdge[];
  /**
   * The type each input's bound location addresses, resolved during normalization so a
   * runtime never has to re-derive it.
   */
  locationTypes: Record<NodeId, TypeRef>;
  /**
   * The state each input's bound location is rooted in. A runtime uses it to tell a write
   * to canonical application state from a write to a draft.
   */
  locationRoots: Record<NodeId, NodeId>;
}
