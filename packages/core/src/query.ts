import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type { NodeBase } from './nodes.js';
import type { TypeRef } from './type-ref.js';

/**
 * A **demand-driven read over authoritative application data**.
 *
 * `StateDef` is bounded, materialized semantic state. `QueryDef` is what an application
 * reaches for when the canonical data is too large to materialize — 500,000 orders, years
 * of audit rows — and the answer must be computed *by the persistence layer* and returned a
 * page at a time. The graph owns the meaning; a `DataProvider` owns execution (spec 0.10
 * §2, §38).
 *
 * It is deliberately **not** an `IntegrationDef`. An integration observes an *external*
 * system; a query reads the application's *own* canonical database, which is inside the
 * Axiom authority boundary. The distinction matters for read authorization, dependency
 * analysis and cache identity, none of which an integration carries.
 *
 * ## Shape
 *
 * A `QueryDef` is one node with a fixed set of named clauses, and **every leaf value in
 * every clause is an ordinary Axiom `Expression`** — there is no second predicate or
 * arithmetic language (spec §8, §17). `filter` is a boolean expression, a `sort` key is a
 * projection expression, a projected field is an expression. The clauses that are present
 * are exactly the provider capabilities the query needs (spec §29): a query with a `filter`
 * needs `filter`, one with `relationships` needs `relationship`, and a provider that lacks a
 * required capability rejects the query before executing it rather than approximating it
 * (spec §9, §81, §84).
 *
 * ```ts
 * graph.addNode<QueryDef>({
 *   id: QUERY_RECENT_ORDERS,
 *   kind: 'query',
 *   source: ENTITY_ORDER,
 *   rowScopeId: SCOPE_ORDER_ROW,
 *   parameters: [
 *     { id: P_STATUS, valueType: enumType(['pending', 'confirmed', 'cancelled']) },
 *     { id: P_SEARCH, valueType: optionalType(primitiveType('string')) },
 *   ],
 *   filter: binary('eq', field(ref(SCOPE_ORDER_ROW), F_ORDER_STATUS), ref(P_STATUS)),
 *   sort: [{ key: field(ref(SCOPE_ORDER_ROW), F_ORDER_CREATED_AT), direction: 'desc' }],
 *   relationships: [{ relationshipId: REL_ORDER_ACCOUNT, bindAs: SCOPE_ORDER_ACCOUNT }],
 *   projection: {
 *     entityId: ENTITY_ORDER_SUMMARY,
 *     fields: [
 *       { id: F_SUMMARY_ID,         value: field(ref(SCOPE_ORDER_ROW), F_ORDER_ID) },
 *       { id: F_SUMMARY_CREATED_AT, value: field(ref(SCOPE_ORDER_ROW), F_ORDER_CREATED_AT) },
 *       { id: F_SUMMARY_ACCOUNT,    value: field(ref(SCOPE_ORDER_ACCOUNT), F_ACCOUNT_NAME) },
 *       { id: F_SUMMARY_TOTAL,      value: field(ref(SCOPE_ORDER_ROW), F_ORDER_TOTAL) },
 *     ],
 *   },
 *   pagination: { strategy: 'cursor', maxPageSize: 100, defaultPageSize: 50 },
 *   readPolicyId: POLICY_ORDER_VISIBILITY,
 * });
 * ```
 *
 * A `QueryDef` survives compilation into the portable Server IR under `axiom.server.v6`.
 */

/** How a sort key orders rows. Defaults to `'asc'`. */
export type QuerySortDirection = 'asc' | 'desc';

export const QUERY_SORT_DIRECTIONS: readonly QuerySortDirection[] = ['asc', 'desc'];

/**
 * Where absent values sort. When a key does not declare one, Axiom's portable default is
 * `'last'` for an ascending key and `'first'` for a descending key — i.e. `null` sorts as
 * greater than every present value, provider-independently (spec §78). A provider emits the
 * ordering explicitly (SQLite `NULLS FIRST`/`NULLS LAST`); it is never left to a database
 * default.
 */
export type QueryNullsOrder = 'first' | 'last';

export const QUERY_NULLS_ORDERS: readonly QueryNullsOrder[] = ['first', 'last'];

/**
 * `'cursor'` is the canonical, consistency-preserving model (spec §12). `'offset'` is an
 * optional provider convenience whose behaviour under concurrent mutation is documented and
 * not normative (spec §14).
 */
export type QueryPaginationStrategy = 'cursor' | 'offset';

