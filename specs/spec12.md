# Axiom 0.12.0 Specification

## Distributed Authority

Status: major semantic milestone
Target: `@cynodia/axiom 0.12.0-alpha.1`
Baseline: `0.11.2-alpha.1`

---

# 1. PURPOSE

Axiom 0.11 established externally validated schema evolution:

```
Discoverability: D1
Semantic escape: E1
Safety: S1
```

0.12 addresses the next architectural boundary:

```
Can multiple independent Axiom authority instances execute
the same application concurrently without changing the
application's semantic meaning?
```

The central invariant is:

```
one authority instance
    ≈
N authority instances
```

with respect to committed semantic state and all framework-owned asynchronous work.

Deployment topology MUST NOT become application semantics.

---

# 2. MILESTONE NAME

Axiom 0.12:

```
DISTRIBUTED AUTHORITY
```

Definition:

```
Multiple independent authority instances may concurrently operate
against the same persisted Axiom application while preserving the
framework's declared state, transaction, effect, scheduling,
subscription, retry, and ownership semantics.
```

---

# 3. NON-GOALS

0.12 is NOT:

```
Kubernetes integration
container orchestration
service discovery
generic distributed transactions
Raft
Paxos
a distributed database
multi-region consensus
active-active database replication
distributed SQL
arbitrary user-defined distributed locks
workflow orchestration
online schema migration
a message-broker abstraction
a Redis requirement
a Kafka requirement
```

Axiom owns semantic coordination.

Providers own physical coordination.

---

# 4. PRIMARY INVARIANT

For any valid application graph G:

```
observableMeaning(
    execute(G, oneAuthority)
)
```

must equal:

```
observableMeaning(
    execute(G, multipleAuthorities)
)
```

subject only to explicitly declared delivery/order guarantees.

At minimum this applies to:

```
committed state
ActionDef execution
transaction effects
durable outbox
external effects
scheduled work
timers
retries
subscriptions
external events
crash recovery
authority failover
cache visibility
```

---

# 5. TOPOLOGY TRANSPARENCY

Application code MUST NOT need to know:

```
instance count
instance identity
leader identity
which instance executes an effect
which instance executes a scheduled job
which instance receives an external event
which instance serves a request
```

unless topology is itself explicitly modeled as application data.

Do NOT introduce application-level primitives such as:

```
ifLeader(...)
currentNode()
nodeId()
clusterSize()
runOnInstance(...)
```

Topology belongs below the semantic graph.

---

# 6. AUTHORITY INSTANCE IDENTITY

Each authority process MUST have a runtime instance identity.

Conceptually:

```
AuthorityInstanceId
```

Requirements:

```
unique enough for lease ownership
process/runtime scoped
serializable where durable ownership requires it
not application semantic data
not exposed through ordinary Expression
not usable for authorization
not part of schemaFingerprint
not part of application graph identity
```

Instance identity is infrastructure metadata.

---

# 7. DISTRIBUTED OWNERSHIP MODEL

Framework-owned asynchronous work MUST use explicit durable ownership.

Canonical model:

```
work item
    ↓
durable pending state
    ↓
authority acquires lease
    ↓
authority performs attempt
    ↓
durable completion / retry state
```

Ownership MUST be:

```
exclusive
leased
recoverable
observable
bounded in time
crash-safe
```

A process crash must not permanently own work.

---

# 8. LEASE SEMANTICS

Define a reusable internal distributed lease contract.

Conceptual shape:

```
Lease {
    resourceId
    ownerId
    token
    acquiredAt
    expiresAt
    generation
}
```

Required operations:

```
acquire
renew
release
inspect
reclaim-expired
```

Requirements:

```
at most one valid owner per resource generation
stale owner cannot mutate after losing ownership
expired owner may be replaced
renewal is owner-specific
release is owner-specific
ownership transitions are durable
```

---

# 9. FENCING

Lease expiry alone is insufficient.

0.12 MUST address the stale-owner problem:

```
A owns work
A pauses
lease expires
B acquires
A wakes up
A continues writing
```

Use fencing or equivalent generation-based protection.

Every ownership acquisition SHOULD produce a monotonically increasing:

```
fencingToken
generation
epoch
```

Provider-side mutations associated with owned work MUST reject stale generations where necessary for correctness.

A stale authority must not successfully commit semantic completion after ownership has moved.

---

# 10. DISTRIBUTED COORDINATION PROVIDER

Introduce a provider-level coordination capability.

Conceptually:

```
CoordinationProvider
```

Responsibilities:

```
lease acquisition
lease renewal
lease release
fencing generation
durable ownership inspection
atomic claim transitions
```

Do NOT expose provider-specific locking primitives to applications.

---

# 11. REQUIRED REFERENCE PROVIDERS

0.12 MUST support distributed-authority conformance with at least:

```
memory/reference provider
SQLite provider
```

Memory:

```
semantic reference
deterministic testing
multi-runtime simulation where practical
```

SQLite:

```
real cross-process reference
separate OS processes
separate connections
same persisted application
```

If SQLite cannot support a required semantic safely, fail explicitly rather than weaken the contract.

---

# 12. NO REDIS REQUIREMENT

Do not make Redis mandatory for 0.12.

A future production provider may use:

```
PostgreSQL
Redis
DynamoDB
etc.
```

