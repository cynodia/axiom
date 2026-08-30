# Axiom 0.13.1 Specification
## Live Query Invalidation Coherence Hardening

**Status:** Corrective release specification  
**Target:** `@cynodia/axiom 0.13.1-alpha.1`  
**Baseline:** `0.13.0-alpha.1` — Realtime / Live Canonical Queries  
**Reason:** Phase 21 blind external regression returned `D2 / E1 / S3`  
**Target classification:** B — LIVE CANONICAL QUERIES  
**Required external verdict:** `D1 / E1 / S1`  
**Server IR:** retain `axiom.server.v7` unless portable semantic vocabulary actually changes  
**Conformance:** retain `axiom.conformance.v7` unless fixture vocabulary must change

---

# 1. PURPOSE

Axiom 0.13.1 is a corrective hardening release for Realtime / Live Canonical Queries.

It MUST NOT introduce a second live-query semantic model.

It MUST preserve the 0.13 principle:

> A live query is a persistent semantic observation of an ordinary canonical `QueryDef`.

0.13.1 exists to repair two defects discovered by the Phase 21 blind external regression:

1. provider-record commits are not observable cross-authority by the live-query invalidation mechanism;
2. QueryDef StateDef references are inconsistently validated, analyzed, and executed.

The primary corrected invariant is:

> Every committed Axiom mutation capable of changing canonical query meaning MUST become observable to every compatible authority responsible for live-query evaluation, independent of which persistence surface the mutation touched.

---

# 2. EXTERNAL VALIDATION BASELINE

Phase 21 tested the published `0.13.0-alpha.1` packages from a fresh external consumer.

Result:

```text
Discoverability:   D2
Semantic Escape:   E1
Safety:            S3

Verdict:
NOT EXTERNALLY VALIDATED
DO NOT FREEZE
```

The external test otherwise confirmed the majority of the 0.13 model:

- canonical delta semantics;
- insert/remove/update/move/reset;
- live fold equals fresh one-shot QueryDef;
- cursor integrity;
- cursor context binding;
- mixed-build fail-closed;
- reconnect through arbitrary compatible authorities;
- real `SIGKILL` recovery;
- no-gap initial handoff;
- bounded slow-consumer handling;
- aggregate reset semantics;
- principal isolation;
- parameter isolation;
- ReadPolicy add/remove;
- transport independence;
- SQLite lost-write correction;
- conformance v7;
- 0.12 distributed-authority regression;
- 0.12.1 StateDef coherence regression;
- zero raw SQLite leakage;
- zero application semantic escape.

0.13.1 MUST preserve all of these.

---

# 3. FINDING F1 — PROVIDER-RECORD INVALIDATION GAP

Phase 21 demonstrated that a provider-record mutation committed through an Axiom action can change a canonical `QueryDef` result without advancing the durable revision observed by remote live-query authorities.

Observed:

```text
provider-record-only mutation:

Authority A:
    commits provider-record mutation

Authority B:
    serves affected live QueryDef

Result:
    0 / 50 remote observations
```

Control:

```text
provider-record + StateDef mutation:

Authority A:
    commits provider-record mutation
    commits StateDef mutation

Authority B:
    observes persistence.revision() advance
    re-evaluates QueryDef

Result:
    50 / 50 remote observations
    median approximately 107 ms
```

Topology workload:

```text
1 authority:
    25 / 25 correct

2 authorities:
    15 / 25 correct

8 authorities:
    0 / 10 correct
```

The live result therefore depends on whether the authority serving the query happens to be the authority that performed the provider-record mutation.

This violates the primary 0.13 topology invariant.

---

# 4. F1 IS RELEASE-BLOCKING

F1 triggers at least these 0.13 release blockers:

```text
committed remote change can remain permanently invisible

observable meaning changes with authority topology
```

This is not an acceptable documented limitation.

The documented limitation for arbitrary writes outside Axiom does not apply.

The failing mutations are:

```text
Axiom ActionDef
    ↓
canonical provider-record Location
    ↓
DataProvider mutation
    ↓
successful Axiom commit
```

They are part of Axiom's canonical write model.

---

# 5. FINDING F2 — QUERYDEF / STATEDEF SCOPE INCONSISTENCY

Phase 21 also found that a QueryDef filter containing a StateDef reference currently has contradictory public semantics.

A graph containing conceptually:

```text
QueryDef:
    filter:
        ref(StateDef)
```

currently:

```text
validateGraph
    → accepts

queryDependencies
    → reports StateDef dependency

AgentAPI.analyzeLiveQuery
    → reports live-capable
    → reports StateDef dependency

QueryDef execution
    → does not bind StateDef into QueryDef execution scope
    → silently evaluates incorrectly
```

The observed query returned an empty result regardless of the StateDef value.

This prevented natural validation of the StateDef-dependent live-query case.

---

# 6. F2 CORRECTIVE POLICY

0.13.1 MUST NOT silently expand QueryDef semantics merely to make the test pass.

Unless existing canonical QueryDef semantics already explicitly define StateDef references inside QueryDef expressions, the corrective behaviour MUST be:

```text
QueryDef direct StateDef reference
    → validation error
```

with a structured diagnostic.

The following components MUST agree:

```text
validateGraph
compiler
QueryDef execution
queryDependencies
queryLiveCapability
AgentAPI.analyzeLiveQuery
```

No public layer may advertise a dependency that canonical QueryDef execution cannot evaluate.

---

# 7. NON-GOALS

0.13.1 MUST NOT add:

- new graph node kinds;
- `LiveQueryDef`;
- `RealtimeQueryDef`;
- durable live-query history;
- generic CDC;
- Redis;
- Kafka;
- WebSocket semantics;
- sticky routing;
- leader election;
- production distributed materialized views;
- arbitrary external-database observation;
- new QueryDef expression scope;
- generic StateDef access from QueryDef filters;
- new delivery guarantees;
- exactly-once network delivery;
- global ordering;
- workflow semantics.

This is a corrective release.

---

# 8. PRIMARY CORRECTED INVARIANT

For any canonical query `Q`, principal `P`, arguments `A`, and committed Axiom mutation `M`:

```text
if:

    M can change executeQuery(Q, P, A)

then:

    every compatible authority serving Q
    MUST eventually become aware that canonical observable meaning may have changed
```

subject to the documented:

- polling interval;
- coalescing;
- backpressure;
- reset;
- delivery semantics.

The invariant MUST NOT depend on which authority executed `M`.

---

# 9. MUTATION-SURFACE INVARIANT

Live-query invalidation correctness MUST NOT depend on whether a transaction modifies:

```text
StateDef only

provider records only

StateDef + provider records

relationship-relevant provider records

ReadPolicy-relevant provider records
```

If the committed mutation can affect canonical query meaning, the mutation must participate in the observable invalidation mechanism.

---

# 10. TOPOLOGY INVARIANT

The 0.13 topology invariant remains:

```text
observableLiveMeaning(
    execute(G, oneAuthority)
)
==
observableLiveMeaning(
    execute(G, NAuthorities)
)
```

for identical committed semantic history.

0.13.1 MUST specifically prove this invariant for:

```text
provider-record-only workloads
```

because that is the path falsified by Phase 21.

---

# 11. DESIGN GATE G1 — AUTHORITATIVE OBSERVABLE REVISION

Before implementation, explicitly define the monotonic durable quantity observed by live-query invalidation.

The implementation MUST NOT continue relying on the accidental assumption:

```text
persistence.revision()
==
revision of all canonical Axiom mutations
```

unless that statement is made architecturally true.

The design note MUST answer:

> What durable monotonic value means "canonical observable application meaning may have changed"?

For this specification, call that concept:

