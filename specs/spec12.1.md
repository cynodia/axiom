# Axiom 0.12.1 Specification

## Distributed State Coherence Hardening

**Status:** Corrective hardening release
**Target:** `@cynodia/axiom 0.12.1-alpha.1`
**Baseline:** `0.12.1-alpha.1`
**Primary input:** Axiom 0.12 Phase 20 Blind External Regression
**Target classification:** D1 / E1 / S1

---

# 1. PURPOSE

Axiom 0.12 introduced Distributed Authority with the primary invariant:

```text
observableMeaning(execute(G, oneAuthority))
    ==
observableMeaning(execute(G, N authorities))
```

for compatible authorities sharing the same durable application state.

The published `0.12.1-alpha.1` blind external regression established:

```text
Discoverability   D1
Semantic Escape   E1
Safety            S4
```

The Distributed Authority coordination layer itself achieved S1-grade behaviour under approximately 500 real-OS-process race/crash trials:

* exclusive leased ownership held;
* fencing held;
* stale-owner resurrection was rejected;
* durable work was reclaimable;
* logical effects remained exactly-once;
* uncertain physical effects remained accurately at-least-once;
* scheduler firings remained logically unique;
* stable external events deduplicated correctly;
* subscription cursors remained fenced and monotonic;
* revision-observing cache maintained its declared zero-revision staleness bound;
* incompatible builds refused work;
* no provider-native SQLite contention escaped from the 0.12 coordination stores.

However, the same external test discovered a release-blocking integration defect:

> Running `AxiomServer` instances do not re-observe `StateDef` state committed by another authority.

A second authority can therefore indefinitely serve stale state and permanently fail subsequent writes with `CONCURRENCY_CONFLICT`.

A second defect showed that `createSqlitePersistence` leaks raw SQLite lock contention during ordinary supported multi-process operation.

0.12.1 exists solely to close these gaps and restore the advertised Distributed Authority invariant.

---

# 2. RELEASE GOAL

After 0.12.1, compatible running authorities sharing one persistence provider MUST behave as views over one authoritative persisted application state.

Specifically:

```text
commit through authority A
        ↓
durable persistence revision advances
        ↓
read/action through authority B
        ↓
B observes state at least as new as the committed revision
        ↓
B executes from that authoritative state
```

Authority-local loaded state MUST NOT remain indefinitely authoritative after another authority commits.

---

# 3. NON-GOALS

0.12.1 MUST NOT introduce:

* new graph node kinds;
* new Expression kinds;
* new Operation kinds;
* new migration operations;
* new distributed work classes;
* new leader election;
* Redis;
* PostgreSQL;
* DynamoDB;
* distributed consensus;
* distributed transactions across actions;
* CRDT semantics;
* eventual-consistency application semantics;
* application-visible distributed locks;
* topology vocabulary;
* live queries;
* workflow semantics;
* new authorization semantics;
* zero-downtime migration;
* multi-region replication;
* generic database abstraction redesign.

0.12.1 is a coherence and provider-hardening release.

---

# 4. EXTERNAL FINDINGS TO CLOSE

The release MUST close four Phase 20 findings.

## F1 — release blocking

Multi-authority `StateDef` incoherence.

Observed:

```text
A starts: ledger = 0, revision = 0
B starts: ledger = 0, revision = 0

A commits ledger = 5, revision = 1

B SnapshotRequest:
    ledger = 0
    revision = 0

B attempts another mutation:
    CONCURRENCY_CONFLICT

B remains stale indefinitely.
```

A fresh authority C starts and correctly loads `ledger = 5`.

Therefore persistence contains the correct state; the defect is running-authority coherence.

F1 MUST be fixed.

## F2 — significant provider hardening

`createSqlitePersistence` leaks:

```text
ERR_SQLITE_ERROR
database is locked
SQLITE_BUSY / equivalent physical contention
```

during ordinary supported multi-process use.

F2 MUST be fixed for the reference SQLite multi-authority path.

## F3 — minor robustness

Malformed `TypeRef` can cause `validateGraph()` to throw a JavaScript `TypeError` instead of returning a structured validation diagnostic.

F3 SHOULD be fixed.

## F4 — cosmetic inspection mismatch

`inspectDistributedSemantics()` references:

```text
AxiomServer.inspectDistributedWork().schedules
```

but `inspectDistributedWork()` does not expose that field.

F4 MUST be made truthful either by exposing the documented state or correcting the pointer.

Do not add unnecessary runtime surface solely to preserve an incorrect documentation string.

---

# 5. PRIMARY INVARIANT

For any committed persistence revision `R`:

> A running authority MUST NOT indefinitely serve authoritative `StateDef` state older than `R` after it has had an opportunity to observe the durable revision.

For ordinary authoritative request processing, Axiom's target remains:

```text
stalenessBoundRevisions = 0
```

A request arriving after another authority's commit has durably completed MUST not intentionally execute against a known older local revision.

---

# 6. AUTHORITY-LOCAL STATE IS A CACHE

0.12.1 MUST formally treat the in-memory `StateDef` representation inside a running `AxiomServer` as:

```text
an authority-local cache of persisted authoritative state
```

and NOT as an independently authoritative state store.

The persistence provider owns durable truth.

This distinction MUST be reflected in implementation and documentation.

---

# 7. DURABLE REVISION OBSERVATION

Before an authority uses cached `StateDef` state for an authoritative operation, it MUST establish whether its local revision is current relative to persistence.

Conceptually:

```text
persistedRevision = persistence.revision()

if persistedRevision > localRevision:
    refresh authoritative state

continue only from coherent state
```

The exact internal implementation is not prescribed.

Correctness is prescribed.

---

# 8. REQUIRED COHERENCE BOUNDARIES

Revision coherence MUST apply before every operation whose semantic result depends on authoritative `StateDef` state.

At minimum:

1. protocol `SnapshotRequest`;
2. public `snapshot()` where it represents authoritative state;
3. public `getState()` or equivalent authoritative read;
4. ActionDef invocation;
5. transaction opening;
6. guard/precondition evaluation that reads StateDef;
7. authorization expressions that read StateDef, where applicable;
8. constraint evaluation dependent on StateDef;
9. trigger/action execution that reads StateDef;
10. event-driven action execution that reads StateDef;
11. scheduled action execution that reads StateDef;
12. query paths whose semantics depend on StateDef rather than provider-backed entity data;
13. effect argument evaluation that occurs from current StateDef;
14. any protocol response claiming the current application revision/state.

