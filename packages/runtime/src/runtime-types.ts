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

/**
 * The UI node kinds the browser renderer draws.
 *
 * It lives beside the renderer rather than in core because the renderer is what has to be
 * true to it: a kind listed here without a `case` in `renderNode` is a lie that validation
 * would then repeat. `packages/runtime/test/host.test.ts` renders one of every kind on this
 * list and fails if any reports `UNSUPPORTED_UI_NODE`.
 */
export const BROWSER_RENDERER_CAPABILITIES = {
  target: 'browser',
  supportedUiKinds: [
    'view',
    'container',
    'text',
    'repeat',
    'field-display',
    'form',
    'input',
    'button',
    'conditional',
    'diagnostic',
    'dialog',
  ],
} as const;

/**
 * The trigger kinds the browser runtime executes: none. `runtime.ts` implements no trigger
 * handling at all, so a client-authority trigger of any kind would otherwise validate,
 * compile into `ApplicationIR.triggers`, and silently never fire (spec 8.1 §31-36). Naming
 * the empty set explicitly, rather than leaving trigger capabilities unspecified, is what
 * makes `validateGraph`/`compileToIR` reject such a graph instead of shipping it inert.
 */
export const BROWSER_TRIGGER_CAPABILITIES = {
  target: 'browser',
  supportedTriggerKinds: [],
} as const;
