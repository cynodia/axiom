# Authority

Axiom 0.6.2-alpha.1. How an application crosses the trust boundary.

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
| Read server-only state | it is not in the client IR, the snapshot or any answer |

## Server IR

```ts
const serverIR = compileToServerIR(graph);   // throws GraphValidationError if invalid
```

`ServerIR` is what an authority executes: entities, the state authoritative execution needs,
the server actions in full, constraints, transition constraints, the principal entity, and
which states a client may observe. It carries **no UI, no presentation, no theme and no
routes**, because none of that decides anything.

It is plain JSON — deterministic, closure-free, and specific to no language or host. It
declares `contract: 'axiom.server.v1'`, and a runtime that does not recognize the value MUST
refuse it rather than interpret it partially.

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
```

```ts
{ kind: 'result',   ok, diagnostics, changes, revision, requestId?, replayed? }
{ kind: 'snapshot', snapshot: { revision, states, partial? } }
{ kind: 'error',    diagnostics }
```

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

Enumerate the suite from its manifest rather than by listing a directory:

```
@cynodia/axiom-server/conformance            → the manifest
@cynodia/axiom-server/conformance/<name>.json → one fixture
```

The manifest names the contracts the fixtures are written against (`axiom.conformance.v1`,
`axiom.server.v1`, `axiom.protocol.v1`), the release, every area covered, and every fixture
with its file. A runtime that does not implement a contract the manifest names should refuse
the suite rather than discover the mismatch one assertion at a time. The files are plain JSON
in a documented package directory, so a non-JavaScript consumer can read them straight out of
the tarball without Node's module resolver.

Every fixture is executed against the reference runtime by this repository's own test suite,
and its expectations are exhaustive — a fixture that says which states changed must name all
of them and no others. No fixture is permitted to disagree with the shipped runtime.

## Machine-readable contracts

```
@cynodia/axiom-server/schema/server-ir.v1.schema.json
@cynodia/axiom-server/schema/protocol.v1.schema.json
```

JSON Schema for the Server IR and for the wire protocol, so an implementer is not reading
TypeScript declarations to find out what a document may contain. They are generated from the
runtime's own vocabulary — expression kinds, built-in functions, operation kinds — so they
cannot drift from what the runtime implements, and every shipped fixture is validated against
them.

They describe **structure**. What a conforming runtime must *do* with a valid document is this
page plus the conformance fixtures.

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

## Not in 0.6.2

Stated plainly rather than left to discovery:

- **Generated values cannot be bound within an action.** An operation cannot name a value an earlier operation produced: `uuid()` evaluated in one `insert` cannot be referred to by a later `insert` in the same action. Give the record an identity the action already has — a parameter, or a field of something it read — or perform the second write in a second action. A semantic binding for this (`bindAs` on an operation, `ref` to it later) needs a lexical lifetime, a type, `for-each` and nested-invoke semantics, serialization and dependency analysis all decided together; doing that hastily would weaken a contract that is now frozen, so it is deferred to 0.7.
- **Read authorization per caller or per record.** Visibility is per state.

- **External effects.** A database write rolls back; an email does not. Nothing here makes an external side effect participate in a transaction, and `NativeOperation` MUST NOT be used to smuggle one in. A deliberate effect model — commands, a transactional outbox, idempotency — is future work.
- **Realtime synchronization**, subscriptions and collaboration. Request/response only.
- **Query semantics.** Authoritative collections are loaded into runtime state; large-data querying needs its own design.
- **Relational schema generation**, migrations and ORM behaviour.
- **Multi-node distributed execution.** Correctness is guaranteed within one authority process.
- **File storage, background jobs, scheduling.**
