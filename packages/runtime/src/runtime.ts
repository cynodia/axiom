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
  NodeId,
  Operation,
  StateDef,
  TypeRef,
  UINode,
} from '@axiom/core';
import type { DomElement, DomEvent, HostEnvironment } from './dom.js';

export interface RuntimeDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: NodeId;
  fieldId?: FieldId;
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

export interface AxiomRuntimeOptions {
  ir: ApplicationIR;
  rootElement: DomElement;
  host: HostEnvironment;
  nativeOperations?: Record<string, NativeImplementation>;
}

export interface AxiomRuntime {
  start(): void;
  render(): void;
  getState(id: NodeId): unknown;
  setState(id: NodeId, value: unknown): void;
  invokeAction(id: NodeId, args?: Record<string, unknown>): ActionResult;
  navigate(path: string): void;
  currentRoute(): RouteMatch | null;
  diagnostics(): RuntimeDiagnostic[];
  registerNativeOperation(implementationId: string, implementation: NativeImplementation): void;
}

interface Scope {
  values: Map<string, unknown>;
  parent?: Scope;
}

const MISSING = Symbol('missing');

function cloneValue<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Presence semantics used by `required` — distinct from boolean coercion. */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function toBoolean(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const leftText = toText(left);
  const rightText = toText(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

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

export function createAxiomRuntime(options: AxiomRuntimeOptions): AxiomRuntime {
  const { ir, rootElement, host } = options;
  const store = new Map<string, unknown>();
  const derivedCache = new Map<string, unknown>();
  const natives = new Map<string, NativeImplementation>(
    Object.entries(options.nativeOperations ?? {}),
  );
  const diagnostics: RuntimeDiagnostic[] = [];
  const inputElements = new Map<string, DomElement>();
  let focusedNodeId: string | null = null;
  let focusedCaret: number | null = null;
  let started = false;

  const statesById = new Map<string, StateDef>(ir.states.map((state) => [state.id, state]));
  const entitiesById = new Map<string, EntityDef>(ir.entities.map((entity) => [entity.id, entity]));

  function report(diagnostic: RuntimeDiagnostic): void {
    diagnostics.push(diagnostic);
    if (diagnostic.severity === 'error') {
      host.report?.(`${diagnostic.code}: ${diagnostic.message}`);
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
            store.set(state.id, JSON.parse(persisted) as unknown);
            continue;
          } catch {
            report({
              code: 'PERSISTED_STATE_UNREADABLE',
              message: `Stored value for ${state.id} could not be parsed; falling back to the initial value`,
              severity: 'warning',
              nodeId: state.id,
            });
          }
        }
      }
      store.set(
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
      host.storage.write(key, JSON.stringify(store.get(stateId) ?? null));
    }
  }

  function readState(stateId: string): unknown {
    const state = statesById.get(stateId);
    if (state?.derivation) {
      if (derivedCache.has(stateId)) {
        return derivedCache.get(stateId);
      }
      derivedCache.set(stateId, null);
      const value = evaluate(state.derivation, rootScope());
      derivedCache.set(stateId, value);
      return value;
    }
    return store.get(stateId);
  }

  function writeState(stateId: string, value: unknown): void {
    store.set(stateId, value);
    derivedCache.clear();
    persistState(stateId);
  }

  function snapshotStore(): Map<string, unknown> {
    const snapshot = new Map<string, unknown>();
    for (const [key, value] of store) {
      snapshot.set(key, cloneValue(value));
    }
    return snapshot;
  }

  function restoreStore(snapshot: Map<string, unknown>): void {
    store.clear();
    for (const [key, value] of snapshot) {
      store.set(key, value);
    }
    derivedCache.clear();
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
        report({
          code: 'UNRESOLVED_REFERENCE',
          message: `Reference ${expression.targetId} could not be resolved`,
          severity: 'error',
          nodeId: expression.targetId,
        });
        return null;
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
        const source = evaluate(expression.source, scope);
        if (!Array.isArray(source)) {
          return [];
        }
        return source.filter((item) =>
          toBoolean(evaluate(expression.predicate, childScope(scope, expression.scopeId, item))),
        );
      }
      case 'find': {
        const source = evaluate(expression.source, scope);
        if (!Array.isArray(source)) {
          return null;
        }
        const found = source.find((item) =>
          toBoolean(evaluate(expression.predicate, childScope(scope, expression.scopeId, item))),
        );
        return found === undefined ? null : found;
      }
      default:
        report({
          code: 'UNKNOWN_EXPRESSION',
          message: `Unknown expression kind "${(expression as { kind: string }).kind}"`,
          severity: 'error',
        });
        return null;
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
        report({ code: 'UNKNOWN_OPERATOR', message: `Unknown operator "${operator}"`, severity: 'error' });
        return null;
    }
  }

  function evaluateCall(fn: string, args: Expression[], scope: Scope): unknown {
    const values = args.map((argument) => evaluate(argument, scope));
    switch (fn) {
      case 'required':
        return isPresent(values[0]);
      case 'is-empty':
        return !isPresent(values[0]);
      case 'length':
        return Array.isArray(values[0]) ? values[0].length : toText(values[0]).length;
      case 'count':
        return Array.isArray(values[0]) ? values[0].length : 0;
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
        report({ code: 'UNKNOWN_FUNCTION', message: `Unknown function "${fn}"`, severity: 'error' });
        return null;
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

  function instancesOf(entityId: string): unknown[] {
    const instances: unknown[] = [];
    for (const state of ir.states) {
      // Drafts are incomplete by definition, and derived states are views of data that
      // is already validated where it is stored.
      if (state.draft || state.derivation) {
        continue;
      }
      if (collectionEntityId(state) !== entityId) {
        continue;
      }
      const value = readState(state.id);
      if (Array.isArray(value)) {
        instances.push(...value);
      } else if (isRecord(value)) {
        instances.push(value);
      }
    }
    return instances;
  }

  function checkFieldValue(field: FieldDef, value: unknown, entityId: string): RuntimeDiagnostic | null {
    if (!isPresent(value)) {
      if (field.required) {
        return {
          code: 'REQUIRED_FIELD_MISSING',
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
        code: 'ENUM_VALUE_INVALID',
        message: `${field.name ?? field.id} must be one of: ${resolved.values.join(', ')}`,
        severity: 'error',
        nodeId: entityId as NodeId,
        fieldId: field.id,
      };
    }
    if (resolved.kind === 'primitive' && resolved.primitive === 'number' && typeof value !== 'number') {
      return {
        code: 'TYPE_MISMATCH',
        message: `${field.name ?? field.id} must be a number`,
        severity: 'error',
        nodeId: entityId as NodeId,
        fieldId: field.id,
      };
    }
    if (resolved.kind === 'primitive' && resolved.primitive === 'boolean' && typeof value !== 'boolean') {
      return {
        code: 'TYPE_MISMATCH',
        message: `${field.name ?? field.id} must be a boolean`,
        severity: 'error',
        nodeId: entityId as NodeId,
        fieldId: field.id,
      };
    }
    return null;
  }

  /** Schema conformance plus declared constraints, evaluated over live instances. */
  function evaluateInvariants(): RuntimeDiagnostic[] {
    const failures: RuntimeDiagnostic[] = [];
    for (const entity of ir.entities) {
      for (const instance of instancesOf(entity.id)) {
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
      failures.push(...evaluateConstraint(constraint));
    }
    return failures;
  }

  function evaluateConstraint(constraint: ConstraintDef): RuntimeDiagnostic[] {
    const severity = constraint.severity ?? 'error';
    const failures: RuntimeDiagnostic[] = [];
    const record = (): void => {
      failures.push({
        code: 'CONSTRAINT_VIOLATION',
        message: constraint.message ?? `Constraint ${constraint.name ?? constraint.id} failed`,
        severity,
        nodeId: constraint.id,
      });
    };

    if (!constraint.entityId) {
      if (!toBoolean(evaluate(constraint.expression, rootScope()))) {
        record();
      }
      return failures;
    }
    for (const instance of instancesOf(constraint.entityId)) {
      const scope = childScope(rootScope(), constraint.entityId, instance);
      if (!toBoolean(evaluate(constraint.expression, scope))) {
        record();
      }
    }
    return failures;
  }

  // --------------------------------------------------------------- behaviour

  function resolveIdentityField(entityId: string | null): FieldId | null {
    if (!entityId) {
      return null;
    }
    return entitiesById.get(entityId)?.identityFieldId ?? null;
  }

  function executeOperation(operation: Operation, scope: Scope, result: RuntimeDiagnostic[]): void {
    switch (operation.kind) {
      case 'set-state':
        writeState(operation.stateId, cloneValue(evaluate(operation.value, scope)));
        return;
      case 'add-item': {
        const collection = readState(operation.collectionId);
        const items = Array.isArray(collection) ? collection : [];
        const value = cloneValue(evaluate(operation.value, scope));
        if (operation.position === 'start') {
          items.unshift(value);
        } else {
          items.push(value);
        }
        writeState(operation.collectionId, items);
        return;
      }
      case 'remove-item': {
        const collection = readState(operation.collectionId);
        if (!Array.isArray(collection)) {
          return;
        }
        const target = evaluate(operation.item, scope);
        const state = statesById.get(operation.collectionId);
        const identity = resolveIdentityField(state ? collectionEntityId(state) : null);
        const remaining = collection.filter((item) => {
          if (identity && isRecord(item) && isRecord(target)) {
            return !valuesEqual(item[identity], target[identity]);
          }
          return !valuesEqual(item, target);
        });
        writeState(operation.collectionId, remaining);
        return;
      }
      case 'update-field': {
        const target = evaluate(operation.target, scope);
        if (!isRecord(target)) {
          result.push({
            code: 'UPDATE_TARGET_MISSING',
            message: `Update target for field ${operation.fieldId} did not resolve to a record`,
            severity: 'error',
            fieldId: operation.fieldId,
          });
          return;
        }
        target[operation.fieldId] = evaluate(operation.value, scope);
        derivedCache.clear();
        for (const state of ir.states) {
          persistState(state.id);
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
            code: 'ROUTE_NOT_FOUND',
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
            code: 'NATIVE_OPERATION_MISSING',
            message: `No implementation registered for "${operation.implementationId}"`,
            severity: 'error',
          });
          return;
        }
        const inputs: Record<string, unknown> = {};
        for (const [key, argument] of Object.entries(operation.inputs ?? {})) {
          inputs[key] = evaluate(argument, scope);
        }
        implementation(inputs);
        return;
      }
      default:
        result.push({
          code: 'UNKNOWN_OPERATION',
          message: `Unknown operation kind "${(operation as { kind: string }).kind}"`,
          severity: 'error',
        });
    }
  }

  function runAction(actionId: string, args: Record<string, unknown> = {}): ActionResult {
    const action: ActionDef | undefined = ir.actions[actionId as NodeId];
    if (!action) {
      const failure: RuntimeDiagnostic = {
        code: 'ACTION_NOT_FOUND',
        message: `Action ${actionId} is not defined`,
        severity: 'error',
      };
      report(failure);
      return { ok: false, diagnostics: [failure] };
    }

    const scope = rootScope();
    for (const parameter of action.parameters ?? []) {
      scope.values.set(parameter.id, args[parameter.id] ?? null);
    }

    const failures: RuntimeDiagnostic[] = [];
    for (const parameter of action.parameters ?? []) {
      if (parameter.required && !isPresent(scope.values.get(parameter.id))) {
        failures.push({
          code: 'PARAMETER_MISSING',
          message: `Action ${action.name ?? action.id} requires ${parameter.name ?? parameter.id}`,
          severity: 'error',
          nodeId: action.id,
        });
      }
    }
    if (failures.length > 0) {
      failures.forEach(report);
      return { ok: false, diagnostics: failures };
    }

    for (const precondition of action.preconditions ?? []) {
      if (!toBoolean(evaluate(precondition, scope))) {
        const failure: RuntimeDiagnostic = {
          code: 'PRECONDITION_FAILED',
          message:
            action.failureModes?.[0]?.message ??
            `A precondition of ${action.name ?? action.id} was not satisfied`,
          severity: 'error',
          nodeId: action.id,
        };
        report(failure);
        return { ok: false, diagnostics: [failure] };
      }
    }

    if (action.requiresConfirmation) {
      const message =
        action.confirmationMessage ?? `Confirm ${action.name ?? action.id}. This cannot be undone.`;
      if (!host.confirm(message)) {
        return { ok: false, diagnostics: [] };
      }
    }

    const snapshot = snapshotStore();
    const operationDiagnostics: RuntimeDiagnostic[] = [];
    for (const operation of action.operations ?? []) {
      executeOperation(operation, scope, operationDiagnostics);
    }

    const violations = [
      ...operationDiagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
      ...evaluateInvariants().filter((diagnostic) => diagnostic.severity === 'error'),
    ];
    for (const postcondition of action.postconditions ?? []) {
      if (!toBoolean(evaluate(postcondition, scope))) {
        violations.push({
          code: 'POSTCONDITION_FAILED',
          message: `A postcondition of ${action.name ?? action.id} was not satisfied`,
          severity: 'error',
          nodeId: action.id,
        });
      }
    }

    if (violations.length > 0) {
      restoreStore(snapshot);
      violations.forEach(report);
      renderApplication();
      return { ok: false, diagnostics: violations };
    }

    renderApplication();
    return { ok: true, diagnostics: operationDiagnostics };
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

  function presentationClasses(node: UINode): string {
    const hints = node.presentation;
    if (!hints) {
      return '';
    }
    return [
      hints.role ? `axiom-role-${hints.role}` : '',
      hints.density ? `axiom-density-${hints.density}` : '',
      hints.emphasis ? `axiom-emphasis-${hints.emphasis}` : '',
    ]
      .filter(Boolean)
      .join(' ');
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

  function resolveInputTag(node: UINode & { kind: 'input' }): {
    tag: string;
    type?: string;
    options?: string[];
  } {
    const field = fieldOf(node.binding.fieldId);
    const resolved = field ? unwrapType(field.valueType) : null;
    const hint = node.inputHint;
    if (hint === 'multiline') {
      return { tag: 'textarea' };
    }
    if (node.options) {
      return { tag: 'select' };
    }
    if (hint === 'select' || (!hint && resolved?.kind === 'enum')) {
      return { tag: 'select', options: resolved?.kind === 'enum' ? resolved.values : [] };
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

  function coerceInputValue(fieldId: FieldId, raw: string, checked: boolean | undefined): unknown {
    const field = fieldOf(fieldId);
    const resolved = field ? unwrapType(field.valueType) : null;
    if (resolved?.kind === 'primitive' && resolved.primitive === 'boolean') {
      return Boolean(checked);
    }
    if (resolved?.kind === 'primitive' && resolved.primitive === 'number') {
      if (raw.trim() === '') {
        return field?.required ? 0 : null;
      }
      const parsed = Number(raw);
      return Number.isNaN(parsed) ? raw : parsed;
    }
    return raw;
  }

  function renderNode(id: NodeId, scope: Scope): DomElement | null {
    const node = ir.uiNodes[id];
    if (!node) {
      report({
        code: 'UI_NODE_MISSING',
        message: `UI node ${id} is not defined`,
        severity: 'error',
        nodeId: id,
      });
      return null;
    }
    if (node.visibleWhen && !toBoolean(evaluate(node.visibleWhen, scope))) {
      return null;
    }

    switch (node.kind) {
      case 'view': {
        const container = element('div', `axiom-view ${presentationClasses(node)}`.trim());
        container.setAttribute('data-node', node.id);
        renderChildren(node.children, scope, container);
        return container;
      }
      case 'container': {
        const container = element(
          'div',
          `axiom-container axiom-layout-${node.layout ?? 'vertical'} ${presentationClasses(node)}`.trim(),
        );
        container.setAttribute('data-node', node.id);
        renderChildren(node.children, scope, container);
        return container;
      }
      case 'text': {
        const text = element('span', `axiom-text ${presentationClasses(node)}`.trim());
        text.setAttribute('data-node', node.id);
        text.textContent =
          typeof node.value === 'string' ? node.value : toText(evaluate(node.value, scope));
        return text;
      }
      case 'repeat': {
        const container = element('div', 'axiom-repeat');
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
        const container = element('div', 'axiom-field');
        container.setAttribute('data-node', node.id);
        const field = fieldOf(node.fieldId);
        if (node.label ?? field?.name) {
          const label = element('span', 'axiom-field-label');
          label.textContent = node.label ?? field?.name ?? '';
          container.appendChild(label);
        }
        const value = element('span', 'axiom-field-value');
        const source = evaluate(node.source, scope);
        value.textContent = isRecord(source) ? toText(source[node.fieldId]) : '';
        container.appendChild(value);
        return container;
      }
      case 'form': {
        const form = element('form', 'axiom-form');
        form.setAttribute('data-node', node.id);
        renderChildren(node.children, scope, form);
        if (node.submitActionId) {
          const submit = element('button', 'axiom-submit');
          submit.setAttribute('type', 'submit');
          submit.textContent = node.submitLabel ?? 'Submit';
          form.appendChild(submit);
          const actionId = node.submitActionId;
          form.addEventListener('submit', (event: DomEvent) => {
            event.preventDefault?.();
            runAction(actionId);
          });
        }
        return form;
      }
      case 'input': {
        const wrapper = element('label', 'axiom-input');
        wrapper.setAttribute('data-node', node.id);
        if (node.label) {
          const label = element('span', 'axiom-input-label');
          label.textContent = node.label;
          wrapper.appendChild(label);
        }
        const descriptor = resolveInputTag(node);
        const control = element(descriptor.tag, 'axiom-control');
        control.setAttribute('data-node', node.id);
        if (descriptor.type) {
          control.setAttribute('type', descriptor.type);
        }
        if (node.placeholder) {
          control.setAttribute('placeholder', node.placeholder);
        }
        const target = evaluate(node.binding.target, scope);
        const current = isRecord(target) ? target[node.binding.fieldId] : null;
        if (descriptor.type === 'checkbox') {
          control.checked = Boolean(current);
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

        const apply = (event: DomEvent): void => {
          const source = (event.target ?? control) as DomElement;
          const next = coerceInputValue(node.binding.fieldId, source.value ?? '', source.checked);
          const liveTarget = evaluate(node.binding.target, scope);
          if (!isRecord(liveTarget)) {
            return;
          }
          liveTarget[node.binding.fieldId] = next;
          derivedCache.clear();
          for (const state of ir.states) {
            persistState(state.id);
          }
          focusedNodeId = node.id;
          focusedCaret = typeof source.selectionStart === 'number' ? source.selectionStart : null;
          renderApplication();
        };
        control.addEventListener('input', apply);
        control.addEventListener('change', apply);
        control.addEventListener('focus', () => {
          focusedNodeId = node.id;
        });
        inputElements.set(node.id, control);
        wrapper.appendChild(control);
        return wrapper;
      }
      case 'button': {
        const button = element(
          'button',
          `axiom-button ${node.destructive ? 'axiom-destructive' : ''} ${presentationClasses(node)}`.trim(),
        );
        button.setAttribute('data-node', node.id);
        button.setAttribute('type', 'button');
        button.textContent =
          typeof node.label === 'string' ? node.label : toText(evaluate(node.label, scope));
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
        const container = element('div', 'axiom-conditional');
        container.setAttribute('data-node', node.id);
        const branch = toBoolean(evaluate(node.condition, scope)) ? node.whenTrue : node.whenFalse ?? [];
        renderChildren(branch, scope, container);
        return container;
      }
      default:
        report({
          code: 'UNKNOWN_UI_NODE',
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
    setState(id: NodeId, value: unknown): void {
      writeState(id, cloneValue(value));
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
