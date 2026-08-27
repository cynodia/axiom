import type { MigrationDef, MigrationOperation, ServerIR } from './deps.js';
import {
  migrationOperationEntityId,
  migrationOperationExpressions,
  migrationOperationFieldIds,
  migrationOperationReadFieldIds,
  migrationPath,
} from './deps.js';

/**
 * Semantic migration planning and the migration state machine (spec11 §34, §51-56).
 *
 * This module is **pure**: it inspects a `ServerIR` and a persisted schema version and
 * produces a `SemanticMigrationPlan` — what would change, what data moves, what is
 * destructive, what provider capabilities it needs. It never touches persisted data. A
 * `DataProvider` turns the semantic plan into a physical plan (phase 7); `executeMigration`
 * runs it (phase 11).
 */

/** The durable phases a migration moves through (spec11 §34). */
export type MigrationPhase =
  | 'planned'
  | 'approved'
  | 'running'
  | 'checkpointed'
  | 'validating'
  | 'completed'
  | 'failed';

export const MIGRATION_PHASES: readonly MigrationPhase[] = [
  'planned',
  'approved',
  'running',
  'checkpointed',
  'validating',
  'completed',
  'failed',
];

/** Provider migration capabilities a semantic plan may require (spec11 §80). */
export type MigrationProviderCapability =
  | 'atomic-schema-change'
  | 'batched-transform'
  | 'checkpointing'
  | 'rename-field'
  | 'transactional-ddl'
  | 'migration-lock';

export const MIGRATION_PROVIDER_CAPABILITIES: readonly MigrationProviderCapability[] = [
  'atomic-schema-change',
  'batched-transform',
  'checkpointing',
  'rename-field',
  'transactional-ddl',
  'migration-lock',
];

/**
 * Structured migration diagnostics (spec11 §76). Spread into `SERVER_DIAGNOSTIC_CODES` so a
 * migration failure crossing the authority boundary is described the same structured way as
 * any other.
 */
export const MIGRATION_DIAGNOSTIC_CODES = {
  /** Persisted data is at an older schema than the graph requires; a migration must run first (spec11 §12). */
  SCHEMA_MIGRATION_REQUIRED: 'SCHEMA_MIGRATION_REQUIRED',
  /** Persisted data cannot be reconciled with the graph — a newer stored version, or no migration path. */
  SCHEMA_INCOMPATIBLE: 'SCHEMA_INCOMPATIBLE',
  /** A migration is already running (a lock is held with a valid lease). */
  MIGRATION_IN_PROGRESS: 'MIGRATION_IN_PROGRESS',
  /** Stored migration metadata is internally inconsistent — a fingerprint or history mismatch. */
  MIGRATION_STATE_CORRUPTED: 'MIGRATION_STATE_CORRUPTED',
  /** No contiguous `MigrationDef` chain connects the persisted version to the required one. */
  MIGRATION_PATH_NOT_FOUND: 'MIGRATION_PATH_NOT_FOUND',
  /** The plan contains destructive operations and the execution call did not approve them (spec11 §21). */
  MIGRATION_APPROVAL_REQUIRED: 'MIGRATION_APPROVAL_REQUIRED',
  /** Reported for each destructive operation surfaced by planning (spec11 §20). */
  MIGRATION_DESTRUCTIVE: 'MIGRATION_DESTRUCTIVE',
  /** The configured provider cannot execute a capability the plan requires — refused before any write (spec11 §79). */
  MIGRATION_PROVIDER_UNSUPPORTED: 'MIGRATION_PROVIDER_UNSUPPORTED',
  /** A transform expression threw or produced a value that does not satisfy the target field. */
  MIGRATION_TRANSFORM_FAILED: 'MIGRATION_TRANSFORM_FAILED',
  /** Post-migration validation found persisted data that does not satisfy the target schema (spec11 §37). */
  MIGRATION_VALIDATION_FAILED: 'MIGRATION_VALIDATION_FAILED',
  /** A resume was attempted from a checkpoint that does not match the current plan or fingerprint. */
  MIGRATION_CHECKPOINT_INVALID: 'MIGRATION_CHECKPOINT_INVALID',
  /** The persisted schema fingerprint does not match the origin of the resolved migration path. */
  MIGRATION_FINGERPRINT_MISMATCH: 'MIGRATION_FINGERPRINT_MISMATCH',
  /** The caller is not the host-controlled migration principal (spec11 §73, §74). */
  MIGRATION_NOT_AUTHORIZED: 'MIGRATION_NOT_AUTHORIZED',
  /** A migration failed for a reason not covered by a more specific code; the target version was not committed. */
  MIGRATION_FAILED: 'MIGRATION_FAILED',
} as const;