But 0.12 semantics must not be defined in Redis terminology.

Examples of forbidden semantic leakage:

```
SETNX
Redlock
Redis TTL
Dynamo conditional write
```

Those are provider techniques.

---

# 13. EXISTING OUTBOX MODEL

Preserve the 0.8+ durable outbox model.

0.12 extends it from:

```
durable asynchronous work
```

to:

```
durable asynchronous work safely executed by N authorities.
```

Do not replace the outbox model.

Strengthen ownership and delivery semantics around it.

---

# 14. LOGICAL EFFECT VS PHYSICAL ATTEMPT

Make the distinction explicit:

```
LogicalEffect
    semantic work created by committed application execution

EffectAttempt
    one physical attempt to perform that effect
```

A logical effect MUST have stable identity.

Retries MUST NOT create new logical effects.

Conceptually:

```
logicalEffectId
attemptNumber
ownerGeneration
```

---

# 15. EFFECT DELIVERY SEMANTICS

Do NOT promise impossible generic exactly-once external side effects.

Define the contract precisely.

Recommended:

```
exactly-once logical effect creation

at-least-once physical execution unless the external provider
supports idempotency / deduplication

exactly-once durable Axiom completion transition
```

This distinction MUST be documented and machine-inspectable.

---

# 16. EFFECT IDEMPOTENCY

External effect providers SHOULD support an Axiom-supplied stable idempotency key.

Conceptually:

```
effect.idempotencyKey = logicalEffectId
```

Provider adapter MAY map this to:

```
HTTP Idempotency-Key
payment-provider idempotency key
message deduplication id
email provider metadata
```

The application must not need to invent distributed execution IDs.

---

# 17. EFFECT CLAIMING

For each pending effect:

```
exactly one authority may own the active attempt generation.
```

Multiple authorities may race to claim it.

Allowed:

```
A claims
B observes unavailable
```

Forbidden:

```
A and B both validly own the same generation
```

If A crashes:

```
lease expires
B claims new generation
B retries
```

---

# 18. EFFECT COMPLETION FENCING

Suppose:

```
A owns generation 7
A pauses
B reclaims generation 8
B completes
A resumes
```

A MUST NOT overwrite generation 8 completion/retry state.

Completion writes must be conditional on current ownership generation.

---

# 19. EFFECT FAILURE AND RETRY

Persist retry state durably.

At minimum:

```
attempt count
last attempt time
next eligible time
last failure classification
completion state
```

Do not rely on process-local timers for correctness.

A process restart must preserve retry semantics.

---

# 20. RETRY POLICY

Existing retry semantics must remain graph-owned where already semantic.

Infrastructure MAY choose:

```
polling cadence
claim batch size
lease-renew interval
```

Infrastructure MUST NOT silently change:

```
maximum semantic attempts
backoff policy if graph-defined
retry eligibility
terminal failure meaning
```

---

# 21. SCHEDULER DISTRIBUTION

Scheduled work MUST become multi-authority safe.

For each logical scheduled firing:

```
exactly one logical firing record
```

Authorities may race to execute it.

Only one active owner generation.

Crash permits reclaim.

No duplicate logical firing caused merely by N authorities polling the same schedule.

---

# 22. SCHEDULED FIRING IDENTITY

Every logical firing MUST have deterministic/stable identity.

Conceptually:

```
scheduleId + dueInstant
```

or an equivalent canonical firing identity.

Two authorities observing the same due schedule MUST derive/claim the same logical firing, not independently create two unrelated firings.

---

# 23. MISSED SCHEDULES

Define explicit catch-up semantics.

At minimum distinguish:

```
due
late
already-fired
currently-owned
expired-owner
terminally-completed
```

Do not let multiple authorities independently "catch up" the same missed firing.

---

# 24. CLOCK MODEL

Distributed scheduling requires explicit clock assumptions.

Use:

```
authority/provider wall clock
```

for lease/schedule infrastructure.

Do not expose infrastructure clock directly as application semantic time unless existing Axiom semantics already do so.

Document assumptions about:

```
clock skew
lease safety margin
scheduler due comparison
```

Do not attempt distributed clock synchronization.

---

# 25. WEBHOOK / EXTERNAL EVENT INGESTION

If multiple authorities may receive the same external event, event ingestion MUST support deduplication where stable external identity exists.

Conceptually:

```
ExternalEvent {
    source
    externalEventId
    payload
}
```

Deduplication key:

```
source + externalEventId
```

Two authorities receiving the same event concurrently MUST NOT create two semantic events when the provider contract says the external ID is stable.

---

# 26. EVENT WITHOUT STABLE EXTERNAL ID

If an external source provides no stable event identity:

```
do not pretend exactly-once ingestion is possible.
```

Document the delivery guarantee explicitly.

Possible contract:

```
at-least-once ingestion
```

Do not synthesize false uniqueness from:

```
receive timestamp
authority instance id
random UUID
```

and call that deduplication.

---

# 27. SUBSCRIPTIONS

0.12 MUST define multi-authority subscription ownership.

Distinguish:

```
semantic subscription
physical client connection
delivery cursor
owning authority
```

A client connection may physically terminate on one authority while semantic subscription state remains durable where required.

---

# 28. SUBSCRIPTION DELIVERY

Define explicit delivery semantics.

At minimum address:

