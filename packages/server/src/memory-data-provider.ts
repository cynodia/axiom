import type { Expression, FieldId, LiteralValue, NodeId } from './deps.js';
import type {
  AggregateResult,
  DataProvider,
  ProviderMutation,
  ProviderPage,
  ProviderQuery,
  ProviderResult,
  QueryPlan,
} from './data-provider.js';
import { requiredCapabilities } from './data-provider.js';
import {
  UnsupportedQueryExpression,
  compareSortValues,
  evaluateQueryExpression,
} from './query-eval.js';

/**
 * The deterministic in-memory reference provider (spec 0.10 §28).
 *
 * It is framework code, not test scaffolding: the semantics of filtering, multi-key
 * ordering, keyset pagination, projection, relationship traversal and aggregation must be
 * executable without a database, or the portable conformance fixtures could not state them.
 * Every persistent provider is checked to produce **semantically identical** results to
 * this one (spec §90).
 *
 * It is bounded by construction, so it legitimately declares `local-evaluation`. It still
 * never does N+1 traversal: a to-one relationship is resolved by indexing the target table
 * once (spec §22).
 */

type Row = Record<string, LiteralValue>;

export interface MemoryDataProviderOptions {
  /** Rows per entity id, each row keyed by field id. */
  rows: Record<string, Row[]>;
  /** Authority ceiling on a page. Defaults to 100. */
  maxPageSize?: number;
  /** Invoked once per provider round-trip, for the N+1 and bounded-materialization gates. */
  onProviderCall?(kind: 'query' | 'aggregate' | 'relationship' | 'load' | 'mutate', entityId: NodeId): void;
}

