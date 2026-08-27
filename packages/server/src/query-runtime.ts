import type {
  Expression,
  FieldId,
  LiteralValue,
  NodeId,
  QueryDef,
  ReadPolicyDef,
  RelationshipDef,
} from './deps.js';
import { PRINCIPAL } from './deps.js';
import type { ProviderQuery, ProviderRelationship, ProviderSortKey } from './data-provider.js';

/**
 * Turns a registered `QueryDef` plus a verified request into the normalized `ProviderQuery`
 * a `DataProvider` executes. Everything policy- and principal-dependent is resolved here,
 * on the authority:
 *
 * - the **effective filter** is `requestedFilter AND readPolicy.predicate`, with the
 *   policy's own row scope rebound to the query's row scope (spec 0.10 §47);
 * - canonical **identity is appended** as the final sort key so pagination is deterministic
 *   (spec §11);
 * - the **principal record** is bound from the authenticated context, never from arguments
 *   (spec §56).
 *
 * A client cannot remove any of it: the raw `QueryDef` never crosses the boundary.
 */

/** Rewrites every `ref(from)` in an expression tree to `ref(to)`. Other nodes pass through. */
export function rebindRef(expression: Expression, from: NodeId, to: NodeId): Expression {
  const recurse = (node: Expression): Expression => rebindRef(node, from, to);
  switch (expression.kind) {
    case 'literal':
      return expression;
    case 'ref':
      return expression.targetId === from ? { ...expression, targetId: to } : expression;
    case 'field':
      return { ...expression, source: recurse(expression.source) };
    case 'object':
      return {
        ...expression,
        entries: expression.entries.map((entry) => ({ ...entry, value: recurse(entry.value) })),
      };
    case 'binary':
      return { ...expression, left: recurse(expression.left), right: recurse(expression.right) };
    case 'unary':
      return { ...expression, operand: recurse(expression.operand) };
    case 'call':
      return { ...expression, arguments: expression.arguments.map(recurse) };
    case 'filter':
    case 'find':
    case 'every':
    case 'some':
      return { ...expression, source: recurse(expression.source), predicate: recurse(expression.predicate) };
    case 'map':
      return { ...expression, source: recurse(expression.source), projection: recurse(expression.projection) };
    case 'sort':
    case 'group':
      return { ...expression, source: recurse(expression.source), by: recurse(expression.by) };
    case 'flatten':
      return { ...expression, source: recurse(expression.source) };
    case 'conditional':
      return {
        ...expression,
        condition: recurse(expression.condition),
        whenTrue: recurse(expression.whenTrue),
        whenFalse: recurse(expression.whenFalse),
      };
    case 'expression-ref':
      return {
        ...expression,
        arguments: Object.fromEntries(
          Object.entries(expression.arguments ?? {}).map(([key, value]) => [key, recurse(value)]),
        ),
      };
    default:
      return expression;
  }
}

function and(left: Expression, right: Expression): Expression {
  return { kind: 'binary', operator: 'and', left, right };
}

function fieldRef(scopeId: NodeId, fieldId: FieldId): Expression {
  return { kind: 'field', source: { kind: 'ref', targetId: scopeId }, fieldId };
}

/**
 * The read policy governing a query's source, if one is declared — either named explicitly
 * on the `QueryDef` or the single policy over its `source` entity.
 */
export function policyForQuery(
  query: QueryDef,
  policies: readonly ReadPolicyDef[],
): ReadPolicyDef | undefined {
  if (query.readPolicyId) {
    return policies.find((policy) => policy.id === query.readPolicyId);
  }
  return policies.find((policy) => policy.entityId === query.source);
}

/** `requestedFilter AND policy.predicate` with the policy row scope rebound. */
export function effectiveFilter(
  query: QueryDef,
  policy: ReadPolicyDef | undefined,
): Expression | undefined {
  if (!policy) {
    return query.filter;
  }
  const policyPredicate = rebindRef(policy.predicate, policy.rowScopeId, query.rowScopeId);
  return query.filter ? and(query.filter, policyPredicate) : policyPredicate;
}

export interface BuildProviderQueryInput {
  query: QueryDef;
  policy: ReadPolicyDef | undefined;
  relationships: readonly RelationshipDef[];
  sourceIdentityFieldId?: FieldId;
  arguments: Record<string, LiteralValue>;
  principal: Record<string, LiteralValue> | null;
  pageSize: number;
  strategy: 'cursor' | 'offset';
  after?: ProviderQuery['after'];
  offset?: number;
}

export function buildProviderQuery(input: BuildProviderQueryInput): ProviderQuery {
  const { query } = input;
  const filter = effectiveFilter(query, input.policy);

  const sort: ProviderSortKey[] = (query.sort ?? []).map((key) => {
    const direction = key.direction ?? 'asc';
    return {
      key: key.key,
      direction,
      nulls: key.nulls ?? (direction === 'asc' ? 'last' : 'first'),
      label: describeSortKey(key.key, direction),
    };
  });
  // The canonical identity tie-breaker — always ascending — so pagination is a total order
  // (spec §11). Only added when the source has an identity field and we are paging by cursor.
  if (input.strategy === 'cursor' && input.sourceIdentityFieldId) {
    sort.push({
      key: fieldRef(query.rowScopeId, input.sourceIdentityFieldId),
      direction: 'asc',
      nulls: 'last',
      label: `${String(input.sourceIdentityFieldId)} ASC`,
    });
  }

  const relationships: ProviderRelationship[] = (query.relationships ?? []).flatMap((use) => {
    const relationship = input.relationships.find((candidate) => candidate.id === use.relationshipId);
    return relationship ? [{ use, relationship }] : [];
  });

  return {
    queryId: query.id,
    source: query.source,
    rowScopeId: query.rowScopeId,
    ...(filter ? { filter } : {}),
    sort,
    ...(input.sourceIdentityFieldId ? { identityFieldId: input.sourceIdentityFieldId } : {}),
    ...(query.projection ? { projection: query.projection } : {}),
    relationships,
    groupBy: query.groupBy ?? [],
    aggregate: query.aggregate ?? [],
    arguments: input.arguments,
    principal: input.principal,
    pageSize: input.pageSize,
    strategy: input.strategy,
    ...(input.after ? { after: input.after } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  };
}

function describeSortKey(key: Expression, direction: 'asc' | 'desc'): string {
  const name =
    key.kind === 'field' ? String(key.fieldId) : key.kind === 'ref' ? String(key.targetId) : key.kind;
  return `${name} ${direction.toUpperCase()}`;
}

export { PRINCIPAL };
