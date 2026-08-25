import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type { RetryPolicy } from './integrations.js';
import type { NodeBase } from './nodes.js';

/**
 * The third direction of external interaction.
 *
 * A **query** asks the outside world a question and waits for the answer; an **effect**
 * tells it to do something and does not; a **subscription** is the opposite direction
 * entirely — Axiom declares a standing semantic interest in a long-lived external source,
 * and deliveries arrive while that interest is active.
 *
 * It is a node of its own rather than a third `IntegrationOperationMode`, because a
 * subscription has correctness concerns neither of the other two has: activation, stopping,
 * reconnection, duplicate delivery, ordering, backpressure and a lifecycle state an
 * operator can observe. Folding all of that onto `IntegrationOperationDef` would have made
 * most of its fields meaningless for most of its values.
 *
 * Nothing here names a socket, a topic, a broker, a URL, a file descriptor or a serial
 * port. Those are host configuration, supplied to a `SubscriptionAdapter`; the graph says
 * only *which capability domain*, *which semantic source within it*, and *which `EventDef`
 * a delivery becomes.
 */

/**
 * What a subscription is doing, as an operator or agent can observe it.
 *
 * The state machine is deliberately small — six states, and only the transitions below:
 *
 * ```
 * inactive ──start──▶ starting ──ok──▶ active ──stop──▶ stopped
 *                        │                │
 *                        │ fail           │ transport lost
 *                        ▼                ▼
 *                     failed ◀──exhausted── reconnecting ──ok──▶ active
 * ```
 *
 * `inactive` is a subscription the graph declares but startup did not activate
 * (`lifecycle.autoStart: false`). `failed` is terminal for this process: the reconnect
 * policy is spent. `stopped` is a deliberate shutdown, and a stopped subscription never
 * delivers again — that is what makes shutdown observable rather than merely likely.
 */
export type SubscriptionLifecycleState =
  | 'inactive'
  | 'starting'
  | 'active'
  | 'reconnecting'
  | 'failed'
  | 'stopped';

export const SUBSCRIPTION_LIFECYCLE_STATES: readonly SubscriptionLifecycleState[] = [
  'inactive',
  'starting',
  'active',
  'reconnecting',
  'failed',
  'stopped',
];

/**
 * What happens when deliveries arrive faster than the authority commits the actions they
 * cause. Every mode is explicit and none of them is unbounded buffering.
 *
 * | Policy | Behaviour when the queue is full | Loses events? |
 * | ------ | -------------------------------- | ------------- |
 * | `block` | The adapter's `deliver` call does not resolve until there is room. | No |
 * | `reject` | The delivery is refused; the adapter decides whether to redeliver. | No — the source still holds it |
 * | `drop-oldest` | The oldest queued delivery is discarded to make room. | **Yes** |
 * | `drop-newest` | The arriving delivery is discarded. | **Yes** |
 *
 * `block` is the default, because the default may not silently lose an authoritative
 * event. The two dropping modes are legitimate for genuinely lossy sources — a sensor
 * feed where only the newest reading matters — and both report
 * `SUBSCRIPTION_DELIVERY_DROPPED`, so a discarded event is never silent.
 */
export type SubscriptionBackpressurePolicy = 'block' | 'reject' | 'drop-oldest' | 'drop-newest';

export const SUBSCRIPTION_BACKPRESSURE_POLICIES: readonly SubscriptionBackpressurePolicy[] = [
  'block',
  'reject',
  'drop-oldest',
  'drop-newest',
];

/** Modes that may discard an accepted delivery. Declaring one is declaring loss. */
export const LOSSY_BACKPRESSURE_POLICIES: readonly SubscriptionBackpressurePolicy[] = [
  'drop-oldest',
  'drop-newest',
];

/**
 * What to do with a delivery whose action keeps failing — a poison event.
 *
 * `report` (the default) records the failure, reports `SUBSCRIPTION_DELIVERY_FAILED` and
 * moves on to the next delivery; `pause` additionally stops the subscription, so a source
 * producing payloads this application cannot process does not spin. Neither ever retries
 * without bound: `delivery.maxAttempts` is the ceiling, and it defaults to 1.
 */
export type SubscriptionFailurePolicy = 'report' | 'pause';

export const SUBSCRIPTION_FAILURE_POLICIES: readonly SubscriptionFailurePolicy[] = ['report', 'pause'];

/** Queue depth a subscription gets when it declares none. */
export const DEFAULT_SUBSCRIPTION_QUEUE_LIMIT = 64;

/** Delivery keys a subscription remembers when it declares no window. */
export const DEFAULT_SUBSCRIPTION_DEDUPLICATION_WINDOW = 512;

/** Reconnect policy a subscription gets when it declares none. */
export const DEFAULT_SUBSCRIPTION_RECONNECT: RetryPolicy = {
  policy: 'exponential',
  maxAttempts: 5,
  delayMs: 1000,
};