Do not fix only `SnapshotRequest`.

---

# 9. TRANSACTION START COHERENCE

The most important write-side rule:

> An ActionDef transaction MUST begin from a StateDef snapshot corresponding to the persistence revision against which that transaction will attempt to commit.

It is insufficient to refresh state only after a transaction fails.

Before opening a transaction:

```text
observe durable revision
refresh if behind
establish transaction base revision
execute semantic action
attempt commit against that base
```

---

# 10. OPTIMISTIC CONCURRENCY REMAINS VALID

0.12.1 MUST NOT remove optimistic concurrency control.

Two authorities may legitimately race:

```text
A reads revision 10
B reads revision 10

A commits revision 11
B attempts commit from revision 10
```

B MAY receive a concurrency conflict.

That is correct.

What is forbidden is:

```text
B receives conflict
B restores its stale revision-10 local state
B remains at revision 10 indefinitely
B retries future unrelated requests from revision 10 forever
```

---

# 11. CONCURRENCY-CONFLICT RECOVERY

After persistence rejects a commit because the authority's base revision is stale:

```text
local authoritative state MUST be considered invalid
```

The authority MUST re-observe/reload the winning durable state before it processes subsequent authoritative work.

Preferred behaviour:

```text
commit conflict
    ↓
invalidate local state
    ↓
reload persisted authoritative state
    ↓
update local revision
    ↓
return CONCURRENCY_CONFLICT for the losing invocation
```

The losing invocation need not automatically retry unless existing Axiom semantics already require that.

But the authority itself MUST recover.

---

# 12. NO SILENT ACTION REPLAY

0.12.1 MUST NOT automatically replay an ActionDef merely because its commit lost an optimistic concurrency race unless replay is semantically proven safe by an existing contract.

Example:

```text
incrementCounter()
```

may appear replayable.

But:

```text
chargeCard()
sendMessage()
generateEffect()
```

may not be.

Therefore the default rule is:

```text
losing invocation:
    CONCURRENCY_CONFLICT

authority:
    refreshes itself for subsequent requests
```

No hidden semantic retry.

---

# 13. READ-AFTER-WRITE ACROSS AUTHORITIES

Given:

```text
A commit completes at durable revision R
```

a subsequent authoritative read through B MUST observe:

```text
revision >= R
```

subject only to a newer concurrent commit.

Example:

```text
A: deposit(5)             -> commit revision 1
B: SnapshotRequest        -> ledger 5, revision >= 1
```

Returning:

```text
ledger 0, revision 0
```

is release-blocking.

---

# 14. WRITE-AFTER-REMOTE-WRITE

Given:

```text
A: deposit(5) -> committed
B: deposit(7)
```

B MUST first reconcile to A's committed state.

Expected successful sequential result when there is no overlapping race:

```text
ledger = 12
```

B MUST NOT remain permanently wedged on `CONCURRENCY_CONFLICT`.

---

# 15. TRUE CONCURRENT WRITE RACE

For simultaneous writes:

```text
A and B both begin from revision R
```

acceptable outcomes include:

```text
A commits
B gets CONCURRENCY_CONFLICT
```

or vice versa.

Afterward:

```text
both authorities MUST converge to the winning durable state
before subsequent authoritative operations.
```

A conflict is not itself a Distributed Authority defect.

Permanent local divergence after conflict is.

---

# 16. STATE REFRESH GRANULARITY

Implementation MAY use:

* whole-state reload;
* changed-StateDef reload;
* revision-indexed state reload;
* provider-specific incremental refresh;

provided the externally visible semantics are identical.

0.12.1 SHOULD prefer the smallest implementation that can be proven correct.

Do not introduce a complex distributed invalidation protocol merely for optimization.

---

# 17. BROADCAST IS NOT REQUIRED FOR CORRECTNESS

State coherence MUST NOT depend solely on:

* process-local events;
* pub/sub;
* Redis notifications;
* filesystem notifications;
* WebSocket broadcasts;
* another authority voluntarily notifying peers.

A lost notification MUST NOT permit indefinite stale authoritative state.

Durable revision observation is the correctness mechanism.

Optional notification may later optimize latency.

---

# 18. REVISION SOURCE

The persisted revision used for StateDef coherence MUST be the same authoritative commit-order concept used by persistence concurrency control.

Do not invent an unrelated process-local coherence counter.

If the provider exposes:

```text
persistence.revision()
```

that revision SHOULD be the basis unless implementation analysis proves another durable revision is required.

---

# 19. ATOMIC REFRESH VIEW

A state refresh MUST correspond to a coherent persisted revision.

Forbidden:

```text
read revision 20
load State A from revision 20
concurrent commit 21
load State B from revision 21
publish local state as "revision 20"
```

The provider/runtime MUST ensure that a refresh represents a coherent authoritative snapshot or detect that the revision changed during refresh and retry.

Exact mechanism is provider-specific.

Semantic requirement is not.

---

# 20. REFRESH RACE

If persistence changes while an authority is refreshing:

```text
refresh MUST either:

A. return a coherent snapshot at an identified revision;

or

B. detect revision movement and repeat.
```

It MUST NOT silently combine state from incompatible revisions.

---

# 21. MULTIPLE LOCAL REQUESTS

State refresh must remain safe if multiple requests arrive concurrently at one authority while it is behind.

Implementation MAY coalesce refreshes.

It MUST prevent:

* local state rollback;
* an older refresh overwriting a newer refresh;
* two refreshes publishing inconsistent revisions;
* unbounded duplicate reload work.

A per-authority internal refresh mutex/promise is acceptable infrastructure.

It is not application distributed locking.

---

# 22. MONOTONIC LOCAL REVISION

For a running authority:

```text
localAuthoritativeRevision
```

MUST be monotonic.

Once the authority has observed revision `R`:

```text
it MUST NOT later publish authoritative local state at revision < R.
```

---

# 23. STATEDEF AND CACHE COHERENCE RELATIONSHIP

0.12 already defines:

```text
CACHE_COHERENCE = {
    mechanism: durable-revision-observation,
    stalenessBoundRevisions: 0,
    requiresBroadcast: false,
    checkPerRead: true
}
```

