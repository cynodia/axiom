import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse as HttpServerResponse } from 'node:http';
import { dispatch } from './transport.js';
import type { AxiomServer } from './server.js';

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
      if (request.method !== 'POST' || (request.url ?? '').split('?')[0] !== path) {
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
