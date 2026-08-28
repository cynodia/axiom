import type { LiteralValue, ServerIR } from './deps.js';
import { planMigration } from './migration.js';
import type { MigrationDiagnosticCode } from './migration.js';
import { createMemoryMigrationStore } from './migration-store.js';
import { createMemoryRowStore } from './migration-row-store.js';
import type { MigrationDataset, MigrationRowStore } from './migration-row-store.js';
import { MigrationCrash, runMigration } from './migration-executor.js';
import { evaluateSchemaGate } from './migration-gate.js';

/**
 * The portable **migration conformance** model (`axiom.conformance.v5`, spec11 §84-86).
 *
 * A fixture is pure data: a compiled `axiom.server.v7` Server IR (the *target* schema plus
 * its `MigrationDef` chain), the schema version the persisted data starts at, the source
 * rows, any destructive approvals, and the exact expected outcome — target rows and a
 * `completed` status, or a diagnostic code and a `refused` / `failed` status with the
 * schema version left unchanged. Running one needs nothing from this implementation beyond
 * a row store; a runtime in another language builds its own runner from these shapes plus
 * `docs/AUTHORITY.md` and `docs/MIGRATIONS.md`.
 */

export type MigrationConformanceRow = Record<string, LiteralValue>;

export interface MigrationConformanceFixture {
  conformance: 'axiom.conformance.v5';
  name: string;
  covers: string[];
  description: string;
  /** The `axiom.server.v7` target document, including its migration chain. */
  serverIR: ServerIR;
  /** The schema version the persisted data is currently at. */
  fromVersion: number;
  /** Source rows per entity id (source-schema shape). */
  sourceData: Record<string, MigrationConformanceRow[]>;
  /** Destructive operation ids the operator approves (spec11 §21). */
  approvals?: string[];
  batchSize?: number;
  /** Overrides the stored source fingerprint — for the fingerprint-mismatch case. */
  seededFingerprint?: string;
  /** Inject a crash once this many rows of a transform have been processed, then resume. */
  crashAfterRows?: number;
  /** A lock is already held by this holder before the migration is attempted. */
  preHeldLockHolder?: string;
  /** Run the migration twice; the second run must be an idempotent no-op (spec11 §35). */
  rerun?: boolean;
  expect:
    | { ok: true; status: 'completed'; targetData: Record<string, MigrationConformanceRow[]> }
    | { ok: false; status: 'refused' | 'failed'; code: MigrationDiagnosticCode };
}

export interface MigrationConformanceResult {
  name: string;
  passed: boolean;
  failures: string[];
  /** The resulting rows per entity id, sorted by identity — for cross-provider comparison. */
  resultData: Record<string, MigrationConformanceRow[]>;
}

export interface RunMigrationConformanceOptions {
  /** Builds a row store for one fixture's source data. */
  makeRowStore(
    sourceData: Record<string, MigrationConformanceRow[]>,
    ir: ServerIR,
  ): (MigrationRowStore & { snapshot: (entityId: string) => MigrationConformanceRow[] }) | Promise<
    MigrationRowStore & { snapshot: (entityId: string) => MigrationConformanceRow[] }
  >;
}

/** A memory row store plus a `snapshot` matching the SQLite one's shape. */
export function memoryConformanceRowStore(
  sourceData: Record<string, MigrationConformanceRow[]>,
): MigrationRowStore & { snapshot: (entityId: string) => MigrationConformanceRow[] } {
  const dataset: MigrationDataset = {
    rows: new Map(Object.entries(sourceData).map(([id, rows]) => [id, rows.map((row) => ({ ...row }))])),
  };
  const store = createMemoryRowStore(dataset);
  return {
    ...store,
    snapshot: (entityId: string) => [...(dataset.rows.get(entityId) ?? [])].map((row) => ({ ...row })),
  };
}

function identityFieldOf(ir: ServerIR, entityId: string): string | undefined {
  const entity = ir.entities.find((candidate) => String(candidate.id) === entityId);
  return entity?.identityFieldId ? String(entity.identityFieldId) : undefined;
}

/**
 * `null` and an absent key mean the same thing for an optional field (Axiom presence
 * semantics), so the memory representation (absent) and the relational one (`NULL`) are
 * normalized to the same shape before any comparison.
 */