0.12.1 SHOULD align StateDef coherence with this principle.

However:

```text
RevisionObservingCache
```

and:

```text
AxiomServer StateDef state
```

are distinct runtime concerns.

Do not merely wrap state in the existing query-cache helper if doing so violates transaction semantics.

---

# 24. ONE AUTHORITY REGRESSION

Single-authority semantics MUST remain unchanged.

No meaningful behavioural regression is allowed for:

```text
createAxiomServer({ persistence })
```

with one server process.

The additional revision observation MAY introduce provider reads.

Performance impact MUST be measured.

Correctness takes priority.

---

# 25. NON-PERSISTENT APPLICATIONS

Applications without durable persistence MUST continue to work according to existing single-authority semantics.

0.12.1 MUST NOT require a distributed revision mechanism where no persistence provider exists.

---

# 26. DISTRIBUTED ACTIVATION

No new:

```text
enableStateCoherence
enableClusterMode
distributedState: true
```

graph or application flag.

If multiple authorities share a persistence provider, the same application graph must remain correct.

Host/runtime implementation may internally activate revision observation whenever durable persistence is present.

---

# 27. SQLITE PERSISTENCE CONTENTION

`createSqlitePersistence` is part of the supported SQLite multi-authority reference path.

It MUST tolerate ordinary concurrent use from independent OS processes.

Raw provider contention MUST NOT escape during normal supported operation as:

```text
ERR_SQLITE_ERROR
SQLITE_BUSY
SQLITE_LOCKED
database is locked
```

---

# 28. SQLITE BUSY HANDLING

SQLite persistence SHOULD use the proven 0.11.2/0.12 contention philosophy:

```text
short SQLite busy timeout
        +
bounded retry
        +
semantic re-observation
```

The implementation MUST NOT use unbounded waiting.

The implementation MUST NOT classify every SQLite error as contention.

---

# 29. STRUCTURED SQLITE ERROR RECOGNITION

Contention recognition MUST use structured SQLite information where available.

Recognize the relevant base error codes for:

```text
SQLITE_BUSY
SQLITE_LOCKED
```

Do not classify contention solely from message text such as:

```text
"database is locked"
```

Do not swallow:

* constraint failures;
* corruption;
* IO errors;
* programming errors;
* invalid SQL;
* arbitrary `Error`.

---

# 30. SQLITE BUSY TIMEOUT

A public `busyTimeoutMs` option MAY be added to `createSqlitePersistence` if useful.

If added:

* provide a safe default;
* document it;
* `0` MAY disable SQLite's native wait;
* correctness MUST still use bounded handling;
* it MUST remain infrastructure tuning, not application semantics.

Prefer consistency with the existing SQLite migration/coordination providers where practical.

---

# 31. SQLITE TRANSACTION BOUNDARIES

Do not casually change SQLite journal mode or weaken transaction boundaries.

In particular:

* preserve atomic state commit;
* preserve optimistic revision checks;
* preserve crash durability;
* preserve existing schema/persistence semantics.

WAL MAY be investigated, but MUST NOT be introduced merely as a way to hide incorrect concurrency logic without explicit justification and regression testing.

---

# 32. SQLITE CONTENTION VS CONCURRENCY CONFLICT

These are distinct:

```text
physical SQLite lock contention
```

versus:

```text
semantic optimistic concurrency conflict
```

The first SHOULD normally be absorbed by bounded provider handling.

The second is a legitimate Axiom semantic result when two actions race from the same base revision.

Do not turn one into the other.

---

# 33. SQLITE STARTUP CONTENTION

Starting 2–8 authorities simultaneously against the same SQLite persistence DB MUST NOT intermittently crash an authority solely because another process is initializing/reading the same supported store.

Test fresh and existing databases.

---

# 34. SQLITE READ CONTENTION

Revision observation will increase persistence reads.

Therefore specifically test:

```text
many readers + writers
```

against one SQLite DB.

The F1 fix MUST NOT turn F2 into a more frequent failure.

---

# 35. PROVIDER CONTRACT

If StateDef coherence requires new persistence-provider capabilities, they MUST be explicit.

Potential examples:

```text
revision-observation
coherent-state-load
```

Do not silently assume every provider supports an operation not represented by its contract.

However, avoid adding a capability if existing persistence contracts already provide sufficient semantics.

The implementation report MUST explain this decision.

---

# 36. UNSUPPORTED PROVIDERS

If a persistence provider cannot provide the coherence semantics required for Distributed Authority:

```text
multi-authority operation MUST fail explicitly
```

rather than silently degrade to load-once state.

No:

```text
"works correctly if only one process happens to write"
```

fallback.

---

# 37. SERVER START

On `start()`:

1. load persisted state;
2. establish its corresponding revision;
3. publish that pair atomically as the local authoritative snapshot.

The server MUST NOT publish:

```text
state from revision R
local revision R+1
```

or the inverse.

---

# 38. SERVER SNAPSHOT

`SnapshotRequest` MUST be revision-coherent.

For a request arriving after another authority has durably committed:

```text
SnapshotRequest
```

must trigger whatever revision observation/refresh is necessary before returning authoritative state.

This is a permanent regression requirement.

---

# 39. PUBLIC SNAPSHOT API

If:

```text
server.snapshot()
```

is documented as current authoritative application state, it MUST obey the same coherence contract.

If some synchronous API cannot safely perform required asynchronous persistence observation, the API contract MUST be reconsidered explicitly rather than silently returning stale authoritative data.

Do not conceal this design issue.

---

# 40. SYNC/ASYNC API DESIGN GATE

The implementation MUST explicitly investigate whether existing synchronous state-read APIs are compatible with distributed revision observation.

If coherence requires I/O and a public API is synchronous, choose and document one of:

1. make the authoritative API asynchronous through a compatible evolution path;
2. maintain continuously refreshed local state with a proven bound;
3. distinguish explicitly between local diagnostic snapshot and authoritative snapshot;
4. another design that preserves the advertised zero-staleness contract.

Do NOT simply leave synchronous reads stale.

This is a major 0.12.1 design gate.

---

# 41. ACTION EXECUTION

Action invocation is already asynchronous and MUST perform required revision observation before evaluating state-dependent semantics.

This path MUST be correct even if synchronous diagnostic APIs require separate treatment.

