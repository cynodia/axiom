# Authority

Axiom 0.6.0-alpha.1. How an application crosses the trust boundary.

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
- `serverOnly: true` excludes the state from the client IR entirely. It is not merely unwritable; it is absent.

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
- It is bound **only where an authority evaluates**. Reading it in a derivation or a UI expression is `PRINCIPAL_REFERENCE_ON_CLIENT`.
- A rule that cannot be evaluated **denies**, exactly as an unevaluable constraint counts as violated.
- No `authorization` means every caller may invoke the action. An application with server state and no authorization anywhere gets a warning.
- `requiresConfirmation` is interaction, asked by the client. It is **not** an authorization mechanism and the authority never treats it as one.

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
`replayed: true`. The client runtime generates one per invocation automatically. Exactly-once
delivery is not assumed.

## The protocol

Transport-independent by construction. One endpoint, semantic requests:

```ts
{ kind: 'snapshot', protocol: 'axiom.protocol.v1', credential? }
{ kind: 'invoke',   protocol: 'axiom.protocol.v1', actionId, arguments?, credential?, requestId? }
```

```ts
{ kind: 'result',   ok, diagnostics, changes, revision, requestId?, replayed? }
{ kind: 'snapshot', snapshot: { revision, states } }
{ kind: 'error',    diagnostics }
```

No graph declares `POST /orders`. Transports:

| Adapter | Use |
| --- | --- |
| `createDirectTransport(server, { credential? })` | In-process. A whole client/authority test with no port. |
| `createHttpTransport({ url, credential?, timeoutMs? })` | The reference network transport. |

A later WebSocket, worker or IPC transport changes nothing in a graph.

## Observing authoritative state

The model is the simplest correct one: **request, decide, apply**.

```ts
const app = createAxiomRuntime({ ir, rootElement, host, remote: createRemoteGateway(transport) });
app.start();
await app.syncAuthoritativeState();     // load the authoritative snapshot
```

- A remote invocation returns `{ ok: false, pending: true }` immediately, so a click never blocks on the network. The outcome arrives later and is recorded through the ordinary action-outcome lifecycle — which is how a `diagnostic` node presents a *server* refusal exactly as it presents a local one.
- `invokeActionAsync(id, args)` awaits the answer, for tests and programmatic callers.
- The answer's `changes` are applied through the client's single write path, under the one flag that permits writing server-owned state.
- **Optimistic updates are not implemented.** There is no client-side rollback to get wrong.
- A derivation that depends only on observed state is recomputed locally rather than transferred.

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

```bash
node packages/cli/dist/index.js serve app.js --export=createGraph --port=3000 --store=state.db
```

One process serves the client page and the authority on one semantic endpoint. Nothing
application-specific is generated: no routes, no controllers, no handlers, no SQL. The
deployment artifact is the client page plus a serialized Server IR, executed by a generic
runtime.

```ts
const server = createAxiomServer({ ir: serverIR, persistence, host });
await server.start();
await serveOverHttp({ server, port: 3000 });
```

## Conformance

`@cynodia/axiom-server` ships `conformance/*.json`. Each fixture is pure data — a Server IR,
the state to start from, invocations, and expected results — covering expression evaluation,
guards, mutation, rollback, constraints, transition constraints, `for-each` provisional
writes, authorization, argument validation, persistence, restart, idempotency and concurrent
mutation.

Running them requires no part of this implementation. That is the point: the Server IR
specification plus these fixtures are the whole contract, so an independent runtime in
another language can be held to exactly the same standard.

## Not in 0.6

Stated plainly rather than left to discovery:

- **Read authorization per caller or per record.** Visibility is per state.
- **External effects.** A database write rolls back; an email does not. Nothing here makes an external side effect participate in a transaction, and `NativeOperation` MUST NOT be used to smuggle one in. A deliberate effect model — commands, a transactional outbox, idempotency — is future work.
- **Realtime synchronization**, subscriptions and collaboration. Request/response only.
- **Query semantics.** Authoritative collections are loaded into runtime state; large-data querying needs its own design.
- **Relational schema generation**, migrations and ORM behaviour.
- **Multi-node distributed execution.** Correctness is guaranteed within one authority process.
- **File storage, background jobs, scheduling.**
