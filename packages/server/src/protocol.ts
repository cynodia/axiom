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
  /** When given, only states changed after this revision are returned. */
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

export type ServerRequest = SnapshotRequest | InvokeRequest;

/** The authoritative value of every observable state the caller may see. */
export interface StateSnapshot {
  revision: number;
  states: Record<NodeId, unknown>;
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

export type ServerResponse = InvokeResponse | SnapshotResponse | ErrorResponse;

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
    (candidate.kind === 'invoke' || candidate.kind === 'snapshot')
  );
}
