import type { Expression, LiteralValue } from './deps.js';
import { MIGRATION_OLD_SCOPE } from './deps.js';
import { compareScalars } from './query-eval.js';

/**
 * The pure evaluator for a migration transform expression (spec11 §24, §25).
 *
 * It reuses ordinary Axiom `Expression` semantics — the same tree the runtime evaluates —
 * over an isolated scope whose only bindings are the old record (`MIGRATION_OLD_SCOPE`), the
 * operation's declared constants, and any nested iteration scopes the expression introduces.
 * It has no access to application state, no wall clock and no randomness: `now` and `uuid`
 * throw here as a second line of defence behind `validateGraph` (spec11 §26).
 *
 * A future language implementation evaluates the identical tree with the identical rules —
 * IEEE-754 binary64 arithmetic and Unicode code-point ordering, shared with the query
 * evaluator via `compareScalars`.
 */
export class MigrationTransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationTransformError';
  }
}

export type MigrationScope = Map<string, unknown>;

/** Build the base scope for one row: the old record bound to `MIGRATION_OLD_SCOPE` plus constants. */
export function migrationRowScope(
  oldRecord: Record<string, unknown>,
  constants: Record<string, LiteralValue> = {},
): MigrationScope {
  const scope: MigrationScope = new Map();
  scope.set(String(MIGRATION_OLD_SCOPE), oldRecord);
  for (const [id, value] of Object.entries(constants)) {
    scope.set(id, value);
  }
  return scope;
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || Array.isArray(value)) {
    return (value as string | unknown[]).length === 0;
  }
  return false;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const PURE_CALLS = new Set([
  'required',
  'is-empty',
  'non-empty',
  'length',
  'contains',
  'concat',
  'coalesce',
  'one-of',
  'count',
  'sum',
  'lowercase',
  'to-string',
]);

