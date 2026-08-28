import type { Expression, LiteralValue, NodeId } from './deps.js';

/**
 * A pure, synchronous evaluator for the **query expression subset** — the leaves a
 * `QueryDef` clause may contain: a boolean `filter`, a `sort`/`groupBy` key, a projected
 * value. It is deliberately smaller than the full runtime evaluator: a query leaf may not
 * be a `filter`/`map`/`sort`/`group`/`find` pipeline, an `expression-ref`, or a
 * non-deterministic call (`now`, `uuid`). Anything outside the subset throws
 * `UnsupportedQueryExpression`, which a provider turns into an `unsupported` plan entry and
 * the runtime into a `QUERY_CAPABILITY_UNSUPPORTED` rejection — never a silent
 * approximation (spec 0.10 §81, §84).
 *
 * The subset's semantics are frozen here so that the memory provider and any persistent
 * provider agree exactly (spec §78-80):
 *
 * - `eq`/`neq`: a `null` operand never matches; `null == null` is **false**.
 * - `lt`/`lte`/`gt`/`gte`: a `null` operand never matches.
 * - `and`/`or`: `null` is treated as `false`.
 * - strings order by Unicode **code point**, not UTF-16 code unit or locale.
 * - numbers are IEEE-754 binary64.
 */

export class UnsupportedQueryExpression extends Error {
  constructor(public readonly kind: string) {
    super(`Query expressions cannot contain "${kind}"`);
    this.name = 'UnsupportedQueryExpression';
  }
}

export type QueryScope = ReadonlyMap<NodeId, unknown>;

type Primitive = string | number | boolean | null;

/** Orders two present scalars. Callers handle `null` before calling this. */
export function compareScalars(a: Primitive, b: Primitive): number {
  if (typeof a === 'string' && typeof b === 'string') {
    return compareCodePoints(a, b);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) {
      return Number.isNaN(a) && Number.isNaN(b) ? 0 : Number.isNaN(a) ? 1 : -1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  // Mixed types: order by a stable type rank so a sort never throws.
  return typeRank(a) - typeRank(b);
}

function typeRank(value: Primitive): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  return 3;
}

function compareCodePoints(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i += 1) {
    const pa = ca[i].codePointAt(0) ?? 0;
    const pb = cb[i].codePointAt(0) ?? 0;
    if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return ca.length === cb.length ? 0 : ca.length < cb.length ? -1 : 1;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== typeof b) {
    return false;
  }
  if (typeof a !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => structurallyEqual(item, b[index]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const key of keys) {
    if (!structurallyEqual(ao[key], bo[key])) {
      return false;
    }
  }
  return true;
}

const SUPPORTED_CALLS = new Set([
  'contains',
  'lowercase',
  'to-string',
  'trim',
  'substring-before',
  'substring-after',
  'coalesce',
  'is-empty',
  'non-empty',
  'required',
  'length',
  'concat',
  'one-of',
]);

export function evaluateQueryExpression(expression: Expression, scope: QueryScope): unknown {
  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'ref': {
      if (!scope.has(expression.targetId)) {
        return null;
      }
      return scope.get(expression.targetId);
    }
    case 'field': {
      const source = evaluateQueryExpression(expression.source, scope);
      if (source === null || source === undefined || typeof source !== 'object') {
        return null;
      }
      const value = (source as Record<string, unknown>)[expression.fieldId as unknown as string];
      return value === undefined ? null : value;
    }
    case 'object': {
      const record: Record<string, unknown> = {};
      for (const entry of expression.entries) {
        record[entry.fieldId as unknown as string] = evaluateQueryExpression(entry.value, scope);
      }
      return record;
    }
    case 'unary': {
      const operand = evaluateQueryExpression(expression.operand, scope);
      if (expression.operator === 'not') {
        return !truthy(operand);
      }
      return typeof operand === 'number' ? -operand : null;
    }
    case 'binary':
      return evaluateBinary(expression.operator, expression.left, expression.right, scope);
    case 'conditional':
      return truthy(evaluateQueryExpression(expression.condition, scope))
        ? evaluateQueryExpression(expression.whenTrue, scope)
        : evaluateQueryExpression(expression.whenFalse, scope);
    case 'call': {
      if (!SUPPORTED_CALLS.has(expression.function)) {
        throw new UnsupportedQueryExpression(`call:${expression.function}`);
      }
      return evaluateCall(expression.function, expression.arguments.map((arg) => evaluateQueryExpression(arg, scope)));
    }
    default:
      throw new UnsupportedQueryExpression(expression.kind);
  }
}

