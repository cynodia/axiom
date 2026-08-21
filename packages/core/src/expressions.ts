import type { FieldId, NodeId } from './ids.js';
import type { LiteralValue } from './nodes.js';

/**
 * Expressions are structured trees, never source strings. Every value reference is an
 * identifier: `ref` resolves an id against the evaluation scope chain (route parameters,
 * action parameters, iteration scopes, then state), and `field` reads a field by id.
 */
export type Expression =
  | LiteralExpression
  | RefExpression
  | FieldExpression
  | ObjectExpression
  | BinaryExpression
  | UnaryExpression
  | CallExpression
  | FilterExpression
  | FindExpression
  | MapExpression
  | SortExpression;

export type ExpressionKind = Expression['kind'];

/** Every expression kind the runtime is required to evaluate. */
export const EXPRESSION_KINDS: readonly ExpressionKind[] = [
  'literal',
  'ref',
  'field',
  'object',
  'binary',
  'unary',
  'call',
  'filter',
  'find',
  'map',
  'sort',
];

export type LiteralPrimitive = string | number | boolean | null;

/** Literal data. Structured values are allowed; executable text is not. */
export interface LiteralExpression {
  kind: 'literal';
  value: LiteralValue;
}

/**
 * Resolves an identifier in the current scope chain. The target may be a state node, a
 * route parameter, an action parameter, an entity under validation, or an iteration
 * scope (a `repeat` node, or a `filter`/`find` expression's `scopeId`).
 */
export interface RefExpression {
  kind: 'ref';
  targetId: NodeId;
}

export interface FieldExpression {
  kind: 'field';
  source: Expression;
  fieldId: FieldId;
}

/** Constructs a record keyed by field id — used to build new instances. */
export interface ObjectExpression {
  kind: 'object';
  entityId?: NodeId;
  entries: ObjectEntry[];
}

export interface ObjectEntry {
  fieldId: FieldId;
  value: Expression;
}

export type BinaryOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'and'
  | 'or'
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide';

export interface BinaryExpression {
  kind: 'binary';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export type UnaryOperator = 'not' | 'negate';

export interface UnaryExpression {
  kind: 'unary';
  operator: UnaryOperator;
  operand: Expression;
}

/**
 * The built-in function vocabulary. Deliberately small and domain-neutral. Every entry
 * must be implemented by the runtime: a function that is declared here but unevaluated
 * would be a construct that typechecks, validates and then does nothing.
 */
export type BuiltinFunction =
  | 'required'
  | 'is-empty'
  | 'length'
  | 'contains'
  | 'concat'
  | 'coalesce'
  | 'one-of'
  | 'count'
  | 'sum'
  | 'lowercase'
  | 'to-string'
  | 'now'
  | 'uuid';

export const BUILTIN_FUNCTIONS: readonly BuiltinFunction[] = [
  'required',
  'is-empty',
  'length',
  'contains',
  'concat',
  'coalesce',
  'one-of',
  'count',
  'sum',
  'lowercase',
  'to-string',
  'now',
  'uuid',
];

/** Functions that reduce a collection of numbers to a number. */
export const AGGREGATE_FUNCTIONS: readonly BuiltinFunction[] = ['sum'];

export interface CallExpression {
  kind: 'call';
  function: BuiltinFunction;
  arguments: Expression[];
}

/** Filters a collection. `predicate` is evaluated with the current item bound to `scopeId`. */
export interface FilterExpression {
  kind: 'filter';
  source: Expression;
  scopeId: NodeId;
  predicate: Expression;
}

/** Returns the first matching item, or null. */
export interface FindExpression {
  kind: 'find';
  source: Expression;
  scopeId: NodeId;
  predicate: Expression;
}

/**
 * Projects every member of a collection. `scopeId` introduces an iteration scope, so the
 * projection refers to the current member as `ref(scopeId)` — the same way a `repeat`
 * node's template refers to its item. Collection<A> projected by A → B is Collection<B>.
 */
export interface MapExpression {
  kind: 'map';
  source: Expression;
  scopeId: NodeId;
  projection: Expression;
}

/** Orders a collection by a projected key. Deterministic for strings and numbers. */
export interface SortExpression {
  kind: 'sort';
  source: Expression;
  scopeId: NodeId;
  by: Expression;
  direction?: 'asc' | 'desc';
}

export function literal(value: LiteralValue): LiteralExpression {
  return { kind: 'literal', value };
}

export function ref(targetId: NodeId): RefExpression {
  return { kind: 'ref', targetId };
}

export function field(source: Expression, id: FieldId): FieldExpression {
  return { kind: 'field', source, fieldId: id };
}

export function binary(operator: BinaryOperator, left: Expression, right: Expression): BinaryExpression {
  return { kind: 'binary', operator, left, right };
}

export function unary(operator: UnaryOperator, operand: Expression): UnaryExpression {
  return { kind: 'unary', operator, operand };
}

export function call(fn: BuiltinFunction, ...args: Expression[]): CallExpression {
  return { kind: 'call', function: fn, arguments: args };
}

export function object(entries: ObjectEntry[], entityId?: NodeId): ObjectExpression {
  return { kind: 'object', ...(entityId ? { entityId } : {}), entries };
}

export function filter(source: Expression, scopeId: NodeId, predicate: Expression): FilterExpression {
  return { kind: 'filter', source, scopeId, predicate };
}

export function find(source: Expression, scopeId: NodeId, predicate: Expression): FindExpression {
  return { kind: 'find', source, scopeId, predicate };
}

export function map(source: Expression, scopeId: NodeId, projection: Expression): MapExpression {
  return { kind: 'map', source, scopeId, projection };
}

export function sort(
  source: Expression,
  scopeId: NodeId,
  by: Expression,
  direction: 'asc' | 'desc' = 'asc',
): SortExpression {
  return { kind: 'sort', source, scopeId, by, direction };
}

/** Sums a collection of numbers. An empty collection sums to zero. */
export function sum(source: Expression): CallExpression {
  return call('sum', source);
}

export function count(source: Expression): CallExpression {
  return call('count', source);
}

/** Visits every sub-expression, parents before children. */
export function walkExpression(expression: Expression, visit: (node: Expression) => void): void {
  visit(expression);
  switch (expression.kind) {
    case 'field':
      walkExpression(expression.source, visit);
      return;
    case 'object':
      for (const entry of expression.entries) {
        walkExpression(entry.value, visit);
      }
      return;
    case 'binary':
      walkExpression(expression.left, visit);
      walkExpression(expression.right, visit);
      return;
    case 'unary':
      walkExpression(expression.operand, visit);
      return;
    case 'call':
      for (const argument of expression.arguments) {
        walkExpression(argument, visit);
      }
      return;
    case 'filter':
    case 'find':
      walkExpression(expression.source, visit);
      walkExpression(expression.predicate, visit);
      return;
    case 'map':
      walkExpression(expression.source, visit);
      walkExpression(expression.projection, visit);
      return;
    case 'sort':
      walkExpression(expression.source, visit);
      walkExpression(expression.by, visit);
      return;
    default:
  }
}

/** Field ids an expression reads, including nested sources and constructed records. */
export function expressionFieldIds(expression: Expression): FieldId[] {
  const found: FieldId[] = [];
  walkExpression(expression, (node) => {
    if (node.kind === 'field') {
      found.push(node.fieldId);
    }
    if (node.kind === 'object') {
      for (const entry of node.entries) {
        found.push(entry.fieldId);
      }
    }
  });
  return found;
}