```text
ApplicationRevision
```

This name is conceptual.

The final public/internal name may differ.

---

# 12. APPLICATION REVISION SEMANTICS

Conceptually:

```text
ApplicationRevision R
```

represents the commit ordering relevant to canonical observable application meaning.

It MUST advance for every successful Axiom commit that may affect canonical query results.

At minimum:

```text
StateDef mutation
provider-record mutation
relationship-relevant provider mutation
ReadPolicy-relevant provider mutation
mixed StateDef/provider mutation
```

must become observable through this mechanism.

---

# 13. PREFERRED ARCHITECTURE — ONE OBSERVABLE COMMIT DOMAIN

The preferred architecture is:

```text
                    ┌─ StateDef mutation
                    │
Axiom transaction ──┼─ provider-record mutation
                    │
                    └─ both
                           │
                           ▼
                 committed semantic change
                           │
                           ▼
                  ApplicationRevision
                           │
                           ▼
          all authorities can observe advancement
```

Live-query correctness should consume this shared semantic commit signal.

---

# 14. DO NOT INTRODUCE ACCIDENTAL DUAL CLOCKS

Avoid solving F1 by casually creating:

```text
stateRevision
dataRevision
```

and asking every consumer to compare both independently.

That architecture creates unresolved questions:

```text
Which revision orders mixed commits?

What does a live-query cursor mean?

What does cache revision mean?

How are StateDef + provider-record transactions represented?

What happens if stateRevision advances but dataRevision does not?

What happens if dataRevision advances but stateRevision does not?

How does a future runtime compare them?

How does cross-runtime conformance define ordering?
```

If multiple provider-local generations are unavoidable, the implementation MUST define a coherent composite semantic revision model rather than exposing unrelated clocks as one logical revision.

---

# 15. ALTERNATIVE ARCHITECTURE REQUIRES JUSTIFICATION

An implementation MAY use a provider-local observable generation, such as:

```text
DataProvider.generation()
```

only if the design note proves:

- no committed provider mutation can be permanently missed;
- mixed StateDef/provider transactions remain coherent;
- cursor semantics remain unambiguous;
- dependency observation remains correct;
- topology invariance holds;
- crash windows are closed;
- future independent runtimes can implement the same semantics.

The implementation report MUST explain why this is preferable to one application-level revision.

---

# 16. DESIGN GATE G2 — ATOMICITY

The invalidation signal MUST NOT have a crash gap.

Forbidden implementation:

```text
1. commit provider record
2. process crashes
3. increment ApplicationRevision
```

because after step 2:

```text
canonical query meaning changed

but

remote authorities have no durable evidence
```

This reproduces F1 in a narrower crash window.

---

# 17. ATOMICITY REQUIREMENT

For every committed mutation that can affect query meaning, one of the following MUST hold:

### Model A — same atomic transaction

```text
provider mutation
+
observable revision advancement

commit atomically
```

### Model B — provider-owned durable generation

The provider mutation atomically advances a provider-owned durable generation that the live-query engine observes.

### Model C — recoverable durable invalidation intent

The mutation atomically creates enough durable intent that recovery guarantees eventual observable invalidation.

Other implementations are permitted only if they provide equivalent crash safety.

---

# 18. NO BEST-EFFORT INVALIDATION

The following is insufficient:

```text
commit
then notify
```

if notification can be permanently lost.

Likewise:

```text
commit
then increment process-local counter
```

is insufficient.

And:

```text
commit
then broadcast
```

is insufficient.

The correctness signal must be durable or recoverable.

---

# 19. BROADCAST REMAINS OPTIONAL

0.13's principle remains:

```text
broadcast/pub-sub/wakeup
    MAY improve latency

broadcast/pub-sub/wakeup
    MUST NOT be required for correctness
```

0.13.1 MUST NOT fix F1 by adding a mandatory cross-process broadcast channel.

---

# 20. POLLING REMAINS VALID

Framework-owned polling remains a valid reference implementation.

Conceptually:

```text
lastObservedApplicationRevision = R

poll

currentApplicationRevision = R+1

if changed:
    determine affected live queries
    re-evaluate as required
```

The application MUST NOT implement this polling itself.

---

# 21. OBSERVABLE REVISION MUST BE DURABLE

If an authority dies after committing provider data, a newly started authority must still be able to determine that the canonical data is at the newer observable revision.

The signal MUST NOT live only in:

- memory;
- event emitter;
- socket;
- process-local cache;
- temporary worker state.

---

# 22. OBSERVABLE REVISION MUST BE MONOTONIC

For one authoritative persistence domain:

```text
R0 < R1 < R2 < ... < Rn
```

Successful committed semantic mutations MUST NOT cause revision regression.

Authorities MUST NOT independently generate conflicting revision histories.

---

# 23. REVISION ADVANCES ONLY ON COMMIT

A failed transaction MUST NOT publish an authoritative revision advancement corresponding to speculative semantic state.

A losing optimistic transaction:

```text
attempts mutation
fails commit
```

must not cause live consumers to observe a semantic change that never committed.

Conservative re-evaluation caused by a harmless extra wakeup is acceptable.

Publishing speculative state is not.

---

# 24. MIXED STATE + PROVIDER TRANSACTION

Explicitly test an ActionDef transaction that mutates:

```text
StateDef
+
provider record
```

The resulting observable commit semantics MUST be coherent.

A remote authority MUST NOT observe a semantic revision in which only one half of a logically atomic Axiom transaction is considered committed if the existing Axiom transaction contract says they commit together.

If the current architecture does not provide true atomicity across these persistence surfaces, the implementation report MUST state the exact existing transaction semantics and prove live-query observation does not overclaim them.

---

# 25. PROVIDER-RECORD WRITE PATHS

Audit every canonical provider-record mutation path.

At minimum inspect:

```text
create
insert
update
delete
provider-record Location writes
relationship-affecting mutations
bulk operations if supported
ActionDef-mediated provider writes
```

Every successful path capable of changing a QueryDef result must participate in invalidation.

Do not fix only the exact mutation used by Phase 21.

---

# 26. DELETE INVALIDATION

Provider-record deletion MUST advance or otherwise participate in observable invalidation.

Example:

```text
live query:
    open orders

Authority A:
    deletes matching order

Authority B:
    serves live query
```

B must eventually remove the row.

---

# 27. INSERT INVALIDATION

Provider-record insertion MUST participate.

Example:

```text
Authority A:
    inserts matching record

Authority B:
    live query
```

B must eventually include it.

---

# 28. UPDATE INVALIDATION

Provider-record update MUST participate even when:

- membership changes;
- projection changes;
- ordering changes;
- limit boundary changes;
- ReadPolicy visibility changes;
- relationship-dependent meaning changes.

---

# 29. NO-OP MUTATIONS

If a provider operation succeeds but produces no semantic data change, the implementation MAY:

```text
advance ApplicationRevision
```

or avoid doing so.

Either is acceptable if correctness remains intact.

False-positive invalidation is acceptable.

False-negative invalidation is not.

---

# 30. CONSERVATIVE INVALIDATION REMAINS VALID

0.13 dependency analysis remains conservative.

If the runtime knows:

```text
something canonical changed
```

but cannot determine whether query Q is affected, it MUST prefer:

```text
re-evaluate Q
```

over leaving Q stale.

---

# 31. DEPENDENCY ANALYSIS DOES NOT REPLACE REVISION OBSERVABILITY

`queryDependencies()` answers:

```text
could this change affect this query?
```

It does NOT answer:

```text
did any remote change happen?
```

0.13.1 must provide both:

```text
durable change observation
+
dependency filtering
```

Do not attempt to repair F1 only by modifying dependency analysis.

