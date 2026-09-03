# Subscriptions

Axiom 0.15.0-alpha.1. How an application receives a stream of external events — an MQTT
topic, a WebSocket feed, a queue consumer, a filesystem watcher, a serial port — without a
client, a socket or a callback anywhere in the graph.

[`INTEGRATIONS.md`](INTEGRATIONS.md) is the outbound half (query and effect); this is the
inbound one. [`AUTHORITY.md`](AUTHORITY.md) is the trust boundary all three sit behind.

## The three directions

Axiom's whole external-interaction model is three directions and no more:

| | Shape | Vocabulary |
| --- | --- | --- |
| **Query** | Ask, and wait for a finite answer. | `integration-query` on an `IntegrationOperationDef{mode:'query'}` |
| **Effect** | Tell the world to do something. No answer joins the transaction. | `integration-effect` on an `IntegrationOperationDef{mode:'effect'}` |
| **Subscription** | The world tells *you*, for as long as you are listening. | `SubscriptionDef` → `EventDef` |

Storage is not a fourth direction: a metadata lookup is a query, a commit or a delete is an
effect. See [`STORAGE.md`](STORAGE.md).

## The model

```ts
interface SubscriptionDef {
  id: NodeId;
  kind: 'subscription';
  integrationId: NodeId;
  source?: string;
  arguments?: Record<string, Expression>;
  eventId: NodeId;
  lifecycle?: {
    autoStart?: boolean;
    required?: boolean;
    reconnect?: { policy: 'none' | 'fixed' | 'exponential'; maxAttempts?: number; delayMs?: number };
  };
  delivery?: {
    maxQueued?: number;
    backpressure?: 'block' | 'reject' | 'drop-oldest' | 'drop-newest';
    deduplicateBy?: FieldId;
    deduplicationWindow?: number;
    maxAttempts?: number;
    onFailure?: 'report' | 'pause';
  };
}
```

`integrationId` names the capability domain whose adapter maintains the source. `source` is
a **semantic** name — `'device-status'`, `'inbound-orders'` — that the adapter maps to a
topic, a URL, a queue or a device; the graph never learns which. Absent, the subscription's
own id is the name.

```ts
graph.addNode<SubscriptionDef>({
  id: SUBSCRIPTION_DEVICE_STATUS,
  kind: 'subscription',
  name: 'live device status',
  integrationId: INTEGRATION_DEVICE_PROVIDER,
  source: 'device-status',
  eventId: EVENT_DEVICE_STATUS_CHANGED,
  delivery: { deduplicateBy: F_CHANGE_DELIVERY_ID, maxQueued: 32 },
});
```

## The pipeline

There is no second event system. A delivery enters the one that already exists:

```
external source → SubscriptionAdapter → SubscriptionDef → EventDef → TriggerDef → ActionDef
```

MUST NOT: invoke an application callback, register a handler, or mutate state from the
adapter. An adapter's only semantic act is calling `deliver`.

## Rules

- A `SubscriptionDef` MUST name an `EventDef` that at least one `TriggerDef{when:{kind:'event'}}`
  is bound to. A live source feeding nothing is `SUBSCRIPTION_EVENT_UNREACHABLE`.
- A `SubscriptionDef` MUST appear in a graph with server-authoritative state, or it is
  `SUBSCRIPTION_WITHOUT_AUTHORITY` — nothing would activate it.
- Subscriptions are **server-only**. `compileToIR` strips them from the client IR exactly as
  it strips integrations. There is no client-side subscription and none is compiled inert;
  `validateForBrowser` and `compileToIR` therefore agree by construction.
- `arguments` are evaluated **once, at activation**, in the root scope. A live source is not
  re-negotiated per message, so nothing per-delivery is in scope there.
- A subscription-originated action runs with `source: 'system'`. Declare
  `invocation: { allowedSources: ['system'] }` on it — see **Security** below.

## Lifecycle

Six states, and only these transitions:

```
inactive ──start──▶ starting ──ok──▶ active ──stop──▶ stopped
                       │               │
                       │ fail          │ transport lost
                       ▼               ▼
                    failed ◀─exhausted─ reconnecting ──ok──▶ active
```

| State | Meaning |
| --- | --- |
| `inactive` | Declared, but `lifecycle.autoStart: false` — startup did not activate it. |
| `starting` | The first activation attempt is in flight. |
| `active` | The source is established and deliveries are being accepted. |
| `reconnecting` | The transport was lost, or an attempt failed; the reconnect policy is running. |
| `failed` | The reconnect policy is spent, or `onFailure: 'pause'` stopped it. Terminal for this process. |
| `stopped` | `server.stop()`. Accepts nothing, ever again. |

**Startup owns activation.** `AxiomServer.start()` activates every `autoStart` subscription,
after persistence has loaded and pending effects have resumed. Application code MUST NOT —
and cannot — call `subscription.start()`: there is no such method.

