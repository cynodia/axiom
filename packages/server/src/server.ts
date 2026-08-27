import {
  DEFAULT_THEME,
  EFFECT_CODE_FIELD,
  EFFECT_CORRELATION_ID_FIELD,
  EFFECT_ID_FIELD,
  EFFECT_IDEMPOTENCY_KEY_FIELD,
  EFFECT_INTEGRATION_ID_FIELD,
  EFFECT_MESSAGE_FIELD,
  EFFECT_OPERATION_ID_FIELD,
  EFFECT_RESULT_FIELD,
  EFFECT_RETRYABLE_FIELD,
  PRINCIPAL,
  SERVER_IR_CONTRACTS,
  allowedInvocationSources,
  optionalType,
  entityType,
  maxContract,
  requiredServerContract,
  serverIRExpressions,
  usesExternalIOVocabulary,
  usesIntegrationVocabulary,
  usesInvocationVocabulary,
  usesV4Semantics,
  validateValueAgainstType,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ApplicationIR,
  EntityDef,
  EventDef,
  Expression,
  IntegrationOperationDef,
  LiteralValue,
  NodeId,
  QueryDef,
  ReadPolicyDef,
  RelationshipDef,
  ServerIR,
  ServerIRContract,
  StateDef,
  StorageDef,
  TriggerDef,
} from '@cynodia/axiom-core';
import {
  queryDefaultPageSize,
  queryIsAggregate,
  queryMaxPageSize,
  queryPaginationStrategy,
} from '@cynodia/axiom-core';
import { MemoryElement, createAxiomRuntime, createMemoryHost, valuesEqual } from '@cynodia/axiom-runtime';
import type { AxiomRuntime, EffectIntentRecord, MutationLogEntry, RuntimeDiagnostic } from '@cynodia/axiom-runtime';
import { createMemoryPersistence } from './persistence.js';
import type { EffectRecord, PersistenceAdapter } from './persistence.js';
import { createServerHost } from './host.js';
import type { ExecutionContext, PrincipalRecord, ServerEvent, ServerHost } from './host.js';
import { createEffectRunner } from './effects.js';
import type { IntegrationAdapter, IntegrationAdapterRegistry, IntegrationResult } from './integration.js';
import { createTriggerRuntime } from './triggers.js';
import type { TriggerRuntime } from './triggers.js';
import { blobRef } from './blobs.js';
import type { BlobStorageRegistry, StoredBlob } from './blobs.js';
import { createSubscriptionRuntime } from './subscriptions.js';
import type { SubscriptionRecord, SubscriptionRuntime } from './subscriptions.js';
import type { SubscriptionAdapterRegistry } from './subscription.js';
import { PROTOCOL_VERSION } from './protocol.js';
import type {
  EventRequest,
  EventResponse,
  InvokeRequest,
  InvokeResponse,
  QueryRequest,
  QueryResponse,
  ServerRequest,
  ServerResponse,
  SnapshotResponse,
  StateSnapshot,
} from './protocol.js';
import type { DataProvider, DataProviderRegistry, ProviderMutation } from './data-provider.js';
import { requiredCapabilities } from './data-provider.js';
import { buildProviderQuery, policyForQuery } from './query-runtime.js';
import {
  diffRows,
  identityValuesToLoad,
  providerEntitiesWritten,
  rewriteForStaging,
  stagingStateDef,
  stagingStateId,
} from './provider-record-runtime.js';
import {
  cursorMatchesContext,
  fingerprint,
  openCursor,
  randomCursorSecret,
  sealCursor,
} from './query-cursor.js';
import type { CursorPayload } from './query-cursor.js';
import { MIGRATION_DIAGNOSTIC_CODES } from './migration.js';

/**
 * Diagnostic codes the authority adds to the runtime vocabulary. They describe failures of
 * the boundary, not of an application rule.
 */
export const SERVER_DIAGNOSTIC_CODES = {
  /** The request named an action this authority does not execute. */
  UNKNOWN_SERVER_ACTION: 'UNKNOWN_SERVER_ACTION',
  /** An argument did not conform to its declared parameter type. */
  ARGUMENT_TYPE_MISMATCH: 'ARGUMENT_TYPE_MISMATCH',
  /** The caller may not invoke this action. */
  AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
  /** Another transaction committed the same state first; nothing was applied. */
  CONCURRENCY_CONFLICT: 'CONCURRENCY_CONFLICT',
  /** The request itself was malformed, or spoke an unknown protocol. */
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  /** The authority could not be reached, or did not answer. */
  AUTHORITY_UNREACHABLE: 'AUTHORITY_UNREACHABLE',
  /** An external effect's adapter reported failure after exhausting its retry policy. */
  EFFECT_FAILED: 'EFFECT_FAILED',
  /** A trigger's target action reported failure, or its arguments failed to evaluate. */
  TRIGGER_INVOCATION_FAILED: 'TRIGGER_INVOCATION_FAILED',
  /** An external event's payload did not conform to its `EventDef.payloadType`. */
  EVENT_PAYLOAD_INVALID: 'EVENT_PAYLOAD_INVALID',
  /** An interval trigger tick fired while the previous invocation was still running. */
  TRIGGER_OVERLAP_SKIPPED: 'TRIGGER_OVERLAP_SKIPPED',
  /** The Server IR requires an integration with no registered adapter. */
  INTEGRATION_ADAPTER_MISSING: 'INTEGRATION_ADAPTER_MISSING',
  /** An event→action→effect→event chain was stopped before it could recurse unboundedly. */
  EVENT_DISPATCH_DEPTH_EXCEEDED: 'EVENT_DISPATCH_DEPTH_EXCEEDED',
  /** A webhook delivery failed provider signature verification and was refused. */
  WEBHOOK_VERIFICATION_FAILED: 'WEBHOOK_VERIFICATION_FAILED',
  /** The Server IR declares a subscription with no registered adapter for its integration. */
  SUBSCRIPTION_ADAPTER_MISSING: 'SUBSCRIPTION_ADAPTER_MISSING',
  /** A subscription's source could not be established, after every reconnect attempt. */
  SUBSCRIPTION_START_FAILED: 'SUBSCRIPTION_START_FAILED',
  /** A delivery was discarded by a declared lossy backpressure policy. Never silent. */
  SUBSCRIPTION_DELIVERY_DROPPED: 'SUBSCRIPTION_DELIVERY_DROPPED',
  /** A delivery's action failed after every permitted attempt. */
  SUBSCRIPTION_DELIVERY_FAILED: 'SUBSCRIPTION_DELIVERY_FAILED',
  /** The Server IR declares an object store with no registered blob adapter. */
  BLOB_STORE_MISSING: 'BLOB_STORE_MISSING',
  /** No object with that key, or the key names a still-staged upload. */
  BLOB_NOT_FOUND: 'BLOB_NOT_FOUND',
  /** The caller may not read, download or upload this object. Possession of a key is not permission. */
  BLOB_ACCESS_DENIED: 'BLOB_ACCESS_DENIED',
  /** An upload exceeded the store's declared `maxSizeBytes`. */
  BLOB_TOO_LARGE: 'BLOB_TOO_LARGE',
  /** An upload's media type is not in the store's declared `acceptedMediaTypes`. */
  BLOB_MEDIA_TYPE_REJECTED: 'BLOB_MEDIA_TYPE_REJECTED',
  /** A `blob-commit` or `blob-delete` failed at the store, after its retry policy. */
  BLOB_OPERATION_FAILED: 'BLOB_OPERATION_FAILED',
  /**
   * The action's `invocation.allowedSources` does not include this invocation's source
   * (spec 8.1 §3-9) — e.g. an ordinary client `InvokeRequest` naming a system-only action.
   * Distinct from `AUTHORIZATION_DENIED`: this is refused before identity is even
   * consulted, because no caller reaching the authority this way may invoke it at all.
   */
  INVOCATION_SOURCE_NOT_ALLOWED: 'INVOCATION_SOURCE_NOT_ALLOWED',

  // Semantic data access & query layer (spec 0.10 §82).
  /** The request named a query this authority does not execute. */
  QUERY_NOT_FOUND: 'QUERY_NOT_FOUND',
  /** An argument was missing, unknown, or did not conform to its declared parameter type. */
  QUERY_ARGUMENT_TYPE_MISMATCH: 'QUERY_ARGUMENT_TYPE_MISMATCH',
  /** The caller may not run this query — no read policy could admit them. */
  QUERY_UNAUTHORIZED: 'QUERY_UNAUTHORIZED',
  /** The configured provider cannot push down a semantic this query requires. Never approximated. */
  QUERY_CAPABILITY_UNSUPPORTED: 'QUERY_CAPABILITY_UNSUPPORTED',
  /** The cursor was tampered with, truncated, or minted for another query / principal / policy. */
  QUERY_CURSOR_INVALID: 'QUERY_CURSOR_INVALID',
  /** The requested page size exceeds the authority's ceiling for this query. */
  QUERY_PAGE_SIZE_EXCEEDED: 'QUERY_PAGE_SIZE_EXCEEDED',
  /** The provider reported a failure executing the query. */
  QUERY_PROVIDER_FAILURE: 'QUERY_PROVIDER_FAILURE',
  /** The provider returned rows that do not conform to the query's declared result shape. */
  QUERY_RESULT_TYPE_MISMATCH: 'QUERY_RESULT_TYPE_MISMATCH',
  /** No `DataProvider` is registered for this query's source entity. */
  QUERY_PROVIDER_MISSING: 'QUERY_PROVIDER_MISSING',

  // Schema evolution & semantic migrations (spec11 §76). Defined in `migration.ts` and
  // spread in here so a migration failure crossing the boundary is one of this vocabulary.
  ...MIGRATION_DIAGNOSTIC_CODES,
} as const;

export type ServerDiagnosticCode =
  (typeof SERVER_DIAGNOSTIC_CODES)[keyof typeof SERVER_DIAGNOSTIC_CODES];

