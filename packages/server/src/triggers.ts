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
  /** Dispatches an event to every trigger bound to it. `depth` guards against event cycles. */
  fireEvent(eventId: NodeId, payload: unknown, depth?: number): Promise<void>;
  stop(): void;
}

export function createTriggerRuntime(options: TriggerRuntimeOptions): TriggerRuntime {
  const { triggers, host, evaluate, invoke, report } = options;
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

  async function fire(trigger: TriggerDef, bindings?: Record<string, unknown>, depth = 0): Promise<void> {
    if (!enabled(trigger)) {
      return;
    }
    const args = buildArguments(trigger, bindings);
    if (args === undefined) {
      return;
    }
    report?.({ kind: 'fired', triggerId: trigger.id, actionId: trigger.actionId });
    const result = await invoke(trigger.actionId, args, depth);
    if (!result.ok) {
      report?.({ kind: 'invocation-failed', triggerId: trigger.id, actionId: trigger.actionId });
    }
  }

  async function tick(trigger: TriggerDef, overlap: 'skip' | 'queue'): Promise<void> {
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
      await fire(trigger);
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
          tasks.push(host.scheduleOnce(trigger.when.afterMs, () => void fire(trigger)));
        }
      }
    },
    async fireEvent(eventId: NodeId, payload: unknown, depth = 0): Promise<void> {
      const bound = triggers.filter((trigger) => trigger.when.kind === 'event' && trigger.when.eventId === eventId);
      if (bound.length === 0) {
        return;
      }
      if (depth >= MAX_EVENT_DISPATCH_DEPTH) {
        for (const trigger of bound) {
          report?.({ kind: 'depth-exceeded', triggerId: trigger.id, actionId: trigger.actionId });
        }
        return;
      }
      for (const trigger of bound) {
        await fire(trigger, { [String(trigger.id)]: payload }, depth);
      }
    },
    stop(): void {
      for (const task of tasks) {
        task.cancel();
      }
      tasks.length = 0;
    },
  };
}
