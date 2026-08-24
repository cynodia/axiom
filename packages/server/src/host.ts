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
  /**
   * `'system'` for a trigger- or event-originated invocation, which never authenticates a
   * credential (spec §68) — `principal` is `null` exactly as an anonymous client request's
   * is, so authorization still evaluates and cannot be silently bypassed (spec §69,104).
   * Absent, or `'client'`, for an ordinary client request.
   */
  source?: 'client' | 'system';
}

/** What the authoritative runtime records about an execution, for observability. */
export interface ServerEvent {
  kind:
    | 'invoke'
    | 'snapshot'
    | 'reject'
    | 'conflict'
    | 'replay'
    | 'trigger-fired'
    | 'trigger-skipped-overlap'
    | 'trigger-invocation-failed'
    | 'effect-requested'
    | 'effect-attempted'
    | 'effect-succeeded'
    | 'effect-failed'
    | 'event-received'
    | 'event-dispatched';
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
  /** Set for `trigger-*` and `effect-*` events. */
  triggerId?: NodeId;
  /** Set for `effect-*` events. */
  effectId?: string;
  operationId?: NodeId;
  attempt?: number;
  /** Set for `event-*` events. */
  eventId?: NodeId;
}

/**
 * Everything the authoritative runtime needs from its environment.
 *
 * The semantic engine reads nothing from globals, exactly as the client runtime does not.
 * No transport, no database driver and no host API appears in the semantics.
 */
/** A cancellable scheduled callback, returned by `ServerHost.schedule`/`scheduleOnce`. */
export interface ScheduledTask {
  cancel(): void;
}

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
  /**
   * Calls `callback` every `everyMs`, for an interval trigger. The runtime never sees a
   * timer handle, a `Promise` or a Node API — only this call, so time stays a host
   * capability rather than an accident of implementation (spec §84).
   */
  schedule(everyMs: number, callback: () => void): ScheduledTask;
  /** Calls `callback` once, after `delayMs` — a one-shot delay trigger. */
  scheduleOnce(delayMs: number, callback: () => void): ScheduledTask;
}

/** A host backed by real time, real identifiers and real timers, with no authentication. */
export function createServerHost(overrides: Partial<ServerHost> = {}): ServerHost {
  return {
    now: () => new Date().toISOString(),
    uuid: () =>
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `id-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`,
    schedule: (everyMs, callback) => {
      const handle = setInterval(callback, everyMs);
      return { cancel: () => clearInterval(handle) };
    },
    scheduleOnce: (delayMs, callback) => {
      const handle = setTimeout(callback, delayMs);
      return { cancel: () => clearTimeout(handle) };
    },
    ...overrides,
  };
}

/**
 * A deterministic host, for conformance runs and tests. `now` and `uuid` count rather than
 * varying, so an expected result is stable.
 */
/**
 * The host model the conformance suite runs against.
 *
 * `now()` and `uuid()` are the only two places semantics can depend on something outside the
 * graph, so a portable fixture needs both pinned. The model is one counter, shared, starting
 * at zero and incremented **before** each value is produced, so the nth host call in an
 * execution — whichever of the two it is — is always the same value:
 *
 * ```
 * uuid()  → "id-<n>"
 * now()   → "2026-01-01T00:00:<n, two digits>.000Z"
 * ```
 *
 * A runtime in another language reproduces this exactly by counting host calls in execution
 * order. The counter is per host instance, and a fixture that restarts the authority keeps
 * the same host — a restart does not rewind it.
 */
/**
 * A deterministic host that also owns a virtual clock: `advance(ms)` moves time forward
 * and synchronously fires every timer that becomes due, re-scheduling intervals — the test
 * clock spec §85/§141 require, so a trigger's interval/delay semantics are verifiable
 * without an actual wait.
 */
export interface DeterministicServerHost extends ServerHost {
  /** Moves virtual time forward by `ms`, firing every timer that becomes due in order. */
  advance(ms: number): void;
}

export function createDeterministicServerHost(
  overrides: Partial<ServerHost> = {},
): DeterministicServerHost {
  let counter = 0;
  let virtualNow = 0;
  let nextTimerId = 0;
  const timers = new Map<
    number,
    { dueAt: number; everyMs?: number; callback: () => void; cancelled: boolean }
  >();

  function schedule(everyMs: number, callback: () => void): ScheduledTask {
    const id = nextTimerId++;
    timers.set(id, { dueAt: virtualNow + everyMs, everyMs, callback, cancelled: false });
    return { cancel: () => timers.delete(id) };
  }

  function scheduleOnce(delayMs: number, callback: () => void): ScheduledTask {
    const id = nextTimerId++;
    timers.set(id, { dueAt: virtualNow + delayMs, callback, cancelled: false });
    return { cancel: () => timers.delete(id) };
  }

  return {
    now: () => {
      counter += 1;
      return `2026-01-01T00:00:${String(counter).padStart(2, '0')}.000Z`;
    },
    uuid: () => {
      counter += 1;
      return `id-${counter}`;
    },
    schedule,
    scheduleOnce,
    advance(ms: number): void {
      const target = virtualNow + ms;
      // Firing order is due-time order, so two timers that both become due in this advance
      // still run in the order they would have on a real clock.
      while (true) {
        let next: { id: number; entry: NonNullable<ReturnType<typeof timers.get>> } | undefined;
        for (const [id, entry] of timers) {
          if (entry.cancelled || entry.dueAt > target) {
            continue;
          }
          if (!next || entry.dueAt < next.entry.dueAt) {
            next = { id, entry };
          }
        }
        if (!next) {
          break;
        }
        virtualNow = next.entry.dueAt;
        if (next.entry.everyMs !== undefined) {
          next.entry.dueAt += next.entry.everyMs;
        } else {
          timers.delete(next.id);
        }
        next.entry.callback();
      }
      virtualNow = target;
    },
    ...overrides,
  };
}