export interface AxiomServerOptions {
  ir: ServerIR;
  persistence?: PersistenceAdapter;
  host?: ServerHost;
  /** How many request ids to remember for idempotent retries. */
  idempotencyWindow?: number;
  /**
   * One adapter per integration the Server IR declares, keyed by `IntegrationDef.id`.
   * Checked at `start()`: a required integration with no adapter fails startup clearly
   * rather than at first invocation (spec §116).
   */
  integrations?: IntegrationAdapterRegistry;
  /**
   * One adapter per integration that a `SubscriptionDef` names, keyed by `IntegrationDef.id`.
   * Checked at `start()` for the same reason integration adapters are: a declared live
   * source with nothing to maintain it must fail loudly at startup, not stay silently
   * inactive forever.
   */
  subscriptions?: SubscriptionAdapterRegistry;
  /** One blob store per `StorageDef` the Server IR declares, keyed by `StorageDef.id`. */
  blobStores?: BlobStorageRegistry;
  /**
   * The provider that executes every registered query. Used when a query's source entity
   * has no more specific entry in `dataProviders`.
   */
  dataProvider?: DataProvider;
  /** A provider per query source entity id, for applications whose data spans stores. */
  dataProviders?: DataProviderRegistry;
  /**
   * The secret that signs keyset cursors. An authority given none mints a random one at
   * startup — fine in-process, but a multi-instance deployment must supply a shared value
   * so a cursor issued by one instance verifies on another.
   */
  cursorSecret?: string;
  /**
   * The query result cache. `true` (the default) or `{ maxEntries }` enables it; `false`
   * disables it. Cache identity always includes a principal and read-policy fingerprint, so
   * no entry can cross the trust boundary (spec 0.10 §69-70). Any committed mutation clears
   * the whole cache (§72).
   */
  queryCache?: boolean | { maxEntries?: number };
}

export interface AxiomServer {
  /** Loads committed state. Must complete before any request is handled. */
  start(): Promise<void>;
  /** The one entry point. Every transport funnels through here. */
  handle(request: ServerRequest): Promise<ServerResponse>;
  /** Authoritative values of every observable state. */
  snapshot(): StateSnapshot;
  getState(id: NodeId): unknown;
  revision(): number;
  /** Every mutation this authority has applied, with its outcome. */
  mutationLog(): MutationLogEntry[];
  /**
   * Every effect intent this authority has recorded, distinct from the mutation log
   * because an effect is not a state mutation (spec §73).
   */
  effectLog(): EffectRecord[];
  /**
   * Every subscription this authority maintains, with its lifecycle state and delivery
   * counters — configured, active, reconnecting, failed, received, rejected, dropped, last
   * delivery, last failure. An operator or agent answers "is the feed up, and is it
   * arriving" from here, not from an application-authored health route.
   */
  subscriptionLog(): SubscriptionRecord[];
  subscriptionStatus(id: NodeId): SubscriptionRecord | undefined;
  /**
   * Every storage effect this authority has dispatched, with its outcome — how an
   * un-committed upload or a failed external deletion stays observable rather than
   * becoming a silent orphan (spec 0.9 §55, §56).
   */
  blobLog(): EffectRecord[];
  /**
   * Reads an object's metadata after checking the store's `readAuthorization` against
   * `principal`. The one entry point a download or metadata transport may use: possession
   * of a key is never permission.
   */
  authorizeBlobRead(
    storageId: NodeId,
    key: string,
    principal: PrincipalRecord | null,
  ): Promise<{ ok: true; blob: StoredBlob } | { ok: false; diagnostic: RuntimeDiagnostic }>;
  /** Whether this caller may upload into this store, and under what limits. */
  authorizeBlobUpload(
    storageId: NodeId,
    principal: PrincipalRecord | null,
    upload: { mediaType: string; size: number },
  ): Promise<{ ok: true } | { ok: false; diagnostic: RuntimeDiagnostic }>;
  /** Stages an authorized upload and returns the public `BlobRef` an action may receive. */
  stageBlob(
    storageId: NodeId,
    principal: PrincipalRecord | null,
    upload: { data: Uint8Array; mediaType: string; filename?: string },
  ): Promise<{ ok: true; ref: Record<string, LiteralValue> } | { ok: false; diagnostic: RuntimeDiagnostic }>;
  /** Drops every cached query result. A host calls this after an out-of-band data change. */
  clearQueryCache(): void;
  /** Cache observability: how many entries are held and how many reads it has served. */
  queryCacheStats(): { entries: number; hits: number; enabled: boolean };
  stop(): Promise<void>;
}

const IDEMPOTENCY_WINDOW = 256;

function diagnostic(
  code: ServerDiagnosticCode,
  message: string,
  details?: Record<string, unknown>,
): RuntimeDiagnostic {
  // Server codes join the same structured vocabulary, so a client matches on `code` exactly
  // as it does for a local failure.
  return {
    code: code as unknown as RuntimeDiagnostic['code'],
    message,
    severity: 'error',
    ...(details ? { details } : {}),
  };
}

/**
 * The authoritative runtime.
 *
 * It executes the **same semantic engine** the client runs, given an IR that contains no UI
 * and no routes. That is deliberate rather than convenient: transaction boundaries,
 * provisional writes, `for-each` ordering, constraint and transition evaluation, rollback
 * and the mutation log are not reimplemented here, so a graph cannot behave differently
 * merely because execution moved to the authority.
 *
 * Requests are serialized. One action runs at a time, and its persistence commit completes
 * before the next begins, so two callers cannot both commit from the same snapshot.
 */
/**
 * Detail keys an authority may return to a client.
 *
 * A whitelist, not a blacklist, because the cost of the two mistakes is not symmetric: a
 * missing key is an inconvenience, an unlisted one added later is a disclosure. Everything
 * here is structural — which rule, which record, which guard — and nothing here is a **state
 * value**. A transition rule's `previousValue` and `proposedValue` are exactly the kind of
 * thing that must not cross: the rule may govern an entity the client never sees, and a
 * refusal would otherwise hand over the very record `serverOnly` withholds.
 */
const DISCLOSABLE_DETAIL_KEYS: readonly string[] = [
  'actionId',
  'code',
  'conflicts',
  'constraintId',
  'entityId',
  'failureMode',
  'identity',
  'preconditionIndex',
  'principal',
  'severity',
  'source',
  'stateId',
  'transitionConstraintId',
];

/** Strips state values out of a diagnostic on its way across the trust boundary. */
function disclosable(diagnostic: RuntimeDiagnostic): RuntimeDiagnostic {
  if (!diagnostic.details) {
    return diagnostic;
  }
  const details: Record<string, unknown> = {};
  for (const key of DISCLOSABLE_DETAIL_KEYS) {
    if (key in diagnostic.details) {
      details[key] = diagnostic.details[key];
    }
  }
  return { ...diagnostic, details };
}