export interface SubscriptionDeliveryPolicy {
  /** Accepted-but-unprocessed deliveries held at once. Must be above zero. */
  maxQueued?: number;
  /** What a full queue does. Defaults to `'block'`, which cannot lose an event. */
  backpressure?: SubscriptionBackpressurePolicy;
  /**
   * The field of the event's payload entity carrying the **external** delivery identity —
   * a broker message id, a webhook delivery id, a sequence number. Two deliveries with the
   * same value are one event: the second is acknowledged and never dispatched.
   *
   * Deliberately a payload field rather than an Axiom transaction id: the provider decides
   * what identifies a delivery, and Axiom cannot invent one that survives a redelivery it
   * did not cause. Absent, no deduplication is performed and the documented at-least-once
   * guarantee applies unchanged.
   */
  deduplicateBy?: FieldId;
  /** How many recent keys are remembered. Deduplication is bounded, never unbounded. */
  deduplicationWindow?: number;
  /** How many times one delivery's action may be attempted. Defaults to 1 — no retry. */
  maxAttempts?: number;
  /** What a delivery that exhausts `maxAttempts` does to the subscription. */
  onFailure?: SubscriptionFailurePolicy;
}

export interface SubscriptionLifecyclePolicy {
  /** Whether startup activates it. Defaults to true. */
  autoStart?: boolean;
  /**
   * Whether the application may be considered ready without it.
   *
   * `false` (the default) is spec 0.9 §79's preferred behaviour: a source that cannot be
   * reached leaves the application running and the subscription `failed`/`reconnecting`,
   * because an unreachable feed is not a reason to refuse every request. `true` says this
   * application is not meaningfully running without this source, and `start()` rejects.
   */
  required?: boolean;
  /**
   * Semantic reconnect policy — Axiom's, not the adapter's. The adapter owns transport
   * mechanics (what a reconnect *is* for MQTT versus a WebSocket); Axiom owns how many
   * times and how long apart, so the answer does not change with the provider.
   */
  reconnect?: RetryPolicy;
}

/**
 * A long-lived external event source, declared semantically.
 *
 * ```ts
 * graph.addNode<SubscriptionDef>({
 *   id: SUBSCRIPTION_DEVICE_STATUS,
 *   kind: 'subscription',
 *   integrationId: INTEGRATION_DEVICE_PROVIDER,
 *   source: 'device-status',
 *   eventId: EVENT_DEVICE_STATUS_CHANGED,
 *   delivery: { deduplicateBy: F_CHANGE_DELIVERY_ID, maxQueued: 32 },
 * });
 * ```
 *
 * A delivery becomes an `EventDef` payload and enters the existing
 * `EventDef → TriggerDef → ActionDef` pipeline. There is no second event system, no
 * callback and no application-authored handler.
 */
export interface SubscriptionDef extends NodeBase {
  kind: 'subscription';
  /** The capability domain whose adapter maintains the source. */
  integrationId: NodeId;
  /**
   * Which semantic source within that integration — `'device-status'`, `'inbound-orders'`.
   * It is a name the adapter maps to a topic, a URL, a queue or a device; the graph never
   * learns which. Absent, the subscription's own id is the name.
   */
  source?: string;
  /**
   * Configuration evaluated once, when the subscription activates: a filter, a device set,
   * a starting offset. Expressions, so configuration can follow authoritative state — but
   * evaluated at activation, not per delivery, because a live source is not re-negotiated
   * on every message.
   */
  arguments?: Record<string, Expression>;
  /** The `EventDef` a delivery becomes. Its `payloadType` is what a payload must satisfy. */
  eventId: NodeId;
  lifecycle?: SubscriptionLifecyclePolicy;
  delivery?: SubscriptionDeliveryPolicy;
}

export function subscriptionSourceName(subscription: SubscriptionDef): string {
  return subscription.source ?? String(subscription.id);
}

export function subscriptionQueueLimit(subscription: SubscriptionDef): number {
  return subscription.delivery?.maxQueued ?? DEFAULT_SUBSCRIPTION_QUEUE_LIMIT;
}

export function subscriptionBackpressure(subscription: SubscriptionDef): SubscriptionBackpressurePolicy {
  return subscription.delivery?.backpressure ?? 'block';
}

export function subscriptionMaxAttempts(subscription: SubscriptionDef): number {
  return Math.max(1, subscription.delivery?.maxAttempts ?? 1);
}

export function subscriptionFailurePolicy(subscription: SubscriptionDef): SubscriptionFailurePolicy {
  return subscription.delivery?.onFailure ?? 'report';
}

export function subscriptionDeduplicationWindow(subscription: SubscriptionDef): number {
  return subscription.delivery?.deduplicationWindow ?? DEFAULT_SUBSCRIPTION_DEDUPLICATION_WINDOW;
}

export function subscriptionAutoStart(subscription: SubscriptionDef): boolean {
  return subscription.lifecycle?.autoStart !== false;
}

export function subscriptionIsRequired(subscription: SubscriptionDef): boolean {
  return subscription.lifecycle?.required === true;
}

export function subscriptionReconnectPolicy(subscription: SubscriptionDef): RetryPolicy {
  return subscription.lifecycle?.reconnect ?? DEFAULT_SUBSCRIPTION_RECONNECT;
}

/** Whether this subscription's declared backpressure policy may discard an event. */
export function subscriptionMayLoseEvents(subscription: SubscriptionDef): boolean {
  return LOSSY_BACKPRESSURE_POLICIES.includes(subscriptionBackpressure(subscription));
}
