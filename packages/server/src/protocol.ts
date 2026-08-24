import type { NodeId, RuntimeDiagnostic } from './deps.js';

/**
 * The semantic protocol between a client runtime and an authority.
 *
 * A client requests **semantic operations** — "invoke action X with arguments Y" — never a
 * mutation program. The authority resolves the action from its own IR and decides. Nothing
 * here mentions HTTP, and nothing in an ApplicationGraph mentions a route or a verb.
 */

export const PROTOCOL_VERSION = 'axiom.protocol.v1';

/** Opaque credential material. The host, not the semantic runtime, interprets it. */
export type Credential = string | null;

export interface SnapshotRequest {
  kind: 'snapshot';
  protocol: typeof PROTOCOL_VERSION;
  credential?: Credential;
  /**
   * Ask for an incremental snapshot: a revision this caller already holds.
   *
   * The response then omits every observable state the authority can **prove** has not
   * changed since that revision, and sets `partial`. Omission always means unchanged;
   * inclusion never promises changed. A value that is not a non-negative safe integer is a
   * malformed request; a value the authority cannot reason about — ahead of its own
   * revision — is answered with a complete snapshot, which is always a valid answer.
   */
  sinceRevision?: number;
}

export interface InvokeRequest {
  kind: 'invoke';
  protocol: typeof PROTOCOL_VERSION;
  actionId: NodeId;
  /** Keyed by action parameter id. Untyped input: the authority validates it. */
  arguments?: Record<string, unknown>;
  credential?: Credential;
  /**
   * A caller-chosen key that makes a retry safe. The authority returns the recorded
   * response for a key it has already executed rather than executing again.
   */
  requestId?: string;
}

/**
 * Delivers a semantic event — an already-verified webhook payload, most commonly — for
 * dispatch to whatever `TriggerDef{when:{kind:'event'}}` is bound to it. Verification of
 * provider authenticity happens in the host adapter before this request is even
 * constructed (spec §53): a request that reaches this kind is treated as already trusted
 * to *have arrived*, though its payload is still validated against `EventDef.payloadType`
 * before any action sees it.
 */
export interface EventRequest {
  kind: 'event';
  protocol: typeof PROTOCOL_VERSION;
  eventId: NodeId;
  payload: unknown;
  credential?: Credential;
}

export type ServerRequest = SnapshotRequest | InvokeRequest | EventRequest;

/**
 * The authoritative value of the observable states the caller may see.
 *
 * Complete unless `partial` is set. A complete snapshot names every observable state; a
 * partial one names those that may have changed since the `sinceRevision` that was asked
 * for, and a state it does not name is unchanged since then. `revision` is the authority's
 * current revision either way, so a client can use it as the next `sinceRevision`.
 */
export interface StateSnapshot {
  revision: number;
  states: Record<NodeId, unknown>;
  /** Present and true only for the answer to a `sinceRevision` request. */
  partial?: boolean;
}

export interface InvokeResponse {
  kind: 'result';
  protocol: typeof PROTOCOL_VERSION;
  ok: boolean;
  /** Axiom diagnostics, unchanged: the same codes and details a local failure produces. */
  diagnostics: RuntimeDiagnostic[];
  /** Authoritative values after the transaction settled, for the states it touched. */
  changes: Record<NodeId, unknown>;
  revision: number;
  requestId?: string;
  /** True when this response was replayed for a repeated `requestId`. */
  replayed?: boolean;
}

export interface SnapshotResponse {
  kind: 'snapshot';
  protocol: typeof PROTOCOL_VERSION;
  snapshot: StateSnapshot;
}

/** A failure of the boundary itself, rather than of an application rule. */
export interface ErrorResponse {
  kind: 'error';
  protocol: typeof PROTOCOL_VERSION;
  diagnostics: RuntimeDiagnostic[];
}

export interface EventResponse {
  kind: 'event-result';
  protocol: typeof PROTOCOL_VERSION;
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
}

export type ServerResponse = InvokeResponse | SnapshotResponse | ErrorResponse | EventResponse;

/**
 * How a client reaches an authority. The first implementation is in-process and the second
 * is HTTP; neither is visible to application semantics, so a later WebSocket, worker or IPC
 * transport changes nothing in a graph.
 */
export interface TransportAdapter {
  send(request: ServerRequest): Promise<ServerResponse>;
}

export function isServerRequest(value: unknown): value is ServerRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ServerRequest>;
  return (
    candidate.protocol === PROTOCOL_VERSION &&
    (candidate.kind === 'invoke' || candidate.kind === 'snapshot' || candidate.kind === 'event')
  );
}
