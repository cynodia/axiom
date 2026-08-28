# Authority

Axiom 0.11.2-alpha.1. How an application crosses the trust boundary.

Until 0.5.x an Axiom application executed locally. 0.6 adds an **authority**: a generic
runtime that owns state, decides mutations and persists them. The same semantic graph
describes both halves, so there is no backend to write.

```text
                  ApplicationGraph
                         │
        ┌────────────────┴────────────────┐
   compileToIR                    compileToServerIR
        │                                 │
   Client runtime  ──semantic protocol──▶ Authority
        │                                 │
   presentation                    PersistenceAdapter
```

## Load-bearing server invariants

1. **AUTHORITY** — a client cannot commit server-authoritative state, by any path.
2. **EXECUTION** — a server action executes against state the authority owns, on the authority.
3. **TRUST** — a client's validation results, derived values and claims are never authoritative.
4. **TRANSACTION** — one semantic action commits atomically or not at all, wherever it runs.
5. **CONCURRENCY** — two actions cannot both commit from incompatible snapshots.
6. **PROTOCOL** — a client requests semantic actions, never mutation programs.
7. **SERIALIZATION** — authoritative behavior is data. No closure, no arbitrary code.
8. **REMOTE CLIENT BOOTSTRAP** — a client of a server-authoritative application is configured with a gateway *before* it starts. A generated page does this for itself; see [Running one](#running-one).
9. **STARTUP** — `start()` renders synchronously, then loads authoritative state. See [Startup](#startup).
10. **FORM SUBMIT** — a declared submit button invokes its action with exactly the arguments it declares, whether it is clicked or the form is submitted. See [UI](./UI.md#forms).
11. **IDEMPOTENCY** — an automatically generated request id is unique across runtime instances, whatever the host's uuid provider does. See [Idempotency](#idempotency).
12. **CHANGES** — `InvokeResponse.changes` names every observable state whose value moved, and no others. See [Observing authoritative state](#observing-authoritative-state).
13. **PORTABILITY** — `axiom.server.v1` semantics are language-independent, defined normatively by this document, the [schemas](#machine-readable-contracts) and the [conformance fixtures](#conformance). See [Server IR v1](#server-ir-v1-is-frozen).
14. **INTEGRATION** — external systems are accessed through typed integration operations, never through `NativeOperation` or a raw request embedded in the graph. See [External systems](#external-systems).
15. **QUERY** — an external query is explicit action/trigger execution, resolved before the transaction it feeds opens — never a pure `Expression`. See [External systems](#external-systems).
16. **EFFECT** — an external effect is not a rollback-capable state mutation. It is recorded as intent, and dispatched only after the transaction that requested it commits. See [External effects](#external-effects).
17. **OUTBOX** — effect intent is committed atomically with the state write that requested it, before the adapter is ever called. See [External effects](#external-effects).
18. **TRIGGER** — a trigger invokes an ordinary action, under the same guards, constraints, transition constraints and authorization any other caller is subject to. See [Triggers](#triggers).
19. **EVENT** — an event is a typed fact, validated against its declared payload type before any action sees it; an action is where work happens. See [External events](#external-events).
20. **SECRET** — integration credentials live in host configuration, never in `ApplicationGraph`. See [External systems](#external-systems).
21. **INVOCATION SOURCE** — a system-originated invocation (trigger, event, effect outcome) and an anonymous client request are distinct authoritative facts; a client cannot forge the former, and an action may restrict which it accepts independently of caller identity. See [Invocation source](#invocation-source).

## Authority and persistence are different questions

| | Asks | Declared by |
| --- | --- | --- |
| **Authority** | who may commit this value | `StateDef.authority` |
| **Persistence** | where a committed value survives | `StateDef.persistence`, and the adapter the authority runs with |

A server-authoritative state may live only in memory; a client-authoritative state may be
persisted to local storage. Do not conflate them.

```ts
{ id: STATE_PRODUCTS, kind: 'state', authority: 'server', valueType: … }   // the authority owns it
{ id: STATE_DRAFT,    kind: 'state', draft: true,        valueType: … }   // the client owns it
{ id: STATE_AUDIT,    kind: 'state', authority: 'server', serverOnly: true } // and the client never sees it
```

- `authority` defaults to `'client'`, so **every 0.5.x graph is unchanged** and still runs with no server at all.
- `serverOnly: true` excludes the state from the client IR entirely. It is not merely unwritable; it is absent. What that does and does not hide is spelled out under [What `serverOnly` hides](#what-serveronly-hides).

## Where an action executes

**Derived, never declared.** An action that writes any server-authoritative state is a
server action — following `for-each`, `invoke` and declared native effects. It cannot
disagree with what the action actually does.

```ts
agent.getActionAuthority(ACTION_PLACE_ORDER);   // 'server'
agent.getServerActions();
```

A server action is dispatched by the client, not executed by it: its operations, guards and
authorization are **absent** from the client IR.

## The trust boundary

The client is untrusted. The authority never trusts client state, client-derived values,
client constraint results, client permission checks, client presentation state, or any
claim that validation already happened.

| Attempt | Refused by |
| --- | --- |
| Bind an input into server state | `validateGraph` → `CLIENT_WRITE_TO_SERVER_STATE` |
| Write server state from the client at run time | the client store's single write path → `SERVER_STATE_WRITE` |
| Execute a server action locally | it has no operations in the client IR |
| Send mutation operations | the protocol has no such request |
| Forge an action id | resolved from the authority's own IR → `UNKNOWN_SERVER_ACTION` |
| Send an argument of the wrong shape | checked against the declared type → `ARGUMENT_TYPE_MISMATCH` |
| Invoke without permission | `authorization`, evaluated on the authority → `AUTHORIZATION_DENIED` |
| Invoke an action reachable only by a trigger, event or effect outcome | `invocation.allowedSources` → `INVOCATION_SOURCE_NOT_ALLOWED` |
| Claim to be a trigger, event or effect outcome | `context.source` is server-computed; no protocol field lets a request supply it |
| Read server-only state | it is not in the client IR, the snapshot or any answer |

## Invocation source

`authorization` answers *who* may invoke an action; invocation source answers *how the
invocation reached the authority at all* — a distinct question, because the two can diverge.
An action meant only as a webhook's target, or only as an `integration-effect`'s
`succeededEventId`/`failedEventId` handler, may declare no `authorization` at all — it was
never meant to need one, since only the trigger runtime was ever supposed to call it. Before
this existed, any client that guessed the action's id could invoke it directly, forging a
fake webhook delivery or a fake effect outcome (spec 8.1 §3-9).

```ts
{
  id: ACTION_APPLY_STATUS_CHANGE,
  kind: 'action',
  invocation: { allowedSources: ['system'] },   // a client InvokeRequest is refused
  operations: [ /* … */ ],
}
```

`allowedSources` is `['client', 'system']` — both — unless declared otherwise, so every
existing graph keeps its current behavior. `'system'` covers every trigger kind (interval,
delay, lifecycle, event) and every effect-outcome dispatch; there is no finer distinction,
because a trigger invokes an action "through the same semantics as any other caller"
([TRIGGER](#load-bearing-server-invariants)) and does not get a different one here either.

The source itself is `ExecutionContext.source`, computed by the authority and never read
from client-supplied protocol data — `InvokeRequest` and `EventRequest` carry no `source`
field to forge in the first place. A client request is always `'client'`; a trigger-, event-
or effect-outcome-originated invocation is always `'system'`, with `principal: null` exactly
as an anonymous client's is, so `authorization` still evaluates and cannot be bypassed by a
trigger either (spec §69,104) — invocation source and principal are deliberately separate
questions, and a system invocation is not a stand-in identity.

`checkInvocationSource` runs before `authorization`, before argument-driven work, and before
any transaction opens: a refusal changes nothing, commits nothing, and dispatches no effect
or event. `validateGraph` also catches the case a graph author can state statically — a
trigger targeting an action whose `allowedSources` excludes `'system'` could never succeed —
with `TRIGGER_TARGET_SOURCE_MISMATCH`.

## Server IR

```ts
const serverIR = compileToServerIR(graph);   // throws GraphValidationError if invalid
```

`ServerIR` is what an authority executes: entities, the state authoritative execution needs,
the server actions in full, constraints, transition constraints, the principal entity, and
which states a client may observe. It carries **no UI, no presentation, no theme and no
routes**, because none of that decides anything.

It is plain JSON — deterministic, closure-free, and specific to no language or host. It
declares a `contract`, and a runtime that does not recognize the value MUST refuse it rather
than interpret it partially. **The declared contract is the oldest one that can carry the
document**, computed from the document rather than asserted: see
[contract identifiers](#contract-identifiers).

Guards are normalized into aligned `preconditions` / `failureModes`, exactly as in the
client IR, so an authority that read one and not the other cannot silently skip a check.

## Client IR

`compileToIR` is authority-aware. From the same graph it produces the client's half:

| In the graph | In the client IR |
| --- | --- |
| A server-authoritative state | present, typed, with `initialValue` stripped — the authority owns the value |
| A `serverOnly` state | **absent**, along with any edge, constraint or transition rule that names it |
| A server action | its id, name, parameters and confirmation only — no operations, no guards, no failure modes, no authorization |
| `authority` | `ApplicationIR.authority`, so the client runtime refuses to write what it does not own |
| Server actions | `ApplicationIR.remoteActionIds`, so the runtime dispatches instead of executing |

Entity type declarations are shared: they are the schema, not the rules.

### What `serverOnly` hides

`serverOnly` is a statement about **values and behaviour**, not about the existence of a
vocabulary. Stated exactly, so nothing has to be inferred from the word "absent":

| | Hidden from the client? |
| --- | --- |
| The state's value | **yes** — not in the client IR, not in a snapshot, not in any `changes` map |
| The state's id | **yes** — the state does not appear in the client IR at all |
| The state's declared type, initial value, derivation, persistence | **yes**, with the state |
| A constraint or transition rule that reads the state | **yes** — stripped, and enforced only on the authority |
| An edge naming the state | **yes** |
| The **entity type** the state holds | **no**, when a client-visible state or action also uses that type |
| That entity's **field ids, names and types** | **no**, under the same condition |
| The **values** a rule was judging when it refused | **yes** — see below |

The exception is not an oversight: an entity type is a *schema*, shared by everything that
stores instances of it, and a client that renders one legitimately needs its fields. Stripping
the type would require proving no client-visible state or action reaches it, and a shared type
makes that proof fail. **A client can therefore learn that an entity has a field, and never
learn any value of it.** If the *shape* of a record is itself confidential, model it as a
separate entity that no client-visible state or action references — then it is stripped with
its state, and nothing is shared to keep.

`validateGraph` enforces the boundary at authoring time with `SERVER_ONLY_STATE_OBSERVED`:
anything a client evaluates that reads a `serverOnly` state is a validation error rather than
a runtime surprise.

**A diagnostic is the other way state could cross, and it does not.** A refusal is returned to
the caller, and a locally-evaluated one carries the record it was judging — a transition rule's
`previousValue` and `proposedValue`, for instance. An authority strips those: a diagnostic
leaving an authority keeps its code, its authored message and its *structural* details — which
rule, which record's identity, which guard by position — and carries **no state value**. The
list is a whitelist (`DISCLOSABLE_DETAIL_KEYS`), so a detail added later is withheld until
somebody decides it may cross, rather than disclosed until somebody notices.

An authored `message` is returned verbatim, because a refusal that cannot say why is not a
refusal a person can act on. Do not put a secret in one.

## Executing an action

The authority runs **the same semantic engine** the client runs. Transaction boundaries,
provisional writes, `for-each` ordering, constraint and transition evaluation, rollback and
the mutation log are not reimplemented, so a graph cannot behave differently merely because
execution moved.

```text
resolve the action from the authority's own IR   → UNKNOWN_SERVER_ACTION
authenticate the credential (host)
validate arguments against declared types        → ARGUMENT_TYPE_MISMATCH
evaluate authorization with PRINCIPAL bound      → AUTHORIZATION_DENIED
  ── nothing above opens a transaction ──
BEGIN TRANSACTION  (the ordinary Axiom lifecycle, unchanged)
COMMIT to persistence, atomically                → CONCURRENCY_CONFLICT
answer with diagnostics and authoritative changes
```

A refusal at any stage before the commit leaves authoritative state exactly as it was.

## Authentication and authorization

They are separate. **Authentication** — who is asking — is the host's business:

```ts
createServerHost({
  authenticate: (credential) => resolveUser(credential),   // → a PrincipalRecord, or null
});
```

Axiom 0.6 ships no authentication provider. **Authorization** — whether this caller may
perform this operation — is semantic:

```ts
graph.setPrincipalEntity(ENTITY_USER);

{
  kind: 'action',
  authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin')),
  …
}
```

- `PRINCIPAL` is bound to a record keyed by the **principal entity's field ids**, so a rule is written with the ordinary `field`/`ref` vocabulary. There is no separate policy language.
- A rule that cannot be evaluated **denies**, exactly as an unevaluable constraint counts as violated.
- No `authorization` means every caller may invoke the action. An application with server state and no authorization anywhere gets a warning.
- `requiresConfirmation` is interaction, asked by the client. It is **not** an authorization mechanism and the authority never treats it as one.

### Where `PRINCIPAL` resolves

`PRINCIPAL` is not an authorization-only construct. It resolves **wherever an authority
evaluates an expression**, which is load-bearing: it is how an authoritative record records
who caused it without a client ever being asked to say so.

| Scope | `PRINCIPAL` |
| --- | --- |
| An action's `authorization` | resolves |
| A guard on a server action | resolves |
| An operation's value expression, including inside `for-each` | resolves |
| A postcondition of a server action | resolves |
| A constraint or transition constraint evaluated on the authority | resolves |
| A derivation, a UI expression, a client-evaluated guard | **prohibited** — `PRINCIPAL_REFERENCE_ON_CLIENT` |

```ts
// An order records its own author. The client passes no user id, so it cannot claim one.
{ kind: 'insert', target: stateLocation(STATE_ORDERS), value: object(ENTITY_ORDER, [
  { fieldId: F_ORDER_PRODUCT,   value: ref(PARAM_PRODUCT) },
  { fieldId: F_ORDER_PLACED_BY, value: field(ref(PRINCIPAL), F_USER_ID) },
]) }
```

- **Client validation.** `validateGraph` rejects a `PRINCIPAL` reference anywhere a client evaluates, and rejects an `authorization` on an action no authority executes. The rule is caught at authoring time, not discovered at run time.
- **Anonymous callers.** When `authenticate` returns `null` there is no principal. `ref(PRINCIPAL)` resolves to nothing: `field(ref(PRINCIPAL), …)` is absent, `required(…)` over it is false, and an authorization rule comparing it to anything is false — so an anonymous caller is denied by any rule naming a principal attribute rather than passing by accident. An operation that writes an absent principal attribute into a `required` field refuses the transaction with `REQUIRED_FIELD_MISSING`; nothing half-attributed is ever committed.
- **Never disclosed.** `PRINCIPAL` is not in the client IR, not in a snapshot and not in any answer. Observability reports the caller's **identity field only**.

**Read authorization is not solved in 0.6.** Observability is per state
(`serverOnly` or not), not per caller and not per record. An application whose users must
see different rows of the same collection needs a mechanism this release does not provide.

## Persistence

```ts
interface PersistenceAdapter {
  load(): Promise<PersistedState[]>;
  commit(commit: PersistenceCommit): Promise<CommitOutcome>;
  revision(): Promise<number>;
  close?(): Promise<void>;
}
```

- A semantic transaction that writes several states MUST persist as **one unit**. An adapter must never apply a subset.
- `commit` carries the revision each written state had when the transaction began. A mismatch MUST refuse the commit rather than overwrite.
- Derived state is recomputed, never stored.

| Adapter | For |
| --- | --- |
| `createMemoryPersistence(seed?)` | Deterministic tests, conformance runs, experimentation. Implements the whole model, revision checks included. |
| `createSqlitePersistence({ location })` | The durable reference, on Node's built-in `node:sqlite`. |

State is stored in **document form** — one row per state, holding its serialized semantic
value and its revision. That is deliberate: 0.6 is about persistence semantics. Relational
projection, migrations and schema generation are future work, and no ApplicationGraph
mentions SQL.

## Concurrency

The authority **serializes** execution: one action at a time, and its commit completes
before the next begins. Within one process that alone prevents a lost update.

The revision check is the second layer, and the one that matters beyond a single process: a
commit whose expected revisions no longer hold is refused, in-memory state is restored to
what it was, and the caller receives `CONCURRENCY_CONFLICT`.

```text
stock 5 · caller A wants 4 · caller B wants 4  →  exactly one commits
```

Multi-node execution is not a 0.6 goal, but the interface does not preclude it: an adapter
backed by a shared store already refuses a stale commit.

## Idempotency

A network retry must not run an action twice.

```ts
{ kind: 'invoke', actionId, arguments, requestId: 'a-stable-key' }
```

The authority remembers recent request ids and answers a repeat from the record, marking it
`replayed: true`. Exactly-once delivery is not assumed.

**Records are scoped by principal.** The key is the caller's identity together with the
request id, not the request id alone. A request id is chosen by a client and is therefore not
a secret: were it the whole key, a caller who guessed another caller's id would be handed
that caller's answer. Anonymous callers share one scope, because there is nothing to tell
them apart — an application that needs replay isolation between anonymous callers has to
authenticate them.

**Generated ids are unique across clients.** The client runtime generates one per invocation,
combining a per-runtime session identity with the action, an ordinal and the host's uuid. The
session identity matters: a deterministic host — a memory host, a conformance host, a test
double — hands every runtime it constructs the same uuid sequence, and without something
above the host two clients would generate the same key for their first invocation and the
second would be answered as a replay of the first.

A client writing its own `requestId` is choosing its own retry identity and must make it
unique per intended transaction.

## The protocol

Transport-independent by construction. One endpoint, semantic requests:

```ts
{ kind: 'snapshot', protocol: 'axiom.protocol.v1', credential?, sinceRevision? }
{ kind: 'invoke',   protocol: 'axiom.protocol.v1', actionId, arguments?, credential?, requestId? }
{ kind: 'event',    protocol: 'axiom.protocol.v1', eventId, payload, credential? }
```

```ts
{ kind: 'result',       ok, diagnostics, changes, revision, requestId?, replayed? }
{ kind: 'snapshot',     snapshot: { revision, states, partial? } }
{ kind: 'error',        diagnostics }
{ kind: 'event-result', ok, diagnostics }
```

`event` (spec 0.8) is an **additive** request kind under the same `axiom.protocol.v1`
identifier, not a new protocol version: unlike a Server IR document, a protocol message
carries no document-wide vocabulary ceiling a receiver could silently misinterpret. A
pre-0.8 server's `isServerRequest` check already rejects an unrecognized `kind` as
malformed rather than misreading it as something else, so an older implementation degrades
safely without needing to know the new kind exists.

### `sinceRevision`

A snapshot request may name a revision the caller already holds. The answer is then
**partial**, and what it may leave out is a contract of its own:

| | |
| --- | --- |
| Omitted | Nothing. Every observable state is named. |
| Given | Every observable state the authority cannot **prove** unchanged since that revision: each stored state whose last committed revision is later, and every derived state. `partial: true`. |
| Ahead of the authority's own revision | The complete snapshot. A revision it never issued tells it nothing, and "nothing changed" would be a lie. |
| Not a non-negative integer | `MALFORMED_REQUEST`. |

A state absent from a partial snapshot is unchanged since the revision asked for. The reverse
does not hold: a state may be named without having moved. Derived states are always named,
because a derived value follows states the response may not even be permitted to disclose and
the authority will not guess. `snapshot.revision` is the authority's current revision either
way, so it is what the caller passes as the next `sinceRevision`.

No graph declares `POST /orders`. Transports:

| Adapter | Use |
| --- | --- |
| `createDirectTransport(server, { credential? })` | In-process. A whole client/authority test with no port. |
| `createHttpTransport({ url, credential?, timeoutMs? })` | The reference network transport. |

A later WebSocket, worker or IPC transport changes nothing in a graph.

## Startup

`start()` is the whole startup sequence, and it is the same three steps whether or not there
is an authority:

1. **Render**, synchronously, from the client IR's initial values. A page is on screen before any network call.
2. **Restore** persisted client state, where a state declares persistence.
3. **Load authoritative state**, when a gateway is configured — one snapshot request, applied through the ordinary write path, then one re-render.

`start()` returns a promise that settles when step 3 has settled. Awaiting it means "the page
is showing authoritative state"; not awaiting it means "the page is showing something", which
is a legitimate choice for a page that renders progressively.

```ts
const app = createAxiomRuntime({ ir, rootElement, host, remote });
await app.start();                      // rendered, restored, synchronized
app.authoritativeStateLoaded();         // true
```

Three things follow, and they are contract rather than implementation detail:

- **A gateway must be configured before `start()`.** Adding one afterwards does not retroactively synchronize; call `syncAuthoritativeState()` yourself.
- **A failed load is a diagnostic, not an exception.** The authority being unreachable reports `AUTHORITY_UNREACHABLE`, `start()` still resolves, the page still renders, and `authoritativeStateLoaded()` stays `false`. An empty authoritative collection and an unreachable authority are different situations and the runtime distinguishes them.
- **`syncAuthoritativeState()` is idempotent and may be called at any time.** It is what a refresh button does.

## Observing authoritative state

The model is the simplest correct one: **request, decide, apply**.

- A remote invocation returns `{ ok: false, pending: true }` immediately, so a click never blocks on the network. The outcome arrives later and is recorded through the ordinary action-outcome lifecycle — which is how a `diagnostic` node presents a *server* refusal exactly as it presents a local one. While it is outstanding, the control that started it renders `aria-busy` and refuses a second press; see [UI](./UI.md#pending-actions).
- `invokeActionAsync(id, args)` awaits the answer, for tests and programmatic callers.
- The answer's `changes` are applied through the client's single write path, under the one flag that permits writing server-owned state.
- **Optimistic updates are not implemented.** There is no client-side rollback to get wrong.
- A derivation that depends only on observed state is recomputed locally rather than transferred.

### What `changes` contains

**Every observable state whose value differs from what it was when the transaction opened,
and no others.** Difference is the criterion, not provenance:

| Situation | In `changes`? |
| --- | --- |
| A stored state the transaction wrote to a new value | yes |
| A stored state written back to the value it already held | no |
| A derived state whose recomputed value moved | yes, though no mutation named it |
| A derived state recomputed to the same value | no |
| A `serverOnly` state, however it changed | never — it is not observable |
| Any state, when the invocation was refused or rolled back | no: `changes` is empty |
| Any state, when the action committed nothing | no: `changes` is empty |

A replayed response carries the `changes` that were recorded for the original request, not a
freshly computed set.

## Diagnostics

Server codes join the same structured vocabulary; a client matches on `code` exactly as it
does for a local failure.

| Code | Meaning |
| --- | --- |
| `UNKNOWN_SERVER_ACTION` | The request named an action this authority does not execute. |
| `ARGUMENT_TYPE_MISMATCH` | An argument did not conform to its declared parameter type, or is not a parameter at all. |
| `AUTHORIZATION_DENIED` | The caller may not invoke this action, or the rule could not be evaluated. |
| `CONCURRENCY_CONFLICT` | Another transaction committed the same state first. Nothing was applied. |
| `MALFORMED_REQUEST` | The request was not an Axiom semantic request, or spoke an unknown protocol. |
| `AUTHORITY_UNREACHABLE` | The authority could not be reached, timed out, or answered with a transport error. |
| `EFFECT_FAILED` | An external effect's adapter reported failure after exhausting its retry policy. |
| `TRIGGER_INVOCATION_FAILED` | A trigger's target action reported failure, or its arguments failed to evaluate. |
| `EVENT_PAYLOAD_INVALID` | An external event's payload did not conform to its declared `EventDef.payloadType`. |
| `TRIGGER_OVERLAP_SKIPPED` | An interval trigger's tick fired while its previous invocation was still running, and the default `'skip'` overlap policy discarded it. |
| `INTEGRATION_ADAPTER_MISSING` | The Server IR requires an integration with no registered adapter — refused at `start()`, never deferred to first invocation. |
| `EVENT_DISPATCH_DEPTH_EXCEEDED` | An event → action → effect → event chain was stopped before it could recurse unboundedly. |
| `WEBHOOK_VERIFICATION_FAILED` | A webhook delivery failed provider signature verification and was refused before an event was ever constructed. |
| `SUBSCRIPTION_ADAPTER_MISSING` | The Server IR declares a subscription whose integration has no registered `SubscriptionAdapter`. Startup refuses, rather than leaving a declared live source permanently inactive. |
| `SUBSCRIPTION_START_FAILED` | A subscription's source could not be established, after every attempt its declared reconnect policy allows. |
| `SUBSCRIPTION_DELIVERY_DROPPED` | A delivery was discarded by a declared lossy backpressure policy. Loss is always declared and never silent. |
| `SUBSCRIPTION_DELIVERY_FAILED` | A delivery's triggered action failed after every permitted attempt. |
| `BLOB_STORE_MISSING` | The Server IR declares a `StorageDef` with no registered `BlobStorageAdapter`. |
| `BLOB_NOT_FOUND` | No object with that key, or the key names a still-staged upload. |
| `BLOB_ACCESS_DENIED` | The caller may not read, download or upload this object. Also the answer for a key that names nothing at all, so the endpoint is not an oracle for enumerating keys. |
| `BLOB_TOO_LARGE` | An upload exceeded the store's declared `maxSizeBytes`. |
| `BLOB_MEDIA_TYPE_REJECTED` | An upload's media type is not in the store's declared `acceptedMediaTypes`. |
| `BLOB_OPERATION_FAILED` | A `blob-commit` or `blob-delete` failed at the store, after its retry policy. |
| `INVOCATION_SOURCE_NOT_ALLOWED` | The action's `invocation.allowedSources` does not include this invocation's source (spec 8.1 §3-9) — refused before `authorization` is even evaluated, because no caller reaching the authority this way may invoke the action at all. |
| `QUERY_NOT_FOUND` | The `QueryRequest` named a `QueryDef` this authority does not execute. |
| `QUERY_ARGUMENT_TYPE_MISMATCH` | A query argument was missing, unknown, or did not conform to its declared `QueryParameter` type. Rejected before the provider is touched. |
| `QUERY_UNAUTHORIZED` | The caller may not run this query — reserved for a future explicit query-authorization rule; row visibility today is enforced by the read policy AND-ed into the filter, not by refusal. |
| `QUERY_CAPABILITY_UNSUPPORTED` | The configured `DataProvider` cannot push down a semantic this query requires, or the query's expression subset contains a leaf the provider cannot translate. Never approximated in memory. |
| `QUERY_CURSOR_INVALID` | The cursor was tampered with, truncated, or minted for a different query / principal / read policy / contract. Continuing from it is refused; nothing is disclosed. |
| `QUERY_PAGE_SIZE_EXCEEDED` | The requested page size exceeds the ceiling for this query (`min(QueryDef.pagination.maxPageSize, provider.maxPageSize)`). Refused, never silently truncated. |
| `QUERY_PROVIDER_FAILURE` | The provider reported a failure executing the query or applying a provider-record mutation. Carries no state value. |
| `QUERY_RESULT_TYPE_MISMATCH` | The provider returned rows that do not conform to the query's declared result shape. |
| `QUERY_PROVIDER_MISSING` | No `DataProvider` is registered for this query's source entity (`AxiomServerOptions.dataProvider` / `dataProviders`). |
| `SCHEMA_MIGRATION_REQUIRED` | Persisted canonical data is at an older semantic schema than the graph requires; a migration must run before the authority will serve traffic (spec11 §12). |
| `SCHEMA_INCOMPATIBLE` | Persisted data cannot be reconciled with the graph — a stored schema version ahead of the graph's, or no migration path to it. |
| `MIGRATION_IN_PROGRESS` | A migration is already running: a migration lock is held with a valid lease, by this instance or another (spec11 §66). |
| `MIGRATION_STATE_CORRUPTED` | The provider's stored migration metadata is internally inconsistent — a fingerprint or completed-step history that does not add up. |
| `MIGRATION_PATH_NOT_FOUND` | No contiguous `MigrationDef` chain connects the persisted schema version to the required one (spec11 §13). |
| `MIGRATION_APPROVAL_REQUIRED` | The plan contains destructive operations and the `executeMigration` call did not name them in `approveDestructive` (spec11 §21). |
| `MIGRATION_DESTRUCTIVE` | Reported by planning for each operation that discards persisted information — surfaced before execution (spec11 §20). |
| `MIGRATION_PROVIDER_UNSUPPORTED` | The configured provider cannot execute a capability the plan requires. Refused before any write (spec11 §79). |
| `MIGRATION_TRANSFORM_FAILED` | A migration transform expression threw, or produced a value that does not satisfy the target field. The target schema version was not committed. |
| `MIGRATION_VALIDATION_FAILED` | Post-migration validation found persisted data that does not satisfy the target semantic schema (spec11 §37). |
| `MIGRATION_CHECKPOINT_INVALID` | A resume was attempted from a checkpoint that does not match the current plan or schema fingerprint. |
| `MIGRATION_FINGERPRINT_MISMATCH` | The persisted schema fingerprint does not match the origin of the resolved migration path — the stored data is not the shape the chain expects. |
| `MIGRATION_NOT_AUTHORIZED` | The caller is not the host-minted migration capability. Naming a migration id over the client protocol does nothing; an object built with the capability's visible fields (or a spread copy of a real one) is rejected — authorization is by provenance, not shape (spec11 §73-74, spec11.1 §15-17). |
| `MIGRATION_FAILED` | A migration failed for a reason with no more specific code; the target schema version was not committed and the recovery state is defined. |
| `SCHEMA_IDENTITY_REQUIRED` | The provider's persisted metadata declares a semantic schema version, but the application graph declares none — so compatibility cannot be established. The gate fails closed rather than assuming the unversioned graph is safely compatible with schema 1 (spec11.1 §7). |
| `SCHEMA_METADATA_REQUIRED` | The application graph declares semantic schema evolution (a `schemaVersion` past 1, or any `MigrationDef`), but `createAxiomServer` was given no `migrationMetadata` store, so the startup gate could not run. Startup is refused rather than silently assuming compatibility (spec11.1 §8). |

**Migration execution is host-controlled.** `executeMigration()` is a standalone function,
not a `ServerRequest` branch — there is no path from a client through the semantic protocol
that runs a migration (spec11 §73). It requires a `MigrationPrincipal` minted by the host
with `migrationAuthority(grantedBy)`; a call without one is `MIGRATION_NOT_AUTHORIZED`.
Destructive operations additionally require each operation id in `approveDestructive`
(spec11 §21) — "a migration exists" is never "the operator approved data loss", and an
unapproved destructive migration performs **zero** writes (spec11 §106).

**Which correctness layers apply during a migration** (spec11 §37-40). Only **schema
conformance** — required fields present, identity present, declared field types — is checked,
at the target-record boundary, before the new schema version is committed
(`MIGRATION_VALIDATION_FAILED`). Entity `ConstraintDef`s are **not** evaluated during a
migration: a valid migration may pass through representations that are not valid application
states (spec11 §38), and the target record is what must be valid, expressed by the transform
itself. `TransitionConstraintDef`s are **never** applied to historical-data migration — a
migration is not a user edit and must not pretend to be one (spec11 §40). A host that needs
a business invariant re-checked after a migration does so by starting the authority and
running its own audit query.

Two client-side codes belong to the boundary as well:

| Code | Meaning |
| --- | --- |
| `SERVER_STATE_WRITE` | A local write was attempted against state the authority owns. It did not occur. |
| `REMOTE_ACTION_UNAVAILABLE` | A remote action was invoked with no gateway configured, or the transport failed. |

A network failure becomes a diagnostic, never an exception escaping into application code.

## Observability

```ts
createServerHost({ report: (event) => log(event) });
```

Every invocation reports its kind, action, the caller's **identity field only**, request id,
outcome, duration, revision, diagnostics and the states it committed. No application
implements logging of its own.

## Running one

One graph, one process: the generated page and the authority that answers it.

```ts
import { compileToHtml, compileToServerIR } from '@cynodia/axiom-compiler';
import { createSqlitePersistence, serveAxiomApplication } from '@cynodia/axiom-server';

const graph = createApplicationGraph();
const running = await serveAxiomApplication({
  serverIR: compileToServerIR(graph),
  page: compileToHtml(graph),
  persistence: await createSqlitePersistence({ location: 'app.db' }),
  authenticate: (credential) => resolveUser(credential),
  port: 3000,
});
// running.pageUrl → http://127.0.0.1:3000/
```

`GET /` is the page and `POST /axiom` is the semantic endpoint, for every Axiom application
there will ever be. No application defines a route, a verb, a controller, a handler or a line
of SQL, and the page needs no JavaScript of its own: `compileToHtml` wires the browser-safe
gateway into the generated bootstrap whenever the IR contains a remote action.

To point a page somewhere else, or to switch the gateway off for an application that has no
authority:

```ts
compileToHtml(graph, { remote: { endpoint: 'https://api.example.com/axiom' } });
compileToHtml(graph, { remote: false });
```

The two halves also run separately. `serveOverHttp({ server, port })` is the bare authority,
and `createAxiomServer({ ir, persistence, host })` is the authority with no transport at all —
which is what `createDirectTransport` drives in tests.

**There is no published Axiom CLI.** `packages/cli` is a private development tool of this
repository and is not on npm; the API above is the supported way to run an application.

## Conformance

`@cynodia/axiom-server` ships `conformance/*.json`. Each fixture is pure data — a Server IR,
the state to start from, invocations, and expected results — covering expression evaluation,
guards, mutation, rollback, constraints, transition constraints, `for-each` provisional
writes, authorization, argument validation, persistence, restart, idempotency and concurrent
mutation.

Running them requires no part of this implementation. That is the point: the Server IR
specification plus these fixtures are the whole contract, so an independent runtime in
another language can be held to exactly the same standard.

**A public reference runner is exported for the TypeScript reference runtime itself**
(spec 8.2 §14-16):

```ts
import { runConformanceFixture, runConformanceSuite } from '@cynodia/axiom-server';

const result = await runConformanceFixture(fixtureJson);   // { name, ok, failures[] }
```

It imports only `@cynodia/axiom-server` and fixture data — no graph, no compiler, no
builder — and reports structured pass/fail rather than throwing on an ordinary fixture
mismatch. `packages/server/test/conformance.test.ts` runs every shipped fixture through
this exact function, and `npm run conformance:run` (`scripts/run-conformance.mjs`) runs the
whole suite from a standalone script using nothing but this public API and the manifest —
the "held to the same standard by an outside caller" claim, demonstrated rather than
asserted. The fixture **model** (`ConformanceFixture` and friends, `conformance-types.ts`)
is deliberately kept separate from this **adapter**
(`conformance-runner.ts`): a non-TypeScript implementation needs only the model's shape and
the semantics on this page, never this file.

Enumerate the suite from its manifest rather than by listing a directory:

```
@cynodia/axiom-server/conformance            → the manifest
@cynodia/axiom-server/conformance/<name>.json → one fixture
```

The manifest carries three **separate, non-overlapping** version concepts (spec 8.2 §9-10;
do not conflate them under one "contract" name):

| Field | Means |
| --- | --- |
| `manifest.conformance` | The **fixture-format** version (`axiom.conformance.v1`/`v2`) — the shape of the JSON documents themselves: what top-level keys a fixture may have (`invocations` vs `steps`/`externalAdapters`, and so on). |
| `manifest.baseContract` | The **oldest** Server IR contract any fixture in this manifest may use — `axiom.server.v1`, always, since new fixtures are added without ever raising this floor. It does **not** describe what the newest fixture needs. |
| `manifest.fixtures[].contract` | The Server IR contract **that specific fixture** requires — this is what is authoritative for what running it needs. The suite ships fixtures spanning `v1` through `v4` simultaneously, each correctly labelled. |
| `manifest.release` | The `@cynodia/axiom` package version this snapshot of the suite shipped with — unrelated to either version above. |

Before 8.2 the manifest's top-level field was named `contract` and fixed at
`axiom.server.v1`, which read as a claim about the whole suite even after `v3`/`v4`
fixtures were added; it is now named `baseContract` with the meaning above, precisely
because per-fixture `contract` is what is actually authoritative. A runtime that does not
implement a contract a fixture names should refuse that fixture rather than discover the
mismatch mid-assertion. The files are plain JSON in a documented package directory, so a
non-JavaScript consumer can read them straight out of the tarball without Node's module
resolver.

Every fixture is executed against the reference runtime by this repository's own test suite,
and its expectations are exhaustive — a fixture that says which states changed must name all
of them and no others. No fixture is permitted to disagree with the shipped runtime.

## Machine-readable contracts

```
@cynodia/axiom-server/schema/server-ir.v1.schema.json
@cynodia/axiom-server/schema/server-ir.v2.schema.json
@cynodia/axiom-server/schema/server-ir.v3.schema.json
@cynodia/axiom-server/schema/server-ir.v4.schema.json
@cynodia/axiom-server/schema/protocol.v1.schema.json
```

JSON Schema for the Server IR and for the wire protocol, so an implementer is not reading
TypeScript declarations to find out what a document may contain. They are generated from the
runtime's own vocabulary — expression kinds, built-in functions, operation kinds — so they
cannot drift from what the runtime implements, and every shipped fixture is validated against
them.

They describe **structure**. What a conforming runtime must *do* with a valid document is this
page plus the conformance fixtures.

## Contract identifiers

| Contract | Adds | Since |
| --- | --- | --- |
| `axiom.server.v1` | the frozen 0.6.1 contract, below | 0.6.1 |
| `axiom.server.v2` | the expression kinds `group` and `expression-ref`, and the `expressionDefs` they resolve against | 0.7.0 |
| `axiom.server.v3` | integrations, integration operations, events, triggers, and the `integration-query`/`integration-effect` operation kinds | 0.8.0 |
| `axiom.server.v4` | `ActionDef.invocation.allowedSources` invocation-source restriction, and the structured effect-outcome envelope (`effectOutcomeEntity`, `EFFECT_ID_FIELD` and its sibling reserved fields) that every effect dispatch uses from 8.1 onward | 0.8.1 |
| `axiom.server.v5` | `SubscriptionDef` and `StorageDef`, and the `blob-metadata`/`blob-commit`/`blob-delete` operation kinds — the inbound external-I/O direction and binary object storage | 0.9.0 |
| `axiom.server.v6` | `QueryDef`, `RelationshipDef` and `ReadPolicyDef`, the `query` operation kind, and the `provider-record` location — the semantic data-access & query layer over large authoritative datasets | 0.10.0 |
| `axiom.server.v7` | `MigrationDef` and the closed migration-operation vocabulary, plus the top-level `schemaVersion` and `schemaFingerprint` fields — semantic schema evolution over persisted canonical data | 0.11.0 |

`SERVER_IR_CONTRACTS` enumerates all seven, and is the single source of truth this table is
tested against — `packages/demo/test/documentation.test.ts` fails if a contract in
`SERVER_IR_CONTRACTS` has no row here, or a row here names a contract the code does not
declare (spec 8.2 §7-8). The rules:

- **A document declares the oldest contract that can carry it.** `compileToServerIR` computes the label from the vocabulary the document actually uses, so an application that uses nothing from 0.7 or 0.8 produces a byte-identical `axiom.server.v1` document, and the committed v1 conformance fixtures are unchanged. `usesV4Semantics` computes the v4 case specifically: an action's `invocation.allowedSources` genuinely restricting the default two-source set, or any `integration-operation` with `mode: 'effect'` (since every effect dispatch uses the structured v4 envelope) — a document that merely mentions `invocation` without restricting it only needs `axiom.server.v2`, the same tier `group`/`expression-ref` occupy.
- **A runtime MUST refuse a contract it does not implement**, and MUST refuse a document whose vocabulary exceeds its declared contract. A v2 runtime executing a v1-labelled document that uses `group` would accept what a conforming v1 runtime elsewhere refuses, and the two would then disagree about the same file. `createAxiomServer` raises rather than executing one — including refusing a document that **understates** its own contract (`understatedContract`).
- **A frozen contract gains nothing.** `axiom.server.v1` does not contain `group`, `expression-ref`, `expressionDefs`, an integration, a trigger, an event, the `integration-query`/`integration-effect` operation kinds, `invocation`, or the structured effect-outcome envelope, and `server-ir.v1.schema.json` is byte-frozen. Vocabulary arrives under a new identifier or not at all.
- **`axiom.server.v6` is the latest contract as of 0.10.0** (`SERVER_IR_LATEST_CONTRACT`). `usesQueryVocabulary` computes it from the document: any `queries`, any `relationships`, any `readPolicies`, or any `query` operation. It is incompatible rather than additive for the same reason every prior tier is — a v5 runtime that ignored `queries` would accept an application that promises demand-driven, read-authorized, paginated access to a large dataset and silently execute none of it, and one that ignored a `provider-record` mutation would silently skip a canonical write. Both are the divergence a label exists to prevent.

There is one JSON Schema per contract, each generated from the runtime's own vocabulary and
each shipped: `server-ir.v1.schema.json`, `server-ir.v2.schema.json`, `server-ir.v3.schema.json`,
`server-ir.v4.schema.json`, `server-ir.v5.schema.json`, `server-ir.v6.schema.json`,
`server-ir.v7.schema.json`.

**`SubscriptionDef`, `StorageDef` and the blob operations.** Their normative semantics —
lifecycle states and transitions, at-least-once delivery, per-subscription ordering and the
explicit absence of cross-subscription ordering, bounded queues and every backpressure policy,
deduplication and its restart durability, poison-delivery bounds, staged-then-committed object
lifecycle, and the authorization rule a store evaluates before serving a byte — are documented
in [`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md) and [`STORAGE.md`](STORAGE.md), and are executable in
the `subscription-*` and `blob-*` conformance fixtures. An independent implementer needs those
two documents, the v5 schema and those fixtures, and no TypeScript.

**`group`.** Partitions a collection: `Collection<A>` → `Collection<Group<K, A>>`. Groups appear
in the order their key was **first seen** in the source; members keep source order; two keys are
the same key when they are **structurally** equal; an empty source produces no groups; a `null`
source fails the evaluation as every collection operator does. Nothing is sorted. A group is a
record carrying the two reserved field ids `field_group_key` and `field_group_items`, and no
entity may declare either.

**`expression-ref`.** Evaluates a named `ExpressionDef` from `expressionDefs`. Arguments are
evaluated in the calling scope; the body is evaluated in an **isolated** scope binding the
definition's parameters and application state and nothing else. Every declared parameter MUST be
supplied. A definition that reaches itself is invalid and MUST be refused rather than executed.

## Server IR v1 is frozen

`axiom.server.v1` is a stable semantic contract as of 0.6.1. A runtime may depend on the
semantics below exactly as written; a change that breaks them requires a new contract
identifier, not a new version number.

**Numbers.** Every numeric value is an IEEE-754 binary64 (double-precision) value, and every
arithmetic operator (`add`, `subtract`, `multiply`, `divide`) is the corresponding IEEE-754
operation. Ordered comparisons against a value that is not a number are **false**, both ways —
so a guard over a computation that failed refuses rather than passing on a value it could not
compute. `sum` over an empty collection is `0`. Integer-valued doubles are not a separate
type; there is no integer type and no decimal type in this contract.

**Text.** `to-string` of a number is its shortest round-tripping decimal form, without digit
grouping and without a locale. `lowercase` is the Unicode default case conversion, unconditional
and locale-independent. Text ordering — in `sort`, and in `compareValues` wherever two
non-numeric values are ordered — is **lexicographic by Unicode code point**. Not locale
collation, and not UTF-16 code-unit order: the two disagree whenever a string mixes astral
characters with U+E000–U+FFFF, and code points are the ordering every language can reproduce.

**Host values.** `now()` and `uuid()` are the only two places semantics may depend on something
outside the graph, and their production values are the host's. For conformance the host is
pinned: one counter shared by both, starting at zero and incremented before each value, so the
nth host call in an execution is `id-<n>` or `2026-01-01T00:00:<n>.000Z` whichever it was. A
runtime in another language reproduces this by counting host calls in execution order. The
counter is per host instance; a restart does not rewind it.

**Serialization.** A Server IR document is JSON and nothing else. It MUST NOT contain
`undefined`, a function, a closure, `NaN`, `Infinity`, a `BigInt`, a host object, a `Date`, a
`RegExp`, or an instance of a class that needs its prototype to be understood. It must survive
a parse/serialize round trip unchanged. Record key order is not significant and MUST NOT be
relied upon.

**Diagnostics.** The codes in the table above are public vocabulary and are frozen: a
conforming runtime reports these codes, with these meanings, and the fixtures assert on them.
The details a diagnostic may carry across the boundary are the whitelist described under
[What `serverOnly` hides](#what-serveronly-hides).

**Authorization.** An `authorization` expression is an ordinary expression evaluated on the
authority with `PRINCIPAL` bound, before any guard and before any transaction opens. There is
no policy language, no rule engine and no evaluation order beyond that.

**Persistence is not part of the contract.** `PersistenceAdapter` is how an authority keeps
what it decided; nothing about *which* adapter is in use changes what a graph means. A
conforming runtime may store state any way it likes, provided a semantic transaction persists
as one unit and a stale revision refuses the commit.

**Concurrency.** An authority serializes execution: one action at a time, its commit complete
before the next begins. A conforming runtime may execute concurrently only if the observable
result is identical to some serial order. Across processes, correctness rests on the
persistence adapter's revision check — the contract guarantees that a commit from a stale
snapshot is refused, not that two processes coordinate.

## External systems

0.8 adds a typed boundary to systems Axiom does not own: an `IntegrationDef` names a
capability domain (a shipping provider, a device fleet), and an `IntegrationOperationDef`
names one typed operation of it, with a declared `mode: 'query' | 'effect'`. The graph
never mentions an SDK, a host name, an HTTP client or a secret — those are supplied by an
`IntegrationAdapter`, registered with the authority (`AxiomServerOptions.integrations`),
keyed by integration id. **Integrations default server-only** (secrets, trust, CORS,
auditability, deterministic authority): an operation is client-invokable only if it
declares `clientSafe: true`, and client safety is never inferred from the absence of a
declared secret.

**A missing adapter fails `start()`, not the first invocation.** Every integration a
document requires is checked against the registry before any request is accepted
(`INTEGRATION_ADAPTER_MISSING`).

**A query is explicit execution, never a pure `Expression`.** An `integration-query`
operation calls its adapter and binds the (type-checked) result into scope as
`ref(bindAs)`, resolved **before the transaction opens** — ahead of guards, so a query
never runs mid-transaction and a guard can never reference its result. A malformed
provider response is rejected at this boundary (`INTEGRATION_RESULT_INVALID`) rather than
handed to the application as `unknown`. Full model: `docs/INTEGRATIONS.md`.

## External effects

**An external effect is not a rollback-capable state mutation**, and 0.8 does not pretend
otherwise (spec §15,16). Axiom can roll back a state write; it cannot roll back an email,
a payment or a shipment request.

Reaching an `integration-effect` operation only **records intent** — appended to the same
per-transaction log a mutation is, and discarded on rollback the same way. The adapter is
never called during the transaction. Only once the transaction **commits** — effect intent
persisted atomically with the state write that requested it, the transactional outbox
invariant — does an `EffectRunner` dispatch it, and the response the caller receives never
waits for that: "action committed, effect pending," not "action committed and its effect
succeeded." A `PersistenceAdapter` that implements `loadPendingEffects`/
`recordEffectAttempt` (both shipped adapters do) resumes any intent that was committed but
never reached a terminal status, so a crash between commit and dispatch does not lose it —
**at-least-once delivery**, not exactly-once. Effect operations may declare `idempotent:
true` and a `retry` policy (`'none' | 'fixed' | 'exponential'`); an idempotency key,
computed from `idempotencyKey`, is handed to the adapter on every attempt so a provider can
deduplicate a retried call.

An effect's outcome is never folded back into the transaction that requested it. Instead,
its declared `succeededEventId`/`failedEventId` — an ordinary `EventDef` — is dispatched
through the same event pipeline an external webhook uses, once the outcome is known. There
is no automatic compensation: a semantic inverse (`refundPayment`) is another explicit
action, never an implicit `rollback(createPayment)`. Full model: `docs/EFFECTS.md`.

## Triggers

A `TriggerDef` says **when** an action should be invoked — `interval`, `delay`,
`lifecycle` (`application-start`, `runtime-ready` on the server; `route-enter`,
`route-leave` on the client) or `event` — without embedding callback code. **A triggered
action runs through exactly the same semantics any other caller does**: the same guards,
constraints, transition constraints and authorization. There is no weaker, trigger-specific
execution path.

Timed and event triggers whose target action is server-authority run **on the authority**,
continuing whether or not a browser is connected; `application-start`/`runtime-ready`
triggers run once, in startup order, before requests are accepted (see
[Startup](#startup)). An interval trigger's default overlap policy is `'skip'`: a tick that
fires while the previous invocation is still running is discarded, not queued and never run
concurrently (`TRIGGER_OVERLAP_SKIPPED`); `'queue'` runs one pending tick immediately after.

**Timed and event-originated invocations run under a system context, never an impersonated
user.** `ExecutionContext.principal` is `null` — exactly what an anonymous client request's
is — and `.source` is `'system'`, carried only for observability. Authorization still
evaluates against that; it is never bypassed. An action whose authorization rule can never
be satisfied by a `null` principal is correctly refused when a trigger invokes it — the
graph decides, by declaring authorization or not on the actions it targets. Full model:
`docs/TRIGGERS.md`.

## External events

An `EventDef` is a typed fact — a webhook delivery, an effect's outcome — never work
itself; a `TriggerDef{when:{kind:'event'}}` is what says what happens next. The semantic
protocol's `EventRequest` (`kind: 'event'`) carries only `eventId` and `payload`; the
payload is validated against `EventDef.payloadType` **before any action sees it**
(`EVENT_PAYLOAD_INVALID` otherwise) — malformed input never reaches trusted code.

**Provider authenticity is verified before an event is even constructed.** A webhook route
is registered on the Node host (`serveOverHttp({ webhooks })`), never declared by the
application: `verify` runs over the raw request first, and an unverified delivery never
reaches `decode` or the semantic layer. A provider `deliveryId`, when supplied, is
deduplicated against a bounded recent-deliveries window per route — a duplicate within that
window is acknowledged without dispatching the event again, with no claim of durable,
unbounded deduplication.

**Event dispatch is depth-guarded**, so a cycle (an event whose triggered effect's own
success re-fires it) is stopped rather than recursing unboundedly
(`EVENT_DISPATCH_DEPTH_EXCEEDED`, `MAX_EVENT_DISPATCH_DEPTH` dispatches deep). Full model:
`docs/EVENTS.md`.

## Not in 0.8.0

Stated plainly rather than left to discovery:

- **Generated values cannot be bound within an action, in general.** An operation cannot name a value an earlier operation produced: `uuid()` evaluated in one `insert` cannot be referred to by a later `insert` in the same action. Give the record an identity the action already has — a parameter, or a field of something it read — or perform the second write in a second action. 0.8 adds exactly one narrow, purpose-built exception: an `integration-query`'s `bindAs` result, resolved before the transaction opens (see [External systems](#external-systems)) — not a general operation-result binding mechanism.
- **Read authorization per caller or per record.** Visibility is per state.
- **Absolute/cron schedules.** `interval` and `delay` triggers cover "every N milliseconds" and "once after N milliseconds"; a calendar schedule ("every day at 09:00") is not modeled.
- **Client-side execution of interval, delay and lifecycle triggers.** The browser runtime implements no trigger kind at all. Before spec 8.1 a client-authority trigger silently compiled into `ApplicationIR.triggers` and simply never fired; now `validateGraph`/`compileToIR` reject it with `CLIENT_TRIGGER_UNSUPPORTED` instead, so the gap is a compile-time error rather than a runtime discovery. Only the authoritative runtime executes triggers today.
- **Durable effect delivery beyond the two shipped `PersistenceAdapter`s.** At-least-once delivery across a restart is real for `createMemoryPersistence` (within the process) and `createSqlitePersistence`; a third adapter earns the same claim only by implementing `loadPendingEffects`/`recordEffectAttempt` itself.
- **Realtime synchronization**, subscriptions and collaboration. Request/response only.
- **Query semantics.** Authoritative collections are loaded into runtime state; large-data querying needs its own design.
- **Relational schema generation**, migrations and ORM behaviour.
- **Multi-node distributed execution.** Correctness is guaranteed within one authority process.
- **File storage, background worker fleets, a general job queue, a saga engine, a workflow language.** Effects and triggers are deliberately not a distributed job system (spec §2).