```
event identity
ordering scope
replay
reconnect
duplicate delivery
cursor advancement
owner crash
```

Do not promise global total ordering unless the underlying semantic model actually provides it.

---

# 29. ORDERING

Specify ordering domains.

Candidate:

```
per semantic stream / subscription ordering
```

rather than:

```
global application ordering
```

If no ordering guarantee exists across unrelated entities/events, say so.

Machine-readable inspection should reveal the guarantee.

---

# 30. CURSOR OWNERSHIP

If subscription/event delivery uses durable cursors:

```
cursor advancement must be fenced
```

A stale delivery owner must not move a cursor backward or overwrite a newer owner's cursor.

---

# 31. CLIENT RECONNECT

Reconnect must not depend on hitting the same authority instance.

If a client reconnects to authority B after authority A disappears:

```
semantic replay/resume should follow durable cursor semantics
```

not:

```
process-local memory state.
```

---

# 32. CACHE COHERENCE

Multiple authorities introduce cache coherence requirements.

Axiom MUST NOT return semantically stale authoritative results indefinitely because another authority committed state.

Define:

```
invalidation mechanism
version observation
bounded staleness if any
```

For authoritative reads after successful writes, existing consistency guarantees must not silently weaken merely because another authority served the request.

---

# 33. CACHE GENERATIONS

Prefer durable semantic generations/revisions over ad-hoc broadcast-only invalidation.

Conceptually:

```
persisted revision R
```

Authority cache entry records:

```
observedRevision R
```

If persistence is now R+1:

```
stale entry cannot be treated as current.
```

Broadcast invalidation may optimize latency but should not be the sole correctness mechanism unless explicitly justified.

---

# 34. CROSS-INSTANCE READ-AFTER-WRITE

Required test:

```
request writes through authority A
    ↓
subsequent authoritative read through authority B
```

The result must satisfy Axiom's declared consistency contract.

Do not allow topology to create an undocumented stale-read mode.

---

# 35. TRANSACTION OWNERSHIP

Application transactions remain provider transactions.

Do NOT create distributed transactions across authority instances.

Each ActionDef invocation executes under one authority/provider transaction.

Other authorities observe committed results according to the persistence consistency model.

---

# 36. ACTION INVOCATION

Two authorities receiving the same ordinary client invocation are normally two invocations unless the protocol provides a stable invocation identity.

Do not deduplicate unrelated requests merely because their payloads are equal.

Where the protocol has a request/invocation idempotency identity, define its semantics explicitly.

---

# 37. INVOCATION IDEMPOTENCY

Consider introducing or formalizing:

```
invocationId
```

only if required by existing protocol semantics.

If present:

```
same invocationId + same semantic request
    → one logical invocation
```

Conflicting reuse:

```
same invocationId + different request
    → explicit error
```

Do not make this an application-managed distributed lock.

---

# 38. NATIVEOPERATION

Distributed authority MUST NOT increase semantic escape.

NativeOperation remains a controlled boundary.

Do not require application authors to use NativeOperation for:

```
distributed locks
deduplication
leader election
outbox claiming
schedule claiming
subscription coordination
cache invalidation
```

Target:

```
NativeOperation additions required by 0.12 applications = 0
```

---

# 39. AUTHORIZATION

Distributed ownership is NOT authorization.

Do not conflate:

```
authority instance ownership
user principal
migration authority
application authorization
```

An instance lease grants permission to execute framework-owned work.

It must not grant application privileges beyond the semantic principal/context already attached to that work.

---

# 40. PRINCIPAL PRESERVATION

Durable asynchronous work MUST preserve the appropriate semantic security context.

If an effect/scheduled action/event was created under a principal or policy context that matters semantically:

```
failover to another authority must not change that context.
```

Instance identity must not replace principal identity.

---

# 41. READ POLICY

ReadPolicy semantics must remain invariant across authority instances.

Cache/failover/distribution must not bypass policy injection or reuse data under the wrong principal/policy fingerprint.

Existing query cursor principal/policy/query/contract binding remains intact.

---

# 42. SCHEMA EVOLUTION INTERACTION

0.11 migration safety remains authoritative.

During schema migration:

```
all ordinary authorities refuse incompatible traffic
distributed workers do not continue processing work against an incompatible schema
migration ownership remains host-controlled
```

Do not create a second schema-migration coordination system in 0.12.

Reuse or compose with existing migration metadata semantics where appropriate, but keep migration authority distinct from ordinary distributed-work ownership.

---

# 43. WORK ITEM SCHEMA VERSION

Durable work SHOULD record enough schema/contract identity to determine whether it remains executable after deployment/schema change.

At minimum investigate:

```
graph schemaVersion
schemaFingerprint
action/effect definition identity
provider contract version
```

Do not blindly execute old durable work under incompatible new semantics.

---

# 44. DEPLOYMENT VERSION SKEW

0.12 MUST define behaviour when authority instances with different application builds temporarily coexist.

Examples:

```
A runs schema 4
B runs schema 4 but different graph fingerprint
```

or:

```
A runs schema 4
B runs schema 3
```

Preferred:

```
fail closed when semantic compatibility cannot be established.
```

Do not let rolling deployment silently create mixed semantic execution.

---

# 45. AUTHORITY COMPATIBILITY IDENTITY

