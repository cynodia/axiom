import type {
  EntityDef,
  Expression,
  LiteralValue,
  MigrationOperation,
  ServerIR,
} from './deps.js';
import { compareScalars } from './query-eval.js';
import {
  MigrationTransformError,
  evaluateMigrationExpression,
  migrationRowScope,
} from './migration-eval.js';
import { MIGRATION_DIAGNOSTIC_CODES } from './migration.js';
import type { MigrationDiagnosticCode, SemanticMigrationPlan } from './migration.js';
import type { MigrationMetadataStore } from './migration-store.js';

/**
 * The deterministic reference migration executor (spec11 §81).
 *
 * It runs a `SemanticMigrationPlan` against an in-memory dataset with the same guarantees a
 * durable provider must give: **batched** row transforms (spec11 §30), a **durable
 * checkpoint** after every batch so a crash resumes rather than restarts (spec11 §31, §32),
 * **semantic idempotency** — re-running a completed migration, or resuming after a crash,
 * produces the identical target data (spec11 §35) — and **no destructive write without
 * explicit approval** (spec11 §21, §106). The target schema version is committed only after
 * post-migration validation passes (spec11 §37).
 *
 * A SQLite executor gives the same guarantees with its own physical mechanism; the
 * conformance fixtures assert both produce equivalent target data (spec11 §83).
 */

/** entity id → its rows, each row keyed by field id. Mutated in place by the executor. */
export interface MigrationDataset {
  rows: Map<string, Array<Record<string, LiteralValue>>>;
}

export interface RunMigrationOptions {
  /** Identifies this authority instance for the migration lock. */
  holder: string;
  /** Lock lease in ms. Default 30000. */
  leaseMs?: number;
  /** Rows per batch for a transform step. Default 500. */
  batchSize?: number;
  /** Operation ids the operator has explicitly approved for data loss (spec11 §21). */
  approveDestructive?: readonly string[];
  /** Deterministic clock. Default `Date.now`. */
  now?: () => number;
  /**
   * Test hook — crash injection (spec11 §32, §101). Return `true` to abort right after the
   * named checkpoint is durably written, simulating a process kill mid-migration.
   */
  crashAfter?: (info: { operationIndex: number; rowsProcessed: number; phase: string }) => boolean;
}

/** Thrown when `crashAfter` fires. The checkpoint is already durable; resume is a re-run. */
export class MigrationCrash extends Error {
  constructor() {
    super('migration crash injected');
    this.name = 'MigrationCrash';
  }
}

export type RunMigrationResult =
  | {
      ok: true;
      phase: 'completed';
      rowsTransformed: number;
      resumed: boolean;
      alreadyAtTarget: boolean;
    }
  | { ok: false; phase: 'failed'; code: MigrationDiagnosticCode; message: string };

function planId(plan: SemanticMigrationPlan): string {
  return `${plan.steps.map((step) => step.migrationId).join('>')}@${plan.fromVersion}->${plan.toVersion}`;
}

function isRowTransform(operation: MigrationOperation): boolean {
  return (
    operation.kind === 'populate-field' ||
    operation.kind === 'transform-field' ||
    operation.kind === 'transform-record' ||
    (operation.kind === 'add-field' && operation.populate !== undefined)
  );
}

function transformFor(operation: MigrationOperation): {
  fieldId?: string;
  expression: Expression;
  record: boolean;
  removes: string[];
} {
  switch (operation.kind) {
    case 'populate-field':
      return { fieldId: String(operation.fieldId), expression: operation.value, record: false, removes: [] };
    case 'transform-field':
      return { fieldId: String(operation.fieldId), expression: operation.expression, record: false, removes: [] };
    case 'add-field':
      return {
        fieldId: String(operation.field.id),
        expression: operation.populate as Expression,
        record: false,
        removes: [],
      };
    case 'transform-record':
      return {
        expression: operation.produce,
        record: true,
        removes: (operation.removesFields ?? []).map(String),
      };
    default:
      throw new MigrationTransformError(`not a row transform: ${operation.kind}`);
  }
}

function constantsOf(operation: MigrationOperation): Record<string, LiteralValue> {
  const list = (operation as { constants?: Array<{ id: unknown; value: LiteralValue }> }).constants ?? [];
  return Object.fromEntries(list.map((constant) => [String(constant.id), constant.value]));
}

