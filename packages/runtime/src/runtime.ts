import type { RemoteGateway } from './runtime-types.js';
import type {
  ActionDef,
  AnyNode,
  ApplicationIR,
  CompiledRoute,
  ConstraintDef,
  EntityDef,
  Expression,
  FieldDef,
  FieldId,
  Location,
  NodeId,
  Operation,
  ResolvedPresentation,
  StateDef,
  TypeRef,
  UINode,
} from '@cynodia/axiom-core';
import type { ConfirmationRequest, DomElement, DomEvent, HostEnvironment } from './dom.js';
import { formatValue } from './format.js';
import {
  ariaRoleFor,
  headingTag,
  landmarkTag,
  presentationClasses,
} from './presentation-classes.js';
import { createMutationEngine } from './mutation/mutation-engine.js';
import type { MutationContext, MutationLogEntry, MutationResult } from './mutation/mutation-engine.js';
import { LocationResolutionError, resolveLocation } from './mutation/resolve-location.js';
import { createStateStore } from './mutation/store.js';
import { createTransactionManager } from './mutation/transaction.js';
import type { RuntimeTransaction } from './mutation/transaction.js';
import {
  ExpressionEvaluationError,
  cloneValue,
  compareValues,
  deepFreeze,
  isEmptyValue,
  isPresent,
  isRecord,
  toBoolean,
  toText,
  valuesEqual,
} from './mutation/values.js';

/**
 * The diagnostics a runtime can report. Agents match on the code rather than parsing the
 * message, so this vocabulary is part of the public contract.
 */
export const RUNTIME_DIAGNOSTIC_CODES = {
  ACTION_NOT_FOUND: 'ACTION_NOT_FOUND',
  PARAMETER_MISSING: 'PARAMETER_MISSING',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  POSTCONDITION_FAILED: 'POSTCONDITION_FAILED',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
  REQUIRED_FIELD_MISSING: 'REQUIRED_FIELD_MISSING',
  ENUM_VALUE_INVALID: 'ENUM_VALUE_INVALID',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  EXPRESSION_EVALUATION_FAILED: 'EXPRESSION_EVALUATION_FAILED',
  UNRESOLVED_REFERENCE: 'UNRESOLVED_REFERENCE',
  LOCATION_RESOLUTION_FAILED: 'LOCATION_RESOLUTION_FAILED',
  MUTATION_FAILED: 'MUTATION_FAILED',
  DERIVED_STATE_WRITE: 'DERIVED_STATE_WRITE',
  UNKNOWN_STATE: 'UNKNOWN_STATE',
  TRANSITION_CONSTRAINT_VIOLATION: 'TRANSITION_CONSTRAINT_VIOLATION',
  UNSUPPORTED_EXPRESSION: 'UNSUPPORTED_EXPRESSION',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  NATIVE_OPERATION_MISSING: 'NATIVE_OPERATION_MISSING',
  UI_NODE_MISSING: 'UI_NODE_MISSING',
  UNSUPPORTED_UI_NODE: 'UNSUPPORTED_UI_NODE',
  INPUT_REJECTED: 'INPUT_REJECTED',
  PERSISTED_STATE_UNREADABLE: 'PERSISTED_STATE_UNREADABLE',
  /** A local write was attempted against state whose authority is the server. */
  SERVER_STATE_WRITE: 'SERVER_STATE_WRITE',
  /** An action belongs to the authority, but no gateway to it was configured. */
  REMOTE_ACTION_UNAVAILABLE: 'REMOTE_ACTION_UNAVAILABLE',
  /** The authority could not be reached. Authoritative state was not loaded. */
  AUTHORITY_UNREACHABLE: 'AUTHORITY_UNREACHABLE',
} as const;

export type RuntimeDiagnosticCode =
  (typeof RUNTIME_DIAGNOSTIC_CODES)[keyof typeof RUNTIME_DIAGNOSTIC_CODES];

/**
 * A structured runtime failure. Match on `code` and read `details`; the `message` is for
 * people and is not a stable contract.
 */
export interface RuntimeDiagnostic {
  code: RuntimeDiagnosticCode;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: NodeId;
  fieldId?: FieldId;
  actionId?: NodeId;
  constraintId?: NodeId;
  stateId?: NodeId;
  location?: Location;
  transactionId?: string;
  /** Structured context, so an agent never has to read the message. */
  details?: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
  /**
   * Set when the invocation was dispatched to the authority. `ok` is not yet meaningful:
   * the outcome arrives later, and reaches the interface through the action's recorded
   * outcome and any `diagnostic` node presenting it.
   */
  pending?: true;
}

/**
 * How a client reaches the authority.
 *
 * The client requests **semantic actions**; it never sends operations. A remote invocation
 * is dispatched and answered later, so `invokeAction` returns `pending` and the outcome
 * arrives through the same diagnostic lifecycle a local refusal uses.
 */
export type { RemoteGateway } from './runtime-types.js';

/**
 * The outcome of an action's most recent invocation.
 *
 * `ok` and `cancelled` both carry no diagnostics, so a `diagnostic` UI node presenting
 * this action shows nothing after either. They are distinguished here because the
 * difference matters to an agent: `cancelled` means a person declined the confirmation,
 * not that the action was refused.
 */
export interface ActionOutcome {
  actionId: NodeId;
  /** `pending` means the request is with the authority and the outcome is not yet known. */
  outcome: 'ok' | 'failed' | 'cancelled' | 'pending';
  diagnostics: RuntimeDiagnostic[];
}

export interface RouteMatch {
  route: CompiledRoute;
  /** Parameter values keyed by route parameter id. */
  parameters: Record<string, string>;
}

export type NativeImplementation = (inputs: Record<string, unknown>) => unknown;

/**
 * When entity constraints are evaluated after an input writes to its location.
 * `'deferred'` turns the per-keystroke check off entirely, leaving validity to the next
 * action. Transition constraints are unaffected by this setting and always apply.
 */
export type InputValidationMode = 'immediate' | 'deferred';

export interface AxiomRuntimeOptions {
  ir: ApplicationIR;
  rootElement: DomElement;
  host: HostEnvironment;
  nativeOperations?: Record<string, NativeImplementation>;
  /**
   * How to reach the authority. Required if the application has server-authoritative
   * state; without it a remote invocation reports `REMOTE_ACTION_UNAVAILABLE`.
   */
  remote?: RemoteGateway;
  inputValidation?: InputValidationMode;
  /** Records previous and next values in the mutation log. */
  recordMutationValues?: boolean;
}

export interface AxiomRuntime {
  /**
   * Brings the runtime to its initial usable state.
   *
   * The lifecycle is fixed and does not depend on whether a gateway is configured:
   *
   * 1. local state is initialized from `initialValue` and persistence, before anything else;
   * 2. route matching is resolved and the application renders once, so a slow authority
   *    never leaves a blank page;
   * 3. if a `remote` gateway with a snapshot is configured, authoritative state is loaded
   *    and applied, and the application renders again.
   *
   * `start()` returns a promise that settles when step 3 has completed. Awaiting it is the
   * whole startup sequence: **there is no second call to remember.** Ignoring the promise
   * is safe — steps 1 and 2 have already run synchronously — but authoritative state may
   * not have arrived yet.
   *
   * If synchronization fails, the failure is reported as an `AUTHORITY_UNREACHABLE`
   * diagnostic and `authoritativeStateLoaded()` stays false, so an empty authoritative
   * collection is never mistaken for a loaded one.
   */
  start(): Promise<void>;
  /**
   * Whether authoritative state has been loaded successfully.
   *
   * `false` with a configured gateway means the authority has not answered — which is not
   * the same as an authoritative collection that is genuinely empty. Applications with no
   * remote gateway are always `true`: all their state is local.
   */
  authoritativeStateLoaded(): boolean;
  render(): void;
  /** A deep clone of the value. Derived state is recomputed. */
  getState(id: NodeId): unknown;
  /**
   * Replaces a state value outright, for hosts, tests and seeding.
   *
   * This is an administrative facility, not a semantic write: it does not evaluate
   * preconditions, entity constraints or transition constraints. Application behaviour
   * belongs in actions and input bindings, which are governed.
   */
  hydrateState(id: NodeId, value: unknown): void;
  /**
   * Runs an action as a transaction and returns the diagnostics **of that invocation**,
   * so nothing has to diff global history. Either every mutation commits or every one is
   * rolled back.
   */
  invokeAction(id: NodeId, args?: Record<string, unknown>): ActionResult;
  navigate(path: string): void;
  currentRoute(): RouteMatch | null;
  /** Every diagnostic reported so far. Per-invocation results carry their own. */
  diagnostics(): RuntimeDiagnostic[];
  /** Clears the running log **and** every recorded action outcome. */
  clearDiagnostics(): void;
  /**
   * The outcome of this action's most recent invocation, or `undefined` if it has not been
   * invoked since the last clear or route change. This is what a `diagnostic` UI node
   * presents.
   */
  getActionOutcome(id: NodeId): ActionOutcome | undefined;
  /** Every mutation this runtime has applied, in order, with its semantic location. */
  getMutationLog(): MutationLogEntry[];
  registerNativeOperation(implementationId: string, implementation: NativeImplementation): void;
  /**
   * Invokes an action and waits for its outcome. For a remote action this awaits the
   * authority's answer; for a local one it is `invokeAction` in promise form.
   */
  invokeActionAsync(id: NodeId, args?: Record<string, unknown>): Promise<ActionResult>;
  /**
   * Loads the authoritative snapshot and applies it. Called by `start()` when a gateway
   * provides one.
   */
  syncAuthoritativeState(): Promise<void>;
  /**
   * Resolves when no remote invocation is outstanding.
   *
   * An action started from the interface has no promise the caller can hold; this is how a
   * test, a script or a host waits for the authority to have answered without guessing a
   * delay. Resolves immediately when nothing is in flight.
   */
  settled(): Promise<void>;
  /**
   * Evaluates an expression in the root scope, reporting rather than throwing. It is a
   * pure read: an expression cannot change state.
   *
   * An authority uses it to evaluate an authorization rule before opening a transaction.
   */
  evaluate(expression: Expression): { ok: true; value: unknown } | { ok: false; diagnostic: RuntimeDiagnostic };
}

interface Scope {
  values: Map<string, unknown>;
  parent?: Scope;
}

const MISSING = Symbol('missing');

function unwrapType(type: TypeRef): TypeRef {
  return type.kind === 'optional' ? unwrapType(type.valueType) : type;
}

function defaultForType(type: TypeRef): unknown {
  const resolved = unwrapType(type);
  if (type.kind === 'optional') {
    return null;
  }
  switch (resolved.kind) {
    case 'collection':
      return [];
    case 'primitive':
      switch (resolved.primitive) {
        case 'number':
          return 0;
        case 'boolean':
          return false;
        default:
          return '';
      }
    case 'enum':
      return resolved.values[0] ?? '';
    default:
      return null;
  }
}