Introduce or reuse a durable runtime compatibility identity sufficient to determine whether two authorities may safely execute the same work.

Candidate components:

```
schemaVersion
schemaFingerprint
relevant server contract
application semantic fingerprint if schema fingerprint is insufficient
```

Investigate carefully.

Do NOT overload schemaFingerprint with non-schema meaning unless justified.

---

# 46. APPLICATION SEMANTIC FINGERPRINT

0.12 SHOULD investigate whether distributed workers require a broader:

```
semanticFingerprint
```

covering executable server-side meaning such as:

```
ActionDef bodies
effect definitions
schedule definitions
policy identity
relevant query semantics
```

This is distinct from:

```
schemaFingerprint
```

which intentionally excludes many executable semantics.

If introduced:

```
define canonical projection
version the projection
keep it stable/deterministic
document inclusions/exclusions
expose through AgentAPI
```

If not introduced:

```
document exactly how mixed-build execution is made safe without it.
```

This is a major design decision and must not be hand-waved.

---

# 47. ROLLING DEPLOYMENT

Define a safe rolling-deployment model.

At minimum:

```
old authority
new authority
shared persistence
overlapping lifetime
```

The framework must either:

```
prove compatible execution
```

or:

```
prevent one build from claiming incompatible durable work.
```

"No guarantee" is acceptable only if startup explicitly refuses the unsupported topology.

---

# 48. LEADERLESS PREFERENCE

Prefer:

```
per-work-item distributed ownership
```

over:

```
one global leader for all asynchronous work.
```

A global leader may simplify implementation but introduces unnecessary coupling and failover domains.

Use leadership only where the semantic resource genuinely requires singleton ownership.

---

# 49. NO PERMANENT LEADER REQUIREMENT

0.12 should not require one authority to be permanently designated:

```
master
primary
leader
```

Any healthy compatible authority should be able to reclaim expired work.

---

# 50. WORK CLAIM FAIRNESS

Perfect fairness is not required.

Correctness requirements:

```
no duplicate valid ownership
no permanent starvation caused by stale ownership
expired work reclaimable
```

Provider-specific claim order is infrastructure behaviour unless application semantics explicitly define priority.

---

# 51. BATCH CLAIMING

Providers MAY claim work in bounded batches.

Requirements:

```
bounded memory
no whole-queue materialization
each item independently fenced
crash does not strand batch forever
```

Expose batch size only as infrastructure tuning unless semantically meaningful.

---

# 52. BACKPRESSURE

Distributed workers MUST support bounded work acquisition.

Do not let N authorities each load the entire pending queue.

At minimum define:

```
claim batch limit
max active work per authority
bounded polling
```

This is operational semantics, not graph semantics.

---

# 53. POLLING

Reference providers MAY use polling.

Polling interval:

```
infrastructure configuration
```

not:

```
application semantic timing
```

A scheduled job's semantic due time must not become "whatever time the polling loop happened to notice it."

---

# 54. WAKEUP OPTIMIZATION

Future providers may use:

```
pub/sub
LISTEN/NOTIFY
streams
queue notifications
```

These are optimizations.

Correctness must survive lost wakeups by re-observing durable state.

---

# 55. OBSERVABILITY

Expose distributed authority state through machine-readable inspection.

At minimum:

```
instance identity
claimed work counts
active leases
expired/reclaimable work
pending effects
retrying effects
due schedules
subscription ownership
stale/fenced attempts
compatibility identity
```

Do not require log scraping.

---

# 56. AGENTAPI

Extend AgentAPI with distributed-authority inspection.

Candidate APIs:

```
inspectAuthority()
inspectDistributedWork()
explainWorkOwnership(...)
explainEffectDelivery(...)
explainScheduleFiring(...)
explainSubscription(...)
inspectCompatibility(...)
```

Exact names may differ.

Machine-readable answers must distinguish:

```
semantic guarantee
current runtime state
provider capability
operational tuning
```

---

# 57. EXPLAIN OWNERSHIP

Given a durable work item, an agent should be able to ask:

```
who owns this?
when does ownership expire?
what generation is current?
can another authority reclaim it?
why is it not runnable?
what happens if the owner crashes?
what delivery guarantee applies?
```

This should not require provider-specific knowledge.

---

# 58. SERVER IR

Distributed semantics likely require a new Server IR contract.

Expected:

```
axiom.server.v8
```

Do not bump merely for runtime implementation metadata.

Bump to v8 only if normative portable executable semantics/IR shape changes.

If 0.12 can genuinely be implemented without IR changes:

```
retain v7
```

and explain why.

Do not mechanically force v8.

---

# 59. CONFORMANCE

Introduce:

```
axiom.conformance.v6
```

if new normative distributed semantics require portable fixtures.

Expected fixture classes:

```
lease acquisition
lease fencing
effect claiming
effect reclaim
effect completion
schedule firing
schedule reclaim
event deduplication
subscription cursor fencing
cache revision visibility
mixed-build refusal
```

If no new portable semantics are introduced, retaining v5 requires explicit justification.

---

# 60. PROVIDER CAPABILITIES

Extend provider capability declarations as needed.

Candidate capabilities:

```
distributed-lease
fencing
atomic-work-claim
durable-retry
event-dedup
durable-subscription-cursor
revision-observation
```

