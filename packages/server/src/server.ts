import {
  DEFAULT_THEME,
  PRINCIPAL,
  SERVER_IR_CONTRACT,
  optionalType,
  entityType,
  validateValueAgainstType,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ApplicationIR,
  EntityDef,
  LiteralValue,
  NodeId,
  ServerIR,
  StateDef,
} from '@cynodia/axiom-core';
import { MemoryElement, createAxiomRuntime, createMemoryHost } from '@cynodia/axiom-runtime';
import type { AxiomRuntime, MutationLogEntry, RuntimeDiagnostic } from '@cynodia/axiom-runtime';
import { createMemoryPersistence } from './persistence.js';
import type { PersistenceAdapter } from './persistence.js';
import { createServerHost } from './host.js';
import type { ExecutionContext, PrincipalRecord, ServerEvent, ServerHost } from './host.js';
import { PROTOCOL_VERSION } from './protocol.js';
import type {
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
} as const;

export type ServerDiagnosticCode =
  (typeof SERVER_DIAGNOSTIC_CODES)[keyof typeof SERVER_DIAGNOSTIC_CODES];

export interface AxiomServerOptions {
  ir: ServerIR;
  persistence?: PersistenceAdapter;
  host?: ServerHost;
  /** How many request ids to remember for idempotent retries. */
  idempotencyWindow?: number;
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
export function createAxiomServer(options: AxiomServerOptions): AxiomServer {
  if (options.ir.contract !== SERVER_IR_CONTRACT) {
    throw new Error(
      `Unsupported Server IR contract "${String(options.ir.contract)}"; this runtime executes ${SERVER_IR_CONTRACT}`,
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

  const runtime = buildRuntime(ir, host);
  let storeRevision = 0;
  const revisions = new Map<NodeId, number>();
  const replies = new Map<string, InvokeResponse>();
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

  /** Authorization, evaluated here and nowhere else. */
  function authorize(action: ActionDef, context: ExecutionContext): RuntimeDiagnostic | null {
    if (!action.authorization) {
      return null;
    }
    runtime.hydrateState(PRINCIPAL, context.principal);
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

  function snapshotOf(): StateSnapshot {
    const states: Record<NodeId, unknown> = {};
    for (const stateId of ir.observableStateIds) {
      states[stateId] = runtime.getState(stateId);
    }
    return { revision: storeRevision, states };
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
    const startedAt = Date.now();
    if (request.requestId) {
      const previous = replies.get(request.requestId);
      if (previous) {
        // A retry after a lost response must not execute the action a second time.
        report({ kind: 'replay', actionId: request.actionId, requestId: request.requestId });
        return { ...previous, replayed: true };
      }
    }

    // Resolved from this authority's own IR. A client's idea of what an action does is
    // never consulted.
    const action = ir.actions[request.actionId];
    if (!action) {
      const diagnostics = [
        diagnostic(
          SERVER_DIAGNOSTIC_CODES.UNKNOWN_SERVER_ACTION,
          `This authority does not execute ${String(request.actionId)}`,
          { actionId: request.actionId },
        ),
      ];
      report({ kind: 'reject', actionId: request.actionId, ok: false, diagnostics });
      return refusal(diagnostics, request.requestId);
    }

    const context: ExecutionContext = {
      principal: await resolvePrincipal(request),
      ...(request.credential !== undefined ? { credential: request.credential } : {}),
      ...(request.requestId ? { requestId: request.requestId } : {}),
    };

    const argumentProblems = checkArguments(action, request.arguments ?? {});
    if (argumentProblems.length > 0) {
      report({ kind: 'reject', actionId: action.id, ok: false, diagnostics: argumentProblems });
      return refusal(argumentProblems, request.requestId);
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
      return refusal([denial], request.requestId);
    }

    // Everything the transaction might touch, as it stands now, so a refused commit can be
    // undone exactly.
    const before = new Map<NodeId, LiteralValue>();
    for (const stateId of durableStateIds) {
      before.set(stateId, runtime.getState(stateId) as LiteralValue);
    }
    const mark = runtime.getMutationLog().length;

    runtime.clearDiagnostics();
    const result = runtime.invokeAction(action.id, request.arguments ?? {});

    const written = new Set<NodeId>();
    for (const entry of runtime.getMutationLog().slice(mark)) {
      if (entry.outcome === 'committed') {
        written.add(entry.path.rootStateId);
      }
    }
    const writes = [...written].filter((stateId) => durableStateIds.includes(stateId));

    if (!result.ok || writes.length === 0) {
      const response = respond(result.ok, result.diagnostics, {}, request.requestId);
      report({
        kind: 'invoke',
        actionId: action.id,
        ok: result.ok,
        principal: principalIdentity(context.principal),
        requestId: request.requestId,
        durationMs: Date.now() - startedAt,
        revision: storeRevision,
        diagnostics: result.diagnostics,
        committed: [],
      });
      if (request.requestId) {
        remember(request.requestId, response as InvokeResponse);
      }
      return response;
    }

    const expected: Record<NodeId, number> = {};
    for (const stateId of writes) {
      expected[stateId] = revisions.get(stateId) ?? 0;
    }
    const outcome = await persistence.commit({
      writes: writes.map((stateId) => ({ stateId, value: runtime.getState(stateId) })),
      expected,
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
      const response = refusal(diagnostics, request.requestId);
      if (request.requestId) {
        remember(request.requestId, response as InvokeResponse);
      }
      return response;
    }

    storeRevision = outcome.revision;
    for (const stateId of writes) {
      revisions.set(stateId, outcome.revision);
    }

    const changes: Record<NodeId, unknown> = {};
    for (const stateId of ir.observableStateIds) {
      if (written.has(stateId) || ir.states.find((state) => state.id === stateId)?.derivation) {
        changes[stateId] = runtime.getState(stateId);
      }
    }

    const response = respond(true, result.diagnostics, changes, request.requestId);
    report({
      kind: 'invoke',
      actionId: action.id,
      ok: true,
      principal: principalIdentity(context.principal),
      requestId: request.requestId,
      durationMs: Date.now() - startedAt,
      revision: storeRevision,
      committed: writes,
    });
    if (request.requestId) {
      remember(request.requestId, response as InvokeResponse);
    }
    return response;
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
      diagnostics,
      changes,
      revision: storeRevision,
      ...(requestId ? { requestId } : {}),
    };
  }

  function refusal(diagnostics: RuntimeDiagnostic[], requestId?: string): InvokeResponse {
    return respond(false, diagnostics, {}, requestId);
  }

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }
      started = true;
      // Committed state is restored administratively: it is already authoritative, so it
      // is not re-validated as though it were being proposed.
      for (const entry of await persistence.load()) {
        if (statesById.has(entry.stateId)) {
          runtime.hydrateState(entry.stateId, entry.value);
          revisions.set(entry.stateId, entry.revision);
        }
      }
      storeRevision = await persistence.revision();
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
          report({ kind: 'snapshot', revision: storeRevision });
          const response: SnapshotResponse = {
            kind: 'snapshot',
            protocol: PROTOCOL_VERSION,
            snapshot: snapshotOf(),
          };
          return response;
        }
        if (request.kind === 'invoke') {
          return invoke(request);
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

    async stop(): Promise<void> {
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
function buildRuntime(ir: ServerIR, host: ServerHost): AxiomRuntime {
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
  };

  const dom = createMemoryHost();
  return createAxiomRuntime({
    ir: applicationIR,
    rootElement: new MemoryElement('div'),
    host: { ...dom, now: () => host.now(), uuid: () => host.uuid() },
  });
}
