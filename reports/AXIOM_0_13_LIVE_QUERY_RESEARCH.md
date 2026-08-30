# Axiom 0.13 — Realtime / Live Canonical Queries: design note

Resolves the spec13 §185 design decisions and the §§6, 11, 55, 85, 145, 151 gates before
implementation. Baseline: `0.12.1-alpha.1`.

---

## 1. Is new graph vocabulary required? — **No.** (§5, §6, §148)

Live capability is an **execution mode over the existing `QueryDef` IR**, not a new node
kind. The application meaning ("the rows matching this query") already lives in `QueryDef`.
`LiveQueryDef` / `WatchQueryDef` / a `live: true` graph flag are **not** added.

What *is* added is analysis, not vocabulary: the compiler/AgentAPI classify a `QueryDef` as
`live-capable`, `live-capable-reset-only`, or `not-live-capable(reason)` from its existing
semantics (determinism, stable row identity, bounded result). This classification is
inspectable; it never rejects a graph unless the graph already fails 0.10 validation.

No transport vocabulary (`websocket`, `connection-id`, `broadcast`, `room`, `topic`) enters
the graph.

## 2. Does Server IR remain v7? — **Yes.** (§151)

Live is a pure execution mode over `QueryDef`. The portable runtime needs no new semantic
field to know "live-specific meaning": determinism, identity and boundedness are all already
derivable from the `QueryDef` + entity + policy IR a v7 document carries. `axiom.server.v7`
is retained; a distributed live graph compiles to the byte-identical document it always did.

## 3. Logical live-query identity (§7, §8)

```
LiveQueryIdentity = {
  queryId,
  argumentsFingerprint,          // canonical fingerprint of resolved parameters
  principalFingerprint,          // canonical fingerprint of the principal record (or 'anon')
  policyFingerprint,             // canonical fingerprint of the effective ReadPolicy predicate
  compatibilityFingerprint,      // { serverContract, schemaFingerprint, semanticFingerprint }
}
```

plus a runtime-minted `subscriptionId` (a uuid) that distinguishes two *intentional*
independent subscriptions to the same semantic query. Identity is independent of authority
instance, physical connection, socket, reconnect and process restart. A physical connection
ID is never semantic identity — `LogicalLiveQuery` ≠ `PhysicalDeliveryConnection`.

## 4. What exactly is persisted? — Materialization gate (§55) → **model A + B split**

- **Durable (portable, bounded):** the *cursor* — `axiom.live-query-cursor.v1`, an
  HMAC-integrity-protected token binding `LiveQueryIdentity` + `revision`. Optionally a small
  `LiveSubscriptionStore` row `{ subscriptionId, identity, lastRevision, updatedAt }` for
  observability and GC (memory reference; SQLite parity is straightforward, deferred to a
  provider that needs cross-restart replay).
- **In-authority, bounded, not durable:** the *last materialized result* (bounded by the
  `QueryDef` result cap), used to compute incremental deltas.

Failover / reconnect recovery does **not** depend on the materialized result surviving: a
reconnect to a fresh authority re-evaluates the query at the current coherent revision and
sends a `reset` (§37, §38, §108). Durable history replay is an *optimization* a provider may
add later; the correct baseline is "reset on reconnect to an authority that has no
materialized result for this subscription".

## 5. How is the snapshot→updates gap prevented? — **Model A: revision-first replay** (§10, §11)

```
ensureStateCoherent()                       // reconcile to the durable revision (0.12.1)
R := persistence.revision()
rows := executeQuery(Q, P, A) at R          // coherent single-revision result
register the live query with fromRevision = R
```

All three steps run inside the server's single serialized request queue, so no local commit
can interleave between "evaluate at R" and "register from R". A commit that lands at
revision `R' > R` — on this authority or, via revision observation, another — is a candidate
for re-evaluation and its delta carries `fromRevision >= R`. No committed change between the
snapshot and the registration is lost.

## 6. Canonical delta model (§13-§16)

```
LiveQueryDelta = { fromRevision, toRevision, changes: Change[] }
Change =
  | { kind: 'insert', key, index?, value }
  | { kind: 'remove', key }
  | { kind: 'update', key, value }
  | { kind: 'move',   key, index }
  | { kind: 'reset',  rows }          // replace the whole result with `rows`
```

`key` is the provider/entity **stable row identity** (`entity.identityFieldId`), never an
array index, JSON string, label or object identity. Diff is computed by re-evaluating and
comparing to the last materialized result (§56). Correctness beats minimality: an `update`
may legitimately be delivered as `remove + insert`, and any result may be delivered as
`reset` (§14, §15). A result with no stable row identity is **reset-only**.

## 7. When is reset used? (§14, §38, §108)