function evaluateBinary(
  operator: string,
  leftExpr: Expression,
  rightExpr: Expression,
  scope: QueryScope,
): unknown {
  const left = evaluateQueryExpression(leftExpr, scope) as Primitive;
  const right = evaluateQueryExpression(rightExpr, scope) as Primitive;
  switch (operator) {
    case 'eq':
      return left !== null && right !== null && structurallyEqual(left, right);
    case 'neq':
      return !(left !== null && right !== null && structurallyEqual(left, right));
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (left === null || right === null) {
        return false;
      }
      const order = compareScalars(left, right);
      if (operator === 'lt') return order < 0;
      if (operator === 'lte') return order <= 0;
      if (operator === 'gt') return order > 0;
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
      throw new UnsupportedQueryExpression(`binary:${operator}`);
  }
}

function evaluateCall(fn: string, args: unknown[]): unknown {
  switch (fn) {
    case 'contains': {
      const [haystack, needle] = args;
      if (typeof haystack === 'string') {
        return haystack.includes(String(needle));
      }
      if (Array.isArray(haystack)) {
        return haystack.some((item) => structurallyEqual(item, needle));
      }
      return false;
    }
    case 'lowercase':
      return typeof args[0] === 'string' ? args[0].toLowerCase() : args[0];
    case 'to-string':
      return args[0] === null || args[0] === undefined ? '' : String(args[0]);
    case 'trim':
      return (args[0] === null || args[0] === undefined ? '' : String(args[0])).trim();
    case 'substring-before': {
      const text = args[0] === null || args[0] === undefined ? '' : String(args[0]);
      const separator = args[1] === null || args[1] === undefined ? '' : String(args[1]);
      const index = separator === '' ? -1 : text.indexOf(separator);
      return index < 0 ? text : text.slice(0, index);
    }
    case 'substring-after': {
      const text = args[0] === null || args[0] === undefined ? '' : String(args[0]);
      const separator = args[1] === null || args[1] === undefined ? '' : String(args[1]);
      const index = separator === '' ? -1 : text.indexOf(separator);
      return index < 0 ? '' : text.slice(index + separator.length);
    }
    case 'coalesce':
      return args.find((value) => value !== null && value !== undefined) ?? null;
    case 'is-empty':
      return isEmpty(args[0]);
    case 'non-empty':
      return !isEmpty(args[0]);
    case 'required':
      return args[0] !== null && args[0] !== undefined;
    case 'length':
      if (typeof args[0] === 'string' || Array.isArray(args[0])) {
        return (args[0] as string | unknown[]).length;
      }
      return 0;
    case 'concat':
      return args.map((value) => (value === null || value === undefined ? '' : String(value))).join('');
    case 'one-of':
      return args.slice(1).some((value) => structurallyEqual(value, args[0]));
    default:
      throw new UnsupportedQueryExpression(`call:${fn}`);
  }
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    return (value as string | unknown[]).length === 0;
  }
  return false;
}

/** Public: order two projected sort-key values honouring a nulls policy. */
export function compareSortValues(
  a: LiteralValue,
  b: LiteralValue,
  direction: 'asc' | 'desc',
  nulls: 'first' | 'last',
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) {
    if (aNull && bNull) {
      return 0;
    }
    const nullFirst = nulls === 'first' ? -1 : 1;
    return aNull ? nullFirst : -nullFirst;
  }
  const order = compareScalars(a as Primitive, b as Primitive);
  return direction === 'desc' ? -order : order;
}
