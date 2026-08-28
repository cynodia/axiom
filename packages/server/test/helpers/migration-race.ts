import {
  ApplicationGraph,
  MIGRATION_OLD_SCOPE,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
} from '@cynodia/axiom-core';
import type { EntityDef, LiteralValue, MigrationDef, ServerIR, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import { createSqliteMigrationStore, createSqliteRowStore } from '@cynodia/axiom-server';

/**
 * Shared fixture for the D-4 cross-process SQLite migration race (spec11.2 §27-30, §55).
 *
 * The transform is deliberately **non-idempotent** — `n := n + 1` on every row — so a
 * duplicate execution of the `1 → 2` transition is visible as `n === original + 2`. A
 * correct race resolves to exactly one semantic completion and every row at `original + 1`.
 */

export const RACE_ENTITY = 'entity_item';
export const RACE_F_ID = 'field_item_id';
export const RACE_F_N = 'field_item_n';
export const RACE_ROW_COUNT = 48;

const E = nodeId(RACE_ENTITY);
const F_ID = fieldId(RACE_F_ID);
const F_N = fieldId(RACE_F_N);

/** The target (schema 2) IR both racing processes migrate towards. */
export function buildRaceIr(): ServerIR {
  const graph = new ApplicationGraph('race', 'Race', '0.11.0');
  graph.setSchemaVersion(2);
  graph.addNode<EntityDef>({
    id: E,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string') },
      { id: F_N, valueType: primitiveType('number') },
    ],
  });
  graph.addNode<StateDef>({
    id: nodeId('state_items'),
    kind: 'state',
    valueType: collectionType(entityType(E)),
    authority: 'server',
  });
  graph.addNode<MigrationDef>({
    id: nodeId('m_1_2'),
    kind: 'migration',
    fromSchema: 1,
    toSchema: 2,
    operations: [
      {
        id: nodeId('op_increment'),
        kind: 'transform-field',
        entityId: E,
        fieldId: F_N,
        fromType: primitiveType('number'),
        toType: primitiveType('number'),
        expression: binary('add', field(ref(MIGRATION_OLD_SCOPE), F_N), literal(1)),
      },
    ],
  });
  return compileToServerIR(graph, { validate: false });
}

export function raceSeedRows(): Array<Record<string, LiteralValue>> {
  return Array.from({ length: RACE_ROW_COUNT }, (_, i) => ({
    [RACE_F_ID]: `item-${String(i).padStart(3, '0')}`,
    [RACE_F_N]: i * 10,
  }));
}

/** The value every row's `n` must hold after exactly one `1 → 2` migration. */
export function expectedN(index: number): number {
  return index * 10 + 1;
}

/** Seed a fresh on-disk database at schema 1 with {@link RACE_ROW_COUNT} rows. */
export async function seedRaceDatabase(dbPath: string): Promise<void> {
  const ir = buildRaceIr();
  const rows = await createSqliteRowStore({
    location: dbPath,
    ir,
    seed: { [RACE_ENTITY]: raceSeedRows() },
  });
  const database = (rows as { database: { close(): void } }).database;
  const meta = await createSqliteMigrationStore({ location: dbPath, database });
  await meta.writeSchema(1, 'fp-race-1');
  database.close();
}

/** Read the final `(rows, schemaVersion, historyLength, lock, checkpoint)` of a raced database. */
export async function inspectRaceDatabase(dbPath: string): Promise<{
  ns: number[];
  rowCount: number;
  schemaVersion: number | null;
  historyLength: number;
  lockHeld: boolean;
  checkpointPresent: boolean;
}> {
  const ir = buildRaceIr();
  const rows = await createSqliteRowStore({ location: dbPath, ir });
  const database = (rows as { database: { close(): void } }).database;
  const meta = await createSqliteMigrationStore({ location: dbPath, database });
  const snapshot = rows
    .snapshot(RACE_ENTITY)
    .slice()
    .sort((a, b) => String(a[RACE_F_ID]).localeCompare(String(b[RACE_F_ID])));
  const record = await meta.readSchema();
  const lock = await meta.readLock();
  const checkpoint = await meta.readCheckpoint();
  database.close();
  return {
    ns: snapshot.map((row) => Number(row[RACE_F_N])),
    rowCount: snapshot.length,
    schemaVersion: record?.schemaVersion ?? null,
    historyLength: record?.history.length ?? 0,
    lockHeld: lock !== null,
    checkpointPresent: checkpoint !== null,
  };
}

/** The shape a race worker prints to stdout. */
export interface RaceWorkerResult {
  ok: boolean;
  phase?: string;
  alreadyAtTarget?: boolean;
  rowsTransformed?: number;
  code?: string;
  message?: string;
  thrown?: boolean;
  errorName?: string;
  errorCode?: string;
  errcode?: number;
}