---

# 42. TRIGGERS AND DISTRIBUTED WORK

A distributed worker may claim work on authority B after authority A changed StateDef.

Before B executes a trigger/action whose semantics depend on StateDef:

```text
B MUST reconcile to current durable state.
```

Fenced ownership of the work item does not make B's process-local application state authoritative.

---

# 43. SCHEDULED ACTION STATE

Likewise:

```text
scheduler claim
    ≠
permission to execute against stale StateDef
```

Before scheduled ActionDef execution, the authority must satisfy StateDef coherence.

---

# 44. EXTERNAL EVENT STATE

An external event delivered to authority C may invoke an action that mutates StateDef.

C MUST not apply that action from a stale local base merely because C received the event.

This closes the external test's observed:

```text
eventsSeen = 6 / 3 / 1
```

topology-dependent behaviour.

---

# 45. EFFECT SEMANTICS

0.12 effect semantics MUST remain unchanged:

```text
logical creation             exactly-once
physical external execution  at-least-once
durable completion           exactly-once
```

State coherence hardening MUST NOT introduce duplicate logical effects when an action loses a state commit race.

An effect belonging to a failed transaction MUST NOT become durable merely because its physical preparation occurred locally.

---

# 46. TRANSACTIONAL OUTBOX REGRESSION

Explicitly test:

```text
A and B race StateDef mutation
one wins commit
one loses CONCURRENCY_CONFLICT
```

If both transactions contain an external effect:

```text
only effects belonging to committed semantic transactions may survive.
```

No duplicate logical effect from the losing transaction.

---

# 47. SEMANTIC FINGERPRINT

0.12.1 changes runtime execution semantics but SHOULD NOT change graph executable meaning.

Therefore representative graph:

```text
semanticFingerprint(0.12.0)
    ==
semanticFingerprint(0.12.1)
```

for identical graphs.

If the fingerprint changes, implementation MUST explain exactly why.

Expected:

```text
unchanged
```

---

# 48. SCHEMA FINGERPRINT

`schemaFingerprint` MUST remain byte-identical for identical representative graphs between:

```text
0.11.2
0.12.0
0.12.1
```

where graph schema is unchanged.

No schema-identity change is justified by this patch.

---

# 49. SERVER IR

Server IR SHOULD remain:

```text
axiom.server.v7
```

0.12.1 introduces no new portable graph vocabulary.

Do not mechanically create v8.

If implementation concludes a new IR contract is required, stop and justify it before proceeding.

Expected:

```text
v7 retained
```

---

# 50. CONFORMANCE VERSION

Existing:

```text
axiom.conformance.v6
```

MUST remain valid.

0.12.1 SHOULD add permanent distributed-state coherence fixtures/tests.

Whether these require:

```text
axiom.conformance.v7
```

depends on whether the portable conformance fixture vocabulary itself must change.

Do not increment the conformance version merely because implementation tests were added.

Preferred:

```text
v6 retained
```

unless a genuinely new portable fixture shape is necessary.

---

# 51. PORTABLE COHERENCE FIXTURE

If expressible in the current conformance format, add a fixture equivalent to:

```text
participants:
    A
    B

initial:
    counter = 0
    revision = 0

steps:
    A commits counter = 5
    B reads counter

expect:
    B counter = 5
    B revision >= committed revision
```

If current v6 cannot express application-state operations, retain v6 and add a server-level regression rather than distorting the fixture format.

---

# 52. F3 VALIDATION HARDENING

`validateGraph()` MUST NOT throw an accidental JavaScript `TypeError` for malformed user graph data that reaches normal validation.

For malformed/missing `TypeRef`:

Expected:

```text
ValidationResult {
    errors: [...]
}
```

with a stable diagnostic.

Do not expose:

```text
Cannot read properties of undefined (reading 'kind')
```

as the validation contract.

This fix MUST be narrow.

---

# 53. F4 INSPECTION HARDENING

Every:

```text
runtimeStateAvailableFrom
```

pointer emitted by `inspectDistributedSemantics()` MUST identify a real public runtime inspection surface.

For schedule firing, either:

A. expose schedule state through `inspectDistributedWork()`;

or

B. point to the actual public scheduler inspection API;

or

C. state that runtime state is not currently exposed there.

Prefer truth over adding unnecessary API.

---

# 54. AGENTAPI

AgentAPI SHOULD expose StateDef coherence semantics machine-readably if an existing distributed inspection object has a natural place for it.

Possible shape:

```text
stateCoherence: {
    mechanism: "durable-revision-observation",
    stalenessBoundRevisions: 0,
    requiresBroadcast: false,
    refreshBeforeAuthoritativeOperation: true
}
```

This is optional if the same contract is already discoverable machine-readably elsewhere.

Do not add API merely for symmetry.

---

# 55. DOCUMENTATION

Update:

```text
docs/DISTRIBUTED_AUTHORITY.md
docs/AGENT_REFERENCE.md
README/doc maps where necessary
```

Canonical docs MUST explain:

* persisted state is authoritative;
* authority-local StateDef state is cached;
* revision observation detects remote commits;
* reads refresh when behind;
* transactions begin from a coherent persisted revision;
* concurrency conflict remains possible for true races;
* after conflict, authority refreshes rather than remaining stale;
* no sticky session or single-writer routing is required;
* broadcast invalidation is not required for correctness;
* SQLite physical contention is provider infrastructure, not application semantics.

---

# 56. ANTI-PATTERNS

Add anti-patterns if not already covered:

### Stale authority state as truth

Bad:

```text
server started with state X
therefore X remains authoritative until this process writes
```

Correct:

```text
persisted revision determines whether local state remains current
```

### Sticky-session correctness

Bad:

```text
route all stateful users to the same authority so StateDef works
```

Correct:

```text
topology must not be application semantics
```

### Retry action after concurrency conflict

Bad:

```text
blindly rerun arbitrary ActionDef after losing commit race
```

Correct:

```text
refresh authority state; return semantic conflict unless replay is explicitly safe
```

---

# 57. CORE TWO-AUTHORITY REGRESSION

Permanent release-blocking test:

```text
A.start()
B.start()

assert A.ledger == 0
assert B.ledger == 0

A.deposit(5)
assert persisted ledger == 5

B.snapshot()
assert B.ledger == 5

B.deposit(7)

A.snapshot()
B.snapshot()

assert A.ledger == 12
assert B.ledger == 12
```

