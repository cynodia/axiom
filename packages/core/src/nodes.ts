import type { Expression } from './expressions.js';
import type { CollectionItemLocation, Location } from './location.js';
import type { EdgeId, FieldId, NodeId } from './ids.js';
import type { TypeRef } from './type-ref.js';
import type { ConfirmationPresentation } from './presentation.js';
import type { Authority } from './authority.js';

export interface NodeBase {
  id: NodeId;
  name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A field of an entity.
 *
 * Fields are independently identifiable and globally unique across the graph, and
 * **instance data is keyed by `FieldId`, never by `name`**: a record looks like
 * `{ [F_TITLE]: 'Dune' }`, not `{ title: 'Dune' }`. `name` is metadata for humans and
 * resolves nothing.
 */
export interface FieldDef {
  id: FieldId;
  name?: string;
  valueType: TypeRef;
  /**
   * The value must be **present** in every canonical instance — not `null` and not
   * `undefined`. It says nothing about emptiness: `0`, `false`, `''` and `[]` all satisfy
   * it. Express "must not be blank" as a `ConstraintDef` using `non-empty`.
   */
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

/**
 * A record type. Instances of it are found wherever a state's declared type says they
 * live — including nested inside collections and inside other entities — and are validated
 * there.
 */
export interface EntityDef extends NodeBase {
  kind: 'entity';
  fields: FieldDef[];
  /**
   * Field used to distinguish instances of this entity.
   *
   * Required in order to address an instance by identity (`identitySelector`), and
   * required by every `TransitionConstraintDef` on this entity — without it such a rule is
   * **silently skipped**. Declare it on every entity stored in a collection.
   */
  identityFieldId?: FieldId;
}

export type StatePersistence =
  | { kind: 'memory' }
  | { kind: 'local-storage'; key?: string }
  | { kind: 'remote'; sourceId: NodeId };

/**
 * A named application value: stored, or computed from other state.
 *
 * A state with no `derivation` is stored, and one that is neither `draft` nor `ephemeral`
 * is **canonical** — the state entity constraints and schema conformance apply to. Stored
 * values are deeply frozen on entry to the store, and every read hands out a copy.
 */
export interface StateDef extends NodeBase {
  kind: 'state';
  valueType: TypeRef;
  /**
   * Seed data, keyed by `FieldId` wherever it contains a record. It is walked against
   * `valueType` recursively at validation time, so data keyed by field *name* is rejected
   * rather than surfacing later as an inexplicably empty UI.
   *
   * Absent, the state starts at the default for its type: `optional` → `null`,
   * `collection` → `[]`, `number` → `0`, `boolean` → `false`, other primitive → `''`,
   * `enum` → its first value, `entity` → `null`.
   */
  initialValue?: LiteralValue;
  /**
   * When present the state is computed rather than stored.
   *
   * Derived state is **read-only**: a write is rejected by `validateGraph` and by the
   * runtime. It is recomputed on demand and handed out as a frozen deep copy, so nothing
   * can work by sharing an object with the state it was derived from. Instance validation
   * skips it, because the data is already validated where it is stored.
   */
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
  /**
   * Who may commit a canonical mutation to this state. Absent, it is `'client'`, so every
   * 0.5.x graph keeps executing exactly as it did.
   *
   * A client MUST NOT commit a mutation to `'server'` state through any path: an action
   * that writes it executes on the authority, and an input bound into it is a validation
   * error. Authority is separate from `persistence` — one says who decides a value, the
   * other where a decided value survives.
   */
  authority?: Authority;
  /**
   * Marks server-authoritative state the client may not observe at all. Such a state is
   * excluded from the client IR entirely rather than merely being unwritable.
   */
  serverOnly?: boolean;
  persistence?: StatePersistence;
}

/**
 * A parameter of an `ExpressionDef`. Bound only inside that definition's body.
 */
export interface ExpressionParameter {
  id: NodeId;
  name?: string;
  valueType?: TypeRef;
}

/**
 * A named, reusable expression: *this semantic calculation exists once*.
 *
 * Building the same filter three times with three different scope ids is how an author (or
 * an agent) ends up with twelve near-identical expressions and a scope collision. A
 * definition is the alternative, and it is a **graph node** rather than a TypeScript
 * variable holding an `Expression` — because a variable solves neither of the two problems
 * that matter: the calculation is still copied into every consumer, and its scope ids are
 * still shared with whatever surrounds it.
 *
 * As a node it is serializable, inspectable, type-inferable, dependency-analyzable and
 * addressable: `expressionRef(id)` names it, `AgentAPI` can list its consumers, and the read
 * edges of a consumer include the states the definition reads.
 *
 * **Scope isolation.** The body sees its own `parameters`, application state, and the
 * iteration scopes it introduces itself — and nothing else. Not the caller's iteration
 * scopes, not the caller's action or route parameters, not an entity under validation. A
 * definition therefore means the same thing everywhere it is used, which is the only way
 * reuse can be sound. Pass whatever the caller has as an argument.
 *
 * It is data, never a closure: there is no JavaScript function anywhere in it.
 */
export interface ExpressionDef extends NodeBase {
  kind: 'expression';
  parameters?: ExpressionParameter[];
  /** The calculation. Evaluated in an isolated scope. */
  expression: Expression;
  /** The declared result type. Absent, the type is inferred from the body. */
  valueType?: TypeRef;
  description?: string;
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

/**
 * Behaviour expressed as data, executed as a transaction.
 *
 * An invocation proceeds: resolve the action, bind parameters, evaluate preconditions in
 * order, ask for confirmation if required — **none of which opens a transaction, so a
 * refusal at any of those stages mutates nothing** — then begin a transaction, run the
 * operations sequentially against provisional state, evaluate entity constraints,
 * transition constraints and postconditions, and either commit everything or roll back
 * every mutation.
 *
 * `invokeAction` returns the diagnostics of that invocation.
 */
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
  /**
   * Whether the caller may invoke this action at all, evaluated **on the authority** with
   * the caller bound to `PRINCIPAL`.
   *
   * It is checked before any guard and before any transaction opens, and it is stripped
   * from the client IR — a client never learns the rule and can never satisfy it by
   * claiming to. `requiresConfirmation` is UX and is not an authorization mechanism.
   */
  authorization?: Expression;
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

/**
 * Writes a value to an addressed position.
 *
 * A missing field along the path is created. A missing **collection item** is not: an
 * identity selector that matches nothing reports `LOCATION_RESOLUTION_FAILED`.
 */
export interface SetOperation {
  kind: 'set';
  target: Location;
  value: Expression;
}

/**
 * Adds a member to a collection. The constructed value is deep-cloned before it is stored.
 *
 * A newly inserted entity instance has no previous state, so **no transition constraint is
 * evaluated for it**. Govern creation with an action guard or an entity constraint.
 */
export interface InsertOperation {
  kind: 'insert';
  /** A location addressing a collection. A non-array current value is treated as `[]`. */
  target: Location;
  value: Expression;
  /** Defaults to `'end'`. */
  position?: 'start' | 'end';
}

/**
 * Removes one member of a collection.
 *
 * A selector that matches nothing is a **no-op**: no mutation, no log entry and no
 * diagnostic. Removing an existing instance *is* a transition, with the proposed value
 * bound to nothing.
 */
export interface RemoveOperation {
  kind: 'remove';
  target: CollectionItemLocation;
}

/**
 * Performs a set of mutations once per member of a collection.
 *
 * Iteration N observes provisional writes from previous iterations. The loop executes
 * inside the containing action's transaction and opens none of its own, so any failure
 * rolls back the complete action — every iteration included. The collection itself is
 * evaluated **once**, before the first member is mutated.
 *
 * `scopeId` introduces an iteration scope. Nested expressions refer to the current member
 * as `ref(scopeId)`, and nested locations may use it to address the canonical record the
 * member points at. Nested operations must be mutations only.
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

/**
 * An invariant over proposed state, evaluated after every governed mutation.
 *
 * A constraint that cannot be evaluated counts as **violated**, never as satisfied.
 */
export interface ConstraintDef extends NodeBase {
  kind: 'constraint';
  expression: Expression;
  /**
   * When set, the expression is evaluated once per canonical instance of this entity, with
   * the instance bound to `ref(entityId)` — wherever that instance is stored, including
   * nested inside another entity. Without it the expression is evaluated once, in the root
   * scope.
   */
  entityId?: NodeId;
  /** Defaults to `'error'`. A `'warning'` is advice and **never blocks a write**. */
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
 *
 * "Previous" means committed state as it stood immediately before the **outermost**
 * transaction began — not the previous operation, and not the previous iteration.
 *
 * A **newly inserted** instance has no previous state and is therefore **not evaluated**.
 * Govern creation with an action guard or an entity constraint. The entity must declare
 * `identityFieldId`; without one this rule is silently skipped.
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