A graph/runtime requiring unsupported semantics must fail explicitly.

No silent single-node fallback.

---

# 61. VALIDATION

Compile/validation MUST reject or flag configurations where required distributed semantics cannot be supported.

Examples:

```
durable effect execution requested
provider cannot atomically claim work
```

or:

```
durable subscription cursor requested
provider lacks fenced cursor mutation
```

Expected:

```
explicit capability diagnostic
```

not:

```
"works as long as only one server is running."
```

---

# 62. SINGLE-AUTHORITY COMPATIBILITY

0.12 MUST remain excellent with one authority.

Distributed machinery must not require:

```
external cluster service
second process
Redis
broker
```

for a normal single-instance deployment.

Single-instance applications should inherit the same durable semantics with minimal overhead.

---

# 63. MEMORY PROVIDER

Memory provider remains a semantic reference.

It may simulate multiple authority instances sharing one in-process coordination state.

It MUST NOT claim:

```
cross-process durability
```

unless it genuinely provides it.

Conformance metadata should distinguish:

```
semantic support
physical durability support
```

---

# 64. SQLITE PROVIDER

SQLite is the required real cross-process reference provider.

Use:

```
independent OS processes
independent connections
one database file
```

Required:

```
atomic claim
lease
fencing
crash/reclaim
work completion
scheduler ownership
outbox ownership
```

Do not rely on process-local mutexes for correctness.

---

# 65. SQLITE CONTENTION

Preserve 0.11.2 semantics:

Ordinary Axiom ownership contention:

```
semantic Axiom result
```

Unexpected unrelated SQLite contention:

```
provider failure with safe cause
```

Never regress to raw:

```
SQLITE_BUSY
SQLITE_LOCKED
ERR_SQLITE_ERROR
```

on normal distributed-authority paths.

---

# 66. FAILURE MODEL

0.12 must explicitly test:

```
process crash
hard kill
lease expiry
network-like provider timeout where simulatable
slow/stalled owner
stale owner resumes
duplicate external event
retry after uncertain effect outcome
mixed-version authority
cache invalidation loss
subscriber reconnect
```

Correctness must not depend on graceful shutdown.

---

# 67. KILL -9 TESTING

At least one cross-process reference test MUST terminate an authority without cleanup.

Equivalent:

```
SIGKILL
```

or the platform's hard-kill mechanism.

Then prove:

```
lease expires
another authority reclaims
stale completion cannot win
semantic state remains correct
```

---

# 68. STALE OWNER TEST

Construct deliberately:

```
A claims generation 1
A pauses
lease expires
B claims generation 2
B completes
A resumes and attempts completion
```

Expected:

```
A completion rejected as stale/fenced
B completion remains authoritative
```

This is release-blocking.

---

# 69. EFFECT RACE TEST

Two real OS processes race one pending effect.

Expected:

```
one logical effect
one active owner generation
one successful semantic completion
```

If the physical effect provider is made idempotent in the harness:

```
external effect observed exactly once
```

If intentionally non-idempotent:

```
document physical at-least-once boundary accurately.
```

---

# 70. UNCERTAIN EFFECT OUTCOME

Test:

```
authority sends external request
external system processes it
authority crashes before recording completion
```

Axiom cannot generally know whether the effect happened.

Required semantics:

```
retry according to delivery contract
stable idempotency key reused
```

Do not falsely claim generic exactly-once physical effects.

This scenario MUST be documented prominently.

---

# 71. SCHEDULER RACE TEST

N ≥ 3 authorities observe one due scheduled firing.

Expected:

```
one logical firing
one active owner generation
one completion
```

Repeat across many trials.

No N-fold duplicate firing.

---

# 72. SCHEDULER CRASH TEST

Owner claims due firing then dies.

Expected:

```
lease expires
another authority reclaims same logical firing
no second logical firing identity created
```

---

# 73. EVENT DEDUP RACE TEST

Two authorities concurrently ingest:

```
same source
same externalEventId
same payload
```

Expected:

```
one semantic external event
```

Then test:

```
same source
same externalEventId
different payload
```

Expected:

```
explicit conflict / integrity diagnostic
```

not silent acceptance as two events.

---

# 74. SUBSCRIPTION FAILOVER TEST

Client delivery owned by A.

A disappears.

Client reconnects through B using the supported resume identity/cursor.

Expected:

```
delivery resumes according to declared replay contract
no cursor regression
no silent event loss attributable to instance change
```

---

# 75. CURSOR FENCING TEST

A owns subscription delivery generation 10.

A stalls.

B takes generation 11 and advances cursor.

A resumes and tries to write old cursor state.

Expected:

```
stale cursor mutation rejected.
```

Release-blocking if stale owner can overwrite newer cursor state.

---

# 76. CACHE CROSS-INSTANCE TEST

Authority A caches record/query result.

Authority B commits mutation.

Then read through A.

Expected:

```
according to declared consistency contract, A observes the new committed state within the required boundary.
```

If bounded staleness exists:

```
quantify and expose it.
```

Do not leave it accidental.

---

# 77. LOST INVALIDATION TEST

If an invalidation notification mechanism exists:

```
deliberately drop the notification.
```

Authority must still eventually detect stale cache through durable revision/version observation.

Correctness must not depend solely on reliable pub/sub.

---

# 78. MIXED-BUILD TEST

