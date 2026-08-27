/**
 * The durable state a persistence provider must record for schema evolution (spec11 §10,
 * §31, §34, §66, §67).
 *
 * Four things live here and nowhere else:
 *
 * - the **current semantic schema version** and **fingerprint** the persisted data is at;
 * - a **history** of completed migration steps, so a resume knows what already ran;
 * - a **migration lock** with a lease, so two authority instances cannot run the same
 *   migration at once (spec11 §66) and a crashed owner cannot brick the application
 *   (spec11 §67);
 * - a **checkpoint** for a long batched migration, so a crash mid-transform resumes rather
 *   than restarts (spec11 §31).
 *
 * `MigrationMetadataStore` is the contract. `createMemoryMigrationStore` is the
 * deterministic reference implementation; a SQLite-backed one lives with that provider.
 */

/** What the provider durably knows about the schema its data is at. */
export interface MigrationSchemaRecord {
  schemaVersion: number;
  schemaFingerprint: string;
  history: MigrationHistoryEntry[];
  /** Deterministic host time of the last write, for observation only — never a migration input. */
  updatedAt: number;
}

export interface MigrationHistoryEntry {
  migrationId: string;
  fromSchema: number;
  toSchema: number;
  operationIds: string[];
  completedAt: number;
}

/**
 * A held migration lock. `token` is opaque and must be presented to renew or release it;
 * `leaseExpiresAt` is a deterministic host time after which any instance may reclaim it
 * (spec11 §67).
 */
export interface MigrationLock {
  holder: string;
  token: string;
  acquiredAt: number;
  leaseExpiresAt: number;
}

/** Resume state for a long batched migration (spec11 §31). */
export interface MigrationCheckpoint {
  /** Identifies the plan this checkpoint belongs to — a resume against a different plan is rejected. */
  planId: string;
  /** The schema fingerprint the plan targets; a mismatch invalidates the checkpoint. */
  targetFingerprint: string;
  /** Index into the plan's operation list of the operation currently in progress. */
  operationIndex: number;
  /** Provider-opaque continuation position within that operation's batched transform. */
  batchCursor: string | null;
  /** Rows transformed so far by the current operation — for observation and idempotency checks. */
  rowsProcessed: number;
  updatedAt: number;
}

export interface AcquireLockResult {
  ok: boolean;
  lock?: MigrationLock;
  /** When `ok` is false: the lock currently held, so a caller can report who owns it. */
  heldBy?: MigrationLock;
}

/**
 * The durable metadata contract. Every method is async so a real adapter can persist; the
 * memory implementation resolves synchronously.
 */
export interface MigrationMetadataStore {
  /** The recorded schema, or `null` if the store has never been stamped (a fresh database). */
  readSchema(): Promise<MigrationSchemaRecord | null>;
  /** Stamp the schema version + fingerprint. Called once, when a migration (or a fresh start) commits it. */
  writeSchema(schemaVersion: number, schemaFingerprint: string): Promise<void>;
  /** Append one completed step to the history, atomically with nothing else. */
  appendHistory(entry: MigrationHistoryEntry): Promise<void>;

  /** Try to take the lock. Succeeds when free or when the current lease has expired (spec11 §67). */
  acquireLock(holder: string, leaseMs: number): Promise<AcquireLockResult>;
  /** Extend a lease. Fails if the token is not the current holder's. */
  renewLock(token: string, leaseMs: number): Promise<boolean>;
  /** Release the lock. A no-op if the token is stale. */
  releaseLock(token: string): Promise<void>;
  /** The lock as it currently stands, or `null` if free / expired. */
  readLock(): Promise<MigrationLock | null>;

  readCheckpoint(): Promise<MigrationCheckpoint | null>;
  writeCheckpoint(checkpoint: MigrationCheckpoint): Promise<void>;
  clearCheckpoint(): Promise<void>;
}

export interface MemoryMigrationStoreOptions {
  seed?: MigrationSchemaRecord | null;
  /** Deterministic clock. Defaults to `Date.now`; conformance and tests inject a fake. */
  now?: () => number;
  /** Deterministic token source. Defaults to a counter; a real adapter uses a random nonce. */
  nextToken?: () => string;
}

/**
 * Deterministic in-memory reference implementation (spec11 §81). With an injected clock and
 * token source it is fully reproducible, which is what the conformance fixtures require.
 */
export function createMemoryMigrationStore(
  options: MemoryMigrationStoreOptions = {},
): MigrationMetadataStore {
  const now = options.now ?? (() => Date.now());
  let tokenCounter = 0;
  const nextToken = options.nextToken ?? (() => `lock-${(tokenCounter += 1)}`);

  let schema: MigrationSchemaRecord | null = options.seed
    ? { ...options.seed, history: [...options.seed.history] }
    : null;
  let lock: MigrationLock | null = null;
  let checkpoint: MigrationCheckpoint | null = null;

  const lockIsLive = (): boolean => lock !== null && lock.leaseExpiresAt > now();

  return {
    async readSchema() {
      return schema ? { ...schema, history: schema.history.map((entry) => ({ ...entry })) } : null;
    },
    async writeSchema(schemaVersion, schemaFingerprint) {
      schema = {
        schemaVersion,
        schemaFingerprint,
        history: schema?.history ?? [],
        updatedAt: now(),
      };
    },
    async appendHistory(entry) {
      const base: MigrationSchemaRecord =
        schema ??
        ({
          schemaVersion: entry.fromSchema,
          schemaFingerprint: '',
          history: [],
          updatedAt: now(),
        } satisfies MigrationSchemaRecord);
      // Idempotent: appending a step already recorded is a no-op (spec11 §35).
      if (base.history.some((existing) => existing.migrationId === entry.migrationId)) {
        schema = base;
        return;
      }
      schema = { ...base, history: [...base.history, { ...entry }], updatedAt: now() };
    },

    async acquireLock(holder, leaseMs) {
      if (lockIsLive()) {
        return { ok: false, heldBy: { ...(lock as MigrationLock) } };
      }
      const acquiredAt = now();
      lock = {
        holder,
        token: nextToken(),
        acquiredAt,
        leaseExpiresAt: acquiredAt + leaseMs,
      };
      return { ok: true, lock: { ...lock } };
    },
    async renewLock(token, leaseMs) {
      if (lock === null || lock.token !== token || !lockIsLive()) {
        return false;
      }
      lock = { ...lock, leaseExpiresAt: now() + leaseMs };
      return true;
    },
    async releaseLock(token) {
      if (lock !== null && lock.token === token) {
        lock = null;
      }
    },
    async readLock() {
      return lockIsLive() ? { ...(lock as MigrationLock) } : null;
    },

    async readCheckpoint() {
      return checkpoint ? { ...checkpoint } : null;
    },
    async writeCheckpoint(next) {
      checkpoint = { ...next, updatedAt: now() };
    },
    async clearCheckpoint() {
      checkpoint = null;
    },
  };
}
