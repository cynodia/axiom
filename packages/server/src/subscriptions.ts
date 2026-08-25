import {
  subscriptionAutoStart,
  subscriptionBackpressure,
  subscriptionDeduplicationWindow,
  subscriptionFailurePolicy,
  subscriptionIsRequired,
  subscriptionMaxAttempts,
  subscriptionQueueLimit,
  subscriptionReconnectPolicy,
  subscriptionSourceName,
} from './deps.js';
import type {
  Expression,
  NodeId,
  SubscriptionDef,
  SubscriptionLifecycleState,
} from './deps.js';
import type { ServerHost } from './host.js';
import type {
  DeliveryOutcome,
  DeliveryStatus,
  SubscriptionAdapterRegistry,
  SubscriptionDelivery,
  SubscriptionHandle,
} from './subscription.js';

/**
 * The subscription runtime: lifecycle, ordering, deduplication and backpressure.
 *
 * The guarantees it implements, stated once here and documented in `docs/SUBSCRIPTIONS.md`:
 *
 * - **Delivery is at-least-once.** A provider that redelivers, a reconnect that replays and
 *   a crash between dispatch and commit can all present the same external event twice.
 *   Nothing here claims exactly-once, because nothing here can deliver it across all three.
 * - **Deduplication makes it effectively-once where an identity exists.** With
 *   `delivery.deduplicateBy`, a repeated key is acknowledged and never dispatched — and the
 *   record of seen keys is durable, so it survives a restart. Without one, at-least-once
 *   applies unchanged and the graph says so by omission.
 * - **Ordering is per subscription.** Deliveries of one subscription are dispatched one at
 *   a time, in accepted order, each in its own transaction. Two subscriptions have **no**
 *   ordering relationship with each other, and none is promised: they are independent
 *   sources, and inventing a global order would mean serializing sources that never had one.
 * - **A stopped subscription delivers nothing.** `stop()` is synchronous with respect to
 *   acceptance: everything arriving afterwards is answered `stopped` and never dispatched,
 *   including deliveries a scripted or in-flight adapter had already begun.
 */

export interface SubscriptionRuntimeEvent {
  kind:
    | 'subscription-starting'
    | 'subscription-active'
    | 'subscription-reconnecting'
    | 'subscription-failed'
    | 'subscription-stopped'
    | 'subscription-delivery'
    | 'subscription-delivery-rejected'
    | 'subscription-delivery-dropped'
    | 'subscription-delivery-duplicate';
  subscriptionId: NodeId;
  eventId?: NodeId;
  code?: string;
  message?: string;
}

/** Everything an operator or agent can observe about one subscription, at any moment. */
export interface SubscriptionRecord {
  subscriptionId: NodeId;
  integrationId: NodeId;
  eventId: NodeId;
  source: string;
  state: SubscriptionLifecycleState;
  /** Activation attempts made so far, including the one that succeeded. */
  attempts: number;
  /** Deliveries the runtime accepted onto the queue. */
  received: number;
  /** Deliveries dispatched whose action committed. */
  applied: number;
  /** Deliveries refused before dispatch: invalid payload, duplicate, dropped or refused. */
  rejected: number;
  /** Deliveries dispatched whose action failed after every permitted attempt. */
  failed: number;
  /** Deliveries discarded by a declared lossy backpressure policy. */
  dropped: number;
  /** Deliveries currently queued, waiting for the authority. */
  queued: number;
  lastDeliveryAt?: string;
  lastFailure?: { code: string; message: string; at: string };
}

export interface SubscriptionRuntimeOptions {
  subscriptions: readonly SubscriptionDef[];
  adapters: SubscriptionAdapterRegistry;
  host: ServerHost;
  /** Evaluates activation-time configuration against authoritative state. */
  evaluate(expression: Expression): { ok: true; value: unknown } | { ok: false };
  /**
   * Validates the payload against the event's declared type and dispatches it to the
   * triggers bound to that event, in its own serialized turn. Returns whether the whole
   * dispatch — validation, every triggered action, its transaction — succeeded.
   */
  dispatch(eventId: NodeId, payload: unknown): Promise<{ ok: boolean; code?: string; message?: string }>;
  /** Durable delivery identity, so deduplication survives a restart. */
  deliveries?: {
    seen(subscriptionId: NodeId, key: string): Promise<boolean>;
    remember(subscriptionId: NodeId, key: string, window: number): Promise<void>;
  };
  report?(event: SubscriptionRuntimeEvent): void;
}

export interface SubscriptionRuntime {
  /** Activates every `autoStart` subscription. Rejects only if a `required` one cannot start. */
  start(): Promise<void>;
  status(): SubscriptionRecord[];
  statusOf(id: NodeId): SubscriptionRecord | undefined;
  stop(): Promise<void>;
}