Start:

```
authority A = build X
authority B = build Y
```

same persistence.

Test:

```
same schema / incompatible executable semantics
```

and:

```
different schema versions
```

Expected:

```
explicit compatible or incompatible decision
```

Never silent mixed execution if equivalence cannot be established.

---

# 79. MIGRATION INTERACTION TEST

Run ordinary distributed work.

Begin schema migration.

Expected:

```
incompatible workers stop claiming new work
normal serving refuses as defined by 0.11
migration completes
compatible new authorities resume work
```

No old authority may continue semantic work against the migrated schema.

---

# 80. LARGE QUEUE TEST

At least:

```
100,000 pending work items
```

Multiple authorities.

Verify:

```
bounded claim batches
bounded memory
no duplicate completion
no starvation caused by stale leases
throughput scales reasonably
```

This is primarily a boundedness/correctness test, not a benchmark competition.

---

# 81. MANY-AUTHORITY TEST

Do not test only two processes.

At minimum one suite with:

```
8 concurrent authority processes
```

racing:

```
effects
scheduled work
generic durable claims
```

Assert semantic result independent of winner distribution.

---

# 82. CHAOS MATRIX

Create a deterministic/adversarial matrix covering crashes at ownership boundaries:

```
before claim
during claim
after claim / before work
during work
after physical effect / before completion
during checkpoint
before completion commit
after completion commit / before release
during lease renewal
after lease expiry
```

For each:

```
expected semantic state
reclaimability
duplication boundary
fencing result
```

---

# 83. CROSS-PROCESS TESTS

Permanent tests MUST use actual OS processes for SQLite distributed semantics.

Do not replace them with:

```
Promise.all
mocked leases
in-process-only tests
```

In-process tests are useful but insufficient.

---

# 84. DETERMINISTIC TEST HOOKS

Controlled crash/pause hooks are allowed in test infrastructure.

They must not become application semantic APIs.

Examples:

```
pauseAfterClaim
crashAfterEffectAttempt
pauseBeforeCompletion
```

Keep them explicitly test-only.

---

# 85. CONFORMANCE MODEL

Portable conformance fixtures should describe:

```
initial durable state
authority participants
operation sequence / race barriers
injected failure
expected final semantic state
allowed intermediate outcomes
```

Avoid provider-specific SQL/lock vocabulary.

---

# 86. SEMANTIC RESULT SETS

Distributed races may have nondeterministic winners.

Conformance should assert:

```
allowed result set
final invariant
```

rather than one fixed process winner.

Example:

```
exactly one completed
others unavailable/already-completed
final work completed once
```

---

# 87. ERROR VOCABULARY

Introduce semantic diagnostics only where needed.

Candidate concepts:

```
WORK_IN_PROGRESS
WORK_FENCED
WORK_NOT_CLAIMABLE
INCOMPATIBLE_AUTHORITY
EVENT_ID_CONFLICT
```

Do not expose:

```
SQLITE_BUSY
conditional-check-failed
Redis lock lost
```

Provider errors remain provider causes.

Reuse existing diagnostics when semantically equivalent.

---

# 88. PUBLIC API

Keep application-facing API minimal.

Most distributed semantics should activate automatically when:

```
multiple compatible authorities
share a capable durable provider.
```

Avoid requiring:

```
app.enableClusterMode()
app.distributed(true)
```

Correctness should not depend on the developer remembering deployment topology.

---

# 89. HOST CONFIGURATION

Host/runtime configuration MAY include:

```
instanceId override
lease duration
renewal cadence
worker concurrency
claim batch size
polling interval
```

Defaults must be safe.

These are infrastructure knobs.

They must not alter semantic guarantees.

---

# 90. LEASE CONFIGURATION SAFETY

Validate dangerous combinations.

For example:

```
renewal interval >= lease duration
```

should be rejected or normalized explicitly.

Do not accept configurations that make fencing semantics probabilistically unsafe.

---

# 91. CLOCK SKEW TEST

Simulate bounded clock skew between authority instances.

Determine whether provider/server time should be authoritative for leases.

Preferred:

```
lease expiry determined by the coordination persistence provider's clock where available
```

rather than arbitrary process-local wall clocks.

Document the chosen model.

---

# 92. PROVIDER TIME

If SQLite cannot provide a suitable independent server clock, define the reference limitation explicitly.

Do not pretend SQLite provides distributed-clock guarantees it does not.

The semantic contract should tolerate reasonable process clock skew or reject unsupported configurations.

---

# 93. SECURITY

A malicious application request must not:

```
claim framework work
release another authority's lease
advance fencing generation
forge completion
inspect sensitive internal work payloads
invoke distributed coordination directly
```

Distributed authority APIs are host/runtime infrastructure.

---

# 94. PROTOCOL BOUNDARY

Do not expose generic lease operations through ordinary:

```
ServerRequest
```

unless there is an explicit semantic protocol requirement.

Probe guessed request kinds:

```
claim-work
acquire-lease
release-lease
renew-lease
fence-work
```

Expected:

```
malformed / unknown request
```

Host coordination must not become remotely forgeable.

---

# 95. SERIALIZATION

Durable distributed state must be serializable and inspectable.

Do not persist:

```
closures
JS functions
process object references
opaque runtime-only pointers
```

Durable state should be portable enough for independent runtime implementation.

