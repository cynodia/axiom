import type { ServerIR } from './deps.js';
import { MIGRATION_DIAGNOSTIC_CODES } from './migration.js';
import type { MigrationDiagnosticCode, SemanticMigrationPlan } from './migration.js';
import { planMigration } from './migration.js';
import type { MigrationMetadataStore } from './migration-store.js';
import type { MigrationDataset, MigrationRowStore } from './migration-row-store.js';
import { runMigration } from './migration-executor.js';
import type { RunMigrationResult } from './migration-executor.js';
import { evaluateSchemaGate } from './migration-gate.js';
import type { SchemaGateResult } from './migration-gate.js';

/**
 * Migration execution (spec11 §55, §73, §74).
 *
 * `executeMigration` is a **host-controlled operation**, not a `ServerRequest` branch: there
 * is no path from a client through the semantic protocol that runs a migration. It requires
 * an explicit `MigrationPrincipal` the host constructs — naming a migration id over the
 * wire does nothing (spec11 §73). Data loss additionally requires `approveDestructive`
 * (spec11 §21).
 *
 * It is a thin orchestrator: resolve the persisted version, `planMigration`, `runMigration`,
 * and report the plan, the run result and the post-run gate verdict together.
 */

/**
 * The authority to run a migration. Deliberately **not** the nullable `PRINCIPAL` an action
 * authorization reads (spec11 §74): it is a distinct, host-minted capability.
 *
 * Authorization is by **provenance, not shape** (spec11.1 §16-17). The object returned by
 * `migrationAuthority()` is registered in a process-private `WeakSet` and frozen;
 * `isMigrationPrincipal` checks membership of that set. An object a consumer builds with the
 * same visible fields — `{ kind: 'axiom.migration-authority', grantedBy: 'operator' }` — or a
 * spread copy `{ ...migrationAuthority('operator') }` is **not** in the set and is rejected.
 * `grantedBy` remains visible as a descriptive audit label; it is not the source of
 * authorization.
 *
 * The capability is process-local (spec11.1 §19) and is never serialized (spec11.1 §18):
 * migration durability lives in the `MigrationMetadataStore`, the lease and the checkpoints,
 * not in a portable token.
 */
export interface MigrationPrincipal {
  readonly kind: 'axiom.migration-authority';
  /** A descriptive audit label — an operator id, a deploy job. Not the source of authorization. */
  readonly grantedBy: string;
}

/** Process-private registry of genuine, host-minted migration capabilities. */
const MINTED_AUTHORITIES = new WeakSet<object>();

/** Mint migration authority. Only a host calls this; the result cannot be reconstructed by shape. */
export function migrationAuthority(grantedBy: string): MigrationPrincipal {
  const principal: MigrationPrincipal = Object.freeze({
    kind: 'axiom.migration-authority' as const,
    grantedBy: String(grantedBy),
  });
  MINTED_AUTHORITIES.add(principal);
  return principal;
}

/** True only for the exact object `migrationAuthority()` returned — provenance, not duck typing. */
export function isMigrationPrincipal(value: unknown): value is MigrationPrincipal {
  return typeof value === 'object' && value !== null && MINTED_AUTHORITIES.has(value as object);
}

export interface ExecuteMigrationOptions {
  ir: ServerIR;
  metadata: MigrationMetadataStore;
  /** The physical rows to migrate — a `MigrationRowStore` or a raw in-memory dataset. */
  rows: MigrationRowStore | MigrationDataset;
  /** Host-minted migration authority. Absent or wrong ⇒ `MIGRATION_NOT_AUTHORIZED`. */
  principal: MigrationPrincipal;
  /** Operation ids the operator approves for data loss (spec11 §21). */
  approveDestructive?: readonly string[];
  /** The version the persisted data is at. Defaults to the metadata store's record. */
  fromVersion?: number;
  batchSize?: number;
  leaseMs?: number;
  holder?: string;
  now?: () => number;
  crashAfter?: (info: { operationIndex: number; rowsProcessed: number; phase: string }) => boolean;
}