- The query is reset-only (no stable row identity / aggregate-shaped result).
- A reconnecting authority has no materialized result for the subscription.
- A replay gap: the cursor revision predates what this authority can reconstruct
  incrementally → `reset` at the current revision (correctness restored, not an error). Only
  when a fresh authoritative result *cannot* restore correctness is `LIVE_QUERY_CURSOR_EXPIRED`
  emitted.
- Any commit the runtime cannot prove is a pure incremental change of the current result.

A `reset` always carries one coherent authoritative revision — never mixed revisions.

## 8. What is the authoritative revision? (§32)

`persistence.revision()` — the same monotonic durable commit-order integer 0.10 concurrency
control and 0.12.1 state coherence use. No wall clock, no process-local sequence, no socket
message count, no second coherence counter (§31).

## 9-11. Dependency representation (§26-§30)

```
QueryDependencySet = {
  entityIds: Set<NodeId>,     // the query source + every entity a filter/projection/sort/
                              //   relationship/aggregate/policy expression reads
  stateIds:  Set<NodeId>,     // every StateDef a query or policy expression reads (§31)
  broad:     boolean,         // true when a dependency is not statically enumerable (§29)
}
```

Derived **statically** from the `QueryDef` + effective `ReadPolicy` predicate + declared
`RelationshipDef` endpoints by walking the `Expression` trees (`field`/`ref` leaves). Policy
dependencies are included even when the projection does not mention the field (§30).
Conservative (§27): anything not statically enumerable sets `broad: true`, which
re-evaluates on every commit. Authors never declare `watch tables X, Y, Z` (§28).

## 12. StateDef dependency composition with 0.12.1 (§31)

A `QueryDef`/policy expression that reads a `StateDef` adds that state to `stateIds`. Live
invalidation reuses the 0.12.1 durable-revision coherence: `ensureStateCoherent()` runs
before every live re-evaluation, and a commit that wrote a depended-on `StateDef` is a
re-evaluation candidate. No second state-coherence mechanism.

## 13-16. Delivery, update identity, ordering, coalescing (§39-§45)

- **At-least-once** logical update delivery. Physical exactly-once network delivery is never
  claimed (§39).
- **Logical update identity** = `(subscriptionId, toRevision)`. The client/runtime
  recognises an already-applied `toRevision` and drops a duplicate (§41, §104).
- **Ordering:** per subscription, strictly by `toRevision`. An update whose `fromRevision`
  does not equal the last-applied `toRevision` is a detected gap → the consumer replays or
  resets (§42, §43, §105). No global order across subscriptions.
- **Coalescing:** the runtime MAY skip intermediate revisions and deliver one delta from the
  last-applied revision to the newest — `fromRevision`/`toRevision` make the jump explicit
  (§44, §45). Every-revision delivery is never promised.

## 17-19. Cursor (§33-§35, §85)

`axiom.live-query-cursor.v1` — opaque base64url, HMAC-SHA-256 over the payload keyed by the
per-authority `cursorSecret`. Payload binds `subscriptionId`, the four identity fingerprints,
`serverContract`, `schemaFingerprint`, `semanticFingerprint` (§79, §80) and the replay
`revision`. **Server-sent cursor** model (§85 option A): the client resumes from the last
cursor it actually received; there is no explicit ACK. This matches at-least-once delivery —
on crash the client simply reconnects with its last cursor and gets replay-or-reset. Fail
closed: any fingerprint/version/HMAC mismatch → `LIVE_QUERY_CURSOR_INVALID`, nothing
disclosed. A cursor from query A / principal A / parameters A never resumes B.

## 20-22. Reconnect / replay / gap (§36-§38)

Reconnect through **any** compatible authority: authenticate → validate cursor → if this
authority holds a materialized result at exactly the cursor revision, replay the buffered
deltas after it; otherwise re-evaluate fresh at the current coherent revision and send
`reset`. A gap is always explicit (`fromRevision`), never a silently-omitted revision.

## 23. Slow-consumer policy (§46-§48, §129) — **coalesce, then bounded reset**

Per subscription: a bounded pending-update buffer. When a consumer falls behind the buffer
bound, intermediate deltas are **coalesced** into a single delta to the newest revision. If
even the coalesced form would exceed the bound (a very large result churning), the pending
state collapses to a single `reset` at the newest revision. Memory is bounded by
`(result cap + one pending delta)` per subscription — never unbounded.

## 24-25. Durable state on disconnect & retention (§53, §54, §136, §137)

The cursor is the durable resumable position. An optional `LiveSubscriptionStore` retains
`{ subscriptionId, identity, lastRevision, updatedAt }` for a bounded window
(`DEFAULT_LIVE_SUBSCRIPTION_RETENTION_MS`, default 1 h) for observability + GC; after that a
reconnect still works (it is a `reset` from fresh evaluation). No unbounded `.all()` over
history.

