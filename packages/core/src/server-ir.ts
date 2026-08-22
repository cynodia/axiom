import type { FieldId, NodeId } from './ids.js';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  StateDef,
  TransitionConstraintDef,
} from './nodes.js';
import type { FieldIndexEntry } from './graph.js';

/**
 * The contract version a Server IR conforms to. A runtime that does not recognize the
 * value MUST refuse the IR rather than interpret it partially.
 */
export const SERVER_IR_CONTRACT = 'axiom.server.v1';

export type ServerIRContract = typeof SERVER_IR_CONTRACT;

/**
 * The normalized form an authority executes: everything required to decide a mutation, and
 * nothing else.
 *
 * It is deliberately **not** the client IR. It carries no UI nodes, no presentation, no
 * theme and no routes, because none of that decides anything. It does carry the rules a
 * client must never be trusted with — authorization expressions, guards, constraints — and
 * the state the client may not observe.
 *
 * It is plain JSON: serializable, deterministic, free of closures and of anything specific
 * to a language or a host. A conforming runtime in another language executing the same
 * serialized IR must reach the same semantic result, which is what the conformance suite
 * exists to check.
 */
export interface ServerIR {
  contract: ServerIRContract;
  id: string;
  name: string;
  version: string;
  entities: EntityDef[];
  /** Field lookup, pre-indexed so a runtime re-derives nothing. */
  fields: Record<FieldId, FieldIndexEntry>;
  /** Authoritative state, plus whatever authoritative execution reads. */
  states: StateDef[];
  /** Only the actions this authority executes, fully specified. */
  actions: Record<NodeId, ActionDef>;
  constraints: ConstraintDef[];
  transitionConstraints: TransitionConstraintDef[];
  /**
   * The entity whose fields an authorization expression reads through `PRINCIPAL`. Absent
   * when the application declares no authorization.
   */
  principalEntityId?: NodeId;
  /** The states a client is permitted to observe, in declaration order. */
  observableStateIds: NodeId[];
}
