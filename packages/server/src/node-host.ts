import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse as HttpServerResponse } from 'node:http';
import { dispatch } from './transport.js';
import { createAxiomServer } from './server.js';
import type { AxiomServer } from './server.js';
import { createServerHost } from './host.js';
import type { PrincipalRecord } from './host.js';
import type { PersistenceAdapter } from './persistence.js';
import type { ServerIR } from './deps.js';

/**
 * The reference Node host.
 *
 * It is infrastructure, not semantics: it reads a body, hands it to the authority, and
 * writes the answer back. There is one endpoint, and it is the same endpoint for every
 * application — no application declares a route, a verb or a handler.
 */
export interface NodeHostOptions {
  server: AxiomServer;
  port?: number;
  /** The single semantic endpoint. */
  path?: string;
  /**
   * The generated browser page. When given, `GET /` serves it — so one process hands out
   * the client and answers it. Omit to run a bare authority.
   */
  page?: string;
}

export interface RunningNodeHost {
  /** The port actually bound, which matters when `port: 0` was requested. */
  port: number;
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body is too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function serveOverHttp(options: NodeHostOptions): Promise<RunningNodeHost> {
  const path = options.path ?? '/axiom';
  await options.server.start();

  const http: Server = createServer((request: IncomingMessage, response: HttpServerResponse) => {
    void (async () => {
      const target = (request.url ?? '').split('?')[0];
      if (options.page !== undefined && request.method === 'GET' && (target === '/' || target === '/index.html')) {
        // The generated page and the endpoint it talks to, from one process. Nothing here is
        // application-specific: every Axiom application is served by exactly this handler.
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(options.page);
        return;
      }
      if (request.method !== 'POST' || target !== path) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ kind: 'error', diagnostics: [] }));
        return;
      }
      try {
        const answer = await dispatch(options.server, await readBody(request));
        const body = JSON.stringify(answer);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            kind: 'error',
            diagnostics: [
              {
                code: 'MALFORMED_REQUEST',
                message: error instanceof Error ? error.message : String(error),
                severity: 'error',
              },
            ],
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolve) => {
    http.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);

  return {
    port,
    url: `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * One graph, one process: the generated page and the authority that answers it.
 *
 * This is the whole deployment story for an application with server-authoritative state.
 * The caller supplies the two compiled artifacts — the Server IR and the page — plus how to
 * authenticate a credential and where to keep state. It defines no route, no verb and no
 * handler, because there are none to define: `GET /` is the page and `POST /axiom` is the
 * semantic endpoint, for every Axiom application there will ever be.
 *
 * ```ts
 * const running = await serveAxiomApplication({
 *   serverIR: compileToServerIR(graph),
 *   page: compileToHtml(graph),
 *   persistence: createSqlitePersistence({ file: 'app.db' }),
 *   authenticate: (credential) => users.get(credential ?? '') ?? null,
 *   port: 3000,
 * });
 * ```
 */
export interface AxiomApplicationOptions {
  serverIR: ServerIR;
  /** The generated browser page, exactly as `compileToHtml` produced it. */
  page: string;
  persistence?: PersistenceAdapter;
  /** Resolves opaque credential material to a principal record, or null for anonymous. */
  authenticate?: (credential: string | null) => PrincipalRecord | null | Promise<PrincipalRecord | null>;
  port?: number;
  /** The semantic endpoint. Change it only if something else already owns `/axiom`. */
  path?: string;
}

export interface RunningAxiomApplication extends RunningNodeHost {
  /** The page's address, which is what a person opens. */
  pageUrl: string;
  /** The authority itself, for tests and administrative inspection. */
  server: AxiomServer;
}

export async function serveAxiomApplication(
  options: AxiomApplicationOptions,
): Promise<RunningAxiomApplication> {
  const server = createAxiomServer({
    ir: options.serverIR,
    ...(options.persistence ? { persistence: options.persistence } : {}),
    ...(options.authenticate
      ? { host: createServerHost({ authenticate: options.authenticate }) }
      : {}),
  });
  const running = await serveOverHttp({
    server,
    page: options.page,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.path === undefined ? {} : { path: options.path }),
  });
  return { ...running, pageUrl: `http://127.0.0.1:${running.port}/`, server };
}
