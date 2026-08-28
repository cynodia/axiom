import type { LiteralValue } from './deps.js';
import { compareScalars } from './query-eval.js';

/**
 * The physical row-access contract the migration executor drives (spec11 §29, §30, §51).
 *
 * The executor never materializes a whole table: it reads a **keyset-ordered batch**,
 * transforms it, writes it back, checkpoints, and moves on. `createMemoryRowStore` is the
 * deterministic reference; `createSqliteRowStore` is the durable one. Both must produce
 * semantically equivalent target data for the same plan (spec11 §83).
 */
export interface MigrationRowStore {
  /** DDL — all idempotent so a crash-resume that re-runs a schema step is safe (spec11 §35). */
  addEntity(entityId: string): Promise<void>;
  removeEntity(entityId: string): Promise<void>;
  addColumn(entityId: string, fieldId: string): Promise<void>;
  dropColumn(entityId: string, fieldId: string): Promise<void>;

  countRows(entityId: string): Promise<number>;
  /**
   * Rows of `entityId` whose identity value is strictly greater than `afterIdentity`
   * (from the start when `null`), ordered by identity, at most `limit` of them.
   */
  readBatch(
    entityId: string,
    identityField: string,
    afterIdentity: LiteralValue | null,
    limit: number,
  ): Promise<Array<Record<string, LiteralValue>>>;
  /** Persist transformed values, matched by identity. Only the named columns are written. */
  writeBatch(
    entityId: string,
    identityField: string,
    updates: Array<{ identity: LiteralValue; values: Record<string, LiteralValue> }>,
  ): Promise<void>;
  /** The first required-field / identity violation after the migration, or `null` (spec11 §37). */
  requiredFieldViolation(
    entityId: string,
    requiredFields: readonly string[],
    identityField: string | undefined,
  ): Promise<string | null>;
}

/** entity id → its rows, each row keyed by field id. Mutated in place. */
export interface MigrationDataset {
  rows: Map<string, Array<Record<string, LiteralValue>>>;
}

function identityGreater(a: LiteralValue, b: LiteralValue | null): boolean {
  if (b === null) return true;
  if (a === null || a === undefined) return false;
  return compareScalars(a as never, b as never) > 0;
}

/** Deterministic in-memory row store over a {@link MigrationDataset} (spec11 §81). */
export function createMemoryRowStore(dataset: MigrationDataset): MigrationRowStore {
  const rowsOf = (entityId: string): Array<Record<string, LiteralValue>> => {
    if (!dataset.rows.has(entityId)) dataset.rows.set(entityId, []);
    return dataset.rows.get(entityId) as Array<Record<string, LiteralValue>>;
  };

  return {
    async addEntity(entityId) {
      rowsOf(entityId);
    },
    async removeEntity(entityId) {
      dataset.rows.delete(entityId);
    },
    async addColumn() {
      // A column is implicit in the memory representation — an absent key is a null value.
    },
    async dropColumn(entityId, fieldId) {
      for (const row of dataset.rows.get(entityId) ?? []) {
        delete row[fieldId];
      }
    },
    async countRows(entityId) {
      return (dataset.rows.get(entityId) ?? []).length;
    },
    async readBatch(entityId, identityField, afterIdentity, limit) {
      const rows = [...(dataset.rows.get(entityId) ?? [])].sort((a, b) => {
        const av = a[identityField];
        const bv = b[identityField];
        if (av === undefined || av === null || bv === undefined || bv === null) return 0;
        return compareScalars(av as never, bv as never);
      });
      return rows
        .filter((row) => identityGreater(row[identityField], afterIdentity))
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async writeBatch(entityId, identityField, updates) {
      const rows = dataset.rows.get(entityId) ?? [];
      const byId = new Map(rows.map((row) => [JSON.stringify(row[identityField] ?? null), row]));
      for (const update of updates) {
        const row = byId.get(JSON.stringify(update.identity ?? null));
        if (row) {
          Object.assign(row, update.values);
        }
      }
    },
    async requiredFieldViolation(entityId, requiredFields, identityField) {
      const rows = dataset.rows.get(entityId) ?? [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        for (const fieldId of requiredFields) {
          if (row[fieldId] === undefined || row[fieldId] === null) {
            return `${entityId}[${index}] is missing required field ${fieldId} after migration`;
          }
        }
        if (identityField && (row[identityField] === undefined || row[identityField] === null)) {
          return `${entityId}[${index}] has no identity value after migration`;
        }
      }
      return null;
    },
  };
}