export function createAxiomServer(options: AxiomServerOptions): AxiomServer {
  if (!(SERVER_IR_CONTRACTS as readonly string[]).includes(String(options.ir.contract))) {
    throw new Error(
      `Unsupported Server IR contract "${String(options.ir.contract)}"; this runtime executes ${SERVER_IR_CONTRACTS.join(', ')}`,
    );
  }
  // A document may not claim a contract older than the vocabulary it uses. Executing it
  // anyway would make the label meaningless, and the label is what another implementation
  // decides by.
  const understated = understatedContract(options.ir);
  if (understated) {
    throw new Error(
      `Server IR declares "${String(options.ir.contract)}" but uses ${understated} semantics; label it ${understated}`,
    );
  }

  const ir = options.ir;
  const persistence = options.persistence ?? createMemoryPersistence();
  const host = options.host ?? createServerHost();
  const window = options.idempotencyWindow ?? IDEMPOTENCY_WINDOW;

  const entities = new Map<NodeId, EntityDef>(ir.entities.map((entity) => [entity.id, entity]));
  const statesById = new Map<NodeId, StateDef>(ir.states.map((state) => [state.id, state]));
  /** Persistable state: derived values are recomputed, never stored. */
  const durableStateIds = ir.states.filter((state) => !state.derivation).map((state) => state.id);

  const integrationOperations: Record<NodeId, IntegrationOperationDef> = ir.integrationOperations ?? {};
  const adapters: IntegrationAdapterRegistry = options.integrations ?? {};
  const eventsById = new Map<NodeId, EventDef>((ir.events ?? []).map((event) => [event.id, event]));
  const storagesById: Record<NodeId, StorageDef> = {};
  for (const storage of ir.storages ?? []) {
    storagesById[storage.id] = storage;
  }
  const blobStores: BlobStorageRegistry = options.blobStores ?? {};

  // The semantic data-access layer (spec 0.10). Queries, relationships and row-level read
  // policies are executed here and never cross to a client.
  const queriesById = new Map<NodeId, QueryDef>((ir.queries ?? []).map((query) => [query.id, query]));
  const relationships: RelationshipDef[] = ir.relationships ?? [];
  const readPolicies: ReadPolicyDef[] = ir.readPolicies ?? [];
  const dataProviders: DataProviderRegistry = options.dataProviders ?? {};
  const defaultDataProvider = options.dataProvider;
  const cursorSecret = options.cursorSecret ?? randomCursorSecret();

  /**
   * A conservative, correctness-first query result cache (spec 0.10 §68-72).
   *
   * Cache identity is **every** semantic factor that could change a result: the query, its
   * arguments, the page context, and — critically — a fingerprint of the principal and of
   * the read policy in force (§69). Principal A's cached `ownOrders` can never be served to
   * principal B, because B's key differs in `principalFingerprint` (§70).
   *
   * Invalidation is deliberately blunt: any committed mutation clears the whole cache. Over-
   * invalidation is acceptable (§72); a known-stale result is not. A future incremental
   * engine can narrow this without changing the identity model.
   */
  const cacheEnabled = options.queryCache !== false;
  const cacheMaxEntries =
    typeof options.queryCache === 'object' && options.queryCache.maxEntries !== undefined
      ? options.queryCache.maxEntries
      : 128;
  const queryCache = new Map<string, QueryResponse>();
  let queryCacheHits = 0;
  const invalidateQueryCache = (): void => {
    if (cacheEnabled) {
      queryCache.clear();
    }
  };
  const providerFor = (sourceEntityId: NodeId): DataProvider | undefined =>
    dataProviders[sourceEntityId] ?? defaultDataProvider;
  /** The caller of the action currently running, so a `query` operation's policy binds them. */
  let activePrincipal: Record<string, LiteralValue> | null = null;

  /**
   * Reads a stored object's metadata for a `blob-metadata` operation.
   *
   * A missing key and a still-`staged` key both fail: an operation that bound a plausible
   * empty record for either would be handing the action a reference to bytes no committed
   * transaction ever accepted.
   */
  async function readBlobMetadata(
    storageId: string,
    key: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string }> {
    const store = blobStores[storageId as NodeId];
    if (!store) {
      return { ok: false, code: 'BLOB_STORE_MISSING', message: `No blob store registered for ${storageId}` };
    }
    const outcome = await store.metadata(key);
    if (!outcome.ok) {
      return { ok: false, code: outcome.code, message: outcome.message };
    }
    if (outcome.value.lifecycle !== 'stored') {
      return {
        ok: false,
        code: 'BLOB_NOT_FOUND',
        message: `${key} is staged and has not been committed`,
      };
    }
    return { ok: true, value: blobRef(outcome.value) };
  }

  /**
   * Races the adapter's query against `context.timeoutMs`, enforced by the runtime rather
   * than left to adapter cooperation (spec 8.1 §15-25) — a non-cooperating adapter whose
   * `Promise` never settles must not wedge the semantic invocation, and by extension a
   * polling interval trigger (§22), forever.
   *
   * The adapter's promise is never cancelled — Axiom cannot know whether that is safe for an
   * arbitrary provider call — but its eventual settlement is discarded once the deadline has
   * already answered, so a late result can never mutate state (§20-21), and `.catch` on it
   * prevents an unhandled rejection.
   */
  async function queryWithTimeout(
    adapter: IntegrationAdapter,
    operation: IntegrationOperationDef,
    args: Record<string, unknown>,
    context: { timeoutMs?: number },
  ): Promise<IntegrationResult> {
    const adapterPromise = adapter.query(operation, args, context);
    if (context.timeoutMs === undefined) {
      return adapterPromise;
    }
    let timer: ReturnType<ServerHost['scheduleOnce']> | undefined;
    const timeout = new Promise<IntegrationResult>((resolve) => {
      timer = host.scheduleOnce(context.timeoutMs as number, () => {
        resolve({
          ok: false,
          code: 'INTEGRATION_TIMEOUT',
          message: `${operation.name ?? operation.id} did not answer within ${context.timeoutMs}ms`,
          retryable: true,
        });
      });
    });
    try {
      return await Promise.race([adapterPromise, timeout]);
    } finally {
      timer?.cancel();
      // The adapter may still resolve or reject after the deadline. Its value is simply
      // never read again; the `.catch` only prevents an unhandled rejection.
      adapterPromise.catch(() => undefined);
    }
  }

  /** Bridges an `integration-query` operation to its registered adapter, result-typed. */
  async function queryIntegration(
    operationId: string,
    args: Record<string, unknown>,
    context: { timeoutMs?: number },
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string; retryable?: boolean }> {
    const operation = integrationOperations[operationId as NodeId];
    if (!operation) {
      return { ok: false, code: 'UNKNOWN_INTEGRATION_OPERATION', message: `No integration operation ${operationId}` };
    }
    const adapter = adapters[operation.integrationId];
    if (!adapter) {
      return {
        ok: false,
        code: 'INTEGRATION_ADAPTER_MISSING',
        message: `No adapter registered for ${operation.integrationId}`,
      };
    }
    const result = await queryWithTimeout(adapter, operation, args, context);
    if (!result.ok) {
      return result;
    }
    const problems = validateValueAgainstType(result.value, operation.resultType, {
      path: 'result',
      getEntity: (id) => entities.get(id),
    });
    if (problems.length > 0) {
      return {
        ok: false,
        code: 'INTEGRATION_RESULT_INVALID',
        message: `${operation.name ?? operation.id} returned a value that does not conform to its declared result type`,
      };
    }
    return { ok: true, value: result.value };
  }

  const runtime = buildRuntime(ir, host, queryIntegration, readBlobMetadata, executeQueryForOperation);
  let storeRevision = 0;
  const revisions = new Map<NodeId, number>();
  const replies = new Map<string, InvokeResponse>();
  const effectRecords = new Map<string, EffectRecord>();
  let queue: Promise<unknown> = Promise.resolve();
  let started = false;

  /** Runs `body` after every earlier request has finished, and before any later one. */
  function serialize<T>(body: () => Promise<T>): Promise<T> {
    const next = queue.then(body, body);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function report(event: ServerEvent): void {
    host.report?.(event);
  }

  /** The caller's identity field only. A whole principal record is never reported. */
  function principalIdentity(principal: PrincipalRecord | null): LiteralValue | undefined {
    if (!principal || !ir.principalEntityId) {
      return undefined;
    }
    const identity = entities.get(ir.principalEntityId)?.identityFieldId;
    return identity ? principal[identity] : undefined;
  }

  async function resolvePrincipal(request: InvokeRequest): Promise<PrincipalRecord | null> {
    if (!host.authenticate) {
      return null;
    }
    return (await host.authenticate(request.credential ?? null)) ?? null;
  }

  /** Untrusted input, checked against the declared parameter types. */
  function checkArguments(action: ActionDef, args: Record<string, unknown>): RuntimeDiagnostic[] {
    const problems: RuntimeDiagnostic[] = [];
    const declared = new Map((action.parameters ?? []).map((parameter) => [String(parameter.id), parameter]));

    for (const key of Object.keys(args)) {
      if (!declared.has(key)) {
        problems.push(
          diagnostic(
            SERVER_DIAGNOSTIC_CODES.ARGUMENT_TYPE_MISMATCH,
            `${action.name ?? action.id} has no parameter ${key}`,
            { parameterId: key, expected: [...declared.keys()] },
          ),
        );
      }
    }
    for (const parameter of action.parameters ?? []) {
      const present = Object.prototype.hasOwnProperty.call(args, String(parameter.id));
      const value = args[String(parameter.id)];
      if (!present || value === undefined || value === null) {
        if (parameter.required) {
          problems.push(
            diagnostic(
              SERVER_DIAGNOSTIC_CODES.ARGUMENT_TYPE_MISMATCH,
              `${action.name ?? action.id} requires ${parameter.name ?? parameter.id}`,
              { parameterId: parameter.id },
            ),
          );
        }
        continue;
      }
      if (!parameter.valueType) {
        continue;
      }
      // The same walk that checks seed data checks hostile input; there is no second
      // validation system to drift from the type model.
      const issues = validateValueAgainstType(value, parameter.valueType, {
        path: String(parameter.id),
        getEntity: (id) => entities.get(id),
      });
      for (const problem of issues) {
        problems.push(
          diagnostic(SERVER_DIAGNOSTIC_CODES.ARGUMENT_TYPE_MISMATCH, problem.message, {
            parameterId: parameter.id,
            ...problem.details,
          }),
        );
      }
    }
    return problems;
  }

  /**
   * The trust boundary itself: may an invocation reaching this authority *this way* invoke
   * this action at all — independent of, and evaluated before, `authorize`'s identity check
   * (spec 8.1 §3-9). `context.source` is server-computed in `invoke`/`invokeSystem` and never
   * read from client-supplied protocol data, so a client cannot forge `'system'` (spec §65).
   */
  function checkInvocationSource(
    action: ActionDef,
    context: ExecutionContext,
  ): RuntimeDiagnostic | null {
    const source = context.source ?? 'client';
    if (allowedInvocationSources(action).includes(source)) {
      return null;
    }
    return diagnostic(
      SERVER_DIAGNOSTIC_CODES.INVOCATION_SOURCE_NOT_ALLOWED,
      `${action.name ?? action.id} does not accept '${source}'-sourced invocations`,
      { actionId: action.id, source },
    );
  }

  /** Authorization, evaluated here and nowhere else. */
  function authorize(action: ActionDef, context: ExecutionContext): RuntimeDiagnostic | null {
    if (!action.authorization) {
      return null;
    }
    const outcome = runtime.evaluate(action.authorization);
    if (!outcome.ok) {
      // A rule that cannot be evaluated denies, exactly as an unevaluable constraint is
      // counted as violated.
      return diagnostic(
        SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_DENIED,
        `Authorization for ${action.name ?? action.id} could not be evaluated`,
        { actionId: action.id, cause: outcome.diagnostic.code },
      );
    }
    const permitted = Array.isArray(outcome.value) ? outcome.value.length > 0 : Boolean(outcome.value);
    return permitted
      ? null
      : diagnostic(
          SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_DENIED,
          `The caller may not invoke ${action.name ?? action.id}`,
          { actionId: action.id, principal: principalIdentity(context.principal) },
        );
  }

  /** Observable states the authority recomputes rather than stores. */
  const derivedObservables = new Set<NodeId>(
    ir.observableStateIds.filter(
      (stateId) => ir.states.find((state) => state.id === stateId)?.derivation !== undefined,
    ),
  );

  /**
   * The snapshot a caller receives.
   *
   * With no `sinceRevision` this is every observable state. With one, it is every observable
   * state the authority cannot prove unchanged since that revision: each stored state whose
   * last committed revision is later, and every derived state — because a derived value
   * follows states this response may not even be allowed to disclose, and the authority will
   * not guess. That direction of caution is the whole contract: a partial snapshot may name
   * a state that did not move, and may never omit one that did.
   */
  function snapshotOf(sinceRevision?: number): StateSnapshot {
    // A revision the authority has not issued yet says nothing about what changed, so the
    // complete snapshot — always a correct answer — is what it can honestly give.
    const incremental = sinceRevision !== undefined && sinceRevision <= storeRevision;
    const states: Record<NodeId, unknown> = {};
    for (const stateId of ir.observableStateIds) {
      if (
        incremental &&
        !derivedObservables.has(stateId) &&
        (revisions.get(stateId) ?? 0) <= (sinceRevision as number)
      ) {
        continue;
      }
      states[stateId] = runtime.getState(stateId);
    }
    return { revision: storeRevision, states, ...(incremental ? { partial: true } : {}) };
  }

  /**
   * The key an idempotency record is filed under.
   *
   * Scoped by principal as well as request id. A replay is a caller retrying *their own*
   * request, so a request id that one principal happened to choose must never hand them
   * another principal's answer — a request id is client-chosen and therefore not a secret.
   * Anonymous callers share a single scope, because there is nothing to tell them apart; an
   * application that needs replay isolation between anonymous callers has to authenticate
   * them.
   */
  function recordKey(principal: PrincipalRecord | null, requestId: string): string {
    const identity = principalIdentity(principal);
    return `${identity === undefined ? '' : JSON.stringify(identity)}\u0000${requestId}`;
  }

  function remember(requestId: string, response: InvokeResponse): void {
    replies.set(requestId, response);
    if (replies.size > window) {
      const oldest = replies.keys().next().value;
      if (oldest !== undefined) {
        replies.delete(oldest);
      }
    }
  }

  async function invoke(request: InvokeRequest): Promise<ServerResponse> {
    // Who is calling is established before anything is answered, because the idempotency
    // record is scoped to them. Authenticating first discloses nothing: it is the same work
    // whether or not the action turns out to exist.
    const context: ExecutionContext = {
      principal: await resolvePrincipal(request),
      source: 'client',
      ...(request.credential !== undefined ? { credential: request.credential } : {}),
      ...(request.requestId ? { requestId: request.requestId } : {}),
    };
    const replayKey = request.requestId ? recordKey(context.principal, request.requestId) : undefined;
    if (replayKey) {
      const previous = replies.get(replayKey);
      if (previous) {
        // A retry after a lost response must not execute the action a second time.
        report({ kind: 'replay', actionId: request.actionId, requestId: request.requestId });
        return { ...previous, replayed: true };
      }
    }
    return invokeCore(request.actionId, request.arguments ?? {}, context, request.requestId, replayKey, 0);
  }

  function queryError(code: ServerDiagnosticCode, message: string, details?: Record<string, unknown>): QueryResponse {
    return {
      kind: 'query-result',
      protocol: PROTOCOL_VERSION,
      ok: false,
      diagnostics: [disclosable(diagnostic(code, message, details))],
      revision: storeRevision,
    };
  }

  /**
   * Runs a registered query (spec 0.10 §54). The client names a `QueryDef` and supplies
   * typed arguments; this authority validates them, computes the principal from the
   * authenticated context (never the request), injects the read policy into the filter,
   * clamps the page size, verifies any cursor against this exact context, hands a
   * normalized `ProviderQuery` to the provider, and seals the next cursor.
   */
  async function runQuery(request: QueryRequest): Promise<QueryResponse> {
    const query = queriesById.get(request.queryId);
    if (!query) {
      return queryError(SERVER_DIAGNOSTIC_CODES.QUERY_NOT_FOUND, `No query ${String(request.queryId)}`, {
        queryId: request.queryId,
      });
    }

    const provider = providerFor(query.source);
    if (!provider) {
      return queryError(
        SERVER_DIAGNOSTIC_CODES.QUERY_PROVIDER_MISSING,
        `No data provider is registered for ${String(query.source)}`,
        { queryId: query.id },
      );
    }

    // Arguments: unknown names, missing required, wrong type — all rejected before the
    // provider is touched (spec §7, §55).
    const suppliedArgs = request.arguments ?? {};
    const declared = new Map((query.parameters ?? []).map((parameter) => [String(parameter.id), parameter]));
    const argProblems: RuntimeDiagnostic[] = [];
    for (const key of Object.keys(suppliedArgs)) {
      if (!declared.has(key)) {
        argProblems.push(
          diagnostic(SERVER_DIAGNOSTIC_CODES.QUERY_ARGUMENT_TYPE_MISMATCH, `${query.id} has no parameter ${key}`, {
            parameterId: key,
          }),
        );
      }
    }
    const resolvedArgs: Record<string, LiteralValue> = {};
    for (const parameter of query.parameters ?? []) {
      const key = String(parameter.id);
      const present = Object.prototype.hasOwnProperty.call(suppliedArgs, key);
      const value = suppliedArgs[key];
      if (!present || value === undefined || value === null) {
        if (parameter.required !== false) {
          argProblems.push(
            diagnostic(
              SERVER_DIAGNOSTIC_CODES.QUERY_ARGUMENT_TYPE_MISMATCH,
              `${query.id} requires ${parameter.name ?? parameter.id}`,
              { parameterId: parameter.id },
            ),
          );
        }
        continue;
      }
      if (parameter.valueType) {
        const issues = validateValueAgainstType(value, parameter.valueType, {
          path: key,
          getEntity: (id) => entities.get(id),
        });
        for (const issue of issues) {
          argProblems.push(
            diagnostic(SERVER_DIAGNOSTIC_CODES.QUERY_ARGUMENT_TYPE_MISMATCH, issue.message, {
              parameterId: parameter.id,
            }),
          );
        }
      }
      resolvedArgs[key] = value as LiteralValue;
    }
    if (argProblems.length > 0) {
      return {
        kind: 'query-result',
        protocol: PROTOCOL_VERSION,
        ok: false,
        diagnostics: argProblems.map(disclosable),
        revision: storeRevision,
      };
    }

    const principal = ((host.authenticate
      ? await host.authenticate(request.credential ?? null)
      : null) ?? null) as Record<string, LiteralValue> | null;

    const strategy = queryPaginationStrategy(query);
    const cap = Math.min(queryMaxPageSize(query), provider.capabilities.maxPageSize);
    const requestedSize = request.pageSize ?? queryDefaultPageSize(query);
    if (request.pageSize !== undefined && request.pageSize > cap) {
      return queryError(
        SERVER_DIAGNOSTIC_CODES.QUERY_PAGE_SIZE_EXCEEDED,
        `Requested ${request.pageSize} rows; the ceiling for ${String(query.id)} is ${cap}`,
        { queryId: query.id, requested: request.pageSize, maximum: cap },
      );
    }
    const pageSize = Math.max(1, Math.min(requestedSize, cap));

    const policy = policyForQuery(query, readPolicies);
    const argsFingerprint = await fingerprint(resolvedArgs);
    const principalFingerprint = await fingerprint(principal ?? 'anon');
    const policyFingerprint = await fingerprint(policy ? policy.predicate : 'none');

    let after: CursorPayload['pos'] | undefined;
    if (request.cursor !== undefined) {
      const payload = await openCursor(request.cursor, cursorSecret);
      if (
        !payload ||
        !cursorMatchesContext(payload, {
          queryId: query.id,
          argumentsFingerprint: argsFingerprint,
          principalFingerprint,
          policyFingerprint,
          contract: String(ir.contract),
        })
      ) {
        return queryError(SERVER_DIAGNOSTIC_CODES.QUERY_CURSOR_INVALID, 'The cursor is invalid for this request', {
          queryId: query.id,
        });
      }
      after = payload.pos;
    }

    // Cache identity: every semantic factor that could change the result (spec §69).
    const cacheKey = cacheEnabled
      ? JSON.stringify([
          String(query.id),
          argsFingerprint,
          principalFingerprint,
          policyFingerprint,
          String(ir.contract),
          request.cursor ?? null,
          pageSize,
          request.offset ?? null,
        ])
      : undefined;
    if (cacheKey !== undefined) {
      const cached = queryCache.get(cacheKey);
      if (cached) {
        queryCacheHits += 1;
        return structuredClone(cached);
      }
    }

    const sourceIdentityFieldId = entities.get(query.source)?.identityFieldId;
    const providerQuery = buildProviderQuery({
      query,
      policy,
      relationships,
      ...(sourceIdentityFieldId ? { sourceIdentityFieldId } : {}),
      arguments: resolvedArgs,
      principal,
      pageSize,
      strategy,
      ...(after ? { after } : {}),
      ...(request.offset !== undefined ? { offset: request.offset } : {}),
    });

    // The clauses this query needs must be capabilities the provider actually has, and the
    // provider's own plan must report nothing unsupported (spec §9, §29, §81, §84).
    const needed = requiredCapabilities({
      filter: query.filter ?? policy,
      sort: query.sort ?? [],
      projection: query.projection,
      relationships: query.relationships ?? [],
      aggregate: query.aggregate ?? [],
      groupBy: query.groupBy ?? [],
      strategy,
    });
    const missing = needed.filter((capability) => !provider.capabilities.supports.includes(capability));
    const planUnsupported = provider.explain(providerQuery).unsupported;
    if (missing.length > 0 || planUnsupported.length > 0) {
      return queryError(
        SERVER_DIAGNOSTIC_CODES.QUERY_CAPABILITY_UNSUPPORTED,
        `The provider cannot execute this query exactly: ${[...missing, ...planUnsupported].join(', ')}`,
        { queryId: query.id, missing, unsupported: [...planUnsupported] },
      );
    }

    const remember = (response: QueryResponse): QueryResponse => {
      if (cacheKey !== undefined && response.ok) {
        if (queryCache.size >= cacheMaxEntries) {
          const oldest = queryCache.keys().next().value;
          if (oldest !== undefined) {
            queryCache.delete(oldest);
          }
        }
        queryCache.set(cacheKey, structuredClone(response));
      }
      return response;
    };

    if (queryIsAggregate(query)) {
      const result = await provider.aggregate(providerQuery);
      if (!result.ok) {
        return queryError(
          providerFailureCode(result.code),
          result.message,
          { queryId: query.id },
        );
      }
      return remember({
        kind: 'query-result',
        protocol: PROTOCOL_VERSION,
        ok: true,
        diagnostics: [],
        aggregate: { rows: result.value.rows },
        revision: storeRevision,
      });
    }

    const result = await provider.query(providerQuery);
    if (!result.ok) {
      return queryError(providerFailureCode(result.code), result.message, { queryId: query.id });
    }
    let nextCursor: string | null = null;
    if (result.value.hasMore && result.value.lastPosition && strategy === 'cursor') {
      nextCursor = await sealCursor(
        {
          q: String(query.id),
          a: argsFingerprint,
          p: principalFingerprint,
          rp: policyFingerprint,
          c: String(ir.contract),
          pos: result.value.lastPosition,
        },
        cursorSecret,
      );
    }
    return remember({
      kind: 'query-result',
      protocol: PROTOCOL_VERSION,
      ok: true,
      diagnostics: [],
      page: { items: result.value.items, nextCursor, hasMore: result.value.hasMore },
      revision: storeRevision,
    });
  }

  /**
   * Runs a registered query for a `query` **operation** inside an action (spec 0.10 §40).
   * Same authority as the protocol path — the read policy is injected and the principal is
   * the caller of the running action — but there is no cursor and no page envelope: it
   * binds the rows (or the aggregate rows) directly into the action's scope. Bounded to the
   * query's maximum page size, so a `query` operation can never materialize a whole table
   * into a transaction.
   */
  async function executeQueryForOperation(
    queryId: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string }> {
    const query = queriesById.get(queryId as NodeId);
    if (!query) {
      return { ok: false, code: SERVER_DIAGNOSTIC_CODES.QUERY_NOT_FOUND, message: `No query ${queryId}` };
    }
    const provider = providerFor(query.source);
    if (!provider) {
      return {
        ok: false,
        code: SERVER_DIAGNOSTIC_CODES.QUERY_PROVIDER_MISSING,
        message: `No data provider for ${String(query.source)}`,
      };
    }
    const resolvedArgs: Record<string, LiteralValue> = {};
    for (const parameter of query.parameters ?? []) {
      const key = String(parameter.id);
      if (args[key] !== undefined && args[key] !== null) {
        resolvedArgs[key] = args[key] as LiteralValue;
      }
    }
    const policy = policyForQuery(query, readPolicies);
    const sourceIdentityFieldId = entities.get(query.source)?.identityFieldId;
    const providerQuery = buildProviderQuery({
      query,
      policy,
      relationships,
      ...(sourceIdentityFieldId ? { sourceIdentityFieldId } : {}),
      arguments: resolvedArgs,
      principal: activePrincipal,
      pageSize: Math.min(queryMaxPageSize(query), provider.capabilities.maxPageSize),
      strategy: 'offset',
      offset: 0,
    });
    const needed = requiredCapabilities({
      filter: query.filter ?? policy,
      sort: query.sort ?? [],
      projection: query.projection,
      relationships: query.relationships ?? [],
      aggregate: query.aggregate ?? [],
      groupBy: query.groupBy ?? [],
      strategy: 'offset',
    });
    const missing = needed.filter((capability) => !provider.capabilities.supports.includes(capability));
    if (missing.length > 0 || provider.explain(providerQuery).unsupported.length > 0) {
      return {
        ok: false,
        code: SERVER_DIAGNOSTIC_CODES.QUERY_CAPABILITY_UNSUPPORTED,
        message: `The provider cannot execute ${String(query.id)} exactly`,
      };
    }
    if (queryIsAggregate(query)) {
      const result = await provider.aggregate(providerQuery);
      return result.ok
        ? { ok: true, value: result.value.rows }
        : { ok: false, code: providerFailureCode(result.code), message: result.message };
    }
    const result = await provider.query(providerQuery);
    return result.ok
      ? { ok: true, value: result.value.items }
      : { ok: false, code: providerFailureCode(result.code), message: result.message };
  }

  interface StagedEntity {
    entityId: NodeId;
    identityFieldId: string;
    provider: DataProvider;
    original: Record<string, LiteralValue>[];
  }

  /**
   * Loads the provider-backed rows an action's `provider-record` targets name into their
   * staging collections, so the rewritten action can mutate them through the ordinary
   * engine. Returns the loaded entities for the later diff, or a diagnostic if a provider
   * is missing or a load fails.
   */
  async function loadProviderRecordStaging(
    action: ActionDef,
    args: Record<string, unknown>,
  ): Promise<{ staged: StagedEntity[] } | { error: RuntimeDiagnostic }> {
    const toLoad = identityValuesToLoad(action, args, activePrincipal);
    const staged: StagedEntity[] = [];
    for (const [entityId, values] of toLoad) {
      const provider = providerFor(entityId);
      if (!provider) {
        return {
          error: diagnostic(
            SERVER_DIAGNOSTIC_CODES.QUERY_PROVIDER_MISSING,
            `No data provider is registered for ${String(entityId)}`,
            { entityId },
          ),
        };
      }
      const identityFieldId = String(entities.get(entityId)?.identityFieldId ?? '');
      const loaded = await provider.loadByIdentity(entityId, identityFieldId as never, values);
      if (!loaded.ok) {
        return {
          error: diagnostic(SERVER_DIAGNOSTIC_CODES.QUERY_PROVIDER_FAILURE, loaded.message, { entityId }),
        };
      }
      runtime.hydrateState(stagingStateId(entityId), loaded.value);
      staged.push({ entityId, identityFieldId, provider, original: loaded.value });
    }
    return { staged };
  }

  /** Diffs each staging collection against what was loaded and commits the changes to the provider, atomically. */
  async function commitProviderRecordStaging(staged: StagedEntity[]): Promise<RuntimeDiagnostic | null> {
    const byProvider = new Map<DataProvider, ProviderMutation[]>();
    for (const entry of staged) {
      const after = (runtime.getState(stagingStateId(entry.entityId)) as Record<string, LiteralValue>[]) ?? [];
      const mutations = diffRows(entry.entityId, entry.identityFieldId, entry.original, after);
      if (mutations.length === 0) {
        continue;
      }
      byProvider.set(entry.provider, [...(byProvider.get(entry.provider) ?? []), ...mutations]);
    }
    for (const [provider, mutations] of byProvider) {
      if (!provider.applyMutations) {
        return diagnostic(
          SERVER_DIAGNOSTIC_CODES.QUERY_CAPABILITY_UNSUPPORTED,
          'The data provider does not support writes',
        );
      }
      const applied = await provider.applyMutations(mutations);
      if (!applied.ok) {
        return diagnostic(SERVER_DIAGNOSTIC_CODES.QUERY_PROVIDER_FAILURE, applied.message);
      }
    }
    return null;
  }

  function clearProviderRecordStaging(staged: StagedEntity[]): void {
    for (const entry of staged) {
      runtime.hydrateState(stagingStateId(entry.entityId), []);
    }
  }

  function providerFailureCode(code: string): ServerDiagnosticCode {
    if (code === 'QUERY_CAPABILITY_UNSUPPORTED') {
      return SERVER_DIAGNOSTIC_CODES.QUERY_CAPABILITY_UNSUPPORTED;
    }
    if (code === 'QUERY_CURSOR_INVALID') {
      return SERVER_DIAGNOSTIC_CODES.QUERY_CURSOR_INVALID;
    }
    return SERVER_DIAGNOSTIC_CODES.QUERY_PROVIDER_FAILURE;
  }

  /**
   * Runs a triggered/event-originated action under the system principal (spec §68): no
   * credential is authenticated, and `principal` is `null` exactly as an anonymous
   * client request's is, so an action's `.authorization` still evaluates and cannot be
   * silently bypassed (spec §69,104). `depth` is the event-dispatch cycle guard.
   */
  async function invokeSystem(
    actionId: NodeId,
    args: Record<string, unknown>,
    depth: number,
  ): Promise<InvokeResponse> {
    const context: ExecutionContext = { principal: null, source: 'system' };
    const response = await invokeCore(actionId, args, context, undefined, undefined, depth);
    return response as InvokeResponse;
  }

  /**
   * The shared execution path every invocation — client request or system trigger —
   * funnels through, so a triggered action gets exactly the same semantics an ordinary
   * one does (spec §102): the same guards, constraints, transition constraints and
   * authorization.
   */
  async function invokeCore(
    actionId: NodeId,
    args: Record<string, unknown>,
    context: ExecutionContext,
    requestId: string | undefined,
    replayKey: string | undefined,
    depth: number,
  ): Promise<ServerResponse> {
    const startedAt = Date.now();

    // The caller is bound for the whole invocation, not only for the authorization check.
    // An operation that records who acted — `field(ref(PRINCIPAL), F_USER_ID)` — must resolve
    // whether or not the action also happens to carry an authorization rule. It is also what
    // a `query` operation's read policy is evaluated against.
    runtime.hydrateState(PRINCIPAL, context.principal);
    activePrincipal = (context.principal ?? null) as Record<string, LiteralValue> | null;

    // Resolved from this authority's own IR. A client's idea of what an action does is
    // never consulted.
    const action = ir.actions[actionId];
    if (!action) {
      const diagnostics = [
        diagnostic(
          SERVER_DIAGNOSTIC_CODES.UNKNOWN_SERVER_ACTION,
          `This authority does not execute ${String(actionId)}`,
          { actionId },
        ),
      ];
      report({ kind: 'reject', actionId, ok: false, diagnostics });
      return refusal(diagnostics, requestId);
    }

    const argumentProblems = checkArguments(action, args);
    if (argumentProblems.length > 0) {
      report({ kind: 'reject', actionId: action.id, ok: false, diagnostics: argumentProblems });
      return refusal(argumentProblems, requestId);
    }

    const sourceRejection = checkInvocationSource(action, context);
    if (sourceRejection) {
      report({ kind: 'reject', actionId: action.id, ok: false, diagnostics: [sourceRejection] });
      return refusal([sourceRejection], requestId);
    }

    const denial = authorize(action, context);
    if (denial) {
      report({
        kind: 'reject',
        actionId: action.id,
        ok: false,
        principal: principalIdentity(context.principal),
        diagnostics: [denial],
      });
      return refusal([denial], requestId);
    }

    // Provider-backed records this action mutates are loaded into their staging collections
    // now, so the rewritten action (its targets already rewritten to point at staging) can
    // operate on them through the ordinary engine (spec 0.10 §37-39).
    const stagesProviderRecords = providerEntitiesWritten(action).length > 0;
    let stagedEntities: StagedEntity[] = [];
    if (stagesProviderRecords) {
      const loaded = await loadProviderRecordStaging(action, args);
      if ('error' in loaded) {
        report({ kind: 'reject', actionId: action.id, ok: false, diagnostics: [loaded.error] });
        return refusal([loaded.error], requestId);
      }
      stagedEntities = loaded.staged;
    }

    // Everything the transaction might touch, as it stands now, so a refused commit can be
    // undone exactly.
    const before = new Map<NodeId, LiteralValue>();
    for (const stateId of durableStateIds) {
      before.set(stateId, runtime.getState(stateId) as LiteralValue);
    }
    // Observable values as they stood at transaction entry. `changes` reports what a client
    // can actually see change, which is not the same as what the transaction touched: a
    // derived state is recomputed on every read whether or not its value moved.
    const observedBefore = new Map<NodeId, unknown>();
    for (const stateId of ir.observableStateIds) {
      observedBefore.set(stateId, runtime.getState(stateId));
    }
    const mutationMark = runtime.getMutationLog().length;
    const effectMark = runtime.getEffectIntents().length;

    runtime.clearDiagnostics();
    const result = await runtime.invokeActionAsync(action.id, args);

    // The rewritten action committed (or rolled back) against the staging collections. If it
    // committed, diff each staging collection against what was loaded and hand the changes
    // to the provider, atomically (spec 0.10 §42, §44). A rollback sends the provider
    // nothing. Staging is scratch and is always cleared.
    let providerFailure: RuntimeDiagnostic | null = null;
    if (stagesProviderRecords) {
      if (result.ok) {
        providerFailure = await commitProviderRecordStaging(stagedEntities);
        if (!providerFailure) {
          storeRevision += 1;
          invalidateQueryCache();
        }
      }
      clearProviderRecordStaging(stagedEntities);
    }

    const written = new Set<NodeId>();
    for (const entry of runtime.getMutationLog().slice(mutationMark)) {
      if (entry.outcome === 'committed') {
        written.add(entry.path.rootStateId);
      }
    }
    const writes = [...written].filter((stateId) => durableStateIds.includes(stateId));
    const committedIntents: EffectIntentRecord[] = runtime
      .getEffectIntents()
      .slice(effectMark)
      .filter((entry) => entry.outcome === 'committed');

    if (!result.ok || providerFailure || (writes.length === 0 && committedIntents.length === 0)) {
      const ok = result.ok && !providerFailure;
      const diagnostics = providerFailure ? [providerFailure] : result.diagnostics;
      const response = respond(ok, diagnostics, {}, requestId);
      report({
        kind: 'invoke',
        actionId: action.id,
        ok,
        principal: principalIdentity(context.principal),
        requestId,
        durationMs: Date.now() - startedAt,
        revision: storeRevision,
        diagnostics,
        committed: [],
      });
      if (replayKey) {
        remember(replayKey, response as InvokeResponse);
      }
      return response;
    }

    const expected: Record<NodeId, number> = {};
    for (const stateId of writes) {
      expected[stateId] = revisions.get(stateId) ?? 0;
    }
    const effectsToCommit: EffectRecord[] = committedIntents.map((intent) => ({
      ...intent,
      status: 'pending',
      attempts: 0,
      dispatchDepth: depth,
    }));
    const outcome = await persistence.commit({
      writes: writes.map((stateId) => ({ stateId, value: runtime.getState(stateId) })),
      expected,
      ...(effectsToCommit.length > 0 ? { effects: effectsToCommit } : {}),
    });

    if (!outcome.committed) {
      // Nothing durable was written, so nothing in memory may survive either.
      for (const stateId of writes) {
        runtime.hydrateState(stateId, before.get(stateId));
      }
      const diagnostics = [
        diagnostic(
          SERVER_DIAGNOSTIC_CODES.CONCURRENCY_CONFLICT,
          `${action.name ?? action.id} was not committed: ${outcome.conflicts.join(', ')} changed while it ran`,
          { actionId: action.id, conflicts: outcome.conflicts },
        ),
      ];
      report({ kind: 'conflict', actionId: action.id, ok: false, diagnostics, revision: outcome.revision });
      const response = refusal(diagnostics, requestId);
      if (replayKey) {
        remember(replayKey, response as InvokeResponse);
      }
      return response;
    }

    storeRevision = outcome.revision;
    // A committed mutation may have changed any query's result. Conservative and correct.
    invalidateQueryCache();
    for (const stateId of writes) {
      revisions.set(stateId, outcome.revision);
    }
    for (const effect of effectsToCommit) {
      effectRecords.set(effect.id, effect);
      report({ kind: 'effect-requested', actionId: action.id, effectId: effect.id, operationId: effect.operationId });
    }
    if (effectsToCommit.length > 0) {
      // Never awaited: the transaction has already committed, and the response the caller
      // gets back reflects "committed, effect pending" (spec §123), not the effect's own
      // eventual success or failure.
      effectRunner.dispatch(effectsToCommit);
    }

    const changes: Record<NodeId, unknown> = changedObservables(observedBefore);

    const response = respond(true, result.diagnostics, changes, requestId);
    report({
      kind: 'invoke',
      actionId: action.id,
      ok: true,
      principal: principalIdentity(context.principal),
      requestId,
      durationMs: Date.now() - startedAt,
      revision: storeRevision,
      committed: writes,
    });
    if (replayKey) {
      remember(replayKey, response as InvokeResponse);
    }
    return response;
  }

  /**
   * The `changes` map of an `InvokeResponse`: every observable state whose value differs from
   * what it was when the transaction opened, and no others.
   *
   * Difference, not provenance, is the criterion. A stored state that was written back to
   * the value it already held is absent; a derived state that was recomputed to the same
   * value is absent; a derived state whose recomputation moved is present even though no
   * mutation named it. `serverOnly` states are never observable and so never appear.
   */
  function changedObservables(entry: Map<NodeId, unknown>): Record<NodeId, unknown> {
    const changes: Record<NodeId, unknown> = {};
    for (const stateId of ir.observableStateIds) {
      const current = runtime.getState(stateId);
      if (!valuesEqual(current, entry.get(stateId))) {
        changes[stateId] = current;
      }
    }
    return changes;
  }

  function respond(
    ok: boolean,
    diagnostics: RuntimeDiagnostic[],
    changes: Record<NodeId, unknown>,
    requestId?: string,
  ): InvokeResponse {
    return {
      kind: 'result',
      protocol: PROTOCOL_VERSION,
      ok,
      diagnostics: diagnostics.map(disclosable),
      changes,
      revision: storeRevision,
      ...(requestId ? { requestId } : {}),
    };
  }

  function refusal(diagnostics: RuntimeDiagnostic[], requestId?: string): InvokeResponse {
    return respond(false, diagnostics, {}, requestId);
  }

  /**
   * Validates an external/internal event's payload, then dispatches it to bound triggers.
   *
   * `diagnostics` describes the **event**: an unknown id, or a payload that does not
   * conform. `triggersOk` describes what happened downstream — whether every bound
   * trigger's action actually committed. The two are separate because a caller's
   * `EventResponse.ok` has always meant "the event was accepted", and a subscription needs
   * the second answer to decide whether a delivery was applied.
   */
  async function dispatchEventDetailed(
    eventId: NodeId,
    payload: unknown,
    depth: number,
  ): Promise<{ diagnostics: RuntimeDiagnostic[]; triggersOk: boolean }> {
    const event = eventsById.get(eventId);
    report({ kind: 'event-received', eventId });
    if (!event) {
      return {
        diagnostics: [
          diagnostic(SERVER_DIAGNOSTIC_CODES.EVENT_PAYLOAD_INVALID, `Unknown event ${String(eventId)}`, { eventId }),
        ],
        triggersOk: false,
      };
    }
    const problems = validateValueAgainstType(payload, event.payloadType, {
      path: 'payload',
      getEntity: (id) => entities.get(id),
    });
    if (problems.length > 0) {
      // Refused before any action sees it: no mutation, no state, no dispatch.
      return {
        diagnostics: [
          diagnostic(
            SERVER_DIAGNOSTIC_CODES.EVENT_PAYLOAD_INVALID,
            `${event.name ?? event.id}'s payload does not conform to its declared type`,
            { eventId, problems: problems.map((problem) => problem.message) },
          ),
        ],
        triggersOk: false,
      };
    }
    const fired = await triggerRuntime.fireEvent(eventId, payload, depth);
    report({ kind: 'event-dispatched', eventId });
    return { diagnostics: [], triggersOk: fired.ok };
  }

  async function dispatchEvent(eventId: NodeId, payload: unknown, depth: number): Promise<RuntimeDiagnostic[]> {
    return (await dispatchEventDetailed(eventId, payload, depth)).diagnostics;
  }

  function evaluateForTrigger(
    expression: Expression,
    bindings?: Record<string, unknown>,
  ): { ok: true; value: unknown } | { ok: false } {
    const outcome = bindings ? runtime.evaluateWithBindings(expression, bindings) : runtime.evaluate(expression);
    return outcome.ok ? { ok: true, value: outcome.value } : { ok: false };
  }

  async function invokeFromTrigger(
    actionId: NodeId,
    args: Record<string, unknown>,
    depth: number,
  ): Promise<{ ok: boolean }> {
    const response = await invokeSystem(actionId, args, depth);
    return { ok: response.ok };
  }

  const triggerRuntime: TriggerRuntime = createTriggerRuntime({
    triggers: ir.triggers ?? [],
    events: ir.events ?? [],
    host,
    evaluate: evaluateForTrigger,
    invoke: invokeFromTrigger,
    serialize,
    report: (event) => {
      const kind =
        event.kind === 'skipped-overlap'
          ? 'trigger-skipped-overlap'
          : event.kind === 'fired'
            ? 'trigger-fired'
            : 'trigger-invocation-failed';
      report({ kind, triggerId: event.triggerId, actionId: event.actionId });
    },
  });

  /** Dispatches a terminal effect's declared success/failure event, if it declares one. */
  async function onEffectTerminal(record: EffectRecord): Promise<void> {
    effectRecords.set(record.id, record);
    const eventId = record.status === 'succeeded' ? record.succeededEventId : record.failedEventId;
    if (!eventId) {
      return;
    }
    // A structured envelope, not a raw result or a formatted string — spec 8.1 §37-41: a
    // follow-up action correlates the outcome to the effect that caused it (`effectId`,
    // `operationId`) without parsing text. Both shapes must match what the graph declared
    // for the corresponding `EventDef.payloadType`, checked the same way any event is.
    const integrationId = integrationOperations[record.operationId]?.integrationId;
    const envelope: Record<string, unknown> = {
      [EFFECT_ID_FIELD]: record.id,
      [EFFECT_OPERATION_ID_FIELD]: record.operationId,
      ...(integrationId !== undefined ? { [EFFECT_INTEGRATION_ID_FIELD]: integrationId } : {}),
      ...(record.idempotencyKey !== undefined ? { [EFFECT_IDEMPOTENCY_KEY_FIELD]: record.idempotencyKey } : {}),
      ...(record.transactionId !== undefined ? { [EFFECT_CORRELATION_ID_FIELD]: record.transactionId } : {}),
    };
    const payload =
      record.status === 'succeeded'
        ? { ...envelope, [EFFECT_RESULT_FIELD]: record.result }
        : {
            ...envelope,
            [EFFECT_CODE_FIELD]: record.lastError?.code ?? 'EFFECT_FAILED',
            [EFFECT_MESSAGE_FIELD]: record.lastError?.message ?? 'unknown error',
            [EFFECT_RETRYABLE_FIELD]: record.lastError?.retryable === true,
          };
    // An effect outcome is a genuinely independent, detached entry into the authority —
    // never nested inside a client request's own already-claimed turn — so it needs its
    // own serialized turn exactly as a host-timer-driven trigger tick does (spec 8.1 §26-30).
    await serialize(() => dispatchEvent(eventId, payload, (record.dispatchDepth ?? 0) + 1));
  }

  /**
   * Dispatches a subscription delivery into the authority.
   *
   * It takes its own serialized turn, exactly as a host-timer trigger tick and an effect
   * outcome do: an external delivery is a genuinely independent entry into the authority,
   * never nested inside a client request's already-claimed turn. That is also what makes
   * "one delivery, one transaction" true — the subscription runtime awaits this before
   * taking the next delivery, so two deliveries can never share a transaction.
   */
  async function dispatchSubscriptionDelivery(
    eventId: NodeId,
    payload: unknown,
  ): Promise<{ ok: boolean; code?: string; message?: string }> {
    const outcome = await serialize(() => dispatchEventDetailed(eventId, payload, 0));
    const first = outcome.diagnostics[0];
    if (first) {
      return { ok: false, code: String(first.code), message: first.message };
    }
    if (!outcome.triggersOk) {
      return {
        ok: false,
        code: SERVER_DIAGNOSTIC_CODES.SUBSCRIPTION_DELIVERY_FAILED,
        message: 'a triggered action refused this delivery',
      };
    }
    return { ok: true };
  }

  const subscriptionRuntime: SubscriptionRuntime = createSubscriptionRuntime({
    subscriptions: ir.subscriptions ?? [],
    adapters: options.subscriptions ?? {},
    host,
    evaluate: (expression) => {
      const outcome = runtime.evaluate(expression);
      return outcome.ok ? { ok: true, value: outcome.value } : { ok: false };
    },
    dispatch: dispatchSubscriptionDelivery,
    // Deduplication is durable when the persistence adapter can make it so. Without that
    // it is a bounded in-memory window, which does not survive a restart — a real
    // limitation, documented rather than assumed away.
    ...(persistence.hasDelivery && persistence.recordDelivery
      ? {
          deliveries: {
            seen: (subscriptionId, key) =>
              (persistence.hasDelivery as NonNullable<PersistenceAdapter['hasDelivery']>)(subscriptionId, key),
            remember: (subscriptionId, key, window) =>
              (persistence.recordDelivery as NonNullable<PersistenceAdapter['recordDelivery']>)(
                subscriptionId,
                key,
                window,
              ),
          },
        }
      : {}),
    report: (event) => report({ kind: event.kind, subscriptionId: event.subscriptionId, eventId: event.eventId }),
  });

  /** Evaluates a store's access rule with the caller, and the blob, bound into scope. */
  async function authorizeStorage(
    storage: StorageDef,
    rule: 'readAuthorization' | 'uploadAuthorization',
    principal: PrincipalRecord | null,
    blob?: StoredBlob,
  ): Promise<RuntimeDiagnostic | null> {
    const expression = storage[rule];
    if (!expression) {
      // A store with no rule serves nothing. The safe default for a missing access rule is
      // refusal: an author who forgets one gets a closed door, never an open one.
      return diagnostic(
        SERVER_DIAGNOSTIC_CODES.BLOB_ACCESS_DENIED,
        `${storage.name ?? storage.id} declares no ${rule}, so nothing may be read from or written to it`,
        { storageId: storage.id },
      );
    }
    runtime.hydrateState(PRINCIPAL, principal);
    const outcome = blob
      ? runtime.evaluateWithBindings(expression, { [String(storage.id)]: blobRef(blob) })
      : runtime.evaluate(expression);
    const permitted = outcome.ok
      ? Array.isArray(outcome.value)
        ? outcome.value.length > 0
        : Boolean(outcome.value)
      : false;
    return permitted
      ? null
      : diagnostic(
          SERVER_DIAGNOSTIC_CODES.BLOB_ACCESS_DENIED,
          `The caller may not access this object in ${storage.name ?? storage.id}`,
          { storageId: storage.id, principal: principalIdentity(principal) },
        );
  }

  const effectRunner = createEffectRunner({
    adapters,
    integrationOperations,
    blobStores,
    storages: storagesById,
    persistence,
    host,
    onTerminal: onEffectTerminal,
    // Public `effectLog()` observability (spec 8.2 §17-23): without this, a hung adapter
    // call is indistinguishable from an effect nobody has dispatched yet — both would show
    // `status: 'pending', attempts: 0` forever, even though the adapter had genuinely been
    // invoked. `effectRecords` is the same in-memory map `effectLog()` reads.
    onRunning: (record) => {
      effectRecords.set(record.id, record);
    },
    report: (event) => report({ kind: event.kind, effectId: event.effectId, operationId: event.operationId, attempt: event.attempt }),
  });

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }
      started = true;
      // Every integration this document requires must have a registered adapter before
      // any request is accepted — not deferred to first invocation (spec §116).
      // Only integrations that actually expose an operation need a query/effect adapter.
      // An integration that exists solely to name the capability domain of a subscription
      // has nothing for one to implement, and demanding an empty object would be ceremony.
      const calledIntegrationIds = new Set(
        Object.values(integrationOperations).map((operation) => operation.integrationId),
      );
      const missing = (ir.integrations ?? []).filter(
        (integration) => calledIntegrationIds.has(integration.id) && !adapters[integration.id],
      );
      if (missing.length > 0) {
        throw new Error(
          `Missing integration adapter(s): ${missing.map((integration) => integration.name ?? integration.id).join(', ')}`,
        );
      }
      // Same rule for the other two adapter kinds: a declared live source with nothing to
      // maintain it, or a declared store with nothing behind it, is a deployment mistake
      // that must fail at startup rather than surface as permanent silence.
      const subscriptionAdapters = options.subscriptions ?? {};
      const unmaintained = [
        ...new Set((ir.subscriptions ?? []).map((subscription) => subscription.integrationId)),
      ].filter((integrationId) => !subscriptionAdapters[integrationId]);
      if (unmaintained.length > 0) {
        throw new Error(`Missing subscription adapter(s): ${unmaintained.join(', ')}`);
      }
      const storeless = (ir.storages ?? []).filter((storage) => !blobStores[storage.id]);
      if (storeless.length > 0) {
        throw new Error(
          `Missing blob store(s): ${storeless.map((storage) => storage.name ?? storage.id).join(', ')}`,
        );
      }
      // Committed state is restored administratively: it is already authoritative, so it
      // is not re-validated as though it were being proposed.
      for (const entry of await persistence.load()) {
        if (statesById.has(entry.stateId)) {
          runtime.hydrateState(entry.stateId, entry.value);
          revisions.set(entry.stateId, entry.revision);
        }
      }
      storeRevision = await persistence.revision();
      // A crash between an effect intent's commit and its dispatch must not lose it: every
      // pending intent found on restart resumes dispatch here (spec §19,96,140).
      const pending = (await persistence.loadPendingEffects?.()) ?? [];
      for (const effect of pending) {
        effectRecords.set(effect.id, effect);
      }
      if (pending.length > 0) {
        effectRunner.dispatch(pending);
      }
      // Startup triggers run only once persistence and effect resumption have completed
      // (spec §119), and before this call returns — so `accept external requests` in that
      // ordering is exactly "after `start()` resolves".
      await triggerRuntime.start();
      // Subscriptions activate last, and startup decides which: an application never calls
      // `subscription.start()` itself (spec 0.9 §17). A source that cannot be reached leaves
      // the application running with that subscription observably `reconnecting`/`failed` —
      // unless it declared `lifecycle.required`, which is the one case that rejects here.
      await subscriptionRuntime.start();
    },

    handle(request: ServerRequest): Promise<ServerResponse> {
      return serialize(async () => {
        if (request?.protocol !== PROTOCOL_VERSION) {
          return {
            kind: 'error' as const,
            protocol: PROTOCOL_VERSION,
            diagnostics: [
              diagnostic(
                SERVER_DIAGNOSTIC_CODES.MALFORMED_REQUEST,
                `Unsupported protocol ${String((request as { protocol?: unknown })?.protocol)}`,
              ),
            ],
          };
        }
        if (request.kind === 'snapshot') {
          const since = request.sinceRevision;
          if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
            return {
              kind: 'error' as const,
              protocol: PROTOCOL_VERSION,
              diagnostics: [
                diagnostic(
                  SERVER_DIAGNOSTIC_CODES.MALFORMED_REQUEST,
                  `sinceRevision must be a non-negative integer, not ${String(since)}`,
                ),
              ],
            };
          }
          report({ kind: 'snapshot', revision: storeRevision });
          const response: SnapshotResponse = {
            kind: 'snapshot',
            protocol: PROTOCOL_VERSION,
            snapshot: snapshotOf(since),
          };
          return response;
        }
        if (request.kind === 'invoke') {
          return invoke(request);
        }
        if (request.kind === 'query') {
          return runQuery(request);
        }
        if (request.kind === 'event') {
          const diagnostics = await dispatchEvent((request as EventRequest).eventId, (request as EventRequest).payload, 0);
          const response: EventResponse = {
            kind: 'event-result',
            protocol: PROTOCOL_VERSION,
            ok: diagnostics.length === 0,
            diagnostics: diagnostics.map(disclosable),
          };
          return response;
        }
        return {
          kind: 'error' as const,
          protocol: PROTOCOL_VERSION,
          diagnostics: [
            diagnostic(
              SERVER_DIAGNOSTIC_CODES.MALFORMED_REQUEST,
              `Unknown request kind ${String((request as { kind?: unknown }).kind)}`,
            ),
          ],
        };
      });
    },

    snapshot: snapshotOf,
    getState: (id: NodeId) => runtime.getState(id),
    revision: () => storeRevision,
    mutationLog: () => runtime.getMutationLog(),
    effectLog: () => [...effectRecords.values()].map((entry) => ({ ...entry })),
    subscriptionLog: () => subscriptionRuntime.status(),
    subscriptionStatus: (id: NodeId) => subscriptionRuntime.statusOf(id),
    blobLog: () =>
      [...effectRecords.values()].filter((entry) => entry.storage !== undefined).map((entry) => ({ ...entry })),
    clearQueryCache: invalidateQueryCache,
    queryCacheStats: () => ({ entries: queryCache.size, hits: queryCacheHits, enabled: cacheEnabled }),

    async authorizeBlobRead(storageId, key, principal) {
      const storage = storagesById[storageId];
      if (!storage) {
        return {
          ok: false,
          diagnostic: diagnostic(SERVER_DIAGNOSTIC_CODES.BLOB_STORE_MISSING, `No store ${String(storageId)}`, {
            storageId,
          }),
        };
      }
      const store = blobStores[storageId];
      if (!store) {
        return {
          ok: false,
          diagnostic: diagnostic(
            SERVER_DIAGNOSTIC_CODES.BLOB_STORE_MISSING,
            `No blob store adapter registered for ${String(storageId)}`,
            { storageId },
          ),
        };
      }
      const found = await store.metadata(key);
      // A key that names nothing and a key the caller may not read are answered the same
      // way, deliberately: distinguishing them would turn the endpoint into an oracle a
      // hostile client could enumerate keys with.
      const denial = found.ok
        ? await authorizeStorage(storage, 'readAuthorization', principal, found.value)
        : diagnostic(SERVER_DIAGNOSTIC_CODES.BLOB_ACCESS_DENIED, 'No such object, or access denied', {
            storageId,
          });
      if (denial) {
        return { ok: false, diagnostic: denial };
      }
      return { ok: true, blob: (found as { ok: true; value: StoredBlob }).value };
    },

    async authorizeBlobUpload(storageId, principal, upload) {
      const storage = storagesById[storageId];
      if (!storage) {
        return {
          ok: false,
          diagnostic: diagnostic(SERVER_DIAGNOSTIC_CODES.BLOB_STORE_MISSING, `No store ${String(storageId)}`, {
            storageId,
          }),
        };
      }
      const denial = await authorizeStorage(storage, 'uploadAuthorization', principal);
      if (denial) {
        return { ok: false, diagnostic: denial };
      }
      if (storage.maxSizeBytes !== undefined && upload.size > storage.maxSizeBytes) {
        return {
          ok: false,
          diagnostic: diagnostic(
            SERVER_DIAGNOSTIC_CODES.BLOB_TOO_LARGE,
            `${upload.size} bytes exceeds the ${storage.maxSizeBytes} this store accepts`,
            { storageId },
          ),
        };
      }
      if (storage.acceptedMediaTypes && !storage.acceptedMediaTypes.includes(upload.mediaType)) {
        return {
          ok: false,
          diagnostic: diagnostic(
            SERVER_DIAGNOSTIC_CODES.BLOB_MEDIA_TYPE_REJECTED,
            `${upload.mediaType} is not accepted by this store`,
            { storageId },
          ),
        };
      }
      return { ok: true };
    },

    async stageBlob(storageId, principal, upload) {
      const permitted = await this.authorizeBlobUpload(storageId, principal, {
        mediaType: upload.mediaType,
        size: upload.data.byteLength,
      });
      if (!permitted.ok) {
        return permitted;
      }
      const store = blobStores[storageId];
      if (!store) {
        return {
          ok: false,
          diagnostic: diagnostic(
            SERVER_DIAGNOSTIC_CODES.BLOB_STORE_MISSING,
            `No blob store adapter registered for ${String(storageId)}`,
            { storageId },
          ),
        };
      }
      const staged = await store.stage({
        data: upload.data,
        mediaType: upload.mediaType,
        ...(upload.filename !== undefined ? { filename: upload.filename } : {}),
      });
      if (!staged.ok) {
        return {
          ok: false,
          diagnostic: diagnostic(SERVER_DIAGNOSTIC_CODES.BLOB_OPERATION_FAILED, staged.message, { storageId }),
        };
      }
      // What comes back is the public BlobRef and nothing else: an upload never discloses
      // the store's own lifecycle bookkeeping or provider identifiers (spec 0.9 §53).
      return { ok: true, ref: blobRef(staged.value) };
    },

    async stop(): Promise<void> {
      triggerRuntime.stop();
      // Subscriptions stop before the queue is drained: after this resolves, no further
      // delivery can enter the runtime at all, which is what makes shutdown deterministic
      // rather than merely likely.
      await subscriptionRuntime.stop();
      await queue.catch(() => undefined);
      await persistence.close?.();
    },
  };
}