---

# 32. DATA PROVIDER CONTRACT

If fixing F1 requires a DataProvider contract change, it must remain provider-independent.

Potential concepts include:

```text
observeRevision()
generation()
commitRevision
mutationGeneration
```

but the final API MUST describe semantic capability rather than SQLite implementation.

Forbidden public semantic concepts:

```text
WAL sequence
SQLite rowid
SQLite transaction id
Redis sequence
Postgres LSN
Dynamo stream offset
```

Provider-specific mechanisms remain infrastructure.

---

# 33. PROVIDER CAPABILITY

If not every DataProvider can support cross-authority observable mutation generation, add an explicit capability rather than silently claiming correctness.

Conceptually:

```text
observable-mutation-generation
```

or equivalent.

A distributed live query requiring this capability MUST fail explicitly when the provider cannot supply the required correctness.

Do not silently degrade to stale results.

---

# 34. MEMORY PROVIDER

The memory provider remains the single-process semantic reference.

It MAY implement ApplicationRevision in memory.

It MUST NOT claim cross-process durability.

Its observable semantics should otherwise match SQLite.

---

# 35. SQLITE REFERENCE IMPLEMENTATION

SQLite remains the real cross-process reference provider.

The SQLite implementation MUST make provider-record commits observable to other OS processes.

The implementation must survive:

- concurrent readers;
- concurrent writers;
- independent connections;
- process crash;
- process restart;
- authority replacement.

---

# 36. SQLITE ATOMICITY

Where SQLite stores both the provider mutation and observable revision metadata in the same database/transaction, prefer:

```text
BEGIN IMMEDIATE

validate optimistic revision
perform provider mutation
advance observable revision

COMMIT
```

or an equivalent atomic structure.

Do not perform the observable-revision advancement after commit.

---

# 37. SQLITE LOST-WRITE FIX MUST REMAIN

0.13 fixed a separate defect where optimistic concurrency was checked outside `BEGIN IMMEDIATE`.

0.13.1 MUST preserve:

```text
optimistic concurrency check
inside
the write transaction
```

No regression is permitted.

---

# 38. SQLITE CONTENTION

Reuse the existing structured SQLite contention handling.

Normal supported concurrency MUST NOT leak:

```text
SQLITE_BUSY
SQLITE_LOCKED
ERR_SQLITE_ERROR
"database is locked"
```

to application semantics.

Do not create a second contention mechanism for ApplicationRevision.

---

# 39. CONCURRENT STARTUP

If new revision metadata/schema is introduced, concurrent process initialization MUST be contention-safe.

Test:

```text
2 authorities
4 authorities
8 authorities
```

starting simultaneously against a fresh SQLite database.

---

# 40. REVISION METADATA INITIALIZATION

Fresh database initialization must produce a deterministic initial observable revision.

Conceptually:

```text
ApplicationRevision = 0
```

The exact value is not important.

Properties are:

- deterministic;
- monotonic thereafter;
- identical across authorities;
- durable.

---

# 41. EXISTING DATABASE UPGRADE

0.13.1 must define behaviour for a database created by `0.13.0-alpha.1`.

If new provider metadata is required, startup MUST initialize it safely without corrupting existing canonical data.

Because this is an alpha line, migration policy may remain simple, but behaviour must be explicit and tested.

Do not silently interpret existing provider records as though their historical revision is known when it is not.

---

# 42. APPLICATION REVISION AND CACHE COHERENCE

Review the relationship between the new observable revision and existing 0.12 cache revision semantics.

Preferred direction:

```text
canonical query cache
live query invalidation
StateDef coherence where applicable
```

should increasingly consume one coherent notion of authoritative committed application progress.

Do not unnecessarily introduce parallel invalidation truths.

---

# 43. APPLICATION REVISION AND STATEDEF COHERENCE

0.12.1 established:

```text
authority-local StateDef is a cache
persistence is authoritative
persistence.revision() detects remote StateDef commits
```

0.13.1 MUST NOT regress this.

If `ApplicationRevision` supersedes or generalizes the existing revision:

- StateDef coherence must remain correct;
- `coherentSnapshot()` must remain correct;
- local authoritative revision must remain monotonic;
- conflict recovery must remain correct.

---

# 44. DO NOT CONFUSE STATE REVISION WITH APPLICATION REVISION

If implementation retains both concepts internally, document their distinction.

For example:

```text
StateRevision
    orders StateDef persistence changes

ApplicationRevision
    signals any canonical mutation relevant to observable application meaning
```

If both exist, the public/runtime contracts must not accidentally compare them as though they were the same numeric domain unless they truly are.

---

# 45. LIVE QUERY POLL LOOP

The live-query engine must poll the corrected authoritative signal.

The old failing model:

```text
poll persistence.revision()

provider-only mutation:
    persistence.revision unchanged

therefore:
    no re-evaluation
```

must no longer exist.

Correct conceptual behaviour:

```text
poll observable application revision

provider-only mutation:
    revision advances

therefore:
    candidate live queries considered
```

---

# 46. POLL INTERVAL

`liveQueryPollMs` remains infrastructure configuration.

Default may remain:

```text
250 ms
```

unless implementation evidence requires change.

0.13.1 is not a latency-tuning release.

Correctness matters, not shaving polling milliseconds.

---

# 47. LOCAL FAST PATH

A local authority MAY wake its live-query engine immediately after a local provider mutation.

This remains an optimization.

The same mutation MUST also be durably discoverable by remote authorities.

Local wakeup cannot be the only signal.

---

# 48. CROSS-AUTHORITY PROVIDER-ONLY REGRESSION

Permanent regression test:

```text
A and B start
shared SQLite provider/persistence

B:
    opens live QueryDef Q
    receives initial result at R

A:
    commits provider-record-only mutation M
    M changes Q

B:
    receives update/reset
```

No StateDef mutation may be included.

No manual wakeup may be included.

No explicit reload may be included.

No reconnect may be included.

No helper may advance the old StateDef revision merely to make the test pass.

---

# 49. EXACT F1 EXTERNAL REPRO

Recreate the Phase 21 failing arm as closely as possible.

Required target:

```text
0.13.0:
    0 / 50 observed

0.13.1:
    50 / 50 observed
```

Use real OS processes.

Use independent SQLite connections.

Use provider-record-only writes.

---

# 50. F1 BACKLOG-FLUSH REGRESSION

0.13.0 demonstrated that stale provider mutations could suddenly appear when a later StateDef mutation advanced the observed revision.

Construct:

```text
A:
    provider mutation P1

B:
    remains stale

A:
    provider mutation P2

B:
    remains stale

A:
    StateDef mutation S1
```

0.13.1 expected:

```text
B observes P1 without requiring S1
B observes P2 without requiring S1
```

There must be no hidden backlog waiting for an unrelated StateDef "sync pulse".

---

# 51. MULTIPLE PROVIDER-ONLY COMMITS

Perform:

```text
R0
provider commit 1
provider commit 2
provider commit 3
...
provider commit N
```

without StateDef writes.

Remote live query must converge.

Coalescing is allowed.

It is not required to deliver every intermediate revision.

Final live result must equal fresh one-shot QueryDef.

---

# 52. PROVIDER-ONLY 1/2/8 TOPOLOGY TEST

Re-run the Phase 21 topology workload using only provider-record mutations.

Required:

```text
1 authority:
    correct

2 authorities:
    correct

8 authorities:
    correct
```

Run the identical graph and semantic workload.

No topology-specific graph changes.

No sticky writer.

No sticky live-query authority.

---

# 53. RANDOM ROUTING

With 8 authorities:

```text
random authority performs each provider mutation
random authority serves live query
random authority serves one-shot oracle
```