export function createMemoryDataProvider(options: MemoryDataProviderOptions): DataProvider {
  const tables = new Map<string, Row[]>();
  for (const [entityId, rows] of Object.entries(options.rows)) {
    tables.set(entityId, rows.map((row) => ({ ...row })));
  }
  const maxPageSize = options.maxPageSize ?? 100;
  const note = options.onProviderCall ?? (() => {});
  // A monotone count of committed mutation batches (spec13.1 F1). In-process only — the
  // memory provider is the single-process reference and says so via `mutationObservation`.
  let mutationGeneration = 0;

  const table = (entityId: NodeId): Row[] => tables.get(entityId as unknown as string) ?? [];

  /** The base scope shared by every row of one query: PRINCIPAL and the resolved arguments. */
  function baseScope(query: ProviderQuery): Map<NodeId, unknown> {
    const scope = new Map<NodeId, unknown>();
    scope.set('axiom_principal' as NodeId, query.principal);
    for (const [id, value] of Object.entries(query.arguments)) {
      scope.set(id as NodeId, value);
    }
    return scope;
  }

  /**
   * Indexes every relationship's target table once, then returns a function that binds the
   * relationship scopes for a given source row with no further table scans.
   */
  function relationshipBinder(query: ProviderQuery): (row: Row, scope: Map<NodeId, unknown>) => void {
    const indexes = query.relationships.map(({ use, relationship }) => {
      const targetRows = table(relationship.to.entityId);
      note('relationship', relationship.to.entityId);
      const byKey = new Map<string, Row[]>();
      for (const targetRow of targetRows) {
        const key = keyOf(targetRow[relationship.to.fieldId as unknown as string]);
        byKey.set(key, [...(byKey.get(key) ?? []), targetRow]);
      }
      return { use, relationship, byKey };
    });
    return (row, scope) => {
      for (const { use, relationship, byKey } of indexes) {
        const linkValue = row[relationship.from.fieldId as unknown as string];
        const matches = byKey.get(keyOf(linkValue)) ?? [];
        if (relationship.cardinality === 'to-one') {
          scope.set(use.bindAs, matches[0] ?? null);
        } else {
          const bound = use.maxPageSize ? matches.slice(0, use.maxPageSize) : matches;
          scope.set(use.bindAs, bound);
        }
      }
    };
  }

  type Bind = (row: Row, scope: Map<NodeId, unknown>) => void;

  function rowScope(query: ProviderQuery, base: Map<NodeId, unknown>, bind: Bind, row: Row): Map<NodeId, unknown> {
    const scope = new Map(base);
    scope.set(query.rowScopeId, row);
    bind(row, scope);
    return scope;
  }

  function matchingRows(query: ProviderQuery, base: Map<NodeId, unknown>, bind: Bind): Row[] {
    const kept: Row[] = [];
    for (const row of table(query.source)) {
      const scope = rowScope(query, base, bind, row);
      if (!query.filter || truthy(evaluateQueryExpression(query.filter, scope))) {
        kept.push(row);
      }
    }
    return kept;
  }

  function sortRows(query: ProviderQuery, base: Map<NodeId, unknown>, bind: Bind, rows: Row[]): Row[] {
    if (query.sort.length === 0) {
      return rows;
    }
    const keyed = rows.map((row) => ({
      row,
      keys: sortValuesOf(query, base, bind, row),
    }));
    keyed.sort((a, b) => {
      for (let i = 0; i < query.sort.length; i += 1) {
        const spec = query.sort[i];
        const order = compareSortValues(a.keys[i], b.keys[i], spec.direction, spec.nulls);
        if (order !== 0) {
          return order;
        }
      }
      return 0;
    });
    return keyed.map((entry) => entry.row);
  }

  function projectRow(query: ProviderQuery, base: Map<NodeId, unknown>, bind: Bind, row: Row): Row {
    if (!query.projection) {
      return { ...row };
    }
    const scope = rowScope(query, base, bind, row);
    const projected: Row = {};
    for (const field of query.projection.fields) {
      projected[field.id as unknown as string] = evaluateQueryExpression(field.value, scope) as LiteralValue;
    }
    return projected;
  }

  function sortValuesOf(query: ProviderQuery, base: Map<NodeId, unknown>, bind: Bind, row: Row): LiteralValue[] {
    const scope = rowScope(query, base, bind, row);
    return query.sort.map((key) => evaluateQueryExpression(key.key, scope) as LiteralValue);
  }

  function afterCursor(query: ProviderQuery, base: Map<NodeId, unknown>, bind: Bind, rows: Row[]): Row[] {
    if (!query.after || !query.identityFieldId) {
      return rows;
    }
    const target = query.after;
    return rows.filter((row) => {
      const values = sortValuesOf(query, base, bind, row);
      for (let i = 0; i < query.sort.length; i += 1) {
        const order = compareSortValues(
          values[i],
          target.sortValues[i],
          query.sort[i].direction,
          query.sort[i].nulls,
        );
        if (order !== 0) {
          return order > 0;
        }
      }
      // Sort keys tie: fall back to the identity tie-breaker (always ascending).
      const idValue = row[(query.identityFieldId as unknown as string)];
      return compareSortValues(idValue as LiteralValue, target.identityValue, 'asc', 'last') > 0;
    });
  }

  return {
    capabilities: {
      supports: [
        'filter',
        'sort',
        'cursor',
        'offset',
        'projection',
        'relationship',
        'aggregate',
        'group',
        'transactional-reads',
        'local-evaluation',
      ],
      maxPageSize,
      mutationObservation: 'in-process',
    },

    async observedMutationGeneration(): Promise<number> {
      return mutationGeneration;
    },

    async query(query: ProviderQuery): Promise<ProviderResult<ProviderPage>> {
      note('query', query.source);
      try {
        const base = baseScope(query);
        const bind = relationshipBinder(query);
        let rows = sortRows(query, base, bind, matchingRows(query, base, bind));
        if (query.strategy === 'offset' && query.offset) {
          rows = rows.slice(query.offset);
        } else {
          rows = afterCursor(query, base, bind, rows);
        }
        const pageSize = Math.min(query.pageSize, maxPageSize);
        const window = rows.slice(0, pageSize + 1);
        const hasMore = window.length > pageSize;
        const items = window.slice(0, pageSize);
        const last = items[items.length - 1];
        const lastPosition =
          last && query.identityFieldId && query.strategy === 'cursor'
            ? {
                sortValues: sortValuesOf(query, base, bind, last),
                identityValue: last[query.identityFieldId as unknown as string] as LiteralValue,
              }
            : undefined;
        return {
          ok: true,
          value: {
            items: items.map((row) => projectRow(query, base, bind, row)),
            hasMore,
            ...(lastPosition ? { lastPosition } : {}),
          },
        };
      } catch (error) {
        return failure(error);
      }
    },

    async aggregate(query: ProviderQuery): Promise<ProviderResult<AggregateResult>> {
      note('aggregate', query.source);
      try {
        const base = baseScope(query);
        const bindRelationships = relationshipBinder(query);
        const rows = matchingRows(query, base, bindRelationships);
        const groups = new Map<string, { key: LiteralValue[]; rows: Row[] }>();
        const order: string[] = [];
        for (const row of rows) {
          const scope = new Map(base);
          scope.set(query.rowScopeId, row);
          bindRelationships(row, scope);
          const key = query.groupBy.map((expr) => evaluateQueryExpression(expr, scope) as LiteralValue);
          const id = keyOf(key);
          if (!groups.has(id)) {
            groups.set(id, { key, rows: [] });
            order.push(id);
          }
          groups.get(id)!.rows.push(row);
        }
        const groupList =
          query.groupBy.length > 0
            ? order.map((id) => groups.get(id)!)
            : [{ key: [], rows }];
        const resultRows = groupList.map((group) => ({
          ...(query.groupBy.length > 0 ? { key: group.key } : {}),
          values: reduceAggregates(query, group.rows, base, bindRelationships),
        }));
        return { ok: true, value: { rows: resultRows } };
      } catch (error) {
        return failure(error);
      }
    },

    async loadByIdentity(
      entityId: NodeId,
      identityFieldId: FieldId,
      values: readonly LiteralValue[],
    ): Promise<ProviderResult<Row[]>> {
      note('load', entityId);
      const wanted = new Set(values.map((value) => keyOf(value)));
      const found = table(entityId).filter((row) =>
        wanted.has(keyOf(row[identityFieldId as unknown as string])),
      );
      return { ok: true, value: found.map((row) => ({ ...row })) };
    },

    async applyMutations(mutations: readonly ProviderMutation[]): Promise<ProviderResult<null>> {
      // Applied atomically: validate every mutation resolves before touching anything.
      const planned: Array<{ rows: Row[]; index: number; mutation: ProviderMutation }> = [];
      for (const mutation of mutations) {
        const rows = table(mutation.entityId);
        const index = rows.findIndex(
          (row) => keyOf(row[mutation.identityFieldId as unknown as string]) === keyOf(mutation.identityValue),
        );
        if (index === -1 && mutation.kind === 'set' && !mutation.row) {
          return { ok: false, code: 'QUERY_PROVIDER_FAILURE', message: `No ${mutation.entityId} row ${String(mutation.identityValue)}`, retryable: false };
        }
        planned.push({ rows, index, mutation });
      }
      for (const { rows, index, mutation } of planned) {
        note('mutate', mutation.entityId);
        if (mutation.kind === 'remove') {
          if (index !== -1) {
            rows.splice(index, 1);
          }
        } else if (index === -1) {
          rows.push({ ...(mutation.row ?? {}) });
        } else {
          rows[index] = { ...rows[index], ...(mutation.row ?? {}) };
        }
      }
      // One committed batch → one generation advance (spec13.1 §134): a remote authority
      // only needs to learn that meaning *may* have changed, not per-row.
      mutationGeneration += 1;
      return { ok: true, value: null };
    },

    explain(query: ProviderQuery): QueryPlan {
      const needed = requiredCapabilities({
        filter: query.filter,
        sort: query.sort,
        projection: query.projection,
        relationships: query.relationships,
        aggregate: query.aggregate,
        groupBy: query.groupBy,
        strategy: query.strategy,
      });
      void needed;
      const unsupported: string[] = [];
      for (const expression of queryLeafExpressions(query)) {
        try {
          evaluateQueryExpression(expression, new Map());
        } catch (error) {
          if (error instanceof UnsupportedQueryExpression) {
            unsupported.push(error.kind);
          }
        }
      }
      return {
        queryId: query.queryId,
        source: query.source,
        pushedFilter: Boolean(query.filter),
        pushedSort: query.sort.map((key) => key.label),
        pagination: { strategy: query.strategy, pageSize: Math.min(query.pageSize, maxPageSize) },
        projection: (query.projection?.fields ?? []).map((field) => String(field.id)),
        relationships: query.relationships.map(
          (use) => `${String(use.relationship.id)} (${use.relationship.cardinality}, batched)`,
        ),
        aggregates: query.aggregate.map((aggregate) =>
          aggregate.function === 'count' ? 'count' : `${aggregate.function}(…) as ${String(aggregate.as)}`,
        ),
        unsupported,
      };
    },
  };
}