export type ExecuteMigrationResult =
  | {
      ok: true;
      plan: SemanticMigrationPlan;
      run: RunMigrationResult & { ok: true };
      gate: SchemaGateResult;
    }
  | {
      ok: false;
      code: MigrationDiagnosticCode;
      message: string;
      plan?: SemanticMigrationPlan;
    };

export async function executeMigration(
  options: ExecuteMigrationOptions,
): Promise<ExecuteMigrationResult> {
  if (!isMigrationPrincipal(options.principal)) {
    return {
      ok: false,
      code: MIGRATION_DIAGNOSTIC_CODES.MIGRATION_NOT_AUTHORIZED,
      message: 'executeMigration requires host-minted migration authority (migrationAuthority())',
    };
  }

  const requiredVersion = options.ir.schemaVersion ?? 1;
  const record = await options.metadata.readSchema();
  const fromVersion = options.fromVersion ?? record?.schemaVersion ?? 1;

  if (fromVersion === requiredVersion) {
    // Nothing to do — surface it as success with an empty plan.
    const planned = planMigration(options.ir, { fromVersion, toVersion: requiredVersion });
    if (!planned.ok) {
      return { ok: false, code: planned.diagnostics[0].code, message: planned.diagnostics[0].message };
    }
    const gate = await evaluateSchemaGate(options.ir, options.metadata);
    return {
      ok: true,
      plan: planned.plan,
      run: { ok: true, phase: 'completed', rowsTransformed: 0, resumed: false, alreadyAtTarget: true },
      gate,
    };
  }

  const planned = planMigration(options.ir, { fromVersion, toVersion: requiredVersion });
  if (!planned.ok) {
    return { ok: false, code: planned.diagnostics[0].code, message: planned.diagnostics[0].message };
  }

  const run = await runMigration(options.ir, planned.plan, options.metadata, options.rows, {
    holder: options.holder ?? `migration-${options.principal.grantedBy}`,
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.crashAfter !== undefined ? { crashAfter: options.crashAfter } : {}),
    approveDestructive: options.approveDestructive ?? [],
  });

  if (!run.ok) {
    return { ok: false, code: run.code, message: run.message, plan: planned.plan };
  }

  const gate = await evaluateSchemaGate(options.ir, options.metadata);
  return { ok: true, plan: planned.plan, run, gate };
}

// ------------------------------------------------------------------------- status

export type MigrationRuntimePhase = 'idle' | 'in-progress' | 'checkpointed';

/** Everything an operator or agent needs to answer "where is the schema?" (spec11 §93). */
export interface MigrationStatus {
  schemaVersion: number | null;
  schemaFingerprint: string | null;
  history: Array<{ migrationId: string; fromSchema: number; toSchema: number; completedAt: number }>;
  lock: { holder: string; acquiredAt: number; leaseExpiresAt: number } | null;
  checkpoint: {
    planId: string;
    operationIndex: number;
    rowsProcessed: number;
    batchCursor: string | null;
  } | null;
  phase: MigrationRuntimePhase;
}

export async function getMigrationStatus(metadata: MigrationMetadataStore): Promise<MigrationStatus> {
  const record = await metadata.readSchema();
  const lock = await metadata.readLock();
  const checkpoint = await metadata.readCheckpoint();
  return {
    schemaVersion: record?.schemaVersion ?? null,
    schemaFingerprint: record?.schemaFingerprint ?? null,
    history: (record?.history ?? []).map((entry) => ({
      migrationId: entry.migrationId,
      fromSchema: entry.fromSchema,
      toSchema: entry.toSchema,
      completedAt: entry.completedAt,
    })),
    lock: lock ? { holder: lock.holder, acquiredAt: lock.acquiredAt, leaseExpiresAt: lock.leaseExpiresAt } : null,
    checkpoint: checkpoint
      ? {
          planId: checkpoint.planId,
          operationIndex: checkpoint.operationIndex,
          rowsProcessed: checkpoint.rowsProcessed,
          batchCursor: checkpoint.batchCursor,
        }
      : null,
    phase: lock ? 'in-progress' : checkpoint ? 'checkpointed' : 'idle',
  };
}