function operationEntityId(operation: MigrationOperation): string | undefined {
  switch (operation.kind) {
    case 'add-entity':
      return String(operation.entity.id);
    case 'remove-entity':
    case 'add-field':
    case 'remove-field':
    case 'change-field':
    case 'populate-field':
    case 'transform-field':
    case 'transform-record':
      return String(operation.entityId);
    default:
      return undefined;
  }
}

function identityFieldId(ir: ServerIR, entityId: string): string | undefined {
  const entity = ir.entities.find((candidate) => String(candidate.id) === entityId) as EntityDef | undefined;
  return entity?.identityFieldId ? String(entity.identityFieldId) : undefined;
}

function sortRowsByIdentity(rows: Array<Record<string, LiteralValue>>, identity: string | undefined): void {
  if (!identity) return;
  rows.sort((a, b) => {
    const av = a[identity];
    const bv = b[identity];
    if (av === undefined || av === null || bv === undefined || bv === null) return 0;
    return compareScalars(av as never, bv as never);
  });
}

/** Apply a non-transform (schema-level) operation to the dataset. Idempotent (spec11 §35). */
function applySchemaOperation(dataset: MigrationDataset, operation: MigrationOperation): void {
  switch (operation.kind) {
    case 'add-entity': {
      const key = String(operation.entity.id);
      if (!dataset.rows.has(key)) dataset.rows.set(key, []);
      return;
    }
    case 'remove-entity':
      dataset.rows.delete(String(operation.entityId));
      return;
    case 'remove-field': {
      const rows = dataset.rows.get(String(operation.entityId)) ?? [];
      for (const row of rows) {
        delete row[String(operation.fieldId)];
      }
      return;
    }
    // add-field (no populate), change-field, add/remove-relationship: no row data changes
    // in the memory representation.
    default:
  }
}

function validateTargetData(
  ir: ServerIR,
  dataset: MigrationDataset,
  affectedEntities: readonly string[],
): { valid: boolean; message: string } {
  for (const entityId of affectedEntities) {
    const entity = ir.entities.find((candidate) => String(candidate.id) === entityId) as EntityDef | undefined;
    if (!entity) continue;
    const required = entity.fields.filter((field) => field.required === true).map((field) => String(field.id));
    const identity = entity.identityFieldId ? String(entity.identityFieldId) : undefined;
    const rows = dataset.rows.get(entityId) ?? [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      for (const fieldId of required) {
        if (row[fieldId] === undefined || row[fieldId] === null) {
          return {
            valid: false,
            message: `${entityId}[${index}] is missing required field ${fieldId} after migration`,
          };
        }
      }
      if (identity && (row[identity] === undefined || row[identity] === null)) {
        return { valid: false, message: `${entityId}[${index}] has no identity value after migration` };
      }
    }
  }
  return { valid: true, message: '' };
}

