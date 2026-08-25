import type { NodeId, SubscriptionDef } from './deps.js';
import type { ServerHost } from './host.js';

/**
 * The adapter boundary for a long-lived external source.
 *
 * Above this line: a `SubscriptionDef`, an `EventDef` and a delivery policy. Below it:
 * whatever the provider actually requires — an MQTT client, a WebSocket, a Kafka consumer
 * group, an AMQP channel, an `fs.watch`, a serial port. Sockets, `EventEmitter`s, streams
 * and provider SDKs are all permitted here and nowhere above.
 *
 * One connection may carry many subscriptions and one subscription may outlive many
 * connections: nothing in Axiom assumes `SubscriptionDef` and TCP session correspond, and
 * an adapter is free to multiplex.
 */

/** What an adapter hands the runtime for one external message. */
export interface SubscriptionDelivery {
  /** The event payload, untrusted: validated against `EventDef.payloadType` before use. */
  payload: unknown;
  /**
   * The provider's own identity for this delivery, when it has one — a broker message id,
   * an offset, a delivery tag. Only used when the subscription declares `deduplicateBy`,
   * and then only as a fallback: the payload field named there wins, because that identity
   * is the one the provider guarantees across a redelivery.
   */
  deliveryKey?: string;
}

/**
 * What became of a delivery, so an adapter can translate semantic completion into whatever
 * its provider needs — an `ack`, a `nack`, an offset commit, or nothing at all.
 *
 * That translation is the adapter's, deliberately: acknowledgement vocabulary differs
 * between every provider worth supporting, and an `ApplicationGraph` that named one would
 * stop being portable. The graph declares delivery policy semantically; this is the result
 * of applying it.
 *
 * | Status | Meaning | Typical provider translation |
 * | ------ | ------- | ---------------------------- |
 * | `applied` | Accepted, dispatched, its action committed. | ack / commit offset |
 * | `duplicate` | Already seen; not dispatched again. | ack |
 * | `rejected` | Payload did not conform to the event's declared type. | ack, or dead-letter — redelivering it cannot help |
 * | `failed` | Dispatched; the action failed after every permitted attempt. | nack, or dead-letter |
 * | `dropped` | Backpressure discarded it, under a declared lossy policy. | ack |
 * | `refused` | Backpressure refused it; the source still holds it. | nack — redelivery is expected |
 * | `stopped` | The subscription is no longer running. | nack |
 */
export type DeliveryStatus =
  | 'applied'
  | 'duplicate'
  | 'rejected'
  | 'failed'
  | 'dropped'
  | 'refused'
  | 'stopped';

export interface DeliveryOutcome {
  status: DeliveryStatus;
  /** A structured reason, for `rejected` and `failed`. Never a state value. */
  code?: string;
  message?: string;
}

/** What the runtime gives an adapter when it starts a subscription. */
export interface SubscriptionContext {
  /** The subscription being started, so one adapter can serve several. */
  subscription: SubscriptionDef;
  /** Its declared semantic source name — `'device-status'`, never a topic string. */
  source: string;
  /** `arguments`, evaluated once against authoritative state at activation. */
  arguments: Record<string, unknown>;
  /**
   * Hands one external message to Axiom. Resolves with what became of it.
   *
   * Under `backpressure: 'block'` this does not resolve while the queue is full, which is
   * exactly the point: an adapter that awaits it applies real backpressure to its own
   * transport instead of buffering without limit.
   */
  deliver(delivery: SubscriptionDelivery): Promise<DeliveryOutcome>;
  /**
   * Reports that the transport dropped, so Axiom's reconnect policy takes over. An adapter
   * calls this instead of reconnecting on its own schedule: reconnect *policy* is Axiom's
   * (how many times, how long apart, when to give up), reconnect *mechanics* are the
   * adapter's.
   */
  connectionLost(reason?: string): void;
}

/** A running subscription, from the runtime's side. */
export interface SubscriptionHandle {
  stop(): void | Promise<void>;
}

export interface SubscriptionAdapter {
  /**
   * Establishes the source and begins delivering. Rejecting (or throwing) means the attempt
   * failed; Axiom applies the declared reconnect policy and moves the subscription to
   * `reconnecting`, then `failed`.
   */
  start(context: SubscriptionContext): Promise<SubscriptionHandle>;
}

export type SubscriptionAdapterRegistry = Record<NodeId, SubscriptionAdapter>;

// ------------------------------------------------------------------ scripted adapter

/**
 * One entry of a deterministic script. Pure data — no callback appears in it, which is what
 * lets the same script live inside a portable conformance fixture.
 */