export const QUERY_PAGINATION_STRATEGIES: readonly QueryPaginationStrategy[] = ['cursor', 'offset'];

/** The aggregate reductions a provider must be able to compute without materializing rows (spec §23). */
export type QueryAggregateFunction = 'count' | 'sum' | 'min' | 'max' | 'average';

export const QUERY_AGGREGATE_FUNCTIONS: readonly QueryAggregateFunction[] = [
  'count',
  'sum',
  'min',
  'max',
  'average',
];

/** Page size a query allows when it declares no `pagination.maxPageSize` (spec §15). */
export const DEFAULT_QUERY_MAX_PAGE_SIZE = 100;

/** Page size a request gets when it names none and the query declares no `defaultPageSize`. */
export const DEFAULT_QUERY_PAGE_SIZE = 50;

/** A bounded to-many traversal's page size when its use declares none (spec §21). */
export const DEFAULT_RELATIONSHIP_PAGE_SIZE = 25;

/**
 * A typed input to a query. Arguments supplied by a caller are checked against these
 * `TypeRef`s and rejected before the provider executes anything (spec §7, §55).
 */
export interface QueryParameter {
  id: NodeId;
  name?: string;
  valueType: TypeRef;
  /** Absent defaults to `true`. An optional parameter's `valueType` should be `optional`. */
  required?: boolean;
}

/** One ordering key. `key` is an expression over a source row (`ref(rowScopeId)`). */
export interface QuerySortKey {
  key: Expression;
  /** Defaults to `'asc'`. */
  direction?: QuerySortDirection;
  /** Defaults to `'last'` for `asc`, `'first'` for `desc`. */
  nulls?: QueryNullsOrder;
}

/** One field of a projected result row, populated by an expression over the source row and bound relationships. */
export interface QueryProjectionField {
  /** A field of the projection entity. */
  id: FieldId;
  value: Expression;
}

/**
 * The typed shape of a result row.
 *
 * A query need not return complete canonical entities (spec §16). `entityId` names the
 * entity a projected row conforms to — usually a dedicated summary entity — and `fields`
 * populates it. Projected values reuse expression semantics, so a computed
 * `lineTotal = quantity * unitPrice` is a `binary('multiply', …)`, never a re-implemented
 * arithmetic (spec §17). A projection may not expose a field the source entity's read
 * policy forbids (spec §53).
 */
export interface QueryProjection {
  entityId: NodeId;
  fields: QueryProjectionField[];
}

/**
 * A relationship this query traverses.
 *
 * `relationshipId` names a `RelationshipDef`. `bindAs` introduces a scope the projected
 * fields and the filter can read: for a `to-one` relationship it binds the single related
 * row; for a `to-many` relationship it binds a bounded `QueryPage` of related rows, capped
 * by `maxPageSize` (spec §20-21). Traversal never implies unbounded materialization, and
 * the reference provider resolves a page of N source rows plus a to-one relationship in a
 * bounded number of provider calls — never N+1 (spec §22).
 */
export interface QueryRelationshipUse {
  relationshipId: NodeId;
  bindAs: NodeId;
  /** For a `to-many` traversal: the page bound. Defaults to `DEFAULT_RELATIONSHIP_PAGE_SIZE`. Ignored for to-one. */
  maxPageSize?: number;
}

/**
 * One aggregate reduction over the (post-read-policy) row set.
 *
 * `count` needs no `key`; every other function reduces the numeric projection `key`. `as`
 * is the result field the scalar lands in. With `groupBy` present, one such scalar is
 * produced per group.
 */
export interface QueryAggregate {
  function: QueryAggregateFunction;
  key?: Expression;
  as: FieldId;
}

export interface QueryPagination {
  strategy: QueryPaginationStrategy;
  /** Authority-enforced ceiling. A request above it is rejected, never truncated silently (spec §15). */
  maxPageSize?: number;
  /** Applied when a request names no page size. */
  defaultPageSize?: number;
}

/**
 * A registered, reusable query. Invoked by id with typed arguments, never as a submitted
 * query AST (spec §6).
 */
