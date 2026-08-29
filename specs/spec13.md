# Axiom 0.13.0 Specification

## Realtime / Live Canonical Queries

**Status:** Feature specification
**Target:** `@cynodia/axiom 0.13.0-alpha.1`
**Baseline:** `0.12.1-alpha.1` — Distributed Authority, externally validated D1 / E1 / S1
**Primary classification target:** B — LIVE CANONICAL QUERIES
**Validation target:** D1 / E1 / S1
**Server IR:** retain `axiom.server.v7` unless portable vocabulary actually changes
**Conformance:** introduce the next version only if new portable fixture vocabulary requires it

---

# 1. PURPOSE

Axiom 0.10 made `QueryDef` the canonical semantic mechanism for provider-backed reads.

Axiom 0.12/0.12.1 established:

* distributed authority;
* durable revision observation;
* fencing;
* durable subscription cursors;
* topology-transparent execution;
* authority-local state coherence.

Axiom 0.13 extends canonical queries from:

```text
request
    ↓
QueryDef
    ↓
result
```

to:

```text
subscribe
    ↓
QueryDef
    ↓
initial result
    ↓
semantic changes
    ↓
incremental delivery
    ↓
reconnect / replay
    ↓
continued result
```

without requiring application authors to implement:

* WebSocket protocols;
* polling loops;
* change feeds;
* invalidation channels;
* provider-specific CDC;
* Redis pub/sub;
* manual result diffing;
* reconnect cursors;
* cross-instance fanout;
* client-side query re-execution logic.

The semantic object being observed is the **QueryDef result**, not the transport connection.

---

# 2. PRIMARY INVARIANT

For a live query `Q`, principal `P`, parameters `A`, and authoritative committed state sequence:

```text
R0, R1, R2, ... Rn
```

the live-query consumer MUST observe a sequence semantically equivalent to repeatedly evaluating:

```text
executeQuery(Q, P, A)
```

against the relevant committed revisions, subject to the explicitly declared delivery and coalescing contract.

Informally:

> A live query is a persistent semantic observation of a QueryDef, not a stream of provider events.

---

# 3. TOPOLOGY INVARIANT

For compatible authorities:

```text
observableLiveMeaning(
    subscribe(Q),
    oneAuthority
)
==
observableLiveMeaning(
    subscribe(Q),
    NAuthorities
)
```

subject to explicit delivery semantics.

Adding, removing, restarting, load-balancing across, or failing over between compatible authorities MUST NOT change the semantic query result.

Topology remains deployment infrastructure.

---

# 4. CORE MODEL

A live query has four semantic stages:

```text
subscribe
   │
   ▼
initial snapshot
   │
   ▼
committed changes
   │
   ▼
result updates
   │
   ▼
reconnect / replay
```

The runtime owns continuity between these stages.

---

# 5. QUERYDEF REMAINS CANONICAL

0.13 MUST NOT introduce a second query language.

Live queries are based on ordinary:

```text
QueryDef
```

The same QueryDef MUST define:

* one-shot execution;
* live initial result;
* live re-evaluation;
* provider pushdown;
* policy injection;
* result typing.

Do not create:

```text
LiveQueryDef
RealtimeQueryDef
WatchQueryDef
SubscriptionQueryDef
```

unless implementation proves that QueryDef cannot carry the required semantics without semantic ambiguity.

Preferred model:

```text
QueryDef
    +
live execution mode
```

rather than a parallel query abstraction.

---

# 6. GRAPH VOCABULARY DESIGN GATE

Before implementation, determine whether live-query capability requires new graph vocabulary.

Preferred outcome:

```text
no new semantic node kind
```

because the application meaning already exists in `QueryDef`.

If portable graph semantics must declare live-specific behaviour such as coalescing or delivery guarantees, add the smallest explicit vocabulary necessary.

Do not add transport vocabulary.

Forbidden graph concepts include:

```text
websocket
socket.io
sse
redis-channel
connection-id
server-instance
broadcast
room
topic-name
```

unless such a concept has genuine provider-independent application meaning.

---

# 7. LIVE QUERY IDENTITY

A logical live-query subscription MUST have stable semantic identity independent of:

* authority instance;
* physical connection;
* socket;
* reconnect;
* process restart.

At minimum identity derives from:

```text
QueryDef identity
principal/policy identity
canonical parameters
semantic compatibility identity
```

A runtime-generated subscription identity MAY additionally distinguish two intentional independent subscriptions to the same semantic query.

Do not use physical connection ID as semantic identity.

---

# 8. PHYSICAL CONNECTION ≠ LOGICAL SUBSCRIPTION

Explicitly distinguish:

```text
LogicalLiveQuery
```

from:

```text
PhysicalDeliveryConnection
```

A logical subscription may survive:

* TCP disconnect;
* WebSocket reconnect;
* authority crash;
* reconnect through another authority;
* process replacement.

The physical transport is replaceable infrastructure.

---

# 9. INITIAL RESULT

A successful live subscription MUST establish an initial authoritative result.

Example:

```text
subscribe orders where status = "open"

→ initial {
    revision: 41,
    rows: [...]
}
```

The initial result MUST correspond to a coherent authoritative revision.

It MUST NOT be assembled from mixed revisions.

---

# 10. NO SNAPSHOT-TO-STREAM GAP

There MUST be no correctness gap between:

```text
initial query evaluation
```

and:

```text
registration for subsequent changes
```

Classic forbidden race:

```text
evaluate Q at revision 10
commit revision 11
register watcher
```

resulting in revision 11 never being observed.

0.13 MUST define and implement an atomic or replay-safe handoff.

---

# 11. SNAPSHOT/HANDOFF DESIGN GATE

The implementation MUST explicitly document how it prevents the initial-result/change-stream race.

Acceptable models include:

### A. revision-first replay

```text
capture R
evaluate Q at R
register from R
replay changes > R
```

### B. subscribe-first buffering

```text
register
capture R
evaluate Q
buffer changes during evaluation
deliver after initial result
```

### C. provider transactional snapshot/change cursor

where supported.

The provider-specific mechanism may vary.

The semantic guarantee may not.

---

# 12. RESULT UPDATE SEMANTICS

The client consumes semantic query-result updates.

Axiom MAY deliver:

```text
full replacement result
```

or:

```text
incremental result delta
```

depending on capability.

But both MUST have equivalent meaning.

---

# 13. CANONICAL DELTA MODEL

0.13 SHOULD define a provider-independent canonical delta representation.

Preferred conceptual operations:

```text
insert
remove
update
move
reset
```

where applicable.

Example:

```text
{
  fromRevision: 41,
  toRevision: 42,
  changes: [
    {
      kind: "insert",
      key: "order-123",
      index: 4,
      value: {...}
    }
  ]
}
```

Exact shape is an implementation design decision.

---

# 14. RESET IS A VALID SEMANTIC DELTA

A provider/runtime need not always compute an efficient incremental patch.

A canonical:

```text
reset
```

operation MUST be allowed.

Meaning:

```text
replace current result with this authoritative result
```

This permits correctness before optimal delta computation.

---

# 15. CORRECTNESS BEFORE MINIMAL DIFF

Axiom MUST NOT require the runtime to produce the mathematically smallest result diff.

For example:

```text
update row
```

may legitimately be represented as:

```text
remove + insert
```

or:

```text
reset
```

if the resulting observable query state is identical.

Optimization is secondary.

---

# 16. RESULT KEYS

Incremental list updates require stable row identity.

The runtime MUST use semantic/provider-record identity already defined by QueryDef/entity semantics.

Do not infer identity from:

* array index;
* JSON string;
* display label;
* object identity.

If a query result has no stable row identity, the runtime MAY fall back to `reset`.

---

# 17. ORDERED RESULTS

For queries with semantic ordering:

```text
orderBy(...)
```

live updates MUST preserve that ordering.

A changed record may therefore produce:

```text
move
```

or equivalent remove/insert behaviour.

