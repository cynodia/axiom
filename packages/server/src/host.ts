import type { FieldId, LiteralValue, NodeId, RuntimeDiagnostic } from './deps.js';
import type { Credential } from './protocol.js';

/**
 * A caller, as the authority sees it: a record keyed by the field ids of the graph's
 * principal entity. It is never application state — it describes who is asking.
 */
export type PrincipalRecord = Record<FieldId, LiteralValue>;

export interface ExecutionContext {
  /** The resolved caller, or `null` for an anonymous request. */
  principal: PrincipalRecord | null;
  /** The credential the caller presented, for host-level logging. Never semantic. */
  credential?: Credential;
  requestId?: string;
}

/** What the authoritative runtime records about an execution, for observability. */
export interface ServerEvent {
  kind: 'invoke' | 'snapshot' | 'reject' | 'conflict' | 'replay';
  actionId?: NodeId;
  /** The principal's identity field, when the graph declares one. Never the whole record. */
  principal?: LiteralValue;
  requestId?: string;
  ok?: boolean;
  /** Milliseconds spent in the authoritative runtime. */
  durationMs?: number;
  revision?: number;
  diagnostics?: RuntimeDiagnostic[];
  /** States the transaction committed. */
  committed?: NodeId[];
}

/**
 * Everything the authoritative runtime needs from its environment.
 *
 * The semantic engine reads nothing from globals, exactly as the client runtime does not.
 * No transport, no database driver and no host API appears in the semantics.
 */
export interface ServerHost {
  now(): string;
  uuid(): string;
  /**
   * Resolves an opaque credential to a caller. Returning `null` means anonymous, which an
   * authorization rule may still accept or refuse.
   *
   * This is authentication, and it is deliberately the host's business. Axiom 0.6 provides
   * no authentication provider of its own.
   */
  authenticate?(credential: Credential): Promise<PrincipalRecord | null> | PrincipalRecord | null;
  /** Structured execution information. An application implements no logging of its own. */
  report?(event: ServerEvent): void;
}

/** A host backed by real time and real identifiers, with no authentication. */
export function createServerHost(overrides: Partial<ServerHost> = {}): ServerHost {
  return {
    now: () => new Date().toISOString(),
    uuid: () =>
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `id-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`,
    ...overrides,
  };
}

/**
 * A deterministic host, for conformance runs and tests. `now` and `uuid` count rather than
 * varying, so an expected result is stable.
 */
export function createDeterministicServerHost(overrides: Partial<ServerHost> = {}): ServerHost {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return `2026-01-01T00:00:${String(counter).padStart(2, '0')}.000Z`;
    },
    uuid: () => {
      counter += 1;
      return `id-${counter}`;
    },
    ...overrides,
  };
}
