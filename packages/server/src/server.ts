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
  usesAuthorizationVocabulary,
  usesV4Semantics,
  validateValueAgainstType,
  nodeId,
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
  WorkflowDef,
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
import {
  resolveCoordinationConfig,
  type CoordinationConfig,
  type CoordinationProvider,
} from './coordination.js';
import { WorkflowIRError, createWorkflowEngine, type WorkflowEngine, type WorkflowInspection } from './workflows.js';
import { createMemoryWorkflowStore, type WorkflowStore } from './workflow-store.js';
import {
  createDistributedEffectRunner,
  type DistributedEffectRunner,
} from './distributed-effects.js';
import {
  createDurableWorkStore,
  createMemoryDurableWorkStorage,
  type DurableWorkStorage,
} from './durable-work.js';
import { serverIrCompatibilityKey, serverIrCompatibilityKeyString } from './authority-identity.js';
import { SCHEDULE_FIRING_WORK_CLASS, scheduledFiringId } from './distributed-scheduler.js';
import type { AuthorityCompatibilityKey } from './deps.js';
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
  createLiveQueryEngine,
  liveQueryIdentity,
  newSubscriptionId,
  openLiveCursor,
  liveCursorMatch,
  queryDependencies,
  queryLiveCapability,
  queryStateReferences,
  type LiveEvaluation,
  type LiveQueryEngine,
  type LiveQueryHandle,
  type LiveSubscriptionSpec,
} from './live-query.js';
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
import { evaluateSchemaGate, gateAllowsStart, schemaGateWithoutStore } from './migration-gate.js';
import type { SchemaGateResult } from './migration-gate.js';
import type { MigrationMetadataStore } from './migration-store.js';
import { isSqliteContentionError } from './sqlite-contention.js';
import { getMigrationStatus } from './migration-execute.js';
import type { MigrationStatus } from './migration-execute.js';

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
  /** A QueryDef clause (or a ReadPolicy predicate) references a StateDef the provider cannot bind (spec13.1 F2). */
  QUERY_STATE_REF_NOT_ALLOWED: 'QUERY_STATE_REF_NOT_ALLOWED',
  /** A live query's data provider cannot make committed mutations observable to other authorities (spec13.1 §33, §123). */
  LIVE_QUERY_PROVIDER_NOT_OBSERVABLE: 'LIVE_QUERY_PROVIDER_NOT_OBSERVABLE',
  /** Live mode requested for a QueryDef that cannot be observed live (e.g. nondeterministic). */
  LIVE_QUERY_NOT_CAPABLE: 'LIVE_QUERY_NOT_CAPABLE',
  /** A live-query cursor was tampered with, unsigned, or minted for another query / principal / parameters / policy. */
  LIVE_QUERY_CURSOR_INVALID: 'LIVE_QUERY_CURSOR_INVALID',
  /** A live-query cursor was minted under an incompatible schema / semantic build (spec13 §79-§81). */
  LIVE_QUERY_CURSOR_INCOMPATIBLE: 'LIVE_QUERY_CURSOR_INCOMPATIBLE',
  /** Re-evaluating a live query against the provider failed (spec13 §132). */
  LIVE_QUERY_EVALUATION_FAILED: 'LIVE_QUERY_EVALUATION_FAILED',
  /**
   * The IR carries 0.15 authorization vocabulary (`axiom.server.v9`) but this build cannot
   * yet **enforce** it — spec15 is landing in phases and enforcement (Phase C onward) is not
   * in this build. Rather than run a policy as a silent no-op, `createAxiomServer` fails
   * closed (spec4 §4, spec15 §128). Removed once enforcement ships.
   */
  AUTHORIZATION_ENFORCEMENT_UNAVAILABLE: 'AUTHORIZATION_ENFORCEMENT_UNAVAILABLE',

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
   * How often (ms) an authority serving live queries re-observes the durable persistence
   * revision so a live query sees a commit made on *another* authority (spec13 §31, §32,
   * §68). A local commit wakes live subscriptions synchronously and does not depend on this.
   * Default 250; `0` disables the poll (single-authority deployments lose nothing).
   */
  liveQueryPollMs?: number;
  /**
   * The query result cache. `true` (the default) or `{ maxEntries }` enables it; `false`
   * disables it. Cache identity always includes a principal and read-policy fingerprint, so
   * no entry can cross the trust boundary (spec 0.10 §69-70). Any committed mutation clears
   * the whole cache (§72).
   */
  queryCache?: boolean | { maxEntries?: number };
  /**
   * The provider's durable schema-evolution metadata (spec11 §10). When supplied and the
   * document declares a semantic schema version, `start()` runs the compatibility gate
   * (spec11 §11-12): it refuses to start on anything but a compatible or fresh provider,
   * and while a migration lock is held it refuses to serve traffic (spec11 §68).
   */
  migrationMetadata?: MigrationMetadataStore;
  /**
   * Durable storage for workflow instances (spec14 §81). Required for a graph that declares
   * a `WorkflowDef` in a multi-authority deployment; a single authority may omit it and get
   * the in-memory reference (`createMemoryWorkflowStore`), which is not cross-process
   * durable and says so.
   */
  workflowStore?: WorkflowStore;
  /**
   * A durable coordination provider (spec12 §10). Supplying one, together with a durable
   * `persistence` adapter, activates multi-authority execution automatically — no
   * application API and no "cluster mode" flag (spec12 §88). Absent, the authority runs
   * single-writer exactly as before.
   */
  coordination?: CoordinationProvider;
  /**
   * Durable storage for the distributed work state machine (spec12 §7). Required for a real
   * multi-process cluster; when `coordination` is set but this is not, an in-memory store is
   * used — correct for one process and tests, not durable across a restart.
   */
  workStorage?: DurableWorkStorage;
  /**
   * Infrastructure knobs for distributed execution (spec12 §89): `instanceId`,
   * `leaseDurationMs`, `renewIntervalMs`, `workerConcurrency`, `claimBatchSize`,
   * `pollIntervalMs`. Defaults are safe for one authority and for a cluster. An unsafe
   * combination (e.g. `renewIntervalMs >= leaseDurationMs`) makes `createAxiomServer`
   * throw (spec12 §90). These never change a semantic guarantee.
   */
  distributed?: Partial<CoordinationConfig>;
}