The client MUST not need to re-sort using hidden provider rules.

---

# 18. LIMIT / WINDOW QUERIES

Queries containing:

```text
limit
cursor window
top N
```

require special handling.

Example:

```text
top 10 newest orders
```

Insertion of a newer row may:

* add one row;
* move rows;
* evict the previous tenth row.

The delivered result MUST remain semantically equivalent to fresh QueryDef execution.

---

# 19. AGGREGATES

Live aggregate queries MUST be supported at least through reset/re-evaluation if QueryDef currently supports the aggregate one-shot.

Example:

```text
count(open orders)
```

may deliver:

```text
41 → 42
```

without exposing provider-specific aggregate change mechanics.

---

# 20. RELATIONSHIP/TRAVERSAL QUERIES

If QueryDef supports relationships/traversal, live semantics MUST preserve them.

A change to a related entity that changes query membership or projection MUST invalidate/update the result.

Do not track only the primary entity table.

---

# 21. READPOLICY

Every live query is continuously governed by the same authoritative `ReadPolicy` semantics as one-shot execution.

The live result at revision R must be equivalent to:

```text
executeQuery(Q, principal, params, R)
```

including policy injection.

---

# 22. AUTHORIZATION CHANGES

A live subscription MUST NOT permanently retain data that is no longer authorized.

If a policy-relevant change causes a row to become invisible:

```text
row MUST leave the live result
```

If the entire subscription becomes unauthorized:

```text
subscription MUST fail/terminate explicitly
```

according to a defined diagnostic.

---

# 23. PRINCIPAL IDENTITY

The logical live subscription MUST preserve the security principal under:

* reconnect;
* authority failover;
* replay;
* re-evaluation.

A reconnect through another authority MUST NOT accidentally execute as:

```text
system
anonymous
previous connection's principal
```

---

# 24. AUTHORIZATION IS RE-EVALUATED

A reconnect token/cursor MUST NOT itself authorize query access.

On reconnect:

```text
authenticate current principal
        ↓
validate subscription identity
        ↓
re-evaluate authorization
        ↓
resume if permitted
```

Possession of a cursor is not authorization.

---

# 25. QUERY PARAMETER IDENTITY

Parameters MUST be canonicalized deterministically for logical identity.

Equivalent parameter maps MUST not become different queries merely because:

* object key order differs;
* JSON serialization order differs;
* runtime object identity differs.

Use canonical Axiom value semantics.

---

# 26. DEPENDENCY TRACKING

The runtime must determine when a committed change may affect a live QueryDef.

0.13 SHOULD introduce a provider-independent query dependency model.

Conceptually:

```text
QueryDependencySet
```

may include:

* entity types;
* fields used in filters;
* fields used in projections;
* fields used in ordering;
* relationship edges;
* policy dependencies;
* aggregate dependencies;
* StateDef dependencies where applicable.

---

# 27. DEPENDENCY TRACKING MUST BE CONSERVATIVE

False-positive invalidation is acceptable:

```text
query recomputed even though result unchanged
```

False-negative invalidation is not:

```text
result changed semantically
but live query receives no update
```

Correctness rule:

> When uncertain, invalidate/re-evaluate.

---

# 28. STATIC DEPENDENCY ANALYSIS

Where possible, dependencies SHOULD be derived from the semantic QueryDef/Expression graph.

Do not require application authors to manually declare:

```text
watch tables X, Y, Z
```

if Axiom can derive them.

---

# 29. DYNAMIC DEPENDENCIES

If query semantics include dependencies not statically enumerable, the runtime MAY classify the query as:

```text
broad invalidation
```

and re-evaluate on a wider revision set.

Again:

```text
extra work > stale result
```

---

# 30. POLICY DEPENDENCIES

Dependency analysis MUST include fields/entities used by `ReadPolicy`.

Example:

```text
QueryDef:
    orders

ReadPolicy:
    order.accountId == principal.accountId
```

A change to policy-relevant data may affect visibility even if the QueryDef projection itself does not mention that field.

---

# 31. STATEDEF DEPENDENCIES

If QueryDef semantics can reference `StateDef`, those dependencies MUST participate in live invalidation.

0.12.1 StateDef durable-revision coherence is the authoritative foundation.

Do not create a second state-coherence mechanism.

---

# 32. COMMIT REVISION

Live-query progression MUST be tied to an authoritative durable revision/order.

Do not use:

* wall-clock timestamps;
* process-local sequence numbers;
* socket message counts.

Where the persistence provider already exposes a durable revision, reuse it.

---

# 33. LIVE CURSOR

A live-query consumer MUST have a resumable semantic position.

Conceptually:

```text
LiveQueryCursor {
    subscriptionId
    revision
    ...
}
```

The cursor MUST be opaque to application logic.

---

# 34. CURSOR SECURITY

Live-query cursors MUST be integrity protected.

They MUST bind sufficiently to:

* query identity;
* principal/policy identity;
* parameters;
* semantic/server compatibility identity;
* replay position.

A cursor from query A MUST NOT resume query B.

A cursor from principal A MUST NOT grant principal B A's result stream.

---

# 35. CURSOR VERSIONING

Live-query cursor format MUST be explicitly versioned.

Example:

```text
axiom.live-query-cursor.v1
```

Do not rely on accidental JSON shape stability.

---

# 36. RECONNECT

A disconnected consumer may reconnect through any compatible authority.

Example:

```text
client → Authority A
receive through revision 100
disconnect

client → Authority C
resume cursor@100

Authority C
    ↓
authenticate
    ↓
validate cursor
    ↓
resume/replay >100
```

No sticky routing.

---

# 37. REPLAY

If durable history sufficient to resume from cursor R exists:

```text
replay semantic updates after R
```

If it does not:

```text
send reset/current authoritative result
```

Do not silently omit missing revisions.

---

# 38. REPLAY GAP

A replay gap MUST be explicit.

Preferred semantic behaviour:

```text
reset
```

rather than failure when a fresh authoritative result can restore correctness.

If correctness cannot be restored:

```text
LIVE_QUERY_CURSOR_EXPIRED
```

or equivalent explicit diagnostic.

---

# 39. DELIVERY GUARANTEE

Default live-query delivery SHOULD be:

```text
at-least-once update delivery
```

with revision/cursor semantics allowing consumers/runtime to recognize replay.

Do NOT claim physical exactly-once network delivery.

---

# 40. OBSERVABLE RESULT EXACTNESS

Although physical update delivery may be at-least-once, applying the canonical update stream correctly MUST yield one authoritative logical result.

Duplicate delivery MUST NOT cause duplicate rows or cumulative corruption.

---

# 41. UPDATE IDENTITY

Every logical live-query update SHOULD have stable identity sufficient for dedup/replay.

Potential identity:

```text
subscriptionId + fromRevision + toRevision
```

or a stronger logical update ID.

Do not use physical message UUID alone.

---

# 42. ORDERING

Ordering guarantee:

```text
per logical live-query subscription
```

Updates for one subscription MUST be applied in revision order.

No global order is required across independent live queries.

This aligns with the 0.12 subscription ordering model.

---

# 43. OUT-OF-ORDER DELIVERY

If transport delivers update R+2 before R+1:

runtime/client protocol MUST:

* buffer;
* replay;
* reject and reconnect;
* reset;

or otherwise preserve semantic order.

It MUST NOT apply updates in arbitrary arrival order.

---

# 44. COALESCING

Axiom MAY coalesce intermediate revisions.

Example:

```text
R10
R11
R12
R13
```

may become:

```text
R10 → R13
```

if the delivered delta/reset is semantically equivalent.

Coalescing MUST be explicitly represented in cursor/revision semantics.

---

# 45. NO CLAIM OF EVERY-REVISION DELIVERY

Unless explicitly requested by future semantics, a live query observes:

```text
authoritative result evolution
```

not necessarily every intermediate database revision.

0.13 MUST distinguish:

```text
latest-result correctness
```

from:

```text
audit/event stream
```