interface Managed {
  definition: SubscriptionDef;
  record: SubscriptionRecord;
  handle?: SubscriptionHandle;
  /** Accepted, not yet dispatched. Bounded by `delivery.maxQueued`. */
  queue: Array<{ delivery: SubscriptionDelivery; settle(outcome: DeliveryOutcome): void }>;
  /** Callers parked by `backpressure: 'block'`, released as room appears. */
  waiting: Array<() => void>;
  draining: boolean;
  /** In-process fallback when no durable delivery store is configured. */
  recentKeys: string[];
  /**
   * Serializes the deduplication check for this subscription.
   *
   * Two deliveries that arrive in the same turn would otherwise both read "not seen" before
   * either recorded itself, and both would be dispatched — deduplication that only works
   * when deliveries are far enough apart is not deduplication.
   */
  dedupeGate: Promise<void>;
}

/** Whether a subscription is still able to accept deliveries. */
function accepting(record: SubscriptionRecord): boolean {
  return record.state !== 'stopped' && record.state !== 'failed';
}

function pluck(payload: unknown, fieldId: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[fieldId];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

export function createSubscriptionRuntime(options: SubscriptionRuntimeOptions): SubscriptionRuntime {
  const { adapters, host, evaluate, dispatch, deliveries, report } = options;
  const managed = new Map<NodeId, Managed>();
  let running = false;

  for (const definition of options.subscriptions) {
    managed.set(definition.id, {
      definition,
      record: {
        subscriptionId: definition.id,
        integrationId: definition.integrationId,
        eventId: definition.eventId,
        source: subscriptionSourceName(definition),
        state: 'inactive',
        attempts: 0,
        received: 0,
        applied: 0,
        rejected: 0,
        failed: 0,
        dropped: 0,
        queued: 0,
      },
      queue: [],
      waiting: [],
      draining: false,
      recentKeys: [],
      dedupeGate: Promise.resolve(),
    });
  }

  function move(entry: Managed, state: SubscriptionLifecycleState, failure?: { code: string; message: string }): void {
    entry.record.state = state;
    if (failure) {
      entry.record.lastFailure = { ...failure, at: host.now() };
    }
    const kind = (
      {
        starting: 'subscription-starting',
        active: 'subscription-active',
        reconnecting: 'subscription-reconnecting',
        failed: 'subscription-failed',
        stopped: 'subscription-stopped',
        inactive: 'subscription-stopped',
      } as const
    )[state];
    report?.({
      kind,
      subscriptionId: entry.definition.id,
      eventId: entry.definition.eventId,
      ...(failure ? { code: failure.code, message: failure.message } : {}),
    });
  }

  /** Whether this key has already been delivered — durably when a store is configured. */
  function isDuplicate(entry: Managed, key: string): Promise<boolean> {
    const answer = entry.dedupeGate.then(() => checkAndRemember(entry, key));
    entry.dedupeGate = answer.then(
      () => undefined,
      () => undefined,
    );
    return answer;
  }

  async function checkAndRemember(entry: Managed, key: string): Promise<boolean> {
    const window = subscriptionDeduplicationWindow(entry.definition);
    if (deliveries) {
      if (await deliveries.seen(entry.definition.id, key)) {
        return true;
      }
      await deliveries.remember(entry.definition.id, key, window);
      return false;
    }
    // Without durable delivery storage, deduplication is memory-only and does not survive a
    // restart. That is a real limitation and is documented as one rather than papered over.
    if (entry.recentKeys.includes(key)) {
      return true;
    }
    entry.recentKeys.push(key);
    if (entry.recentKeys.length > window) {
      entry.recentKeys.shift();
    }
    return false;
  }

  function release(entry: Managed): void {
    while (entry.waiting.length > 0 && entry.queue.length < subscriptionQueueLimit(entry.definition)) {
      (entry.waiting.shift() as () => void)();
    }
  }

  /**
   * Dispatches queued deliveries one at a time, in accepted order.
   *
   * One delivery, one transaction: the loop awaits each dispatch before taking the next, so
   * two deliveries can never share a transaction and a failure in one never unwinds another.
   */
  async function drain(entry: Managed): Promise<void> {
    if (entry.draining) {
      return;
    }
    entry.draining = true;
    try {
      while (entry.queue.length > 0) {
        const item = entry.queue.shift() as NonNullable<(typeof entry.queue)[number]>;
        entry.record.queued = entry.queue.length;
        release(entry);

        const attempts = subscriptionMaxAttempts(entry.definition);
        let result: Awaited<ReturnType<typeof dispatch>> = { ok: false, code: 'SUBSCRIPTION_STOPPED' };
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          result = await dispatch(entry.definition.eventId, item.delivery.payload);
          if (result.ok) {
            break;
          }
        }

        if (result.ok) {
          entry.record.applied += 1;
          entry.record.lastDeliveryAt = host.now();
          report?.({
            kind: 'subscription-delivery',
            subscriptionId: entry.definition.id,
            eventId: entry.definition.eventId,
          });
          item.settle({ status: 'applied' });
          continue;
        }

        const invalid = result.code === 'EVENT_PAYLOAD_INVALID';
        const failure = {
          code: result.code ?? 'SUBSCRIPTION_DELIVERY_FAILED',
          message: result.message ?? 'the delivery could not be applied',
        };
        entry.record.lastFailure = { ...failure, at: host.now() };
        if (invalid) {
          // An unconforming payload is refused **before** any mutation: no action ran, no
          // state moved, and redelivering the same bytes cannot help.
          entry.record.rejected += 1;
          report?.({
            kind: 'subscription-delivery-rejected',
            subscriptionId: entry.definition.id,
            eventId: entry.definition.eventId,
            ...failure,
          });
          item.settle({ status: 'rejected', ...failure });
          continue;
        }

        entry.record.failed += 1;
        item.settle({ status: 'failed', ...failure });
        if (subscriptionFailurePolicy(entry.definition) === 'pause') {
          // A poison delivery must not spin: pausing stops the source rather than retrying
          // it forever, and the stopped state says so where an operator can see it.
          await stopOne(entry, 'failed', failure);
          return;
        }
      }
    } finally {
      entry.draining = false;
      release(entry);
    }
  }

  /** Accepts (or refuses) one delivery. Every backpressure decision is made here. */
  async function accept(entry: Managed, delivery: SubscriptionDelivery): Promise<DeliveryOutcome> {
    if (!running || !accepting(entry.record)) {
      // Shutdown determinism: after `stop()`, no delivery enters the runtime at all.
      return { status: 'stopped' };
    }

    const deduplicateBy = entry.definition.delivery?.deduplicateBy;
    if (deduplicateBy !== undefined) {
      const key = pluck(delivery.payload, String(deduplicateBy)) ?? delivery.deliveryKey;
      if (key !== undefined && (await isDuplicate(entry, key))) {
        entry.record.rejected += 1;
        report?.({
          kind: 'subscription-delivery-duplicate',
          subscriptionId: entry.definition.id,
          eventId: entry.definition.eventId,
        });
        return { status: 'duplicate' };
      }
    }

    const limit = subscriptionQueueLimit(entry.definition);
    const policy = subscriptionBackpressure(entry.definition);
    if (entry.queue.length >= limit) {
      if (policy === 'reject') {
        entry.record.rejected += 1;
        return { status: 'refused', code: 'SUBSCRIPTION_QUEUE_FULL', message: 'the delivery queue is full' };
      }
      if (policy === 'drop-newest') {
        entry.record.dropped += 1;
        report?.({
          kind: 'subscription-delivery-dropped',
          subscriptionId: entry.definition.id,
          eventId: entry.definition.eventId,
          code: 'SUBSCRIPTION_DELIVERY_DROPPED',
        });
        return { status: 'dropped', code: 'SUBSCRIPTION_DELIVERY_DROPPED' };
      }
      if (policy === 'drop-oldest') {
        const evicted = entry.queue.shift();
        entry.record.dropped += 1;
        report?.({
          kind: 'subscription-delivery-dropped',
          subscriptionId: entry.definition.id,
          eventId: entry.definition.eventId,
          code: 'SUBSCRIPTION_DELIVERY_DROPPED',
        });
        evicted?.settle({ status: 'dropped', code: 'SUBSCRIPTION_DELIVERY_DROPPED' });
      } else {
        // `block`: the adapter's own call is what waits, which is how backpressure reaches
        // the transport instead of being absorbed by an unbounded buffer here.
        await new Promise<void>((resolve) => entry.waiting.push(resolve));
        // Re-read after parking: `stop()` releases every waiter precisely so that an
        // adapter blocked here learns the subscription is gone instead of enqueuing into a
        // runtime that has shut down.
        if (!running || !accepting(entry.record)) {
          return { status: 'stopped' };
        }
      }
    }

    entry.record.received += 1;
    const outcome = new Promise<DeliveryOutcome>((resolve) => {
      entry.queue.push({ delivery, settle: resolve });
    });
    entry.record.queued = entry.queue.length;
    void drain(entry);
    return outcome;
  }

  async function activate(entry: Managed, attempt: number): Promise<void> {
    if (!running) {
      return;
    }
    const adapter = adapters[entry.definition.integrationId];
    if (!adapter) {
      move(entry, 'failed', {
        code: 'SUBSCRIPTION_ADAPTER_MISSING',
        message: `No subscription adapter registered for ${entry.definition.integrationId}`,
      });
      return;
    }

    entry.record.attempts += 1;
    move(entry, attempt === 1 ? 'starting' : 'reconnecting');

    const args: Record<string, unknown> = {};
    for (const [key, expression] of Object.entries(entry.definition.arguments ?? {})) {
      const outcome = evaluate(expression);
      if (!outcome.ok) {
        move(entry, 'failed', {
          code: 'SUBSCRIPTION_START_FAILED',
          message: `configuration argument ${key} could not be evaluated`,
        });
        return;
      }
      args[key] = outcome.value;
    }

    try {
      const handle = await adapter.start({
        subscription: entry.definition,
        source: subscriptionSourceName(entry.definition),
        arguments: args,
        deliver: (delivery) => accept(entry, delivery),
        connectionLost: (reason) => {
          if (entry.record.state !== 'active') {
            return;
          }
          void reconnect(entry, { code: 'SUBSCRIPTION_CONNECTION_LOST', message: reason ?? 'the transport closed' });
        },
      });
      if (!running) {
        await handle.stop();
        return;
      }
      entry.handle = handle;
      move(entry, 'active');
    } catch (error) {
      const failure = {
        code: 'SUBSCRIPTION_START_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
      await retryLater(entry, attempt, failure);
    }
  }

  /**
   * Axiom's reconnect policy, not the adapter's: how many attempts and how far apart, so the
   * answer does not change with the provider. Exhausting it is terminal for this process —
   * `failed`, visible, and never a silent hot loop.
   */
  async function retryLater(
    entry: Managed,
    attempt: number,
    failure: { code: string; message: string },
  ): Promise<void> {
    const policy = subscriptionReconnectPolicy(entry.definition);
    const maxAttempts = policy.policy === 'none' ? 1 : (policy.maxAttempts ?? 5);
    if (attempt >= maxAttempts) {
      move(entry, 'failed', failure);
      return;
    }
    move(entry, 'reconnecting', failure);
    const base = policy.delayMs ?? 1000;
    const waitMs = policy.policy === 'exponential' ? base * 2 ** (attempt - 1) : base;
    host.scheduleOnce(waitMs, () => void activate(entry, attempt + 1));
  }

  async function reconnect(entry: Managed, failure: { code: string; message: string }): Promise<void> {
    const handle = entry.handle;
    entry.handle = undefined as SubscriptionHandle | undefined;
    if (handle) {
      await handle.stop();
    }
    await retryLater(entry, 1, failure);
  }

  async function stopOne(
    entry: Managed,
    state: 'stopped' | 'failed',
    failure?: { code: string; message: string },
  ): Promise<void> {
    const handle = entry.handle;
    entry.handle = undefined as SubscriptionHandle | undefined;
    move(entry, state, failure);
    // Everything parked and everything queued is answered rather than left hanging: an
    // adapter awaiting `deliver` must learn that the subscription is gone.
    for (const waiter of entry.waiting.splice(0)) {
      waiter();
    }
    for (const item of entry.queue.splice(0)) {
      item.settle({ status: 'stopped' });
    }
    entry.record.queued = 0;
    if (handle) {
      await handle.stop();
    }
  }

  return {
    async start(): Promise<void> {
      running = true;
      const required: Array<{ entry: Managed; error: string }> = [];
      for (const entry of managed.values()) {
        if (!subscriptionAutoStart(entry.definition)) {
          move(entry, 'inactive');
          continue;
        }
        await activate(entry, 1);
        if (subscriptionIsRequired(entry.definition) && entry.record.state !== 'active') {
          required.push({
            entry,
            error: entry.record.lastFailure?.message ?? 'the source could not be established',
          });
        }
      }
      if (required.length > 0) {
        // The one case where a subscription failure stops the application: the author said
        // this source is what the application is *for*. Every other failure leaves the
        // application running and the subscription observably reconnecting or failed.
        throw new Error(
          `Required subscription(s) did not start: ${required
            .map(({ entry, error }) => `${entry.definition.name ?? entry.definition.id} (${error})`)
            .join(', ')}`,
        );
      }
    },

    status: () => [...managed.values()].map((entry) => ({ ...entry.record })),
    statusOf: (id: NodeId) => {
      const entry = managed.get(id);
      return entry ? { ...entry.record } : undefined;
    },

    async stop(): Promise<void> {
      running = false;
      for (const entry of managed.values()) {
        if (entry.record.state !== 'inactive') {
          await stopOne(entry, 'stopped');
        }
      }
    },
  };
}

/** Whether a delivery status means the event reached authoritative state. */
export function deliveryApplied(status: DeliveryStatus): boolean {
  return status === 'applied';
}