/**
 * Collection operators are strict about their source: `null` means a missing or invalid
 * collection, and an empty collection means an empty collection. Conflating the two is
 * what made 0.4 hard to reason about.
 */
function requireCollection(value: unknown, operator: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ExpressionEvaluationError(
      `${operator} expects a collection but received ${describeValue(value)}`,
      { collectionOperator: operator, received: value },
    );
  }
  return value;
}

/** A short, structured description of a runtime value, for diagnostics. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'nothing';
  }
  if (Array.isArray(value)) {
    return `a collection of ${value.length}`;
  }
  if (typeof value === 'object') {
    return 'a record';
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Distinguishes runtimes that share a process.
 *
 * `host.uuid()` is the only entropy a runtime has, and a deterministic host — the memory
 * host, a conformance host, a test double — hands every runtime it constructs the same
 * sequence. Two clients would then generate the same request id for their first remote
 * invocation, and the authority would answer the second from the first one's idempotency
 * record. A counter that lives above the host closes that: within a process it is what
 * separates two runtimes, and across processes a real host's uuid is.
 */
let runtimeSessions = 0;

export function createAxiomRuntime(options: AxiomRuntimeOptions): AxiomRuntime {
  const { ir, rootElement, host } = options;
  const store = createStateStore();
  const derivedCache = new Map<string, unknown>();
  const natives = new Map<string, NativeImplementation>(
    Object.entries(options.nativeOperations ?? {}),
  );
  const diagnostics: RuntimeDiagnostic[] = [];
  /** Rendered controls, keyed by render instance — not by node id. */
  const inputElements = new Map<string, DomElement>();
  /**
   * How each rendered form submits, keyed by the form's render instance.
   *
   * A form with a declared submit control must invoke the action **exactly** as that button
   * would on its own — same arguments, evaluated in the button's own scope. Registering the
   * button's invocation here is what makes the two paths literally the same code, rather
   * than two that have to be kept in step.
   */
  const submitInvokers = new Map<string, () => void>();
  let focusedInstance: string | null = null;
  let focusedCaret: number | null = null;
  let started = false;
  let transactionCounter = 0;
  const mutationLog: MutationLogEntry[] = [];
  const inputValidation = options.inputValidation ?? 'immediate';
  const remote = options.remote;
  const remoteActionIds = new Set<string>(ir.remoteActionIds ?? []);
  /**
   * Set only while an authoritative answer is being applied. The authority owns the value;
   * every other path is refused, which is what makes the boundary structural rather than a
   * convention about where inputs are bound.
   */
  let applyingAuthoritative = false;
  let remoteRequests = 0;
  /** Generated once, and only when this runtime can actually talk to an authority. */
  const sessionId = remote ? `s${(runtimeSessions += 1)}-${host.uuid()}` : '';
  /** False until the authority has answered, when one is configured. */
  let authoritativeLoaded = options.remote?.snapshot === undefined;
  let startup: Promise<void> = Promise.resolve();
  const theme = ir.theme;
  const locale = theme?.locale ?? 'en-US';
  /**
   * Messages for inputs whose last write was refused, so a control can say so. Keyed by
   * render instance: refusing a write in one row must not mark another row invalid.
   */
  const inputErrors = new Map<string, string>();

  /**
   * The most recent outcome of each action, which is what a `diagnostic` node presents.
   * Ephemeral runtime state: it is replaced by the next invocation of the same action, and
   * cleared by `clearDiagnostics()` and by navigating to another route.
   */
  const actionOutcomes = new Map<string, ActionOutcome>();

  /**
   * Buttons that are their form's declared submit control, and the action each submits.
   * Such a button carries native submit behaviour instead of its own click handler, so a
   * click runs the action exactly once.
   */
  const submitControls = new Map<string, { formId: NodeId; actionId: NodeId }>();
  for (const node of Object.values(ir.uiNodes)) {
    if (node.kind !== 'form' || !node.submitButtonId) {
      continue;
    }
    const button = ir.uiNodes[node.submitButtonId];
    if (button?.kind === 'button') {
      submitControls.set(node.submitButtonId, {
        formId: node.id,
        actionId: node.submitActionId ?? button.actionId,
      });
    }
  }

  /** Diagnostic regions, by the action they report. Indexed once. */
  const diagnosticRegions = new Map<string, NodeId[]>();
  for (const node of Object.values(ir.uiNodes)) {
    if (node.kind === 'diagnostic') {
      diagnosticRegions.set(node.actionId, [...(diagnosticRegions.get(node.actionId) ?? []), node.id]);
    }
  }

  function recordOutcome(
    actionId: string,
    outcome: ActionOutcome['outcome'],
    diagnostics: RuntimeDiagnostic[],
  ): void {
    actionOutcomes.set(actionId, {
      actionId: actionId as NodeId,
      outcome,
      // Only what this invocation reported, and only what a region could present.
      diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
    });
  }

  /** Presentation, already resolved by the compiler. The renderer decides nothing. */
  function presentationOf(id: string): ResolvedPresentation | undefined {
    return (ir.presentation as Record<string, ResolvedPresentation> | undefined)?.[id];
  }

  /**
   * Where a rendered element sits: the repeat instances enclosing it, outermost first.
   *
   * A UI node inside a `repeat` is rendered once per member, so `NodeId` alone cannot
   * identify a rendered element. The graph still holds one semantic node; this is the
   * runtime presentation identity that goes with it, and the two are deliberately
   * distinct — `data-node` carries the first, `data-instance` the second.
   */
  const ROOT_INSTANCE: readonly string[] = [];

  /** Everything a renderer-generated id, relationship or lookup is keyed by. */
  function instanceKey(nodeId: string, path: readonly string[]): string {
    return path.length === 0 ? nodeId : `${nodeId}--${path.join('--')}`;
  }

  /** A DOM-safe fragment of an item's identity. */
  function identityFragment(value: unknown, index: number): string {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    const safe = text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    // An absent or unusable identity falls back to a deterministic iteration index.
    return safe === '' ? `i${index}` : safe;
  }

  const statesById = new Map<string, StateDef>(ir.states.map((state) => [state.id, state]));
  const entitiesById = new Map<string, EntityDef>(ir.entities.map((entity) => [entity.id, entity]));
  const parameterTypes = new Map<string, TypeRef | undefined>();
  for (const action of Object.values(ir.actions)) {
    for (const parameter of action.parameters ?? []) {
      parameterTypes.set(parameter.id, parameter.valueType);
    }
  }
  for (const route of ir.routes) {
    for (const parameter of route.parameters) {
      parameterTypes.set(parameter.id, parameter.valueType);
    }
  }

  /** Diagnostics reported while the current invocation runs, if one is collecting. */
  let collector: RuntimeDiagnostic[] | null = null;

  function report(diagnostic: RuntimeDiagnostic): void {
    diagnostics.push(diagnostic);
    collector?.push(diagnostic);
    if (diagnostic.severity === 'error') {
      host.report?.(`${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  /** Runs `body` while gathering every diagnostic it reports. */
  function collecting<T>(body: (collected: RuntimeDiagnostic[]) => T): T {
    const previous = collector;
    const collected: RuntimeDiagnostic[] = [];
    collector = collected;
    try {
      return body(collected);
    } finally {
      collector = previous;
    }
  }

  // ---------------------------------------------------------------- state store

  function storageKey(state: StateDef): string | null {
    if (state.persistence?.kind !== 'local-storage') {
      return null;
    }
    return state.persistence.key ?? `${ir.id}:${state.id}`;
  }

  function initializeStore(): void {
    for (const state of ir.states) {
      if (state.derivation) {
        continue;
      }
      const key = storageKey(state);
      if (key && host.storage) {
        const persisted = host.storage.read(key);
        if (persisted !== null) {
          try {
            store.write(state.id, JSON.parse(persisted) as unknown);
            continue;
          } catch {
            report({
              code: RUNTIME_DIAGNOSTIC_CODES.PERSISTED_STATE_UNREADABLE,
              message: `Stored value for ${state.id} could not be parsed; falling back to the initial value`,
              severity: 'warning',
              nodeId: state.id,
            });
          }
        }
      }
      store.write(
        state.id,
        state.initialValue === undefined ? defaultForType(state.valueType) : cloneValue(state.initialValue),
      );
    }
  }

  function persistState(stateId: string): void {
    const state = statesById.get(stateId);
    if (!state || !host.storage) {
      return;
    }
    const key = storageKey(state);
    if (key) {
      host.storage.write(key, JSON.stringify(store.read(stateId) ?? null));
    }
  }

  /**
   * Derived values are recomputed from their derivation and handed out as frozen copies,
   * so nothing can work by sharing an object with the state it was derived from.
   */
  function readState(stateId: string): unknown {
    const state = statesById.get(stateId);
    if (state?.derivation) {
      if (derivedCache.has(stateId)) {
        return derivedCache.get(stateId);
      }
      derivedCache.set(stateId, null);
      try {
        const value = deepFreeze(cloneValue(evaluate(state.derivation, rootScope())));
        derivedCache.set(stateId, value);
        return value;
      } catch (error) {
        report(evaluationFailure(error, { nodeId: state.id, stateId: state.id }));
        derivedCache.set(stateId, null);
        return null;
      }
    }
    return store.read(stateId);
  }

  /** The only place the store is written. Values are frozen on the way in. */
  function writeState(stateId: string, value: unknown): void {
    if (!applyingAuthoritative && ir.authority?.[stateId as NodeId] === 'server') {
      // Whatever the path — an action, an input, an administrative hydrate — a client does
      // not commit state the authority owns.
      report({
        code: RUNTIME_DIAGNOSTIC_CODES.SERVER_STATE_WRITE,
        message: `${stateId} is server-authoritative and cannot be written by this client`,
        severity: 'error',
        nodeId: stateId as NodeId,
        stateId: stateId as NodeId,
      });
      return;
    }
    if (!statesById.has(stateId)) {
      report({
        code: RUNTIME_DIAGNOSTIC_CODES.UNKNOWN_STATE,
        message: `Cannot write to unknown state ${stateId}`,
        severity: 'error',
        nodeId: stateId as NodeId,
      });
      return;
    }
    if (statesById.get(stateId)?.derivation) {
      report({
        code: RUNTIME_DIAGNOSTIC_CODES.DERIVED_STATE_WRITE,
        message: `${stateId} is derived state and cannot be written to`,
        severity: 'error',
        nodeId: stateId as NodeId,
      });
      return;
    }
    store.write(stateId, value);
    derivedCache.clear();
    persistState(stateId);
  }

  function restoreStore(snapshot: unknown): void {
    store.restore(snapshot);
    derivedCache.clear();
  }

  // ------------------------------------------------------- mutation subsystem

  const transactions = createTransactionManager(
    {
      capture: () => store.capture(),
      restore: restoreStore,
    },
    () => {
      transactionCounter += 1;
      return `tx_${transactionCounter}`;
    },
  );

  const mutations = createMutationEngine({
    runtime: {
      readState: (stateId: NodeId) => readState(stateId),
      writeState: (stateId: NodeId, value: unknown) => writeState(stateId, value),
      evaluate: (expression: Expression, scope: unknown) => evaluate(expression, scope as Scope),
    },
    recordValues: options.recordMutationValues !== false,
    onLog: (entry: MutationLogEntry) => {
      mutationLog.push(entry);
    },
  });

  /**
   * Settles a transaction and records the outcome against everything it logged. Only the
   * outermost transaction decides: a nested one shares its parent's fate.
   */
  function settle(transaction: RuntimeTransaction, outcome: 'committed' | 'rolled-back'): void {
    if (outcome === 'committed') {
      transaction.commit();
    } else {
      transaction.rollback();
    }
    if (!transaction.isRoot) {
      return;
    }
    for (const entry of mutationLog) {
      if (entry.transactionId === transaction.id && entry.outcome === undefined) {
        entry.outcome = outcome;
      }
    }
  }

  /**
   * Classifies an evaluation failure. The code says what kind of failure it was, so an
   * agent can distinguish an identifier that did not resolve from a value of the wrong
   * shape without reading the message.
   */
  function evaluationFailureCode(details: Record<string, unknown>): RuntimeDiagnosticCode {
    if (details.targetId !== undefined) {
      return RUNTIME_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE;
    }
    if (details.kind !== undefined || details.operator !== undefined || details.function !== undefined) {
      return RUNTIME_DIAGNOSTIC_CODES.UNSUPPORTED_EXPRESSION;
    }
    return RUNTIME_DIAGNOSTIC_CODES.EXPRESSION_EVALUATION_FAILED;
  }

  /** Turns an evaluation failure into a diagnostic instead of letting it escape. */
  function evaluationFailure(
    error: unknown,
    context: Partial<RuntimeDiagnostic> = {},
  ): RuntimeDiagnostic {
    if (error instanceof ExpressionEvaluationError) {
      return {
        code: evaluationFailureCode(error.details),
        message: error.message,
        severity: 'error',
        ...context,
        details: { ...error.details, ...(context.details ?? {}) },
      };
    }
    throw error;
  }

  /** Evaluates an expression, reporting rather than throwing if it cannot be evaluated. */
  function tryEvaluate(
    expression: Expression,
    scope: Scope,
    context: Partial<RuntimeDiagnostic> = {},
  ): { ok: true; value: unknown } | { ok: false; diagnostic: RuntimeDiagnostic } {
    try {
      return { ok: true, value: evaluate(expression, scope) };
    } catch (error) {
      return { ok: false, diagnostic: evaluationFailure(error, context) };
    }
  }

  /** Applies a mutation inside the current transaction and reports resolution failures. */
  function mutate(
    apply: () => MutationResult,
    context: MutationContext,
    failures: RuntimeDiagnostic[],
  ): MutationResult | null {
    try {
      return apply();
    } catch (error) {
      const failure: RuntimeDiagnostic = {
        code:
          error instanceof LocationResolutionError
            ? RUNTIME_DIAGNOSTIC_CODES.LOCATION_RESOLUTION_FAILED
            : RUNTIME_DIAGNOSTIC_CODES.MUTATION_FAILED,
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
        ...(context.sourceNodeId ? { nodeId: context.sourceNodeId } : {}),
      };
      failures.push(failure);
      return null;
    }
  }

  // ------------------------------------------------------------------- scopes

  let activeRoute: RouteMatch | null = null;

  function rootScope(): Scope {
    const values = new Map<string, unknown>();
    if (activeRoute) {
      for (const [parameterId, value] of Object.entries(activeRoute.parameters)) {
        values.set(parameterId, value);
      }
    }
    return { values };
  }

  function childScope(parent: Scope, id: string, value: unknown): Scope {
    return { values: new Map([[id, value]]), parent };
  }

  function lookup(scope: Scope | undefined, id: string): unknown | typeof MISSING {
    let current = scope;
    while (current) {
      if (current.values.has(id)) {
        return current.values.get(id);
      }
      current = current.parent;
    }
    return MISSING;
  }

  // --------------------------------------------------------------- evaluation

  function evaluate(expression: Expression, scope: Scope): unknown {
    switch (expression.kind) {
      case 'literal':
        return expression.value;
      case 'ref': {
        const scoped = lookup(scope, expression.targetId);
        if (scoped !== MISSING) {
          return scoped;
        }
        if (statesById.has(expression.targetId)) {
          return readState(expression.targetId);
        }
        throw new ExpressionEvaluationError(
          `Reference ${expression.targetId} could not be resolved`,
          { targetId: expression.targetId },
        );
      }
      case 'field': {
        const source = evaluate(expression.source, scope);
        if (!isRecord(source)) {
          return null;
        }
        const value = source[expression.fieldId];
        return value === undefined ? null : value;
      }
      case 'object': {
        const result: Record<string, unknown> = {};
        for (const entry of expression.entries) {
          result[entry.fieldId] = evaluate(entry.value, scope);
        }
        return result;
      }
      case 'binary':
        return evaluateBinary(expression.operator, expression.left, expression.right, scope);
      case 'unary': {
        const operand = evaluate(expression.operand, scope);
        return expression.operator === 'not' ? !toBoolean(operand) : -Number(operand ?? 0);
      }
      case 'call':
        return evaluateCall(expression.function, expression.arguments, scope);
      case 'filter': {
        const source = requireCollection(evaluate(expression.source, scope), 'filter');
        return source.filter((item) =>
          toBoolean(evaluate(expression.predicate, childScope(scope, expression.scopeId, item))),
        );
      }
      case 'map': {
        const source = requireCollection(evaluate(expression.source, scope), 'map');
        return source.map((item) =>
          evaluate(expression.projection, childScope(scope, expression.scopeId, item)),
        );
      }
      case 'sort': {
        const source = requireCollection(evaluate(expression.source, scope), 'sort');
        const direction = expression.direction === 'desc' ? -1 : 1;
        const key = (item: unknown): unknown =>
          evaluate(expression.by, childScope(scope, expression.scopeId, item));
        return [...source].sort((left, right) => direction * compareValues(key(left), key(right)));
      }
      case 'every': {
        const source = requireCollection(evaluate(expression.source, scope), 'every');
        return source.every((item) =>
          toBoolean(evaluate(expression.predicate, childScope(scope, expression.scopeId, item))),
        );
      }
      case 'some': {
        const source = requireCollection(evaluate(expression.source, scope), 'some');
        return source.some((item) =>
          toBoolean(evaluate(expression.predicate, childScope(scope, expression.scopeId, item))),
        );
      }
      case 'flatten': {
        const source = requireCollection(evaluate(expression.source, scope), 'flatten');
        return source.flatMap((member) => requireCollection(member, 'flatten'));
      }
      case 'conditional':
        return toBoolean(evaluate(expression.condition, scope))
          ? evaluate(expression.whenTrue, scope)
          : evaluate(expression.whenFalse, scope);
      case 'find': {
        const source = requireCollection(evaluate(expression.source, scope), 'find');
        const found = source.find((item) =>
          toBoolean(evaluate(expression.predicate, childScope(scope, expression.scopeId, item))),
        );
        return found === undefined ? null : found;
      }
      default:
        throw new ExpressionEvaluationError(
          `Unknown expression kind "${(expression as { kind: string }).kind}"`,
          { kind: (expression as { kind: string }).kind },
        );
    }
  }

  function evaluateBinary(
    operator: string,
    leftExpression: Expression,
    rightExpression: Expression,
    scope: Scope,
  ): unknown {
    if (operator === 'and') {
      return toBoolean(evaluate(leftExpression, scope)) && toBoolean(evaluate(rightExpression, scope));
    }
    if (operator === 'or') {
      return toBoolean(evaluate(leftExpression, scope)) || toBoolean(evaluate(rightExpression, scope));
    }
    const left = evaluate(leftExpression, scope);
    const right = evaluate(rightExpression, scope);
    /**
     * A number that is not finite has no place in an ordering. Every ordered comparison
     * against one is false, so a guard fails closed rather than passing on a value that
     * could not be computed — or one a hostile caller supplied.
     */
    const unordered =
      (typeof left === 'number' && !Number.isFinite(left)) ||
      (typeof right === 'number' && !Number.isFinite(right));
    switch (operator) {
      case 'eq':
        return valuesEqual(left, right);
      case 'neq':
        return !valuesEqual(left, right);
      case 'gt':
        return !unordered && compareValues(left, right) > 0;
      case 'gte':
        return !unordered && compareValues(left, right) >= 0;
      case 'lt':
        return !unordered && compareValues(left, right) < 0;
      case 'lte':
        return !unordered && compareValues(left, right) <= 0;
      case 'add':
        return Number(left ?? 0) + Number(right ?? 0);
      case 'subtract':
        return Number(left ?? 0) - Number(right ?? 0);
      case 'multiply':
        return Number(left ?? 0) * Number(right ?? 0);
      case 'divide': {
        const divisor = Number(right ?? 0);
        return divisor === 0 ? null : Number(left ?? 0) / divisor;
      }
      default:
        throw new ExpressionEvaluationError(`Unknown operator "${operator}"`, { operator });
    }
  }

  function evaluateCall(fn: string, args: Expression[], scope: Scope): unknown {
    const values = args.map((argument) => evaluate(argument, scope));
    switch (fn) {
      case 'required':
        // Presence only: an empty collection or string exists, and so does 0 and false.
        return isPresent(values[0]);
      case 'is-empty':
        return isEmptyValue(values[0]);
      case 'non-empty':
        return !isEmptyValue(values[0]);
      case 'length':
        return Array.isArray(values[0]) ? values[0].length : toText(values[0]).length;
      case 'count':
        return requireCollection(values[0], 'count').length;
      case 'sum': {
        // An aggregation that cannot be computed fails; it never returns a number that
        // would quietly satisfy a guard.
        const source = requireCollection(values[0], 'sum');
        let total = 0;
        for (const member of source) {
          if (typeof member !== 'number' || !Number.isFinite(member)) {
            throw new ExpressionEvaluationError(
              `sum encountered ${describeValue(member)} where a number was required`,
              { member },
            );
          }
          total += member;
        }
        return total;
      }
      case 'contains': {
        const [haystack, needle] = values;
        if (Array.isArray(haystack)) {
          return haystack.some((item) => valuesEqual(item, needle));
        }
        return toText(haystack).toLowerCase().includes(toText(needle).toLowerCase());
      }
      case 'concat':
        return values.map(toText).join('');
      case 'coalesce':
        // Nullish, not "non-empty": falling back to an empty collection has to be possible.
        return values.find((value) => isPresent(value)) ?? null;
      case 'one-of':
        return values.slice(1).some((option) => valuesEqual(option, values[0]));
      case 'lowercase':
        return toText(values[0]).toLowerCase();
      case 'to-string':
        return toText(values[0]);
      case 'now':
        return host.now();
      case 'uuid':
        return host.uuid();
      default:
        throw new ExpressionEvaluationError(`Unknown function "${fn}"`, { function: fn });
    }
  }

  // -------------------------------------------------------------- validation

  function collectionEntityId(state: StateDef): string | null {
    const resolved = unwrapType(state.valueType);
    if (resolved.kind === 'collection') {
      const item = unwrapType(resolved.itemType);
      return item.kind === 'entity' ? item.entityId : null;
    }
    return resolved.kind === 'entity' ? resolved.entityId : null;
  }

  /**
   * Every canonical occurrence of every entity, found by walking state values against
   * their declared types. Entities nested inside collections and inside other entities
   * are reached recursively, so their constraints apply wherever they actually live.
   */
  function collectInstances(read: (stateId: string) => unknown = readState): Map<string, unknown[]> {
    const found = new Map<string, unknown[]>();

    const visit = (value: unknown, type: TypeRef): void => {
      const resolved = unwrapType(type);
      if (resolved.kind === 'collection') {
        if (Array.isArray(value)) {
          for (const item of value) {
            visit(item, resolved.itemType);
          }
        }
        return;
      }
      if (resolved.kind !== 'entity' || !isRecord(value)) {
        return;
      }
      const instances = found.get(resolved.entityId) ?? [];
      instances.push(value);
      found.set(resolved.entityId, instances);
      for (const field of entitiesById.get(resolved.entityId)?.fields ?? []) {
        visit(value[field.id], field.valueType);
      }
    };

    for (const state of ir.states) {
      // Drafts are incomplete by definition, ephemeral state is not a domain fact at all,
      // and derived states are views of data already validated where it is stored.
      if (state.draft || state.ephemeral || state.derivation) {
        continue;
      }
      visit(read(state.id), state.valueType);
    }
    return found;
  }

  /**
   * Transition rules, evaluated against the state the transaction started from and the
   * state it now proposes. Every governed mutation path runs this before committing, so a
   * rule holds regardless of which path attempted the write.
   */
  function evaluateTransitions(): RuntimeDiagnostic[] {
    const snapshot = transactions.entrySnapshot() as Map<string, unknown> | undefined;
    if (!snapshot || ir.transitionConstraints.length === 0) {
      return [];
    }

    const previousInstances = collectInstances((stateId) => snapshot.get(stateId));
    const proposedInstances = collectInstances();
    const failures: RuntimeDiagnostic[] = [];

    for (const rule of ir.transitionConstraints) {
      const entity = entitiesById.get(rule.entityId);
      const identity = entity?.identityFieldId;
      if (!identity) {
        continue;
      }

      const identify = (instance: unknown): unknown => (isRecord(instance) ? instance[identity] : undefined);
      const proposedByIdentity = new Map<string, unknown>();
      for (const instance of proposedInstances.get(rule.entityId) ?? []) {
        proposedByIdentity.set(toText(identify(instance)), instance);
      }

      for (const previous of previousInstances.get(rule.entityId) ?? []) {
        const key = toText(identify(previous));
        // A removed instance is a transition too: its proposed form is nothing.
        const proposed = proposedByIdentity.get(key) ?? null;
        if (proposed !== null && valuesEqual(previous, proposed)) {
          continue;
        }

        const scope = childScope(
          childScope(rootScope(), rule.previousScopeId, previous),
          rule.proposedScopeId,
          proposed,
        );
        const outcome = tryEvaluate(rule.expression, scope, {
          nodeId: rule.id,
          constraintId: rule.id,
        });
        if (outcome.ok && toBoolean(outcome.value)) {
          continue;
        }

        failures.push(
          outcome.ok
            ? {
                code: RUNTIME_DIAGNOSTIC_CODES.TRANSITION_CONSTRAINT_VIOLATION,
                message: rule.message ?? `Transition ${rule.name ?? rule.id} is not allowed`,
                severity: rule.severity ?? 'error',
                nodeId: rule.id,
                constraintId: rule.id,
                details: {
                  transitionConstraintId: rule.id,
                  entityId: rule.entityId,
                  identity: identify(previous),
                  previousValue: previous,
                  proposedValue: proposed,
                },
              }
            : outcome.diagnostic,
        );
      }
    }

    return failures;
  }

  function instancesOf(entityId: string): unknown[] {
    return collectInstances().get(entityId) ?? [];
  }

  function checkFieldValue(field: FieldDef, value: unknown, entityId: string): RuntimeDiagnostic | null {
    if (!isPresent(value)) {
      if (field.required) {
        return {
          code: RUNTIME_DIAGNOSTIC_CODES.REQUIRED_FIELD_MISSING,
          message: `${field.name ?? field.id} is required`,
          severity: 'error',
          nodeId: entityId as NodeId,
          fieldId: field.id,
        };
      }
      return null;
    }
    const resolved = unwrapType(field.valueType);
    if (resolved.kind === 'enum' && !resolved.values.includes(toText(value))) {
      return {
        code: RUNTIME_DIAGNOSTIC_CODES.ENUM_VALUE_INVALID,
        message: `${field.name ?? field.id} must be one of: ${resolved.values.join(', ')}`,
        severity: 'error',
        nodeId: entityId as NodeId,
        fieldId: field.id,
      };
    }
    if (resolved.kind === 'primitive' && resolved.primitive === 'number' && typeof value !== 'number') {
      return {
        code: RUNTIME_DIAGNOSTIC_CODES.TYPE_MISMATCH,
        message: `${field.name ?? field.id} must be a number`,
        severity: 'error',
        nodeId: entityId as NodeId,
        fieldId: field.id,
      };
    }
    if (resolved.kind === 'primitive' && resolved.primitive === 'boolean' && typeof value !== 'boolean') {
      return {
        code: RUNTIME_DIAGNOSTIC_CODES.TYPE_MISMATCH,
        message: `${field.name ?? field.id} must be a boolean`,
        severity: 'error',
        nodeId: entityId as NodeId,
        fieldId: field.id,
      };
    }
    return null;
  }

  /**
   * Schema conformance plus declared constraints, evaluated over every canonical instance
   * — including instances nested inside collections and inside other entities.
   */
  function evaluateInvariants(): RuntimeDiagnostic[] {
    const failures: RuntimeDiagnostic[] = [];
    const instances = collectInstances();

    for (const entity of ir.entities) {
      for (const instance of instances.get(entity.id) ?? []) {
        if (!isRecord(instance)) {
          continue;
        }
        for (const field of entity.fields) {
          const failure = checkFieldValue(field, instance[field.id], entity.id);
          if (failure) {
            failures.push(failure);
          }
        }
      }
    }
    for (const constraint of ir.constraints) {
      failures.push(...evaluateConstraint(constraint, instances));
    }
    return failures;
  }

  /** Invariant failures that must never be left standing in canonical state. */
  function hardViolations(): RuntimeDiagnostic[] {
    return evaluateInvariants().filter((diagnostic) => diagnostic.severity === 'error');
  }

  function violationKey(diagnostic: RuntimeDiagnostic): string {
    return [
      diagnostic.code,
      diagnostic.nodeId ?? '',
      diagnostic.fieldId ?? '',
      diagnostic.message,
    ].join('|');
  }

  function countViolations(violations: RuntimeDiagnostic[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const violation of violations) {
      const key = violationKey(violation);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Violations that were not already present. A change is only held responsible for what
   * it broke, so data that was already invalid does not make the rest of the UI unusable.
   */
  function violationsIntroducedSince(before: Map<string, number>): RuntimeDiagnostic[] {
    const remaining = new Map(before);
    const introduced: RuntimeDiagnostic[] = [];
    for (const violation of hardViolations()) {
      const key = violationKey(violation);
      const outstanding = remaining.get(key) ?? 0;
      if (outstanding > 0) {
        remaining.set(key, outstanding - 1);
        continue;
      }
      introduced.push(violation);
    }
    return introduced;
  }

  /**
   * An entity-scoped constraint is evaluated once per instance, with `ref(entityId)`
   * bound to the instance under validation.
   */
  function evaluateConstraint(
    constraint: ConstraintDef,
    instances: Map<string, unknown[]>,
  ): RuntimeDiagnostic[] {
    const severity = constraint.severity ?? 'error';
    const failures: RuntimeDiagnostic[] = [];
    const record = (instance?: unknown): void => {
      failures.push({
        code: RUNTIME_DIAGNOSTIC_CODES.CONSTRAINT_VIOLATION,
        message: constraint.message ?? `Constraint ${constraint.name ?? constraint.id} failed`,
        severity,
        nodeId: constraint.id,
        constraintId: constraint.id,
        ...(constraint.entityId ? { details: { entityId: constraint.entityId, instance } } : {}),
      });
    };

    /** A constraint that cannot be evaluated counts as violated, never as satisfied. */
    const holds = (scope: Scope): boolean => {
      const outcome = tryEvaluate(constraint.expression, scope, {
        nodeId: constraint.id,
        constraintId: constraint.id,
      });
      if (!outcome.ok) {
        failures.push(outcome.diagnostic);
        return false;
      }
      return toBoolean(outcome.value);
    };

    if (!constraint.entityId) {
      if (!holds(rootScope())) {
        record();
      }
      return failures;
    }
    for (const instance of instances.get(constraint.entityId) ?? []) {
      if (!holds(childScope(rootScope(), constraint.entityId, instance))) {
        record(instance);
      }
    }
    return failures;
  }

  // --------------------------------------------------------------- behaviour

  function executeOperation(
    operation: Operation,
    scope: Scope,
    context: MutationContext,
    result: RuntimeDiagnostic[],
  ): void {
    try {
      executeOperationUnguarded(operation, scope, context, result);
    } catch (error) {
      result.push(
        evaluationFailure(error, {
          ...(context.sourceNodeId ? { nodeId: context.sourceNodeId, actionId: context.sourceNodeId } : {}),
          ...(context.transactionId ? { transactionId: context.transactionId } : {}),
        }),
      );
    }
  }

  function executeOperationUnguarded(
    operation: Operation,
    scope: Scope,
    context: MutationContext,
    result: RuntimeDiagnostic[],
  ): void {
    switch (operation.kind) {
      case 'set':
      case 'insert':
      case 'remove':
        mutate(() => mutations.apply(operation, scope, context), context, result);
        return;
      case 'for-each': {
        // The members are read once, before any of them are mutated, so the iteration
        // walks the collection as it stood when the operation began. Nothing here opens
        // a transaction: these mutations belong to the action's own transaction, and a
        // failure in any iteration rolls back every iteration with it.
        const members = requireCollection(evaluate(operation.collection, scope), 'for-each');
        for (const member of members) {
          const iteration = childScope(scope, operation.scopeId, member);
          for (const nested of operation.operations ?? []) {
            executeOperation(nested, iteration, context, result);
          }
        }
        return;
      }
      case 'invoke': {
        const args: Record<string, unknown> = {};
        for (const [parameterId, argument] of Object.entries(operation.arguments ?? {})) {
          args[parameterId] = evaluate(argument, scope);
        }
        const nested = runAction(operation.actionId, args);
        result.push(...nested.diagnostics);
        return;
      }
      case 'navigate': {
        if (operation.path) {
          navigate(operation.path);
          return;
        }
        const route = ir.routes.find((candidate) => candidate.id === operation.routeId);
        if (!route) {
          result.push({
            code: RUNTIME_DIAGNOSTIC_CODES.ROUTE_NOT_FOUND,
            message: `Navigate operation could not resolve route ${String(operation.routeId)}`,
            severity: 'error',
          });
          return;
        }
        const values: Record<string, string> = {};
        for (const [parameterId, argument] of Object.entries(operation.parameters ?? {})) {
          values[parameterId] = toText(evaluate(argument, scope));
        }
        navigate(buildPath(route, values));
        return;
      }
      case 'native': {
        const implementation = natives.get(operation.implementationId);
        if (!implementation) {
          result.push({
            code: RUNTIME_DIAGNOSTIC_CODES.NATIVE_OPERATION_MISSING,
            message: `No implementation registered for "${operation.implementationId}"`,
            severity: 'error',
          });
          return;
        }
        const inputs: Record<string, unknown> = {};
        for (const [key, argument] of Object.entries(operation.inputs ?? {})) {
          // Native code receives copies: it can never reach into managed state.
          inputs[key] = cloneValue(evaluate(argument, scope));
        }
        const returned = implementation(inputs);
        if (operation.resultTarget) {
          const target = operation.resultTarget;
          mutate(
            () => mutations.set(target, cloneValue(returned), scope, { ...context, source: 'native' }),
            context,
            result,
          );
        }
        return;
      }
      default:
        result.push({
          code: RUNTIME_DIAGNOSTIC_CODES.UNSUPPORTED_OPERATION,
          message: `Unknown operation kind "${(operation as { kind: string }).kind}"`,
          severity: 'error',
        });
    }
  }

  /**
   * Applies an authoritative answer. The only path permitted to write server-owned state —
   * and it still goes through `writeState`, so the store keeps exactly one writer.
   */
  function applyAuthoritative(changes: Record<string, unknown>): void {
    applyingAuthoritative = true;
    try {
      for (const [stateId, value] of Object.entries(changes)) {
        if (statesById.has(stateId)) {
          writeState(stateId, cloneValue(value));
        }
      }
    } finally {
      applyingAuthoritative = false;
    }
  }

  /**
   * Dispatches a semantic action to the authority.
   *
   * The client sends an action id and typed arguments — never operations. The answer is
   * applied when it arrives, and recorded through the same outcome lifecycle a local
   * refusal uses, so a `diagnostic` node presents a server refusal exactly as it presents
   * a local one.
   */
  function runRemoteAction(action: ActionDef, args: Record<string, unknown>): ActionResult {
    if (!remote) {
      const failure: RuntimeDiagnostic = {
        code: RUNTIME_DIAGNOSTIC_CODES.REMOTE_ACTION_UNAVAILABLE,
        message: `${action.name ?? action.id} executes on the authority, but no gateway to it is configured`,
        severity: 'error',
        nodeId: action.id,
        actionId: action.id,
      };
      report(failure);
      recordOutcome(action.id, 'failed', [failure]);
      renderApplication();
      return { ok: false, diagnostics: [failure] };
    }
    if (action.requiresConfirmation && !askForConfirmation(action)) {
      // Confirmation is interaction, and it happens here. The authority never treats it as
      // an authorization mechanism.
      recordOutcome(action.id, 'cancelled', []);
      renderApplication();
      return { ok: false, diagnostics: [] };
    }

    remoteRequests += 1;
    // A stable key, so a retry after a lost answer cannot execute the action twice — and one
    // carrying this runtime's own session identity, so two clients never claim the same key.
    const requestId = `${ir.id}:${sessionId}:${action.id}:${remoteRequests}:${host.uuid()}`;
    recordOutcome(action.id, 'pending', []);
    renderApplication();

    const settle = remote
      .invoke({ actionId: action.id, arguments: args, requestId })
      .then((answer) => {
        applyAuthoritative(answer.changes ?? {});
        // A diagnostic from an authority is untrusted input: its `code` is a string until it
        // matches something we know. It is carried through unchanged, because a client that
        // rewrote a refusal would be inventing one.
        const reported = answer.diagnostics as RuntimeDiagnostic[];
        reported.forEach(report);
        recordOutcome(action.id, answer.ok ? 'ok' : 'failed', answer.ok ? [] : reported);
        renderApplication();
        return { ok: answer.ok, diagnostics: reported };
      })
      .catch((error: unknown) => {
        // A transport failure becomes a structured diagnostic, not an escaping exception.
        const failure: RuntimeDiagnostic = {
          code: RUNTIME_DIAGNOSTIC_CODES.REMOTE_ACTION_UNAVAILABLE,
          message: error instanceof Error ? error.message : String(error),
          severity: 'error',
          nodeId: action.id,
          actionId: action.id,
        };
        report(failure);
        recordOutcome(action.id, 'failed', [failure]);
        renderApplication();
        return { ok: false, diagnostics: [failure] };
      });
    pending.set(action.id, settle);
    void settle.finally(() => {
      if (pending.get(action.id) === settle) {
        pending.delete(action.id);
      }
    });
    return { ok: false, pending: true, diagnostics: [] };
  }

  /** In-flight remote invocations, so `invokeActionAsync` can await one. */
  const pending = new Map<string, Promise<ActionResult>>();

  /**
   * Waits until nothing is outstanding with an authority.
   *
   * A remote action started from the interface — a click, a form submit — returns to the
   * event handler immediately, so there is no promise for the caller to hold. Without this,
   * anything driving the UI has to guess a delay. It loops because settling one invocation
   * may start another.
   */
  async function allSettled(): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled([...pending.values()]);
    }
  }

  /**
   * Loads authoritative state and applies it.
   *
   * A failure is a diagnostic, not an exception, and leaves `authoritativeLoaded` false —
   * so an application can tell "the authority has not answered" from "the collection is
   * empty", which are very different things to show a person.
   */
  async function syncAuthoritative(): Promise<void> {
    if (!remote?.snapshot) {
      return;
    }
    try {
      const snapshot = await remote.snapshot();
      applyAuthoritative(snapshot.states ?? {});
      authoritativeLoaded = true;
    } catch (error) {
      authoritativeLoaded = false;
      report({
        code: RUNTIME_DIAGNOSTIC_CODES.AUTHORITY_UNREACHABLE,
        message: `Authoritative state could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      });
    }
    renderApplication();
  }

  function runAction(actionId: string, args: Record<string, unknown> = {}): ActionResult {
    const remoteAction = remoteActionIds.has(actionId) ? ir.actions[actionId as NodeId] : undefined;
    if (remoteAction) {
      return runRemoteAction(remoteAction, args);
    }
    return collecting((collected) => {
      const started = collected.length;
      const result = runActionCollecting(actionId, args, collected);
      if (ir.actions[actionId as NodeId]) {
        // The record is this invocation's own diagnostics, so a later invocation of another
        // action can never appear to belong to this one.
        recordOutcome(
          actionId,
          result.ok ? 'ok' : cancelled ? 'cancelled' : 'failed',
          result.ok ? [] : collected.slice(started),
        );
      }
      cancelled = false;
      // Any invocation can change what a diagnostic region presents, including one refused
      // before a transaction was ever opened. Render once, at the outermost invocation.
      if (transactions.currentId() === undefined) {
        renderApplication();
      }
      return result;
    });
  }

  /** Set when the most recent invocation stopped because a confirmation was declined. */
  let cancelled = false;

  function runActionCollecting(
    actionId: string,
    args: Record<string, unknown>,
    collected: RuntimeDiagnostic[],
  ): ActionResult {
    const action: ActionDef | undefined = ir.actions[actionId as NodeId];
    if (!action) {
      const failure: RuntimeDiagnostic = {
        code: RUNTIME_DIAGNOSTIC_CODES.ACTION_NOT_FOUND,
        message: `Action ${actionId} is not defined`,
        severity: 'error',
      };
      report(failure);
      return { ok: false, diagnostics: [...collected] };
    }

    const scope = rootScope();
    for (const parameter of action.parameters ?? []) {
      scope.values.set(parameter.id, args[parameter.id] ?? null);
    }

    const failures: RuntimeDiagnostic[] = [];
    for (const parameter of action.parameters ?? []) {
      if (parameter.required && !isPresent(scope.values.get(parameter.id))) {
        failures.push({
          code: RUNTIME_DIAGNOSTIC_CODES.PARAMETER_MISSING,
          message: `Action ${action.name ?? action.id} requires ${parameter.name ?? parameter.id}`,
          severity: 'error',
          nodeId: action.id,
        });
      }
    }
    if (failures.length > 0) {
      failures.forEach(report);
      return { ok: false, diagnostics: [...collected] };
    }

    // Failure modes line up with preconditions by position, so a refusal says which
    // condition was not met rather than always naming the first one.
    for (const [index, precondition] of (action.preconditions ?? []).entries()) {
      const outcome = tryEvaluate(precondition, scope, { nodeId: action.id, actionId: action.id });
      if (!outcome.ok) {
        report(outcome.diagnostic);
        return { ok: false, diagnostics: [...collected] };
      }
      if (toBoolean(outcome.value)) {
        continue;
      }
      const mode = action.failureModes?.[index];
      report({
        code: RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED,
        message: mode?.message ?? `A precondition of ${action.name ?? action.id} was not satisfied`,
        severity: 'error',
        nodeId: action.id,
        actionId: action.id,
        details: { preconditionIndex: index, ...(mode?.code ? { failureMode: mode.code } : {}) },
      });
      return { ok: false, diagnostics: [...collected] };
    }

    if (action.requiresConfirmation) {
      if (!askForConfirmation(action)) {
        // Declining a confirmation is not a refusal: it reports nothing.
        cancelled = true;
        return { ok: false, diagnostics: [...collected] };
      }
    }

    const transaction = transactions.begin();
    const context: MutationContext = {
      source: 'action',
      sourceNodeId: action.id,
      transactionId: transaction.id,
    };
    const operationDiagnostics: RuntimeDiagnostic[] = [];
    const reportedBefore = collected.length;
    for (const operation of action.operations ?? []) {
      executeOperation(operation, scope, context, operationDiagnostics);
    }

    // Anything reported while the operations ran — an expression that could not be
    // evaluated, for instance — is a failure of this action, not a passing curiosity.
    const violations = [
      ...operationDiagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
      ...collected.slice(reportedBefore).filter((diagnostic) => diagnostic.severity === 'error'),
      ...evaluateInvariants().filter((diagnostic) => diagnostic.severity === 'error'),
      ...evaluateTransitions().filter((diagnostic) => diagnostic.severity === 'error'),
    ];
    for (const postcondition of action.postconditions ?? []) {
      const outcome = tryEvaluate(postcondition, scope, { nodeId: action.id, actionId: action.id });
      if (!outcome.ok || !toBoolean(outcome.value)) {
        if (!outcome.ok) {
          violations.push(outcome.diagnostic);
        }
        violations.push({
          code: RUNTIME_DIAGNOSTIC_CODES.POSTCONDITION_FAILED,
          message: `A postcondition of ${action.name ?? action.id} was not satisfied`,
          severity: 'error',
          nodeId: action.id,
          actionId: action.id,
        });
      }
    }

    if (violations.length > 0) {
      settle(transaction, 'rolled-back');
      for (const violation of violations) {
        if (!collected.includes(violation)) {
          report({ ...violation, actionId: action.id, transactionId: transaction.id });
        }
      }
      return { ok: false, diagnostics: [...collected] };
    }

    settle(transaction, 'committed');
    return { ok: true, diagnostics: [...collected] };
  }

  // ------------------------------------------------------------------ routing

  function buildPath(route: CompiledRoute, values: Record<string, string>): string {
    const segments = route.segments.map((segment) => {
      if (segment.kind === 'static') {
        return segment.value;
      }
      const parameterId = segment.parameterId ?? '';
      const value = values[parameterId] ?? '';
      return encodeURIComponent(value);
    });
    return `/${segments.join('/')}`.replace(/\/+/g, '/');
  }

  function matchRoute(pathname: string): RouteMatch | null {
    const parts = pathname.split('?')[0].split('/').filter(Boolean);
    for (const route of ir.routes) {
      if (route.segments.length !== parts.length) {
        continue;
      }
      const parameters: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index];
        const part = parts[index];
        if (segment.kind === 'static') {
          if (segment.value !== part) {
            matched = false;
            break;
          }
          continue;
        }
        if (segment.parameterId) {
          parameters[segment.parameterId] = decodeURIComponent(part);
        }
      }
      if (matched) {
        return { route, parameters };
      }
    }
    return null;
  }

  function navigate(path: string): void {
    host.pushPath(path);
    syncRoute();
  }

  function syncRoute(): void {
    const previous = activeRoute?.route.id;
    activeRoute = matchRoute(host.getPath());
    if (previous !== undefined && previous !== activeRoute?.route.id) {
      // Diagnostics are about the screen that produced them.
      actionOutcomes.clear();
      inputErrors.clear();
    }
    derivedCache.clear();
    renderApplication();
  }

  // ----------------------------------------------------------------- renderer

  function element(tagName: string, className?: string): DomElement {
    const created = host.document.createElement(tagName);
    if (className) {
      created.setAttribute('class', className);
    }
    return created;
  }

  /** The semantic classes a node's resolved presentation implies. No styles, no colours. */
  function nodeClasses(node: UINode, ...base: string[]): string {
    return presentationClasses(presentationOf(node.id), ...base);
  }

  /** A semantic icon, drawn with the glyph the theme supplies for it. */
  function appendIcon(parent: DomElement, resolved: ResolvedPresentation | undefined): boolean {
    const name = resolved?.icon;
    if (!name) {
      return false;
    }
    const icon = element('span', 'axiom-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('data-icon', name);
    icon.textContent = theme?.icons?.[name] ?? '';
    parent.appendChild(icon);
    return true;
  }

  /**
   * Asks for confirmation. The graph describes what is asked; the host decides how to ask.
   * A host that can only manage a plain question still gets a sentence to show.
   */
  function askForConfirmation(action: ActionDef): boolean {
    const declared = action.confirmation;
    const fallback = `Confirm ${action.name ?? action.id}. This cannot be undone.`;
    const composed = declared
      ? [declared.title, declared.description].filter(Boolean).join(' — ')
      : '';
    const message = action.confirmationMessage ?? (composed || fallback);
    if (!host.confirmRequest) {
      return host.confirm(message);
    }
    const request: ConfirmationRequest = {
      actionId: action.id,
      title: declared?.title ?? action.name ?? action.id,
      confirmLabel: declared?.confirmLabel ?? 'Confirm',
      cancelLabel: declared?.cancelLabel ?? 'Cancel',
      severity: declared?.severity ?? (action.destructive ? 'destructive' : 'informational'),
      message,
      ...(declared?.description ?? action.confirmationMessage
        ? { description: declared?.description ?? action.confirmationMessage }
        : {}),
    };
    return host.confirmRequest(request);
  }

  /**
   * The diagnostics a region presents: those of its action's most recent invocation, at or
   * above the region's own severity.
   */
  function presentedDiagnostics(node: UINode & { kind: 'diagnostic' }): RuntimeDiagnostic[] {
    const record = actionOutcomes.get(node.actionId);
    if (!record) {
      return [];
    }
    const minimum = node.severity ?? 'error';
    return record.diagnostics.filter(
      (diagnostic) => minimum === 'warning' || diagnostic.severity === 'error',
    );
  }

  /** Whether any region currently reports something about this action. */
  function reportingRegionFor(actionId: string, path: readonly string[]): string | null {
    if (path.length > 0) {
      // A region reports one action, not one row; relating a repeated control to it would
      // be guesswork. Rows report through their own input diagnostics instead.
      return null;
    }
    for (const regionId of diagnosticRegions.get(actionId) ?? []) {
      const region = ir.uiNodes[regionId];
      if (region?.kind === 'diagnostic' && presentedDiagnostics(region).length > 0) {
        return `axiom-diagnostic-${regionId}`;
      }
    }
    return null;
  }

  function renderChildren(
    ids: NodeId[],
    scope: Scope,
    parent: DomElement,
    path: readonly string[],
  ): void {
    for (const id of ids) {
      const child = renderNode(id, scope, path);
      if (child) {
        parent.appendChild(child);
      }
    }
  }

  function fieldOf(id: FieldId): FieldDef | undefined {
    return ir.fields[id]?.field;
  }

  /** Reads through a location without giving the renderer a way to write. */
  function readLocation(location: Location, scope: Scope): unknown {
    try {
      return resolveLocation(location, scope, {
        readState,
        writeState,
        evaluate: (expression: Expression, inner: unknown) => evaluate(expression, inner as Scope),
      }).read();
    } catch {
      return null;
    }
  }

  interface ControlDescriptor {
    /** A tag name, or `radio-group` for the one control made of several elements. */
    tag: string;
    type?: string;
    options?: string[];
    variant?: string;
  }

  /**
   * Which control edits this value. Semantic intent wins, then the older HTML-shaped
   * hint, then the type of the location the input is bound to.
   */
  function resolveInputTag(node: UINode & { kind: 'input' }): ControlDescriptor {
    const located = ir.locationTypes[node.id];
    const resolved = located ? unwrapType(located) : null;
    const enumValues = resolved?.kind === 'enum' ? resolved.values : [];
    const hint = node.inputHint;

    switch (presentationOf(node.id)?.control) {
      case 'multiline':
        return { tag: 'textarea', variant: 'multiline' };
      case 'select':
        return { tag: 'select', options: enumValues, variant: 'select' };
      case 'radio-group':
        return { tag: 'radio-group', options: enumValues, variant: 'radio-group' };
      case 'switch':
        return { tag: 'input', type: 'checkbox', variant: 'switch' };
      case 'checkbox':
        return { tag: 'input', type: 'checkbox', variant: 'checkbox' };
      case 'stepper':
        return { tag: 'input', type: 'number', variant: 'stepper' };
      default:
        break;
    }

    if (hint === 'multiline') {
      return { tag: 'textarea' };
    }
    if (node.options) {
      return { tag: 'select' };
    }
    if (hint === 'select' || (!hint && resolved?.kind === 'enum')) {
      return { tag: 'select', options: enumValues };
    }
    if (hint === 'checkbox' || (!hint && resolved?.kind === 'primitive' && resolved.primitive === 'boolean')) {
      return { tag: 'input', type: 'checkbox' };
    }
    if (hint) {
      return { tag: 'input', type: hint };
    }
    if (resolved?.kind === 'primitive') {
      switch (resolved.primitive) {
        case 'number':
          return { tag: 'input', type: 'number' };
        case 'date':
        case 'datetime':
          return { tag: 'input', type: 'date' };
        default:
          return { tag: 'input', type: 'text' };
      }
    }
    return { tag: 'input', type: 'text' };
  }

  /** Choices for a select: either enum values or records drawn from application data. */
  function optionChoices(
    node: UINode & { kind: 'input' },
    scope: Scope,
    enumValues: string[],
  ): Array<{ value: string; label: string }> {
    const source = node.options;
    if (!source) {
      return enumValues.map((value) => ({ value, label: value }));
    }
    const candidates = evaluate(source.source, scope);
    if (!Array.isArray(candidates)) {
      return [];
    }
    return candidates.filter(isRecord).map((candidate) => {
      const value = toText(candidate[source.valueFieldId]);
      const label = source.labelFieldId ? toText(candidate[source.labelFieldId]) : value;
      return { value, label: label || value };
    });
  }

  function coerceInputValue(inputId: NodeId, raw: string, checked: boolean | undefined): unknown {
    const located = ir.locationTypes[inputId];
    const optional = located?.kind === 'optional';
    const resolved = located ? unwrapType(located) : null;
    if (resolved?.kind === 'primitive' && resolved.primitive === 'boolean') {
      return Boolean(checked);
    }
    if (resolved?.kind === 'primitive' && resolved.primitive === 'number') {
      if (raw.trim() === '') {
        return optional ? null : 0;
      }
      const parsed = Number(raw);
      return Number.isNaN(parsed) ? raw : parsed;
    }
    return raw;
  }

  function renderNode(id: NodeId, scope: Scope, path: readonly string[]): DomElement | null {
    try {
      return renderNodeUnguarded(id, scope, path);
    } catch (error) {
      report(evaluationFailure(error, { nodeId: id }));
      return null;
    }
  }

  function renderNodeUnguarded(id: NodeId, scope: Scope, path: readonly string[]): DomElement | null {
    const node = ir.uiNodes[id];
    if (!node) {
      report({
        code: RUNTIME_DIAGNOSTIC_CODES.UI_NODE_MISSING,
        message: `UI node ${id} is not defined`,
        severity: 'error',
        nodeId: id,
      });
      return null;
    }
    if (node.visibleWhen && !toBoolean(evaluate(node.visibleWhen, scope))) {
      return null;
    }

    const presentation = presentationOf(node.id);
    const instance = instanceKey(node.id, path);
    /** `data-node` is the semantic node; `data-instance` is this rendering of it. */
    const identify = (target: DomElement): DomElement => {
      target.setAttribute('data-node', node.id);
      if (path.length > 0) {
        target.setAttribute('data-instance', instance);
      }
      return target;
    };
    /**
     * `data-control` names the one element a person actually operates.
     *
     * A single semantic node can render as more than one element — an input is a label
     * wrapping a control, and both carry `data-node`, because both are that node. Anything
     * that wants to type into it, click it or read its value needs the inner one, and
     * `data-node` cannot say which that is. This can.
     */
    const asControl = (target: DomElement): DomElement => {
      target.setAttribute('data-control', node.id);
      return target;
    };

    switch (node.kind) {
      case 'view': {
        const container = identify(element('div', nodeClasses(node, 'axiom-view')));
        renderChildren(node.children, scope, container, path);
        return container;
      }
      case 'container': {
        // A UX role that names a region of the page becomes the element that means it, so
        // the landmark structure an author declared is the one assistive technology sees.
        const container = identify(
          element(landmarkTag(presentation?.uxRole) ?? 'div', nodeClasses(node, 'axiom-container')),
        );
        const ariaRole = ariaRoleFor(presentation?.uxRole);
        if (ariaRole) {
          container.setAttribute('role', ariaRole);
        }
        if (presentation?.accessibleLabel) {
          container.setAttribute('aria-label', presentation.accessibleLabel);
        }
        appendIcon(container, presentation);
        renderChildren(node.children, scope, container, path);
        return container;
      }
      case 'text': {
        const text = identify(
          element(headingTag(presentation) ?? 'span', nodeClasses(node, 'axiom-text')),
        );
        // A status role announces itself whatever kind of node carries it.
        const textRole = ariaRoleFor(presentation?.uxRole);
        if (textRole) {
          text.setAttribute('role', textRole);
        }
        if (presentation?.accessibleLabel) {
          text.setAttribute('aria-label', presentation.accessibleLabel);
        }
        const raw = typeof node.value === 'string' ? node.value : evaluate(node.value, scope);
        const rendered = presentation?.format ? formatValue(raw, presentation.format, locale) : toText(raw);
        if (appendIcon(text, presentation)) {
          const value = element('span', 'axiom-text-value');
          value.textContent = rendered;
          text.appendChild(value);
        } else {
          text.textContent = rendered;
        }
        return text;
      }
      case 'repeat': {
        const container = identify(element('div', nodeClasses(node, 'axiom-repeat')));
        const source = evaluate(node.source, scope);
        const items = Array.isArray(source) ? source : [];
        if (items.length === 0 && node.emptyTemplateId) {
          renderChildren([node.emptyTemplateId], scope, container, path);
          return container;
        }
        // Each member gets its own render instance, preferring its semantic identity so
        // the identity survives reordering. Nested repeats compose rather than collide.
        const identityFieldId = ir.repeatIdentityFields?.[node.id];
        items.forEach((item, index) => {
          const identity = identityFieldId && isRecord(item) ? item[identityFieldId] : undefined;
          const child = renderNode(
            node.templateId,
            childScope(scope, node.id, item),
            [...path, identityFragment(identity, index)],
          );
          if (child) {
            container.appendChild(child);
          }
        });
        return container;
      }
      case 'field-display': {
        const container = identify(element('div', nodeClasses(node, 'axiom-field')));
        const field = fieldOf(node.fieldId);
        if (node.label ?? field?.name) {
          const label = element('span', 'axiom-field-label');
          label.textContent = node.label ?? field?.name ?? '';
          container.appendChild(label);
        }
        appendIcon(container, presentation);
        const value = element('span', 'axiom-field-value');
        const source = evaluate(node.source, scope);
        // The stored value is untouched; only what is shown is formatted.
        value.textContent = isRecord(source)
          ? formatValue(source[node.fieldId], presentation?.format, locale)
          : '';
        container.appendChild(value);
        return container;
      }
      case 'form': {
        const form = identify(element('form', nodeClasses(node, 'axiom-form')));
        renderChildren(node.children, scope, form, path);
        const declaredControl = node.submitButtonId
          ? submitControls.get(node.submitButtonId)
          : undefined;
        const submitActionId = declaredControl?.actionId ?? node.submitActionId;
        if (submitActionId) {
          if (!declaredControl) {
            // The simple form: the renderer supplies the button.
            const actions = element('div', 'axiom-container axiom-ux-action-group axiom-layout-horizontal axiom-gap-small axiom-align-center axiom-justify-end axiom-wrap axiom-width-fill');
            const submit = element(
              'button',
              'axiom-submit axiom-button axiom-role-primary axiom-emphasis-strong axiom-ux-primary-action',
            );
            submit.setAttribute('type', 'submit');
            submit.textContent = node.submitLabel ?? 'Submit';
            actions.appendChild(submit);
            form.appendChild(actions);
          }
          const formInstance = instanceKey(node.id, path);
          form.addEventListener('submit', (event: DomEvent) => {
            event.preventDefault?.();
            // A declared control carries the arguments; a generated one has none to carry.
            const declared = submitInvokers.get(formInstance);
            if (declared) {
              declared();
              return;
            }
            runAction(submitActionId);
          });
        }
        return form;
      }
      case 'input': {
        const descriptor = resolveInputTag(node);
        const grouped = descriptor.tag === 'radio-group';
        const controlId = `axiom-control-${instance}`;
        const required = ir.locationRequired?.[node.id] === true;
        const wrapper = identify(element(grouped ? 'div' : 'label', nodeClasses(node, 'axiom-input')));
        if (grouped) {
          wrapper.setAttribute('role', 'group');
        } else {
          // The label is the element, and it names the control by id as well, so the
          // association survives however the two are laid out.
          wrapper.setAttribute('for', controlId);
        }
        const labelText = node.label ?? presentation?.accessibleLabel;
        if (labelText) {
          const label = element('span', 'axiom-input-label axiom-text-label');
          label.textContent = labelText;
          if (required) {
            const marker = element('span', 'axiom-required-marker');
            marker.setAttribute('aria-hidden', 'true');
            marker.textContent = '*';
            label.appendChild(marker);
          }
          wrapper.appendChild(label);
        }

        const current = readLocation(node.binding.location, scope);
        const describedBy: string[] = [];
        const control = identify(
          element(grouped ? 'div' : descriptor.tag, grouped ? 'axiom-radio-group' : 'axiom-control'),
        );
        if (descriptor.variant) {
          control.setAttribute('data-variant', descriptor.variant);
        }
        if (!grouped) {
          asControl(control);
        }
        if (!grouped) {
          control.setAttribute('id', controlId);
          if (descriptor.type) {
            control.setAttribute('type', descriptor.type);
          }
          if (node.placeholder) {
            control.setAttribute('placeholder', node.placeholder);
          }
          if (required) {
            control.setAttribute('aria-required', 'true');
          }
          if (!labelText && presentation?.accessibleLabel) {
            control.setAttribute('aria-label', presentation.accessibleLabel);
          }
        }
        if (grouped) {
          // A radio group has no single element to operate, so the group itself is it.
          wrapper.setAttribute('data-variant', descriptor.variant ?? 'radio-group');
          asControl(wrapper);
        }
        if (descriptor.variant === 'switch') {
          control.setAttribute('role', 'switch');
        }

        const radios: DomElement[] = [];
        if (grouped) {
          for (const choice of optionChoices(node, scope, descriptor.options ?? [])) {
            const option = element('label', 'axiom-radio-option');
            const radio = element('input', 'axiom-radio');
            radios.push(radio);
            radio.setAttribute('type', 'radio');
            radio.setAttribute('name', controlId);
            radio.setAttribute('value', choice.value);
            radio.value = choice.value;
            if (toText(current) === choice.value) {
              radio.checked = true;
              radio.setAttribute('checked', 'checked');
            }
            const caption = element('span');
            caption.textContent = choice.label;
            option.appendChild(radio);
            option.appendChild(caption);
            control.appendChild(option);
          }
        } else if (descriptor.type === 'checkbox') {
          control.checked = Boolean(current);
          if (Boolean(current)) {
            control.setAttribute('checked', 'checked');
          }
        } else if (descriptor.tag === 'select') {
          for (const choice of optionChoices(node, scope, descriptor.options ?? [])) {
            const option = element('option');
            option.setAttribute('value', choice.value);
            option.textContent = choice.label;
            if (toText(current) === choice.value) {
              option.setAttribute('selected', 'selected');
            }
            control.appendChild(option);
          }
          control.value = toText(current);
        } else {
          control.value = toText(current);
          control.setAttribute('value', toText(current));
        }

        // An input mutates through the same engine and transaction machinery as an
        // action. There is no separate write path inside the renderer.
        //
        // A write to canonical state is transactional with respect to hard invariants:
        // if the value would break one, the whole mutation is rolled back. A write to a
        // draft is not, because a draft is incomplete by definition while it is filled in.
        const apply = (event: DomEvent): void => {
          const source = (event.target ?? control) as DomElement;
          const next = coerceInputValue(node.id, source.value ?? '', source.checked);
          const rootStateId = ir.locationRoots[node.id];
          const rootState = rootStateId === undefined ? undefined : statesById.get(rootStateId);
          // A draft is incomplete while it is filled in, and ephemeral presentation state
          // is not a domain fact at all; neither is guarded per keystroke.
          const guarded =
            inputValidation === 'immediate' &&
            rootState !== undefined &&
            rootState.draft !== true &&
            rootState.ephemeral !== true;
          const before = guarded ? countViolations(hardViolations()) : null;

          const transaction = transactions.begin();
          const context: MutationContext = {
            source: 'ui',
            sourceNodeId: node.id,
            transactionId: transaction.id,
          };
          const failures: RuntimeDiagnostic[] = [];
          mutate(
            () => mutations.set(node.binding.location, next, scope, context),
            context,
            failures,
          );

          if (failures.length > 0) {
            settle(transaction, 'rolled-back');
            inputErrors.set(instance, failures[0].message);
            failures.forEach(report);
          } else {
            // A transition rule always applies: it compares against the state this
            // mutation started from, so it can never be a pre-existing violation.
            const rejected = [
              ...(before ? violationsIntroducedSince(before) : []),
              ...evaluateTransitions().filter((diagnostic) => diagnostic.severity === 'error'),
            ];
            if (rejected.length > 0) {
              settle(transaction, 'rolled-back');
              inputErrors.set(instance, rejected[0].message);
              rejected.forEach((diagnostic) =>
                report({ ...diagnostic, details: { ...diagnostic.details, source: 'input', nodeId: node.id } }),
              );
              report({
                code: RUNTIME_DIAGNOSTIC_CODES.INPUT_REJECTED,
                message: `${node.label ?? node.id} kept its previous value: ${rejected[0].message}`,
                severity: 'warning',
                nodeId: node.id,
                details: { source: 'input' },
              });
            } else {
              settle(transaction, 'committed');
              inputErrors.delete(instance);
            }
          }

          focusedInstance = instance;
          focusedCaret = typeof source.selectionStart === 'number' ? source.selectionStart : null;
          renderApplication();
        };
        // A radio group's listeners live on its radios; everything else is one control.
        for (const target of grouped ? radios : [control]) {
          target.addEventListener('input', apply);
          target.addEventListener('change', apply);
          target.addEventListener('focus', () => {
            focusedInstance = instance;
          });
        }
        inputElements.set(instance, control);
        wrapper.appendChild(control);

        if (presentation?.description) {
          const help = element('span', 'axiom-input-description axiom-text-caption');
          help.setAttribute('id', `${controlId}-description`);
          help.textContent = presentation.description;
          describedBy.push(`${controlId}-description`);
          wrapper.appendChild(help);
        }
        const rejection = inputErrors.get(instance);
        if (rejection) {
          // The refusal is related to the control it refused, not left floating.
          const error = element('span', 'axiom-input-description axiom-role-destructive axiom-text-caption');
          error.setAttribute('id', `${controlId}-error`);
          error.setAttribute('role', 'alert');
          error.textContent = rejection;
          describedBy.push(`${controlId}-error`);
          wrapper.appendChild(error);
          if (!grouped) {
            control.setAttribute('aria-invalid', 'true');
          }
        }
        if (describedBy.length > 0 && !grouped) {
          control.setAttribute('aria-describedby', describedBy.join(' '));
        }
        return wrapper;
      }
      case 'button': {
        const submits = submitControls.get(node.id);
        const button = asControl(
          identify(element('button', nodeClasses(node, 'axiom-button', submits ? 'axiom-submit' : ''))),
        );
        button.setAttribute('type', 'button');
        const label = typeof node.label === 'string' ? node.label : toText(evaluate(node.label, scope));
        if (presentation?.icon) {
          const caption = element('span', 'axiom-button-label');
          caption.textContent = label;
          // Where the icon sits is a theme decision, not a per-button one.
          if (theme?.buttons?.iconPlacement === 'trailing') {
            button.appendChild(caption);
            appendIcon(button, presentation);
          } else {
            appendIcon(button, presentation);
            button.appendChild(caption);
          }
        } else {
          button.textContent = label;
        }
        if (presentation?.accessibleLabel) {
          button.setAttribute('aria-label', presentation.accessibleLabel);
        }
        const reporting = reportingRegionFor(node.actionId, path);
        if (reporting) {
          button.setAttribute('aria-describedby', reporting);
        }
        // A remote action is in flight until the authority answers, and a person watching a
        // button that does nothing will press it again. `pending` is already a semantic
        // runtime outcome; this is the whole of its presentation — the control says it is
        // working, and refuses a second invocation until it is not. No async model, no
        // spinner vocabulary, nothing an author writes.
        const pending = actionOutcomes.get(node.actionId)?.outcome === 'pending';
        if (pending) {
          button.setAttribute('data-pending', 'true');
          button.setAttribute('aria-busy', 'true');
          button.setAttribute('disabled', 'true');
        }
        /** What this button does, wherever the interaction came from. */
        const invoke = (): void => {
          if (pending) {
            // The authority has not answered the last one. Pressing again would be a second
            // transaction, not a retry of the first.
            return;
          }
          const args: Record<string, unknown> = {};
          for (const [parameterId, argument] of Object.entries(node.arguments ?? {})) {
            args[parameterId] = evaluate(argument, scope);
          }
          runAction(node.actionId, args);
        };

        if (submits) {
          // Native form submission runs the action; a click handler here would run it twice.
          // The form invokes exactly this, so the button's arguments are not lost.
          button.setAttribute('type', 'submit');
          submitInvokers.set(instanceKey(submits.formId, path), invoke);
          return button;
        }
        button.addEventListener('click', (event: DomEvent) => {
          event.preventDefault?.();
          invoke();
        });
        return button;
      }
      case 'diagnostic': {
        const region = identify(element('div', nodeClasses(node, 'axiom-diagnostic')));
        region.setAttribute('id', `axiom-diagnostic-${instance}`);
        const ariaRole = ariaRoleFor(presentation?.uxRole);
        if (ariaRole) {
          region.setAttribute('role', ariaRole);
        }
        if (presentation?.accessibleLabel) {
          region.setAttribute('aria-label', presentation.accessibleLabel);
        }
        const reported = presentedDiagnostics(node);
        if (reported.length === 0) {
          // Nothing to report: the region renders empty rather than disappearing, so the
          // relationship an initiating control declares stays resolvable.
          region.setAttribute('data-empty', 'true');
          return region;
        }
        appendIcon(region, presentation);
        for (const diagnostic of reported) {
          const entry = element('span', 'axiom-diagnostic-entry axiom-text-body');
          entry.setAttribute('data-code', diagnostic.code);
          // The wording is the structured diagnostic's own; the renderer invents none.
          entry.textContent = diagnostic.message;
          region.appendChild(entry);
        }
        return region;
      }
      case 'conditional': {
        const container = identify(element('div', nodeClasses(node, 'axiom-conditional')));
        const branch = toBoolean(evaluate(node.condition, scope)) ? node.whenTrue : node.whenFalse ?? [];
        renderChildren(branch, scope, container, path);
        return container;
      }
      default:
        report({
          code: RUNTIME_DIAGNOSTIC_CODES.UNSUPPORTED_UI_NODE,
          message: `Unknown UI node kind "${(node as { kind: string }).kind}"`,
          severity: 'error',
        });
        return null;
    }
  }

  function renderApplication(): void {
    inputElements.clear();
    submitInvokers.clear();
    const scope = rootScope();
    if (!activeRoute) {
      const missing = element('div', 'axiom-no-route');
      missing.textContent = `No route matches ${host.getPath()}`;
      rootElement.replaceChildren(missing);
      return;
    }
    const view = renderNode(activeRoute.route.viewId, scope, ROOT_INSTANCE);
    rootElement.replaceChildren(...(view ? [view] : []));
    restoreFocus();
  }

  function restoreFocus(): void {
    if (!focusedInstance) {
      return;
    }
    const control = inputElements.get(focusedInstance);
    if (!control) {
      return;
    }
    try {
      control.focus?.();
      if (focusedCaret !== null && typeof control.selectionStart === 'number') {
        control.selectionStart = focusedCaret;
      }
    } catch {
      // Some controls reject caret manipulation; focus alone is enough.
    }
  }

  // -------------------------------------------------------------- public API

  initializeStore();

  return {
    start(): Promise<void> {
      if (started) {
        return startup;
      }
      started = true;
      host.onPathChange(() => {
        activeRoute = matchRoute(host.getPath());
        derivedCache.clear();
        // Diagnostics are about the screen that produced them.
        actionOutcomes.clear();
        inputErrors.clear();
        renderApplication();
      });
      // Local state and a first render happen synchronously, so an application is on screen
      // before the authority is consulted.
      syncRoute();
      startup = remote?.snapshot ? syncAuthoritative() : Promise.resolve();
      return startup;
    },
    authoritativeStateLoaded(): boolean {
      return authoritativeLoaded;
    },
    render: renderApplication,
    getState(id: NodeId): unknown {
      return cloneValue(readState(id));
    },
    hydrateState(id: NodeId, value: unknown): void {
      const transaction = transactions.begin();
      const failures: RuntimeDiagnostic[] = [];
      const context: MutationContext = { source: 'system', transactionId: transaction.id };
      mutate(
        () => mutations.set({ kind: 'state', stateId: id }, cloneValue(value), rootScope(), context),
        context,
        failures,
      );
      if (failures.length > 0) {
        settle(transaction, 'rolled-back');
        failures.forEach(report);
      } else {
        settle(transaction, 'committed');
      }
      renderApplication();
    },
    invokeAction(id: NodeId, args: Record<string, unknown> = {}): ActionResult {
      return runAction(id, args);
    },
    navigate,
    currentRoute(): RouteMatch | null {
      return activeRoute;
    },
    diagnostics(): RuntimeDiagnostic[] {
      return diagnostics.map((diagnostic) => ({ ...diagnostic }));
    },
    clearDiagnostics(): void {
      diagnostics.length = 0;
      actionOutcomes.clear();
      inputErrors.clear();
      renderApplication();
    },
    getActionOutcome(id: NodeId): ActionOutcome | undefined {
      const record = actionOutcomes.get(id);
      return record ? { ...record, diagnostics: record.diagnostics.map((d) => ({ ...d })) } : undefined;
    },
    getMutationLog(): MutationLogEntry[] {
      return mutationLog.map((entry) => ({ ...entry }));
    },
    registerNativeOperation(implementationId: string, implementation: NativeImplementation): void {
      natives.set(implementationId, implementation);
    },
    async invokeActionAsync(id: NodeId, args: Record<string, unknown> = {}): Promise<ActionResult> {
      const result = runAction(id, args);
      if (!result.pending) {
        return result;
      }
      return (await pending.get(id)) ?? result;
    },
    syncAuthoritativeState(): Promise<void> {
      return syncAuthoritative();
    },
    settled(): Promise<void> {
      return allSettled();
    },
    evaluate(expression: Expression) {
      const outcome = tryEvaluate(expression, rootScope(), {});
      return outcome.ok ? { ok: true as const, value: outcome.value } : { ok: false as const, diagnostic: outcome.diagnostic };
    },
  };
}

/** Builds a host bound to the browser globals. Used by generated pages. */
export function createBrowserHost(): HostEnvironment {
  const globals = globalThis as unknown as Record<string, any>;
  return {
    document: globals.document,
    getPath: () => globals.location.pathname,
    pushPath: (path: string) => globals.history.pushState({}, '', path),
    onPathChange: (listener: () => void) => globals.addEventListener?.('popstate', listener),
    confirm: (message: string) => Boolean(globals.confirm(message)),
    now: () => new Date().toISOString(),
    uuid: () =>
      typeof globals.crypto?.randomUUID === 'function'
        ? globals.crypto.randomUUID()
        : `id-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`,
    storage: globals.localStorage
      ? {
          read: (key: string) => globals.localStorage.getItem(key),
          write: (key: string, value: string) => globals.localStorage.setItem(key, value),
        }
      : undefined,
    report: (message: string) => globals.console?.warn?.(message),
  };
}