A live query is not an audit log.

---

# 46. BACKPRESSURE

Slow consumers MUST NOT cause unbounded memory growth.

Live query delivery requires an explicit backpressure policy.

Preferred default:

```text
coalesce toward latest correct result
```

rather than retaining an unbounded sequence of obsolete deltas.

---

# 47. BACKPRESSURE RESET

If a consumer falls too far behind:

```text
reset to current result
```

is preferable to unbounded buffering.

The cursor advances to the reset revision only after the reset is semantically accepted according to the protocol contract.

---

# 48. RESOURCE LIMITS

Host configuration SHOULD allow infrastructure tuning such as:

```text
maxLiveSubscriptions
maxSubscriptionsPerConnection
maxBufferedUpdates
maxReplayUpdates
pollIntervalMs
liveQueryBatchSize
```

These are operational tuning, not graph semantics.

---

# 49. DISTRIBUTED OWNERSHIP

If live subscriptions require authority-owned durable work, ownership MUST reuse 0.12 leased/fenced semantics.

Do not create another lease system.

Potential resource identity:

```text
live-query:<logicalSubscriptionId>
```

---

# 50. FENCING

Any durable mutation belonging to an owned live-query worker MUST be fenced by ownership generation.

A stale authority MUST NOT:

* advance cursor;
* publish durable subscription position;
* finalize replay state;
* overwrite newer ownership state.

Reuse the proven 0.12 fencing model.

---

# 51. FAILOVER

Kill the authority currently serving/owning a live query.

Another compatible authority MUST be able to recover the logical subscription and continue from durable position.

No lost semantic result.

No duplicate logical subscription creation.

Physical duplicate delivery around failure is acceptable under at-least-once semantics.

---

# 52. CONNECTION LOSS VS AUTHORITY LOSS

These are distinct:

```text
client connection lost
```

and:

```text
authority process lost
```

The logical subscription model must handle both.

Do not make connection lifetime equal authority ownership lifetime unless correctness is proven.

---

# 53. DISCONNECTED RETENTION

Define how long a logical subscription remains resumable after the physical client disconnects.

This SHOULD be host/runtime policy.

Example:

```text
liveQueryRetentionMs
```

Expired subscription state may be garbage-collected.

---

# 54. DURABLE SUBSCRIPTION STATE

At minimum, durable live-query state SHOULD contain enough to establish:

* logical subscription identity;
* query identity;
* parameter fingerprint;
* principal/policy fingerprint;
* compatibility key;
* latest durable cursor/revision;
* ownership generation where owned;
* lifecycle state;
* expiry/retention metadata.

Do not durably persist transport objects.

---

# 55. RESULT MATERIALIZATION DESIGN GATE

Determine whether Axiom durably stores:

A. only cursor/dependency state;

B. the last materialized result;

C. provider-specific delta position;

D. some combination.

This is a major design gate.

Correctness requirements:

* failover must recover;
* reconnect must restore result semantics;
* storage must be bounded;
* provider-independent contract must remain clear.

---

# 56. RECOMPUTE VS MATERIALIZE

0.13 SHOULD allow the simplest correct implementation:

```text
revision changed
    ↓
query potentially affected
    ↓
re-execute QueryDef
    ↓
compare with previous result
    ↓
deliver delta/reset
```

before requiring sophisticated incremental query maintenance.

A future provider may optimize this.

---

# 57. PROVIDER DELTA CAPABILITY

Providers MAY advertise an optimization capability such as:

```text
query-delta
```

or equivalent.

A capable provider may return incremental changes directly.

An incapable provider MUST still be able to produce correct live semantics through re-evaluation if bounded and supported.

---

# 58. CAPABILITY ≠ SEMANTIC DIFFERENCE

Provider capability may change:

* latency;
* CPU;
* database work;
* delta minimality.

It MUST NOT change:

* result membership;
* authorization;
* ordering;
* reconnect meaning;
* delivery guarantee.

---

# 59. LARGE DATA

0.13 MUST NOT require loading an unbounded entity collection into framework memory merely to implement live queries.

For large QueryDefs:

* provider pushdown remains mandatory where 0.10 requires it;
* result bounds remain enforced;
* re-evaluation remains bounded by query result semantics;
* dependency tracking must not require loading the whole table.

---

# 60. QUERY RESULT SIZE

Existing QueryDef bounded-result rules remain authoritative.

Live mode does not create an escape from result-size constraints.

---

# 61. N+1 INVALIDATION

Avoid architecture where one commit causes every live query in the entire application to re-run unless correctness leaves no alternative.

Dependency indexing SHOULD narrow candidate subscriptions.

However, broad invalidation is acceptable as an initial fallback for semantic cases that cannot yet be analyzed precisely.

---

# 62. DEPENDENCY INDEX

Runtime SHOULD maintain an infrastructure index:

```text
dependency
    →
logical live subscriptions potentially affected
```

Example:

```text
entity:Order
field:Order.status
relationship:Order.customer
```

This index is runtime infrastructure, not graph semantics.

---

# 63. COMMIT CHANGESET

Where possible, persistence commit SHOULD expose enough semantic change information to avoid querying every dependency after every revision.

Potential provider-independent shape:

```text
CommitChangeSet {
    revision
    entitiesChanged
    fieldsChanged
    stateDefsChanged
    relationshipsChanged
}
```

This is a design candidate, not mandatory exact vocabulary.

---

# 64. CHANGESET CORRECTNESS

A commit changeset may be conservative.

It MUST NOT omit a semantic dependency that changed.

False positives are acceptable.

False negatives are release-blocking.

---

# 65. EXTERNAL DATABASE CHANGES

0.13 MUST explicitly define whether live queries observe changes made outside Axiom.

Preferred initial contract:

> Live-query guarantees apply to mutations committed through an Axiom persistence provider/runtime unless the provider explicitly supports external-change observation.

Do not imply generic CDC if none exists.

---

# 66. MULTIPLE WRITERS

Multiple Axiom authorities may commit changes.

A live query MUST observe semantic changes regardless of which compatible authority committed them.

0.12.1 durable revision observation is the minimum fallback correctness mechanism.

---

# 67. NO BROADCAST DEPENDENCY

Like 0.12 cache/state coherence:

```text
broadcast notification MAY reduce latency
```

but:

```text
broadcast notification MUST NOT be required for correctness
```

Lost pub/sub wakeup must not create permanent stale live results.

---

# 68. POLLING FALLBACK

A provider/runtime MAY use durable revision polling as the reference correctness mechanism.

Example:

```text
observe revision
if advanced:
    inspect dependencies / re-evaluate
```

This is acceptable for reference providers.

It MUST be bounded and configurable.

---

# 69. WAKE-ON-COMMIT OPTIMIZATION

Within one process, commits MAY wake live-query evaluation immediately.

Cross-process provider notification MAY later do the same.

These are latency optimizations only.

The durable revision path remains sufficient for correctness.

---

# 70. MEMORY PROVIDER

Memory provider remains the semantic reference implementation.

It SHOULD support live queries in one process.

It MUST not claim cross-process durability.

---

# 71. SQLITE PROVIDER

SQLite MUST be the real cross-process reference implementation.

Live queries against shared SQLite must work across independent OS processes.

No application SQL.

No application lock management.

No raw SQLite contention leakage during supported operation.

---

# 72. SQLITE CONTENTION

Reuse 0.12.1 SQLite busy handling.

Do not create another SQLite contention mechanism.

Live polling/re-evaluation MUST NOT reintroduce:

```text
SQLITE_BUSY
SQLITE_LOCKED
ERR_SQLITE_ERROR
database is locked
```

to application semantics.

---

# 73. TRANSACTION BOUNDARY

A live query observes committed state only.

It MUST NOT expose:

* speculative transaction state;
* rolled-back state;
* losing optimistic transaction state;
* uncommitted effect intent.

---

# 74. ACTION + LIVE QUERY

Example:

```text
client subscribes:
    open orders

another client:
    close order 123
```

