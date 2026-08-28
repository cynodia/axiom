import type { ServerIR } from './deps.js';
import { migrationPath } from './deps.js';
import { MIGRATION_DIAGNOSTIC_CODES } from './migration.js';
import type { MigrationDiagnosticCode } from './migration.js';
import type { MigrationMetadataStore } from './migration-store.js';

/**
 * The startup schema-compatibility gate (spec11 §11-12, hardened by spec11.1 §4-14).
 *
 * Before an authority serves any traffic it establishes the relationship between what the
 * graph declares — a semantic schema version and fingerprint — and what the provider has
 * durably recorded. **There is no hopeful startup**, and there is **no `compatible` verdict
 * for a relationship that was never checked** (spec11.1 §5): a `compatible` result means
 * compatibility was actually established.
 */
export type SchemaGateStatus =
  /** Stored `(version, fingerprint)` were compared and match. Serving is permitted. */
  | 'compatible'
  /** No stored schema metadata; the provider is stamped at the graph's version. Serving is permitted. */
  | 'fresh'
  /** The graph declares no semantic schema identity and there is no versioned persistence to protect — the gate does not apply. Serving is permitted. */
  | 'not-applicable'
  /** Stored version < required and a complete migration path exists. Serving is refused until the migration runs. */
  | 'migration-required'
  /** A migration lock is held. Serving is refused. */
  | 'migration-in-progress'
  /** Stored version > required, or no migration path to it. Serving is refused. */
  | 'incompatible'
  /** Same version, wrong fingerprint; or persisted data with no metadata and a schema-evolving graph. Serving is refused. */
  | 'corrupted'
  /** Persisted data declares a schema version but the graph does not. Compatibility cannot be established. Serving is refused. */
  | 'schema-identity-required'
  /** The graph declares schema evolution but no metadata store was supplied, so the gate could not run. Serving is refused. */
  | 'schema-metadata-required';

/** Every gate status, for enumeration in tests. */
export const SCHEMA_GATE_STATUSES: readonly SchemaGateStatus[] = [
  'compatible',
  'fresh',
  'not-applicable',
  'migration-required',
  'migration-in-progress',
  'incompatible',
  'corrupted',
  'schema-identity-required',
  'schema-metadata-required',
];

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

/** Whether the graph carries a semantic schema identity that the gate must protect. */
export function declaresSchemaIdentity(ir: {
  schemaVersion?: number;
  migrations?: readonly unknown[];
  schemaFingerprint?: string;
}): boolean {
  return (
    (ir.schemaVersion ?? 1) > 1 ||
    (ir.migrations ?? []).length > 0 ||
    ir.schemaFingerprint !== undefined
  );
}

/**
 * Evaluate the gate against a metadata store. Pure with respect to the graph; it only
 * *reads* the store. `createAxiomServer().start()` refuses to start on any status other than
 * `compatible`, `fresh` or `not-applicable`.
 */
export async function evaluateSchemaGate(
  ir: ServerIR,
  metadata: MigrationMetadataStore,
  context: SchemaGateContext = {},
): Promise<SchemaGateResult> {
  const requiredVersion = ir.schemaVersion ?? 1;
  const requiredFingerprint = ir.schemaFingerprint ?? '';
  const identity = declaresSchemaIdentity(ir);

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

  // --- The graph declares no semantic schema identity ---------------------------------
  if (!identity) {
    if (record !== null && record.schemaVersion > 1) {
      // …but the provider does. Compatibility cannot be established — fail closed
      // (spec11.1 §7). Do not interpret the unversioned graph as safely compatible with v1.
      return {
        status: 'schema-identity-required',
        code: MIGRATION_DIAGNOSTIC_CODES.SCHEMA_IDENTITY_REQUIRED,
        message:
          `persisted data declares semantic schema version ${record.schemaVersion}, but the ` +
          'application does not declare a semantic schema version; compatibility cannot be established',
        requiredVersion,
        persistedVersion: record.schemaVersion,
      };
    }
    // No versioned persistence to protect. The gate genuinely does not apply here — this is
    // NOT `compatible` (spec11.1 §5, §10).
    return {
      status: 'not-applicable',
      message:
        'the application declares no semantic schema identity and the provider records no versioned ' +
        'schema; the migration gate does not apply',
      requiredVersion,
      persistedVersion: record?.schemaVersion ?? null,
    };
  }

  // --- The graph declares a semantic schema identity ---------------------------------
  if (record === null) {
    if (context.hasPersistedData) {
      // Existing persistence whose schema cannot be checked — distinct from a fresh domain
      // (spec11.1 §9). Fail closed.
      return {
        status: 'corrupted',
        code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_STATE_CORRUPTED,
        message:
          'persisted data is present but the provider has no schema metadata, and the graph ' +
          `requires semantic schema ${requiredVersion}; compatibility cannot be established`,
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

/**
 * The verdict a caller with no metadata store gets. A schema-evolving graph with no store
 * is `schema-metadata-required` — the gate could not run, so it is refused (spec11.1 §8).
 * A graph with no schema identity is `not-applicable`.
 */
export function schemaGateWithoutStore(ir: ServerIR): SchemaGateResult {
  const requiredVersion = ir.schemaVersion ?? 1;
  if (declaresSchemaIdentity(ir)) {
    return {
      status: 'schema-metadata-required',
      code: MIGRATION_DIAGNOSTIC_CODES.SCHEMA_METADATA_REQUIRED,
      message:
        'the application declares semantic schema evolution, but no migrationMetadata store was ' +
        'supplied; the startup schema gate could not run',
      requiredVersion,
      persistedVersion: null,
    };
  }
  return {
    status: 'not-applicable',
    message: 'the application declares no semantic schema identity; the migration gate does not apply',
    requiredVersion,
    persistedVersion: null,
  };
}

/** Whether a gate result permits the authority to start serving. */
export function gateAllowsStart(result: SchemaGateResult): boolean {
  return (
    result.status === 'compatible' ||
    result.status === 'fresh' ||
    result.status === 'not-applicable'
  );
}