/** Evaluate one migration transform expression in `scope`. */
export function evaluateMigrationExpression(expression: Expression, scope: MigrationScope): unknown {
  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'ref': {
      const key = String(expression.targetId);
      if (!scope.has(key)) {
        throw new MigrationTransformError(
          `transform reads ${key}, which is not the old record, a declared constant or an iteration scope`,
        );
      }
      return scope.get(key);
    }
    case 'field': {
      const source = evaluateMigrationExpression(expression.source, scope);
      if (source === null || source === undefined || typeof source !== 'object') {
        return null;
      }
      const value = (source as Record<string, unknown>)[expression.fieldId as unknown as string];
      return value === undefined ? null : value;
    }
    case 'object': {
      const record: Record<string, unknown> = {};
      for (const entry of expression.entries) {
        record[entry.fieldId as unknown as string] = evaluateMigrationExpression(entry.value, scope);
      }
      return record;
    }
    case 'unary': {
      const operand = evaluateMigrationExpression(expression.operand, scope);
      return expression.operator === 'not'
        ? !truthy(operand)
        : typeof operand === 'number'
          ? -operand
          : null;
    }
    case 'binary': {
      const left = evaluateMigrationExpression(expression.left, scope);
      const right = evaluateMigrationExpression(expression.right, scope);
      switch (expression.operator) {
        case 'eq':
          return left !== null && right !== null && structurallyEqual(left, right);
        case 'neq':
          return !(left !== null && right !== null && structurallyEqual(left, right));
        case 'lt':
        case 'lte':
        case 'gt':
        case 'gte': {
          if (left === null || right === null) return false;
          const order = compareScalars(left as never, right as never);
          if (expression.operator === 'lt') return order < 0;
          if (expression.operator === 'lte') return order <= 0;
          if (expression.operator === 'gt') return order > 0;
          return order >= 0;
        }
        case 'and':
          return truthy(left) && truthy(right);
        case 'or':
          return truthy(left) || truthy(right);
        case 'add':
          return num(left) + num(right);
        case 'subtract':
          return num(left) - num(right);
        case 'multiply':
          return num(left) * num(right);
        case 'divide':
          return num(right) === 0 ? NaN : num(left) / num(right);
        default:
          throw new MigrationTransformError('unsupported binary operator in a migration transform');
      }
    }
    case 'conditional':
      return truthy(evaluateMigrationExpression(expression.condition, scope))
        ? evaluateMigrationExpression(expression.whenTrue, scope)
        : evaluateMigrationExpression(expression.whenFalse, scope);
    case 'call': {
      if (expression.function === 'now' || expression.function === 'uuid') {
        throw new MigrationTransformError(
          `${expression.function}() is not deterministic and cannot run inside a migration transform (spec11 §26)`,
        );
      }
      if (!PURE_CALLS.has(expression.function)) {
        throw new MigrationTransformError(`call:${expression.function}`);
      }
      const args = expression.arguments.map((arg) => evaluateMigrationExpression(arg, scope));
      return evaluateCall(expression.function, args);
    }
    case 'filter':
    case 'find':
    case 'map':
    case 'every':
    case 'some':
    case 'sort': {
      const source = evaluateMigrationExpression(expression.source, scope);
      if (source === null || source === undefined) {
        throw new MigrationTransformError(`${expression.kind} over a missing collection`);
      }
      if (!Array.isArray(source)) {
        throw new MigrationTransformError(`${expression.kind} over a non-collection`);
      }
      const scopeId = String((expression as { scopeId: string }).scopeId);
      const withItem = (item: unknown): MigrationScope => {
        const next = new Map(scope);
        next.set(scopeId, item);
        return next;
      };
      if (expression.kind === 'map') {
        return source.map((item) => evaluateMigrationExpression(expression.projection, withItem(item)));
      }
      if (expression.kind === 'filter') {
        return source.filter((item) => truthy(evaluateMigrationExpression(expression.predicate, withItem(item))));
      }
      if (expression.kind === 'find') {
        return (
          source.find((item) => truthy(evaluateMigrationExpression(expression.predicate, withItem(item)))) ?? null
        );
      }
      if (expression.kind === 'every') {
        return source.every((item) => truthy(evaluateMigrationExpression(expression.predicate, withItem(item))));
      }
      if (expression.kind === 'some') {
        return source.some((item) => truthy(evaluateMigrationExpression(expression.predicate, withItem(item))));
      }
      // sort
      const direction = (expression as { direction?: 'asc' | 'desc' }).direction ?? 'asc';
      const keyed = source.map((item) => ({
        item,
        key: evaluateMigrationExpression((expression as { by: Expression }).by, withItem(item)),
      }));
      keyed.sort((a, b) => {
        const order =
          a.key === null || b.key === null ? 0 : compareScalars(a.key as never, b.key as never);
        return direction === 'desc' ? -order : order;
      });
      return keyed.map((entry) => entry.item);
    }
    case 'flatten': {
      const source = evaluateMigrationExpression(expression.source, scope);
      if (!Array.isArray(source)) {
        throw new MigrationTransformError('flatten over a non-collection');
      }
      return source.flatMap((item) => (Array.isArray(item) ? item : [item]));
    }
    default:
      throw new MigrationTransformError(`unsupported expression kind in a migration transform: ${expression.kind}`);
  }
}

function evaluateCall(fn: string, args: unknown[]): unknown {
  switch (fn) {
    case 'contains': {
      const [haystack, needle] = args;
      if (typeof haystack === 'string') return haystack.includes(String(needle));
      if (Array.isArray(haystack)) return haystack.some((item) => structurallyEqual(item, needle));
      return false;
    }
    case 'lowercase':
      return typeof args[0] === 'string' ? args[0].toLowerCase() : args[0];
    case 'to-string':
      return args[0] === null || args[0] === undefined ? '' : String(args[0]);
    case 'coalesce':
      return args.find((value) => value !== null && value !== undefined) ?? null;
    case 'is-empty':
      return isEmpty(args[0]);
    case 'non-empty':
      return !isEmpty(args[0]);
    case 'required':
      return args[0] !== null && args[0] !== undefined;
    case 'length':
      return typeof args[0] === 'string' || Array.isArray(args[0])
        ? (args[0] as string | unknown[]).length
        : 0;
    case 'concat':
      return args.map((value) => (value === null || value === undefined ? '' : String(value))).join('');
    case 'one-of':
      return args.slice(1).some((value) => structurallyEqual(value, args[0]));
    case 'count':
      return Array.isArray(args[0]) ? args[0].length : 0;
    case 'sum':
      return Array.isArray(args[0]) ? (args[0] as unknown[]).reduce<number>((total, v) => total + num(v), 0) : 0;
    default:
      throw new MigrationTransformError(`call:${fn}`);
  }
}