After commit:

```text
order 123 leaves live result
```

If the action loses a concurrency race and does not commit:

```text
live result MUST NOT change because of that losing attempt
```

---

# 75. EFFECT OUTCOME + LIVE QUERY

If an effect outcome commits semantic state that affects a QueryDef, live query invalidation MUST occur exactly as for any other committed state change.

The live system does not special-case human/client writes.

---

# 76. SCHEDULE + LIVE QUERY

A scheduled action committed on authority C may change a live query currently delivered through authority A.

A MUST eventually observe/deliver the change according to the live-query staleness/delivery contract.

Topology cannot hide it.

---

# 77. EVENT + LIVE QUERY

An external event accepted on authority B may change data affecting a live query connected through authority D.

The result MUST update.

This explicitly composes 0.12 event dedup with 0.13 live observation.

---

# 78. SCHEMA MIGRATION

0.11 migration gates remain authoritative.

A live subscription MUST NOT continue blindly across an incompatible schema migration.

During migration:

```text
ordinary serving remains fail-closed
```

After migration:

* old cursors may be invalidated;
* reconnect may require reset;
* incompatible query identity must fail explicitly.

---

# 79. SCHEMA FINGERPRINT IN CURSOR

Live cursor SHOULD bind to the relevant schema identity.

A cursor created against incompatible schema MUST not be interpreted under a new schema as though nothing changed.

---

# 80. SEMANTIC FINGERPRINT IN CURSOR

Live cursor MUST bind to executable meaning sufficiently to prevent:

```text
same QueryDef ID
different query body
resume old cursor
```

from silently continuing with incompatible semantics.

Use the 0.12 semantic compatibility model.

---

# 81. MIXED BUILD

Authority A and B may have the same schema but different QueryDef executable meaning.

They MUST NOT share/resume the same logical live subscription.

Expected:

```text
INCOMPATIBLE_AUTHORITY
```

or a live-query-specific compatibility diagnostic.

Fail closed.

---

# 82. ROLLING DEPLOYMENT

A live query connected to an old compatible build may reconnect to another compatible build.

If semantic compatibility differs:

```text
do not resume
```

If presentation-only differences exist:

```text
resume is allowed
```

consistent with `semanticFingerprint`.

---

# 83. CLIENT PROTOCOL

0.13 requires a portable client-facing live-query protocol.

Conceptually:

```text
LiveQueryOpenRequest
LiveQueryInitial
LiveQueryUpdate
LiveQueryResumeRequest
LiveQueryCloseRequest
LiveQueryError
```

Exact names are design work.

Do not expose provider-specific concepts.

---

# 84. PROTOCOL AUTHORITY

The server decides:

* whether query exists;
* whether live mode is supported;
* authorization;
* canonical parameter interpretation;
* cursor validity;
* replay/reset;
* result updates.

The client cannot assert its own revision as authoritative.

---

# 85. CLIENT ACKNOWLEDGEMENT DESIGN GATE

Determine whether cursor advancement requires explicit client acknowledgement.

Two viable models:

### A. server-sent cursor

Client resumes from the last cursor it has actually received.

### B. explicit ACK

Server durably advances acknowledged position only after client confirmation.

The chosen model MUST match at-least-once delivery semantics and crash behaviour.

Do not leave this ambiguous.

---

# 86. CONNECTION TRANSPORT

The semantic protocol MUST NOT require one transport.

Reference server MAY support:

* WebSocket;
* SSE where suitable;
* in-process stream API.

But transport is host infrastructure.

The portable semantic contract is above it.

---

# 87. NO APP WEBSOCKET LOGIC

An application author MUST be able to express:

```text
live QueryDef
```

without writing:

```text
socket.on(...)
io.to(...)
broadcast(...)
setInterval(...)
redis.publish(...)
redis.subscribe(...)
manual diff(...)
```

Any such requirement is semantic escape.

---

# 88. SERVER API

Provide a runtime API suitable for transport adapters.

Conceptually:

```text
server.openLiveQuery(...)
server.resumeLiveQuery(...)
server.closeLiveQuery(...)
```

or an async stream abstraction.

Exact API is implementation work.

Keep it semantic and transport-independent.

---

# 89. ASYNC ITERATION

An in-process interface SHOULD be considered:

```text
AsyncIterable<LiveQueryMessage>
```

because it naturally represents:

* initial result;
* updates;
* termination;
* backpressure.

Do not mandate it if it complicates cross-runtime portability.

---

# 90. CLIENT RUNTIME

If Axiom has a client runtime, it SHOULD own application of canonical deltas.

Application code should consume:

```text
current result
```

rather than manually mutating arrays from protocol patches.

---

# 91. RESULT STATE MACHINE

Define a portable logical state machine.

Suggested:

```text
opening
    ↓
active
    ↓
disconnected
    ↓
resuming
    ↓
active

active
    ↓
closed

active
    ↓
failed
```

Physical connections may have additional states but they are not semantic.

---

# 92. UPDATE STATE MACHINE

Suggested:

```text
initial
    ↓
delta*
    ↓
reset?
    ↓
delta*
```

with monotonic cursor/revision progression.

---

# 93. DIAGNOSTICS

Potential live-query diagnostics include:

```text
LIVE_QUERY_NOT_SUPPORTED
LIVE_QUERY_NOT_FOUND
LIVE_QUERY_UNAUTHORIZED
LIVE_QUERY_CURSOR_INVALID
LIVE_QUERY_CURSOR_EXPIRED
LIVE_QUERY_INCOMPATIBLE
LIVE_QUERY_LIMIT_EXCEEDED
LIVE_QUERY_FENCED
LIVE_QUERY_PROVIDER_UNSUPPORTED
```

Use existing diagnostics where semantics are identical.

Do not multiply codes unnecessarily.

---

# 94. AGENTAPI

AgentAPI MUST make live semantics inspectable.

At minimum provide something equivalent to:

```text
inspectLiveQuery(queryId)
```

showing:

* whether QueryDef is live-capable;
* dependencies;
* ordering;
* result identity;
* authorization dependencies;
* provider capability requirements;
* fallback strategy;
* replay semantics;
* backpressure semantics;
* cursor identity inputs.

---

# 95. EXPLAIN LIVE QUERY

Provide an explain surface conceptually like:

```text
explainLiveQuery(queryId)
```

Example output:

```text
Query order.openOrders is live-capable.

Initial result:
  provider-backed QueryDef execution

Dependencies:
  Order.status
  Order.createdAt
  ReadPolicy Order.accountId

Update strategy:
  re-evaluate on relevant committed revision
  canonical delta

Ordering:
  createdAt descending

Reconnect:
  durable cursor
  any compatible authority

Backpressure:
  coalesce/reset to latest correct result
```

No provider SQL required in semantic explanation.

---

# 96. RUNTIME INSPECTION

Runtime inspection SHOULD expose:

* active logical subscriptions;
* owning authority where applicable;
* fencing generation;
* last observed revision;
* last delivered revision;
* replay position;
* buffered/coalesced state;
* compatibility identity;
* lifecycle state.

Do not expose secrets/cursor signing keys.

---

# 97. QUERY EXPLAINABILITY

AgentAPI SHOULD explain why a particular commit invalidates a query.

Conceptually:

```text
explainLiveInvalidation(queryId, change)
```

Possible result:

```text
Order.status changed.
Query filter depends on Order.status.
Result membership may have changed.
Re-evaluation required.
```

This is valuable for AI authoring and debugging.

---

# 98. PROVIDER INTERFACE

Implementation SHOULD define the minimum provider interfaces necessary for live correctness.

Potential concepts:

```text
observeRevision
loadChangesSince
queryDelta
```

Do not force all providers to implement the most advanced mechanism.

Reference fallback must remain possible.

---

# 99. CAPABILITIES

Potential capabilities:

```text
revision-observation
commit-changeset
query-delta
durable-live-cursor
```

Names are design work.