After each committed mutation or bounded coalescing interval:

```text
folded live result
==
fresh one-shot QueryDef result
```

---

# 54. INSERT / UPDATE / DELETE MATRIX

Cross-authority provider-only tests MUST include:

```text
insert
update
delete
```

Each must independently wake/re-evaluate affected remote live queries.

---

# 55. FILTER MEMBERSHIP MATRIX

Provider-only remote mutation:

```text
closed → open
open → closed
```

for:

```text
status == open
```

Remote live result must add/remove correctly.

---

# 56. ORDERING MATRIX

Provider-only remote mutation changes an ordering key.

Remote live result must reorder correctly.

Canonical move quality from 0.13 must remain unchanged.

---

# 57. LIMIT BOUNDARY MATRIX

Query:

```text
ORDER BY score DESC
LIMIT 10
```

Provider-only remote mutation moves item #11 to #3.

Remote result must:

```text
include promoted row
remove previous boundary row
retain size 10
retain canonical order
```

---

# 58. AGGREGATE MATRIX

Provider-only remote mutation affects a reset-only aggregate query.

Expected:

```text
remote authority observes mutation
re-evaluates
emits reset
fresh aggregate == live aggregate
```

---

# 59. READPOLICY MATRIX

Provider-only remote mutation changes data used by `ReadPolicy`.

Cases:

```text
visible → invisible
invisible → visible
```

Remote live query must update authorization-correct result.

Unauthorized data remaining indefinitely visible is release-blocking.

---

# 60. RELATIONSHIP MATRIX

Where QueryDef meaning depends on relationships:

provider-only remote mutation affecting relationship meaning must invalidate correctly.

False-negative invalidation is release-blocking.

---

# 61. STATEDEF-ONLY REGRESSION

Re-run existing StateDef-only live-query observation paths that are valid under canonical semantics.

0.13.1 must not fix provider records by breaking StateDef revision observation.

---

# 62. MIXED STATE + PROVIDER REGRESSION

Run ActionDef transaction containing both mutation classes where supported.

Remote authority must converge to the committed semantic result.

No duplicate invalidation requirement exists.

Multiple harmless re-evaluations are acceptable.

---

# 63. SCHEDULE-DRIVEN PROVIDER MUTATION

A scheduled action on authority A performs provider-record-only mutation.

Live query on B must update.

This proves invalidation follows committed semantics rather than client request path.

---

# 64. EVENT-DRIVEN PROVIDER MUTATION

External event accepted on A triggers provider-record-only mutation.

Live query on B must update.

0.12 event dedup semantics must remain intact.

---

# 65. EFFECT-OUTCOME PROVIDER MUTATION

Where an effect outcome causes provider-record mutation:

remote live query must observe the committed result.

No special client-write assumption.

---

# 66. LOSING PROVIDER TRANSACTION

Race two provider mutations.

If one transaction loses optimistic concurrency:

```text
loser MUST NOT produce committed semantic state

live query MUST NOT expose speculative loser state
```

An extra harmless re-evaluation is acceptable.

---

# 67. CRASH BEFORE PROVIDER COMMIT

Kill process before commit.

Expected:

```text
no committed provider change
no required semantic live update
```

---

# 68. CRASH AFTER PROVIDER COMMIT

Kill process immediately after provider commit returns/linearizes.

Remote authority MUST eventually observe the change.

This is a critical atomicity test.

Run enough trials to attack the exact commit/invalidation boundary.

---

# 69. CRASH BETWEEN INTERNAL STEPS

If implementation internally separates:

```text
provider write
revision metadata update
```

the test suite MUST inject crash at every boundary.

There must be no boundary producing:

```text
committed provider meaning
+
permanently unobservable revision
```

---

# 70. PROCESS RESTART

After provider-only commit:

```text
kill writer
kill live-query authority
start fresh authority C
```

C must:

- load current canonical provider data;
- observe correct revision/generation state;
- serve correct initial live result.

---

# 71. LOST OPTIONAL WAKEUP

Disable/drop any optional local notification.

Provider-only commit on A.

B must still update through durable observation.

Run at least:

```text
50 trials
```

---

# 72. DUPLICATE OPTIONAL WAKEUP

Generate duplicate invalidation notification if such optimization exists.

Expected:

- no duplicate logical rows;
- no corrupt delta;
- final result equals fresh query.

---

# 73. HIGH REVISION JUMP

Allow many provider-only commits between B's polls.

Example:

```text
B observed R10

A/C/D perform many commits

B next observes R100
```

B may coalesce.

It must converge to canonical current result.

It need not replay every revision.

---

# 74. SLOW LIVE CONSUMER

Provider-only mutations must continue to interact correctly with existing bounded slow-consumer semantics.

Generate provider commits faster than consumer reads.

Expected:

```text
bounded queue
coalescing/reset
eventual correct result
```

No unbounded memory.

---

# 75. QUERY CACHE INTERACTION

If provider-backed one-shot QueryDef results are cached, provider-only observable revision advancement must prevent stale cache from poisoning live re-evaluation.

Test:

```text
B evaluates Q
cache populated

A provider-only mutation

B live re-evaluates
```

Expected current result, not cached pre-mutation result.

---

# 76. F2 — VALIDATION REQUIREMENT

Direct StateDef references in QueryDef expressions that are not part of canonical QueryDef execution scope MUST fail validation.

Introduce a structured diagnostic.

Preferred conceptual code:

```text
QUERY_STATE_REF_NOT_ALLOWED
```

Exact name may differ if an existing diagnostic taxonomy is more appropriate.

Do not throw `TypeError`.

Do not silently accept.

---

# 77. F2 — QUERYDEPENDENCIES REQUIREMENT

For an invalid QueryDef containing unsupported StateDef reference:

`queryDependencies()` MUST NOT advertise that the query is validly dependent on that StateDef.

Acceptable behaviours:

```text
validation prevents dependency analysis

or

dependency analysis returns invalid/unsupported reference information
```

Forbidden:

```text
live-capable
state dependency = yes
```

for a query that cannot execute that dependency.

---

# 78. F2 — LIVE CAPABILITY REQUIREMENT

`queryLiveCapability()` MUST agree with validation.

An invalid QueryDef must not be reported as:

```text
live-capable
```

It may report:

```text
not-live-capable
reason: invalid QueryDef
```

if called independently.

---

# 79. F2 — AGENTAPI REQUIREMENT

`AgentAPI.analyzeLiveQuery(queryId)` MUST NOT tell an agent that an unsupported StateDef-ref QueryDef is live-capable.

AgentAPI must expose the same semantic truth as validation/compiler/runtime.

---

# 80. F2 — COMPILER REQUIREMENT

Compiler must fail explicitly for unsupported QueryDef StateDef references.

It must not compile a graph that runtime later evaluates with missing binding.

---

# 81. F2 — EXECUTION REQUIREMENT

Runtime must never silently interpret an unresolved StateDef reference as:

```text
undefined
null
false
empty result
```

If malformed/invalid IR somehow reaches runtime, fail explicitly.

Do not produce a plausible but wrong QueryDef result.

---

# 82. F2 — READPOLICY DISTINCTION

If StateDef references are valid in an existing server-side `ReadPolicy` scope, preserve them there.

The fix MUST distinguish:

```text
QueryDef expression scope
```

from:

```text
ReadPolicy expression scope
```

Do not globally ban StateDef references if other established semantic scopes legitimately support them.

---

# 83. F2 — NO SEMANTIC EXPANSION

0.13.1 MUST NOT add direct StateDef QueryDef binding merely because it would make Phase 21 §51 easy to test.

That would change the QueryDef semantic model.