/**
 * Wraps the Server IR as an `ApplicationIR` with no UI, no routes and no presentation, and
 * runs the ordinary semantic engine over it. Nothing about transactions, constraints or
 * iteration is reimplemented, which is the only way to guarantee the semantics match.
 */
/**
 * The contract a document needs, when that is newer than the one it declares.
 *
 * The check runs in the direction that matters: a v2 runtime executing a document labelled
 * v1 would accept vocabulary a v1 runtime elsewhere would refuse, and the two would then
 * disagree about the same file.
 */
function understatedContract(ir: ServerIR): ServerIRContract | undefined {
  const candidates: ServerIRContract[] = [
    ir.expressionDefs || usesInvocationVocabulary(ir)
      ? 'axiom.server.v2'
      : requiredServerContract(serverIRExpressions(ir)),
    usesIntegrationVocabulary(ir) ? 'axiom.server.v3' : 'axiom.server.v1',
    usesV4Semantics(ir) ? 'axiom.server.v4' : 'axiom.server.v1',
    usesExternalIOVocabulary(ir) ? 'axiom.server.v5' : 'axiom.server.v1',
  ];
  const required = candidates.reduce(maxContract);
  const order = SERVER_IR_CONTRACTS as readonly string[];
  return order.indexOf(required) > order.indexOf(String(ir.contract)) ? required : undefined;
}