## 26-29. Distributed ownership / fencing / failover (§49-§52)

A live query's **durable delivery position** is a fenced conditional write when a
`CoordinationProvider` is present — the same mechanism as the 0.12 `SubscriptionCursorStore`
(reused, not reinvented): monotonic `revision`, `writerGeneration`; a stale owner's advance
is rejected. Reconnect-anywhere + reset-on-fresh-authority means a lost owner never blocks a
consumer. Failover: the new authority re-evaluates and resets. Stale-owner resurrection:
its cursor advance is fenced exactly as a 0.12 subscription cursor's is.

## 30-32. Provider capabilities & fallback (§57, §98-§100) — reuse + one optional capability

Required: nothing new — the reference path is **recompute-and-diff** (§56) over the existing
`DataProvider.query` / `aggregate`, plus `persistence.revision()` for wake-on-commit.
Optional: a provider MAY advertise `query-delta` and return incremental changes directly;
capability changes latency/CPU/delta minimality but **never** membership, authorization,
ordering, reconnect meaning or the delivery guarantee (§58). The revision-only fallback
(§31, §68) is: poll `persistence.revision()`; on advance, re-evaluate affected subscriptions.

## 33. External non-Axiom DB writes (§65) — **out of scope, documented**

Live invalidation is driven by Axiom's durable commit revision. A write made directly to the
provider's store outside an Axiom transaction does not advance that revision and is not
observed until the next Axiom commit or an explicit `server.clearQueryCache()` / host poke.
This is stated as a limitation.

## 34-35. Time / nondeterministic queries (§145, §146)

A `QueryDef` whose filter/projection/sort reads `now` / `uuid` / any nondeterministic
builtin is classified **`not-live-capable(nondeterministic)`** — `openLiveQuery` returns
`LIVE_QUERY_NOT_CAPABLE`. (A time-*windowed* query pattern that a future release supports via
an explicit refresh cadence is deferred, §192.)

## 36-37. Ordered / limited / aggregate updates (§17-§19)

Recompute-and-diff makes these correct by construction: the re-evaluated result already
reflects the new order / the new limit window / the new aggregate value, and the diff
against the previous materialized result produces `move` / boundary `insert`+`remove` /
`update` (for a single-row aggregate result) or `reset`. Fresh-query equivalence is the
test oracle (§15, §21, §115).

## 38. Authorization removal (§21-§24, §117, §134)

`ReadPolicy` and the principal are bound into every re-evaluation exactly as in a one-shot
query. A commit that changes policy-relevant data (or a reconnect with a changed principal,
§119) re-evaluates under the current policy; rows that are no longer visible produce
`remove` (or `reset`). Unauthorized data is never retained past one re-evaluation
(release-blocking, §180.7).

## 39. Mixed-build compatibility (§79-§82) — reuse 0.12

The cursor binds `schemaFingerprint` + `semanticFingerprint` + `serverContract`. A cursor
minted under one build is refused (`LIVE_QUERY_CURSOR_INCOMPATIBLE`) by an authority whose
`AuthorityCompatibilityKey` differs — the same fail-closed check the 0.12
`DurableWorkStore` applies. A presentation-only graph change (§121) does not change any of
the three fingerprints, so the cursor still resumes.

## 40. Portable conformance surface (§152) — **`axiom.conformance.v7`**

The fixture *shape* is new (subscribe → committed mutations → expected canonical deltas),
so a new tier is justified. `LiveQueryConformanceFixture` = deterministic initial data +
a `QueryDef` + a script of committed mutations + the expected `initial` result and ordered
`delta` sequence. Public `runLiveQueryConformanceFixture` / `runLiveQueryConformanceSuite`
over the memory provider. Negative control: one altered expected delta must fail the runner.
`v1..v6` fixtures untouched (§154).

---

## Server API (§88, §89)

Transport-independent:

```
server.openLiveQuery(request)   -> Promise<LiveQueryHandle>
server.resumeLiveQuery(cursor, request) -> Promise<LiveQueryHandle>
handle: AsyncIterable<LiveQueryMessage> & { close(): void; cursor(): string }
LiveQueryMessage =
  | { kind: 'initial', revision, rows, cursor }
  | { kind: 'update',  delta: LiveQueryDelta, cursor }
  | { kind: 'reset',   revision, rows, cursor }
  | { kind: 'error',   code, message }
```

A reference WebSocket host adapter maps this onto frames; the application writes **no**
`socket.on` / `broadcast` / `redis.publish` / `setInterval` / manual diff (§87).

## Release classification target

**B — LIVE CANONICAL QUERIES.** Validation target D1 / E1 / S1 (blind external, post-publish).