Such a feature belongs in a future feature release if desired.

0.13.1 should make the existing boundary explicit and consistent.

---

# 84. F2 PERMANENT REGRESSION

Create graph:

```text
StateDef:
    threshold

QueryDef:
    filter references threshold directly
```

Expected:

```text
validateGraph:
    structured rejection

compiler:
    refuses

AgentAPI:
    does not advertise live capability

runtime:
    cannot silently execute wrong result
```

---

# 85. VALID QUERY CONTROL

Create a normal valid provider-backed QueryDef.

Expected unchanged:

```text
validate
compile
one-shot execute
live execute
dependency analysis
AgentAPI
```

This proves F2 fix did not over-reject QueryDef expressions generally.

---

# 86. READPOLICY STATEDEF CONTROL

If existing canonical semantics permit ReadPolicy to reference StateDef:

construct:

```text
QueryDef:
    ordinary provider query

ReadPolicy:
    valid StateDef dependency
```

Expected existing behaviour remains valid.

Remote commits affecting that StateDef must continue to update authorization meaning through existing coherence mechanisms.

---

# 87. DISCOVERABILITY CORRECTION

Phase 21 classified 0.13 as D2 partly because shipped public surfaces contradicted runtime semantics around F2.

0.13.1 documentation MUST explicitly state:

```text
which expression scopes QueryDef supports

whether QueryDef may directly reference StateDef

how live invalidation observes provider-record commits

what revision/generation liveQueryPollMs observes
```

Target external classification:

```text
D1
```

---

# 88. LIVE_QUERIES DOCUMENTATION

Update `LIVE_QUERIES.md` or canonical equivalent.

It MUST explain:

1. provider-record commits made through Axiom are in scope;
2. such commits are observable cross-authority;
3. arbitrary out-of-band database writes remain out of scope unless provider explicitly supports them;
4. framework-owned polling is the reference correctness mechanism;
5. optional wakeups are latency optimizations;
6. QueryDef direct StateDef reference scope;
7. ReadPolicy distinction if applicable;
8. reset/coalescing semantics remain unchanged.

---

# 89. AGENT REFERENCE

Update machine-oriented documentation.

A cold agent should be able to answer:

```text
Does an Axiom provider-record mutation wake a live query on another authority?

What durable signal makes that possible?

Does the application need Redis?

Does the application need broadcast?

Can QueryDef directly reference StateDef?

Can ReadPolicy reference StateDef?

Are arbitrary external DB writes observed?
```

without source inspection.

---

# 90. ANTI-PATTERNS

Add anti-patterns equivalent to:

### Anti-pattern — provider mutation without observable revision

```text
write provider data
assume local live query wakeup is enough
```

Why wrong:

```text
remote authority may remain permanently stale
```

### Anti-pattern — advertise dependencies runtime cannot bind

```text
dependency analyzer accepts StateDef ref
runtime QueryDef scope cannot evaluate it
```

Why wrong:

```text
analysis becomes more permissive than semantics
```

### Anti-pattern — repair distributed invalidation with mandatory pub/sub

Why wrong:

```text
correctness becomes dependent on best-effort notification infrastructure
```

---

# 91. SERVER IR

Preferred outcome:

```text
axiom.server.v7
```

remains unchanged.

Reason:

F1 is runtime/provider coherence infrastructure.

F2 should narrow validation to the semantics already represented by existing IR.

No new portable graph vocabulary is expected.

If implementation discovers that IR changes are necessary, stop and document why before introducing v8.

---

# 92. SEMANTIC FINGERPRINT

Expected:

```text
semanticFingerprint unchanged
```

for all previously valid graphs.

F1 changes execution infrastructure, not graph meaning.

F2 rejects graphs that were previously accepted but semantically non-executable as advertised.

Do not change semanticFingerprint merely because runtime invalidation implementation changed.

---

# 93. SCHEMA FINGERPRINT

Expected:

```text
schemaFingerprint unchanged
```

for valid graphs.

No schema-model change is intended.

---

# 94. CONFORMANCE VERSION

Preferred:

```text
axiom.conformance.v7
```

remains current.

Add corrective fixtures to v7 only if the project's conformance policy permits additive fixture growth without changing the contract identity.

Otherwise create the smallest appropriate corrective conformance tier.

Do not bump conformance mechanically.

Document the decision.

---

# 95. PORTABLE F1 CONFORMANCE

Where provider-independent conformance can express it, add a fixture equivalent to:

```text
initial QueryDef result

provider-record mutation

observable revision advancement

re-evaluate

result changes
```

Cross-process polling itself may remain a server/provider test rather than portable core conformance.

---

# 96. PORTABLE F2 CONFORMANCE

Add validation/analysis coverage ensuring unsupported QueryDef StateDef refs are consistently rejected.

This is highly suitable for portable conformance because it defines semantic scope.

---

# 97. NEGATIVE CONTROL

As with prior releases:

modify expected F1/F2 fixture result.

Conformance runner MUST fail.

No vacuous green suite.

---

# 98. OLD CONFORMANCE

All frozen historical conformance surfaces MUST remain intact.

Do not rewrite old fixtures to make 0.13.1 appear green.

---

# 99. EXISTING 0.13 LIVE CONFORMANCE

Re-run all 0.13 live-query conformance fixtures.

Expected:

```text
10 / 10
```

or exact current published count if intentionally extended.

Run both memory and SQLite reference providers where currently supported.

---

# 100. EXISTING CANONICAL DELTA REGRESSION

Re-run:

```text
insert
remove
update
move
reset
```

Verify:

```text
applyDelta(initial, updates)
==
fresh one-shot QueryDef
```

No regression from invalidation changes.

---

# 101. MOVE QUALITY REGRESSION

Preserve 0.13 rule:

```text
move
```

represents genuine relative-order change among surviving rows.

Do not generate moves merely because insertion/removal shifts indexes.

---

# 102. CURSOR REGRESSION

Re-run:

```text
HMAC tamper
wrong query
wrong principal
wrong args
wrong policy
schema incompatibility
semantic incompatibility
contract incompatibility
presentation-only compatibility
```

F1 revision changes MUST NOT accidentally weaken cursor context binding.

---

# 103. RECONNECT REGRESSION

Reconnect through another authority must remain correct.

A fresh reset remains acceptable.

Do not introduce sticky routing while repairing F1.

---

# 104. NO-GAP HANDOFF REGRESSION

Re-run the 0.13 no-gap test:

```text
B begins live open at R

A commits during handoff

B must see commit in:
    initial
or
    later update/reset
```

At least:

```text
50 trials
```

Include provider-record-only commit as a new arm.

---

# 105. STATEDEF COHERENCE REGRESSION

Re-run canonical 0.12.1 sequence:

```text
A + B start at 0

A commits +5

B authoritative read sees 5

B commits +7

A/B converge to 12
```

Then true concurrent race.

No permanent conflict wedge.

---

# 106. SQLITE LOST-WRITE REGRESSION

Preserve strengthened 0.13 race.

Real OS processes.

Same starting revision.

Concurrent writes.

Assert:

```text
final state
==
exact sum of successfully committed operations
```

Target:

```text
0 silent lost writes
```

Run at least:

```text
50 trials
```

---

# 107. SQLITE CONTENTION REGRESSION

Run multiple writers/readers while live queries poll the corrected observable revision.

Target raw leakage:

```text
SQLITE_BUSY       0
SQLITE_LOCKED     0
ERR_SQLITE_ERROR  0
database is locked 0
```

---

# 108. DISTRIBUTED AUTHORITY REGRESSION

Re-run meaningful subsets of:

```text
lease race
lease reclaim
stale-owner fencing
durable-work claim
durable-work crash
effect logical identity
effect uncertain outcome
scheduler race
event dedup
subscription cursor fencing
cache coherence
mixed-build refusal
```

0.13.1 MUST NOT repair live-query invalidation by weakening 0.12 distributed guarantees.

---

# 109. 1 / 2 / 8 FULL REFERENCE APP

Use one unchanged semantic graph.

Include:

```text
provider-backed QueryDef
provider-record writes
ReadPolicy
ordering
limit
aggregate/reset-only query
live query
ordinary ActionDef
```

Run with:

```text
1 authority
2 authorities
8 authorities
```

Randomize request routing.

Required:

```text
final committed state equivalent

fresh QueryDef results equivalent

folded live results equivalent
```

---

# 110. PROVIDER-ONLY REFERENCE APP

In addition to the full app, run a workload intentionally containing:

```text
zero StateDef writes
```

All semantic mutations occur through provider-record Locations.

This is mandatory because StateDef writes masked F1 in 0.13.0.

---

# 111. NO SYNC-PULSE TEST

The provider-only test MUST verify correctness for a substantial period without:

- StateDef mutation;
- reconnect;
- server restart;
- manual snapshot;
- manual refresh;
- manual revision bump.

A remote live query must update naturally.

---

# 112. REAL OS PROCESSES

The following tests MUST use real OS processes:

```text
F1 exact repro
provider-only 1/2/8
crash after provider commit
concurrent startup
SQLite lost-write
mixed-build regression
```

In-process simulation is insufficient.

---

# 113. INDEPENDENT SQLITE CONNECTIONS

Every process must create its own SQLite connection.

Do not share an in-process database handle and call it distributed validation.

---

# 114. REAL FILESYSTEM

Cross-process SQLite tests must run on a filesystem with real inter-process locking.

Record filesystem type.

Use ext4 or equivalent non-memory filesystem for at least the release-critical F1/F1-crash tests when practical.

---

# 115. SIGKILL

Crash tests MUST include actual abrupt termination:

```text
SIGKILL
```

Graceful shutdown alone does not test atomicity gaps.

---

# 116. F1 CRASH MATRIX

At minimum attempt:

```text
before provider mutation

during provider mutation

after provider mutation before transaction commit

immediately after transaction commit

after commit before local wakeup

after local wakeup before next remote poll

during remote re-evaluation
```

For every successful committed provider mutation:

```text
remote live query eventually converges
```

---

# 117. REVISION CONSISTENCY INSPECTION

Add internal/public runtime inspection where appropriate so tests can determine:

```text
last observed application revision
current provider observable revision
```

without exposing provider-specific internals.

Do not expose SQL/WAL implementation details as semantic API.

---

# 118. AGENTAPI LIVE ANALYSIS

`AgentAPI.analyzeLiveQuery(queryId)` should remain graph-derived and portable.

It SHOULD expose enough information to explain:

```text
dependencies
broad invalidation
live capability
reset-only capability
unsupported references
```

Do not make AgentAPI depend on SQLite runtime state.

---

# 119. RUNTIME LIVE INSPECTION

`inspectLiveQueries()` should continue to expose runtime state such as:

```text
logical subscription
last evaluated revision
pending/coalesced state
```

If the observable revision concept changes, inspection terminology must be accurate.

Do not label a StateDef-only revision as "application revision".

---

# 120. PUBLIC TYPE ACCURACY

Published `.d.ts` MUST accurately expose any new provider capability/API needed by 0.13.1.

A blind consumer must not need source inspection to implement a compatible provider.

---

# 121. CUSTOM PROVIDER COMPATIBILITY

If DataProvider interface changes, document upgrade requirements for custom providers.

A custom provider that cannot support distributed observable mutations must fail capability negotiation explicitly where distributed live queries require it.

Do not silently treat it as safe.

---

# 122. SINGLE-AUTHORITY CUSTOM PROVIDER

It may be valid for a provider lacking distributed observable mutation generation to support:

```text
single-authority live queries
```

if local correctness is guaranteed.

If so, capability semantics must distinguish:

```text
single-authority live capable
```

from:

```text
distributed live capable
```

without changing application graph semantics.

Topology capability belongs to host/runtime/provider configuration.

---

# 123. FAIL-CLOSED PROVIDER CAPABILITY

If distributed live queries are started with a provider that cannot guarantee remote mutation observability:

expected:

```text
explicit startup/openLiveQuery failure
```

rather than:

```text
works locally
silently stale remotely
```

---

# 124. NO APPLICATION-FACING TOPOLOGY FLAG

Do not introduce graph semantics such as:

```text
distributed: true
requiresPolling: true
singleWriter: true
stickyAuthority: true
```

The graph owns application meaning.

Provider/runtime capabilities own deployment feasibility.

---

# 125. NO MANUAL INVALIDATE API REQUIREMENT

Application code MUST NOT be required to call:

```text
invalidateLiveQueries()
bumpRevision()
notifyOtherAuthorities()
refreshRemoteQueries()
```

after canonical provider mutation.

Such an API may exist as infrastructure/debugging only if never required for correctness.

Required application usage count:

```text
0
```

---

# 126. NO APP BROADCAST

Application must not need:

```text
Redis publish
WebSocket broadcast
Socket.IO room emit
custom event bus
```

to make provider-record live updates visible remotely.

Target semantic escape remains:

```text
E1
```

---

# 127. NO APP POLLING

Application must not poll:

```text
provider rows
revision metadata
SQLite
```

to repair live queries.

Framework-owned polling is acceptable.

---

# 128. NO APP SQL

Application-level SQL required for F1 correction:

```text
0
```

Provider implementation SQL is infrastructure and does not count as semantic escape.

---

# 129. NO NATIVEOPERATION

`NativeOperation` usages required for 0.13.1 live correctness:

```text
0
```

---

# 130. EXTERNAL DATABASE WRITE SCOPE

Retain the 0.13 limitation:

```text
arbitrary writes performed outside Axiom
```

are not necessarily observed unless the provider explicitly supports external-change observation.

But clearly distinguish them from:

```text
provider-record mutations committed through Axiom
```

which ARE in scope and MUST be observed.

---

# 131. DOCUMENTATION MUST MAKE THIS DISTINCTION EXPLICIT

Required wording equivalent to:

```text
Axiom-managed provider-record commits participate in live-query
invalidation and are observable across compatible authorities.

Direct out-of-band database mutations are outside the baseline
live-query guarantee unless the provider explicitly advertises
external-change observation.
```

This distinction is necessary for D1.

---

# 132. PERFORMANCE

Measure the overhead of corrected observable revision handling.

At minimum record:

```text
provider commit latency before/after
live poll cost
remote commit→update latency
SQLite write amplification
SQLite read amplification
1/2/8 authority behaviour
```

No arbitrary production SLA.

Correctness takes precedence.

---

# 133. REVISION WRITE AMPLIFICATION

If every provider mutation updates revision metadata, measure impact.

Optimization is allowed later.

Do not weaken atomicity to avoid one metadata write.

---

# 134. BATCH MUTATIONS

If provider supports batch mutations:

one logical committed batch MAY advance observable revision once.

It need not advance once per row.

The semantic requirement is:

```text
after successful batch commit
remote authorities can detect that query meaning may have changed
```

---

# 135. TRANSACTION WITH MANY PROVIDER WRITES

An ActionDef transaction performing multiple provider writes SHOULD produce a coherent observable commit boundary rather than exposing intermediate states.

Test:

```text
write A
write B
write C
commit
```

Remote query must observe committed transaction meaning, not partially applied speculative meaning.

---

# 136. APPLICATION REVISION IDENTITY

