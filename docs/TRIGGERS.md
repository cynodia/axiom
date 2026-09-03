# Triggers

Axiom 0.15.0-alpha.2. A `TriggerDef` says **when** an action should be invoked, without
embedding callback code. `docs/AUTHORITY.md`
[§ Triggers](AUTHORITY.md#triggers) is the load-bearing statement of the execution model;
this file is the vocabulary.

A trigger covers time (`interval`, `delay`), the application lifecycle, and a dispatched
event. It does **not** cover a long-lived external source: that is a
[`SubscriptionDef`](SUBSCRIPTIONS.md), whose deliveries become `EventDef` payloads that
`event` triggers then react to. Keep the two separate — an interval trigger driving an
`integration-query` is polling, and polling is not a subscription.

## The model

```ts
interface TriggerDef {
  id: NodeId;
  kind: 'trigger';
  actionId: NodeId;
  when: TriggerSpec;
  arguments?: Record<string, Expression>;
  enabledWhen?: Expression;
}

type TriggerSpec =
  | { kind: 'interval'; everyMs: number; overlap?: 'skip' | 'queue' }
  | { kind: 'delay'; afterMs: number }
  | { kind: 'lifecycle'; event: 'application-start' | 'runtime-ready' | 'route-enter' | 'route-leave'; routeId?: NodeId }
  | { kind: 'event'; eventId: NodeId };
```

`TRIGGER_KINDS` is `['interval', 'delay', 'lifecycle', 'event']`. `everyMs`/`afterMs` are
plain numbers, never expressions — scheduling stays static; only `enabledWhen` is dynamic,
evaluated each time the trigger would otherwise fire. This is deliberate (spec §62): a
rapidly-changing interval would be a scheduling platform, which 0.8 is not (spec §58).

## A trigger invokes an action exactly as any other caller does

**There is no weaker execution path for a triggered action** (spec §102). The same
`invoke` pipeline the client's `InvokeRequest` uses runs it: the same argument checking,
the same authorization evaluation, the same guards, the same transaction, the same
constraints and transition constraints. A constraint violation from a triggered action
rolls back exactly like one from a client request does.

The one thing that differs is who is asking: a triggered invocation runs under
`ExecutionContext.principal: null`, `source: 'system'` — no credential is authenticated,
because there is no caller to authenticate (spec §68). An action whose `.authorization`
can only be satisfied by a real, authenticated principal is correctly refused when a
trigger targets it; this is not a special case in the authorization check, it is the
ordinary one applied to a `null` principal, exactly as an anonymous client request gets.

`source: 'system'` is also what `invocation.allowedSources` checks (spec 8.1 §3-14, full
model in [`AUTHORITY.md`](AUTHORITY.md#invocation-source)): an action meant only to be a
trigger's target — an effect's `succeededEventId`/`failedEventId` handler, a webhook's — can
declare `invocation: { allowedSources: ['system'] }` so an anonymous client that guessed its
id cannot invoke it directly. A trigger targeting an action that has opted out of
`'system'` entirely is rejected at validation (`TRIGGER_TARGET_SOURCE_MISMATCH`), since the
trigger could then never succeed.

## Where a trigger executes

Derived from where its target action executes, not declared:

| `when.kind` | Runs | Because |
| --- | --- | --- |
| `interval`, `delay` | server, if the target action is server-authority; otherwise client | either authority can run a timer |
| `lifecycle: 'application-start' \| 'runtime-ready'` | server | these are authority startup moments |
| `lifecycle: 'route-enter' \| 'route-leave'` | client | routes are a client-IR concept |
| `event` | server | only the server dispatches events |

`event` triggers targeting a client-authority action, and `route-enter`/`route-leave`
triggers targeting a server-authority one, are rejected at validation
(`TRIGGER_WRONG_AUTHORITY`) — the mismatch can never reach a runtime that would silently
do nothing with it.

**A client-authority trigger of a kind the browser cannot execute is a validation error,
not a silent no-op — for any call that actually names the browser's capabilities.** The
browser runtime implements no trigger kind at all today
(`BROWSER_TRIGGER_CAPABILITIES.supportedTriggerKinds` is empty), so `compileToIR` — which
applies `BROWSER_TRIGGER_CAPABILITIES` by default — and `validateForBrowser` both reject
such a trigger with `CLIENT_TRIGGER_UNSUPPORTED`, the same capability-gate pattern
`RendererCapabilities` already applies to UI node kinds. Before spec 8.1, the trigger
validated and compiled into `ApplicationIR.triggers` and simply never fired, which is
exactly the "publicly declared, typechecks, passes validation, has no defined runtime
behaviour" shape the framework forbids.

**`validateGraph(graph)` with no options is target-neutral by design (spec 8.2 §2-4) and
does not raise `CLIENT_TRIGGER_UNSUPPORTED`** — a graph is never rejected for a trigger
runtime nobody named, exactly as it is never rejected for a renderer nobody named. A
validate-only workflow that wants the browser-real answer without compiling calls
`validateForBrowser(graph)` (`@cynodia/axiom-compiler`) instead of the bare call; both it
and `compileToIR` apply the identical `BROWSER_TRIGGER_CAPABILITIES`, so they never
disagree. Compiling for a trigger runtime that *does* implement a kind
(`compileToIR(graph, { triggerRuntime })`) accepts it. Only the authoritative runtime
executes triggers today. See [Not in 0.8.0](AUTHORITY.md#not-in-080).

## Interval semantics

```ts
{ kind: 'interval', everyMs: 5000, overlap?: 'skip' | 'queue' }   // overlap defaults to 'skip'
```

- First execution is `everyMs` after the trigger runtime starts — there is no
  fire-immediately option.
- `overlap: 'skip'` (default): a tick that fires while the previous invocation of the same
  trigger is still running is discarded — reported as `TRIGGER_OVERLAP_SKIPPED` — never
  queued and never run concurrently with it.
- `overlap: 'queue'`: one pending tick runs immediately after the in-flight one finishes.
  Never more than one queued at a time.
- A failed invocation (a refused guard, a rolled-back constraint) is reported the ordinary
  way and does not cancel the schedule; the next tick still fires.

## Lifecycle triggers and startup order

`application-start` and `runtime-ready` triggers fire once, in that order, as the last
step of `AxiomServer.start()` — after persistence has loaded, effect resumption has begun,
and every required integration adapter has been validated present, and before any request
is accepted:

```text
load IR → initialize persistence → restore state → initialize adapters →
validate required capabilities → runtime-ready triggers run → accept requests
```

(`application-start` triggers run first, ahead of `runtime-ready`, within that same step.)

## Event triggers and the payload scope

```ts
{ kind: 'event', eventId: EVENT_DEVICE_STATUS_CHANGED }
```

An `event`-kind trigger's `arguments`/`enabledWhen` may `ref` **the trigger's own id** to
read the event's payload — the same mechanism a `for-each`/`map`'s `scopeId` provides,
except the whole payload is bound, not a collection member:

```ts
graph.addNode<TriggerDef>({
  id: TRIGGER_STATUS_CHANGED,
  kind: 'trigger',
  actionId: ACTION_APPLY_STATUS,
  when: { kind: 'event', eventId: EVENT_DEVICE_STATUS_CHANGED },
  arguments: { [String(PARAM_STATUS)]: ref(TRIGGER_STATUS_CHANGED) },
});
```

Full event semantics: [`EVENTS.md`](EVENTS.md).

## Enablement

```ts
enabledWhen?: Expression
```

Evaluated each time the trigger would otherwise fire; a `false`/unevaluable result means
this occurrence does not run, but the schedule continues. This is the mechanism for
"poll only while the integration is enabled" (spec §61) — dynamic enablement, never a
dynamic interval.

## A deterministic test clock

```ts
const host = createDeterministicServerHost();
const server = createAxiomServer({ ir, host, integrations });
await server.start();

host.advance(5000);   // fires every timer due within the next 5000ms, in due-time order
```

No test verifying interval/delay behavior needs to wait on a real second (spec §85,141).
`advance(ms)` fires every host timer that becomes due, re-scheduling intervals, in the
order they would fire on a real clock.

**Every invocation — client request or trigger tick — is serialized against every other one
this authority runs** (spec 8.1 §26-30), the same FIFO ordering `AxiomServer.handle()`
already gave client requests. `advance(ms)` firing several same-period triggers in one call
does not race their commits against each other: each waits its turn, exactly as it would
under real, staggered timer callbacks. This is why the deterministic host and the real host
agree on outcome for the same schedule — the ordering guarantee does not depend on which
host is running. Only the overlap check itself (`inFlight`, above) runs unserialized, since
it exists specifically to detect *concurrent* ticks of the *same* trigger, which requires
running immediately when the timer fires.

**A hung query cannot wedge a trigger forever.** `integration-query`'s `timeoutMs` is
enforced by the runtime itself (spec 8.1 §15-25, full model in
[`INTEGRATIONS.md`](INTEGRATIONS.md#timeout)) — a non-cooperating adapter's promise that
never settles still causes the invocation, and therefore the tick, to fail within
`timeoutMs`, clearing `inFlight` so the next scheduled tick runs normally instead of being
skipped as an overlap forever.

## Validation

| Code | Raised when |
| --- | --- |
| `TRIGGER_ACTION_NOT_FOUND` | `actionId` does not resolve to an action. |
| `TRIGGER_INTERVAL_NOT_POSITIVE` | `everyMs`/`afterMs` is not a positive number. |
| `UNKNOWN_EVENT` | An `event` trigger's `eventId` does not resolve to an `EventDef`. |
| `TRIGGER_WRONG_AUTHORITY` | An authority mismatch between the trigger kind and its target action, described above. |
| `TRIGGER_TARGET_SOURCE_MISMATCH` | The target action's `invocation.allowedSources` excludes `'system'`, so this trigger could never invoke it. |
| `CLIENT_TRIGGER_UNSUPPORTED` | A client-authority trigger of a kind the named trigger runtime does not execute. |

Full table: [`VALIDATION.md`](VALIDATION.md#integrations-effects-triggers-and-events).

## AgentAPI

```ts
agent.getTriggersForAction(actionId);        // TriggerDef[]
agent.getTimedTriggers();                    // TriggerDef[] — interval and delay only
agent.getActionsTriggeredByEvent(eventId);    // ActionDef[]
agent.getSystemOnlyActions();                 // ActionDef[] — invocation.allowedSources excludes 'client'
agent.getTriggersTargetingClientOnlyActions(); // TriggerDef[] — could never succeed
agent.isClientInvocable(actionId);            // boolean
agent.isSystemOnly(actionId);                 // boolean
```

"What runs automatically" and "what happens every 5 seconds" (spec §78) are answerable
without reading source, and so is "which actions are reachable only by a trigger, event or
effect outcome" (spec 8.1 §13).
