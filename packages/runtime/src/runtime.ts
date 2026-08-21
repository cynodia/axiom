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
  inputValidation?: InputValidationMode;
  /** Records previous and next values in the mutation log. */
  recordMutationValues?: boolean;
}

export interface AxiomRuntime {
  start(): void;
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
  clearDiagnostics(): void;
  /** Every mutation this runtime has applied, in order, with its semantic location. */
  getMutationLog(): MutationLogEntry[];
  registerNativeOperation(implementationId: string, implementation: NativeImplementation): void;
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

export function createAxiomRuntime(options: AxiomRuntimeOptions): AxiomRuntime {
  const { ir, rootElement, host } = options;
  const store = createStateStore();
  const derivedCache = new Map<string, unknown>();
  const natives = new Map<string, NativeImplementation>(
    Object.entries(options.nativeOperations ?? {}),
  );
  const diagnostics: RuntimeDiagnostic[] = [];
  const inputElements = new Map<string, DomElement>();
  let focusedNodeId: string | null = null;
  let focusedCaret: number | null = null;
  let started = false;
  let transactionCounter = 0;
  const mutationLog: MutationLogEntry[] = [];
  const inputValidation = options.inputValidation ?? 'immediate';
  const theme = ir.theme;
  const locale = theme?.locale ?? 'en-US';
  /** Messages for inputs whose last write was refused, so a control can say so. */
  const inputErrors = new Map<string, string>();

  /** Presentation, already resolved by the compiler. The renderer decides nothing. */
  function presentationOf(id: string): ResolvedPresentation | undefined {
    return (ir.presentation as Record<string, ResolvedPresentation> | undefined)?.[id];
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
    switch (operator) {
      case 'eq':
        return valuesEqual(left, right);
      case 'neq':
        return !valuesEqual(left, right);
      case 'gt':
        return compareValues(left, right) > 0;
      case 'gte':
        return compareValues(left, right) >= 0;
      case 'lt':
        return compareValues(left, right) < 0;
      case 'lte':
        return compareValues(left, right) <= 0;
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

  function runAction(actionId: string, args: Record<string, unknown> = {}): ActionResult {
    return collecting((collected) => runActionCollecting(actionId, args, collected));
  }

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
      renderApplication();
      return { ok: false, diagnostics: [...collected] };
    }

    settle(transaction, 'committed');
    renderApplication();
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
    activeRoute = matchRoute(host.getPath());
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

  function renderChildren(ids: NodeId[], scope: Scope, parent: DomElement): void {
    for (const id of ids) {
      const child = renderNode(id, scope);
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

  function renderNode(id: NodeId, scope: Scope): DomElement | null {
    try {
      return renderNodeUnguarded(id, scope);
    } catch (error) {
      report(evaluationFailure(error, { nodeId: id }));
      return null;
    }
  }

  function renderNodeUnguarded(id: NodeId, scope: Scope): DomElement | null {
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

    switch (node.kind) {
      case 'view': {
        const container = element('div', nodeClasses(node, 'axiom-view'));
        container.setAttribute('data-node', node.id);
        renderChildren(node.children, scope, container);
        return container;
      }
      case 'container': {
        // A UX role that names a region of the page becomes the element that means it, so
        // the landmark structure an author declared is the one assistive technology sees.
        const container = element(landmarkTag(presentation?.uxRole) ?? 'div', nodeClasses(node, 'axiom-container'));
        container.setAttribute('data-node', node.id);
        const ariaRole = ariaRoleFor(presentation?.uxRole);
        if (ariaRole) {
          container.setAttribute('role', ariaRole);
        }
        if (presentation?.accessibleLabel) {
          container.setAttribute('aria-label', presentation.accessibleLabel);
        }
        appendIcon(container, presentation);
        renderChildren(node.children, scope, container);
        return container;
      }
      case 'text': {
        const text = element(headingTag(presentation?.textRole) ?? 'span', nodeClasses(node, 'axiom-text'));
        text.setAttribute('data-node', node.id);
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
        const container = element('div', nodeClasses(node, 'axiom-repeat'));
        container.setAttribute('data-node', node.id);
        const source = evaluate(node.source, scope);
        const items = Array.isArray(source) ? source : [];
        if (items.length === 0 && node.emptyTemplateId) {
          renderChildren([node.emptyTemplateId], scope, container);
          return container;
        }
        for (const item of items) {
          const child = renderNode(node.templateId, childScope(scope, node.id, item));
          if (child) {
            container.appendChild(child);
          }
        }
        return container;
      }
      case 'field-display': {
        const container = element('div', nodeClasses(node, 'axiom-field'));
        container.setAttribute('data-node', node.id);
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
        const form = element('form', nodeClasses(node, 'axiom-form'));
        form.setAttribute('data-node', node.id);
        renderChildren(node.children, scope, form);
        if (node.submitActionId) {
          const actions = element('div', 'axiom-container axiom-ux-action-group axiom-layout-horizontal axiom-gap-small axiom-align-center axiom-justify-end axiom-wrap axiom-width-fill');
          const submit = element(
            'button',
            'axiom-submit axiom-button axiom-role-primary axiom-emphasis-strong axiom-ux-primary-action',
          );
          submit.setAttribute('type', 'submit');
          submit.textContent = node.submitLabel ?? 'Submit';
          actions.appendChild(submit);
          form.appendChild(actions);
          const actionId = node.submitActionId;
          form.addEventListener('submit', (event: DomEvent) => {
            event.preventDefault?.();
            runAction(actionId);
          });
        }
        return form;
      }
      case 'input': {
        const descriptor = resolveInputTag(node);
        const grouped = descriptor.tag === 'radio-group';
        const controlId = `axiom-control-${node.id}`;
        const required = ir.locationRequired?.[node.id] === true;
        const wrapper = element(grouped ? 'div' : 'label', nodeClasses(node, 'axiom-input'));
        wrapper.setAttribute('data-node', node.id);
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
        const control = element(grouped ? 'div' : descriptor.tag, grouped ? 'axiom-radio-group' : 'axiom-control');
        control.setAttribute('data-node', node.id);
        if (descriptor.variant) {
          control.setAttribute('data-control', descriptor.variant);
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
          wrapper.setAttribute('data-control', descriptor.variant ?? 'radio-group');
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
            inputErrors.set(node.id, failures[0].message);
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
              inputErrors.set(node.id, rejected[0].message);
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
              inputErrors.delete(node.id);
            }
          }

          focusedNodeId = node.id;
          focusedCaret = typeof source.selectionStart === 'number' ? source.selectionStart : null;
          renderApplication();
        };
        // A radio group's listeners live on its radios; everything else is one control.
        for (const target of grouped ? radios : [control]) {
          target.addEventListener('input', apply);
          target.addEventListener('change', apply);
          target.addEventListener('focus', () => {
            focusedNodeId = node.id;
          });
        }
        inputElements.set(node.id, control);
        wrapper.appendChild(control);

        if (presentation?.description) {
          const help = element('span', 'axiom-input-description axiom-text-caption');
          help.setAttribute('id', `${controlId}-description`);
          help.textContent = presentation.description;
          describedBy.push(`${controlId}-description`);
          wrapper.appendChild(help);
        }
        const rejection = inputErrors.get(node.id);
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
        const button = element('button', nodeClasses(node, 'axiom-button'));
        button.setAttribute('data-node', node.id);
        button.setAttribute('type', 'button');
        const label = typeof node.label === 'string' ? node.label : toText(evaluate(node.label, scope));
        if (appendIcon(button, presentation)) {
          const caption = element('span', 'axiom-button-label');
          caption.textContent = label;
          button.appendChild(caption);
        } else {
          button.textContent = label;
        }
        if (presentation?.accessibleLabel) {
          button.setAttribute('aria-label', presentation.accessibleLabel);
        }
        button.addEventListener('click', (event: DomEvent) => {
          event.preventDefault?.();
          const args: Record<string, unknown> = {};
          for (const [parameterId, argument] of Object.entries(node.arguments ?? {})) {
            args[parameterId] = evaluate(argument, scope);
          }
          runAction(node.actionId, args);
        });
        return button;
      }
      case 'conditional': {
        const container = element('div', nodeClasses(node, 'axiom-conditional'));
        container.setAttribute('data-node', node.id);
        const branch = toBoolean(evaluate(node.condition, scope)) ? node.whenTrue : node.whenFalse ?? [];
        renderChildren(branch, scope, container);
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
    const scope = rootScope();
    if (!activeRoute) {
      const missing = element('div', 'axiom-no-route');
      missing.textContent = `No route matches ${host.getPath()}`;
      rootElement.replaceChildren(missing);
      return;
    }
    const view = renderNode(activeRoute.route.viewId, scope);
    rootElement.replaceChildren(...(view ? [view] : []));
    restoreFocus();
  }

  function restoreFocus(): void {
    if (!focusedNodeId) {
      return;
    }
    const control = inputElements.get(focusedNodeId);
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
    start(): void {
      if (started) {
        return;
      }
      started = true;
      host.onPathChange(() => {
        activeRoute = matchRoute(host.getPath());
        derivedCache.clear();
        renderApplication();
      });
      syncRoute();
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
    },
    getMutationLog(): MutationLogEntry[] {
      return mutationLog.map((entry) => ({ ...entry }));
    },
    registerNativeOperation(implementationId: string, implementation: NativeImplementation): void {
      natives.set(implementationId, implementation);
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
