import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  ExpressionDef,
  GraphEdge,
  RouteDef,
  StateDef,
  TransitionConstraintDef,
} from './nodes.js';
import type { NodeId } from './ids.js';
import type { UINode, UINodeKind } from './ui.js';
import type { ThemeInput } from './theme.js';
import type { EventDef } from './events.js';
import type { IntegrationDef, IntegrationOperationDef } from './integrations.js';
import type { TriggerDef } from './triggers.js';
import type { SubscriptionDef } from './subscriptions.js';
import type { StorageDef } from './storage.js';

export type SemanticNodeKind =
  | 'entity'
  | 'state'
  | 'action'
  | 'constraint'
  | 'transition-constraint'
  | 'route'
  | 'expression'
  | 'integration'
  | 'integration-operation'
  | 'event'
  | 'trigger'
  | 'subscription'
  | 'storage';

/** Every semantic node kind, enumerated so tests can walk them. */
export const SEMANTIC_NODE_KINDS: readonly SemanticNodeKind[] = [
  'entity',
  'state',
  'action',
  'constraint',
  'transition-constraint',
  'route',
  'expression',
  'integration',
  'integration-operation',
  'event',
  'trigger',
  'subscription',
  'storage',
];

export type NodeKind = SemanticNodeKind | UINodeKind;

export type AnyNode =
  | EntityDef
  | StateDef
  | ActionDef
  | ConstraintDef
  | TransitionConstraintDef
  | RouteDef
  | ExpressionDef
  | IntegrationDef
  | IntegrationOperationDef
  | EventDef
  | TriggerDef
  | SubscriptionDef
  | StorageDef
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
  /** Visual identity. Presentation only: a theme can never change behaviour. */
  theme?: ThemeInput;
  /**
   * The entity whose fields an authorization expression reads through `PRINCIPAL`. It
   * describes a caller, and is never stored as application state.
   */
  principalEntityId?: NodeId;
  metadata?: Record<string, unknown>;
}
