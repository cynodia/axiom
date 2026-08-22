/**
 * The handful of types the browser-safe gateway needs, declared without importing the
 * runtime module.
 *
 * `remote.ts` is inlined into generated pages, and a value import from core would be
 * stripped from that bundle. Keeping these local also means the gateway pulls in nothing
 * else at all.
 */
export type NodeId = string & { readonly __brand?: 'NodeId' };

export interface RuntimeDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  details?: Record<string, unknown>;
  [key: string]: unknown;
}