/** What {@link AxiomServer.authority} reports about this instance's distributed execution. */
export interface AuthorityInfo {
  instanceId: string;
  /** True when a coordination provider is wired: framework-owned async work is leased + fenced. */
  distributed: boolean;
  /** The coordination provider's advertised capabilities, or `null` when single-authority. */
  coordination:
    | { provider: string; supports: readonly string[]; physicalDurability: boolean }
    | null;
  /** The resolved infrastructure config (spec12 §89). */
  config: CoordinationConfig;
  /** This build's compatibility identity (spec12 §45); the key durable work is stamped with. */
  compatibilityKey: AuthorityCompatibilityKey;
}

export interface AxiomServer {
  /** Loads committed state. Must complete before any request is handled. */
  start(): Promise<void>;
  /** The one entry point. Every transport funnels through here. */
  handle(request: ServerRequest): Promise<ServerResponse>;
  /**
   * This authority's **local view** of every observable state — the state as of the most
   * recently handled request (spec12.1 §6, §39, §40). It is a synchronous read of the
   * authority-local cache and does not itself reconcile with persistence. In a multi-authority
   * deployment, read authoritative state through `handle(SnapshotRequest)` or an action, both
   * of which reconcile to the durable revision first; or call {@link coherentSnapshot}.
   */
  snapshot(): StateSnapshot;
  /** A single state's value from the authority-local view. See {@link snapshot} for the coherence contract. */
  getState(id: NodeId): unknown;
  /** The durable store revision this authority's local view is at (spec12.1 §22, monotonic). */
  revision(): number;
  /**
   * Reconcile to the durable revision (reloading persisted state if another authority has
   * committed) and return a revision-coherent snapshot (spec12.1 §7, §38, §40). This is the
   * async counterpart of {@link snapshot}; `handle(SnapshotRequest)` performs the same
   * reconciliation for the protocol path.
   */
  coherentSnapshot(): Promise<StateSnapshot>;
  /**
   * Open a **live query** (spec13): a persistent semantic observation of a `QueryDef`
   * result. The returned handle is an `AsyncIterable<LiveQueryMessage>` — an initial
   * coherent result, then canonical deltas / resets as authoritative state changes, then
   * `closed`. Transport-independent: a WebSocket / SSE / worker adapter maps this to frames.
   */
  openLiveQuery(request: {
    queryId: string;
    arguments?: Record<string, unknown>;
    credential?: unknown;
  }): Promise<LiveQueryHandle | { error: { code: string; message: string } }>;
  /**
   * Reconnect an existing live subscription through this authority using its opaque
   * `axiom.live-query-cursor.v1` (spec13 §36-§38). This authority holds no materialized
   * result, so the first message is a `reset` at the current coherent revision.
   */
  resumeLiveQuery(
    cursor: string,
    request: { queryId: string; arguments?: Record<string, unknown>; credential?: unknown },
  ): Promise<LiveQueryHandle | { error: { code: string; message: string } }>;
  closeLiveQuery(subscriptionId: string): void;
  /** Bounded observability listing of the live subscriptions this authority serves (spec13 §96). */
  inspectLiveQueries(): Array<{ subscriptionId: string; revision: number; pending: number; queryId: string }>;
  /**
   * The revision quantities live-query invalidation observes (spec13.1 §117, §119). Kept
   * distinct on purpose: `stateRevision` is `persistence.revision()` (StateDef commits);
   * `dataGeneration` is the sum of each data provider's durable mutation generation
   * (provider-record commits); `applicationRevision` is this authority's local monotone
   * count of distinct observed application-meaning changes, projected from both.
   */
  revisionInspection(): Promise<{ applicationRevision: number; stateRevision: number; dataGeneration: number }>;
  /**
   * Start a durable workflow (spec14 §18). Idempotent on `(workflowId, principal,
   * idempotencyKey)` — a retry after a lost response returns the same `instanceId`.
   */
  startWorkflow(request: {
    workflowId: string;
    arguments?: Record<string, unknown>;
    credential?: unknown;
    idempotencyKey?: string;
  }): Promise<{ instanceId: string; status: string } | { error: { code: string; message: string } }>;
  /**
   * Cancel a workflow instance (spec14 §75). Idempotent; not a rollback. **Authorized**
   * (spec14pt6): `credential` is resolved and its principal fingerprint must match the one
   * the instance was started under, or the call is refused `AUTHORIZATION_DENIED` with no
   * mutation. Cancellation of an already-terminal instance stays idempotent for any caller.
   */
  cancelWorkflow(
    instanceId: string,
    credential?: unknown,
  ): Promise<{ ok: true; status: string } | { error: { code: string; message: string } }>;
  /** The semantic status of one workflow instance (spec14 §136, §137) — no secrets. */
  getWorkflow(instanceId: string): Promise<WorkflowInspection | undefined>;
  /** Bounded listing of the workflow instances this authority can see (spec14 §136). */
  inspectWorkflows(limit?: number): Promise<WorkflowInspection[]>;
  /** The durable semantic transition history of one instance (spec14 §142, §144). */
  workflowHistory(instanceId: string): Promise<Array<Record<string, unknown>>>;
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
  /**
   * The startup schema-compatibility verdict (spec11 §11). Callable before `start()` so a
   * host or a tool can decide whether to migrate first. Returns a permissive `compatible`
   * when no `migrationMetadata` was configured.
   */
  schemaGate(): Promise<SchemaGateResult>;
  /**
   * Where the schema is and whether a migration is running / checkpointed (spec11 §93).
   * `null` when no `migrationMetadata` was configured.
   */
  getMigrationStatus(): Promise<MigrationStatus | null>;
  /** Drops every cached query result. A host calls this after an out-of-band data change. */
  clearQueryCache(): void;
  /** Cache observability: how many entries are held and how many reads it has served. */
  queryCacheStats(): { entries: number; hits: number; enabled: boolean };
  /**
   * This authority's distributed-execution identity, capability and configuration (spec12
   * §6, §55, §89). `distributed` is false and `coordination` null when no provider is wired.
   */
  authority(): AuthorityInfo;
  /**
   * Live distributed-work state on this authority (spec12 §55, §57): every effect work item
   * with its lease liveness, plus the items this build is refusing as incompatible. Empty
   * arrays when no coordination provider is wired.
   */
  inspectDistributedWork(): Promise<DistributedWorkInspection>;
  stop(): Promise<void>;
}

export interface DistributedWorkInspection {
  authority: AuthorityInfo;
  effects: import('./durable-work.js').DurableWorkItemView[];
  /** Logical scheduled firings this authority knows about, with their lease liveness (spec12.1 §53). */
  schedules: import('./durable-work.js').DurableWorkItemView[];
  incompatibleEffects: import('./durable-work.js').DurableWorkItem[];
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

