import type { IntegrationOperationDef, NodeId } from './deps.js';

export interface IntegrationSuccess {
  ok: true;
  value: unknown;
}

export interface IntegrationFailure {
  ok: false;
  code: string;
  message: string;
  /** Whether a retry might succeed. Absent means the adapter could not determine it. */
  retryable?: boolean;
}

export type IntegrationResult = IntegrationSuccess | IntegrationFailure;

/**
 * Translates a semantic integration operation into provider-specific execution.
 *
 * The graph declares the operation's shape; this is where the SDK, the HTTP client, the
 * credentials and the provider-specific error translation live (spec §28,29) — none of it
 * ever reaches an `ApplicationGraph`.
 */
export interface IntegrationAdapter {
  query(
    operation: IntegrationOperationDef,
    args: Record<string, unknown>,
    context: { timeoutMs?: number },
  ): Promise<IntegrationResult>;
  effect(
    operation: IntegrationOperationDef,
    args: Record<string, unknown>,
    context: { idempotencyKey?: string },
  ): Promise<IntegrationResult>;
}

export type IntegrationAdapterRegistry = Record<NodeId, IntegrationAdapter>;

/**
 * Deterministic canned results, for tests and conformance fixtures — semantics must not
 * depend on a real network call (spec §107).
 */
export function createFakeIntegrationAdapter(options: {
  query?(
    operation: IntegrationOperationDef,
    args: Record<string, unknown>,
  ): IntegrationResult | Promise<IntegrationResult>;
  effect?(
    operation: IntegrationOperationDef,
    args: Record<string, unknown>,
  ): IntegrationResult | Promise<IntegrationResult>;
}): IntegrationAdapter {
  return {
    async query(operation, args) {
      if (!options.query) {
        return { ok: false, code: 'NOT_IMPLEMENTED', message: `No fake query behaviour registered for ${operation.id}` };
      }
      return options.query(operation, args);
    },
    async effect(operation, args) {
      if (!options.effect) {
        return { ok: false, code: 'NOT_IMPLEMENTED', message: `No fake effect behaviour registered for ${operation.id}` };
      }
      return options.effect(operation, args);
    },
  };
}

export interface HttpIntegrationOperationConfig {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A path template, `{paramName}` substituted from the operation's arguments. */
  path: string;
  /** Argument keys sent as the JSON body. Absent sends every argument not used in the path. */
  bodyFields?: string[];
}

/**
 * A generic HTTP adapter, sufficient to prove query/effect/timeout/typed-response/error
 * mapping over an arbitrary REST service (spec §106) — a lower-level mechanism, not the
 * canonical integration model (spec §30,31).
 */
export function createHttpIntegrationAdapter(options: {
  baseUrl: string;
  headers?: Record<string, string>;
  operations: Record<string, HttpIntegrationOperationConfig>;
}): IntegrationAdapter {
  async function call(
    operation: IntegrationOperationDef,
    args: Record<string, unknown>,
    timeoutMs: number | undefined,
  ): Promise<IntegrationResult> {
    const config = options.operations[String(operation.id)];
    if (!config) {
      return {
        ok: false,
        code: 'INTEGRATION_OPERATION_UNCONFIGURED',
        message: `No HTTP mapping configured for ${operation.id}`,
      };
    }
    const path = config.path.replace(/\{(\w+)\}/g, (_match, key: string) => encodeURIComponent(String(args[key] ?? '')));
    const url = new URL(path.replace(/^\//, ''), options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    const pathKeys = new Set([...config.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
    const bodyKeys = config.bodyFields ?? Object.keys(args).filter((key) => !pathKeys.has(key));
    const body: Record<string, unknown> = {};
    for (const key of bodyKeys) {
      body[key] = args[key];
    }
    const controller = new AbortController();
    const timer = timeoutMs !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const response = await fetch(url, {
        method: config.method,
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        ...(config.method === 'GET' ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          code: `HTTP_${response.status}`,
          message: `${config.method} ${url.pathname} returned ${response.status}`,
          retryable: response.status >= 500,
        };
      }
      const value: unknown = response.status === 204 ? null : await response.json();
      return { ok: true, value };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        code: timedOut ? 'INTEGRATION_TIMEOUT' : 'INTEGRATION_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return {
    query: (operation, args, context) => call(operation, args, context.timeoutMs),
    effect: (operation, args) => call(operation, args, undefined),
  };
}
