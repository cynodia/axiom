import type { ServerIR } from './deps.js';
import { migrationPath } from './deps.js';
import { MIGRATION_DIAGNOSTIC_CODES } from './migration.js';
import type { MigrationDiagnosticCode } from './migration.js';
import type { MigrationMetadataStore } from './migration-store.js';

/**
 * The startup schema-compatibility gate (spec11 §11, §12).
 *
 * Before an authority serves any traffic it compares what the graph requires — a semantic
 * schema version and fingerprint — with what the provider has durably recorded. There is
 * **no hopeful startup**: a mismatch produces an explicit outcome, never a server that runs
 * and then fails queries and actions in arbitrary ways later.
 */
export type SchemaGateStatus =
  | 'compatible'
  | 'fresh'
  | 'migration-required'
  | 'migration-in-progress'
  | 'incompatible'
  | 'corrupted';

export interface SchemaGateResult {
  status: SchemaGateStatus;
  /** Set for every non-serving outcome. */
  code?: MigrationDiagnosticCode;
  message: string;
  requiredVersion: number;
  persistedVersion: number | null;
  /** For `migration-required`: how many migration steps the path has. */
  pathSteps?: number;
}

export interface SchemaGateContext {
  /** Whether the persistence adapter already holds committed authoritative state. */
  hasPersistedData?: boolean;
}

/**
 * Evaluate the gate. Pure with respect to the graph; it only *reads* the metadata store.
 * The caller decides what to do with the result — `createAxiomServer().start()` refuses to
 * start on anything but `compatible` / `fresh`.
 */
export async function evaluateSchemaGate(
  ir: ServerIR,
  metadata: MigrationMetadataStore,
  context: SchemaGateContext = {},
): Promise<SchemaGateResult> {
  const requiredVersion = ir.schemaVersion ?? 1;
  const requiredFingerprint = ir.schemaFingerprint ?? '';

  // Pre-v7 documents have no semantic schema identity; the gate is disabled for them.
  if (requiredVersion <= 1 && (ir.migrations ?? []).length === 0 && ir.schemaFingerprint === undefined) {
    return {
      status: 'compatible',
      message: 'document declares no semantic schema version; gate disabled',
      requiredVersion,
      persistedVersion: null,
    };
  }

  const lock = await metadata.readLock();
  if (lock) {
    return {
      status: 'migration-in-progress',
      code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_IN_PROGRESS,
      message: `a migration is running, held by ${lock.holder}; the authority will not start until it completes`,
      requiredVersion,
      persistedVersion: null,
    };
  }

  const record = await metadata.readSchema();

  if (record === null) {
    if (context.hasPersistedData && requiredVersion > 1) {
      return {
        status: 'corrupted',
        code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_STATE_CORRUPTED,
        message: `persisted data is present but the provider has no schema metadata, and the graph requires schema ${requiredVersion}`,
        requiredVersion,
        persistedVersion: null,
      };
    }
    return {
      status: 'fresh',
      message: `no stored schema metadata; the provider will be stamped at schema ${requiredVersion}`,
      requiredVersion,
      persistedVersion: null,
    };
  }

  if (record.schemaVersion === requiredVersion) {
    if (record.schemaFingerprint === requiredFingerprint) {
      return {
        status: 'compatible',
        message: `persisted schema ${requiredVersion} matches`,
        requiredVersion,
        persistedVersion: record.schemaVersion,
      };
    }
    return {
      status: 'corrupted',
      code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_FINGERPRINT_MISMATCH,
      message: `persisted schema version ${requiredVersion} matches, but its fingerprint does not — the stored data is not the shape this build expects`,
      requiredVersion,
      persistedVersion: record.schemaVersion,
    };
  }

  if (record.schemaVersion > requiredVersion) {
    return {
      status: 'incompatible',
      code: MIGRATION_DIAGNOSTIC_CODES.SCHEMA_INCOMPATIBLE,
      message: `persisted schema ${record.schemaVersion} is newer than this build's schema ${requiredVersion}; an older application must not run against newer data`,
      requiredVersion,
      persistedVersion: record.schemaVersion,
    };
  }

  const path = migrationPath(ir.migrations ?? [], record.schemaVersion, requiredVersion);
  if (path === null) {
    return {
      status: 'incompatible',
      code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_PATH_NOT_FOUND,
      message: `no migration chain connects persisted schema ${record.schemaVersion} to required schema ${requiredVersion}`,
      requiredVersion,
      persistedVersion: record.schemaVersion,
    };
  }

  return {
    status: 'migration-required',
    code: MIGRATION_DIAGNOSTIC_CODES.SCHEMA_MIGRATION_REQUIRED,
    message: `persisted schema ${record.schemaVersion} must be migrated to ${requiredVersion} (${path.length} step${
      path.length === 1 ? '' : 's'
    }) before the authority will serve traffic`,
    requiredVersion,
    persistedVersion: record.schemaVersion,
    pathSteps: path.length,
  };
}

/** Whether a gate result permits the authority to start serving. */
export function gateAllowsStart(result: SchemaGateResult): boolean {
  return result.status === 'compatible' || result.status === 'fresh';
}
