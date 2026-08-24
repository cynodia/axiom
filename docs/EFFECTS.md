# Effects

Axiom 0.8.0. External effects are not rollback-capable state mutations. This file
is the delivery model; [`AUTHORITY.md`](AUTHORITY.md#external-effects) is the load-bearing
statement of why, and [`INTEGRATIONS.md`](INTEGRATIONS.md) is the operation vocabulary this
builds on.

## The operation

```ts
{
  kind: 'integration-effect',
  operationId: NodeId,
  arguments?: Record<string, Expression>,
  idempotencyKey?: Expression,
  succeededEventId?: NodeId,
  failedEventId?: NodeId,
}
```

`operationId` must name an `IntegrationOperationDef` with `mode: 'effect'`
(`INTEGRATION_OPERATION_MODE_MISMATCH` otherwise). Legal only at an action's top level,
never inside `for-each`.

## Execution model — commit, then dispatch

```text
Action
  ↓
state transaction opens
  ↓
`integration-effect` reached → intent recorded (transaction-local, like a mutation)
  ↓
guards / constraints / transition constraints evaluated
  ↓
commit — state writes AND effect intent persisted atomically (the outbox invariant)
  ↓
response returned to the caller: "committed, effect pending"
  ↓
EffectRunner dispatches the intent → IntegrationAdapter.effect(...)
  ↓
terminal status (succeeded/failed) → declared event dispatched, if any
```

Reaching `integration-effect` **never calls the adapter**. It only appends an intent to a
transaction-scoped log — the same log a mutation is recorded in, `AxiomRuntime
.getEffectIntents()`, discarded on rollback exactly the way a rolled-back mutation is. The
adapter is called only **after** the surrounding transaction commits, by a separate
`EffectRunner`, and the invoking request's response never waits for that call — spec §123's
"action committed, effect pending" is literal: `outcome`/`ok` in the response describes
whether the **state transaction** committed, not whether the effect has succeeded yet.

## The outbox invariant

Effect intent is committed **atomically with the state write that requested it** —
`PersistenceAdapter.commit()` receives both `writes` and `effects` in the same call, and a
durable adapter persists them together. `createMemoryPersistence` and
`createSqlitePersistence` both implement the adapter's optional `loadPendingEffects()` /
`recordEffectAttempt()` pair, so a restarted authority resumes any intent that was
committed but never reached a terminal status — a crash between commit and the adapter
call does not lose the intent.

**Delivery is at-least-once, never exactly-once.** A resumed dispatch gets a fresh full
retry budget rather than picking up a partially-spent one, because a process that crashed
mid-call was never told whether its one call succeeded. This is why `idempotent: true` and
an `idempotencyKey` matter: a provider capable of deduplicating a retried call is what
turns at-least-once delivery into an effectively-once outcome.

## Retry

```ts
retry?: { policy: 'none' | 'fixed' | 'exponential'; maxAttempts?: number; delayMs?: number }
```

Declared on the `IntegrationOperationDef`, not on the calling action — retry is an
external-effect-execution concern, not business UI. `policy: 'none'` (the default) is one
attempt. `'fixed'` waits `delayMs` (default 1000ms) between attempts; `'exponential'`
doubles it each time. The wait uses the host's own scheduling
(`ServerHost.scheduleOnce`), so a test can drive it with `createDeterministicServerHost()`
+ `advance(ms)` and never wait on a real clock.

## Effect status and observability

```ts
type EffectDispatchStatus = 'pending' | 'running' | 'succeeded' | 'failed';

interface EffectRecord {
  id: string;
  operationId: NodeId;
  arguments: Record<string, unknown>;
  status: EffectDispatchStatus;
  attempts: number;
  lastError?: { code: string; message: string; retryable?: boolean };
  result?: unknown;             // the adapter's returned value, once succeeded
}

server.effectLog();   // EffectRecord[]
```

`server.effectLog()` is distinct from `server.mutationLog()` — an effect is not a state
mutation, and mixing the two would misrepresent what actually happened (spec §73). Host
`report()` events cover the whole lifecycle: `effect-requested`, `effect-attempted`,
`effect-succeeded`, `effect-failed`.

## The result reaches an action only through an event

An effect's outcome is never folded back into the transaction that requested it. Instead,
`succeededEventId`/`failedEventId` — ordinary `EventDef` nodes — are dispatched through
the same event pipeline an external webhook uses (see [`EVENTS.md`](EVENTS.md)), once the
outcome is known:

- **Success payload** is the effect operation's own `resultType` value — the adapter's
  returned result, unchanged.
- **Failure payload** is the error formatted as text, `"<code>: <message>"` — declare
  `failedEventId`'s `payloadType` as `primitiveType('string')` to receive it.

Both are checked against the declared `EventDef.payloadType` the same way any event is,
so a mismatched declaration is caught rather than silently dropped.

## No automatic compensation

0.8 does not implement compensation. If an effect has a semantic inverse, it is another
explicit action and effect — `refundPayment`, never `rollback(createPayment)`.

## Validation and diagnostics

| Code | Raised when |
| --- | --- |
| `UNKNOWN_EVENT` | `succeededEventId`/`failedEventId` naming something that is not an `EventDef`. |
| `EFFECT_FAILED` | An adapter reported failure after the retry policy was exhausted. |

Full tables: [`VALIDATION.md`](VALIDATION.md#integrations-effects-triggers-and-events),
[`AUTHORITY.md`](AUTHORITY.md#diagnostics).

## AgentAPI

```ts
agent.getEffectsForAction(actionId);   // IntegrationOperationDef[] — the effect-mode operations it calls
```

"What can this application do to an external system, and from where" is answerable without
reading source — spec §78's example question, made concrete.