Use real shared SQLite persistence.

Use independent server instances.

Prefer real OS processes for the release gate.

---

# 58. EIGHT-AUTHORITY STATE TEST

Start:

```text
8 real OS-process authorities
```

against one shared SQLite persistence DB.

Perform sequential actions, each routed to a randomly selected authority.

After every committed action:

```text
read from another randomly selected authority
```

Expected:

```text
read observes the committed state
```

At end:

```text
all 8 authorities converge to identical StateDef values
```

No sticky routing.

---

# 59. RANDOM LOAD-BALANCER TEST

Model ordinary deployment:

```text
for each request:
    choose random healthy authority
```

Run mixed:

* authoritative reads;
* StateDef writes;
* actions producing effects;
* event-triggered writes;
* scheduled writes where feasible.

Compare against a one-authority reference execution for an equivalent serial request order.

Expected:

```text
same committed semantic result
```

except for explicitly allowed true concurrency conflicts.

---

# 60. TRUE WRITE-RACE TEST

Use barriers:

```text
A reads revision R
B reads revision R

release both writes simultaneously
```

Expected:

```text
exactly one may win if both target same optimistic revision
other gets CONCURRENCY_CONFLICT
```

Then:

```text
loser performs authoritative snapshot
```

Expected:

```text
loser sees winner's committed state
```

Then perform a new action on loser.

Expected:

```text
it executes from refreshed state
```

This permanently tests the F1 recovery defect.

---

# 61. EVENT DISTRIBUTION TEST

Reproduce the external Phase 20 failure.

Send six events distributed across:

```text
1 authority
2 authorities
8 authorities
```

with each event causing:

```text
eventsSeen := eventsSeen + 1
```

Expected final authoritative value:

```text
6
```

in all topologies.

After completion, reads through every authority:

```text
eventsSeen == 6
```

The previous:

```text
6 / 3 / 1
```

result MUST be impossible.

---

# 62. SCHEDULED STATE MUTATION TEST

Multiple authorities poll the same scheduled trigger.

Distributed scheduler ensures one logical firing.

The winning authority mutates StateDef.

After completion:

```text
every authority must observe the resulting StateDef mutation
```

This proves scheduler correctness composes with state coherence.

---

# 63. EFFECT + STATE RACE TEST

Action:

```text
mutate StateDef
emit logical effect
```

Race invocation across authorities.

Verify:

* committed state matches winner;
* losing transaction does not leak effect;
* exactly one logical effect per committed invocation;
* all authorities subsequently observe committed StateDef;
* effect runner semantics remain 0.12-compatible.

---

# 64. REMOTE SNAPSHOT TEST

Use the real protocol:

```text
SnapshotRequest
```

not merely internal methods.

Sequence:

```text
A commits
B receives SnapshotRequest
```

Expected:

```text
B response contains current persisted StateDef
```

This is release-blocking because it reproduces the external consumer's real-client observation.

---

# 65. RUNNING-AUTHORITY REFRESH TEST

Prove that correctness does not rely on restart.

Sequence:

```text
A and B start
A commits
wait arbitrary duration
B reads
```

B must refresh while remaining the same running process.

A fresh C loading correctly is not sufficient.

---

# 66. REFRESH-STORM TEST

Start 8 authorities behind revision R.

Authority A commits R+1.

Simultaneously send many reads/actions to the seven stale authorities.

Expected:

* all converge;
* no local revision rollback;
* no incorrect mixed snapshot;
* no unbounded refresh amplification;
* no raw SQLite lock leakage;
* no deadlock.

---

# 67. SQLITE CONTENTION REGRESSION

Repeat the Phase 20 workload that produced approximately 102 raw lock errors.

Use:

```text
3 writer processes
5 reader processes
```

or stronger.

Run:

```text
>= 30 trials
```

Forbidden counters:

```text
raw SQLITE_BUSY
raw SQLITE_LOCKED
uncaught ERR_SQLITE_ERROR
"database is locked" escaping normal provider operation
```

Target:

```text
all zero
```

---

# 68. CONCURRENT STARTUP REGRESSION

Start:

```text
2
4
8
```

authorities simultaneously against:

A. fresh SQLite DB;

B. existing populated SQLite DB.

Repeat:

```text
>= 25 trials each topology
```

Expected:

```text
all start successfully
```

unless a genuine semantic incompatibility exists.

No authority may die solely from ordinary SQLite initialization contention.

---

# 69. SQLITE UNRELATED FAILURE NEGATIVE CONTROL

Ensure the F2 fix does not swallow unrelated SQLite failures.

Inject or provoke where practical:

* constraint violation;
* malformed database operation;
* closed DB;
* generic SQLite error;
* IO error simulation where practical.

Expected:

```text
not classified as ordinary retryable lock contention
```

Cause remains inspectable.

---

# 70. COORDINATION REGRESSION

Re-run all existing 0.12 coordination race suites.

At minimum:

* coordination race;
* durable-work race;
* distributed-effects race;
* distributed-scheduler race;
* external-event-dedup race;
* subscription-cursor race;
* mixed-build race;
* revision-cache race;
* eight-authority chaos;
* stale-owner resurrection;
* SIGKILL reclaim.

Every previously-zero forbidden counter MUST remain zero.

---

# 71. D1 REGRESSION

Cold documentation path MUST remain:

```text
llms.txt
    →
DISTRIBUTED_AUTHORITY.md
    →
AGENT_REFERENCE / public .d.ts / machine-readable inspection
```

External consumer must discover that StateDef is now revision-coherent across authorities without learning internal implementation details.

Target:

```text
D1
```

---

# 72. E1 REGRESSION

The corrected multi-authority application MUST require:

```text
handwritten SQL coordination      0
Redis                             0
application locks                 0
sticky-session correctness        0
leader election                   0
NativeOperation coordination      0
manual state refresh calls        0
```

Critically:

> Application authors MUST NOT need to call `server.reloadState()` or equivalent before every request.

State coherence is runtime responsibility.

Target:

```text
E1
```

---

# 73. S1 REGRESSION

The external consumer must be able to run:

```text
same graph
same persistence
same request sequence
```

with:

```text
1 authority
2 authorities
8 authorities
```

and obtain equivalent committed semantic state.