export type MigrationDiagnosticCode =
  (typeof MIGRATION_DIAGNOSTIC_CODES)[keyof typeof MIGRATION_DIAGNOSTIC_CODES];

/** One operation the plan will discard information with (spec11 §20). */
export interface DestructiveChange {
  operationId: string;
  kind: MigrationOperation['kind'];
  entityId?: string;
  fieldIds: string[];
  reason: string;
}

/** One record/field transformation the plan will run (spec11 §17, §24, §52). */
export interface PlannedTransformation {
  operationId: string;
  kind: MigrationOperation['kind'];
  entityId?: string;
  writesFields: string[];
  readsFields: string[];
  /** True when the transform is applied row by row and therefore batched (spec11 §30). */
  batched: boolean;
}

export interface MigrationPlanStep {
  migrationId: string;
  fromSchema: number;
  toSchema: number;
  operations: MigrationOperation[];
}

/**
 * The inspectable semantic plan (spec11 §52). Everything a tool or an agent needs to
 * explain a proposed upgrade, without reading provider source.
 */
export interface SemanticMigrationPlan {
  fromVersion: number;
  toVersion: number;
  targetFingerprint?: string;
  steps: MigrationPlanStep[];
  operationCount: number;
  affectedEntities: string[];
  affectedFields: string[];
  destructive: DestructiveChange[];
  transformations: PlannedTransformation[];
  providerCapabilitiesRequired: MigrationProviderCapability[];
  reversibility: 'reversible' | 'irreversible' | 'reverse-supplied' | 'mixed';
  /** True when any operation discards persisted information — `executeMigration` needs approval (spec11 §21). */
  hasDataLoss: boolean;
}

export interface MigrationPlanDiagnostic {
  code: MigrationDiagnosticCode;
  message: string;
  details?: Record<string, unknown>;
}

export type PlanMigrationResult =
  | { ok: true; plan: SemanticMigrationPlan }
  | { ok: false; diagnostics: MigrationPlanDiagnostic[] };

const TRANSFORM_KINDS = new Set<MigrationOperation['kind']>([
  'add-field',
  'populate-field',
  'transform-field',
  'transform-record',
]);

/** Whether an operation carries a transform expression that runs per row. */
function isRowTransform(operation: MigrationOperation): boolean {
  if (operation.kind === 'add-field') {
    return operation.populate !== undefined;
  }
  return TRANSFORM_KINDS.has(operation.kind);
}

function destructiveReason(operation: MigrationOperation): string | undefined {
  switch (operation.kind) {
    case 'remove-field':
      return 'the field and every stored value in it are dropped';
    case 'remove-entity':
      return 'the entity and all of its rows are dropped';
    case 'transform-record':
      return operation.removesFields && operation.removesFields.length > 0
        ? `fields ${operation.removesFields.join(', ')} are dropped by the record transform`
        : operation.destructive === true
          ? 'the record transform is marked as discarding information'
          : undefined;
    case 'transform-field':
    case 'change-field':
      return operation.destructive === true ? 'a narrowing representation change' : undefined;
    default:
      return operation.destructive === true ? 'marked destructive by the author' : undefined;
  }
}