Capabilities must describe execution ability, not application semantics.

---

# 100. PROVIDER FALLBACK MATRIX

Document behaviour such as:

| Provider capability | Live strategy                                                  |
| ------------------- | -------------------------------------------------------------- |
| query-delta         | provider incremental delta                                     |
| commit-changeset    | dependency-targeted re-evaluation                              |
| revision only       | conservative re-evaluation                                     |
| no durable revision | single-process semantic reference only or explicit unsupported |

Do not silently claim distributed live correctness from an incapable provider.

---

# 101. SUBSCRIPTION CURSOR REUSE

0.12 already contains durable subscription cursor semantics.

0.13 MUST reuse or generalize that mechanism where appropriate.

Do not create:

```text
LiveQueryCursorStore
```

that independently reimplements:

* ownership;
* fencing;
* monotonic sequence;
* failover;

unless the existing abstraction is genuinely insufficient.

Document the decision.

---

# 102. CACHE COHERENCE REUSE

0.12 revision-observing cache already establishes:

```text
durable revision observation
staleness bound 0
broadcast optional
```

Live queries SHOULD compose with this mechanism.

Do not build a separate cross-authority invalidation truth system.

---

# 103. STATE COHERENCE REUSE

0.12.1 establishes:

```text
authority-local StateDef is a cache
persistence is authoritative
ensure coherence before authoritative operation
```

Live QueryDef evaluation that depends on StateDef MUST use this contract.

No second StateDef model.

---

# 104. DUPLICATE PHYSICAL DELIVERY

Test:

```text
same logical update delivered twice
```

Applying both MUST NOT corrupt the logical result.

The client/runtime should identify duplicate or already-applied cursor positions.

---

# 105. LOST PHYSICAL DELIVERY

Test:

```text
R10 delivered
R11 lost
R12 arrives
```

The runtime must detect the gap and:

* replay;
* reset;
* reconnect;

rather than silently applying an invalid delta chain.

---

# 106. DISCONNECT AFTER SEND BEFORE CLIENT OBSERVES

Classic uncertainty:

```text
server sends update R11
connection dies
unknown whether client received it
```

Reconnect from client's last known cursor may cause R11 to be resent.

This is expected under at-least-once delivery.

Canonical update application MUST tolerate it.

---

# 107. DISCONNECT AFTER CLIENT RECEIVES BEFORE SERVER KNOWS

Same principle.

Do not claim physical exactly-once delivery.

---

# 108. RESET AFTER RECONNECT

If replay is unavailable:

```text
resume cursor R10
current revision R1000
history unavailable
```

server may respond:

```text
reset at R1000
```

The client then has correct current state.

This is successful recovery, not necessarily an error.

---

# 109. DELETE

If a row leaves a live result because it was deleted:

```text
remove
```

or equivalent reset must occur.

No tombstone may remain visible unless QueryDef semantics explicitly include deleted records.

---

# 110. FILTER MEMBERSHIP CHANGE

Record:

```text
status: open → closed
```

for query:

```text
status == open
```

must produce removal.

Reverse change must produce insertion.

---

# 111. PROJECTION CHANGE

If a row remains a member but projected fields change:

```text
update
```

or equivalent reset must occur.

---

# 112. NON-PROJECTED NON-DEPENDENT CHANGE

If a changed field cannot affect:

* filter;
* projection;
* ordering;
* relationship;
* policy;
* aggregate;

runtime SHOULD avoid delivering a semantic update.

A conservative re-evaluation that finds no result difference is acceptable.

---

# 113. ORDERING CHANGE

If ordering key changes:

```text
move/update
```

or equivalent reset.

Final client ordering must equal fresh QueryDef execution.

---

# 114. LIMIT BOUNDARY CHANGE

Explicit test:

```text
ORDER BY score DESC LIMIT 10
```

Change item #11 so it becomes #3.

Expected:

* item enters;
* previous #10 leaves;
* ordering correct;
* result remains size 10.

---

# 115. AGGREGATE CHANGE

Explicit test:

```text
count
sum
min/max
```

where currently supported.

Result after update must equal one-shot QueryDef execution.

---

# 116. RELATIONSHIP CHANGE

Explicit test where changing related entity data changes:

* membership;
* projection;
* authorization;

of the live query.

Dependency analysis must catch it.

---

# 117. READPOLICY REMOVAL

A row visible at R10 becomes unauthorized at R11.

It MUST disappear from the live result.

This is release-critical.

---

# 118. READPOLICY ADDITION

A previously invisible row becomes authorized.

It SHOULD enter the live result according to normal QueryDef semantics.

---

# 119. PRINCIPAL CHANGE ON RECONNECT

Reconnect using another principal with an old cursor.

Expected:

```text
cursor rejected or subscription re-established under new principal
```

Never reuse old authorization context.

---

# 120. QUERY BODY CHANGE

Same query ID, changed executable body, same schema.

Old cursor must fail compatibility validation.

This directly tests `semanticFingerprint`.

---

# 121. PRESENTATION-ONLY CHANGE

Change:

* label;
* description;
* UI presentation.

Old cursor SHOULD remain compatible where semanticFingerprint remains unchanged.

---

# 122. MULTI-AUTHORITY COMMIT

Authority A owns/serves live query.

Authority B commits affecting data.

A must deliver resulting semantic update.

Repeat A/B roles randomly.

---

# 123. MULTI-AUTHORITY DELIVERY

Logical subscription initially connected through A.

Disconnect.

Reconnect through B.

Continue without semantic discontinuity.

---

# 124. OWNER CRASH

If live-query work has an owner:

```text
A owns generation 4
A SIGKILL
lease expires
B claims generation 5
```

A stale generation 4 process must not advance durable live position afterward.

---

# 125. STALE OWNER RESURRECTION

Pause A rather than kill it.

Allow B to reclaim.

Resume A.

Any durable live-query mutation by A MUST be fenced.

Permanent release blocker.

---

# 126. CACHE INVALIDATION LOSS

Drop all optional in-process/cross-process wake notifications.

Commit through B.

A's live query must still update through durable revision observation.

This proves notification is optimization only.

---

# 127. MANY WRITERS

Run:

```text
8 authorities
many writes
many live reads
multiple subscriptions
```

against one SQLite persistence DB.

Assert:

* no stale terminal result;
* no raw SQLite contention leakage;
* no cursor regression;
* no duplicate logical rows;
* bounded buffers.

---

# 128. HIGH SUBSCRIPTION COUNT

Test enough simultaneous live subscriptions to prove:

* bounded memory;
* dependency index scales;
* claim batching works if durable work used;
* one commit does not accidentally produce unbounded task creation.

Exact production-scale target may be env-gated.

---

# 129. SLOW CONSUMER

Artificially stop consuming one subscription.

Continue commits.

Expected:

* bounded buffer;
* coalescing/reset policy activates;
* other subscriptions continue;
* process memory remains bounded;
* slow consumer eventually reaches correct current result.

---

# 130. FAST WRITER

Write faster than one live query can re-evaluate.

Expected:

```text
coalesce revisions
```

rather than unbounded evaluation queue.

Final delivered result must equal current QueryDef result.

---

# 131. REEVALUATION DEDUP

If revisions 10,11,12 arrive while Q is already re-evaluating:

runtime SHOULD avoid:

```text
three redundant full concurrent evaluations
```

Preferred:

```text
evaluate
notice newest revision
evaluate at newest if needed
```

while preserving correctness.

---

# 132. QUERY EXECUTION FAILURE

If live re-evaluation fails because of a transient provider failure:

* do not advance durable cursor past the failed revision;
* retry according to explicit infrastructure policy;
* preserve last known correct result;
* do not fabricate a delta.

---

# 133. PERMANENT QUERY FAILURE

If query becomes permanently invalid/incompatible:

terminate explicitly.

Do not keep emitting stale data forever.

---

# 134. AUTHORIZATION FAILURE DURING STREAM

If authorization fails during re-evaluation:

* remove data no longer authorized;
* terminate if query itself is unauthorized;
* do not leak old authorized result indefinitely.

---

# 135. CLOSE

Closing a logical live query MUST:

* stop future delivery;
* release ownership where applicable;
* clean up ephemeral transport state;
* eventually garbage-collect durable state according to retention policy.

Close MUST be idempotent.

---

# 136. GARBAGE COLLECTION

Expired/closed durable subscription state must be reclaimable.

GC must not delete an active subscription owned by another authority.

Use fencing/lease semantics where necessary.

---

# 137. RECONNECT AFTER GC

If durable state has been garbage-collected:

server may:

```text
reject cursor as expired
```

or:

```text
create fresh subscription + reset
```

depending on protocol.

Behaviour must be explicit.

---

# 138. QUERY CACHE INTERACTION

Live-query re-evaluation MAY use canonical query cache if doing so preserves revision correctness.

A cache entry from R10 must not satisfy live re-evaluation at R11 when R11 may affect Q.

Reuse revision-aware cache semantics.

---

# 139. NO PROVIDER EVENT LEAKAGE

Application/client must not receive:

```text
SQLite row changed
Postgres WAL offset
Dynamo stream sequence
Redis message
```

as live-query semantics.

Provider events are translated into QueryDef result meaning.

---

# 140. CROSS-RUNTIME PORTABILITY

0.13 live-query semantic contracts MUST be designed so an independent runtime could implement them without Node-specific behaviour.

This includes:

* cursor format semantics;
* delta semantics;
* ordering;
* dependency semantics;
* reset;
* delivery guarantee;
* compatibility.

Do not expose JavaScript object identity or Node stream semantics as normative.

---

# 141. EARLY CROSS-RUNTIME TRACK

As a parallel architecture test, create portable live-query conformance fixtures early enough that a future Rust/Kotlin runtime could consume them.

The TypeScript runtime remains primary for 0.13.

No independent runtime is required to release 0.13.

But the fixture contract SHOULD be language-neutral.

---

# 142. CANONICAL VALUE EQUALITY

Result comparison/delta generation MUST use Axiom canonical value semantics.

Do not rely on:

```text
===
object reference equality
JSON.stringify with incidental key order
```

for semantic equality.

---

# 143. FLOAT / NULL / OPTIONAL

Explicitly test canonical equality and delta generation for:

* null;
* optional/missing values;
* booleans;
* strings;
* integers;
* floating point values according to existing Axiom semantics;
* nested records;
* lists;
* enums;
* IDs.

Cross-runtime ambiguity is release-blocking if it affects live result meaning.

---

# 144. TIME VALUES

If QueryDef supports temporal values, live comparison/cursor semantics must use canonical time representation.

Do not use local timezone formatting as identity.

---

# 145. QUERY WITH NOW/TIME DEPENDENCY

Major design gate:

A query whose result changes merely because time passes may require invalidation without any database commit.

Example:

```text
expiresAt < now()
```

If QueryDef permits such expressions, 0.13 MUST either:

A. support semantic time dependencies;

or

B. reject such QueryDefs as live-ineligible with an explicit diagnostic.

Do not silently freeze a time-dependent live result.

---

# 146. NON-DETERMINISTIC EXPRESSIONS

Queries using:

* random;
* uuid;
* impure external calls;

MUST NOT be live-capable unless existing Axiom semantics already make them deterministic for QueryDef execution.

Preferred:

```text
LIVE_QUERY_NOT_DETERMINISTIC
```

---

# 147. EXTERNAL I/O IN QUERY

Live QueryDef MUST preserve existing canonical query purity/provider rules.

Do not re-run arbitrary external side effects because a live query invalidates.

Queries are reads.

---

# 148. QUERY LIVE-CAPABILITY ANALYSIS

Validator/compiler SHOULD classify QueryDef live capability.

Conceptually:

```text
liveCapable
liveCapableWithResetOnly
notLiveCapable(reason)
```

This should be inspectable.

---

# 149. VALIDATION

Graph validation MUST reject impossible declared live semantics.

Examples:

* live mode requested for nondeterministic query;
* unsupported unbounded result;
* missing stable identity where incremental mode is required;
* invalid delivery/backpressure declaration;
* impossible provider requirement if statically known.

Prefer structured diagnostics.

---

# 150. COMPILATION

Compiler MUST preserve all semantic information required for a runtime to execute live queries independently.

Do not depend on closures or JS-only metadata not represented in portable output.

---

# 151. SERVER IR DESIGN GATE

If live capability is purely an execution mode over existing QueryDef IR:

```text
retain axiom.server.v7
```

If portable runtime needs new semantic fields to know live-specific meaning:

```text
introduce axiom.server.v8
```

only after explicitly demonstrating why v7 cannot represent the semantics.

Do not version IR merely because server implementation gained a feature.

---

# 152. CONFORMANCE

0.13 MUST add portable live-query conformance coverage.

Likely next contract:

```text
axiom.conformance.v7
```

if new fixture vocabulary is required.

Preferred fixture categories:

1. initial result;
2. insert;
3. remove;
4. update;
5. ordering move;
6. limit boundary;
7. reset;
8. duplicate delivery;
9. replay;
10. replay gap/reset;
11. authorization removal;
12. relationship invalidation;
13. aggregate update;
14. mixed-build cursor refusal;
15. reconnect;
16. backpressure/coalescing.

Exact count may change.

---

# 153. NEGATIVE CONFORMANCE CONTROL

As with 0.12:

modify one expected live result/delta in a copied fixture.

Runner MUST fail.

This proves the conformance runner is not vacuously green.

---

# 154. OLD CONFORMANCE

All existing conformance versions MUST remain usable.

Do not rewrite historical fixtures.

---

# 155. REFERENCE APPLICATION

Extend an existing representative application without topology-specific graph changes.

Suggested scenario:

```text
device monitor / order system
```

with live views such as:

```text
offline devices
recent failures
open orders
orders by customer
aggregate counts
```

Run unchanged with:

```text
1 authority
2 authorities
8 authorities
```

---

# 156. REFERENCE UI

A minimal reference client SHOULD demonstrate:

```text
subscribe QueryDef
render current result
disconnect
reconnect through another authority
continue
```

No application WebSocket/diff logic.

The UI itself is not the semantic proof.

---

# 157. SERVER TRANSPORT REFERENCE

Provide at least one real transport path for end-to-end testing.

WebSocket is a reasonable reference.

Transport code belongs in server/host infrastructure.

Do not make WebSocket vocabulary part of the graph.

---

# 158. REAL NETWORK TEST

At least one release test MUST use real:

```text
client process
network transport
server process(es)
```

rather than only in-process async iterators.

Disconnect the network deliberately.

Reconnect through another authority.

---

# 159. REAL OS PROCESSES

Distributed live-query release tests MUST use independent OS processes.

At minimum:

* remote commit;
* live delivery;
* owner crash;
* reconnect through different authority;
* stale-owner fencing;
* many-writer SQLite.

---

# 160. CHAOS MATRIX

Inject crash at each important boundary:

```text
before initial query
after initial query before watcher handoff
after handoff before initial send
after initial send before cursor persistence
after commit detected
during re-evaluation
after delta generated before send
after send before acknowledgement/position advance
after position advance before response completion
during reconnect
after reclaim before replay
```

For each boundary determine expected replay/reset behaviour.

---

# 161. SIGKILL

Use actual `SIGKILL`, not graceful shutdown only.

Logical live query must recover according to its durable contract.

---

# 162. LOST WAKEUP

Deliberately suppress optional notification.

Durable revision observation must still discover the change.

Permanent stale result is release-blocking.

---

# 163. DUPLICATE WAKEUP

Deliver the same invalidation signal repeatedly.

Must not produce corrupted or duplicated result.

---

# 164. REORDERED WAKEUP

Deliver revision notifications out of order.

Durable revision/cursor semantics must dominate notification arrival order.

---