Do not include `ApplicationRevision` in:

```text
schemaFingerprint
semanticFingerprint
```

merely because the current runtime revision value changes.

Revision is runtime state, not graph identity.

---

# 137. COMPATIBILITY KEY

`AuthorityCompatibilityKey` remains based on semantic compatibility.

Do not make two otherwise compatible authorities incompatible merely because they currently observe different runtime revisions.

They should reconcile, not fail compatibility.

---

# 138. MIXED BUILD

Re-run same-schema/different-query-body refusal.

The F1 correction must not weaken:

```text
semanticFingerprint
AuthorityCompatibilityKey
live cursor compatibility
```

---

# 139. PRESENTATION-ONLY COMPATIBILITY

Presentation-only graph changes remain compatible where they were in 0.13.

Old cursor should still resume/reset correctly.

---

# 140. RELEASE VERSIONING

Update package versions consistently:

```text
0.13.0-alpha.1
    ↓
0.13.1-alpha.1
```

All relevant published packages must use one coherent version set for external testing.

No mixed 0.13.0/0.13.1 consumer.

---

# 141. RELEASE PREPARATION

Before publish:

```text
full repository tests
release:pack
release:verify
consumer-test
probe
documentation tests
conformance tests
```

must all pass.

---

# 142. IMPLEMENTATION REPORT

Produce:

```text
AXIOM_0_13_1_IMPLEMENTATION_REPORT.md
```

or project-standard equivalent.

It MUST explicitly answer the design questions in this specification.

---

# 143. IMPLEMENTATION REPORT — REQUIRED F1 ANSWERS

The report MUST answer:

1. What exactly caused F1?
2. What did `persistence.revision()` represent in 0.13.0?
3. Why did StateDef writes wake provider-query updates?
4. What revision/generation is authoritative in 0.13.1?
5. Which mutation paths advance it?
6. Is advancement atomic with provider commit?
7. What happens on crash after provider mutation?
8. What happens on crash before revision advancement?
9. Can that state exist at all?
10. How does SQLite implement the atomicity?
11. How does memory provider implement it?
12. What must custom providers implement?
13. What capability expresses support?
14. How does liveQueryPollMs consume the signal?
15. How does local wakeup interact with durable observation?
16. How are mixed StateDef/provider transactions represented?
17. Does StateDef coherence use the same revision?
18. Does query cache use the same revision?
19. Does cursor meaning change?
20. Does semanticFingerprint change?
21. Does Server IR change?
22. Does conformance version change?

---

# 144. IMPLEMENTATION REPORT — REQUIRED F2 ANSWERS

The report MUST answer:

1. Why did `validateGraph` accept StateDef refs in QueryDef?
2. Why did dependency analysis advertise them?
3. Why could runtime not bind them?
4. What is the canonical QueryDef expression scope?
5. Which scopes may legally reference StateDef?
6. What diagnostic now rejects invalid QueryDef StateDef refs?
7. Does compiler reject them?
8. Does AgentAPI report them invalid?
9. Does queryLiveCapability report them invalid?
10. Does runtime fail explicitly if invalid IR bypasses validation?
11. Were any previously valid canonical graphs affected?
12. Did semanticFingerprint rules change?

---

# 145. IMPLEMENTATION PHASES

Recommended order:

### Phase 1 — root-cause / design gates

Resolve:

```text
G1 authoritative observable revision
G2 atomicity
DataProvider capability
StateDef/ApplicationRevision relationship
F2 canonical expression scope
```

No broad implementation before these are documented.

### Phase 2 — provider observable revision primitive

Implement portable provider/runtime abstraction.

### Phase 3 — SQLite atomic provider mutation + revision

Make provider mutation and durable observability crash-safe.

### Phase 4 — memory provider

Match semantic behaviour.

### Phase 5 — live engine integration

Poll corrected signal.

### Phase 6 — dependency/cache integration

Ensure re-evaluation cannot reuse stale cached provider result.

### Phase 7 — F2 validation/compiler fix

Reject unsupported StateDef refs consistently.

### Phase 8 — AgentAPI/docs

Make public semantics discoverable.

### Phase 9 — deterministic regressions

F1/F2 exact tests.

### Phase 10 — real-process regressions

Cross-authority provider-only tests.

### Phase 11 — crash/atomicity matrix

Attack provider commit/revision boundary.

### Phase 12 — 1/2/8 topology

Provider-only + full reference workloads.

### Phase 13 — historical regressions

0.12/0.12.1/0.13.

### Phase 14 — release preparation

Pack/verify/consumer/probe.

### Phase 15 — blind external Phase 21 rerun

Published packages only.

---

# 146. INTERNAL TEST MATRIX

At minimum add permanent tests for:

```text
provider insert advances observable revision
provider update advances observable revision
provider delete advances observable revision
provider-only remote live insert
provider-only remote live remove
provider-only remote live update
provider-only ordering change
provider-only LIMIT boundary
provider-only aggregate reset
provider-only ReadPolicy removal
provider-only ReadPolicy addition
provider-only relationship invalidation
multiple provider commits without StateDef
no sync-pulse
lost optional wakeup
high revision jump
crash immediately after provider commit
process restart after provider commit
mixed StateDef/provider mutation
losing provider transaction
query cache after remote provider commit
1 authority provider workload
2 authority provider workload
8 authority provider workload
StateDef coherence regression
SQLite lost-write regression
SQLite contention regression
unsupported QueryDef StateDef ref validation
unsupported QueryDef StateDef ref compiler
unsupported QueryDef StateDef ref AgentAPI
unsupported QueryDef StateDef ref runtime guard
valid QueryDef control
valid ReadPolicy StateDef control where applicable
```

---

# 147. REAL-PROCESS TRIAL TARGETS

Recommended minimum:

```text
exact F1 remote provider commit             50
provider-only insert                         50
provider-only update                         50
provider-only delete                         50
lost wakeup                                  50
crash-after-provider-commit                  50
provider-only 2-authority topology           25
provider-only 8-authority topology           25
random-routing 8-authority workload          25
SQLite lost-write race                       50
concurrent SQLite startup:
    2 process                                25
    4 process                                25
    8 process                                25
ReadPolicy remote removal                    25
LIMIT/order remote mutation                  25
aggregate reset                              25
```

Trial counts may be increased.

Do not reduce the exact F1 repro below 50 without justification.

---

# 148. REQUIRED FORBIDDEN COUNTERS

The internal and external reports MUST include explicit totals for:

```text
provider commits permanently missed by remote live queries
provider-only topology divergences
committed provider changes requiring StateDef sync pulse
committed provider changes lost across writer crash
mixed-revision query results
stale cached provider results after observed revision
silent lost SQLite writes
two conflicting writes falsely both committed
raw SQLITE_BUSY
raw SQLITE_LOCKED
ERR_SQLITE_ERROR leakage
"database is locked" leakage
unsupported QueryDef StateDef refs accepted
AgentAPI false live-capable classifications
runtime silent unresolved StateDef refs
application manual revision bumps
application manual invalidation calls
application polling loops
application broadcast/pub-sub
application locks
application handwritten SQL
NativeOperation live-query escapes
```

Target:

```text
all zero
```

---

# 149. RELEASE BLOCKERS

0.13.1 MUST NOT release if any of these occur:

