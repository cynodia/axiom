/**
 * SQLite lock-contention reconciliation (spec11.2 §5, §23, §24).
 *
 * SQLite has a *physical* concurrency model — a single-writer file lock that surfaces as
 * `SQLITE_BUSY` / `SQLITE_LOCKED`. Axiom has a *semantic* concurrency model — one migration
 * owner, competing runners never execute the same transition. When two valid Axiom migration
 * runners race on the same database file, the physical lock must not leak through the
 * provider abstraction: the consumer-visible outcome has to be an Axiom term
 * (`MIGRATION_IN_PROGRESS` / `alreadyAtTarget`), never `ERR_SQLITE_ERROR`.
 *
 * This module is the provider's tool for that reconciliation:
 *
 *  - {@link isSqliteContentionError} recognises *only* the two lock-contention families, by
 *    structured error fields, never by English message text (spec11.2 §23, §24). Malformed
 *    SQL, constraint violations, disk errors and programmer errors stay real failures.
 *  - {@link runWithBusyHandling} wraps a synchronous `node:sqlite` call in a **bounded**
 *    retry, on top of the connection's own `PRAGMA busy_timeout`. It never waits unbounded
 *    and never serialises a whole migration behind SQLite's writer lock (spec11.2 §7).
 *  - {@link SqliteContentionError} is what escapes when the bounded window is exhausted — a
 *    typed marker the migration executor / gate / status paths map to a semantic outcome,
 *    carrying a short protocol-safe cause and never a raw stack (spec11.2 §25).
 */

/**
 * The primary-result SQLite codes for lock contention:
 * `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6). Extended result codes carry the primary code in
 * the low byte (`SQLITE_BUSY_SNAPSHOT = 5 | (2<<8)`, `SQLITE_LOCKED_SHAREDCACHE = 6 | (1<<8)`),
 * so the low byte is what we test.
 */
const CONTENTION_PRIMARY_CODES = new Set([5, 6]);

/** node:sqlite's `Error.code` for every SQLite-originated error. */
const NODE_SQLITE_ERROR_CODE = 'ERR_SQLITE_ERROR';

/** The bounded default busy window, in milliseconds (spec11.2 §22). See the implementation report for the rationale. */
export const DEFAULT_BUSY_TIMEOUT_MS = 2_000;

/** Bounded number of retry attempts on top of `PRAGMA busy_timeout`, and the base backoff. */
export const DEFAULT_BUSY_ATTEMPTS = 4;
export const DEFAULT_BUSY_BACKOFF_MS = 20;

/**
 * A SQLite lock-contention error that survived the bounded busy window. Its presence means
 * "physical contention we could not wait out here" — a caller with migration context decides
 * whether that is `MIGRATION_IN_PROGRESS`, `alreadyAtTarget` or a genuine `MIGRATION_FAILED`.
 */
export class SqliteContentionError extends Error {
  /** Structured marker so `instanceof` survives bundling / realm boundaries. */
  readonly isSqliteContention = true as const;
  readonly sqliteCode: string | undefined;
  readonly sqliteErrcode: number | undefined;
  readonly sqliteErrstr: string | undefined;
  /** How many bounded attempts were made before giving up. */
  readonly attempts: number;

  constructor(cause: unknown, context: string, attempts: number) {
    super(`SQLite lock contention was not resolved within the bounded busy window during ${context}`);
    this.name = 'SqliteContentionError';
    this.attempts = attempts;
    const structured = cause as { code?: unknown; errcode?: unknown; errstr?: unknown } | null;
    this.sqliteCode = typeof structured?.code === 'string' ? structured.code : undefined;
    this.sqliteErrcode = typeof structured?.errcode === 'number' ? structured.errcode : undefined;
    this.sqliteErrstr = typeof structured?.errstr === 'string' ? structured.errstr : undefined;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }

  /**
   * A short, protocol-safe description of the physical reason — for an operator to see that
   * a `MIGRATION_FAILED` was SQLite locking, without a stack trace crossing a protocol
   * surface (spec11.2 §25).
   */
  get providerCause(): string {
    const detail = this.sqliteErrstr ?? this.sqliteCode ?? 'database is locked';
    return this.sqliteErrcode !== undefined
      ? `sqlite: ${detail} (errcode ${this.sqliteErrcode})`
      : `sqlite: ${detail}`;
  }
}

/**
 * True only for a SQLite `SQLITE_BUSY` / `SQLITE_LOCKED` error, recognised by structured
 * fields (`error.code === 'ERR_SQLITE_ERROR'` and the primary result code in
 * `error.errcode`). Never by message text (spec11.2 §23). An already-wrapped
 * {@link SqliteContentionError} also returns true.
 *
 * Everything else — malformed SQL, `SQLITE_CONSTRAINT`, `SQLITE_IOERR`, `SQLITE_CORRUPT`,
 * a `TypeError` from a binding bug — returns false and must be re-thrown untouched.
 */
export function isSqliteContentionError(error: unknown): error is SqliteContentionError | Error {
  if (error instanceof SqliteContentionError) return true;
  if (error === null || typeof error !== 'object') return false;
  const structured = error as { code?: unknown; errcode?: unknown };
  if (structured.code !== NODE_SQLITE_ERROR_CODE) return false;
  if (typeof structured.errcode !== 'number') return false;
  return CONTENTION_PRIMARY_CODES.has(structured.errcode & 0xff);
}

export interface BusyHandlingOptions {
  /** Names the operation, for the {@link SqliteContentionError} message. */
  context: string;
  /** Bounded extra attempts after `PRAGMA busy_timeout` expires. Default {@link DEFAULT_BUSY_ATTEMPTS}. */
  attempts?: number;
  /** Base backoff between attempts, ms; jittered and scaled per attempt. Default {@link DEFAULT_BUSY_BACKOFF_MS}. */
  backoffMs?: number;
  /** Injectable sleep, for deterministic tests. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0, 1). Default `Math.random`. */
  random?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a synchronous `node:sqlite` call, tolerating short lock hand-offs. The connection's
 * `PRAGMA busy_timeout` absorbs the common case; this adds a **bounded** number of retries
 * for the residual (CI scheduling jitter, a slightly longer metadata write). A non-contention
 * error is re-thrown on the first attempt — it is never retried and never swallowed. When the
 * bounded window is exhausted, a {@link SqliteContentionError} is thrown for a migration-aware
 * caller to classify.
 */
export async function runWithBusyHandling<T>(fn: () => T, options: BusyHandlingOptions): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_BUSY_ATTEMPTS);
  const backoff = Math.max(1, options.backoffMs ?? DEFAULT_BUSY_BACKOFF_MS);
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isSqliteContentionError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(backoff * (attempt + 1) + Math.floor(random() * backoff));
      }
    }
  }
  throw new SqliteContentionError(lastError, options.context, attempts);
}
