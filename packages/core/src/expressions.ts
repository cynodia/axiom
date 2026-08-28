import type { FieldId, NodeId } from './ids.js';
import { GROUP_ITEMS_FIELD, GROUP_KEY_FIELD, isGroupFieldId } from './group.js';
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
  | SortExpression
  | EveryExpression
  | SomeExpression
  | FlattenExpression
  | ConditionalExpression
  | GroupExpression
  | ExpressionRefExpression;

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
  'every',
  'some',
  'flatten',
  'conditional',
  'group',
  'expression-ref',
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
  | 'non-empty'
  | 'length'
  | 'contains'
  | 'concat'
  | 'coalesce'
  | 'one-of'
  | 'count'
  | 'sum'
  | 'lowercase'
  | 'to-string'
  | 'trim'
  | 'substring-before'
  | 'substring-after'
  | 'now'
  | 'uuid';

export const BUILTIN_FUNCTIONS: readonly BuiltinFunction[] = [
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
  'trim',
  'substring-before',
  'substring-after',
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

/** True when every member satisfies the predicate. An empty collection satisfies it. */
export interface EveryExpression {
  kind: 'every';
  source: Expression;
  scopeId: NodeId;
  predicate: Expression;
}

/** True when at least one member satisfies the predicate. An empty collection does not. */
export interface SomeExpression {
  kind: 'some';
  source: Expression;
  scopeId: NodeId;
  predicate: Expression;
}

/** Collapses one level of nesting: Collection<Collection<T>> becomes Collection<T>. */
export interface FlattenExpression {
  kind: 'flatten';
  source: Expression;
}

/**
 * Partitions a collection by a key.
 *
 * `Collection<A>` becomes `Collection<Group<K, A>>`, where the key is `by` evaluated with
 * each member bound to `scopeId` — the same iteration scope every other collection operator
 * introduces. A group is read with `groupKey` and `groupItems`.
 *
 * The **ordering contract** is part of the semantics, not an accident of implementation:
 *
 * - groups appear in the order their key was **first seen** in the source collection;
 * - members within a group keep their source order;
 * - two keys are the same key when they are structurally equal, so a key may be a nested
 *   record and not only a primitive;
 * - an empty collection produces no groups, and a source that is `null` fails the
 *   evaluation like every other collection operator.
 *
 * Nothing is sorted. A caller that wants groups in key order says so with `sort`, which is
 * the operator whose job that is.
 */
export interface GroupExpression {
  kind: 'group';
  source: Expression;
  scopeId: NodeId;
  by: Expression;
}

/**
 * Evaluates a named expression definition — the reuse mechanism (`ExpressionDef`).
 *
 * `arguments` are keyed by the definition's parameter ids and are evaluated in **this**
 * scope; the body is then evaluated in an **isolated** scope that sees the parameters and
 * application state and nothing else. That isolation is the whole point: a definition
 * reused in three places cannot pick up an iteration scope from one of them, and its own
 * internal scope ids can never collide with a caller's.
 */
export interface ExpressionRefExpression {
  kind: 'expression-ref';
  expressionId: NodeId;
  /** Keyed by parameter id. */
  arguments?: Record<string, Expression>;
}

/** Chooses between two values. Both branches are expressions, never callbacks. */
export interface ConditionalExpression {
  kind: 'conditional';
  condition: Expression;
  whenTrue: Expression;
  whenFalse: Expression;
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

/** True when a value exists at all — an empty collection or string still exists. */
export function required(value: Expression): CallExpression {
  return call('required', value);
}

/** True when a collection or string has no members. */
export function isEmpty(value: Expression): CallExpression {
  return call('is-empty', value);
}

export function nonEmpty(value: Expression): CallExpression {
  return call('non-empty', value);
}

/** The first value that exists. Only null and undefined are skipped. */
export function coalesce(...values: Expression[]): CallExpression {
  return call('coalesce', ...values);
}

export function every(source: Expression, scopeId: NodeId, predicate: Expression): EveryExpression {
  return { kind: 'every', source, scopeId, predicate };
}

export function some(source: Expression, scopeId: NodeId, predicate: Expression): SomeExpression {
  return { kind: 'some', source, scopeId, predicate };
}

export function flatten(source: Expression): FlattenExpression {
  return { kind: 'flatten', source };
}

export function group(source: Expression, scopeId: NodeId, by: Expression): GroupExpression {
  return { kind: 'group', source, scopeId, by };
}

/** The key every member of a group shares. */
export function groupKey(source: Expression): FieldExpression {
  return field(source, GROUP_KEY_FIELD);
}

/** The members of a group, in the order they appeared in the source collection. */
export function groupItems(source: Expression): FieldExpression {
  return field(source, GROUP_ITEMS_FIELD);
}

/**
 * References a named expression definition, optionally supplying its parameters.
 *
 * Deliberately not `ref`: `ref` resolves a value in the scope chain, and a definition is not
 * a value in scope. A separate kind means a reader can see that an expression reaches into a
 * definition without resolving anything first.
 */
export function expressionRef(
  expressionId: NodeId,
  args?: Record<string, Expression>,
): ExpressionRefExpression {
  return { kind: 'expression-ref', expressionId, ...(args ? { arguments: args } : {}) };
}

export function conditional(
  condition: Expression,
  whenTrue: Expression,
  whenFalse: Expression,
): ConditionalExpression {
  return { kind: 'conditional', condition, whenTrue, whenFalse };
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
    case 'every':
    case 'some':
      walkExpression(expression.source, visit);
      walkExpression(expression.predicate, visit);
      return;
    case 'flatten':
      walkExpression(expression.source, visit);
      return;
    case 'group':
      walkExpression(expression.source, visit);
      walkExpression(expression.by, visit);
      return;
    case 'expression-ref':
      for (const argument of Object.values(expression.arguments ?? {})) {
        walkExpression(argument, visit);
      }
      return;
    case 'conditional':
      walkExpression(expression.condition, visit);
      walkExpression(expression.whenTrue, visit);
      walkExpression(expression.whenFalse, visit);
      return;
    default:
  }
}

/**
 * Field ids a constructed record assigns. Only the record's own entries count: the
 * expressions that compute those values are reads, not writes.
 */
export function constructedFieldIds(expression: Expression): FieldId[] {
  return expression.kind === 'object' ? expression.entries.map((entry) => entry.fieldId) : [];
}

/** Expression definitions an expression reaches directly, in tree order. */
export function expressionDefsIn(expression: Expression): NodeId[] {
  const found: NodeId[] = [];
  walkExpression(expression, (node) => {
    if (node.kind === 'expression-ref') {
      found.push(node.expressionId);
    }
  });
  return found;
}

/** Field ids an expression reads, including nested sources and constructed records. */
export function expressionFieldIds(expression: Expression): FieldId[] {
  const found: FieldId[] = [];
  walkExpression(expression, (node) => {
    // A group's own positions are not fields of any entity, so nothing may resolve them
    // as one. Reading them is still a read of whatever the group was built from, which is
    // attributed through the group's source.
    if (node.kind === 'field' && !isGroupFieldId(node.fieldId)) {
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
