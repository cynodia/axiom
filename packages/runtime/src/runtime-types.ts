/**
 * The handful of types the browser-safe gateway needs, declared without importing the
 * runtime module.
 *
 * `remote.ts` is inlined into generated pages, and a value import from core would be
 * stripped from that bundle. Keeping these local also means the gateway pulls in nothing
 * else at all.
 */
/**
 * Structurally identical to `NodeId` in `@cynodia/axiom-core`, and it must stay that way:
 * the brand exists only at compile time, so declaring the same shape here makes the two the
 * same type without an import the browser bundle cannot carry.
 * `packages/runtime/test/host.test.ts` fails if the two declarations drift apart.
 */
export type NodeId = string & { readonly __brand: 'NodeId' };

export interface RuntimeDiagnostic {
  /**
   * A code from `RUNTIME_DIAGNOSTIC_CODES` or `SERVER_DIAGNOSTIC_CODES`, but typed as a
   * string here on purpose: a diagnostic arriving over the wire is untrusted input, and a
   * gateway cannot promise it is one of ours. Match on it; do not switch exhaustively.
   */
  code: string;
  message: string;
  severity: 'error' | 'warning';
  details?: Record<string, unknown>;
  nodeId?: NodeId;
  actionId?: NodeId;
  constraintId?: NodeId;
  stateId?: NodeId;
  transactionId?: string;
}

/**
 * How a client runtime reaches an authority.
 *
 * It lives here, beside the browser-safe gateway, rather than in `runtime.ts`, so that the
 * gateway a page is given and the gateway the runtime accepts are the **same type**. When
 * they were declared separately, `createHttpRemoteGateway()` did not typecheck as one and
 * every consumer needed a cast — for a value the framework hands them itself.
 */
export interface RemoteGateway {
  invoke(request: {
    actionId: NodeId;
    arguments: Record<string, unknown>;
    requestId: string;
  }): Promise<{ ok: boolean; diagnostics: RuntimeDiagnostic[]; changes: Record<NodeId, unknown> }>;
  /** The authoritative values of every observable state. */
  snapshot?(): Promise<{ states: Record<NodeId, unknown> }>;
}