**A failed source does not stop the application.** `lifecycle.required` is false by default,
so an unreachable feed leaves the application serving requests with that subscription
observably `reconnecting` then `failed`. Set `required: true` only when the application is
not meaningfully running without the source; `start()` then rejects.

**Restart recreates from the graph.** A live connection is not persisted. The graph is the
declaration of desired subscription state, so a restarted process reactivates every
`autoStart` subscription from the Server IR alone.

**Reconnect policy is Axiom's; reconnect mechanics are the adapter's.** An adapter reports a
lost transport through `connectionLost()`; how many attempts, how far apart and when to give
up come from `lifecycle.reconnect`, so the answer does not change with the provider. Default:
exponential, 5 attempts, 1000ms base.

**A transport failure is not a domain event.** It moves the lifecycle state and reports a
diagnostic. It becomes an `EventDef` only if an author deliberately declares one for it.

## Delivery guarantees

**Delivery is at-least-once.** A provider that redelivers, a reconnect that replays, and a
crash between dispatch and commit can each present the same external event twice. Axiom does
not claim exactly-once, because it cannot deliver it across all three.

**Deduplication makes it effectively-once where an external identity exists.**
`delivery.deduplicateBy` names a field of the event's payload entity carrying the provider's
own delivery identity — a message id, an offset, a delivery tag. A repeated value is
acknowledged and never dispatched. It is deliberately a payload field and not an Axiom
transaction id: the provider decides what identifies a delivery, and Axiom cannot invent one
that survives a redelivery it did not cause.

**Deduplication survives a restart** when the persistence adapter implements `hasDelivery`
and `recordDelivery` — `createMemoryPersistence` does. Without them the window is
in-process only and does **not** survive a restart; that is a real limitation, not a
guarantee to build on.

Deduplication is bounded by `deduplicationWindow` (default 512). A redelivery older than the
window is dispatched again.

## Ordering

| | Guaranteed? |
| --- | --- |
| Deliveries of **one** subscription | **Yes** — dispatched one at a time, in accepted order, each in its own transaction. |
| Deliveries of **two** subscriptions | **No.** None. They are independent sources. |
| A delivery against a client request or a trigger tick | Only that each takes its own serialized turn. No relative order. |

Two subscriptions do enter the same serialized authority queue, so their *commits* never
interleave — but nothing orders their *arrival*, and a consumer MUST NOT build on an
accident of interleaving.

## Transactions

Each accepted delivery enters authoritative execution through **one** transaction boundary.
Multiple deliveries never share a transaction: the runtime awaits each dispatch before taking
the next off the queue.

If the triggered action fails, its transaction rolls back like any other — but the external
provider cannot un-send the event. What happens next is `delivery.maxAttempts` (default 1,
i.e. no retry) and then `delivery.onFailure`.

## Backpressure

The queue is **bounded**, always. `maxQueued` defaults to 64.

| `backpressure` | When the queue is full | Loses events? |
| --- | --- | --- |
| `block` (default) | The adapter's `deliver` call does not resolve until there is room. | **No** |
| `reject` | The delivery is refused; the source still holds it. | **No** |
| `drop-oldest` | The oldest queued delivery is discarded. | **Yes** |
| `drop-newest` | The arriving delivery is discarded. | **Yes** |

The default cannot lose an authoritative event: an adapter that awaits `deliver` applies real
backpressure to its own transport instead of buffering without limit. The two dropping modes
are legitimate for a genuinely lossy source — a sensor feed where only the newest reading
matters — and both report `SUBSCRIPTION_DELIVERY_DROPPED` and increment
`SubscriptionRecord.dropped`. **Loss is always declared and never silent.**

## Poison deliveries

A delivery whose action keeps failing is bounded by `delivery.maxAttempts` and then handled by
`delivery.onFailure`:

| `onFailure` | Behaviour |
| --- | --- |
| `report` (default) | Count it as `failed`, answer the adapter `failed`, take the next delivery. |
| `pause` | The above, then stop the subscription — state `failed`. |

Neither ever retries without bound. There is no dead-letter queue: Axiom does not invent a
workflow system, and an adapter that needs one translates a `failed` outcome into its
provider's own.

## Acknowledgement

`deliver` resolves with a `DeliveryOutcome` describing what became of the delivery, and the
adapter translates it into whatever its provider needs — an `ack`, a `nack`, an offset
commit, or nothing:

| Status | Meaning | Typical translation |
| --- | --- | --- |
| `applied` | Dispatched; its action committed. | ack / commit offset |
| `duplicate` | Already seen; not dispatched again. | ack |
| `rejected` | The payload did not conform to the `EventDef`. | ack, or dead-letter |
| `failed` | Dispatched; the action failed after every permitted attempt. | nack, or dead-letter |
| `dropped` | Discarded under a declared lossy policy. | ack |
| `refused` | Refused by backpressure; the source still holds it. | nack |
| `stopped` | The subscription is no longer running. | nack |

