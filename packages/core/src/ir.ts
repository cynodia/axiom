import type { FieldId, NodeId } from './ids.js';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  ExpressionDef,
  GraphEdge,
  RouteParameter,
  StateDef,
  TransitionConstraintDef,
} from './nodes.js';
import type { FieldIndexEntry } from './graph.js';
import type { UINode } from './ui.js';
import type { AnyNode } from './types.js';
import type { TypeRef } from './type-ref.js';
import type { Authority } from './authority.js';
import type { ResolvedPresentation } from './presentation.js';
import type { Theme } from './theme.js';
import type { TriggerDef } from './triggers.js';

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
 * `@cynodia/axiom-compiler` and `@cynodia/axiom-runtime`, which is why it lives in core.
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
  /** Rules about how state may change, enforced on every governed mutation path. */
  transitionConstraints: TransitionConstraintDef[];
  /**
   * Named expressions, by id. A runtime evaluating `expression-ref` resolves the body here
   * rather than being handed a closure — the calculation stays data all the way down.
   */
  expressionDefs: Record<NodeId, ExpressionDef>;
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
  /**
   * Whether the field each input addresses is declared required, resolved here so a
   * renderer can mark it without re-deriving the model.
   */
  locationRequired: Record<NodeId, boolean>;
  /**
   * The field that distinguishes the members of each `repeat` node's collection, resolved
   * here so a runtime carries no type inference of its own.
   *
   * A renderer uses it to give every rendered repeat instance a stable identity. A repeat
   * whose member type cannot be resolved statically is absent from this map, and the
   * renderer falls back to the iteration index.
   */
  repeatIdentityFields: Record<NodeId, FieldId>;
  /**
   * The authority of each state. A client runtime refuses to write a state whose authority
   * is `server`, whatever path attempts it.
   */
  authority: Record<NodeId, Authority>;
  /**
   * Actions the client must send to the authority rather than execute itself. Their
   * operations, guards and authorization are **absent** from this IR: a client is never
   * given the rules it is not trusted to apply.
   */
  remoteActionIds: NodeId[];
  /** The application's visual identity, completed against the default theme. */
  theme: Theme;
  /**
   * Presentation with every question already answered, per UI node: renderer defaults,
   * theme, inheritance, semantic inference, node declaration and responsive overrides all
   * resolved. A renderer reads this and needs to know nothing about how it was decided.
   *
   * It is deliberately still semantic — roles, tokens and device classes, not CSS — so a
   * second renderer remains possible.
   */
  presentation: Record<NodeId, ResolvedPresentation>;
  /**
   * Client-authority triggers only — `interval`/`delay`/`lifecycle('application-start' |
   * 'runtime-ready')` triggers whose target action executes locally, plus
   * `lifecycle('route-enter' | 'route-leave')` triggers, which are inherently a client
   * concept. No `event`-kind trigger, no integration, and no secret ever reaches this IR
   * (spec §80).
   */
  triggers: TriggerDef[];
}
