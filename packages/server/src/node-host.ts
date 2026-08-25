import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse as HttpServerResponse } from 'node:http';
import { dispatch } from './transport.js';
import { SERVER_DIAGNOSTIC_CODES, createAxiomServer } from './server.js';
import type { AxiomServer } from './server.js';
import { createServerHost } from './host.js';
import type { PrincipalRecord } from './host.js';
import type { PersistenceAdapter } from './persistence.js';
import { PROTOCOL_VERSION } from './protocol.js';
import type { NodeId, ServerIR } from './deps.js';
import type { IntegrationAdapter } from './integration.js';
import type { SubscriptionAdapter } from './subscription.js';
import type { BlobStorageAdapter } from './blobs.js';

/**
 * What a webhook handler gets to verify and decode a delivery: the raw, unparsed request —
 * signature verification runs over the exact bytes a provider signed, not a re-serialized
 * JSON parse of them.
 */
export interface WebhookRequestInfo {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

/**
 * A registered webhook route: provider-specific verification and decoding, kept entirely
 * out of application semantics (spec §52-55). `verify` runs first — an unverified request
 * never reaches `decode`, and no `EventRequest` is ever constructed for it (spec §53).
 */
export interface WebhookConfig {
  verify(request: WebhookRequestInfo): boolean | Promise<boolean>;
  /**
   * Translates a verified provider payload into a typed Axiom event. `deliveryId`, when the
   * provider supplies one, is what a bounded recent-deliveries window dedupes on (spec
   * §56,99) — a duplicate delivery within that window is acknowledged without dispatching
   * the event again. There is no claim of durable, unbounded deduplication.
   */
  decode(
    request: WebhookRequestInfo,
  ): { eventId: NodeId; payload: unknown; deliveryId?: string } | Promise<{ eventId: NodeId; payload: unknown; deliveryId?: string }>;
}

/** How many recent delivery ids each webhook route remembers, for duplicate detection. */
const WEBHOOK_DEDUP_WINDOW = 512;

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
  /**
   * Webhook routes, keyed by the URL path a provider posts to (e.g. `/webhooks/stripe`).
   * An application author never declares an HTTP route (spec §54); this is the one place
   * a deployment registers one, and only to translate provider deliveries into semantic
   * events — the graph never mentions it.
   */
  webhooks?: Record<string, WebhookConfig>;
  /**
   * The blob transport's base path. `POST <base>/<storageId>` uploads and returns a
   * `BlobRef`; `GET <base>/<storageId>/<key>` downloads. Defaults to `/axiom/blob`.
   *
   * It is one endpoint pair for every Axiom application there will ever be, exactly as
   * `POST /axiom` is: an application declares no upload route, no download route and no
   * handler (spec 0.9 §50, §51). Authorization is the store's declared rule, evaluated by
   * the authority before a byte moves — never a check written here.
   */
  blobPath?: string;
  /** One store per `StorageDef`, so the blob transport can move bytes. */
  blobStores?: Record<NodeId, BlobStorageAdapter>;
  /**
   * Resolves the credential a blob request carries to a principal, so the store's declared
   * access rule is evaluated against a real caller. The semantic endpoint authenticates
   * through `ServerHost.authenticate`; this is the same function, supplied here because the
   * blob transport does not go through a `ServerRequest`.
   */
  authenticate?: (credential: string | null) => PrincipalRecord | null | Promise<PrincipalRecord | null>;
}

export interface RunningNodeHost {
  /** The port actually bound, which matters when `port: 0` was requested. */
  port: number;
  /**
   * The semantic endpoint's address (`POST` here is what a client speaks the protocol to) —
   * `http://127.0.0.1:<port><path>`, `/axiom` by default. Distinct from
   * `RunningAxiomApplication.pageUrl`, which is what a person opens in a browser.
   */
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

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

/** Splits `/axiom/blob/<storageId>[/<key>]` into its two semantic parts. */
function parseBlobPath(target: string, base: string): { storageId: string; key?: string } | undefined {
  if (!target.startsWith(`${base}/`)) {
    return undefined;
  }
  const rest = target.slice(base.length + 1).split('/').filter(Boolean).map(decodeURIComponent);
  const storageId = rest[0];
  if (storageId === undefined) {
    return undefined;
  }
  return rest.length > 1 ? { storageId, key: rest.slice(1).join('/') } : { storageId };
}

function blobFailure(response: HttpServerResponse, status: number, diagnostic: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ kind: 'error', protocol: PROTOCOL_VERSION, diagnostics: [diagnostic] }));
}