Target:

```text
S1
```

---

# 74. PERFORMANCE ENVELOPE

Measure:

* persistence revision observation latency;
* authoritative read overhead;
* action-start overhead;
* refresh frequency;
* refresh coalescing effectiveness;
* SQLite contention rate;
* 1-authority throughput before/after;
* 8-authority throughput before/after.

Do not set a premature strict performance gate.

But report regressions.

Correctness MUST NOT be weakened to recover performance.

---

# 75. AVOID FULL RELOAD PER FIELD ACCESS

The implementation SHOULD avoid persistence reload for every individual Expression state lookup.

Preferred unit:

```text
authoritative operation boundary
```

not:

```text
every state expression node
```

One coherent refresh before semantic evaluation is generally preferable to many provider round trips during evaluation.

---

# 76. NO TOCTOU FALSE CLAIM

Revision observation alone does not eliminate concurrent writes.

Example:

```text
B observes current revision 10
A commits 11 immediately afterward
B executes from 10
```

This is acceptable provided B's commit is checked against revision 10 and loses safely.

Therefore 0.12.1 MUST NOT claim:

```text
revision observation prevents all concurrency conflicts
```

It ensures:

```text
no indefinite stale authority
+
safe optimistic race detection
+
recovery after losing race
```

---

# 77. READ SEMANTICS UNDER CONCURRENT COMMIT

For a read racing a commit, either coherent result may be acceptable depending on linearization point:

```text
state before commit
```

or:

```text
state after commit
```

But the returned state/revision pair MUST be internally coherent.

After the commit is known complete, subsequent reads MUST not indefinitely return the pre-commit state.

---

# 78. LINEARIZATION DOCUMENTATION

Implementation report MUST state the intended linearization point for:

* authoritative snapshot;
* transaction base revision;
* commit;
* conflict recovery.

Do not leave this implicit.

---

# 79. PROVIDER-INDEPENDENT SEMANTICS

The StateDef coherence contract MUST be provider-independent.

SQLite is the real multi-process reference provider.

Memory remains the semantic single-process reference unless explicitly capable of shared cross-process persistence.

No SQLite vocabulary should appear in application semantic diagnostics.

---

# 80. APPLICATION AUTHORIZATION

Refresh/reload MUST NOT change the request principal.

A request arriving on B:

```text
principal P
```

must remain:

```text
principal P
```

after B refreshes state.

State synchronization is infrastructure, not authorization.

---

# 81. MIXED-BUILD SAFETY

0.12 `AuthorityCompatibilityKey` semantics remain unchanged.

A state refresh MUST NOT permit an incompatible authority to execute work it was previously forbidden to claim.

Re-run mixed-build tests.

---

# 82. MIGRATION INTERACTION

0.11 migration safety remains authoritative.

During migration:

```text
ordinary serving remains refused
```

as documented.

A StateDef refresh MUST NOT bypass:

```text
MIGRATION_IN_PROGRESS
SCHEMA_INCOMPATIBLE
SCHEMA_IDENTITY_REQUIRED
SCHEMA_METADATA_REQUIRED
```

or equivalent startup/request gates.

---

# 83. STATE REFRESH DURING MIGRATION

If a running authority attempts coherence refresh while schema migration is active:

```text
fail closed
```

rather than loading partially migrated state.

Do not create a second migration coordination model.

---

# 84. CRASH DURING REFRESH

Kill an authority while it is refreshing local state.

Expected:

```text
no persistence corruption
```

On restart:

```text
authority loads coherent durable state
```

Because refresh is read/reconciliation infrastructure, it must not create a durable half-state.

---

# 85. CRASH AFTER REMOTE COMMIT

Sequence:

```text
A commits
B has stale local state
B crashes before observing commit
B restarts
```

Expected:

```text
B loads A's committed state
```

Existing startup semantics should already provide this; preserve it.

---

# 86. OBSERVABILITY

Runtime inspection SHOULD allow diagnosis of coherence state.

Useful information may include:

```text
localRevision
persistedRevision / lastObservedRevision
stateCurrent
refreshInProgress
lastRefreshAt
```

Do not expose provider-specific details as application semantics.

This is SHOULD, not a release blocker, unless needed to make D1 possible.

---

# 87. NO SILENT SINGLE-WRITER FALLBACK

The implementation MUST NOT "fix" F1 by internally pinning all StateDef mutations to one authority unless that routing is itself a transparent, durable, failover-safe framework semantic proven equivalent.

Preferred solution:

```text
revision-coherent authorities
```

not:

```text
hidden permanent state leader
```

No global leader is needed for ordinary StateDef optimistic concurrency.

---

# 88. NO APPLICATION STICKINESS REQUIREMENT

Documentation and implementation MUST NOT require:

```text
sticky HTTP sessions
same-user → same authority
stateful actions → one process
events → designated authority
```

for correctness.

Such deployment tuning may exist for performance, but not semantic correctness.

---

# 89. REFERENCE APPLICATION

Re-run the existing device-monitor reference application unchanged.

Extend it so that application StateDef observations are made through multiple authorities.

Expected:

```text
one-authority final semantic state
    ==
N-authority final semantic state
```

including both:

```text
framework-owned async work
and
application StateDef state
```

---

# 90. REVISED DISTRIBUTED AUTHORITY INVARIANT

0.12.1 formally clarifies the 0.12 invariant as:

For compatible authority instances sharing a persistence provider capable of Distributed Authority:

```text
observableMeaning(one authority)
    ==
observableMeaning(N authorities)
```

for:

* committed StateDef state;
* ActionDef execution;
* transaction outcomes;
* logical effects;
* effect retry/completion;
* scheduled firings;
* external-event dedup;
* subscription cursor state;
* authoritative cached reads;
* crash/reclaim/failover;

subject only to explicitly documented:

* optimistic concurrency conflicts;
* external physical at-least-once delivery;
* subscription at-least-once delivery;
* ordering scopes;
* known post-completion event window;
* supported provider/clock assumptions.

---

# 91. PERMANENT F1 NAMED REGRESSION

Add a permanent test explicitly named for the external finding.

Suggested:

```text
distributed-state-coherence.test.ts
```

It MUST contain the exact minimal reproduction:

