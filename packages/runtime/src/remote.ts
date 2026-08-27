import type { NodeId, RuntimeDiagnostic } from './runtime-types.js';

/**
 * A browser-safe gateway to an Axiom authority.
 *
 * It lives here, in the runtime, rather than in the server package, because a browser
 * client needs it and that package imports Node built-ins a browser has no use for.
 * Everything below uses `fetch` and nothing else, so a generated page can reach an
 * authority with no application code and no Node dependency at all.
 *
 * The protocol is the semantic one: the client asks for actions, never for URLs. The
 * endpoint is a single path, the same for every application.
 */

/** Must match `PROTOCOL_VERSION` in `@cynodia/axiom-server`. */
export const AXIOM_PROTOCOL_VERSION = 'axiom.protocol.v1';

/** The endpoint an Axiom authority answers on, unless a host says otherwise. */
export const AXIOM_DEFAULT_ENDPOINT = '/axiom';

export interface HttpRemoteGatewayOptions {
  /** Defaults to `/axiom` on the current origin. */
  endpoint?: string;
  /** Read per request, so a host can refresh a credential without rebuilding the client. */
  credential?: () => string | null;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface ProtocolAnswer {
  kind?: string;
  ok?: boolean;
  diagnostics?: RuntimeDiagnostic[];
  changes?: Record<NodeId, unknown>;
  snapshot?: { revision: number; states: Record<NodeId, unknown> };
  page?: { items: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean };
  aggregate?: { rows: Array<{ key?: unknown[]; values: Record<string, unknown> }> };
  revision?: number;
}

/** What a client hands the gateway to run a registered query (spec 0.10 §54). */
export interface RemoteQueryRequest {
  queryId: NodeId;
  arguments?: Record<string, unknown>;
  cursor?: string;
  pageSize?: number;
  offset?: number;
}

export interface RemoteQueryResult {
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
  page?: { items: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean };
  aggregate?: { rows: Array<{ key?: unknown[]; values: Record<string, unknown> }> };
  revision: number;
}

function unreachable(message: string): RuntimeDiagnostic {
  return {
    code: 'AUTHORITY_UNREACHABLE' as RuntimeDiagnostic['code'],
    message,
    severity: 'error',
  };
}

/**
 * Builds the gateway a client runtime is configured with.
 *
 * ```ts
 * createAxiomRuntime({ ir, rootElement, host, remote: createHttpRemoteGateway() });
 * ```
 *
 * A transport failure becomes a structured diagnostic rather than an exception escaping
 * into application code, so a refused or unreachable authority reaches the interface the
 * same way a refused local action does.
 */
export function createHttpRemoteGateway(options: HttpRemoteGatewayOptions = {}) {
  const endpoint = options.endpoint ?? AXIOM_DEFAULT_ENDPOINT;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function send(body: Record<string, unknown>): Promise<ProtocolAnswer> {
    if (!fetchImpl) {
      throw new Error('No fetch implementation is available');
    }
    const controller =
      options.timeoutMs && typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          protocol: AXIOM_PROTOCOL_VERSION,
          credential: options.credential?.() ?? null,
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`The authority answered ${response.status}`);
      }
      return (await response.json()) as ProtocolAnswer;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return {
    async invoke(request: {
      actionId: NodeId;
      arguments: Record<string, unknown>;
      requestId: string;
    }): Promise<{ ok: boolean; diagnostics: RuntimeDiagnostic[]; changes: Record<NodeId, unknown> }> {
      try {
        const answer = await send({
          kind: 'invoke',
          actionId: request.actionId,
          arguments: request.arguments,
          requestId: request.requestId,
        });
        if (answer.kind === 'result') {
          return {
            ok: answer.ok === true,
            diagnostics: answer.diagnostics ?? [],
            changes: answer.changes ?? {},
          };
        }
        return { ok: false, diagnostics: answer.diagnostics ?? [], changes: {} };
      } catch (error) {
        return {
          ok: false,
          diagnostics: [unreachable(error instanceof Error ? error.message : String(error))],
          changes: {},
        };
      }
    },

    async query(request: RemoteQueryRequest): Promise<RemoteQueryResult> {
      try {
        const answer = await send({
          kind: 'query',
          queryId: request.queryId,
          ...(request.arguments ? { arguments: request.arguments } : {}),
          ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(request.pageSize !== undefined ? { pageSize: request.pageSize } : {}),
          ...(request.offset !== undefined ? { offset: request.offset } : {}),
        });
        if (answer.kind === 'query-result') {
          return {
            ok: answer.ok === true,
            diagnostics: answer.diagnostics ?? [],
            ...(answer.page ? { page: answer.page } : {}),
            ...(answer.aggregate ? { aggregate: answer.aggregate } : {}),
            revision: answer.revision ?? 0,
          };
        }
        return { ok: false, diagnostics: answer.diagnostics ?? [], revision: 0 };
      } catch (error) {
        return {
          ok: false,
          diagnostics: [unreachable(error instanceof Error ? error.message : String(error))],
          revision: 0,
        };
      }
    },

    async snapshot(): Promise<{ states: Record<NodeId, unknown> }> {
      // A failed snapshot must reject: `start()` distinguishes "not loaded" from "empty",
      // and swallowing the failure here would erase that difference.
      const answer = await send({ kind: 'snapshot' });
      if (answer.kind !== 'snapshot' || !answer.snapshot) {
        throw new Error('The authority did not return a snapshot');
      }
      return { states: answer.snapshot.states ?? {} };
    },
  };
}