---

# 96. INDEPENDENT RUNTIME READINESS

Design distributed state formats with future non-JS runtime support in mind.

A Rust runtime should be able to understand:

```
work identity
lease
generation
completion state
retry state
schedule firing identity
subscription cursor
```

without reverse-engineering Node internals.

---

# 97. DOCUMENTATION

Add a canonical document:

```
docs/DISTRIBUTED_AUTHORITY.md
```

It must explain:

```
topology transparency
ownership
leases
fencing
logical vs physical effects
delivery guarantees
crash recovery
scheduling
event dedup
subscriptions
cache coherence
version skew
provider capabilities
failure semantics
```

Optimize it for both human and AI consumers.

---

# 98. AGENT REFERENCE

Update:

```
docs/AGENT_REFERENCE.md
```

with a compact machine-oriented distributed-authority section.

An agent should quickly answer:

```
Do I need to write locking code?
    No.

Do I need Redis?
    No.

Are external effects generically exactly-once?
    No.

Can multiple authorities race work safely?
    Yes, with a capable provider.

Can a stale owner commit?
    No.

Is deployment topology graph semantics?
    No.
```

---

# 99. ANTI-PATTERNS

Add anti-patterns covering at minimum:

```
application-written distributed lock
Redis SETNX in NativeOperation
process-local "already executed" Set
leader-only application branches
random UUID as external-event dedup
retry creating a new logical effect
stale owner completion without fencing
global ordering assumption
pub/sub-only cache correctness
swallowing uncertain external effect outcome
pretending physical exactly-once
executing durable work under incompatible build
```

---

# 100. REFERENCE APPLICATION

Extend or create a reference application demonstrating:

```
transactional state change
    ↓
durable effect
    ↓
two authorities race effect execution
    ↓
one owns attempt
    ↓
crash
    ↓
second reclaims
    ↓
idempotent external adapter
    ↓
completion
```

Also include:

```
scheduled work
duplicate external event
subscription/reconnect if 0.12 implements durable subscriptions
```

The reference app must run with:

```
one authority
multiple authorities
```

without graph changes.

---

# 101. DISCOVERABILITY TEST

Run a cold external-agent test.

Give the agent:

```
published npm packages
a requirement to run the same app on multiple authority processes
```

Do NOT tell it:

```
implementation architecture
internal lease table names
provider locking strategy
```

Observe whether it discovers:

```
distributed semantics
fencing
effect delivery contract
scheduler semantics
provider capabilities
```

without inventing SQL/Redis/application locks.

Target:

```
D1
```

---

# 102. SEMANTIC ESCAPE TEST

Ask the cold agent to implement:

```
multi-authority effect processing
scheduled work
failover
event dedup
```

Measure:

```
handwritten locks
raw SQL
Redis calls
callbacks
NativeOperation coordination
external queue glue
```

Target:

```
E1
```

Required:

```
application-level distributed coordination escape = 0
```

---

# 103. SAFETY TEST

External adversarial test must include:

```
8 authority processes
hard kills
stale owners
lease expiry
duplicate events
uncertain effects
schedule races
reconnect
lost invalidation
mixed builds
```

Target:

```
S1
```

---

# 104. SAFETY CLASSIFICATION

Use:

S1

```
Distributed execution preserves declared semantics under ordinary
multi-instance operation, contention, crash and failover.
```

S2

```
Correct in ordinary operation but meaningful distributed weakness exists.
```

S3

```
Expert configuration or unusual timing can violate semantic guarantees.
```

S4

```
Ordinary documented distributed operation can silently duplicate,
lose, corrupt, bypass or mis-execute semantic work.
```

Target:

```
S1
```

---

# 105. RELEASE BLOCKERS

Any of the following blocks release classification A/S1:

```
two authorities validly own same generation

stale owner can commit after fencing generation advances

one logical schedule firing becomes two because two authorities poll

duplicate stable external event becomes two semantic events

effect retry creates a second logical effect

crash permanently strands durable work

failover loses committed work

old/incompatible authority executes new-schema work

ordinary multi-authority operation requires application SQL/locks

provider-native contention leaks as semantic result

cache can remain authoritatively stale without declared bound

subscription stale owner can overwrite newer cursor

physical external-effect exactly-once is falsely claimed
```

---

# 106. ZERO METRICS

Target:

```
application distributed-lock code ............ 0
application Redis coordination ............... 0
handwritten coordination SQL ................. 0
NativeOperation coordination ................. 0
duplicate valid ownership .................... 0
stale-owner commits .......................... 0
duplicate logical effects .................... 0
duplicate logical schedule firings ........... 0
lost durable work ............................ 0
incompatible-build execution ................. 0
unexplained provider lock leakage ............ 0
unbounded work materialization ............... 0
S3 defects .................................... 0
S4 defects .................................... 0
```

---

# 107. IMPLEMENTATION PHASES

Recommended implementation order:

Phase 1
Formalize distributed ownership / lease / fencing semantics.

Phase 2
CoordinationProvider interface + memory reference.

Phase 3
SQLite durable coordination provider.

Phase 4
Durable work identity + claim state machine.

Phase 5
Outbox/effect multi-authority execution.

Phase 6
Effect retry + fencing + uncertain-outcome semantics.

Phase 7
Distributed scheduler / firing identity.

