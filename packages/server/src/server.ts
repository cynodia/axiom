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
  ServerIR,
  ServerIRContract,
  StateDef,
  TriggerDef,
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
import { PROTOCOL_VERSION } from './protocol.js';
import type {
  EventRequest,
  EventResponse,
  InvokeRequest,
  InvokeResponse,
  ServerRequest,
  ServerResponse,
  SnapshotResponse,
  StateSnapshot,
} from './protocol.js';

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
  /**
   * The action's `invocation.allowedSources` does not include this invocation's source
   * (spec 8.1 §3-9) — e.g. an ordinary client `InvokeRequest` naming a system-only action.
   * Distinct from `AUTHORIZATION_DENIED`: this is refused before identity is even
   * consulted, because no caller reaching the authority this way may invoke it at all.
   */
  INVOCATION_SOURCE_NOT_ALLOWED: 'INVOCATION_SOURCE_NOT_ALLOWED',
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

  const runtime = buildRuntime(ir, host, queryIntegration);
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
    // whether or not the action also happens to carry an authorization rule.
    runtime.hydrateState(PRINCIPAL, context.principal);

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

    if (!result.ok || (writes.length === 0 && committedIntents.length === 0)) {
      const response = respond(result.ok, result.diagnostics, {}, requestId);
      report({
        kind: 'invoke',
        actionId: action.id,
        ok: result.ok,
        principal: principalIdentity(context.principal),
        requestId,
        durationMs: Date.now() - startedAt,
        revision: storeRevision,
        diagnostics: result.diagnostics,
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

  /** Validates an external/internal event's payload, then dispatches it to bound triggers. */
  async function dispatchEvent(eventId: NodeId, payload: unknown, depth: number): Promise<RuntimeDiagnostic[]> {
    const event = eventsById.get(eventId);
    report({ kind: 'event-received', eventId });
    if (!event) {
      return [diagnostic(SERVER_DIAGNOSTIC_CODES.EVENT_PAYLOAD_INVALID, `Unknown event ${String(eventId)}`, { eventId })];
    }
    const problems = validateValueAgainstType(payload, event.payloadType, {
      path: 'payload',
      getEntity: (id) => entities.get(id),
    });
    if (problems.length > 0) {
      return [
        diagnostic(
          SERVER_DIAGNOSTIC_CODES.EVENT_PAYLOAD_INVALID,
          `${event.name ?? event.id}'s payload does not conform to its declared type`,
          { eventId, problems: problems.map((problem) => problem.message) },
        ),
      ];
    }
    await triggerRuntime.fireEvent(eventId, payload, depth);
    report({ kind: 'event-dispatched', eventId });
    return [];
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

  const effectRunner = createEffectRunner({
    adapters,
    integrationOperations,
    persistence,
    host,
    onTerminal: onEffectTerminal,
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
      const missing = (ir.integrations ?? []).filter((integration) => !adapters[integration.id]);
      if (missing.length > 0) {
        throw new Error(
          `Missing integration adapter(s): ${missing.map((integration) => integration.name ?? integration.id).join(', ')}`,
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

    async stop(): Promise<void> {
      triggerRuntime.stop();
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

function buildRuntime(ir: ServerIR, host: ServerHost, queryIntegration: QueryIntegration): AxiomRuntime {
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
    actions: ir.actions,
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
    },
  });
}