export type SubscriptionScriptEntry =
  /** Refuse this activation attempt. Repeat it to exhaust the reconnect budget. */
  | { kind: 'connect-failure'; message?: string }
  /**
   * Deliver a payload `afterMs` on the host's clock, measured from activation.
   *
   * `attempt` restricts the entry to one activation (1-based): without it the entry is
   * replayed on every reconnect, which models a source that resends on every connection,
   * and with it a script can say "this arrives only after the reconnect".
   */
  | { kind: 'deliver'; afterMs?: number; attempt?: number; payload: unknown; deliveryKey?: string }
  /** Drop the transport `afterMs`, so the reconnect policy runs. */
  | { kind: 'disconnect'; afterMs?: number; attempt?: number; reason?: string };

export interface SubscriptionScript {
  /** Entries for one subscription id, applied in order on each activation attempt. */
  entries: SubscriptionScriptEntry[];
}

/** What a scripted adapter observed, so a test can assert acknowledgement behaviour. */
export interface ScriptedSubscriptionAdapter extends SubscriptionAdapter {
  /** Every delivery this adapter made, with the outcome Axiom returned for it. */
  outcomes(): Array<{ subscriptionId: NodeId; deliveryKey?: string; status: DeliveryStatus }>;
  /** How many times each subscription has been started, successfully or not. */
  attempts(subscriptionId: NodeId): number;
}

/**
 * A deterministic fake external source.
 *
 * Connect success and failure, deliveries, duplicates, delayed deliveries, disconnection
 * and reconnection are all scripted as data against the host's virtual clock, so a
 * subscription test needs no network, no real timer and no wall-clock wait — and a
 * conformance fixture can carry the same script as JSON.
 */
export function createScriptedSubscriptionAdapter(
  scripts: Record<string, SubscriptionScript>,
  host: Pick<ServerHost, 'scheduleOnce'>,
): ScriptedSubscriptionAdapter {
  const observed: Array<{ subscriptionId: NodeId; deliveryKey?: string; status: DeliveryStatus }> = [];
  const attemptCounts = new Map<string, number>();

  return {
    outcomes: () => observed.map((entry) => ({ ...entry })),
    attempts: (subscriptionId: NodeId) => attemptCounts.get(String(subscriptionId)) ?? 0,

    async start(context: SubscriptionContext): Promise<SubscriptionHandle> {
      const id = String(context.subscription.id);
      const attempt = (attemptCounts.get(id) ?? 0) + 1;
      attemptCounts.set(id, attempt);
      const script = scripts[id] ?? scripts[context.source];
      const entries = script?.entries ?? [];

      // Connect failures are consumed in order: the first attempt sees the first one, so a
      // script of two failures followed by deliveries models "flapped twice, then settled".
      const failures = entries.filter((entry) => entry.kind === 'connect-failure');
      if (attempt <= failures.length) {
        const failure = failures[attempt - 1] as { kind: 'connect-failure'; message?: string };
        throw new Error(failure.message ?? `scripted connect failure ${attempt} for ${id}`);
      }

      let stopped = false;
      const timers: Array<{ cancel(): void }> = [];
      // Attempt-scoped entries are counted from the first *successful* activation, so a
      // script reads as "on the first connection … after the first reconnect …" rather
      // than having to account for the failed attempts the connect-failure entries consumed.
      const connection = attempt - failures.length;
      for (const entry of entries) {
        if (entry.kind === 'connect-failure') {
          continue;
        }
        if (entry.attempt !== undefined && entry.attempt !== connection) {
          continue;
        }
        const at = entry.afterMs ?? 0;
        const fire = (): void => {
          if (stopped) {
            return;
          }
          if (entry.kind === 'disconnect') {
            context.connectionLost(entry.reason ?? 'scripted disconnect');
            return;
          }
          void context
            .deliver({
              payload: entry.payload,
              ...(entry.deliveryKey !== undefined ? { deliveryKey: entry.deliveryKey } : {}),
            })
            .then((outcome) => {
              observed.push({
                subscriptionId: context.subscription.id,
                ...(entry.deliveryKey !== undefined ? { deliveryKey: entry.deliveryKey } : {}),
                status: outcome.status,
              });
            });
        };
        if (at === 0) {
          // Still asynchronous: an adapter that delivered synchronously inside `start` would
          // be racing the runtime's own activation bookkeeping, which no real one does.
          timers.push(host.scheduleOnce(0, fire));
        } else {
          timers.push(host.scheduleOnce(at, fire));
        }
      }

      return {
        stop(): void {
          stopped = true;
          for (const timer of timers) {
            timer.cancel();
          }
        },
      };
    },
  };
}
