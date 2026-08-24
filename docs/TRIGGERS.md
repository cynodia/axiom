# Triggers

Axiom 0.8.0. A `TriggerDef` says **when** an action should be invoked, without
embedding callback code. `docs/AUTHORITY.md`
[§ Triggers](AUTHORITY.md#triggers) is the load-bearing statement of the execution model;
this file is the vocabulary.

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

**Client-authority `interval`/`delay`/`route-enter`/`route-leave` triggers compile into
`ApplicationIR.triggers` for inspection, but the browser runtime does not yet schedule or
execute them.** Only the authoritative runtime does, today. See [Not in
0.8.0](AUTHORITY.md#not-in-080).

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

## Validation

| Code | Raised when |
| --- | --- |
| `TRIGGER_ACTION_NOT_FOUND` | `actionId` does not resolve to an action. |
| `TRIGGER_INTERVAL_NOT_POSITIVE` | `everyMs`/`afterMs` is not a positive number. |
| `UNKNOWN_EVENT` | An `event` trigger's `eventId` does not resolve to an `EventDef`. |
| `TRIGGER_WRONG_AUTHORITY` | An authority mismatch between the trigger kind and its target action, described above. |

Full table: [`VALIDATION.md`](VALIDATION.md#integrations-effects-triggers-and-events).

## AgentAPI

```ts
agent.getTriggersForAction(actionId);        // TriggerDef[]
agent.getTimedTriggers();                    // TriggerDef[] — interval and delay only
agent.getActionsTriggeredByEvent(eventId);    // ActionDef[]
```

"What runs automatically" and "what happens every 5 seconds" (spec §78) are answerable
without reading source.