1. provider-record-only commit can remain permanently invisible to remote live query;
2. provider-record-only workload produces different final live meaning at 1/2/8 authorities;
3. a StateDef mutation is required to flush provider-query changes;
4. provider commit can succeed without durable/recoverable invalidation evidence;
5. crash after provider commit can permanently hide the change;
6. provider insert is not remotely observable;
7. provider update is not remotely observable;
8. provider delete is not remotely observable;
9. ReadPolicy-relevant provider change can leave unauthorized row visible indefinitely;
10. relationship-relevant provider change can be missed;
11. aggregate provider change can remain stale;
12. limit/order provider change can diverge from fresh QueryDef;
13. query cache can serve stale result after observable provider revision advances;
14. losing transaction exposes speculative live result;
15. silent SQLite lost write returns;
16. ordinary SQLite contention leaks raw provider error;
17. StateDef coherence regresses;
18. mixed-build fail-closed regresses;
19. cursor context binding regresses;
20. no-gap handoff regresses;
21. unsupported QueryDef StateDef reference still passes validation;
22. AgentAPI still advertises unsupported StateDef dependency as live-capable;
23. compiler accepts QueryDef expression runtime cannot bind;
24. runtime silently evaluates unresolved StateDef reference;
25. application must manually bump revision;
26. application must manually invalidate live queries;
27. application must broadcast changes;
28. application must poll persistence;
29. application must use sticky routing;
30. application must use provider-specific coordination;
31. application must use `NativeOperation`;
32. Server IR is changed without portable semantic necessity;
33. semanticFingerprint changes for valid graphs without semantic reason;
34. external Phase 21 rerun is not `D1 / E1 / S1`.

---

# 150. SEMANTIC ESCAPE TARGET

Reference application required counts:

```text
manual revision bump                  0
manual live-query invalidation        0
manual persistence polling            0
manual provider polling               0
Redis                                 0
application broadcast                 0
application locks                     0
sticky routing                        0
handwritten application SQL           0
provider-specific CDC                 0
NativeOperation live-query usage      0
```

Target:

```text
E1
```

---

# 151. DISCOVERABILITY TARGET

A cold external agent must be able to determine from shipped artifacts:

```text
provider-record mutations through Axiom are live-observable

remote authorities discover them automatically

framework polling observes durable application progress

broadcast is optional

out-of-band DB writes are not baseline-guaranteed

QueryDef direct StateDef references are unsupported
if that is the final canonical decision

ReadPolicy StateDef semantics remain distinct
```

Target:

```text
D1
```

---

# 152. SAFETY TARGET

Under:

```text
provider-only writes
StateDef-only writes
mixed writes
remote authorities
random routing
authority crash
writer crash
lost optional wakeup
slow consumer
SQLite contention
concurrent startup
optimistic conflicts
mixed builds
```

live-query result must converge to canonical QueryDef meaning.

Target:

```text
S1
```

---

# 153. EXTERNAL VALIDATION

After publishing:

```text
0.13.1-alpha.1
```

create a completely fresh external consumer.

Install only published packages.

Do not use:

- repository source;
- local tarballs;
- workspace links;
- implementation report;
- internal tests;
- design note.

---

# 154. RERUN THE SAME PHASE 21 SPEC

The full original:

```text
Axiom 0.13.0 Blind External Regression Specification
Phase 21 — Realtime / Live Canonical Queries
```

MUST be rerun substantially unchanged.

Do not replace it with a patch-specific confirmation test.

The blind tester must remain free to discover new defects.

---

# 155. F1/F2 ARE MANDATORY REGRESSIONS, NOT HINTS

The external tester may be told that F1 and F2 are mandatory regression areas.

Do NOT explain the internal fix.

The tester should independently determine whether:

```text
provider-only remote live observation now works

QueryDef StateDef semantics are now internally consistent
```

---

# 156. EXTERNAL F1 REQUIRED RESULT

The external test must reproduce the old scenario.

Target:

```text
provider-record-only remote commit:

0.13.0:
    0 / 50 observed

0.13.1:
    50 / 50 observed
```

or equivalent stronger result.

---

# 157. EXTERNAL TOPOLOGY REQUIRED RESULT

The external provider-only workload must no longer produce:

```text
1 authority   correct
2 authorities partial
8 authorities broken
```

Required:

```text
1 authority   semantically correct
2 authorities semantically correct
8 authorities semantically correct
```

with identical final canonical meaning.

---

# 158. EXTERNAL F2 REQUIRED RESULT

The external tester must verify that:

```text
validateGraph
compiler
queryDependencies
queryLiveCapability
AgentAPI
runtime
```

agree on QueryDef StateDef reference semantics.

No accept/advertise/execute contradiction.

---

# 159. EXTERNAL SQLITE REGRESSION

The blind test must retain the 0.13 SQLite lost-write regression.

F1 correction changes commit/revision infrastructure and therefore has elevated risk of reintroducing transaction races.

Target:

```text
silent lost writes = 0
raw SQLite contention leakage = 0
```

---

# 160. EXTERNAL REPORT

Produce:

```text
AXIOM_0_13_1_BLIND_EXTERNAL_REGRESSION.md
```

plus raw machine-readable evidence.

Required verdict:

```text
D1 / E1 / S1
```

Anything else means 0.13 remains unfrozen.

---

# 161. NO SOFT PASS

The following automatically prevent external validation:

```text
one permanently missed committed provider mutation

one topology-dependent final live result

one crash window leaving committed provider meaning unobservable

one persistent unauthorized-row leak

one silent lost SQLite write

one unresolved QueryDef StateDef reference silently evaluated

one application-required manual invalidation mechanism
```

Large numbers of passing trials do not compensate for one falsification of a primary invariant.

---

# 162. SUCCESS CONDITION

0.13.1 succeeds only when the external tester can state:

> Provider-record mutations committed through canonical Axiom execution participate in a durable, cross-authority observable mutation order or equivalent crash-safe invalidation mechanism. A live QueryDef no longer depends on StateDef writes, reconnects, sticky routing, broadcasts, or application intervention to discover remote provider-record changes. QueryDef expression scope is consistently represented by validation, dependency analysis, AgentAPI, compiler, and runtime.

and assigns:

```text
Discoverability:   D1
Semantic Escape:   E1
Safety:            S1
```

---

# 163. FREEZE RULE

Only after published `0.13.1-alpha.1` passes the full blind Phase 21 rerun at:

```text
D1 / E1 / S1
```

mark:

```text
Axiom 0.13
Realtime / Live Canonical Queries

EXTERNALLY VALIDATED

Classification:
B — LIVE CANONICAL QUERIES

Corrective release:
0.13.1-alpha.1

Semantic model:
FROZEN
```

---

# 164. POST-VALIDATION

After successful external validation:

```text
freeze 0.13 semantic model
```

and proceed to:

```text
0.14
Durable Workflows
```

Do not begin substantive 0.14 implementation while the 0.13 distributed live-query invalidation invariant remains externally falsified.

---

# 165. FINAL PRINCIPLE

The 0.13.0 defect exposed an important architectural distinction:

```text
StateDef revision
```

is not automatically equivalent to:

```text
application meaning changed
```

when canonical application data also lives behind provider-backed records.

0.13.1 must make this explicit.

The live-query runtime does not fundamentally need to know:

```text
which table changed
which SQLite connection wrote it
which authority wrote it
which socket was connected
which process emitted an event
```

It needs a durable answer to:

```text
Has canonical observable application meaning
potentially changed since the revision I last evaluated?
```

If yes:

```text
determine whether this QueryDef may be affected
    ↓
re-evaluate when necessary
    ↓
compare canonical result
    ↓
deliver delta or reset
```

That mechanism must work identically whether the committed mutation touched:

```text
StateDef
provider records
or both
```

and it must remain correct if:

```text
the writer dies
the reader dies
notifications are lost
the next request reaches another authority
eight authorities write concurrently
```

The application graph must not know or care how this coherence is achieved.

That is the corrective semantic boundary Axiom 0.13.1 must establish.