function reduceAggregates(
  query: ProviderQuery,
  rows: Row[],
  base: Map<NodeId, unknown>,
  bindRelationships: (row: Row, scope: Map<NodeId, unknown>) => void,
): Record<string, LiteralValue> {
  const values: Record<string, LiteralValue> = {};
  for (const aggregate of query.aggregate) {
    if (aggregate.function === 'count') {
      values[aggregate.as as unknown as string] = rows.length;
      continue;
    }
    const numbers: number[] = [];
    for (const row of rows) {
      const scope = new Map(base);
      scope.set(query.rowScopeId, row);
      bindRelationships(row, scope);
      const value = evaluateQueryExpression(aggregate.key as Expression, scope);
      if (value !== null && value !== undefined) {
        numbers.push(Number(value));
      }
    }
    values[aggregate.as as unknown as string] = summarize(aggregate.function, numbers);
  }
  return values;
}

function summarize(fn: string, numbers: number[]): LiteralValue {
  if (fn === 'sum') {
    return numbers.reduce((total, value) => total + value, 0);
  }
  if (numbers.length === 0) {
    return null;
  }
  if (fn === 'min') {
    return numbers.reduce((best, value) => (value < best ? value : best));
  }
  if (fn === 'max') {
    return numbers.reduce((best, value) => (value > best ? value : best));
  }
  if (fn === 'average') {
    return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  }
  return null;
}

function queryLeafExpressions(query: ProviderQuery): Expression[] {
  const found: Expression[] = [];
  if (query.filter) {
    found.push(query.filter);
  }
  for (const key of query.sort) {
    found.push(key.key);
  }
  for (const field of query.projection?.fields ?? []) {
    found.push(field.value);
  }
  for (const key of query.groupBy) {
    found.push(key);
  }
  for (const aggregate of query.aggregate) {
    if (aggregate.key) {
      found.push(aggregate.key);
    }
  }
  return found;
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

function keyOf(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function failure(error: unknown): ProviderResult<never> {
  if (error instanceof UnsupportedQueryExpression) {
    return { ok: false, code: 'QUERY_CAPABILITY_UNSUPPORTED', message: error.message, retryable: false };
  }
  return {
    ok: false,
    code: 'QUERY_PROVIDER_FAILURE',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