```text
A and B start at revision 0

A commits state = 5

B protocol snapshot:
    state == 5

B commits +7:
    succeeds if no concurrent race

A protocol snapshot:
    state == 12

B protocol snapshot:
    state == 12
```

Never allow this test to be replaced solely by cache-unit tests.

---

# 92. PERMANENT F2 NAMED REGRESSION

Add a real OS-process SQLite persistence test.

Suggested:

```text
sqlite-persistence-contention.test.ts
```

It MUST use:

```text
independent processes
independent SQLite connections
same DB file
real concurrent readers/writers
```

and assert zero raw SQLite lock leakage during supported operation.

---

# 93. F3/F4 REGRESSIONS

Add:

```text
malformed TypeRef -> structured validation diagnostic
```

and:

```text
every AgentAPI runtimeStateAvailableFrom pointer resolves to a real public surface
```

or equivalent structural assertion.

---

# 94. CROSS-PROCESS REQUIREMENT

F1/F2 release gates MUST use real OS processes.

In-process:

```text
Promise.all([serverA, serverB])
```

is useful but insufficient.

At least the following must be cross-process:

* remote commit → remote snapshot;
* remote commit → subsequent write;
* true concurrent write race;
* 8-authority random routing;
* SQLite reader/writer contention;
* concurrent startup.

---

# 95. TRIAL COUNTS

Minimum preferred external/internal stress counts:

```text
2-authority sequential coherence       50
true concurrent write race             50
8-authority random routing             25
event-distributed StateDef mutation    25
scheduled StateDef mutation            25
SQLite reader/writer contention        50
concurrent startup:
    2 authorities                      25
    4 authorities                      25
    8 authorities                      25
```

Environment variables MAY reduce routine local test counts.

Release preparation SHOULD execute full counts.

---

# 96. FORBIDDEN COUNTERS

0.12.1 release report MUST include explicit totals for:

```text
stale authoritative SnapshotRequest after known remote commit
stale getState/snapshot after known remote commit
permanent CONCURRENCY_CONFLICT wedge
local revision rollback
mixed-revision state snapshot
duplicate logical effect due to conflict handling
lost committed effect
raw SQLITE_BUSY
raw SQLITE_LOCKED
uncaught ERR_SQLITE_ERROR
database-is-locked provider leakage
authority startup failure from ordinary SQLite contention
duplicate valid distributed owner
stale-owner commit
duplicate logical schedule firing
cursor regression
incompatible-build execution
```

Target:

```text
all = 0
```

except legitimate one-shot `CONCURRENCY_CONFLICT` results in deliberately simultaneous write-race tests.

---

# 97. CONFLICT COUNTER SEPARATION

Report separately:

```text
legitimate optimistic CONCURRENCY_CONFLICT
```

and:

```text
repeated/permanent conflict caused by stale authority state
```

The first is valid semantics.

The second MUST be zero.

---

# 98. LARGE STATE TEST

Use enough StateDefs / state payload size to ensure refresh correctness is not accidentally dependent on trivial one-field state.

At minimum test:

* multiple independent StateDefs;
* nested structured values;
* optional/null values;
* entity references if StateDef supports them;
* state changed by one authority while another refreshes.

Correctness is primary.

---

# 99. REFRESH PERFORMANCE TEST

Measure whether a remote revision change causes:

```text
one coherent refresh
```

rather than one reload per StateDef or Expression access.

This is informational unless behaviour is pathologically unbounded.

---

# 100. DOCUMENTED LIMITATIONS

The 0.12 known limitations remain unless explicitly changed:

* physical external effects are at-least-once unless provider-idempotent;
* follow-up success/failure event after durable completion retains its documented crash window;
* subscription delivery remains at-least-once;
* SQLite has bounded clock-skew assumptions;
* no production Redis/Postgres/Dynamo coordination provider;
* event-dedup/cursor server wiring boundaries remain as actually implemented/documented.

0.12.1 MUST NOT accidentally claim these are solved.

---

# 101. RELEASE PREPARATION

Before publishing:

```text
npm test / full repo suite
browser tests
release:pack
release:verify
release:consumer-test
release:probe
```

must pass.

All package manifests must target:

```text
0.12.1-alpha.1
```

where appropriate.

Frozen historical IR/conformance artifacts MUST remain byte-identical unless a version change is explicitly justified.

---

# 102. IMPLEMENTATION REPORT

Produce:

```text
reports/AXIOM_0_12_1_IMPLEMENTATION_REPORT.md
```

The report MUST answer the following questions explicitly.

1. What exactly caused F1?
2. Which runtime object previously treated process-local state as authoritative?
3. What is authoritative after 0.12.1?
4. What durable revision is used for coherence?
5. At what boundaries is revision checked?
6. How is a stale authority detected?
7. How is state refreshed?
8. Is refresh whole-state or incremental?
9. How is a coherent state/revision pair guaranteed?
10. What happens if persistence changes during refresh?
11. Can two local refreshes race?
12. Can local revision move backward?
13. What happens after `CONCURRENCY_CONFLICT`?
14. Is the losing ActionDef automatically replayed?
15. Why or why not?
16. What is the authoritative snapshot linearization point?
17. What is the transaction base-revision linearization point?
18. What is the commit linearization point?
19. What is conflict-recovery linearization behaviour?
20. How are synchronous snapshot/getState APIs made coherent?
21. Did any public API become async?
22. If so, how was compatibility handled?
23. How do event-triggered actions obtain coherent StateDef?
24. How do scheduled actions obtain coherent StateDef?
25. How do distributed effect-producing actions remain transactionally correct?
26. Can a losing transaction leak an effect?
27. How was F2 fixed?
28. Is `busyTimeoutMs` public?
29. What is its default?
30. How are SQLite BUSY/LOCKED errors recognized?
31. What errors are explicitly not treated as contention?
32. Is retry bounded?
33. Did journal mode change?
34. Did transaction isolation/boundaries change?
35. Can concurrent startup leak raw SQLite contention?
36. Did persistence-provider capability vocabulary change?
37. Can an incapable provider silently run distributed StateDef?
38. How was F3 fixed?
39. What diagnostic now replaces the TypeError?
40. How was F4 fixed?
41. Does every AgentAPI inspection pointer now resolve?
42. Did schemaFingerprint change?
43. Did semanticFingerprint change?
44. Did Server IR remain v7?
45. Did conformance remain v6?
46. Were historical fixtures byte-identical?
47. What is the 1/2/8-authority equivalence result?
48. What is the event-distribution result replacing 6/3/1?
49. What is the true concurrent-write result distribution?
50. Does the losing authority recover for its next request?
51. How many raw SQLite lock errors occurred?
52. How many stale authoritative reads occurred?
53. How many permanent conflict wedges occurred?
54. Did any previous 0.12 coordination invariant regress?
55. What is the final internal release classification?
56. What remains for external validation?

