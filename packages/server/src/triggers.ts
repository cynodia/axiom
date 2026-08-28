import type { Expression, EventDef, NodeId, TriggerDef } from './deps.js';
import type { ServerHost } from './host.js';

/** How many event dispatches may cascade in one causal chain before dispatch stops. */
export const MAX_EVENT_DISPATCH_DEPTH = 8;

export type TriggerInvoke = (
  actionId: NodeId,
  args: Record<string, unknown>,
  depth: number,
) => Promise<{ ok: boolean }>;

export type TriggerEvaluate = (
  expression: Expression,
  bindings?: Record<string, unknown>,
) => { ok: true; value: unknown } | { ok: false };

export interface TriggerRuntimeEvent {
  kind: 'fired' | 'skipped-overlap' | 'evaluation-failed' | 'invocation-failed' | 'depth-exceeded';
  triggerId: NodeId;
  actionId: NodeId;
}

export interface TriggerRuntimeOptions {
  triggers: readonly TriggerDef[];
  events: readonly EventDef[];
  host: ServerHost;
  evaluate: TriggerEvaluate;
  invoke: TriggerInvoke;
  report?(event: TriggerRuntimeEvent): void;
  /**
   * Runs a host-timer-driven invocation after every earlier one this authority runs has
   * finished, and before any later one — the same ordering guarantee `AxiomServer.handle()`
   * already gives client requests (spec 8.1 §26-30), so a `DeterministicServerHost.advance()`
   * that fires several same-period triggers in one turn does not race their commits against
   * each other. Absent, invocations run unserialized, exactly as before.
   *
   * Wraps only the actual invocation inside `tick`, never `tick` itself: the overlap check
   * (`inFlight`) exists to detect a *concurrent* tick of the same trigger while an earlier
   * one is still running, which requires running immediately when the timer fires, not
   * queued behind that earlier invocation.
   *
   * Deliberately **not** used inside `fireEvent`: an event-triggered action's invocation
   * runs in whatever context its caller is already in — nested inside a client request's
   * own serialized turn when the event came from `handle()`, or inside the caller's own
   * `serialize` when it did not (an effect-outcome event, say). Wrapping it here too would
   * make a client `event` request deadlock against its own already-claimed turn.
   */
  serialize?<T>(body: () => Promise<T>): Promise<T>;
  /**
   * Distributed authority (spec12 §21-§23). When set, each `interval` / `delay` firing is
   * gated on a durable, fenced claim keyed by `(triggerId, dueInstant)`: exactly one
   * authority is allowed to run a given logical firing no matter how many poll their own
   * timers. Returns `null` to skip this firing (another authority owns it), or a finalizer to
   * call once the firing has run (it settles the durable firing record). Absent, every
   * authority fires on its own timer exactly as before.
   */
  claimScheduledFiring?(
    trigger: TriggerDef,
    dueInstant: number,
  ): Promise<null | ((ok: boolean) => Promise<void>)>;
}

/**
 * Schedules and dispatches triggers: interval and delay triggers via the host clock,
 * `application-start`/`runtime-ready` once at startup, and `event`-kind triggers on
 * demand through `fireEvent`. A triggered action runs through the same `invoke` a client
 * request does (spec §102) — this module only decides *when*, never *how*.
 */
export interface TriggerRuntime {
  /** Runs `application-start` then `runtime-ready` triggers, then schedules the rest. */
  start(): Promise<void>;
  /**
   * Dispatches an event to every trigger bound to it. `depth` guards against event cycles.
   *
   * `ok` is false when any bound trigger's action refused, its arguments could not be
   * evaluated, or the depth guard stopped the chain — the answer a subscription needs in
   * order to decide whether the delivery was applied, retried or dead-lettered. An event
   * with no trigger bound to it is vacuously `ok`.
   */
  fireEvent(eventId: NodeId, payload: unknown, depth?: number): Promise<{ ok: boolean }>;
  stop(): void;
}

