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
  | FindExpression;

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

/** The built-in function vocabulary. Deliberately small and domain-neutral. */
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
    default:
  }
}
