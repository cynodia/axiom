import type { Expression, LiteralValue, NodeId } from './deps.js';
import { PRINCIPAL } from './deps.js';
import { UnsupportedQueryExpression } from './query-eval.js';

/**
 * Translates the **query expression subset** to parametrized SQL, for the SQLite reference
 * provider. It is deliberately the same subset `query-eval.ts` evaluates in memory, with
 * the same frozen semantics (spec 0.10 §78-80):
 *
 * - a `null` operand never matches `=` / `<>` / `<` / `>` — SQLite's three-valued `WHERE`
 *   drops a `NULL` result, which is exactly "no match", and `NULL = NULL` is `NULL`;
 * - `TEXT` compares in `BINARY` collation, which for UTF-8 bytes is Unicode code-point
 *   order — never `NOCASE`, never a locale collation (spec §79);
 * - `REAL` is IEEE-754 binary64 (spec §80).
 *
 * Anything outside the subset throws `UnsupportedQueryExpression`, so the provider reports
 * it as `unsupported` and the runtime rejects the query — there is no SQL-side fallback and
 * no silent approximation (spec §9, §32, §81).
 *
 * Values are **always** bound as parameters. A raw argument never becomes a table name, a
 * column name, an operator or a fragment (spec §33).
 */

export interface SqlContext {
  /** The quoted identifier of the source row table. */
  sourceTable: string;
  rowScopeId: NodeId;
  /** Relationship bind id → quoted table alias of the joined target. */
  relationTables: Map<NodeId, string>;
  /** Column name lookup: a `FieldId` maps to itself (columns are named by field id). */
  principal: Record<string, LiteralValue> | null;
  args: Record<string, LiteralValue>;
}

export interface SqlFragment {
  sql: string;
  params: LiteralValue[];
}

const BINARY_OPS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  and: 'AND',
  or: 'OR',
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
};

function quoteColumn(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Translates a filter/sort/group expression to a SQL scalar expression with bound params. */
export function translateExpression(expression: Expression, context: SqlContext): SqlFragment {
  switch (expression.kind) {
    case 'literal':
      return literalFragment(expression.value as LiteralValue);
    case 'ref': {
      // A bare `ref` to a parameter resolves to its value; `ref(rowScope)` / `ref(relBind)`
      // are only meaningful as a `field` source and never appear bare in a valid query.
      if (String(expression.targetId) in context.args) {
        return literalFragment(context.args[String(expression.targetId)]);
      }
      if (expression.targetId === PRINCIPAL) {
        throw new UnsupportedQueryExpression('ref:principal-record');
      }
      throw new UnsupportedQueryExpression(`ref:${String(expression.targetId)}`);
    }
    case 'field': {
      const source = expression.source;
      if (source.kind === 'ref') {
        if (source.targetId === context.rowScopeId) {
          return { sql: `${context.sourceTable}.${quoteColumn(String(expression.fieldId))}`, params: [] };
        }
        const relationTable = context.relationTables.get(source.targetId);
        if (relationTable) {
          return { sql: `${relationTable}.${quoteColumn(String(expression.fieldId))}`, params: [] };
        }
        if (source.targetId === PRINCIPAL) {
          const value = context.principal ? context.principal[String(expression.fieldId)] ?? null : null;
          return literalFragment(value);
        }
      }
      throw new UnsupportedQueryExpression('field:non-scope-source');
    }
    case 'unary': {
      const operand = translateExpression(expression.operand, context);
      if (expression.operator === 'not') {
        return { sql: `(NOT ${operand.sql})`, params: operand.params };
      }
      return { sql: `(-${operand.sql})`, params: operand.params };
    }
    case 'binary': {
      const op = BINARY_OPS[expression.operator];
      if (!op) {
        throw new UnsupportedQueryExpression(`binary:${expression.operator}`);
      }
      const left = translateExpression(expression.left, context);
      const right = translateExpression(expression.right, context);
      if (expression.operator === 'divide') {
        // Match query-eval: divide-by-zero yields NaN, which never compares true.
        return {
          sql: `(CASE WHEN ${right.sql} = 0 THEN NULL ELSE ${left.sql} / (${right.sql} * 1.0) END)`,
          params: [...left.params, ...right.params, ...right.params],
        };
      }
      return { sql: `(${left.sql} ${op} ${right.sql})`, params: [...left.params, ...right.params] };
    }
    case 'conditional': {
      const condition = translateExpression(expression.condition, context);
      const whenTrue = translateExpression(expression.whenTrue, context);
      const whenFalse = translateExpression(expression.whenFalse, context);
      return {
        sql: `(CASE WHEN ${condition.sql} THEN ${whenTrue.sql} ELSE ${whenFalse.sql} END)`,
        params: [...condition.params, ...whenTrue.params, ...whenFalse.params],
      };
    }
    case 'call':
      return translateCall(expression.function, expression.arguments, context);
    default:
      throw new UnsupportedQueryExpression(expression.kind);
  }
}

function translateCall(fn: string, args: Expression[], context: SqlContext): SqlFragment {
  const parts = args.map((argument) => translateExpression(argument, context));
  const params = parts.flatMap((part) => part.params);
  switch (fn) {
    case 'contains':
      // Substring containment, case-sensitive, matching query-eval's `String.includes`.
      return { sql: `(instr(${parts[0].sql}, ${parts[1].sql}) > 0)`, params };
    case 'lowercase':
      return { sql: `lower(${parts[0].sql})`, params };
    case 'to-string':
      return { sql: `CAST(coalesce(${parts[0].sql}, '') AS TEXT)`, params };
    case 'coalesce':
      return { sql: `coalesce(${parts.map((part) => part.sql).join(', ')})`, params };
    case 'is-empty':
      return {
        sql: `(${parts[0].sql} IS NULL OR ${parts[0].sql} = '')`,
        params: [...params, ...parts[0].params],
      };
    case 'non-empty':
      return {
        sql: `(${parts[0].sql} IS NOT NULL AND ${parts[0].sql} <> '')`,
        params: [...params, ...parts[0].params],
      };
    case 'required':
      return { sql: `(${parts[0].sql} IS NOT NULL)`, params };
    case 'length':
      return { sql: `length(coalesce(${parts[0].sql}, ''))`, params };
    case 'concat':
      return { sql: parts.map((part) => `coalesce(${part.sql}, '')`).join(' || ') || `''`, params };
    case 'one-of':
      return {
        sql: `(${parts[0].sql} IN (${parts.slice(1).map((part) => part.sql).join(', ')}))`,
        params,
      };
    default:
      throw new UnsupportedQueryExpression(`call:${fn}`);
  }
}

function literalFragment(value: LiteralValue): SqlFragment {
  if (value === null || value === undefined) {
    return { sql: 'NULL', params: [] };
  }
  return { sql: '?', params: [value] };
}
