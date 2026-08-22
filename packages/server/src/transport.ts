import { PROTOCOL_VERSION, isServerRequest } from './protocol.js';
import type { ServerRequest, ServerResponse, TransportAdapter } from './protocol.js';
import { SERVER_DIAGNOSTIC_CODES } from './server.js';
import type { AxiomServer } from './server.js';
import type { RuntimeDiagnostic } from './deps.js';
import type { RemoteGateway } from '@cynodia/axiom-runtime';

function boundaryFailure(code: string, message: string): ServerResponse {
  return {
    kind: 'error',
    protocol: PROTOCOL_VERSION,
    diagnostics: [
      {
        code: code as unknown as RuntimeDiagnostic['code'],
        message,
        severity: 'error',
      },
    ],
  };
}

/**
 * In-process transport: the client runtime talks to an authority in the same process,
 * without opening a port.
 *
 * This is what makes an end-to-end semantic test deterministic — the whole client/server
 * round trip, with the real authority, and nothing asynchronous but the call itself.
 */
export interface DirectTransportOptions {
  /** Read per request, so a client is configured the same way on every transport. */
  credential?: () => string | null;
}

export function createDirectTransport(
  server: AxiomServer,
  options: DirectTransportOptions = {},
): TransportAdapter {
  return {
    async send(request: ServerRequest): Promise<ServerResponse> {
      const credential = options.credential?.() ?? request.credential ?? null;
      // The request crosses a real boundary even here: it is serialized, so a test cannot
      // accidentally hand the authority a live object reference.
      const copy = JSON.parse(JSON.stringify({ ...request, credential })) as ServerRequest;
      return server.handle(copy);
    },
  };
}

export interface HttpTransportOptions {
  url: string;
  /** Supplied per request, so a host can refresh a credential without rebuilding the client. */
  credential?: () => string | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * The reference network transport.
 *
 * HTTP is an implementation detail of this adapter: one endpoint carrying semantic
 * requests, never a route per entity. No ApplicationGraph mentions a URL or a verb, and
 * replacing this with a WebSocket or a worker channel changes nothing in a graph.
 */
export function createHttpTransport(options: HttpTransportOptions): TransportAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    async send(request: ServerRequest): Promise<ServerResponse> {
      if (!fetchImpl) {
        return boundaryFailure(SERVER_DIAGNOSTIC_CODES.AUTHORITY_UNREACHABLE, 'No fetch implementation is available');
      }
      const credential = options.credential?.() ?? null;
      const controller = options.timeoutMs ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => controller.abort(), options.timeoutMs)
        : undefined;
      try {
        const response = await fetchImpl(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...request, credential }),
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) {
          return boundaryFailure(
            SERVER_DIAGNOSTIC_CODES.AUTHORITY_UNREACHABLE,
            `The authority answered ${response.status}`,
          );
        }
        return (await response.json()) as ServerResponse;
      } catch (error) {
        // A network failure becomes a structured diagnostic, not an exception escaping into
        // application code.
        return boundaryFailure(
          SERVER_DIAGNOSTIC_CODES.AUTHORITY_UNREACHABLE,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}

/**
 * Adapts a transport into the gateway a client runtime expects, so a client is configured
 * with one object and knows nothing about how the authority is reached.
 */
export function createRemoteGateway(transport: TransportAdapter): RemoteGateway {
  return {
    async invoke(request) {
      const answer = await transport.send({
        kind: 'invoke',
        protocol: PROTOCOL_VERSION,
        actionId: request.actionId,
        arguments: request.arguments,
        requestId: request.requestId,
      });
      if (answer.kind === 'result') {
        return { ok: answer.ok, diagnostics: answer.diagnostics, changes: answer.changes };
      }
      return {
        ok: false,
        diagnostics: answer.kind === 'error' ? answer.diagnostics : [],
        changes: {},
      };
    },
    async snapshot() {
      const answer = await transport.send({ kind: 'snapshot', protocol: PROTOCOL_VERSION });
      return { states: answer.kind === 'snapshot' ? answer.snapshot.states : {} };
    },
  };
}

/** Reads and dispatches one semantic request. Shared by every server-side transport. */
export async function dispatch(server: AxiomServer, body: unknown): Promise<ServerResponse> {
  if (!isServerRequest(body)) {
    return boundaryFailure(
      SERVER_DIAGNOSTIC_CODES.MALFORMED_REQUEST,
      'The request is not an Axiom semantic request',
    );
  }
  return server.handle(body);
}
