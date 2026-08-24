import type { Expression } from './expressions.js';
import type { NodeId } from './ids.js';
import type { NodeBase } from './nodes.js';

/**
 * What happens when a tick fires while the previous invocation of the same trigger is
 * still running. `'skip'` (the default) no-ops the tick; `'queue'` runs one pending tick
 * immediately after the in-flight one finishes. Neither ever runs two invocations of the
 * same trigger concurrently — overlap is never accidental.
 */
export type TriggerOverlapPolicy = 'skip' | 'queue';

export const TRIGGER_OVERLAP_POLICIES: readonly TriggerOverlapPolicy[] = ['skip', 'queue'];

export type LifecycleEvent = 'application-start' | 'runtime-ready' | 'route-enter' | 'route-leave';

export const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = [
  'application-start',
  'runtime-ready',
  'route-enter',
  'route-leave',
];

export type TriggerKind = 'interval' | 'delay' | 'lifecycle' | 'event';

export const TRIGGER_KINDS: readonly TriggerKind[] = ['interval', 'delay', 'lifecycle', 'event'];

/**
 * When a trigger fires. `everyMs`/`afterMs` are plain numbers, never expressions —
 * scheduling stays static; only `TriggerDef.enabledWhen` is dynamic.
 */
export type TriggerSpec =
  | { kind: 'interval'; everyMs: number; overlap?: TriggerOverlapPolicy }
  | { kind: 'delay'; afterMs: number }
  | { kind: 'lifecycle'; event: LifecycleEvent; routeId?: NodeId }
  | { kind: 'event'; eventId: NodeId };

/**
 * Describes when an action should be invoked, without embedding callback code.
 *
 * A trigger invokes the target action through the same semantics as any other caller —
 * the same guards, constraints, transition constraints and authorization apply. For an
 * `event`-kind trigger, `arguments` expressions may `ref` the trigger's own id to read the
 * event's payload, the same way a `for-each`/`map` scope id lets a body read the current
 * member.
 */
export interface TriggerDef extends NodeBase {
  kind: 'trigger';
  actionId: NodeId;
  when: TriggerSpec;
  /** Keyed by the target action's parameter id. */
  arguments?: Record<string, Expression>;
  /** Dynamic enablement — evaluated each time the trigger would otherwise fire. */
  enabledWhen?: Expression;
}