export async function serveOverHttp(options: NodeHostOptions): Promise<RunningNodeHost> {
  const path = options.path ?? '/axiom';
  const blobPath = options.blobPath ?? '/axiom/blob';
  await options.server.start();

  // One bounded, most-recent-first window of delivery ids per webhook route.
  const seenDeliveries = new Map<string, string[]>();
  function isDuplicateDelivery(webhookPath: string, deliveryId: string): boolean {
    const seen = seenDeliveries.get(webhookPath) ?? [];
    if (seen.includes(deliveryId)) {
      return true;
    }
    seen.push(deliveryId);
    if (seen.length > WEBHOOK_DEDUP_WINDOW) {
      seen.shift();
    }
    seenDeliveries.set(webhookPath, seen);
    return false;
  }

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
      const webhook = options.webhooks?.[target];
      if (webhook && request.method === 'POST') {
        try {
          const rawBody = await readRawBody(request);
          const info: WebhookRequestInfo = { headers: request.headers, rawBody };
          // Verification happens before any event is constructed — an unverified request
          // never reaches `decode` (spec §53).
          const verified = await webhook.verify(info);
          if (!verified) {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                kind: 'error',
                diagnostics: [
                  {
                    code: SERVER_DIAGNOSTIC_CODES.WEBHOOK_VERIFICATION_FAILED,
                    message: 'Webhook signature verification failed',
                    severity: 'error',
                  },
                ],
              }),
            );
            return;
          }
          const decoded = await webhook.decode(info);
          if (decoded.deliveryId && isDuplicateDelivery(target, decoded.deliveryId)) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({ kind: 'event-result', protocol: PROTOCOL_VERSION, ok: true, diagnostics: [] }),
            );
            return;
          }
          const answer = await options.server.handle({
            kind: 'event',
            protocol: PROTOCOL_VERSION,
            eventId: decoded.eventId,
            payload: decoded.payload,
          });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(answer));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              kind: 'error',
              diagnostics: [
                { code: 'MALFORMED_REQUEST', message: error instanceof Error ? error.message : String(error), severity: 'error' },
              ],
            }),
          );
        }
        return;
      }
      // The blob transport: two endpoints, no application involvement, and every access
      // decision made by the authority against the store's declared rule.
      const blob = parseBlobPath(target, blobPath);
      if (blob && (request.method === 'GET' || request.method === 'POST')) {
        const credential = readCredential(request);
        const principal = (await options.authenticate?.(credential)) ?? null;
        try {
          if (request.method === 'GET' && blob.key !== undefined) {
            const allowed = await options.server.authorizeBlobRead(
              blob.storageId as NodeId,
              blob.key,
              principal,
            );
            if (!allowed.ok) {
              blobFailure(response, 403, allowed.diagnostic);
              return;
            }
            const store = options.blobStores?.[blob.storageId as NodeId];
            const bytes = await store?.read(blob.key);
            if (!bytes?.ok) {
              blobFailure(response, 404, {
                code: 'BLOB_NOT_FOUND',
                message: `No stored object ${blob.key}`,
                severity: 'error',
              });
              return;
            }
            response.writeHead(200, {
              'content-type': allowed.blob.mediaType,
              'content-length': String(bytes.value.data.byteLength),
              // A download the browser saves rather than renders, named as the author
              // stored it. The key is never offered as a filename: it is opaque.
              ...(allowed.blob.filename
                ? { 'content-disposition': `attachment; filename="${allowed.blob.filename.replace(/"/g, '')}"` }
                : {}),
            });
            response.end(Buffer.from(bytes.value.data));
            return;
          }
          if (request.method === 'POST' && blob.key === undefined) {
            const rawBody = await readRawBody(request);
            const staged = await options.server.stageBlob(blob.storageId as NodeId, principal, {
              data: new Uint8Array(rawBody),
              mediaType: String(request.headers['content-type'] ?? 'application/octet-stream'),
              ...(typeof request.headers['x-axiom-filename'] === 'string'
                ? { filename: request.headers['x-axiom-filename'] }
                : {}),
            });
            if (!staged.ok) {
              blobFailure(response, 403, staged.diagnostic);
              return;
            }
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ kind: 'blob', protocol: PROTOCOL_VERSION, ref: staged.ref }));
            return;
          }
        } catch (error) {
          blobFailure(response, 400, {
            code: 'MALFORMED_REQUEST',
            message: error instanceof Error ? error.message : String(error),
            severity: 'error',
          });
          return;
        }
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
    close: async () => {
      // Closing only the HTTP listener left the authority's own trigger timers running
      // forever — a resource leak, and on a real host a process that never exits.
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
      await options.server.stop();
    },
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
  /** One adapter per integration the Server IR declares — required if it declares any. */
  integrations?: Record<NodeId, IntegrationAdapter>;
  /**
   * Webhook routes, keyed by the URL path a provider posts to. Without this, a webhook-
   * receiving application had to drop to `createAxiomServer` + `serveOverHttp` directly
   * just to add one (spec 8.1 §56-58) — the one-call convenience this function otherwise
   * offers should not force that trade-off.
   */
  webhooks?: Record<string, WebhookConfig>;
  /** One adapter per integration a `SubscriptionDef` names — required if the IR declares any. */
  subscriptions?: Record<NodeId, SubscriptionAdapter>;
  /** One store per `StorageDef` the Server IR declares — required if it declares any. */
  blobStores?: Record<NodeId, BlobStorageAdapter>;
  /** The blob transport's base path. Defaults to `/axiom/blob`. */
  blobPath?: string;
}

/** The credential a blob request carries, from the same header the semantic endpoint uses. */
function readCredential(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
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
    ...(options.integrations ? { integrations: options.integrations } : {}),
    ...(options.subscriptions ? { subscriptions: options.subscriptions } : {}),
    ...(options.blobStores ? { blobStores: options.blobStores } : {}),
  });
  const running = await serveOverHttp({
    server,
    page: options.page,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.webhooks ? { webhooks: options.webhooks } : {}),
    ...(options.blobStores ? { blobStores: options.blobStores } : {}),
    ...(options.blobPath === undefined ? {} : { blobPath: options.blobPath }),
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
  });
  return { ...running, pageUrl: `http://127.0.0.1:${running.port}/`, server };
}