/** The provider capabilities a set of operations needs (spec11 §80). */
export function migrationProviderCapabilitiesRequired(
  operations: readonly MigrationOperation[],
): MigrationProviderCapability[] {
  const needed = new Set<MigrationProviderCapability>();
  for (const operation of operations) {
    if (isRowTransform(operation)) {
      needed.add('batched-transform');
      needed.add('checkpointing');
    } else {
      needed.add('atomic-schema-change');
    }
  }
  return MIGRATION_PROVIDER_CAPABILITIES.filter((capability) => needed.has(capability));
}

export interface PlanMigrationOptions {
  /** The schema version the persisted data is currently at. */
  fromVersion: number;
  /** Defaults to the document's `schemaVersion`. */
  toVersion?: number;
}

/**
 * Build the semantic migration plan from a document and a persisted version (spec11 §54).
 * Pure — it performs no I/O and mutates nothing. A gap in the chain is
 * `MIGRATION_PATH_NOT_FOUND`; a persisted version ahead of the target is `SCHEMA_INCOMPATIBLE`.
 */
export function planMigration(ir: ServerIR, options: PlanMigrationOptions): PlanMigrationResult {
  const target = options.toVersion ?? ir.schemaVersion ?? 1;
  const from = options.fromVersion;

  if (from === target) {
    return {
      ok: true,
      plan: emptyPlan(from, target, ir.schemaFingerprint),
    };
  }
  if (from > target) {
    return {
      ok: false,
      diagnostics: [
        {
          code: MIGRATION_DIAGNOSTIC_CODES.SCHEMA_INCOMPATIBLE,
          message: `Persisted data is at schema ${from}, ahead of the graph's schema ${target} — this build cannot serve it`,
          details: { from, target },
        },
      ],
    };
  }

  const migrations = (ir.migrations ?? []) as MigrationDef[];
  const path = migrationPath(migrations, from, target);
  if (path === null) {
    return {
      ok: false,
      diagnostics: [
        {
          code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_PATH_NOT_FOUND,
          message: `No contiguous migration chain connects persisted schema ${from} to required schema ${target}`,
          details: { from, target },
        },
      ],
    };
  }

  const steps: MigrationPlanStep[] = path.map((migration) => ({
    migrationId: String(migration.id),
    fromSchema: migration.fromSchema,
    toSchema: migration.toSchema,
    operations: migration.operations,
  }));
  const operations = steps.flatMap((step) => step.operations);

  const affectedEntities = new Set<string>();
  const affectedFields = new Set<string>();
  const destructive: DestructiveChange[] = [];
  const transformations: PlannedTransformation[] = [];

  for (const operation of operations) {
    const entityId = migrationOperationEntityId(operation);
    if (entityId) {
      affectedEntities.add(String(entityId));
    }
    const fieldIds = migrationOperationFieldIds(operation).map(String);
    for (const fieldId of fieldIds) {
      affectedFields.add(fieldId);
    }
    const reason = destructiveReason(operation);
    if (reason) {
      destructive.push({
        operationId: String(operation.id),
        kind: operation.kind,
        entityId: entityId ? String(entityId) : undefined,
        fieldIds,
        reason,
      });
    }
    if (isRowTransform(operation) || operation.kind === 'transform-record') {
      transformations.push({
        operationId: String(operation.id),
        kind: operation.kind,
        entityId: entityId ? String(entityId) : undefined,
        writesFields: fieldIds,
        readsFields: migrationOperationReadFieldIds(operation).map(String),
        batched: true,
      });
    }
  }

  const reversibilityValues = new Set(
    path.map((migration) => migration.reversibility ?? 'irreversible'),
  );
  const reversibility: SemanticMigrationPlan['reversibility'] =
    reversibilityValues.size === 1
      ? ([...reversibilityValues][0] as SemanticMigrationPlan['reversibility'])
      : 'mixed';

  return {
    ok: true,
    plan: {
      fromVersion: from,
      toVersion: target,
      targetFingerprint: ir.schemaFingerprint,
      steps,
      operationCount: operations.length,
      affectedEntities: [...affectedEntities].sort(),
      affectedFields: [...affectedFields].sort(),
      destructive,
      transformations,
      providerCapabilitiesRequired: migrationProviderCapabilitiesRequired(operations),
      reversibility,
      hasDataLoss: destructive.length > 0,
    },
  };
}