Ack vocabulary lives in the adapter contract and MUST NOT appear in an `ApplicationGraph`:
every provider spells it differently, and a graph that named one would stop being portable.

## Payload validation

A delivered payload is **untrusted data**, even though the adapter is trusted infrastructure.
It is validated against the target `EventDef.payloadType` **before** anything else. An invalid
payload:

- does not dispatch the event,
- does not invoke any action,
- does not mutate authoritative state,
- reports `EVENT_PAYLOAD_INVALID` and increments `SubscriptionRecord.rejected`.

## Security

- A client **cannot** forge a delivery. There is no protocol message that delivers into a
  subscription; a delivery exists only inside the authority, from an adapter.
- A client **cannot** invoke a subscription-only action. Declare
  `invocation: { allowedSources: ['system'] }` and `INVOCATION_SOURCE_NOT_ALLOWED` refuses a
  client-sourced call before identity is consulted.
- An external source **cannot** bypass authorization, preconditions, constraints, transition
  constraints or rollback. A subscription-originated action runs through exactly the same
  `invokeCore` a client request does, under `principal: null`.
- After shutdown, **no** delivery reaches state. `stop()` moves every subscription to
  `stopped`, and a stopped subscription answers `stopped` to everything.

## Observability

```ts
server.subscriptionLog();                    // SubscriptionRecord[]
server.subscriptionStatus(SUBSCRIPTION_ID);  // SubscriptionRecord | undefined
```

`SubscriptionRecord` carries `state`, `source`, `attempts`, `received`, `applied`,
`rejected`, `failed`, `dropped`, `queued`, `lastDeliveryAt` and `lastFailure`. That is the
whole operational picture — configured, active, reconnecting, failed, arriving, being
refused — and it is host observability, not an application-authored health route.

## Adapters

```ts
interface SubscriptionAdapter {
  start(context: SubscriptionContext): Promise<SubscriptionHandle>;
}
```

Registered per integration id on `createAxiomServer({ subscriptions })` or
`serveAxiomApplication({ subscriptions })`. A declared subscription with no registered
adapter fails `start()`, rather than staying silently inactive.

Sockets, `EventEmitter`s, Node streams, subprocesses, serial ports and provider SDKs are all
permitted **inside** an adapter and nowhere above it. One adapter may multiplex many
subscriptions over one connection: nothing in Axiom assumes `SubscriptionDef` and TCP session
correspond.

`createScriptedSubscriptionAdapter(scripts, host)` is the deterministic fake — connect
success and failure, deliveries, duplicates, delayed deliveries, disconnection and
reconnection, all as data against a virtual clock, with no network and no wall-clock wait.
The same script shape appears in the portable conformance fixtures.

## Subscription vs. webhook vs. polling

| | What it is | How it reaches Axiom |
| --- | --- | --- |
| **Webhook** | An externally initiated **finite request**. Each delivery independently enters Axiom. | The host verifies it, then sends one `EventRequest`. See [`EVENTS.md`](EVENTS.md). |
| **Subscription** | Axiom maintains a standing **semantic interest** in a long-lived source. Deliveries occur while it is active. | The adapter calls `deliver` while the subscription is `active`. |
| **Polling** | Axiom asks, repeatedly, on a schedule. | `TriggerDef{when:{kind:'interval'}}` → `integration-query`. See [`TRIGGERS.md`](TRIGGERS.md). |

Do not hide polling behind subscription syntax: a source you have to ask is a query on a
timer, and saying so keeps the graph honest about what it does to the provider.

`TriggerDef` keeps timer and lifecycle semantics; `SubscriptionDef` keeps external long-lived
sources. Neither replaces the other.

## Contract

Subscription vocabulary requires `axiom.server.v5`, computed from the document — a graph that
uses none of it compiles to the byte-identical older document it always did. See
[`AUTHORITY.md`](AUTHORITY.md#contract-identifiers).

## Diagnostic codes

| Code | Meaning |
| --- | --- |
| `SUBSCRIPTION_EVENT_UNREACHABLE` | (validation) The event has no trigger bound to it. |
| `SUBSCRIPTION_WITHOUT_AUTHORITY` | (validation) The graph has no server-authoritative state. |
| `SUBSCRIPTION_INVALID_POLICY` | (validation) A queue below one, no attempts, an unknown backpressure policy, or a `deduplicateBy` that is not a field of the payload entity. |
| `SUBSCRIPTION_ADAPTER_MISSING` | No adapter is registered for the integration. |
| `SUBSCRIPTION_START_FAILED` | The source could not be established after every reconnect attempt. |
| `SUBSCRIPTION_DELIVERY_DROPPED` | A delivery was discarded under a declared lossy policy. |
| `SUBSCRIPTION_DELIVERY_FAILED` | A delivery's action failed after every permitted attempt. |
| `EVENT_PAYLOAD_INVALID` | The payload did not conform to the `EventDef.payloadType`. |
