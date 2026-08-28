import type { IntegrationOperationDef, NodeId, StorageDef } from './deps.js';
import type { ServerHost } from './host.js';
import type { IntegrationAdapterRegistry } from './integration.js';
import type { BlobStorageRegistry } from './blobs.js';
import { blobRef } from './blobs.js';
import type { EffectRecord, PersistenceAdapter } from './persistence.js';
import type { IntegrationResult } from './integration.js';

/**
 * Everything one physical effect attempt needs, independent of *who* runs it or *how many*
 * times. Shared by the single-authority {@link createEffectRunner} and the multi-authority
 * distributed runner (spec12 §14) so the two can never diverge on what "perform this effect"
 * means.
 */
export interface EffectExecutionDeps {
  adapters: IntegrationAdapterRegistry;
  integrationOperations: Record<NodeId, IntegrationOperationDef>;
  blobStores?: BlobStorageRegistry;
  storages?: Record<NodeId, StorageDef>;
}

/**
 * The graph-owned retry policy for an effect record — `operation.retry` for an integration
 * effect, `storage.retry` for a blob effect. Infrastructure may tune cadence and batching
 * but MUST NOT change this (spec12 §20).
 */
export function effectRetryPolicy(
  record: EffectRecord,
  deps: EffectExecutionDeps,
): IntegrationOperationDef['retry'] {
  if (record.storage) {
    return deps.storages?.[record.storage.storageId]?.retry;
  }
  return deps.integrationOperations[record.operationId]?.retry;
}

/**
 * Perform exactly **one** physical attempt of an effect and return its outcome. No retry
 * loop, no durable status write, no event dispatch — the caller owns all of that. A storage
 * effect goes to its blob store; an integration effect goes to its adapter with the
 * Axiom-supplied idempotency key (spec12 §16), so at-least-once physical execution collapses
 * to exactly-once at an idempotent provider (spec12 §15).
 *
 * Missing operation / adapter / store are returned as non-retryable failures rather than
 * thrown, so every caller classifies them the same way.
 */
export async function performEffectAttempt(
  record: EffectRecord,
  deps: EffectExecutionDeps,
): Promise<IntegrationResult> {
  const blobStores = deps.blobStores ?? {};

  if (record.storage) {
    const storage = record.storage;
    const store = blobStores[storage.storageId];
    if (!store) {
      return {
        ok: false,
        code: 'BLOB_STORE_MISSING',
        message: `No blob store registered for ${storage.storageId}`,
        retryable: false,
      };
    }
    const outcome =
      storage.operation === 'commit' ? await store.commit(storage.key) : await store.delete(storage.key);
    if (!outcome.ok) {
      return {
        ok: false,
        code: outcome.code,
        message: outcome.message,
        ...(outcome.retryable !== undefined ? { retryable: outcome.retryable } : {}),
      };
    }
    return { ok: true, value: outcome.value === null ? storage.key : blobRef(outcome.value) };
  }

  const operation = deps.integrationOperations[record.operationId];
  if (!operation) {
    return {
      ok: false,
      code: 'UNKNOWN_INTEGRATION_OPERATION',
      message: `No integration operation ${record.operationId}`,
      retryable: false,
    };
  }
  const adapter = deps.adapters[operation.integrationId];
  if (!adapter) {
    return {
      ok: false,
      code: 'INTEGRATION_ADAPTER_MISSING',
      message: `No adapter registered for ${operation.integrationId}`,
      retryable: false,
    };
  }
  return adapter.effect(
    operation,
    record.arguments,
    record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {},
  );
}

export interface EffectRunnerOptions {
  adapters: IntegrationAdapterRegistry;
  integrationOperations: Record<NodeId, IntegrationOperationDef>;
  /** Object stores, for `blob-commit`/`blob-delete` intents. */
  blobStores?: BlobStorageRegistry;
  storages?: Record<NodeId, StorageDef>;
  persistence: PersistenceAdapter;
  host: ServerHost;
  /** Called once an effect reaches `succeeded` or `failed`, to dispatch its declared event. */
  onTerminal(record: EffectRecord): Promise<void>;
  /**
   * Called synchronously once an attempt is durably recorded as `running`, before the
   * adapter is actually invoked — how `AxiomServer.effectLog()`'s in-memory view learns of
   * the transition (spec 8.2 §17-23). Without this, a hung adapter call is indistinguishable
   * from an effect nobody has dispatched yet: both showed `status: 'pending', attempts: 0`
   * in the public log forever, even though the adapter had genuinely been called.
   */
  onRunning?(record: EffectRecord): void;
  report?(event: {
    kind: 'effect-attempted' | 'effect-succeeded' | 'effect-failed';
    effectId: string;
    operationId: NodeId;
    attempt: number;
  }): void;
}