Phase 8
External event deduplication.

Phase 9
Subscription ownership / cursor fencing.

Phase 10
Cache revision/coherence model.

Phase 11
Mixed-build compatibility identity.

Phase 12
Server/runtime integration.

Phase 13
AgentAPI inspection/explainability.

Phase 14
Server IR / conformance evolution.

Phase 15
cross-process crash/race matrix.

Phase 16
8-authority chaos tests.

Phase 17
reference application.

Phase 18
documentation / anti-patterns.

Phase 19
packaging / consumer tests.

Phase 20
blind external-agent validation.

Do not implement later phases by weakening unresolved earlier semantics.

---

# 108. MAJOR DESIGN GATES

Before implementation proceeds deeply, explicitly resolve these five questions:

G1 — Fencing

```
What prevents a stale owner from committing after lease expiry/reclaim?
```

G2 — External effects

```
What exactly is guaranteed once an external system may have acted but
Axiom has not durably recorded completion?
```

G3 — Compatibility

```
How do two concurrently running authority builds prove that they may
execute the same durable semantic work?
```

G4 — Cache coherence

```
What durable mechanism prevents indefinitely stale authoritative cache
state after another authority commits?
```

G5 — Subscription ordering

```
What ordering/replay guarantee does Axiom actually promise?
```

Do not leave any of these as implementation accidents.

---

# 109. IMPLEMENTATION REPORT

Produce:

```
reports/AXIOM_0_12_IMPLEMENTATION_REPORT.md
```

Answer at minimum:

1. What is the formal distributed-authority invariant?
2. What is an AuthorityInstanceId?
3. What is the durable lease representation?
4. How is ownership acquired atomically?
5. How is ownership renewed?
6. How is expired ownership reclaimed?
7. What fencing mechanism prevents stale-owner commit?
8. Can two authorities ever validly own the same generation?
9. What is a logical effect?
10. What is a physical effect attempt?
11. What exactly-once guarantee exists?
12. What remains at-least-once?
13. How is effect idempotency identity generated?
14. What happens after uncertain external effect outcome?
15. How are retries persisted?
16. How is scheduled firing identity derived?
17. Can two authorities create duplicate logical firings?
18. How does schedule crash/reclaim work?
19. How are duplicate external events detected?
20. What happens when the same external event id carries different payload?
21. What subscription delivery guarantee exists?
22. What ordering scope exists?
23. How are subscription cursors fenced?
24. How does reconnect through another authority work?
25. How is cache coherence maintained?
26. Does correctness depend on pub/sub invalidation?
27. What is the cross-instance read-after-write guarantee?
28. How are mixed authority builds handled?
29. Was a semantic/application fingerprint introduced?
30. If yes, what exactly is included/excluded?
31. If no, how is mixed-build safety proven?
32. How does schema migration interact with distributed workers?
33. What provider capabilities were added?
34. What happens when a provider lacks them?
35. Does SQLite satisfy the full reference contract?
36. What are SQLite's explicit limitations?
37. Did Server IR move to v8?
38. Why or why not?
39. Did conformance move to v6?
40. How many portable fixtures exist?
41. How many cross-process tests exist?
42. Was SIGKILL tested?
43. Was stale-owner resurrection tested?
44. Was uncertain effect outcome tested?
45. Were 8 simultaneous authorities tested?
46. Were 100k queued items tested?
47. Was lost cache invalidation tested?
48. Was mixed-build execution tested?
49. Did any provider-native contention leak?
50. Did any application require SQL/Redis/NativeOperation coordination?
51. What did the reference app demonstrate?
52. What did the blind external agent discover?
53. What D/E/S classifications resulted?
54. What known distributed limitations remain?
55. Which semantics are intentionally deferred beyond 0.12?

---

# 110. RELEASE CLASSIFICATION

Choose exactly one:

A — DISTRIBUTED AUTHORITY

```
Multiple compatible authority instances preserve Axiom semantic
meaning under contention, crash and failover.

Fencing proven.
Effects accurately modeled.
Scheduler safe.
Durable work reclaimable.
Compatibility safe.
No semantic escape.
```

B — DISTRIBUTED WITH LIMITATIONS

```
Core multi-authority execution works, but one meaningful area remains
constrained or single-owner.
```

C — MULTI-PROCESS INFRASTRUCTURE ONLY

```
Multiple processes run, but topology still changes or leaks into
application semantics.
```

D — UNSAFE

```
Duplicate/lost/stale/incompatible semantic execution is possible
under ordinary documented operation.
```

Target:

```
A
```

---

# 111. EXTERNAL VALIDATION TARGET

Published:

```
@cynodia/axiom@0.12.0-alpha.1
@cynodia/axiom-server@0.12.0-alpha.1
```

Cold consumer.

No repository.

No implementation source.

The external test must establish:

```
D1
E1
S1
```

Do not classify S1 solely from internal tests.

---

# 112. FINAL PRINCIPLE

Axiom applications describe semantic meaning.

Authority processes execute that meaning.

Therefore:

```
adding another authority process
removing an authority process
crashing an authority process
moving work between authority processes
```

must not silently change the application's meaning.

The application graph should describe:

```
what happens
```

not:

```
which machine happens to do it.
```

0.12 is complete when authority topology becomes an implementation detail rather than an application concern.