  // spec14pt5 — the workflow admission boundary. `understatedContract` /
  // `serverIRExpressions` and the compatibility fingerprint below all traverse
  // `ir.workflows`; a hand-tampered IR where `workflows` is present but not an array (a
  // number, a plain object, a boolean, a string) must fail closed **here** with the same
  // structured `WorkflowIRError` `createWorkflowEngine` raises — never a native iteration
  // error, and never coerced to `[]`. Absent or `[]` is admissible; per-element / reference
  // validation runs later in `createWorkflowEngine`.
  const workflowsContainer: unknown = options.ir.workflows;
  if (workflowsContainer !== undefined && !Array.isArray(workflowsContainer)) {
    throw new WorkflowIRError([{ code: 'WORKFLOW_INVALID_IR', message: 'workflows is not an array' }]);
  }

  // spec15 Phase B — the authorization model's vocabulary exists (`axiom.server.v9`), is
  // validated and fingerprinted, but its *enforcement* lands in Phase C+. A declared policy
  // that the runtime cannot enforce must fail closed, never run as a silent no-op
  // (spec4 §4, spec15 §128). Removed when enforcement ships.
  if (usesAuthorizationVocabulary(options.ir as never)) {
    throw new Error(
      `${SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_ENFORCEMENT_UNAVAILABLE}: this Server IR declares axiom.server.v9 authorization vocabulary, which this build validates and fingerprints but does not yet enforce (spec15 Phase C+). Refusing rather than running a policy as a no-op.`,
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
  const migrationMetadata = options.migrationMetadata;
  const declaresSchemaVersion =
    (ir.schemaVersion ?? 1) > 1 || (ir.migrations ?? []).length > 0 || ir.schemaFingerprint !== undefined;
  // Migration-lifecycle observation for a long-lived process (spec11 §45, §103): a lock was
  // seen held, and once it clears the schema either still matches (invalidate the query
  // cache) or has moved past this build (refuse permanently).
  let migrationLockSeen = false;
  let schemaOutdated = false;
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
  const liveEngine: LiveQueryEngine = createLiveQueryEngine({ cursorSecret });
  // How often an idle authority re-observes the durable revision so a live query it serves
  // sees a commit made on *another* authority (spec13 §31, §32, §68). A local commit already
  // wakes the engine synchronously; this only covers the remote case. 0 disables it.
  const liveQueryPollMs = Math.max(0, options.liveQueryPollMs ?? 250);
  let liveQueryPollTimer: ReturnType<typeof setInterval> | undefined;
  // spec13.1 F1 — the observable application revision. `applicationRevision` is a local
  // monotone count of *distinct committed application-meaning changes this authority has
  // observed*, projected from two durable sources: `observedStateRevision`
  // (`persistence.revision()`, StateDef commits — 0.6 / 0.12.1) and `observedDataGeneration`
  // (Σ of each data provider's durable `observedMutationGeneration()`, provider-record
  // commits). It is not comparable across authorities (each counts its own observations) and
  // nothing compares it across authorities; it is what the live-query engine's per-
  // registration dedup and the cursor's `rev` use.
  let applicationRevision = 0;
  let observedStateRevision = 0;
  let observedDataGeneration = 0;

  const distinctDataProviders = (): DataProvider[] => {
    const set = new Set<DataProvider>();
    if (defaultDataProvider) set.add(defaultDataProvider);
    for (const provider of Object.values(dataProviders)) set.add(provider);
    return [...set];
  };
  const sumProviderGenerations = async (): Promise<number> => {
    let sum = 0;
    for (const provider of distinctDataProviders()) {
      if (provider.observedMutationGeneration) sum += await provider.observedMutationGeneration();
    }
    return sum;
  };

  // ---- Distributed authority (spec12) ------------------------------------------------
  // A coordination provider activates multi-authority execution automatically (spec12 §88).
  // `resolveCoordinationConfig` throws on an unsafe combination (spec12 §90). The runner
  // itself is built lower down, once the effect terminal/observability hooks exist.
  const coordinationConfig: CoordinationConfig = resolveCoordinationConfig(options.distributed ?? {});
  const instanceId = coordinationConfig.instanceId ?? host.uuid();
  const coordination = options.coordination;
  const distributed = coordination !== undefined;
  const compatibilityKey = serverIrCompatibilityKey(ir);
  const compatibilityKeyStr = serverIrCompatibilityKeyString(ir);
  let distributedEffectRunner: DistributedEffectRunner | undefined;
  let distributedWorkStore: import('./durable-work.js').DurableWorkStore | undefined;

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
   * Distributed state coherence (spec12.1 §6-§9, §11, §17-§22).
   *
   * The in-memory `StateDef` representation inside a running authority is an **authority-local
   * cache** of persisted authoritative state — never an independent store. Before any
   * operation whose semantic result depends on authoritative `StateDef` state, this
   * re-observes the durable revision; if another authority has committed since, it reloads
   * the persisted state so execution proceeds from a coherent revision.
   *
   * - The correctness mechanism is durable-revision observation, never a broadcast: a lost
   *   notification cannot leave this authority indefinitely stale (§17).
   * - A refresh always corresponds to one coherent persisted revision — if the store moves
   *   while loading, it repeats (bounded) rather than mixing revisions (§19, §20).
   * - `storeRevision` is monotonic: this never publishes local state at a revision below one
   *   already observed (§22).
   *
   * Everything that calls this runs inside the server's single serialized queue, so there is
   * never a concurrent refresh within one authority.
   */
  async function ensureStateCoherent(): Promise<void> {
    let observed = await persistence.revision();
    if (observed <= storeRevision) {
      return;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const rows = await persistence.load();
      const after = await persistence.revision();
      if (after !== observed && attempt < 7) {
        observed = after;
        continue;
      }
      for (const row of rows) {
        const state = statesById.get(row.stateId);
        if (!state || state.derivation) {
          continue;
        }
        runtime.hydrateState(row.stateId, row.value);
        revisions.set(row.stateId, row.revision);
      }
      if (observed > storeRevision) {
        storeRevision = observed;
      }
      // A reload may change any cached query result (a principal/policy-scoped entry
      // included); the query cache already invalidates blindly on any commit (spec 0.10 §72).
      invalidateQueryCache();
      return;
    }
  }

  /**
   * Re-observe both durable sources (StateDef persistence revision *and* each data
   * provider's mutation generation) on behalf of idle live subscriptions. If either has
   * advanced past what this authority has already folded in — i.e. another authority
   * committed a `StateDef` *or* a provider-record mutation — reconcile and wake every live
   * subscription with a `broad` changeset (spec13.1 F1, §45, §48). A local commit already
   * advanced `applicationRevision` and woke the engine precisely, so this never double-fires
   * for local work.
   */
  let liveRevisionPollRunning = false;
  async function pollRemoteRevisionForLiveQueries(): Promise<void> {
    if (liveRevisionPollRunning || liveEngine.list().length === 0) return;
    liveRevisionPollRunning = true;
    try {
      const [state, data] = await Promise.all([persistence.revision(), sumProviderGenerations()]);
      if (state <= observedStateRevision && data <= observedDataGeneration) return;
      observedStateRevision = Math.max(observedStateRevision, state);
      observedDataGeneration = Math.max(observedDataGeneration, data);
      applicationRevision += 1;
      await ensureStateCoherent();
      await liveEngine.onCommit({
        toRevision: applicationRevision,
        entityIds: new Set<string>(),
        stateIds: new Set<string>(),
        broad: true,
      });
    } catch {
      // A transient persistence / provider read failure is retried on the next tick; a live
      // query is never wedged by one missed poll (the durable sources stay authoritative).
    } finally {
      liveRevisionPollRunning = false;
    }
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

  const knownStateIdStrings = new Set<string>([...statesById.keys()].map(String));

  /**
   * Defence in depth for spec13.1 F2, §81: `compileToServerIR` already rejects a graph whose
   * `QueryDef` clause references a `StateDef` (the provider binds no authority state). If a
   * hand-built IR bypasses that, fail explicitly here rather than serving a plausible but
   * wrong empty result.
   */
  function queryStateRefProblem(query: QueryDef): string[] {
    return queryStateReferences(query, knownStateIdStrings, policyForQuery(query, readPolicies));
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

    const stateRefs = queryStateRefProblem(query);
    if (stateRefs.length > 0) {
      return queryError(
        SERVER_DIAGNOSTIC_CODES.QUERY_STATE_REF_NOT_ALLOWED,
        `Query ${String(query.id)} references StateDef(s) ${stateRefs.join(', ')}, which a query cannot bind`,
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
          ...(ir.schemaFingerprint ? { schemaFingerprint: ir.schemaFingerprint } : {}),
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
          ...(ir.schemaFingerprint ? { s: ir.schemaFingerprint } : {}),
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

  interface LiveQueryContext {
    identity: ReturnType<typeof liveQueryIdentity>;
    spec: LiveSubscriptionSpec;
    capability: ReturnType<typeof queryLiveCapability>;
  }

  /**
   * Resolve a live query's logical identity and its recompute-and-diff evaluator (spec13
   * §7, §26-§31, §56). The evaluator reconciles to the coherent durable revision (0.12.1)
   * and returns one bounded authoritative result, so every re-evaluation is single-revision.
   */
  async function liveQueryContext(
    queryId: string,
    args: Record<string, unknown>,
    credential: unknown,
  ): Promise<
    | { ok: false; code: ServerDiagnosticCode; message: string }
    | { ok: true; value: LiveQueryContext }
  > {
    const query = queriesById.get(queryId as never);
    if (!query) {
      return { ok: false, code: SERVER_DIAGNOSTIC_CODES.QUERY_NOT_FOUND, message: `No query ${String(queryId)}` };
    }
    const provider = providerFor(query.source);
    if (!provider) {
      return {
        ok: false,
        code: SERVER_DIAGNOSTIC_CODES.QUERY_PROVIDER_MISSING,
        message: `No data provider is registered for ${String(query.source)}`,
      };
    }
    const stateRefs = queryStateRefProblem(query);
    if (stateRefs.length > 0) {
      return {
        ok: false,
        code: SERVER_DIAGNOSTIC_CODES.QUERY_STATE_REF_NOT_ALLOWED,
        message: `Query ${String(query.id)} references StateDef(s) ${stateRefs.join(', ')}, which a query cannot bind`,
      };
    }
    // A live query needs its provider commits to be observable to other authorities
    // (spec13.1 F1, §33, §123). A writable provider that offers no mutation generation is
    // refused rather than silently serving stale results on a peer.
    if (
      provider.applyMutations &&
      provider.capabilities.mutationObservation === 'none'
    ) {
      return {
        ok: false,
        code: SERVER_DIAGNOSTIC_CODES.LIVE_QUERY_PROVIDER_NOT_OBSERVABLE,
        message: `The data provider for ${String(query.source)} cannot make committed mutations observable across authorities`,
      };
    }
    const declared = new Map((query.parameters ?? []).map((p) => [String(p.id), p]));
    const resolvedArgs: Record<string, LiteralValue> = {};
    for (const [key, value] of Object.entries(args ?? {})) {
      if (!declared.has(key)) {
        return { ok: false, code: SERVER_DIAGNOSTIC_CODES.QUERY_ARGUMENT_TYPE_MISMATCH, message: `${query.id} has no parameter ${key}` };
      }
      resolvedArgs[key] = value as LiteralValue;
    }
    for (const parameter of query.parameters ?? []) {
      const key = String(parameter.id);
      if (resolvedArgs[key] === undefined && parameter.required !== false) {
        return { ok: false, code: SERVER_DIAGNOSTIC_CODES.QUERY_ARGUMENT_TYPE_MISMATCH, message: `${query.id} requires ${parameter.name ?? parameter.id}` };
      }
    }

    const principal = ((host.authenticate ? await host.authenticate(credential as never) : null) ??
      null) as Record<string, LiteralValue> | null;
    const policy = policyForQuery(query, readPolicies);
    const sourceIdentityFieldId = entities.get(query.source)?.identityFieldId;
    const identityFieldId = sourceIdentityFieldId ? String(sourceIdentityFieldId) : undefined;
    const capability = queryLiveCapability(query, identityFieldId, knownStateIdStrings);
    const ordered = (query.sort?.length ?? 0) > 0;
    const resultCap = Math.min(queryMaxPageSize(query), provider.capabilities.maxPageSize);

    const identity = liveQueryIdentity({
      queryId: String(query.id),
      argumentsFingerprint: await fingerprint(resolvedArgs),
      principalFingerprint: await fingerprint(principal ?? 'anon'),
      policyFingerprint: await fingerprint(policy ? policy.predicate : 'none'),
      compatibilityFingerprint: compatibilityKeyStr,
    });

    const reevaluate = async (): Promise<LiveEvaluation> => {
      await ensureStateCoherent();
      const providerQuery = buildProviderQuery({
        query,
        policy,
        relationships,
        ...(sourceIdentityFieldId ? { sourceIdentityFieldId } : {}),
        arguments: resolvedArgs,
        principal,
        pageSize: resultCap,
        strategy: queryPaginationStrategy(query),
      });
      if (queryIsAggregate(query)) {
        const result = await provider.aggregate(providerQuery);
        return {
          // spec13.1 F1: a live result is stamped with the observable application revision,
          // which advances for a provider-record commit too — not `storeRevision` (StateDef only).
          revision: applicationRevision,
          rows: result.ok ? result.value.rows.map((r) => r.values) : [],
          resetOnly: true,
        };
      }
      const result = await provider.query(providerQuery);
      return {
        revision: applicationRevision,
        rows: result.ok ? result.value.items : [],
        resetOnly: capability.capability !== 'live-capable',
      };
    };

    const spec: LiveSubscriptionSpec = {
      identity,
      dependencies: queryDependencies(query, policy ?? undefined, relationships, new Set([...statesById.keys()].map(String))),
      identityFieldId,
      ordered,
      resultCap,
      reevaluate,
    };
    return { ok: true, value: { identity, spec, capability } };
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

  // ---- Durable workflows (spec14) --------------------------------------------------

  // spec14pt4 §29, §30 — a hand-tampered IR may carry `workflows` as the wrong shape
  // entirely (a string, an object, a one-element array holding `null`). Route anything
  // present-but-not-an-empty-array into the engine's total admission validator so it fails
  // closed with a structured `WorkflowIRError` rather than being silently ignored (`{}` has
  // no `.length`) or reaching a native `TypeError`.
  // Anything other than absent-or-empty-array is routed into the engine's total admission
  // validator (`null`, a string, an object, a non-empty array) so it fails closed rather
  // than being silently ignored (`{}` / `null` have no useful `.length`).
  const declaredWorkflows = ir.workflows as unknown;
  const workflowsDeclared =
    declaredWorkflows !== undefined &&
    (!Array.isArray(declaredWorkflows) || declaredWorkflows.length > 0);

  const workflowStore: WorkflowStore | undefined = workflowsDeclared
    ? options.workflowStore ?? createMemoryWorkflowStore()
    : undefined;

  const workflowEngine: WorkflowEngine | undefined = workflowStore
    ? createWorkflowEngine({
        // Pass the declared value **through unchanged** (never `?? []`) so a tampered
        // `null` / string / object reaches the total admission validator instead of being
        // coalesced to an empty list (spec14pt4 §29, §63).
        workflows: declaredWorkflows as readonly WorkflowDef[],
        store: workflowStore,
        compatibilityFingerprint: compatibilityKeyStr,
        instanceId,
        ...(coordination ? { coordination, leaseMs: coordinationConfig.leaseDurationMs } : {}),
        resolvePrincipal: async (credential) => {
          const principal = (host.authenticate ? await host.authenticate(credential as never) : null) ?? null;
          return { principal, fingerprint: await fingerprint(principal ?? 'anon') };
        },
        // A workflow ActionDef step runs as a system invocation under the workflow's bound
        // principal, with the stable logical invocation identity as its request id. A crash
        // between "action committed" and "workflow transition recorded" is reconciled by the
        // **durable** idempotency record `invokeCore` commits atomically with the state
        // (spec14pt2 F1) — a recovery authority with an empty in-memory cache still returns
        // the canonical outcome instead of executing the action twice (spec14 §31, §32).
        invokeAction: async ({ actionId, arguments: args, principal, invocationId }) => {
          const context: ExecutionContext = { principal: principal as PrincipalRecord | null, source: 'system' };
          const replayKey = recordKey(context.principal, invocationId);
          const cached = replies.get(replayKey);
          const response = (cached ??
            (await invokeCore(nodeId(actionId), args, context, invocationId, replayKey, 0))) as InvokeResponse;
          const ok = response.ok === true;
          const codes = (response.diagnostics ?? []).map((d) => ({ code: String(d.code), message: d.message }));
          const retryable = !ok && codes.some((d) => d.code === 'CONCURRENCY_CONFLICT' || d.code === 'AUTHORITY_UNREACHABLE');
          return { ok, retryable, diagnostics: codes };
        },
      })
    : undefined;

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

    // spec12.1 §9, §41-§44: an ActionDef transaction MUST begin from a StateDef snapshot
    // corresponding to the persistence revision it will attempt to commit against — for a
    // client request, a trigger, a scheduled firing, an event-invoked action or an
    // effect-outcome action alike. Reconcile to the durable revision before any
    // state-dependent semantics (guards, authorization, constraints, operations) run.
    await ensureStateCoherent();

    // spec14pt2 F1: a durable idempotency record proves this exact invocation already
    // logically committed. A recovery authority — a fresh process with no in-memory request
    // cache, resuming a workflow's action step after the original authority died between
    // "state committed" and "workflow transition recorded" — returns the canonical answer
    // here instead of executing the action a second time. The record is written atomically
    // with the state commit below (`PersistenceCommit.idempotency`), so it can never be
    // present without the matching durable state.
    if (replayKey && persistence.loadIdempotentResponse) {
      const durable = await persistence.loadIdempotentResponse(replayKey);
      if (durable) {
        remember(replayKey, durable.response as InvokeResponse);
        report({ kind: 'replay', actionId, ...(requestId ? { requestId } : {}) });
        return { ...(durable.response as InvokeResponse), replayed: true };
      }
    }

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
          // spec13.1 F1: a provider-record commit writes no durable `StateDef`, so the action
          // returns before the durable-commit path below and `persistence.revision()` does
          // not move. The provider's durable `observedMutationGeneration` did move (atomic
          // with `applyMutations`); fold it into `applicationRevision` here so a remote
          // authority's poll and this authority's own live queries both see the change.
          observedDataGeneration = await sumProviderGenerations();
          applicationRevision += 1;
          void liveEngine.onCommit({
            toRevision: applicationRevision,
            stateIds: new Set<string>(),
            entityIds: new Set(providerEntitiesWritten(action).map((id) => String(id))),
          });
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
        // A successful invocation that wrote no durable state and dispatched no effect is
        // idempotent by vacuity, but record it durably anyway so a recovery authority skips
        // even the re-evaluation (spec14pt2 F1). Non-atomic is fine here: there is no state
        // it could disagree with. A failed invocation is deliberately not recorded — a
        // retryable workflow action must be free to run again.
        if (ok && persistence.recordIdempotentResponse) {
          await persistence.recordIdempotentResponse(replayKey, response, window).catch(() => {});
        }
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
    // The canonical answer, computed before the commit so it can ride *inside* the commit
    // transaction as a durable idempotency record (spec14pt2 F1). `changedObservables` is
    // pure and the mutations are already applied to the runtime, so this is the same value
    // the post-commit `respond` produces — only the revision is anticipated, and corrected
    // below if another authority advanced the store in between.
    const changes = changedObservables(observedBefore);
    const anticipatedRevision = storeRevision + 1;
    const committedResponse = replayKey
      ? respond(true, result.diagnostics, changes, requestId, anticipatedRevision)
      : undefined;
    const outcome = await persistence.commit({
      writes: writes.map((stateId) => ({ stateId, value: runtime.getState(stateId) })),
      expected,
      ...(effectsToCommit.length > 0 ? { effects: effectsToCommit } : {}),
      ...(replayKey && committedResponse
        ? { idempotency: { key: replayKey, response: committedResponse, window } }
        : {}),
    });

    if (!outcome.committed) {
      // Nothing durable was written, so nothing in memory may survive either.
      for (const stateId of writes) {
        runtime.hydrateState(stateId, before.get(stateId));
      }
      // spec12.1 §11, §14, §15: this authority lost an optimistic concurrency race. The
      // losing invocation returns CONCURRENCY_CONFLICT (no silent replay, §12) — but the
      // authority itself MUST recover: its local StateDef is now known invalid, so reload
      // the winning durable state before it processes any subsequent request. Without this,
      // the base revision stays stale and every future commit fails the same way (the F1
      // wedge).
      await ensureStateCoherent();
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
    // Live queries (spec13 §63, §64, §74): wake every subscription whose dependency set
    // this commit may have touched — the durable state ids it wrote and the provider-backed
    // entity ids the action mutates. Conservative: a `broad` subscription re-evaluates
    // regardless. Fire-and-forget — the transaction has already committed. A mixed
    // StateDef + provider-record action also advanced the provider generation above, so fold
    // both durable sources in (spec13.1 §24, §62).
    observedStateRevision = Math.max(observedStateRevision, outcome.revision);
    if (providerEntitiesWritten(action).length > 0) {
      observedDataGeneration = await sumProviderGenerations();
    }
    applicationRevision += 1;
    void liveEngine.onCommit({
      toRevision: applicationRevision,
      stateIds: new Set(writes.map((id) => String(id))),
      entityIds: new Set(providerEntitiesWritten(action).map((id) => String(id))),
    });
    for (const effect of effectsToCommit) {
      effectRecords.set(effect.id, effect);
      report({ kind: 'effect-requested', actionId: action.id, effectId: effect.id, operationId: effect.operationId });
    }
    if (effectsToCommit.length > 0) {
      // Never awaited: the transaction has already committed, and the response the caller
      // gets back reflects "committed, effect pending" (spec §123), not the effect's own
      // eventual success or failure. Under distributed authority the intent is registered as
      // durable work and picked up by the poll loop (or another authority) instead.
      if (distributedEffectRunner) {
        distributedEffectRunner.dispatch(effectsToCommit);
        void distributedEffectRunner.poll();
      } else {
        effectRunner.dispatch(effectsToCommit);
      }
    }

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
      // The atomic idempotency record already committed with the state and guarantees no
      // re-execution. If the store advanced past our anticipation (another authority
      // committed unrelated state in the same window), upgrade the durable copy to carry
      // the exact revision — best-effort, correctness does not depend on it.
      if (
        committedResponse &&
        outcome.revision !== anticipatedRevision &&
        persistence.recordIdempotentResponse
      ) {
        await persistence.recordIdempotentResponse(replayKey, response, window).catch(() => {});
      }
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
    revisionOverride?: number,
  ): InvokeResponse {
    return {
      kind: 'result',
      protocol: PROTOCOL_VERSION,
      ok,
      diagnostics: diagnostics.map(disclosable),
      changes,
      revision: revisionOverride ?? storeRevision,
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
    // Durable workflows waiting on this event type are driven off the same accepted-event
    // occurrence (spec14 §51, §54-§60). The engine journals it durably and allocates the
    // store-global observation `seq` itself (spec14pt2 F2); dedup has already collapsed a
    // redelivered physical event upstream.
    if (workflowEngine) {
      void workflowEngine.onEventAccepted(String(eventId), payload);
    }
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
    // Distributed authority (spec12 §21-§23): gate each interval/delay firing on a fenced,
    // durable claim keyed by `scheduleId@dueInstant`, so N authorities polling their own
    // timers cause exactly one logical firing. `distributedWorkStore` is assigned lower down
    // (only when a coordination provider is wired); this closure reads it at fire time.
    ...(options.coordination
      ? {
          claimScheduledFiring: async (
            trigger: TriggerDef,
            dueInstant: number,
          ): Promise<null | ((ok: boolean) => Promise<void>)> => {
            if (!distributedWorkStore) return null;
            const workId = scheduledFiringId(trigger.id, dueInstant);
            await distributedWorkStore.enqueue({
              workClass: SCHEDULE_FIRING_WORK_CLASS,
              workId,
              payload: { triggerId: String(trigger.id), dueInstant },
            });
            const claim = await distributedWorkStore.claimOne(
              SCHEDULE_FIRING_WORK_CLASS,
              workId,
              instanceId,
              { leaseMs: coordinationConfig.leaseDurationMs },
            );
            if (!claim) return null;
            return async (ok: boolean) => {
              await distributedWorkStore!.settle(
                claim,
                ok
                  ? { kind: 'succeeded', result: null }
                  : { kind: 'failed', error: { code: 'SCHEDULED_FIRING_REFUSED', message: `${String(trigger.id)}@${dueInstant}` } },
              );
            };
          },
        }
      : {}),
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

  // The distributed outbox (spec12 §13-§20): when a coordination provider is wired, each
  // committed effect intent becomes a leased, fenced `DurableWorkItem` that exactly one
  // authority claims, attempts and settles. The legacy single-writer `effectRunner` above is
  // still used when no provider is supplied.
  if (distributed && coordination) {
    const workStore = createDurableWorkStore({
      coordination,
      storage: options.workStorage ?? createMemoryDurableWorkStorage(),
      authorityKey: compatibilityKeyStr,
      defaultLeaseMs: coordinationConfig.leaseDurationMs,
    });
    distributedWorkStore = workStore;
    distributedEffectRunner = createDistributedEffectRunner({
      store: workStore,
      execution: { adapters, integrationOperations, blobStores, storages: storagesById },
      host,
      instanceId,
      config: coordinationConfig,
      onTerminal: (record) => onEffectTerminal(record),
      onAttempt: (record) => {
        effectRecords.set(record.id, record);
      },
      report: (event) =>
        report({
          kind:
            event.kind === 'effect-outcome-uncertain' || event.kind === 'effect-retry-scheduled'
              ? 'effect-attempted'
              : event.kind,
          effectId: event.effectId,
          operationId: event.operationId,
          attempt: event.attempt,
        }),
    });
  }

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
      const persisted = await persistence.load();

      // The schema-compatibility gate (spec11 §11-12, hardened spec11.1 §4-14). There is no
      // hopeful startup, and no `compatible` claim for a relationship that was never checked.
      if (migrationMetadata) {
        // Run the gate whenever a store is supplied — this catches an unversioned graph
        // pointed at a versioned provider (spec11.1 §7, D-2).
        const gate = await evaluateSchemaGate(ir, migrationMetadata, {
          hasPersistedData: persisted.length > 0,
        });
        if (!gateAllowsStart(gate)) {
          throw new Error(`${gate.code ?? 'SCHEMA_INCOMPATIBLE'}: ${gate.message}`);
        }
        if (gate.status === 'fresh') {
          await migrationMetadata.writeSchema(ir.schemaVersion ?? 1, ir.schemaFingerprint ?? '');
        }
      } else if (declaresSchemaVersion) {
        // A graph that declares semantic schema evolution but was given no metadata store:
        // the gate cannot run, so startup is refused rather than silently assuming
        // compatibility (spec11.1 §8, D-2).
        const gate = schemaGateWithoutStore(ir);
        throw new Error(`${gate.code}: ${gate.message}`);
      }

      // spec12.1 §37: publish a coherent (state, revision) pair. `persisted` above may be a
      // read behind by now (the migration gate did async work); re-load so the hydrated
      // state and `storeRevision` identify the same durable revision, repeating if a
      // concurrent authority commits during the load (§19, §20).
      let coherent: typeof persisted;
      let coherentAt: number;
      for (let attempt = 0; ; attempt += 1) {
        coherentAt = await persistence.revision();
        coherent = await persistence.load();
        const after = await persistence.revision();
        if (after === coherentAt || attempt >= 7) {
          break;
        }
      }
      for (const entry of coherent) {
        if (statesById.has(entry.stateId)) {
          runtime.hydrateState(entry.stateId, entry.value);
          revisions.set(entry.stateId, entry.revision);
        }
      }
      storeRevision = coherentAt;
      // A crash between an effect intent's commit and its dispatch must not lose it: every
      // pending intent found on restart resumes dispatch here (spec §19,96,140).
      const pending = (await persistence.loadPendingEffects?.()) ?? [];
      for (const effect of pending) {
        effectRecords.set(effect.id, effect);
      }
      if (distributedEffectRunner) {
        // Re-register any intent this authority still holds — `enqueue` is idempotent, so a
        // sibling authority that already picked it up is unaffected — then run the poll loop
        // so this and every other class of orphaned durable work is reclaimed (spec12 §7).
        if (pending.length > 0) {
          distributedEffectRunner.dispatch(pending);
        }
        distributedEffectRunner.start();
        void distributedEffectRunner.poll();
      } else if (pending.length > 0) {
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

      // spec13.1 F1 / §45: the idle-authority poll for live queries served here while
      // another authority commits a StateDef *or* a provider-record mutation. Harmless for a
      // single authority (it never observes an advance it did not already fold in). Seed the
      // observed points from the current durable state so the first tick is not a spurious
      // broad wake.
      observedStateRevision = Math.max(observedStateRevision, await persistence.revision());
      observedDataGeneration = Math.max(observedDataGeneration, await sumProviderGenerations());
      if (liveQueryPollMs > 0 && !liveQueryPollTimer) {
        liveQueryPollTimer = setInterval(() => void pollRemoteRevisionForLiveQueries(), liveQueryPollMs);
        liveQueryPollTimer.unref?.();
      }

      // Durable workflows resume last: an authority discovers every runnable / retry-due /
      // timer-due / recoverably-waiting instance and advances it, with no application
      // intervention (spec14 §94, §95).
      await workflowEngine?.start();
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
        if (migrationMetadata) {
          // While a migration is running, authoritative traffic is refused rather than
          // applied to data that is mid-transition (spec11 §68, spec11.1 §12). 0.11 has no
          // online migration; a host that wants zero-downtime must sequence it itself.
          //
          // A residual SQLite contention error here (after the store's bounded busy
          // handling) means another process is holding/establishing migration ownership on
          // the shared database — a request-time race with a migrator resolves to
          // `MIGRATION_IN_PROGRESS`, never a leaked provider error (spec11.2 §34).
          let migrationLockHeld: boolean;
          try {
            migrationLockHeld = (await migrationMetadata.readLock()) !== null;
          } catch (error) {
            if (!isSqliteContentionError(error)) throw error;
            migrationLockHeld = true;
          }
          if (migrationLockHeld) {
            migrationLockSeen = true;
            return {
              kind: 'error' as const,
              protocol: PROTOCOL_VERSION,
              diagnostics: [
                diagnostic(
                  SERVER_DIAGNOSTIC_CODES.MIGRATION_IN_PROGRESS,
                  'a schema migration is in progress; the authority is not serving requests',
                ),
              ],
            };
          }
          if (migrationLockSeen && !schemaOutdated) {
            // A migration that ran under this process has just finished. Either the schema
            // still matches this build — invalidate the (now possibly stale) query cache
            // (spec11 §45) — or it moved past this build and this authority must stop
            // serving until it is redeployed (spec11 §103). If the post-migration schema
            // read still contends, defer the decision to the next request rather than
            // leaking the error.
            let record: Awaited<ReturnType<MigrationMetadataStore['readSchema']>> | undefined;
            try {
              record = await migrationMetadata.readSchema();
            } catch (error) {
              if (!isSqliteContentionError(error)) throw error;
              record = undefined;
            }
            if (record !== undefined) {
              migrationLockSeen = false;
              if (
                record &&
                (record.schemaVersion !== (ir.schemaVersion ?? 1) ||
                  record.schemaFingerprint !== (ir.schemaFingerprint ?? ''))
              ) {
                schemaOutdated = true;
              } else {
                invalidateQueryCache();
              }
            }
          }
          if (schemaOutdated) {
            return {
              kind: 'error' as const,
              protocol: PROTOCOL_VERSION,
              diagnostics: [
                diagnostic(
                  SERVER_DIAGNOSTIC_CODES.SCHEMA_INCOMPATIBLE,
                  'the persisted schema has advanced past this build; redeploy the authority',
                ),
              ],
            };
          }
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
          // spec12.1 §8.1, §13, §38, §64: a SnapshotRequest arriving after another
          // authority's commit MUST observe state at least as new as that commit. Reconcile
          // to the durable revision before answering — this is the protocol path a real
          // consumer reads authoritative state through, and it is a permanent regression
          // requirement.
          await ensureStateCoherent();
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

    snapshot: () => snapshotOf(),
    getState: (id: NodeId) => runtime.getState(id),
    revision: () => storeRevision,
    async coherentSnapshot(): Promise<StateSnapshot> {
      return serialize(async () => {
        await ensureStateCoherent();
        return snapshotOf();
      });
    },
    mutationLog: () => runtime.getMutationLog(),
    effectLog: () => [...effectRecords.values()].map((entry) => ({ ...entry })),
    subscriptionLog: () => subscriptionRuntime.status(),
    subscriptionStatus: (id: NodeId) => subscriptionRuntime.statusOf(id),
    blobLog: () =>
      [...effectRecords.values()].filter((entry) => entry.storage !== undefined).map((entry) => ({ ...entry })),
    async schemaGate(): Promise<SchemaGateResult> {
      // Never claim `compatible` for a relationship that was not checked (spec11.1 §5).
      if (!migrationMetadata) {
        return schemaGateWithoutStore(ir);
      }
      return evaluateSchemaGate(ir, migrationMetadata, {
        hasPersistedData: (await persistence.load()).length > 0,
      });
    },
    async getMigrationStatus(): Promise<MigrationStatus | null> {
      return migrationMetadata ? getMigrationStatus(migrationMetadata) : null;
    },
    clearQueryCache: invalidateQueryCache,
    queryCacheStats: () => ({ entries: queryCache.size, hits: queryCacheHits, enabled: cacheEnabled }),

    async startWorkflow(request) {
      if (!workflowEngine) {
        return { error: { code: SERVER_DIAGNOSTIC_CODES.MALFORMED_REQUEST, message: 'this authority runs no workflows' } };
      }
      return workflowEngine.startWorkflow(request);
    },
    async cancelWorkflow(instanceId, credential) {
      if (!workflowEngine) {
        return { error: { code: SERVER_DIAGNOSTIC_CODES.MALFORMED_REQUEST, message: 'this authority runs no workflows' } };
      }
      return workflowEngine.cancelWorkflow(instanceId, credential);
    },
    async getWorkflow(instanceId) {
      return workflowEngine?.getWorkflow(instanceId);
    },
    async inspectWorkflows(limit) {
      return workflowEngine ? workflowEngine.listWorkflows(limit) : [];
    },
    async workflowHistory(instanceId) {
      return workflowEngine
        ? ((await workflowEngine.workflowHistory(instanceId)) as unknown as Array<Record<string, unknown>>)
        : [];
    },

    async openLiveQuery(request) {
      return serialize(async () => {
        const ctx = await liveQueryContext(request.queryId, request.arguments ?? {}, request.credential);
        if (!ctx.ok) return { error: { code: ctx.code, message: ctx.message } };
        if (ctx.value.capability.capability === 'not-live-capable') {
          return {
            error: {
              code: SERVER_DIAGNOSTIC_CODES.LIVE_QUERY_NOT_CAPABLE,
              message: ctx.value.capability.reason,
            },
          };
        }
        // spec13 §10, §11 (model A): reconcile, capture R, evaluate at R, register from R —
        // all inside this serialized turn, so no local commit interleaves.
        const initial = await ctx.value.spec.reevaluate();
        return liveEngine.register(newSubscriptionId(), ctx.value.spec, initial);
      });
    },

    async resumeLiveQuery(cursor, request) {
      return serialize(async () => {
        const payload = openLiveCursor(cursor, cursorSecret);
        if (!payload) {
          return { error: { code: SERVER_DIAGNOSTIC_CODES.LIVE_QUERY_CURSOR_INVALID, message: 'malformed or unsigned live-query cursor' } };
        }
        const ctx = await liveQueryContext(request.queryId, request.arguments ?? {}, request.credential);
        if (!ctx.ok) return { error: { code: ctx.code, message: ctx.message } };
        const mismatch = liveCursorMatch(payload, ctx.value.identity);
        if (mismatch !== 'ok') {
          const code =
            mismatch === 'compatibility'
              ? SERVER_DIAGNOSTIC_CODES.LIVE_QUERY_CURSOR_INCOMPATIBLE
              : SERVER_DIAGNOSTIC_CODES.LIVE_QUERY_CURSOR_INVALID;
          return { error: { code, message: `live-query cursor does not match this request (${mismatch})` } };
        }
        // This authority has no materialized result for `payload.sub` — re-evaluate fresh at
        // the current coherent revision and hand the client a `reset` (spec13 §37, §38, §108).
        const current = await ctx.value.spec.reevaluate();
        return liveEngine.resume(payload.sub, ctx.value.spec, current);
      });
    },

    closeLiveQuery: (subscriptionId) => liveEngine.close(subscriptionId),
    inspectLiveQueries: () => liveEngine.list(),
    async revisionInspection() {
      return {
        applicationRevision,
        stateRevision: await persistence.revision(),
        dataGeneration: await sumProviderGenerations(),
      };
    },
    authority: (): AuthorityInfo => ({
      instanceId,
      distributed,
      coordination: coordination
        ? {
            provider: coordination.capabilities.provider,
            supports: coordination.capabilities.supports,
            physicalDurability: coordination.capabilities.physicalDurability,
          }
        : null,
      config: coordinationConfig,
      compatibilityKey,
    }),
    async inspectDistributedWork(): Promise<DistributedWorkInspection> {
      const authorityInfo: AuthorityInfo = {
        instanceId,
        distributed,
        coordination: coordination
          ? {
              provider: coordination.capabilities.provider,
              supports: coordination.capabilities.supports,
              physicalDurability: coordination.capabilities.physicalDurability,
            }
          : null,
        config: coordinationConfig,
        compatibilityKey,
      };
      if (!distributedWorkStore) {
        return { authority: authorityInfo, effects: [], schedules: [], incompatibleEffects: [] };
      }
      return {
        authority: authorityInfo,
        effects: await distributedWorkStore.list('effect'),
        schedules: await distributedWorkStore.list(SCHEDULE_FIRING_WORK_CLASS),
        incompatibleEffects: await distributedWorkStore.listIncompatible('effect'),
      };
    },

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
      workflowEngine?.stop();
      if (liveQueryPollTimer) {
        clearInterval(liveQueryPollTimer);
        liveQueryPollTimer = undefined;
      }
      await distributedEffectRunner?.stop();
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
    // spec15 — a document that carries authorization vocabulary but labels itself older
    // would let an older runtime accept it and skip enforcement (spec15 §46, §66).
    usesAuthorizationVocabulary(ir as never) ? 'axiom.server.v9' : 'axiom.server.v1',
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