export interface QueryDef extends NodeBase {
  kind: 'query';
  parameters?: QueryParameter[];
  /** The authoritative row type: an `EntityDef` id. */
  source: NodeId;
  /**
   * Binds one source row for every expression in this query — `filter`, every `sort` key,
   * every projected field, `groupBy` and every `aggregate` key. Must not shadow an
   * enclosing scope or take a graph node's id.
   */
  rowScopeId: NodeId;
  /**
   * Boolean predicate. In scope: the source row (`ref(rowScopeId)`), the query parameters
   * (`ref(<param id>)`), `PRINCIPAL`, and any relationship binds. Absent means "every row".
   *
   * The effective filter a provider receives is `filter AND readPolicy.predicate` — the
   * policy conjunct is added on the authority and cannot be removed by a client (spec §47).
   */
  filter?: Expression;
  /**
   * Ordering keys, most significant first. Canonical identity is appended as a final
   * tie-breaker so pagination is deterministic (spec §11); a query whose source entity has
   * no `identityFieldId` and whose keys are not provably unique is rejected as unstable.
   */
  sort?: QuerySortKey[];
  relationships?: QueryRelationshipUse[];
  projection?: QueryProjection;
  /**
   * Group keys — expressions over the source row. Groups are produced in first-seen key
   * order, matching the `group` expression's contract; this ordering is semantic and must
   * not become database-dependent (spec §24). Present only with `aggregate`.
   */
  groupBy?: Expression[];
  aggregate?: QueryAggregate[];
  /** Absent defaults to `{ strategy: 'cursor', maxPageSize: DEFAULT_QUERY_MAX_PAGE_SIZE }`. */
  pagination?: QueryPagination;
  /** The `ReadPolicyDef` whose predicate is AND-ed into `filter` before execution. */
  readPolicyId?: NodeId;
}

export function queryPaginationStrategy(query: QueryDef): QueryPaginationStrategy {
  return query.pagination?.strategy ?? 'cursor';
}

export function queryMaxPageSize(query: QueryDef): number {
  return query.pagination?.maxPageSize ?? DEFAULT_QUERY_MAX_PAGE_SIZE;
}

export function queryDefaultPageSize(query: QueryDef): number {
  return Math.min(query.pagination?.defaultPageSize ?? DEFAULT_QUERY_PAGE_SIZE, queryMaxPageSize(query));
}

export function sortKeyDirection(key: QuerySortKey): QuerySortDirection {
  return key.direction ?? 'asc';
}

export function sortKeyNulls(key: QuerySortKey): QueryNullsOrder {
  return key.nulls ?? (sortKeyDirection(key) === 'asc' ? 'last' : 'first');
}

export function relationshipUsePageSize(use: QueryRelationshipUse): number {
  return use.maxPageSize ?? DEFAULT_RELATIONSHIP_PAGE_SIZE;
}

/** Whether this query reduces its rows to aggregate scalars rather than returning them. */
export function queryIsAggregate(query: QueryDef): boolean {
  return (query.aggregate?.length ?? 0) > 0;
}

/** Whether this query groups before aggregating. */
export function queryIsGrouped(query: QueryDef): boolean {
  return (query.groupBy?.length ?? 0) > 0;
}

/**
 * The entity a non-aggregate result row conforms to: the projection entity when the query
 * projects, otherwise the source entity itself. For an aggregate query the result shape is
 * the aggregate `as` fields (plus any group keys), not an entity.
 */
export function queryRowEntityId(query: QueryDef): NodeId {
  return query.projection?.entityId ?? query.source;
}

/**
 * Every `Expression` leaf a query contains, in no particular order. Used by dependency
 * analysis, by Server IR contract computation and by validation, so a query's read edges
 * are attributed exactly like any other node's.
 */
export function queryExpressions(query: QueryDef): Expression[] {
  const found: Expression[] = [];
  if (query.filter) {
    found.push(query.filter);
  }
  for (const key of query.sort ?? []) {
    found.push(key.key);
  }
  for (const field of query.projection?.fields ?? []) {
    found.push(field.value);
  }
  for (const key of query.groupBy ?? []) {
    found.push(key);
  }
  for (const aggregate of query.aggregate ?? []) {
    if (aggregate.key) {
      found.push(aggregate.key);
    }
  }
  return found;
}

/**
 * An operation that runs a registered query inside an action and binds its result into
 * scope for the operations that follow (spec §40).
 *
 * It is resolved before the action's transaction opens — its result may inform the
 * mutations that follow — and reads Axiom's *own* authoritative data, which is why it is a
 * first-class operation rather than an `integration-query` (spec §102). `bindAs` introduces
 * a scope exactly as a `for-each`'s `scopeId` does; later operations refer to the whole
 * result as `ref(bindAs)`. Never legal inside `for-each`.
 */
export interface QueryOperation {
  kind: 'query';
  queryId: NodeId;
  arguments?: Record<string, Expression>;
  bindAs: NodeId;
}