/**
 * Dispatches committed effect intents to their integration adapter, post-commit and never
 * awaited by the invoking request (spec §17,123). Delivery is at-least-once: a retry
 * policy governs how many attempts a failed effect gets, and every attempt — including the
 * first — updates durable status through `persistence.recordEffectAttempt`, so a restart
 * resumes from wherever dispatch left off rather than losing the intent (spec §19,20,96).
 */
export interface EffectRunner {
  /** Dispatches freshly committed effect intents. Fire-and-forget from the caller's view. */
  dispatch(records: EffectRecord[]): void;
}

function delay(host: ServerHost, ms: number): Promise<void> {
  return new Promise((resolve) => {
    host.scheduleOnce(ms, resolve);
  });
}

export function createEffectRunner(options: EffectRunnerOptions): EffectRunner {
  const { adapters, integrationOperations, persistence, host, onTerminal, onRunning, report } = options;
  const blobStores = options.blobStores ?? {};
  const storages = options.storages ?? {};
  const deps: EffectExecutionDeps = { adapters, integrationOperations, blobStores, storages };

  async function run(record: EffectRecord): Promise<void> {
    // A missing operation or adapter is a deployment fault, not a delivery failure: it
    // reaches a terminal `failed` immediately, with no `running` attempt recorded.
    if (!record.storage) {
      const operation = integrationOperations[record.operationId];
      if (!operation) {
        const failed: EffectRecord = {
          ...record,
          status: 'failed',
          lastError: { code: 'UNKNOWN_INTEGRATION_OPERATION', message: `No integration operation ${record.operationId}` },
        };
        await persistence.recordEffectAttempt?.(record.id, failed);
        await onTerminal(failed);
        return;
      }
      if (!adapters[operation.integrationId]) {
        const failed: EffectRecord = {
          ...record,
          status: 'failed',
          lastError: { code: 'INTEGRATION_ADAPTER_MISSING', message: `No adapter registered for ${operation.integrationId}` },
        };
        await persistence.recordEffectAttempt?.(record.id, failed);
        await onTerminal(failed);
        return;
      }
    }

    await runWith(record, effectRetryPolicy(record, deps), () => performEffectAttempt(record, deps));
  }

  /** The shared attempt loop: durable status per attempt, bounded retries, one terminal outcome. */
  async function runWith(
    record: EffectRecord,
    retry: IntegrationOperationDef['retry'],
    call: () => Promise<IntegrationResult>,
  ): Promise<void> {
    const policy = retry ?? { policy: 'none' as const };
    const maxAttempts = policy.policy === 'none' ? 1 : (policy.maxAttempts ?? 3);
    // Deliberately local to this dispatch, not seeded from `record.attempts`: a record
    // found `'running'` at startup means a previous process called the adapter and was
    // never told the outcome (spec §96) — that attempt is unaccounted for, not spent, so
    // resuming it gets a full fresh budget rather than silently going idle at zero
    // remaining attempts. `record.attempts` is still carried forward into what gets
    // persisted, so the historical count across a restart stays honest.
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      const persistedAttempts = record.attempts + attempt;
      await persistence.recordEffectAttempt?.(record.id, { status: 'running', attempts: persistedAttempts });
      onRunning?.({ ...record, status: 'running', attempts: persistedAttempts });
      report?.({ kind: 'effect-attempted', effectId: record.id, operationId: record.operationId, attempt: persistedAttempts });

      const result = await call();

      if (result.ok) {
        const succeeded: EffectRecord = {
          ...record,
          status: 'succeeded',
          attempts: persistedAttempts,
          result: result.value,
        };
        await persistence.recordEffectAttempt?.(record.id, {
          status: 'succeeded',
          attempts: persistedAttempts,
          result: result.value,
        });
        report?.({ kind: 'effect-succeeded', effectId: record.id, operationId: record.operationId, attempt: persistedAttempts });
        await onTerminal(succeeded);
        return;
      }

      const lastError = { code: result.code, message: result.message, retryable: result.retryable };
      const exhausted = attempt >= maxAttempts || result.retryable === false;
      if (exhausted) {
        const failed: EffectRecord = { ...record, status: 'failed', attempts: persistedAttempts, lastError };
        await persistence.recordEffectAttempt?.(record.id, { status: 'failed', attempts: persistedAttempts, lastError });
        report?.({ kind: 'effect-failed', effectId: record.id, operationId: record.operationId, attempt: persistedAttempts });
        await onTerminal(failed);
        return;
      }

      const base = policy.delayMs ?? 1000;
      const waitMs = policy.policy === 'exponential' ? base * 2 ** (attempt - 1) : base;
      await delay(host, waitMs);
    }
  }

  return {
    dispatch(records: EffectRecord[]): void {
      for (const record of records) {
        void run(record);
      }
    },
  };
}
