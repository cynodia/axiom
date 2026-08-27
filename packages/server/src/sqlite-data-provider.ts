import type { EntityDef, Expression, FieldId, LiteralValue, NodeId, RelationshipDef } from './deps.js';
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
import { translateExpression } from './sql-query.js';
import type { SqlContext, SqlFragment } from './sql-query.js';

/**
 * The persistent reference `DataProvider` (spec 0.10 §28), on Node's built-in `node:sqlite`.
 *
 * It projects the semantic model relationally — one table per entity, one column per field
 * — and executes every query as parametrized SQL. Filtering, ordering, keyset pagination,
 * to-one relationship joins and aggregation are **pushed down**; the only work done in the
 * runtime is applying projection expressions over the already-bounded page (spec §17), so a
 * page of 50 rows is one `SELECT`, never 51 (spec §22). A semantic it cannot translate is
 * reported `unsupported` and the query is rejected — there is no in-memory fallback
 * (spec §9, §32, §81). It must produce results **semantically identical** to
 * `createMemoryDataProvider` (spec §90); `provider-parity.test.ts` checks that.
 */

interface SqliteStatement {
  run(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): Array<Record<string, unknown>>;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteDataProviderOptions {
  /** `':memory:'` or a file path. */
  location: string;
  entities: EntityDef[];
  relationships?: RelationshipDef[];
  /** Rows per entity id, each keyed by field id. */
  seed?: Record<string, Record<string, LiteralValue>[]>;
  maxPageSize?: number;
}

export async function isSqliteAvailable(): Promise<boolean> {
  try {
    const module = (await import('node:sqlite')) as { DatabaseSync?: unknown };
    return typeof module.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

function tableName(entityId: NodeId): string {
  return `t_${String(entityId).replace(/[^A-Za-z0-9_]/g, '_')}`;
}
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
function bind(value: LiteralValue): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

export async function createSqliteDataProvider(
  options: SqliteDataProviderOptions,
): Promise<DataProvider> {
  const module = (await import('node:sqlite')) as {
    DatabaseSync: new (location: string) => SqliteDatabase;
  };
  const db = new module.DatabaseSync(options.location);
  const maxPageSize = options.maxPageSize ?? 100;

  const entitiesById = new Map(options.entities.map((entity) => [entity.id, entity]));
  const columnsOf = (entityId: NodeId): FieldId[] =>
    (entitiesById.get(entityId)?.fields ?? []).map((field) => field.id);

  for (const entity of options.entities) {
    const columns = entity.fields.map((field) => `${quote(String(field.id))} `);
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${tableName(entity.id)} (${columns.join(', ')}, _seq INTEGER);`,
    );
  }
  for (const [entityId, rows] of Object.entries(options.seed ?? {})) {
    const columns = columnsOf(entityId as NodeId);
    const insert = db.prepare(
      `INSERT INTO ${tableName(entityId as NodeId)} (${columns
        .map((column) => quote(String(column)))
        .join(', ')}, _seq) VALUES (${columns.map(() => '?').join(', ')}, ?)`,
    );
    rows.forEach((row, index) => {
      insert.run(...columns.map((column) => bind(row[column as unknown as string] ?? null)), index);
    });
  }

  const relationshipsById = new Map(
    (options.relationships ?? []).map((relationship) => [relationship.id, relationship]),
  );

  function rowToRecord(entityId: NodeId, raw: Record<string, unknown>, prefix = ''): Record<string, LiteralValue> {
    const record: Record<string, LiteralValue> = {};
    for (const column of columnsOf(entityId)) {
      record[column as unknown as string] = raw[`${prefix}${String(column)}`] as LiteralValue;
    }
    return record;
  }

  function buildContext(query: ProviderQuery): {
    context: SqlContext;
    joins: string;
    relationScopes: (raw: Record<string, unknown>) => Map<NodeId, unknown>;
  } {
    const relationTables = new Map<NodeId, string>();
    const joinClauses: string[] = [];
    const relationReaders: Array<{ bindAs: NodeId; entityId: NodeId; prefix: string }> = [];
    query.relationships.forEach((use, index) => {
      const relationship = relationshipsById.get(use.relationship.id) ?? use.relationship;
      if (relationship.cardinality !== 'to-one') {
        throw new UnsupportedQueryExpression('relationship:to-many');
      }
      const alias = `r${index}`;
      relationTables.set(use.use.bindAs, quote(alias));
      joinClauses.push(
        `LEFT JOIN ${tableName(relationship.to.entityId)} AS ${quote(alias)} ON ${quote(alias)}.${quote(
          String(relationship.to.fieldId),
        )} = ${quote('src')}.${quote(String(relationship.from.fieldId))}`,
      );
      relationReaders.push({ bindAs: use.use.bindAs, entityId: relationship.to.entityId, prefix: `${alias}__` });
    });
    const context: SqlContext = {
      sourceTable: quote('src'),
      rowScopeId: query.rowScopeId,
      relationTables,
      principal: query.principal,
      args: query.arguments,
    };
    return {
      context,
      joins: joinClauses.join(' '),
      relationScopes: (raw) => {
        const scope = new Map<NodeId, unknown>();
        for (const reader of relationReaders) {
          scope.set(reader.bindAs, rowToRecord(reader.entityId, raw, reader.prefix));
        }
        return scope;
      },
    };
  }

  function selectList(query: ProviderQuery): string {
    const parts = columnsOf(query.source).map(
      (column) => `${quote('src')}.${quote(String(column))} AS ${quote(String(column))}`,
    );
    query.relationships.forEach((use, index) => {
      const relationship = relationshipsById.get(use.relationship.id) ?? use.relationship;
      for (const column of columnsOf(relationship.to.entityId)) {
        parts.push(`${quote(`r${index}`)}.${quote(String(column))} AS ${quote(`r${index}__${String(column)}`)}`);
      }
    });
    return parts.join(', ');
  }

  function orderByClause(query: ProviderQuery, context: SqlContext): SqlFragment {
    const parts: string[] = [];
    const params: LiteralValue[] = [];
    for (const key of query.sort) {
      const fragment = translateExpression(key.key, context);
      params.push(...fragment.params);
      parts.push(`${fragment.sql} ${key.direction === 'desc' ? 'DESC' : 'ASC'} NULLS ${key.nulls === 'first' ? 'FIRST' : 'LAST'}`);
    }
    if (query.identityFieldId) {
      parts.push(`${quote('src')}.${quote(String(query.identityFieldId))} ASC`);
    }
    return { sql: parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '', params };
  }

  /** The lexicographic keyset predicate for continuing after a cursor position. */
  function keysetPredicate(query: ProviderQuery, context: SqlContext): SqlFragment | null {
    if (!query.after || !query.identityFieldId) {
      return null;
    }
    const anchors = query.after.sortValues;
    const keyFragments = query.sort.map((key) => translateExpression(key.key, context));
    const idExpr = `${quote('src')}.${quote(String(query.identityFieldId))}`;
    let predicate = `${idExpr} > ?`;
    let params: LiteralValue[] = [query.after.identityValue];
    for (let i = query.sort.length - 1; i >= 0; i -= 1) {
      const key = query.sort[i];
      const fragment = keyFragments[i];
      const anchor = anchors[i] ?? null;
      const cmp = key.direction === 'desc' ? '<' : '>';
      const nullsLast = key.nulls !== 'first';
      let after: string;
      let afterParams: LiteralValue[];
      if (anchor === null) {
        after = nullsLast ? '0' : `(${fragment.sql} IS NOT NULL)`;
        afterParams = nullsLast ? [] : [...fragment.params];
      } else {
        after = nullsLast
          ? `((${fragment.sql} ${cmp} ?) OR ${fragment.sql} IS NULL)`
          : `(${fragment.sql} ${cmp} ?)`;
        afterParams = nullsLast
          ? [...fragment.params, anchor, ...fragment.params]
          : [...fragment.params, anchor];
      }
      const eq = `(${fragment.sql} IS ?)`;
      predicate = `(${after} OR (${eq} AND (${predicate})))`;
      params = [...afterParams, ...fragment.params, anchor, ...params];
    }
    return { sql: predicate, params };
  }

  function whereClause(query: ProviderQuery, context: SqlContext): SqlFragment {
    const clauses: SqlFragment[] = [];
    if (query.filter) {
      clauses.push(translateExpression(query.filter, context));
    }
    const keyset = keysetPredicate(query, context);
    if (keyset) {
      clauses.push(keyset);
    }
    if (clauses.length === 0) {
      return { sql: '', params: [] };
    }
    return {
      sql: `WHERE ${clauses.map((clause) => `(${clause.sql})`).join(' AND ')}`,
      params: clauses.flatMap((clause) => clause.params),
    };
  }

  function planUnsupported(query: ProviderQuery): string[] {
    const unsupported: string[] = [];
    try {
      const { context } = buildContext(query);
      if (query.filter) {
        translateExpression(query.filter, context);
      }
      for (const key of query.sort) {
        translateExpression(key.key, context);
      }
      for (const key of query.groupBy) {
        translateExpression(key, context);
      }
      for (const aggregate of query.aggregate) {
        if (aggregate.key) {
          translateExpression(aggregate.key, context);
        }
      }
    } catch (error) {
      if (error instanceof UnsupportedQueryExpression) {
        unsupported.push(error.kind);
      } else {
        throw error;
      }
    }
    return unsupported;
  }

  const provider: DataProvider = {
    capabilities: {
      supports: ['filter', 'sort', 'cursor', 'offset', 'projection', 'relationship', 'aggregate', 'group', 'transactional-reads'],
      maxPageSize,
    },

    async query(query: ProviderQuery): Promise<ProviderResult<ProviderPage>> {
      try {
        const { context, joins, relationScopes } = buildContext(query);
        const where = whereClause(query, context);
        const orderBy = orderByClause(query, context);
        const pageSize = Math.min(query.pageSize, maxPageSize);
        const limit = pageSize + 1;
        const offsetSql = query.strategy === 'offset' && query.offset ? ` OFFSET ${Math.max(0, Math.floor(query.offset))}` : '';
        const sql = `SELECT ${selectList(query)} FROM ${tableName(query.source)} AS ${quote('src')} ${joins} ${where.sql} ${orderBy.sql} LIMIT ${limit}${offsetSql}`;
        const raws = db.prepare(sql).all(...[...where.params, ...orderBy.params].map(bind));
        const hasMore = raws.length > pageSize;
        const pageRaws = raws.slice(0, pageSize);
        const items = pageRaws.map((raw) => {
          const record = rowToRecord(query.source, raw);
          if (!query.projection) {
            return record;
          }
          const scope = new Map<NodeId, unknown>([[query.rowScopeId, record], ...relationScopes(raw)]);
          const projected: Record<string, LiteralValue> = {};
          for (const field of query.projection.fields) {
            projected[field.id as unknown as string] = evaluateQueryExpression(field.value, scope) as LiteralValue;
          }
          return projected;
        });
        const last = pageRaws[pageRaws.length - 1];
        const lastPosition =
          last && query.identityFieldId && query.strategy === 'cursor'
            ? {
                sortValues: sortValuesOf(query, last, relationScopes),
                identityValue: (last[String(query.identityFieldId)] as LiteralValue) ?? null,
              }
            : undefined;
        return { ok: true, value: { items, hasMore, ...(lastPosition ? { lastPosition } : {}) } };
      } catch (error) {
        return sqlFailure(error);
      }
    },

    async aggregate(query: ProviderQuery): Promise<ProviderResult<AggregateResult>> {
      try {
        const { context, joins } = buildContext(query);
        const where = whereClause({ ...query, after: undefined }, context);
        const groupFragments = query.groupBy.map((key) => translateExpression(key, context));
        const aggregateSql = query.aggregate.map((aggregate, index) => {
          if (aggregate.function === 'count') {
            return `COUNT(*) AS ${quote(`a${index}`)}`;
          }
          const fragment = translateExpression(aggregate.key as Expression, context);
          const fn = aggregate.function === 'average' ? 'AVG' : aggregate.function.toUpperCase();
          return `${fn}(${fragment.sql}) AS ${quote(`a${index}`)}`;
        });
        const groupCols = groupFragments.map((fragment, index) => `${fragment.sql} AS ${quote(`g${index}`)}`);
        const groupBy = groupFragments.length > 0 ? `GROUP BY ${groupFragments.map((fragment) => fragment.sql).join(', ')}` : '';
        // First-seen group order (spec §24): order groups by the earliest source row in each.
        const groupOrder = groupFragments.length > 0 ? `ORDER BY MIN(${quote('src')}._seq)` : '';
        const selectParts = [...groupCols, ...aggregateSql].join(', ') || '1';
        const params = [
          ...groupFragments.flatMap((fragment) => fragment.params),
          ...query.aggregate.flatMap((aggregate) =>
            aggregate.key ? translateExpression(aggregate.key, context).params : [],
          ),
          ...where.params,
          ...groupFragments.flatMap((fragment) => fragment.params),
        ];
        const sql = `SELECT ${selectParts} FROM ${tableName(query.source)} AS ${quote('src')} ${joins} ${where.sql} ${groupBy} ${groupOrder}`;
        const raws = db.prepare(sql).all(...params.map(bind));
        const rows = raws.map((raw) => ({
          ...(query.groupBy.length > 0
            ? { key: groupFragments.map((_, index) => (raw[`g${index}`] as LiteralValue) ?? null) }
            : {}),
          values: Object.fromEntries(
            query.aggregate.map((aggregate, index) => [
              String(aggregate.as),
              normalizeAggregate(aggregate.function, raw[`a${index}`] as LiteralValue),
            ]),
          ),
        }));
        return { ok: true, value: { rows: rows.length > 0 ? rows : [{ values: emptyAggregateValues(query) }] } };
      } catch (error) {
        return sqlFailure(error);
      }
    },

    async loadByIdentity(entityId, identityFieldId, values) {
      if (values.length === 0) {
        return { ok: true, value: [] };
      }
      const placeholders = values.map(() => '?').join(', ');
      const sql = `SELECT ${columnsOf(entityId)
        .map((column) => quote(String(column)))
        .join(', ')} FROM ${tableName(entityId)} WHERE ${quote(String(identityFieldId))} IN (${placeholders})`;
      const raws = db.prepare(sql).all(...values.map(bind));
      return { ok: true, value: raws.map((raw) => rowToRecord(entityId, raw)) };
    },

    async applyMutations(mutations: readonly ProviderMutation[]) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const mutation of mutations) {
          const table = tableName(mutation.entityId);
          if (mutation.kind === 'remove') {
            db.prepare(`DELETE FROM ${table} WHERE ${quote(String(mutation.identityFieldId))} = ?`).run(
              bind(mutation.identityValue),
            );
            continue;
          }
          const row = mutation.row ?? {};
          const columns = Object.keys(row);
          const assignments = columns.map((column) => `${quote(column)} = ?`).join(', ');
          const updated = db
            .prepare(
              `UPDATE ${table} SET ${assignments} WHERE ${quote(String(mutation.identityFieldId))} = ?`,
            )
            .run(...columns.map((column) => bind(row[column])), bind(mutation.identityValue));
          if ((updated as { changes?: number }).changes === 0) {
            db.prepare(
              `INSERT INTO ${table} (${columns.map((column) => quote(column)).join(', ')}, _seq) VALUES (${columns
                .map(() => '?')
                .join(', ')}, (SELECT coalesce(MAX(_seq), -1) + 1 FROM ${table}))`,
            ).run(...columns.map((column) => bind(row[column])));
          }
        }
        db.exec('COMMIT');
        return { ok: true, value: null };
      } catch (error) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'QUERY_PROVIDER_FAILURE', message: error instanceof Error ? error.message : String(error) };
      }
    },

    explain(query: ProviderQuery): QueryPlan {
      const unsupported = planUnsupported(query);
      void requiredCapabilities({
        filter: query.filter,
        sort: query.sort,
        projection: query.projection,
        relationships: query.relationships,
        aggregate: query.aggregate,
        groupBy: query.groupBy,
        strategy: query.strategy,
      });
      return {
        queryId: query.queryId,
        source: query.source,
        pushedFilter: Boolean(query.filter),
        pushedSort: query.sort.map((key) => key.label),
        pagination: { strategy: query.strategy, pageSize: Math.min(query.pageSize, maxPageSize) },
        projection: (query.projection?.fields ?? []).map((field) => String(field.id)),
        relationships: query.relationships.map((use) => `${String(use.relationship.id)} (JOIN)`),
        aggregates: query.aggregate.map((aggregate) =>
          aggregate.function === 'count' ? 'count' : `${aggregate.function}(…) as ${String(aggregate.as)}`,
        ),
        unsupported,
      };
    },
  };

  function sortValuesOf(
    query: ProviderQuery,
    raw: Record<string, unknown>,
    relationScopes: (raw: Record<string, unknown>) => Map<NodeId, unknown>,
  ): LiteralValue[] {
    const record = rowToRecord(query.source, raw);
    const scope = new Map<NodeId, unknown>([[query.rowScopeId, record], ...relationScopes(raw)]);
    return query.sort.map((key) => evaluateQueryExpression(key.key, scope) as LiteralValue);
  }

  return provider;
}

function normalizeAggregate(fn: string, value: LiteralValue): LiteralValue {
  if (fn === 'count' || fn === 'sum') {
    return typeof value === 'number' ? value : Number(value ?? 0);
  }
  return value ?? null;
}

function emptyAggregateValues(query: ProviderQuery): Record<string, LiteralValue> {
  return Object.fromEntries(
    query.aggregate.map((aggregate) => [
      String(aggregate.as),
      aggregate.function === 'count' || aggregate.function === 'sum' ? 0 : null,
    ]),
  );
}

function sqlFailure(error: unknown): ProviderResult<never> {
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

void compareSortValues;
