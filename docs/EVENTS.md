# Events

Axiom 0.11.0-alpha.1. An event is a typed fact — something that happened — never work
itself. [`AUTHORITY.md`](AUTHORITY.md#external-events) is the load-bearing statement;
this file is the vocabulary and the webhook delivery mechanism. A **subscription** is the
other way an external fact becomes an `EventDef` payload — see
[`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md), which also states the distinction between a webhook,
a subscription and polling.

## The model

```ts
interface EventDef {
  id: NodeId;
  kind: 'event';
  payloadType: TypeRef;
}
```

Nothing more: an event is a name and a typed payload. What happens when one occurs is a
`TriggerDef{when:{kind:'event', eventId}}` — see [`TRIGGERS.md`](TRIGGERS.md). Keeping
"a fact occurred" (`EventDef`) and "do this work" (`ActionDef`, via a trigger) as separate
node kinds is deliberate (spec §46): an event may have zero, one or several triggers bound
to it, and none of them is embedded in the event's own declaration.

## Event vs. action

| | Answers |
| --- | --- |
| `EventDef` | "What happened?" |
| `ActionDef` | "What should be done about it?" |

An event never mutates state itself. Only the action a trigger invokes does, through the
ordinary governed write path.

## Sources

An event reaches the semantic layer three ways, and all three funnel through the same
`dispatchEvent`/`TriggerRuntime.fireEvent` path and the same payload validation:

1. **An external webhook**, decoded and verified by a registered host adapter (below).
2. **An effect's own outcome** — `succeededEventId`/`failedEventId` on an
   `integration-effect` operation (see [`EFFECTS.md`](EFFECTS.md)).
3. **The semantic protocol directly** — `EventRequest{ kind: 'event', eventId, payload }`,
   for a host that already trusts its own caller (an internal service, a test).

## Payload validation

Every event's payload is checked against its declared `EventDef.payloadType` — the same
`validateValueAgainstType` walk that checks action arguments and seed data — **before any
trigger's action runs**. A malformed payload never reaches trusted code:
`EVENT_PAYLOAD_INVALID`, and no action is invoked.

## Webhooks

```ts
import { serveOverHttp } from '@cynodia/axiom-server';

await serveOverHttp({
  server,
  webhooks: {
    '/webhooks/device-provider': {
      verify: (request) => verifySignature(request.headers, request.rawBody, secret),
      decode: (request) => {
        const body = JSON.parse(request.rawBody.toString('utf8'));
        return { eventId: EVENT_DEVICE_STATUS_CHANGED, payload: body.status, deliveryId: body.id };
      },
    },
  },
});
```

An application author never declares an HTTP route (spec §54) — `webhooks` is a
*deployment* concern, registered where the Node host is stood up, and the graph never
mentions it. `verify` runs over the **raw, unparsed request**: signature verification is
over the exact bytes a provider signed, and it runs strictly before `decode` — an
unverified request never reaches the semantic layer at all (`WEBHOOK_VERIFICATION_FAILED`,
401). Provider-specific protocol — headers, signing scheme, payload shape — stays entirely
in `verify`/`decode`; nothing crosses into `ApplicationGraph`.

`serveAxiomApplication({ ..., webhooks })` accepts the same option directly (spec 8.1
§56-58) — a webhook-receiving application no longer has to drop to `createAxiomServer` +
`serveOverHttp` just to register one.

## Duplicate delivery

`decode`'s optional `deliveryId` is deduplicated against a **bounded, per-route,
most-recent window** (512 entries): a duplicate delivery within that window is
acknowledged (`ok: true`) without dispatching the event again. This is not a durable,
unbounded guarantee — a delivery older than the window, or a restart, is not remembered.
State that. Do not claim more.

## Event loop protection

A cascade — an event triggers an action, whose effect's success re-fires the same event —
is bounded: `MAX_EVENT_DISPATCH_DEPTH` (8) dispatches deep, then further dispatch stops
(`EVENT_DISPATCH_DEPTH_EXCEEDED`) rather than recursing without limit. Depth is carried
forward from the invocation that created an effect intent to the event its outcome
dispatches, so the guard holds across the commit/dispatch boundary, not only within one
synchronous call chain.

## Validation and diagnostics

| Code | Raised when |
| --- | --- |
| `UNKNOWN_EVENT` | A trigger's `eventId`, or an effect's `succeededEventId`/`failedEventId`, does not resolve to an `EventDef`. |
| `EVENT_PAYLOAD_INVALID` | A payload does not conform to its declared `payloadType`. |
| `EVENT_DISPATCH_DEPTH_EXCEEDED` | A cascade was stopped at the depth guard. |

Full tables: [`VALIDATION.md`](VALIDATION.md#integrations-effects-triggers-and-events),
[`AUTHORITY.md`](AUTHORITY.md#diagnostics).

## AgentAPI

```ts
agent.getTriggeredEvents();             // EventDef[] — events at least one trigger reacts to
agent.getActionsTriggeredByEvent(id);   // ActionDef[]
```

`getTriggeredEvents()` is a **graph-static** query — "which `EventDef`s have a `TriggerDef`
bound to them" — not "which webhook deliveries has this server received" (spec 8.2 §34-37).
An event it returns may be dispatched by a verified external webhook, by an effect's
`succeededEventId`/`failedEventId`, or by any other internal source; the graph does not
record which, so nothing here claims to. Webhook routes and deployment-level registration
are host/deployment concerns, deliberately outside what `GraphQueries` infers.

`getWebhookEvents()` is a deprecated alias, kept for backward compatibility; new code should
call `getTriggeredEvents()`.

"Which trigger-bound event can mutate `Order`?" (spec §78) is answerable by following
`getTriggeredEvents()` through `getActionsTriggeredByEvent()` to the actions it can reach,
without reading a single handler.