# 165. HIGH REVISION JUMP

Subscription last saw R10.

Next observation is R1000.

System must:

* replay if supported/bounded;
* or reset to authoritative R1000.

It must not require seeing 990 individual notifications.

---

# 166. LARGE RESULT

Use a bounded but substantial query result.

Measure:

* initial query;
* re-evaluation;
* delta generation;
* reset;
* memory peak.

No unbounded table load.

---

# 167. MANY SUBSCRIPTIONS SAME QUERY

Multiple clients subscribe to identical QueryDef+params+policy.

Implementation MAY share computation/materialization.

But sharing is an optimization.

One client's close/backpressure/failure MUST NOT corrupt another logical subscription.

---

# 168. DIFFERENT PRINCIPALS SAME QUERY

Never share unauthorized materialized result across principals unless policy equivalence is proven.

Safe default:

```text
principal/policy identity participates in materialization identity
```

---

# 169. QUERY PARAMETER ISOLATION

Subscriptions to:

```text
orders(customer=A)
orders(customer=B)
```

must never receive each other's results.

---

# 170. OBSERVABILITY UNDER LOAD

Inspection APIs must remain bounded and coherent while live queries update.

Do not require enumerating unbounded internal message history.

---

# 171. SECURITY — CURSOR FORGERY

Modify:

* query ID;
* revision;
* principal fingerprint;
* parameter fingerprint;
* semantic fingerprint;
* signature.

Cursor must be rejected.

---

# 172. SECURITY — SUBSCRIPTION HIJACK

Knowing another logical subscription ID must not grant access to its result or cursor.

Authorization remains principal-based.

---

# 173. SECURITY — PROTOCOL OWNERSHIP

Remote clients MUST NOT be able to:

* set owner generation;
* acquire internal lease;
* fence another authority;
* advance durable internal cursor arbitrarily;
* force compatibility identity.

Internal ownership remains host/runtime authority.

---

# 174. SECURITY — QUERY SELECTION

A client may only open QueryDefs permitted through existing invocation/access semantics.

Do not expose arbitrary provider query construction through the live protocol.

---

# 175. SECURITY — PARAMETER VALIDATION

Live query parameters use the same type validation and authorization rules as one-shot QueryDef execution.

No separate permissive parser.

---

# 176. SECURITY — ERROR LEAKAGE

Live diagnostics MUST NOT expose:

* SQL;
* database filenames;
* signing keys;
* other principals' subscription IDs;
* provider credentials.

---

# 177. SEMANTIC ESCAPE TARGET

Reference live application must use:

```text
raw WebSocket handlers in app      0
Redis pub/sub                      0
manual DB polling in app           0
manual diffing in app              0
manual reconnect cursor logic      0
manual cross-instance broadcast    0
NativeOperation for live queries   0
provider-specific CDC in app       0
```

Target:

```text
E1
```

---

# 178. DISCOVERABILITY TARGET

A cold external agent should discover:

```text
QueryDef
    ↓
live execution
    ↓
initial result
    ↓
updates
    ↓
cursor/reconnect
```

from:

```text
llms.txt
docs
.d.ts
AgentAPI
conformance fixtures
```

without reading source.

Target:

```text
D1
```

---

# 179. SAFETY TARGET

Under:

* concurrent commits;
* multi-authority deployment;
* authority crash;
* client disconnect;
* reconnect;
* stale-owner recovery;
* lost notification;
* duplicate notification;
* provider contention;
* mixed build;
* slow consumer;

the live result must remain semantically equivalent to QueryDef execution.

Target:

```text
S1
```

---

# 180. RELEASE BLOCKERS

0.13 MUST NOT release if any of these occurs:

1. initial snapshot/change handoff can lose a committed change;
2. a committed change can permanently fail to reach an affected live query;
3. an unrelated topology change changes query meaning;
4. reconnect through another authority loses semantic continuity;
5. stale owner can advance durable live position;
6. cursor can be forged across query/principal/parameters;
7. policy change leaves unauthorized data visible indefinitely;
8. mixed semantic builds resume each other's incompatible live query;
9. duplicate delivery corrupts result;
10. lost delivery is not detected;
11. out-of-order update corrupts result;
12. slow consumer causes unbounded memory;
13. provider-native change events leak as application semantics;
14. application must write distributed locking/broadcast logic;
15. application must manually poll persistence;
16. application must manually diff QueryDef results;
17. application must use sticky authority routing;
18. SQLite ordinary contention leaks raw provider errors;
19. losing transaction generates a live update;
20. reset can publish mixed-revision state;
21. limit/order query diverges from fresh QueryDef execution;
22. relationship/policy dependency produces a false-negative invalidation;
23. live cursor bypasses authentication/authorization;
24. old schema/semantic cursor silently resumes incompatible meaning;
25. live-query state grows without bound under documented operation;
26. 1/2/8 authority reference executions produce different final live meaning.

---

# 181. FORBIDDEN COUNTERS

Release report MUST include explicit totals for:

```text
lost committed live updates
duplicate logical rows after replay
cursor regressions
stale-owner cursor advances
unauthorized rows retained
mixed-build resumes
undetected update gaps
out-of-order applications
unbounded-buffer events
raw SQLITE_BUSY
raw SQLITE_LOCKED
ERR_SQLITE_ERROR leakage
manual application broadcasts
manual application polling loops
manual application diff implementations
NativeOperation live-query usages
topology-dependent final results
```

Target:

```text
all zero
```

except physical duplicate delivery where explicitly expected and correctly deduplicated/applied.

---

# 182. PERFORMANCE REPORT

Measure at least:

* initial live-query latency;
* commit→update latency;
* reconnect latency;
* reset latency;
* incremental delta generation;
* full re-evaluation;
* 1/2/8 authority behaviour;
* 1/100/1000 subscriptions;
* slow consumer memory;
* SQLite polling overhead;
* provider query count per commit;
* dependency-index hit rate;
* percentage reset vs incremental delta.

No premature production SLA required.

---

# 183. BOUNDEDNESS

Demonstrate bounded:

* update buffer;
* replay batch;
* subscription claim batch;
* dependency candidate set processing per batch;
* materialized result according to QueryDef result bound;
* GC batch.

No unbounded `.all()` over durable subscription history.

---

# 184. IMPLEMENTATION PHASES

Recommended implementation order:

### Phase 1 — semantic model / design gates

Resolve §§6, 11, 55, 85, 145, 151.

### Phase 2 — live query identity + cursor

Canonical identity, versioned secure cursor.

### Phase 3 — initial result + no-gap handoff

Single authority, memory provider.

### Phase 4 — canonical result delta

Insert/remove/update/move/reset.

### Phase 5 — dependency analysis

QueryDef + policy + relationship dependencies.

### Phase 6 — revision-driven re-evaluation

Reference correctness path.

### Phase 7 — ordering / limit / aggregate semantics

Fresh-query equivalence.

### Phase 8 — authorization

Policy changes, principal binding, reconnect.

### Phase 9 — durable logical subscription state

Lifecycle, retention, cursor.

### Phase 10 — distributed ownership/fencing

Reuse 0.12 coordination.

### Phase 11 — reconnect/replay/reset

Any compatible authority.

### Phase 12 — backpressure/coalescing

Bounded slow-consumer behaviour.

### Phase 13 — SQLite cross-process reference

Multi-authority revision observation, contention.

### Phase 14 — transport-independent server API

Open/resume/close/stream.

### Phase 15 — real reference transport

WebSocket or equivalent host adapter.

### Phase 16 — AgentAPI / inspection / explain

Live capability, dependencies, runtime state.

### Phase 17 — portable conformance

Fixtures + negative control.

### Phase 18 — reference application

Unmodified semantic graph across 1/2/8 authorities.

### Phase 19 — chaos / scale / security

SIGKILL, lost wakeup, slow consumer, mixed build.

### Phase 20 — documentation / release preparation

Docs, anti-patterns, package version, pack/verify/consumer/probe.

