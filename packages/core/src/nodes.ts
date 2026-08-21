import type { Expression } from './expressions.js';
import type { CollectionItemLocation, Location } from './location.js';
import type { EdgeId, FieldId, NodeId } from './ids.js';
import type { TypeRef } from './type-ref.js';
import type { ConfirmationPresentation } from './presentation.js';

export interface NodeBase {
  id: NodeId;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface FieldDef {
  id: FieldId;
  name?: string;
  valueType: TypeRef;
  required?: boolean;
  defaultValue?: LiteralValue;
  metadata?: Record<string, unknown>;
}

export type LiteralValue =
  | string
  | number
  | boolean
  | null
  | LiteralValue[]
  | { [key: string]: LiteralValue };

export interface EntityDef extends NodeBase {
  kind: 'entity';
  fields: FieldDef[];
  /** Field used to distinguish instances of this entity. */
  identityFieldId?: FieldId;
}

export type StatePersistence =
  | { kind: 'memory' }
  | { kind: 'local-storage'; key?: string }
  | { kind: 'remote'; sourceId: NodeId };

export interface StateDef extends NodeBase {
  kind: 'state';
  valueType: TypeRef;
  initialValue?: LiteralValue;
  /** When present the state is computed rather than stored. */
  derivation?: Expression;
  /**
   * Marks a state that holds work in progress. Draft instances are incomplete by
   * definition, so instance validation skips them until an action commits the value.
   */
  draft?: boolean;
  /**
   * Marks ephemeral presentation state — which panel is expanded, which tab is selected,
   * whether a dialog is open. It is not canonical domain state: instance validation skips
   * it, and it may not be persisted. Marking it says so in the graph instead of leaving an
   * agent to guess which states are domain facts.
   *
   * It changes what a state *is*, never what is permitted: a write reaching domain state
   * is governed exactly as before.
   */
  ephemeral?: boolean;
  persistence?: StatePersistence;
}

export interface ActionParameter {
  id: NodeId;
  name?: string;
  valueType?: TypeRef;
  required?: boolean;
}

export interface FailureMode {
  code: string;
  message?: string;
}

/** A condition together with the failure it reports, so the two cannot drift apart. */
export interface ActionGuard {
  condition: Expression;
  failureMode?: FailureMode;
}

export interface ActionDef extends NodeBase {
  kind: 'action';
  parameters?: ActionParameter[];
  /** Preferred over the parallel `preconditions` and `failureModes` arrays. */
  guards?: ActionGuard[];
  preconditions?: Expression[];
  operations: Operation[];
  postconditions?: Expression[];
  failureModes?: FailureMode[];
  /** Declared destructive intent. Semantics may also be inferred from operations. */
  destructive?: boolean;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
  /** What the confirmation says, when a plain message is not enough. */
  confirmation?: ConfirmationPresentation;
}

/**
 * The conditions an action checks, however they were written. `guards` pairs each
 * condition with its failure; the older parallel arrays are matched by position.
 */
export function actionGuards(action: ActionDef): ActionGuard[] {
  if (action.guards && action.guards.length > 0) {
    return action.guards;
  }
  return (action.preconditions ?? []).map((condition, index) => ({
    condition,
    ...(action.failureModes?.[index] ? { failureMode: action.failureModes[index] } : {}),
  }));
}

export type Operation =
  | SetOperation
  | InsertOperation
  | RemoveOperation
  | ForEachOperation
  | InvokeOperation
  | NavigateOperation
  | NativeOperation;

export type OperationKind = Operation['kind'];

/** Every operation kind the runtime is required to execute. */
export const OPERATION_KINDS: readonly OperationKind[] = [
  'set',
  'insert',
  'remove',
  'for-each',
  'invoke',
  'navigate',
  'native',
];

/** Every mutation is a set, an insert or a remove against an addressed Location. */
export type MutationOperation = SetOperation | InsertOperation | RemoveOperation;

export interface SetOperation {
  kind: 'set';
  target: Location;
  value: Expression;
}

export interface InsertOperation {
  kind: 'insert';
  /** A location addressing a collection. */
  target: Location;
  value: Expression;
  position?: 'start' | 'end';
}

export interface RemoveOperation {
  kind: 'remove';
  target: CollectionItemLocation;
}

/**
 * Performs a set of mutations once per member of a collection. The iteration is not a
 * transaction of its own: it runs inside the action's transaction, so a failure in any
 * iteration rolls the whole action back.
 *
 * `scopeId` introduces an iteration scope. Nested expressions refer to the current member
 * as `ref(scopeId)`, and nested locations may use it to address the canonical record the
 * member points at.
 */
export interface ForEachOperation {
  kind: 'for-each';
  collection: Expression;
  scopeId: NodeId;
  operations: MutationOperation[];
}

export function isMutationOperation(operation: Operation): operation is MutationOperation {
  return operation.kind === 'set' || operation.kind === 'insert' || operation.kind === 'remove';
}

export function forEach(
  collection: Expression,
  scopeId: NodeId,
  operations: MutationOperation[],
): ForEachOperation {
  return { kind: 'for-each', collection, scopeId, operations };
}

export interface InvokeOperation {
  kind: 'invoke';
  actionId: NodeId;
  arguments?: Record<string, Expression>;
}

export interface NavigateOperation {
  kind: 'navigate';
  routeId?: NodeId;
  path?: string;
  /** Keyed by route parameter id. */
  parameters?: Record<string, Expression>;
}

export type NativeEffect =
  | { kind: 'reads-state'; stateId: NodeId }
  | { kind: 'writes-state'; stateId: NodeId }
  | { kind: 'external'; description: string };

/**
 * Controlled boundary for behaviour the operation vocabulary cannot express. The graph
 * declares an implementation id and its effects; the implementation itself is registered
 * with the runtime and is never embedded in the graph as source text.
 */
export interface NativeOperation {
  kind: 'native';
  implementationId: string;
  inputs?: Record<string, Expression>;
  /**
   * Where the implementation's return value is stored. Native code never writes Axiom
   * state itself; it returns a value that the mutation engine then sets.
   */
  resultTarget?: Location;
  declaredEffects?: NativeEffect[];
}

export interface ConstraintDef extends NodeBase {
  kind: 'constraint';
  expression: Expression;
  /** When set, the expression is evaluated once per instance of this entity. */
  entityId?: NodeId;
  severity?: 'error' | 'warning';
  message?: string;
}

/**
 * A rule about how state may change, rather than about what state may be.
 *
 * An ordinary constraint judges the proposed state on its own; a transition constraint
 * sees the instance as it was when the transaction began *and* as the transaction
 * proposes it. That is what lets a rule like "once confirmed, an order may not change"
 * hold no matter which path attempts the write — an action, an input binding, an
 * iteration, or something added later.
 *
 * `previousScopeId` and `proposedScopeId` bind those two instances for the expression.
 * When the instance is being removed, the proposed scope is bound to nothing.
 */
export interface TransitionConstraintDef extends NodeBase {
  kind: 'transition-constraint';
  /** The entity whose transitions are governed. It must have an identity field. */
  entityId: NodeId;
  previousScopeId: NodeId;
  proposedScopeId: NodeId;
  /** Must hold for every governed transition. */
  expression: Expression;
  severity?: 'error' | 'warning';
  message?: string;
}

export interface RouteParameter {
  id: NodeId;
  /** Matches the `:name` placeholder in the route path. */
  name: string;
  valueType?: TypeRef;
}

export interface RouteDef extends NodeBase {
  kind: 'route';
  path: string;
  viewId: NodeId;
  parameters?: RouteParameter[];
}

export type EdgeKind =
  | 'contains'
  | 'reads'
  | 'writes'
  | 'invokes'
  | 'renders'
  | 'binds'
  | 'depends-on'
  | 'derives-from'
  | 'constrains'
  | 'routes-to'
  | 'references';

export const EDGE_KINDS: readonly EdgeKind[] = [
  'contains',
  'reads',
  'writes',
  'invokes',
  'renders',
  'binds',
  'depends-on',
  'derives-from',
  'constrains',
  'routes-to',
  'references',
];

export interface GraphEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
}