---

# 103. RELEASE BLOCKERS

0.12.1 MUST NOT publish if any of the following occurs:

1. B serves stale StateDef indefinitely after A's completed commit.
2. B remains permanently wedged after one concurrency conflict.
3. local authoritative revision moves backward.
4. refresh can publish a mixed-revision state snapshot.
5. event-distributed StateDef result depends on number of authorities.
6. scheduled StateDef mutation is visible only on the winning process.
7. losing transaction leaks a logical effect.
8. SQLite persistence leaks raw ordinary lock contention.
9. concurrent authority startup fails because of normal SQLite lock contention.
10. F1 fix requires application sticky routing.
11. F1 fix requires application manual refresh.
12. F1 fix introduces a hidden permanent leader without failover semantics.
13. state refresh bypasses migration safety.
14. state refresh bypasses authorization.
15. mixed-build authority executes incompatible work.
16. any existing 0.12 fencing/reclaim invariant regresses.
17. schema/semantic fingerprints change without explicit justified semantic reason.
18. Server IR changes without portable vocabulary change.
19. provider incapability silently degrades to unsafe multi-authority operation.
20. ordinary multi-authority topology still changes committed application meaning.

---

# 104. INTERNAL RELEASE CLASSIFICATION

0.12.1 may be classified:

```text
A — DISTRIBUTED AUTHORITY
```

internally only if:

* F1 is closed by actual coherence, not documentation downgrade;
* F2 is closed;
* F3/F4 are closed or explicitly justified as nonblocking;
* all 0.12 coordination invariants remain green;
* 1/2/8-authority StateDef equivalence passes;
* no release blocker fires.

But internal classification is not external validation.

---

# 105. EXTERNAL REGRESSION

After publishing:

```text
@cynodia/axiom@0.12.1-alpha.1
@cynodia/axiom-server@0.12.1-alpha.1
```

re-run the Phase 20 blind external regression from a fresh consumer.

The external agent MUST NOT receive implementation source or the 0.12.1 implementation report before testing.

It MAY receive the original Phase 20 test specification.

---

# 106. EXTERNAL F1 MANDATORY REPRODUCTION

The external regression MUST rerun the exact previously failing sequence:

```text
A and B start at 0

A commits ledger = 5

B protocol SnapshotRequest
    MUST return 5

B commits +7
    MUST succeed absent a simultaneous race

A snapshot
B snapshot
    MUST both return 12
```

Repeat with:

```text
2 authorities
8 authorities
random request routing
```

---

# 107. EXTERNAL EVENT EQUIVALENCE

Re-run the exact topology-sensitive test.

Previous:

```text
1 authority  -> eventsSeen 6
2 authorities -> eventsSeen 3
8 authorities -> eventsSeen 1
```

Required 0.12.1 result:

```text
1 authority  -> 6
2 authorities -> 6
8 authorities -> 6
```

and every authority's subsequent authoritative read observes:

```text
6
```

---

# 108. EXTERNAL F2 STRESS

Re-run the workload that previously produced approximately 102 SQLite lock leaks.

Target:

```text
raw SQLITE_BUSY       0
raw SQLITE_LOCKED     0
ERR_SQLITE_ERROR      0
database-is-locked    0
startup lock failures 0
```

for ordinary supported contention.

---

# 109. EXTERNAL COORDINATION REGRESSION

The blind test MUST rerun enough of the 0.12 coordination matrix to establish that the corrective state work did not regress:

* lease exclusivity;
* fencing;
* crash reclaim;
* uncertain effects;
* scheduler uniqueness;
* event dedup;
* cursor fencing;
* cache revision coherence;
* mixed-build refusal.

Full 0.12 trial counts are preferred.

---

# 110. EXTERNAL TARGET

Required final classification:

```text
Discoverability: D1
Semantic Escape: E1
Safety: S1
```

Anything below S1 means 0.12 Distributed Authority remains unfrozen.

---

# 111. FREEZE CONDITION

Only after published 0.12.1 receives:

```text
D1 / E1 / S1
```

with:

```text
StateDef equivalence        PASS
SQLite persistence          PASS
coordination regression     PASS
all release blockers        zero
```

may Axiom 0.12 Distributed Authority be marked:

```text
EXTERNALLY VALIDATED
```

and functionally frozen.

---

# 112. RELEASE CLASSIFICATION AFTER SUCCESS

Record:

```text
Axiom 0.12 Distributed Authority

Corrective release:
    0.12.1-alpha.1

Status:
    EXTERNALLY VALIDATED

Discoverability:
    D1

Semantic Escape:
    E1

Safety:
    S1

Closed external findings:
    F1 StateDef coherence
    F2 SQLite persistence contention
    F3 malformed TypeRef validation
    F4 distributed inspection pointer
```

if all four are in fact closed.

---

# 113. NEXT MILESTONE

Do not use 0.12.1 to begin the next feature milestone.

After external D1/E1/S1 validation, freeze the 0.12 contract and proceed to:

```text
Axiom 0.13
Realtime / Live Canonical Queries
```

The 0.12.1 StateDef coherence mechanism becomes a load-bearing prerequisite for live queries.

Do not duplicate it with a second unrelated coherence model in 0.13.

---

# 114. FINAL PRINCIPLE

0.12.0 successfully established that framework-owned distributed work can be:

```text
leased
fenced
reclaimed
deduplicated
made version-compatible
```

without making deployment topology application semantics.

0.12.1 completes that model for application state.

The invariant is:

> A running Axiom authority is not the owner of application truth. Persistence is.

An authority may cache that truth.

It may execute semantic work against that truth.

It may optimistically race another authority.

It may lose that race.

But it may never continue indefinitely believing that its stale process-local copy is the application.

Therefore:

```text
adding
removing
restarting
load-balancing across
or failing over between
```

compatible Axiom authorities MUST NOT silently change application meaning.
