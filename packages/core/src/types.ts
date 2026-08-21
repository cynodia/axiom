import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  GraphEdge,
  RouteDef,
  StateDef,
  TransitionConstraintDef,
} from './nodes.js';
import type { NodeId } from './ids.js';
import type { UINode, UINodeKind } from './ui.js';

export type SemanticNodeKind =
  | 'entity'
  | 'state'
  | 'action'
  | 'constraint'
  | 'transition-constraint'
  | 'route';

export type NodeKind = SemanticNodeKind | UINodeKind;

export type AnyNode =
  | EntityDef
  | StateDef
  | ActionDef
  | ConstraintDef
  | TransitionConstraintDef
  | RouteDef
  | UINode;

export type NodeOfKind<K extends NodeKind> = Extract<AnyNode, { kind: K }>;

/** A node as supplied by a caller: the id may be omitted and will be generated. */
export type NodeInput<T extends AnyNode = AnyNode> = T extends AnyNode
  ? Omit<T, 'id'> & { id?: NodeId }
  : never;

export interface ApplicationGraphData {
  id: string;
  name: string;
  version: string;
  nodes: Record<NodeId, AnyNode>;
  edges: Record<string, GraphEdge>;
  metadata?: Record<string, unknown>;
}