type QueryIntegration = (
  operationId: string,
  args: Record<string, unknown>,
  context: { timeoutMs?: number },
) => Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string; retryable?: boolean }>;

type ReadBlobMetadata = (
  storageId: string,
  key: string,
) => Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string }>;

type RunQueryOperation = (
  queryId: string,
  args: Record<string, unknown>,
) => Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string }>;

function buildRuntime(
  ir: ServerIR,
  host: ServerHost,
  queryIntegration: QueryIntegration,
  readBlobMetadata: ReadBlobMetadata,
  runQueryOperation: RunQueryOperation,
): AxiomRuntime {
  const nodes: ApplicationIR['nodes'] = {};
  for (const entity of ir.entities) {
    nodes[entity.id] = entity;
  }
  for (const state of ir.states) {
    nodes[state.id] = state;
  }
  for (const action of Object.values(ir.actions)) {
    nodes[action.id] = action;
  }
  for (const constraint of ir.constraints) {
    nodes[constraint.id] = constraint;
  }
  for (const constraint of ir.transitionConstraints) {
    nodes[constraint.id] = constraint;
  }

  const states = [...ir.states];

  // Provider-record staging: every action that mutates a provider-backed row runs a version
  // of itself with the `provider-record` targets rewritten to a `collection-item` over a
  // synthetic staging collection, and one ephemeral staging state is added per source
  // entity (spec 0.10 §38). `ir.states` and `ir.actions` — the persisted / contract sets —
  // are untouched; only the runtime's own copy is rewritten.
  const runtimeActions: Record<NodeId, ActionDef> = { ...ir.actions };
  const stagingEntityIds = new Set<NodeId>();
  for (const action of Object.values(ir.actions)) {
    const written = providerEntitiesWritten(action);
    if (written.length === 0) {
      continue;
    }
    for (const entityId of written) {
      stagingEntityIds.add(entityId);
    }
    const rewritten = rewriteForStaging(action);
    runtimeActions[action.id] = rewritten;
    nodes[action.id] = rewritten;
  }
  for (const entityId of stagingEntityIds) {
    const entity = ir.entities.find((candidate) => candidate.id === entityId);
    if (!entity) {
      continue;
    }
    const staging = stagingStateDef(entity) as unknown as StateDef;
    states.push(staging);
    nodes[staging.id] = staging;
  }

  if (ir.principalEntityId) {
    // The caller is bound through an ordinary state so that `ref(PRINCIPAL)` resolves with
    // the existing scope rules. It is never persisted and never observable.
    const principalState: StateDef = {
      id: PRINCIPAL,
      kind: 'state',
      name: 'principal',
      valueType: optionalType(entityType(ir.principalEntityId)),
      ephemeral: true,
      initialValue: null,
    };
    states.push(principalState);
    nodes[PRINCIPAL] = principalState;
  }

  const applicationIR: ApplicationIR = {
    id: ir.id,
    name: ir.name,
    version: ir.version,
    nodes,
    fields: ir.fields,
    entities: ir.entities,
    states,
    actions: runtimeActions,
    uiNodes: {},
    constraints: ir.constraints,
    transitionConstraints: ir.transitionConstraints,
    expressionDefs: ir.expressionDefs ?? {},
    routes: [],
    edges: [],
    locationTypes: {},
    locationRoots: {},
    locationRequired: {},
    repeatIdentityFields: {},
    authority: {},
    remoteActionIds: [],
    theme: DEFAULT_THEME,
    presentation: {},
    triggers: [],
  };

  const dom = createMemoryHost();
  return createAxiomRuntime({
    ir: applicationIR,
    rootElement: new MemoryElement('div'),
    host: {
      ...dom,
      now: () => host.now(),
      uuid: () => host.uuid(),
      queryIntegration: (operationId, args, options) => queryIntegration(operationId, args, options),
      readBlobMetadata: (storageId, key) => readBlobMetadata(storageId, key),
      runQuery: (queryId, args) => runQueryOperation(queryId, args),
    },
  });
}