export async function runMigration(
  ir: ServerIR,
  plan: SemanticMigrationPlan,
  metadata: MigrationMetadataStore,
  dataset: MigrationDataset,
  options: RunMigrationOptions,
): Promise<RunMigrationResult> {
  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? 30_000;
  const batchSize = Math.max(1, options.batchSize ?? 500);
  const approved = new Set(options.approveDestructive ?? []);
  const id = planId(plan);

  // --- Idempotency & compatibility, before any lock or write (spec11 §35) --------------
  const current = await metadata.readSchema();
  if (current && current.schemaVersion === plan.toVersion) {
    return { ok: true, phase: 'completed', rowsTransformed: 0, resumed: false, alreadyAtTarget: true };
  }
  if (current && current.schemaVersion !== plan.fromVersion) {
    return {
      ok: false,
      phase: 'failed',
      code: MIGRATION_DIAGNOSTIC_CODES.SCHEMA_INCOMPATIBLE,
      message: `persisted schema ${current.schemaVersion} is not the plan's origin ${plan.fromVersion}`,
    };
  }

  // --- Destructive approval, before any lock or write (spec11 §21, §106) ---------------
  const unapproved = plan.destructive.filter((change) => !approved.has(change.operationId));
  if (unapproved.length > 0) {
    return {
      ok: false,
      phase: 'failed',
      code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_APPROVAL_REQUIRED,
      message: `destructive operations not approved: ${unapproved.map((change) => change.operationId).join(', ')}`,
    };
  }

  // --- Take the migration lock (spec11 §66) -------------------------------------------
  const lockResult = await metadata.acquireLock(options.holder, leaseMs);
  if (!lockResult.ok || !lockResult.lock) {
    return {
      ok: false,
      phase: 'failed',
      code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_IN_PROGRESS,
      message: `a migration is already running, held by ${lockResult.heldBy?.holder ?? 'another instance'}`,
    };
  }
  const token = lockResult.lock.token;

  const operations = plan.steps.flatMap((step) => step.operations);
  const affectedEntities = plan.affectedEntities;

  try {
    const checkpoint = await metadata.readCheckpoint();
    if (checkpoint && checkpoint.planId !== id) {
      return {
        ok: false,
        phase: 'failed',
        code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_CHECKPOINT_INVALID,
        message: 'a checkpoint from a different migration plan is present',
      };
    }
    const resumeIndex = checkpoint?.operationIndex ?? 0;
    const resumeRows = checkpoint?.rowsProcessed ?? 0;
    const resumed = checkpoint !== null;
    let rowsTransformed = 0;

    for (let i = resumeIndex; i < operations.length; i += 1) {
      const operation = operations[i];

      if (!isRowTransform(operation)) {
        applySchemaOperation(dataset, operation);
        await metadata.writeCheckpoint({
          planId: id,
          targetFingerprint: plan.targetFingerprint ?? '',
          operationIndex: i + 1,
          batchCursor: null,
          rowsProcessed: 0,
          updatedAt: now(),
        });
        if (options.crashAfter?.({ operationIndex: i, rowsProcessed: 0, phase: 'schema' })) {
          throw new MigrationCrash();
        }
        continue;
      }

      const entityId = operationEntityId(operation) as string;
      const rows = dataset.rows.get(entityId) ?? [];
      sortRowsByIdentity(rows, identityFieldId(ir, entityId));
      const spec = transformFor(operation);
      const constants = constantsOf(operation);
      const startRow = i === resumeIndex ? resumeRows : 0;

      for (let start = startRow; start < rows.length; start += batchSize) {
        const end = Math.min(start + batchSize, rows.length);
        for (let r = start; r < end; r += 1) {
          const row = rows[r];
          const scope = migrationRowScope(row, constants);
          const produced = evaluateMigrationExpression(spec.expression, scope);
          if (spec.record) {
            if (produced === null || typeof produced !== 'object' || Array.isArray(produced)) {
              throw new MigrationTransformError('transform-record.produce did not evaluate to a record');
            }
            for (const field of spec.removes) {
              delete row[field];
            }
            for (const [key, value] of Object.entries(produced as Record<string, LiteralValue>)) {
              row[key] = value;
            }
          } else {
            row[spec.fieldId as string] = produced as LiteralValue;
          }
        }
        rowsTransformed += end - start;
        await metadata.writeCheckpoint({
          planId: id,
          targetFingerprint: plan.targetFingerprint ?? '',
          operationIndex: i,
          batchCursor: String(end),
          rowsProcessed: end,
          updatedAt: now(),
        });
        await metadata.renewLock(token, leaseMs);
        if (options.crashAfter?.({ operationIndex: i, rowsProcessed: end, phase: 'transform' })) {
          throw new MigrationCrash();
        }
      }

      await metadata.writeCheckpoint({
        planId: id,
        targetFingerprint: plan.targetFingerprint ?? '',
        operationIndex: i + 1,
        batchCursor: null,
        rowsProcessed: 0,
        updatedAt: now(),
      });
    }

    // --- Validate the target, before committing the version (spec11 §37, §39) --------
    const validation = validateTargetData(ir, dataset, affectedEntities);
    if (!validation.valid) {
      return {
        ok: false,
        phase: 'failed',
        code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_VALIDATION_FAILED,
        message: validation.message,
      };
    }

    // --- Commit (spec11 §27, §55) --------------------------------------------------
    await metadata.writeSchema(plan.toVersion, plan.targetFingerprint ?? '');
    for (const step of plan.steps) {
      await metadata.appendHistory({
        migrationId: step.migrationId,
        fromSchema: step.fromSchema,
        toSchema: step.toSchema,
        operationIds: step.operations.map((operation) => String(operation.id)),
        completedAt: now(),
      });
    }
    await metadata.clearCheckpoint();

    return { ok: true, phase: 'completed', rowsTransformed, resumed, alreadyAtTarget: false };
  } catch (error) {
    if (error instanceof MigrationCrash) {
      throw error; // checkpoint is durable; a re-run resumes
    }
    if (error instanceof MigrationTransformError) {
      return {
        ok: false,
        phase: 'failed',
        code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_TRANSFORM_FAILED,
        message: error.message,
      };
    }
    return {
      ok: false,
      phase: 'failed',
      code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_FAILED,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await metadata.releaseLock(token);
  }
}
