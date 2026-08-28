import type { EntityDef, Expression, LiteralValue, MigrationOperation, ServerIR } from './deps.js';
import {
  MigrationTransformError,
  evaluateMigrationExpression,
  migrationRowScope,
} from './migration-eval.js';
import { MIGRATION_DIAGNOSTIC_CODES } from './migration.js';
import type { MigrationDiagnosticCode, SemanticMigrationPlan } from './migration.js';
import type { MigrationMetadataStore } from './migration-store.js';
import type { MigrationDataset, MigrationRowStore } from './migration-row-store.js';
import { createMemoryRowStore } from './migration-row-store.js';

/**
 * The migration executor (spec11 §55, §81).
 *
 * It runs a `SemanticMigrationPlan` against a {@link MigrationRowStore} with the guarantees
 * a durable provider must give: **keyset-batched** row transforms that never materialize a
 * whole table (spec11 §29, §30), a **durable checkpoint** after every batch so a crash
 * resumes rather than restarts (spec11 §31, §32), **semantic idempotency** — re-running a
 * completed migration, or resuming after a crash, produces the identical target data
 * (spec11 §35) — **no destructive write without explicit approval** (spec11 §21, §106), and
 * a target schema version committed only after post-migration validation passes
 * (spec11 §37).
 *
 * The same function drives the in-memory reference store and the SQLite store, which is
 * what makes memory/SQLite parity a property of the row store rather than of the executor
 * (spec11 §83).
 */

export type { MigrationDataset, MigrationRowStore } from './migration-row-store.js';
export { createMemoryRowStore } from './migration-row-store.js';

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
   * checkpoint is durably written, simulating a process kill mid-migration.
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
  | { ok: true; phase: 'completed'; rowsTransformed: number; resumed: boolean; alreadyAtTarget: boolean }
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

interface TransformSpec {
  expression: Expression;
  /** For a single-field transform, the field it writes. */
  fieldId?: string;
  /** For `transform-record`, whether the produced object's keys are written verbatim. */
  record: boolean;
  removes: string[];
  adds: string[];
}

function transformFor(operation: MigrationOperation): TransformSpec {
  switch (operation.kind) {
    case 'populate-field':
      return { expression: operation.value, fieldId: String(operation.fieldId), record: false, removes: [], adds: [] };
    case 'transform-field':
      return {
        expression: operation.expression,
        fieldId: String(operation.fieldId),
        record: false,
        removes: [],
        adds: [],
      };
    case 'add-field':
      return {
        expression: operation.populate as Expression,
        fieldId: String(operation.field.id),
        record: false,
        removes: [],
        adds: [String(operation.field.id)],
      };
    case 'transform-record':
      return {
        expression: operation.produce,
        record: true,
        removes: (operation.removesFields ?? []).map(String),
        adds: (operation.addsFields ?? []).map(String),
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

function entityOf(ir: ServerIR, entityId: string): EntityDef | undefined {
  return ir.entities.find((candidate) => String(candidate.id) === entityId) as EntityDef | undefined;
}

function identityFieldId(ir: ServerIR, entityId: string): string | undefined {
  const entity = entityOf(ir, entityId);
  return entity?.identityFieldId ? String(entity.identityFieldId) : undefined;
}

/** Apply a schema-level operation to the row store. Idempotent (spec11 §35). */
async function applySchemaOperation(store: MigrationRowStore, operation: MigrationOperation): Promise<void> {
  switch (operation.kind) {
    case 'add-entity':
      await store.addEntity(String(operation.entity.id));
      return;
    case 'remove-entity':
      await store.removeEntity(String(operation.entityId));
      return;
    case 'add-field':
      await store.addColumn(String(operation.entityId), String(operation.field.id));
      return;
    case 'remove-field':
      await store.dropColumn(String(operation.entityId), String(operation.fieldId));
      return;
    // change-field / add-relationship / remove-relationship: no physical row change here.
    default:
  }
}

export async function runMigration(
  ir: ServerIR,
  plan: SemanticMigrationPlan,
  metadata: MigrationMetadataStore,
  target: MigrationRowStore | MigrationDataset,
  options: RunMigrationOptions,
): Promise<RunMigrationResult> {
  const store: MigrationRowStore =
    'readBatch' in target ? (target as MigrationRowStore) : createMemoryRowStore(target as MigrationDataset);
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

  // --- Take the migration lock (spec11 §66) -----------------------------------------
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
    const resumeCursor: LiteralValue | null = checkpoint?.batchCursor
      ? (JSON.parse(checkpoint.batchCursor) as LiteralValue)
      : null;
    const resumeRows = checkpoint?.rowsProcessed ?? 0;
    const resumed = checkpoint !== null;
    let rowsTransformed = 0;

    for (let i = resumeIndex; i < operations.length; i += 1) {
      const operation = operations[i];

      if (!isRowTransform(operation)) {
        await applySchemaOperation(store, operation);
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
      const identity = identityFieldId(ir, entityId);
      if (!identity) {
        return {
          ok: false,
          phase: 'failed',
          code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_FAILED,
          message: `entity ${entityId} has no identity field; a batched transform needs one to page deterministically`,
        };
      }
      const spec = transformFor(operation);
      const constants = constantsOf(operation);
      for (const column of spec.adds) {
        await store.addColumn(entityId, column);
      }

      let cursor: LiteralValue | null = i === resumeIndex ? resumeCursor : null;
      let processed = i === resumeIndex ? resumeRows : 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await store.readBatch(entityId, identity, cursor, batchSize);
        if (batch.length === 0) break;
        const updates = batch.map((row) => {
          const produced = evaluateMigrationExpression(spec.expression, migrationRowScope(row, constants));
          if (spec.record) {
            if (produced === null || typeof produced !== 'object' || Array.isArray(produced)) {
              throw new MigrationTransformError('transform-record.produce did not evaluate to a record');
            }
            return { identity: row[identity], values: produced as Record<string, LiteralValue> };
          }
          return { identity: row[identity], values: { [spec.fieldId as string]: produced as LiteralValue } };
        });
        await store.writeBatch(entityId, identity, updates);
        cursor = batch[batch.length - 1][identity];
        processed += batch.length;
        rowsTransformed += batch.length;
        await metadata.writeCheckpoint({
          planId: id,
          targetFingerprint: plan.targetFingerprint ?? '',
          operationIndex: i,
          batchCursor: JSON.stringify(cursor ?? null),
          rowsProcessed: processed,
          updatedAt: now(),
        });
        await metadata.renewLock(token, leaseMs);
        if (options.crashAfter?.({ operationIndex: i, rowsProcessed: processed, phase: 'transform' })) {
          throw new MigrationCrash();
        }
        if (batch.length < batchSize) break;
      }

      for (const column of spec.removes) {
        await store.dropColumn(entityId, column);
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
    for (const entityId of plan.affectedEntities) {
      const entity = entityOf(ir, entityId);
      if (!entity) continue;
      const required = entity.fields
        .filter((fieldDef) => fieldDef.required === true)
        .map((fieldDef) => String(fieldDef.id));
      const violation = await store.requiredFieldViolation(
        entityId,
        required,
        entity.identityFieldId ? String(entity.identityFieldId) : undefined,
      );
      if (violation) {
        return {
          ok: false,
          phase: 'failed',
          code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_VALIDATION_FAILED,
          message: violation,
        };
      }
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