function normalizeRow(row: MigrationConformanceRow): MigrationConformanceRow {
  const out: MigrationConformanceRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

function sortByIdentity(rows: MigrationConformanceRow[], identity: string | undefined): MigrationConformanceRow[] {
  const normalized = rows.map(normalizeRow);
  if (!identity) return normalized;
  return normalized.sort((a, b) => {
    const av = JSON.stringify(a[identity] ?? null);
    const bv = JSON.stringify(b[identity] ?? null);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

const FIXED_TIME = 1_700_000_000_000;

export async function runMigrationConformanceFixture(
  fixture: MigrationConformanceFixture,
  options: RunMigrationConformanceOptions,
): Promise<MigrationConformanceResult> {
  const failures: string[] = [];
  const ir = fixture.serverIR;
  const targetVersion = ir.schemaVersion ?? 1;

  const metadata = createMemoryMigrationStore({
    now: () => FIXED_TIME,
    seed:
      fixture.fromVersion >= 1 && (fixture.fromVersion < targetVersion || fixture.seededFingerprint !== undefined)
        ? {
            schemaVersion: fixture.fromVersion,
            schemaFingerprint: fixture.seededFingerprint ?? `source-v${fixture.fromVersion}`,
            history: [],
            updatedAt: 0,
          }
        : null,
  });

  const rowStore = await options.makeRowStore(fixture.sourceData, ir);
  const snapshotAll = (): Record<string, MigrationConformanceRow[]> => {
    const out: Record<string, MigrationConformanceRow[]> = {};
    for (const entityId of Object.keys(fixture.sourceData)) {
      out[entityId] = sortByIdentity(rowStore.snapshot(entityId), identityFieldOf(ir, entityId));
    }
    return out;
  };

  // --- Gate-only fixtures: same version, seeded fingerprint (mismatch / corrupted). -----
  if (fixture.fromVersion === targetVersion) {
    const gate = await evaluateSchemaGate(ir, metadata, { hasPersistedData: true });
    if (fixture.expect.ok) {
      if (gate.status !== 'compatible') failures.push(`expected compatible gate, got ${gate.status}`);
    } else if (gate.code !== fixture.expect.code) {
      failures.push(`expected gate code ${fixture.expect.code}, got ${gate.code ?? gate.status}`);
    }
    return { name: fixture.name, passed: failures.length === 0, failures, resultData: snapshotAll() };
  }

  if (fixture.preHeldLockHolder) {
    await metadata.acquireLock(fixture.preHeldLockHolder, 1_000_000_000);
  }

  const planned = planMigration(ir, { fromVersion: fixture.fromVersion });
  if (!planned.ok) {
    if (fixture.expect.ok) {
      failures.push(`planning failed: ${planned.diagnostics[0].code}`);
    } else if (planned.diagnostics[0].code !== fixture.expect.code) {
      failures.push(`expected ${fixture.expect.code}, planning gave ${planned.diagnostics[0].code}`);
    }
    return { name: fixture.name, passed: failures.length === 0, failures, resultData: snapshotAll() };
  }

  const runOptions = {
    holder: `conformance-${fixture.name}`,
    now: () => FIXED_TIME,
    approveDestructive: fixture.approvals ?? [],
    ...(fixture.batchSize !== undefined ? { batchSize: fixture.batchSize } : {}),
  };

  if (fixture.crashAfterRows !== undefined) {
    let crashed = false;
    try {
      await runMigration(ir, planned.plan, metadata, rowStore, {
        ...runOptions,
        crashAfter: ({ rowsProcessed }) => rowsProcessed >= (fixture.crashAfterRows as number),
      });
    } catch (error) {
      crashed = error instanceof MigrationCrash;
    }
    if (!crashed) failures.push('expected an injected crash but the migration completed');
    if ((await metadata.readSchema())?.schemaVersion === targetVersion) {
      failures.push('schema version was committed before the crash');
    }
  }

  const run = await runMigration(ir, planned.plan, metadata, rowStore, runOptions);

  if (fixture.rerun && run.ok) {
    const before = JSON.stringify(snapshotAll());
    const second = await runMigration(ir, planned.plan, metadata, rowStore, runOptions);
    if (!second.ok || !second.alreadyAtTarget) {
      failures.push('a re-run was not an idempotent no-op');
    }
    if (JSON.stringify(snapshotAll()) !== before) {
      failures.push('a re-run changed the data');
    }
  }

  if (fixture.expect.ok) {
    if (!run.ok) {
      failures.push(`expected success, got ${run.code}: ${run.message}`);
    } else {
      const result = snapshotAll();
      for (const [entityId, expectedRows] of Object.entries(fixture.expect.targetData)) {
        const expected = sortByIdentity(expectedRows, identityFieldOf(ir, entityId));
        if (JSON.stringify(result[entityId] ?? []) !== JSON.stringify(expected)) {
          failures.push(
            `${entityId}: target data mismatch\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(
              result[entityId] ?? [],
            )}`,
          );
        }
      }
      if ((await metadata.readSchema())?.schemaVersion !== targetVersion) {
        failures.push('schema version was not committed after a successful migration');
      }
    }
  } else {
    if (run.ok) {
      failures.push(`expected ${fixture.expect.code}, migration succeeded`);
    } else if (run.code !== fixture.expect.code) {
      failures.push(`expected ${fixture.expect.code}, got ${run.code}`);
    }
    if ((await metadata.readSchema())?.schemaVersion === targetVersion) {
      failures.push('schema version was committed despite a failed / refused migration');
    }
  }

  return { name: fixture.name, passed: failures.length === 0, failures, resultData: snapshotAll() };
}

export interface MigrationSuiteResult {
  total: number;
  passed: number;
  results: MigrationConformanceResult[];
}

export async function runMigrationConformanceSuite(
  fixtures: readonly MigrationConformanceFixture[],
  options: RunMigrationConformanceOptions,
): Promise<MigrationSuiteResult> {
  const results: MigrationConformanceResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runMigrationConformanceFixture(fixture, options));
  }
  return { total: results.length, passed: results.filter((result) => result.passed).length, results };
}