export function createTriggerRuntime(options: TriggerRuntimeOptions): TriggerRuntime {
  const { triggers, host, evaluate, invoke, report } = options;
  const serialize = options.serialize ?? (<T>(body: () => Promise<T>): Promise<T> => body());
  const tasks: Array<{ cancel(): void }> = [];
  const inFlight = new Set<NodeId>();
  const queued = new Set<NodeId>();

  function enabled(trigger: TriggerDef): boolean {
    if (!trigger.enabledWhen) {
      return true;
    }
    const outcome = evaluate(trigger.enabledWhen);
    return outcome.ok && Boolean(outcome.value);
  }

  function buildArguments(
    trigger: TriggerDef,
    bindings: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const args: Record<string, unknown> = {};
    for (const [key, expression] of Object.entries(trigger.arguments ?? {})) {
      const outcome = evaluate(expression, bindings);
      if (!outcome.ok) {
        report?.({ kind: 'evaluation-failed', triggerId: trigger.id, actionId: trigger.actionId });
        return undefined;
      }
      args[key] = outcome.value;
    }
    return args;
  }

  async function fire(trigger: TriggerDef, bindings?: Record<string, unknown>, depth = 0): Promise<boolean> {
    if (!enabled(trigger)) {
      // Not firing is not failing: `enabledWhen` said this tick does not apply.
      return true;
    }
    const args = buildArguments(trigger, bindings);
    if (args === undefined) {
      return false;
    }
    report?.({ kind: 'fired', triggerId: trigger.id, actionId: trigger.actionId });
    const result = await invoke(trigger.actionId, args, depth);
    if (!result.ok) {
      report?.({ kind: 'invocation-failed', triggerId: trigger.id, actionId: trigger.actionId });
    }
    return result.ok;
  }

  const claimScheduledFiring = options.claimScheduledFiring;

  /**
   * The logical firing instant every authority derives identically (spec12 §22): an
   * `interval` boundary is epoch-aligned to multiples of `everyMs`; a `delay` fires exactly
   * once, so its instant is the constant `afterMs`.
   */
  function dueInstantFor(trigger: TriggerDef): number {
    if (trigger.when.kind === 'interval') {
      return Math.floor(Date.now() / trigger.when.everyMs) * trigger.when.everyMs;
    }
    if (trigger.when.kind === 'delay') {
      return trigger.when.afterMs;
    }
    return Date.now();
  }

  async function tick(trigger: TriggerDef, overlap: 'skip' | 'queue'): Promise<void> {
    // The overlap check itself must never wait behind `serialize` — it exists precisely to
    // detect a *concurrent* tick of this same trigger while an earlier one is still
    // in flight, which requires running immediately when the host timer fires, not queued
    // behind that earlier invocation's own turn.
    if (inFlight.has(trigger.id)) {
      if (overlap === 'skip') {
        report?.({ kind: 'skipped-overlap', triggerId: trigger.id, actionId: trigger.actionId });
        return;
      }
      queued.add(trigger.id);
      return;
    }
    inFlight.add(trigger.id);
    try {
      // Distributed authority: only the authority that wins the fenced claim for this logical
      // firing runs it (spec12 §21). The others skip silently — not a failure.
      const finalize = claimScheduledFiring
        ? await claimScheduledFiring(trigger, dueInstantFor(trigger))
        : null;
      if (claimScheduledFiring && !finalize) {
        return;
      }
      // Only the actual invocation — not the overlap bookkeeping around it — is serialized
      // against every other invocation this authority runs (spec 8.1 §26-30).
      const ok = await serialize(() => fire(trigger));
      if (finalize) {
        await finalize(ok);
      }
    } finally {
      inFlight.delete(trigger.id);
      if (queued.delete(trigger.id)) {
        void tick(trigger, overlap);
      }
    }
  }

  return {
    async start(): Promise<void> {
      for (const trigger of triggers) {
        if (trigger.when.kind === 'lifecycle' && trigger.when.event === 'application-start') {
          await fire(trigger);
        }
      }
      for (const trigger of triggers) {
        if (trigger.when.kind === 'lifecycle' && trigger.when.event === 'runtime-ready') {
          await fire(trigger);
        }
      }
      for (const trigger of triggers) {
        if (trigger.when.kind === 'interval') {
          const overlap = trigger.when.overlap ?? 'skip';
          tasks.push(host.schedule(trigger.when.everyMs, () => void tick(trigger, overlap)));
        }
        if (trigger.when.kind === 'delay') {
          // Route through `tick` so distributed authority can gate the single firing on a
          // fenced claim; with no `claimScheduledFiring` this is `serialize(fire)` as before.
          tasks.push(host.scheduleOnce(trigger.when.afterMs, () => void tick(trigger, 'skip')));
        }
      }
    },
    async fireEvent(eventId: NodeId, payload: unknown, depth = 0): Promise<{ ok: boolean }> {
      const bound = triggers.filter((trigger) => trigger.when.kind === 'event' && trigger.when.eventId === eventId);
      if (bound.length === 0) {
        return { ok: true };
      }
      if (depth >= MAX_EVENT_DISPATCH_DEPTH) {
        for (const trigger of bound) {
          report?.({ kind: 'depth-exceeded', triggerId: trigger.id, actionId: trigger.actionId });
        }
        return { ok: false };
      }
      let ok = true;
      for (const trigger of bound) {
        ok = (await fire(trigger, { [String(trigger.id)]: payload }, depth)) && ok;
      }
      return { ok };
    },
    stop(): void {
      for (const task of tasks) {
        task.cancel();
      }
      tasks.length = 0;
    },
  };
}
