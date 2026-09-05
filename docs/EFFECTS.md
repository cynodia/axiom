# Effects

Axiom 0.16.0-alpha.2. External effects are not rollback-capable state mutations. This file
is the delivery model; [`AUTHORITY.md`](AUTHORITY.md#external-effects) is the load-bearing
statement of why, and [`INTEGRATIONS.md`](INTEGRATIONS.md) is the operation vocabulary this
builds on.

Storage effects — `blob-commit` and `blob-delete` — ride this same outbox rather than a
second durability system; see [`STORAGE.md`](STORAGE.md).

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

**`IntegrationFailure.retryable: false` is control flow, not metadata.** It stops the
remaining retry policy immediately, regardless of `maxAttempts` — an adapter that always
answers `retryable: false` never retries at all, whatever `policy` says (spec 8.1 §73).

**The three states of `retryable` (spec 8.2 §38-39):**

| `retryable` | Meaning | Effect on the declared policy |
| --- | --- | --- |
| `false` | The adapter determined a retry cannot succeed. | Stops immediately — the remaining `maxAttempts` are never spent. |
| `true` | The adapter determined a retry may succeed. | Continues — the next attempt runs after the policy's delay. |
| absent | The adapter could not determine retryability either way. | Continues, exactly as `true` — an unknown answer is not treated as a refusal. |

`packages/server/test/effect-retry.test.ts` is the regression coverage for all three,
including a genuine multi-attempt retry sequence with a stable `idempotencyKey` across
every attempt.

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

**Exact status semantics (spec 8.2 §17-21):**

| Status | Means |
| --- | --- |
| `pending` | A durable effect intent exists (committed in the outbox), but no attempt is currently executing — either dispatch has not started yet, or it is waiting between retry attempts. |
| `running` | An adapter attempt has been started and has not yet settled. Set **before** `IntegrationAdapter.effect(...)` is called, synchronously with the durable `attempts` increment, so `effectLog()`'s public view reflects reality rather than lagging behind it. |
| `succeeded` | An attempt returned `{ ok: true }`. Terminal. |
| `failed` | Every attempt the retry policy allows was exhausted, or one returned `retryable: false`. Terminal. |

Before 8.2, `running` existed in the type but nothing updated `AxiomServer`'s in-memory
`effectLog()` view when an attempt actually started — a hung adapter call was
indistinguishable from an effect nobody had dispatched yet, both showing `status: 'pending',
attempts: 0` forever even though the adapter had genuinely been invoked. `attempts` counts
**invocation attempts started**, not merely attempts that settled — it increments at the
same moment `status` moves to `'running'`, before the adapter is called, so a hung attempt
is still counted. `packages/server/test/integrations.test.ts`'s hung-effect regression is
the test for this.

**Restart semantics for a `running` effect (spec 8.2 §20).** A record persisted as
`'running'` when the authority restarts means a previous process called the adapter and was
never told the outcome — that attempt is unaccounted for, not spent. It is treated as
resumable/unknown outstanding work: the resumed dispatch gets a **fresh** full retry budget
(local attempt count restarts at zero; the persisted `attempts` total still carries forward
honestly across the restart) rather than silently going idle at zero remaining attempts.
Axiom never claims to know whether the old process's call actually reached the provider —
only that at-least-once redelivery, paired with `idempotencyKey`, is what makes resuming it
safe.

**No runtime-enforced effect timeout in 0.8.2.** Unlike an `integration-query`'s
`timeoutMs` (deadline enforced by the runtime itself — see [`INTEGRATIONS.md`](INTEGRATIONS.md#timeout)),
a `running` effect attempt has no deadline: a non-cooperating adapter call can remain
`running` indefinitely, and nothing in this release will time it out or reclassify it. This
is a deliberate scope boundary, not an oversight (spec 8.2 §24) — see the note below for why.

**Research note: effect timeout is deferred, not merely unbuilt (spec 8.2 §25).** A future
effect timeout cannot safely map a timed-out attempt directly to `failed`: unlike a query,
an effect may have genuinely reached the provider and caused the external side effect
before the response was lost — declaring it `failed` could make an idempotent caller retry
a side effect that already happened once, and declaring it `succeeded` could be simply
wrong. The honest state that later work would need is something like `unknown` — distinct
from both terminal states — but that state is deliberately **not** introduced in 0.8.2. Do
not add a deadline just because `running` is now observable; effect timeout remains a
distinct future design topic.

## The result reaches an action only through an event

An effect's outcome is never folded back into the transaction that requested it. Instead,
`succeededEventId`/`failedEventId` — ordinary `EventDef` nodes — are dispatched through
the same event pipeline an external webhook uses (see [`EVENTS.md`](EVENTS.md)), once the
outcome is known, as a **structured envelope** (spec 8.1 §37-41):

```ts
import { EFFECT_ID_FIELD, EFFECT_OPERATION_ID_FIELD, EFFECT_RESULT_FIELD, effectOutcomeEntity } from '@cynodia/axiom-core';

graph.addNode(effectOutcomeEntity(ENTITY_EFFECT_OUTCOME, primitiveType('string')));   // the operation's resultType
graph.addNode<EventDef>({ id: EVENT_SUCCEEDED, kind: 'event', payloadType: entityType(ENTITY_EFFECT_OUTCOME) });
graph.addNode<EventDef>({ id: EVENT_FAILED, kind: 'event', payloadType: entityType(ENTITY_EFFECT_OUTCOME) });
```

One shape covers both outcomes — field ids are graph-global, so two entities could not both
declare `effectId`/`operationId`/`integrationId` without colliding:

| Field | Present on success | Present on failure |
| --- | --- | --- |
| `EFFECT_ID_FIELD` | always | always |
| `EFFECT_INTEGRATION_ID_FIELD` | always | always |
| `EFFECT_OPERATION_ID_FIELD` | always | always |
| `EFFECT_IDEMPOTENCY_KEY_FIELD` | when declared | when declared |
| `EFFECT_CORRELATION_ID_FIELD` | when the action's transaction has one | when the action's transaction has one |
| `EFFECT_RESULT_FIELD` | the operation's own `resultType` value | absent |
| `EFFECT_CODE_FIELD` | absent | the adapter's failure code |
| `EFFECT_MESSAGE_FIELD` | absent | the adapter's failure message |
| `EFFECT_RETRYABLE_FIELD` | absent | whether a retry might have succeeded |

A follow-up action correlates the outcome to the effect that caused it through
`EFFECT_ID_FIELD`/`EFFECT_OPERATION_ID_FIELD` — never by parsing text. Before 8.1, the
success payload was the raw `resultType` value with no envelope, and the failure payload
was a single formatted string `"<code>: <message>"`; an application still declaring
`primitiveType('string')` as either event's `payloadType` now fails validation, because the
dispatched value is always this entity shape.

Both are checked against the declared `EventDef.payloadType` the same way any event is,
so a mismatched declaration is caught rather than silently dropped.

**The full envelope, field by field (spec 8.2 §31-33):**

| Field | Present | Source, lifetime and stability |
| --- | --- | --- |
| `EFFECT_ID_FIELD` | always | The framework-generated id of this effect intent. Stable for the life of the intent (survives restart — it is what `EffectRecord.id` is keyed by), never consumer-settable. |
| `EFFECT_INTEGRATION_ID_FIELD` | always | The `IntegrationDef.id` the operation belongs to. Graph-static. |
| `EFFECT_OPERATION_ID_FIELD` | always | The `IntegrationOperationDef.id` invoked. Graph-static. |
| `EFFECT_IDEMPOTENCY_KEY_FIELD` | when the `integration-effect` operation declared one | Whatever the action's `idempotencyKey` expression evaluated to at commit time. Application-controlled, and the field the framework recommends for business correlation (below). |
| `EFFECT_CORRELATION_ID_FIELD` | when the committing action's transaction has one | See below — this is **not** a business correlation key. |
| `EFFECT_RESULT_FIELD` | success only | The operation's own `resultType` value, unwrapped from the adapter's `IntegrationSuccess.value`. |
| `EFFECT_CODE_FIELD` | failure only | The adapter's `IntegrationFailure.code`. |
| `EFFECT_MESSAGE_FIELD` | failure only | The adapter's `IntegrationFailure.message` — see the security note below before copying it into state. |
| `EFFECT_RETRYABLE_FIELD` | failure only | The adapter's `IntegrationFailure.retryable`, coerced to a boolean (`retryable === true`; both `false` and absent read as `false` here — the three-way distinction that matters for retry control flow is internal to the retry policy, not exposed on the terminal payload). |

Success and failure share this one envelope family — the always-present fields plus
`idempotencyKey`/`correlationId` when applicable — but they are **not symmetric**: success
never carries `EFFECT_CODE_FIELD`/`EFFECT_MESSAGE_FIELD`/`EFFECT_RETRYABLE_FIELD`, and
failure never carries `EFFECT_RESULT_FIELD`. Do not describe the two shapes as identical;
describe them as one family with disjoint success-only and failure-only fields.

**What `EFFECT_CORRELATION_ID_FIELD` actually is.** Its value is the internal Axiom
transaction id (`Transaction.id`, formatted like `tx_<n>`) of the action's transaction that
recorded the effect intent — the same id `RuntimeDiagnostic.transactionId` already carries
elsewhere. Concretely:

- **Source**: assigned by the runtime's own per-process transaction counter, never supplied
  or influenced by the application or the adapter.
- **Lifetime**: exists only as long as the process that created it is running.
- **Uniqueness scope**: unique only within one running authority process — it is not a
  globally unique identifier.
- **Stable across restart?** No. The counter resets when the authority restarts, so this
  value cannot be used to correlate an effect across a restart, or across two different
  authority processes.
- **Consumer-settable?** No — there is no way for a graph or an adapter to choose it.
- **Always present?** In practice yes, since every `integration-effect` operation only ever
  runs inside an action's transaction, and every transaction is assigned an id — but it is
  documented as conditional (`when the committing action's transaction has one`) because
  that is a property of the runtime's transaction model, not a graph-level guarantee this
  document freezes.

**Its string format (`tx_<n>`) is explicitly not part of the public contract** (spec 8.2
§27) — only its semantics are: "identifies the Axiom transaction that created this effect
intent, within this process's lifetime." A future implementation may change the format
without that being a breaking change, as long as the semantics hold.

**Business correlation guidance (spec 8.2 §28-30).** `EFFECT_CORRELATION_ID_FIELD` is an
**internal diagnostic aid**, not a business correlation key — it identifies "which
transaction" in this process, not "which order" or "which device" to a follow-up action.
**Effect outcomes do not automatically carry the original operation's arguments.** An
application that needs to correlate an outcome back to a specific business entity (which
order this reboot was for, which customer this notification was about) should use
`idempotencyKey` for that purpose when the value is naturally unique per business operation
(an order id, a reservation id) — it is already carried through to both the success and
failure envelope, application-controlled, and exists for exactly this shape of problem.
0.8.2 deliberately does **not** add a separate `correlationKey`/`correlationValue`
primitive: `idempotencyKey` already covers the common case cleanly, and a second field
whose only job is to avoid a documentation inconvenience was judged not worth the added
vocabulary (spec 8.2 §29-30). This may be revisited if a concrete use case proves
`idempotencyKey` alone is not conceptually clean enough — none has yet.

**Effect message security (spec 8.2 §33).** Framework diagnostics — anything Axiom itself
emits as a `RuntimeDiagnostic`/`ServerDiagnostic` — are sanitized according to
`DISCLOSABLE_DETAIL_KEYS` (see [`AUTHORITY.md`](AUTHORITY.md#diagnostics)) before crossing
the trust boundary. `EFFECT_MESSAGE_FIELD`/`EFFECT_CODE_FIELD` are different: they are
**application data**, populated verbatim from whatever `IntegrationFailure.message`/`.code`
the adapter returned, and dispatched into ordinary graph state through the event pipeline
like any other value. Once an application's own action copies an adapter's message into
state, **that application is responsible for what the message contains** — Axiom's
diagnostic sanitization does not reach into adapter-authored text. Never place a secret or
credential in an adapter's `IntegrationFailure.message`.

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