function emptyPlan(from: number, target: number, fingerprint?: string): SemanticMigrationPlan {
  return {
    fromVersion: from,
    toVersion: target,
    targetFingerprint: fingerprint,
    steps: [],
    operationCount: 0,
    affectedEntities: [],
    affectedFields: [],
    destructive: [],
    transformations: [],
    providerCapabilitiesRequired: [],
    reversibility: 'reversible',
    hasDataLoss: false,
  };
}

/**
 * The agent-friendly semantic explanation of a plan (spec11 §56). No provider detail, no
 * SQL — the step-by-step account of what changes and what is destructive.
 */
export function explainMigration(plan: SemanticMigrationPlan): string {
  const lines: string[] = [];
  lines.push(`Current schema: ${plan.fromVersion}`);
  lines.push(`Target schema:  ${plan.toVersion}`);
  if (plan.steps.length === 0) {
    lines.push('');
    lines.push('Already at the target schema — nothing to migrate.');
    return lines.join('\n');
  }
  lines.push('');
  for (const step of plan.steps) {
    lines.push(`${step.fromSchema} → ${step.toSchema}  (${step.migrationId})`);
    for (const operation of step.operations) {
      lines.push(`  ${describeOperation(operation)}`);
    }
    const stepDestructive = plan.destructive.filter((change) =>
      step.operations.some((operation) => String(operation.id) === change.operationId),
    );
    if (stepDestructive.length > 0) {
      lines.push('  DESTRUCTIVE — explicit approval required');
      for (const change of stepDestructive) {
        lines.push(`    - ${change.reason}`);
      }
    } else {
      lines.push('  Non-destructive');
    }
    lines.push('');
  }
  lines.push(
    plan.providerCapabilitiesRequired.length > 0
      ? `Provider capabilities required: ${plan.providerCapabilitiesRequired.join(', ')}`
      : 'Provider capabilities required: none',
  );
  lines.push(`Reversibility: ${plan.reversibility}`);
  return lines.join('\n').trimEnd();
}

function describeOperation(operation: MigrationOperation): string {
  switch (operation.kind) {
    case 'add-entity':
      return `Add entity ${operation.entity.id}`;
    case 'remove-entity':
      return `Remove entity ${operation.entityId}`;
    case 'add-field':
      return `Add field ${operation.field.id} to ${operation.entityId}${
        operation.field.required ? ' (required)' : ''
      }${operation.populate ? ', populated by expression' : ''}`;
    case 'remove-field':
      return `Remove field ${operation.fieldId} from ${operation.entityId}`;
    case 'change-field':
      return `Change field ${operation.fieldId} on ${operation.entityId}`;
    case 'populate-field':
      return `Populate field ${operation.fieldId} on ${operation.entityId} from expression`;
    case 'transform-field':
      return `Transform field ${operation.fieldId} on ${operation.entityId}`;
    case 'transform-record':
      return `Transform every ${operation.entityId} record`;
    case 'add-relationship':
      return `Add relationship ${operation.relationship.id}`;
    case 'remove-relationship':
      return `Remove relationship ${operation.relationshipId}`;
    default:
      return 'Unknown operation';
  }
}

// Referenced by phase 7+ so the transform-leaf walk stays consistent between planning and
// execution.
export { migrationOperationExpressions };