### Phase 21 — blind external validation

Published packages only, fresh consumer, D1/E1/S1.

---

# 185. PHASE 1 REQUIRED DESIGN DECISIONS

Before substantial implementation, write a design note answering:

1. Is new graph vocabulary required?
2. Does Server IR remain v7?
3. What is logical live-query identity?
4. What exactly is persisted?
5. How is snapshot→updates gap prevented?
6. What is the canonical delta model?
7. When is reset used?
8. What is the authoritative revision?
9. How are dependencies represented?
10. How are policy dependencies represented?
11. How are relationship dependencies represented?
12. How does StateDef dependency compose with 0.12.1?
13. Is update delivery at-least-once?
14. What is logical update identity?
15. What is the ordering guarantee?
16. May revisions be coalesced?
17. What does cursor mean?
18. Is cursor client-held, server-held, or both?
19. Does delivery require ACK?
20. How is reconnect authenticated?
21. How is cursor integrity protected?
22. What happens on replay gap?
23. What is the slow-consumer policy?
24. What durable state survives disconnect?
25. How long is it retained?
26. Is a live query authority-owned work?
27. If yes, what resource is leased/fenced?
28. How does failover work?
29. How are stale owners fenced?
30. What provider capabilities are required?
31. What is the revision-only fallback?
32. How does SQLite discover remote commits?
33. Are external non-Axiom DB writes in scope?
34. How are time-dependent queries handled?
35. How are nondeterministic queries handled?
36. How are ordered/limited results updated?
37. How are aggregates updated?
38. How are authorization removals handled?
39. How is mixed-build compatibility checked?
40. What is the portable conformance surface?

Do not let implementation implicitly answer these.

---

# 186. INTERNAL TEST MATRIX

At minimum include deterministic tests for:

* initial result;
* no-gap handoff;
* insert;
* remove;
* update;
* ordering move;
* limit boundary;
* reset;
* aggregate;
* relationship dependency;
* ReadPolicy removal/addition;
* duplicate delivery;
* lost delivery;
* out-of-order delivery;
* reconnect;
* replay;
* replay gap;
* cursor tampering;
* principal mismatch;
* query parameter mismatch;
* semantic fingerprint mismatch;
* presentation-only compatibility;
* slow consumer;
* coalescing;
* close;
* GC;
* provider transient failure;
* provider permanent failure;
* owner crash;
* stale-owner resurrection;
* lost wakeup;
* duplicate wakeup;
* StateDef dependency;
* scheduled mutation;
* event mutation;
* effect-outcome mutation;
* SQLite contention;
* concurrent startup;
* 1/2/8 authority equivalence.

---

# 187. REAL-PROCESS TRIAL TARGETS

Recommended minimum full release counts:

```text
snapshot/handoff race                 50
remote commit/live delivery           50
reconnect different authority         50
owner crash/reclaim                   25
stale-owner resurrection              25
duplicate delivery                    50
lost-wakeup recovery                  50
mixed-build resume refusal            25
policy removal under failover         25
SQLite many-writer/live-reader        50
slow-consumer/coalescing              25
1/2/8 authority equivalence           25 each
```

Use real OS processes for distributed cases.

---

# 188. BLIND EXTERNAL VALIDATION

After publishing `0.13.0-alpha.1`, run a cold external test from a new project.

The external tester receives:

* published packages;
* shipped docs;
* public types;
* public conformance fixtures.

It does NOT receive:

* source repository;
* internal implementation report;
* internal test rationale;
* private architecture notes.

The tester should attempt to falsify the primary live-query invariant.

---

# 189. EXTERNAL QUESTIONS

Blind tester MUST answer at least:

1. Can live capability be discovered without source?
2. Is QueryDef still canonical?
3. Is transport absent from application semantics?
4. Can initial snapshot lose a concurrent commit?
5. Can a remote authority commit be missed permanently?
6. Can reconnect occur through another authority?
7. Can stale owner advance live position?
8. Can duplicate delivery corrupt result?
9. Can lost delivery go undetected?
10. Can out-of-order delivery corrupt result?
11. Can replay recover?
12. Can replay gap reset safely?
13. Can slow consumer cause unbounded growth?
14. Can policy changes leak unauthorized rows?
15. Can another principal reuse a cursor?
16. Can another QueryDef reuse a cursor?
17. Can same-schema/different-semantic build resume?
18. Does presentation-only change remain compatible?
19. Do ordering/limit queries remain correct?
20. Do aggregates remain correct?
21. Do relationship changes invalidate correctly?
22. Do StateDef changes invalidate correctly?
23. Do scheduled/event/effect-outcome changes propagate?
24. Does lost broadcast/wakeup affect correctness?
25. Does SQLite leak provider-native contention?
26. Does 1/2/8 authority execution preserve live meaning?
27. Does application require Redis?
28. Does application require locks?
29. Does application require manual polling?
30. Does application require manual diffing?
31. Does application require sticky routing?
32. Does application require WebSocket logic?
33. Are physical delivery guarantees described honestly?
34. Is cursor integrity fail-closed?
35. Is authorization re-evaluated on reconnect?
36. Is provider capability fallback discoverable?
37. Are live-ineligible QueryDefs diagnosed explicitly?
38. Are runtime semantics inspectable through AgentAPI?
39. Are conformance fixtures portable?
40. Can the tester falsify topology transparency?

---

# 190. SUCCESS CRITERIA

0.13 succeeds only if:

```text
D1
E1
S1
```

and all release blockers are zero.

Internal green tests are necessary but not sufficient.

---

# 191. FREEZE RULE

After published 0.13 receives external:

```text
D1 / E1 / S1
```

mark:

```text
Axiom 0.13
Realtime / Live Canonical Queries
EXTERNALLY VALIDATED
```

and freeze its semantic model.

Corrective patch releases remain allowed for genuine defects.

Do not continue feature expansion under 0.13 after validation.

---

# 192. DEFERRED

Explicitly defer unless implementation demonstrates they are required for correctness:

* production PostgreSQL CDC;
* Redis pub/sub provider;
* DynamoDB Streams;
* Kafka;
* global ordering across subscriptions;
* audit/event-stream semantics;
* physical exactly-once network delivery;
* arbitrary offline history;
* distributed materialized-view engine;
* CRDT query results;
* multi-region consensus;
* GraphQL subscriptions compatibility;
* automatic client UI binding;
* workflow semantics;
* field-level authorization completion;
* production Rust/Kotlin runtime.

---

# 193. RELATION TO 0.14+

0.13 must not absorb later roadmap items.

0.14 Durable Workflows may consume live-query/event semantics but is separate.

0.15 Authorization Completeness may deepen field/record/operation authorization; 0.13 must correctly preserve the authorization semantics that exist now.

0.16 Tooling/Explainability may generalize the explain surfaces introduced here.

0.17 Independent Runtime will use portable live-query conformance as part of cross-runtime proof.

---

# 194. CROSS-RUNTIME PRINCIPLE

A future independent runtime must be able to implement live queries from:

```text
portable graph / Server IR
+
public live-query semantic contract
+
portable conformance fixtures
```

without reading the TypeScript runtime.

Therefore avoid normative dependence on:

* JavaScript event loop ordering;
* Promise scheduling;
* Node streams;
* object reference identity;
* V8 serialization;
* Socket.IO semantics.

---

# 195. FINAL PRINCIPLE

A live query is not:

```text
a WebSocket
a database change feed
a Redis channel
a polling loop
a stream of table mutations
```

It is:

```text
a persistent semantic observation
of a canonical Axiom QueryDef
```

The runtime may poll.

The provider may push.

The server may reconnect.

The owning authority may crash.

Updates may be replayed.

Intermediate revisions may be coalesced.

A reset may replace an incremental delta.

But at every externally observable point, the consumer's live result must remain explainable as:

```text
the authorized result of this QueryDef
at an authoritative committed revision
```

and changing the number or identity of healthy compatible Axiom authorities must not change that meaning.
