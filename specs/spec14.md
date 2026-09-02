# Axiom 0.14 Specification

## Durable Workflows

**Status:** Feature specification
**Target:** `@cynodia/axiom 0.14.0-alpha.5`
**Baseline:** `0.13.1-alpha.1` — Realtime / Live Canonical Queries
**Prerequisite:** Axiom 0.13 externally validated at `D1 / E1 / S1`
**Primary capability:** Durable, portable, analyzable long-running workflows
**Expected Server IR:** `axiom.server.v8`
**Expected conformance:** `axiom.conformance.v8`
**Validation target:** blind external regression `D1 / E1 / S1`

---

# 1. PURPOSE

Axiom 0.14 introduces **Durable Workflows** as a first-class semantic capability.

A workflow is a long-running semantic computation that may:

* execute canonical Axiom actions;
* wait for durable external events;
* wait for time;
* branch deterministically;
* survive process death;
* survive authority failover;
* retry transient execution failures;
* be cancelled;
* complete or fail explicitly;
* remain inspectable and explainable while waiting.

A workflow MUST NOT be implemented as application-owned JavaScript orchestration.

The primary design principle is:

> The workflow graph owns durable orchestration meaning. The runtime owns scheduling, persistence, retries, leases, fencing, crash recovery, and physical execution.

---

# 2. WHY WORKFLOWS ARE A FIRST-CLASS SEMANTIC

Without WorkflowDef, applications requiring long-running orchestration are forced to construct application infrastructure such as:

```text
StateDef status fields

+
scheduler jobs

+
event handlers

+
manual retry counters

+
manual idempotency keys

+
manual crash recovery

+
manual state machines

+
application locks

+
leader election
```

That is semantic escape.

0.14 must allow the same meaning to be represented canonically.

---

# 3. PRIMARY INVARIANT

For a valid WorkflowDef `W` and workflow instance `I`:

```text
observableMeaning(
    executeWorkflow(I, oneAuthority)
)
==
observableMeaning(
    executeWorkflow(I, NAuthorities)
)
```

subject only to explicitly documented physical delivery semantics.

A process crash, authority crash, retry, lease expiry, or request routing change MUST NOT change the logical workflow result.

---

# 4. DURABILITY INVARIANT

Once a workflow transition is durably committed:

```text
process death
authority death
machine restart
new authority
```

MUST NOT cause the workflow to forget that transition.

Conversely:

A transition that did not durably commit MUST NOT later appear as committed merely because a stale process resumes.

---

# 5. EXACTLY-ONCE LOGICAL TRANSITION

Axiom 0.14 MUST guarantee:

```text
exactly-once logical workflow transition
```

for each activated workflow step.

This does NOT imply:

```text
exactly-once physical execution
```

of external effects.

The distinction is mandatory.

---

# 6. PHYSICAL EXECUTION SEMANTICS

Existing Axiom effect honesty remains unchanged.

Conceptually:

```text
logical workflow transition
    exactly once

logical ActionDef invocation
    exactly once according to its canonical invocation identity

physical external effect attempt
    at least once where existing Axiom effect semantics say so
```

0.14 MUST NOT claim physical exactly-once delivery where the underlying system cannot provide it.

---

# 7. WORKFLOWDEF

Introduce a first-class graph node:

```text
WorkflowDef
```

A WorkflowDef describes:

* workflow id;
* input parameters;
* steps;
* entry step;
* durable control-flow edges;
* completion;
* failure;
* optional retry policy;
* optional timeouts where semantically relevant.

The WorkflowDef MUST be serializable.

It MUST appear in portable Server IR.

It MUST be inspectable through AgentAPI.

---

# 8. NO APPLICATION SCRIPT BODY

WorkflowDef MUST NOT contain arbitrary JavaScript.

Forbidden:

```text
run: async () => { ... }

handler: function (...) { ... }

eval: "arbitrary JS"

callback pointer

module name

source-code string
```

Workflow meaning must be represented structurally.

---

# 9. MINIMAL STEP SET

0.14 SHOULD begin with the smallest useful portable step vocabulary:

```text
action

wait-event

timer

branch

complete

fail
```

This is sufficient for a large class of durable workflows without turning WorkflowDef into a general-purpose programming language.

---

# 10. DEFERRED STEP TYPES

0.14 MUST NOT require:

```text
parallel
race
map
foreach
child-workflow
query-watch
human-task
compensation
saga
subworkflow
dynamic code
arbitrary loops
```

These may be considered after the base execution model has been externally validated.

---

# 11. ACYCLIC WORKFLOW GRAPH

0.14 WorkflowDefs SHOULD be acyclic.

Validation SHOULD reject a control-flow cycle.

Reason:

* simpler deterministic execution;
* simpler transition identity;
* simpler static analysis;
* no hidden unbounded computation;
* no need for loop iteration identity in the first workflow contract.

Retries are runtime execution policy and do not constitute graph cycles.

---

# 12. FUTURE LOOPS

The persistent execution model MUST nevertheless use an activation identity that does not assume:

```text
stepId == forever unique execution identity
```

Use a distinct conceptual:

```text
activationId
```

so future versions can add loops without replacing workflow-instance identity semantics.

---

# 13. WORKFLOW INPUTS

WorkflowDef may declare typed input parameters.

Conceptually:

```text
workflow order_fulfillment(
    orderId: OrderId,
    requestedBy: UserId
)
```

Inputs are immutable after workflow creation.

---

# 14. WORKFLOW INPUT SERIALIZATION

All workflow inputs MUST use canonical Axiom portable value types.

No host objects.

No closures.

No file descriptors.

No open sockets.

No class instances with runtime-only identity.

---

# 15. WORKFLOW INSTANCE

Starting a WorkflowDef creates a durable:

```text
WorkflowInstance
```

with at least:

```text
instanceId
workflowId
workflowCompatibilityFingerprint
principal
inputs
status
currentActivation
durable bindings
instanceRevision
createdAt
updatedAt
```

Exact storage shape is runtime-owned.

The semantic fields must be inspectable.

---

# 16. WORKFLOW STATUS

Canonical instance statuses:

```text
running

waiting

completed

failed

cancelled
```

Additional internal statuses MAY exist but MUST NOT create contradictory public semantics.

---

# 17. WAITING REASON

A workflow in:

```text
waiting
```

must have an inspectable reason.

Examples:

```text
waiting for event payment_confirmed

waiting until 2026-09-01T10:00:00Z

waiting for retry attempt 3 at ...

waiting for execution ownership
```

A workflow MUST NOT simply appear "stuck" with no semantic explanation.

---

# 18. WORKFLOW START API

Provide a public server operation conceptually equivalent to:

```ts
server.startWorkflow({
  workflowId,
  arguments,
  credential,
  idempotencyKey
})
```

Exact API naming may differ.

---

# 19. START IDEMPOTENCY

Workflow creation MUST support stable caller-provided idempotency.

Repeated:

```text
startWorkflow(W, same principal, same idempotencyKey)
```

MUST NOT create multiple logical workflow instances.

---

# 20. START IDENTITY

Conceptually:

```text
WorkflowStartIdentity =
    workflowId
    +
    principalFingerprint
    +
    idempotencyKey
```

The final implementation may include additional compatibility context.

Two distinct callers MUST NOT accidentally collide merely because they reused the same textual key under different principals.

---

# 21. UNCERTAIN START

Required network-failure behaviour:

```text
client sends start

server commits workflow

connection dies before response
```

Client retries with same idempotency key.

Expected:

```text
same logical workflow instance returned
```

not a duplicate instance.

---

# 22. PRINCIPAL CAPTURE

Workflow creation must bind the semantic principal under which the workflow was started.

Do not persist raw credentials merely to replay later.

Persist only the canonical principal representation necessary for later authorization semantics.

---

# 23. PRINCIPAL PRESERVATION

Every workflow-driven ActionDef execution MUST run as the workflow's bound principal unless WorkflowDef semantics explicitly define another principal mechanism in a future release.

No authority-local service principal substitution.

No implicit privilege escalation.

---

# 24. AUTHORIZATION RE-EVALUATION

Capturing the principal does NOT mean authorization decisions are frozen forever.

When a later workflow step invokes an ActionDef:

```text
current authorization semantics
```

must be applied using the workflow principal.

A workflow started while access was permitted does not automatically retain permanent authorization if current canonical policy denies the later action.

---

# 25. AUTHORIZATION FAILURE

If a workflow ActionDef is no longer authorized:

the step must fail semantically.

It MUST NOT silently execute under elevated authority.

The WorkflowDef may route that failure using its declared failure edge if supported.

---

# 26. WORKFLOW BINDINGS

Workflow execution may require values produced after start.

0.14 SHOULD use typed, durable, single-assignment workflow bindings rather than one mutable JSON state blob.

Conceptually:

```text
inputs.orderId

event.payment.transactionId

event.payment.amount
```

---

# 27. NO ARBITRARY MUTABLE WORKFLOW BLOB

Avoid:

```text
workflow.state = arbitrary JSON
workflow.state.foo.bar = ...
```

as the primary semantic model.

That turns WorkflowDef into a generic state-machine container and makes static analysis weak.

Prefer:

```text
immutable inputs
+
explicit step outputs/bindings
+
durable control position
```

---

# 28. SINGLE-ASSIGNMENT BINDINGS

A binding produced by an activated step SHOULD be assigned once.

A later step may read it but may not arbitrarily mutate it.

This improves:

* replay safety;
* static analysis;
* explainability;
* portability.

---

# 29. ACTION STEP

An action step invokes an existing canonical:

```text
ActionDef
```

Example:

```text
reserve_inventory
    action: action_reserve_inventory
    arguments:
        orderId: ref(workflow.input.orderId)
    next: wait_for_payment
```

---

# 30. ACTIONDEF REMAINS CANONICAL

WorkflowDef MUST NOT duplicate ActionDef semantics.

The workflow step references an existing ActionDef.

Transactions, constraints, provider writes, effects, authorization, and other ActionDef semantics remain owned by ActionDef/runtime.

---

# 31. ACTION INVOCATION IDENTITY

Every activated action step MUST execute with a stable logical invocation identity.

Conceptually:

```text
WorkflowActionInvocationIdentity =
    workflowInstanceId
    +
    activationId
```

Retrying the same activated step MUST reuse the same logical invocation identity.

---

# 32. DOUBLE-ACTION PREVENTION

Crash scenario:

```text
authority A begins action step

action logically commits

A dies before workflow transition is recorded

authority B takes workflow
```

B MUST NOT create a second logical execution of the same ActionDef.

The runtime must reconcile the stable invocation identity and determine whether the action already logically committed.

---

# 33. EFFECT IDENTITY COMPOSITION

Effects created by an ActionDef invoked from a workflow MUST retain stable logical effect identity across workflow retries.

A workflow retry MUST NOT accidentally create:

```text
charge-card attempt #1 as logical payment A

and

charge-card attempt #2 as unrelated logical payment B
```

if both represent the same logical workflow action activation.

Physical retry semantics remain governed by the effect system.

---

# 34. ACTION STEP SUCCESS

After ActionDef logical success:

the workflow MUST durably transition exactly once to its declared next step.

---

# 35. ACTION STEP FAILURE

A terminal ActionDef failure must either:

```text
follow explicit onError edge
```

or:

```text
fail the workflow
```

depending on WorkflowDef semantics.

---

# 36. ONERROR

Action steps MAY define:

```text
onError
```

pointing to another workflow step.

This provides declarative error handling without arbitrary catch code.

---

# 37. ERROR VALUE

If failure details become available to later workflow logic, only canonical structured error information may be bound.

Do not expose host stack frames or provider-specific raw exception objects as workflow semantics.

---

# 38. RETRY POLICY

Action steps MAY declare a portable retry policy.

Minimum useful model:

```text
maxAttempts

initialDelay

backoffMultiplier

maxDelay
```

---

# 39. RETRY CLASSIFICATION

Automatic workflow retries SHOULD apply only to runtime-classified retryable failures.

Examples:

```text
temporary infrastructure unavailability

lease interruption before logical commit

retryable provider condition
```

Do not automatically retry semantic business refusal unless the WorkflowDef explicitly requests semantics that make doing so safe.

---

# 40. RETRYABLE VS TERMINAL

Axiom MUST expose a structured distinction equivalent to:

```text
retryable failure

terminal semantic failure
```

Workflow logic MUST NOT determine this by parsing error-message strings.

---

# 41. RETRY ATTEMPT IDENTITY

Each physical execution attempt gets a distinct attempt identity.

Conceptually:

```text
logical activation:
    workflow/123/action-charge

attempt:
    1

attempt:
    2

attempt:
    3
```

Logical action identity remains constant.

---

# 42. RETRY DURABILITY

Retry count and next eligible execution time MUST be durable.

Authority death must not reset:

```text
attempt = 4
```

back to:

```text
attempt = 1
```

unless the attempt never durably existed.

---

# 43. NO RETRY STORM

Multiple authorities MUST NOT independently retry the same workflow step simultaneously as separate logical owners.

Lease/fencing semantics must ensure one current authorized executor.

---

# 44. TIMER STEP

A timer step waits until a durable time condition.

Support:

```text
after duration
```

and/or:

```text
at instant
```

---

# 45. TIMER EVALUATION

Timer target time MUST be evaluated exactly once when the timer activation becomes durable.

Example:

```text
after 24h
```

activation occurs at:

```text
2026-09-01T10:00Z
```

durable target:

```text
2026-09-02T10:00Z
```

A restart MUST NOT recompute:

```text
now + 24h
```

and accidentally extend the wait.

---

# 46. TIMER IDENTITY

Each timer activation must have stable logical identity.

Conceptually:

```text
workflowTimerId =
    workflowInstanceId
    +
    activationId
```

Repeated scheduler attempts must refer to the same logical timer.

---

# 47. TIMER DELIVERY

Scheduler firing may be physically at-least-once.

Workflow transition caused by that timer must be logically exactly once.

---

# 48. TIMER RECOVERY

Crash scenario:

```text
workflow durably enters timer step

authority dies before scheduler registration completes
```

The timer MUST NOT be lost permanently.

Either:

* timer registration is atomic with workflow transition; or
* waiting workflow state is sufficient to reconstruct the same timer safely.

---

# 49. TIMER LATE DELIVERY

A timer firing after its target time remains valid.

The baseline semantic guarantee is:

```text
not before target time
eventually after target time
```

subject to scheduler availability.

0.14 does not promise hard real-time execution.

---

# 50. WAIT-EVENT STEP

A workflow may wait for a canonical Axiom event.

Conceptually:

```text
wait_payment:
    wait-event:
        event: payment_confirmed
        where:
            event.orderId == workflow.input.orderId
    next: ship_order
```

---

# 51. EVENTDEF REMAINS CANONICAL

WorkflowDef MUST reference the existing canonical event model.

Do not introduce a separate workflow message bus.

---

# 52. EVENT CORRELATION

A wait-event step may define a portable correlation/filter expression over:

```text
event payload

workflow inputs

durable workflow bindings
```

and other explicitly defined workflow expression scope.

---

# 53. EVENT FILTER DETERMINISM

The event correlation predicate MUST be deterministic.

Do not permit:

```text
now()

uuid()

random()

host process state
```

inside event matching.

---

# 54. EVENT WAIT ACTIVATION

A wait-event activation must durably establish:

```text
which event type

correlation predicate

activation identity

event observation boundary
```

before the workflow can rely on future event delivery.

---

# 55. NO-GAP EVENT WAIT

Critical invariant:

```text
workflow leaves step A

workflow enters wait-event B

matching event E commits during handoff
```

E MUST NOT be permanently lost because it landed between:

```text
workflow transition
```

and:

```text
event subscription registration
```

---

# 56. EVENT WAIT OBSERVATION BOUNDARY

The implementation MUST define a durable event observation boundary.

Conceptually:

```text
event cursor

event sequence

durable journal position

or equivalent
```

Axiom must be able to determine whether a matching event occurred after the wait became semantically active.

---

# 57. NO IN-MEMORY-ONLY EVENT REGISTRATION

Forbidden correctness model:

```text
workflow state = waiting

then

processEmitter.on(event)
```

with no durable recovery mechanism.

A crash between those operations creates a permanent semantic gap.

---

# 58. EVENT HISTORY OR RECOVERABLE REGISTRATION

One of the following must hold:

### Model A

The event system has enough durable history to scan from the wait activation's cursor.

### Model B

The wait registration itself is durably committed before events can be considered missed.

### Model C

Equivalent recoverable mechanism proven gap-free.

---

# 59. EVENT DEDUP

Existing external event dedup semantics remain authoritative.

Repeated physical delivery of the same logical event MUST NOT cause a workflow wait activation to transition twice.

---

# 60. EVENT FANOUT

Baseline 0.14 event waits SHOULD use observation/fanout semantics:

```text
one matching logical event
may unblock multiple workflow instances
```

if each independently matches.

0.14 SHOULD NOT introduce competing-consumer queue semantics.

---

# 61. EVENT CONSUMPTION

A workflow wait MUST NOT globally "consume" an event such that another valid matching workflow cannot observe it unless such queue semantics are explicitly introduced in a future release.

---

# 62. EVENT OUTPUT BINDINGS

A wait-event step MAY bind selected canonical event fields into durable workflow bindings.

Example:

```text
bind:
    paymentId: event.paymentId
    amount: event.amount
```

---

# 63. EVENT PAYLOAD SNAPSHOT

Values bound from an event must represent the matched logical event occurrence.

Later workflow steps MUST NOT silently read a mutated external payload representation.

---

# 64. WAIT-EVENT TIMEOUT

A wait-event step MAY declare a timeout.

Example:

```text
wait payment

timeout: 7 days

onTimeout: cancel_order
```

---

# 65. TIMEOUT RACE

If matching event and timeout occur concurrently:

exactly one logical transition may win.

Required:

```text
event branch
XOR
timeout branch
```

Never both.

---

# 66. TIMEOUT LINEARIZATION

The winner must be determined by durable workflow-instance concurrency control.

Do not resolve event-vs-timeout races using:

```text
which callback happened first in one process
```

---

# 67. BRANCH STEP

A branch step evaluates deterministic workflow data.

Conceptually:

```text
branch:
    if workflow.input.expedited:
        -> priority_shipping
    else:
        -> standard_shipping
```

---

# 68. BRANCH EXPRESSION SCOPE

Branch expressions SHOULD be restricted to durable workflow context:

```text
inputs

bindings

canonical prior-step outcomes explicitly persisted
```

Avoid implicit live reads of:

```text
StateDef

DataProvider

current wall clock
```

inside branch evaluation.

---

# 69. WHY BRANCH IS PURE

A branch should be replayable and explainable.

If current external state is required, model that state interaction as a canonical ActionDef before the branch.

Then branch on the resulting durable semantic outcome where supported.

---

# 70. BRANCH DETERMINISM

Repeated evaluation of the same branch activation against the same durable workflow state MUST choose the same edge.

---

# 71. COMPLETE STEP

`complete` transitions the workflow instance to:

```text
completed
```

exactly once.

A completed workflow never resumes normal execution.

---

# 72. COMPLETION OUTPUT

WorkflowDef MAY define a canonical completion result assembled from:

```text
inputs

durable bindings

literal portable values
```

if required.

No arbitrary runtime object.

---

# 73. FAIL STEP

`fail` transitions the workflow to:

```text
failed
```

with a structured portable failure.

---

# 74. TERMINAL STATES

Terminal statuses:

```text
completed

failed

cancelled
```

must be durable and irreversible under normal execution.

A stale authority MUST NOT resurrect a terminal workflow.

---

# 75. CANCELLATION API

Provide an operation conceptually equivalent to:

```ts
server.cancelWorkflow(instanceId, ...)
```

Cancellation MUST be idempotent.

---

# 76. CANCELLATION IS NOT ROLLBACK

Cancellation means:

```text
do not continue executing future workflow steps
```

It does NOT imply:

```text
undo already committed actions

undo external effects

distributed transaction rollback
```

Documentation must make this explicit.

---

# 77. NO IMPLICIT COMPENSATION

0.14 MUST NOT pretend arbitrary side effects can be automatically reversed.

Compensation/sagas may be a future explicit semantic feature.

---

# 78. CANCELLATION RACE

Race:

```text
authority A completes current action

authority B processes cancellation
```

Exactly one durable instance revision ordering wins.

The resulting state must be deterministic according to documented rules.

---

# 79. CANCELLATION WHILE WAITING

A waiting timer/event workflow must become cancelled durably.

Any later timer/event delivery must not transition the cancelled workflow.

---

# 80. CANCELLATION DURING PHYSICAL EFFECT

Cancellation cannot guarantee interruption of an already dispatched physical external effect.

The framework must remain honest about uncertain physical execution.

Logical workflow execution after cancellation must nevertheless stop according to the committed workflow state.

---

# 81. WORKFLOWSTORE

Introduce a runtime persistence abstraction for durable workflow state.

Conceptually:

```ts
WorkflowStore
```

It must support at least:

```text
create idempotently

load

claim/lease where required

compare-and-swap transition

record waiting state

record terminal state

recover runnable instances
```

Exact API is implementation-owned but must be provider-independent.

---

# 82. MEMORY WORKFLOW STORE

Provide a memory reference implementation.

It may be:

```text
single-process only
```

but must implement the same logical workflow semantics.

---

# 83. SQLITE WORKFLOW STORE

Provide a SQLite durable reference implementation.

It MUST support:

* independent OS-process connections;
* contention;
* crash recovery;
* leasing/fencing where required;
* concurrent startup;
* durable workflow state.

---

# 84. NO SQLITE SEMANTICS IN GRAPH

WorkflowDef must not contain:

```text
SQLite path

table name

rowid

WAL position

busy timeout
```

These remain runtime/provider configuration.

---

# 85. WORKFLOW INSTANCE REVISION

Each workflow instance should have a monotonic durable revision.

Conceptually:

```text
instanceRevision
```

Every logical transition performs:

```text
expected revision R
    ->
new revision R+1
```

or equivalent CAS/fencing.

---

# 86. INSTANCE REVISION PURPOSE

This revision provides linearization for races such as:

```text
event vs timeout

cancel vs action completion

two authorities attempting same step

stale authority vs new authority
```

---

# 87. OWNERSHIP MODEL

Workflow execution MUST remain leaderless at deployment level.

Do not introduce:

```text
global workflow leader

primary node

workflow master process
```

Any compatible authority should be able to execute an eligible workflow instance.

---

# 88. PER-WORKFLOW LEASE

A runnable workflow instance MAY use a short durable lease.

Conceptually:

```text
workflowInstanceId
owner
leaseUntil
fence
```

This is infrastructure ownership, not application meaning.

---

# 89. FENCING

A lease alone is insufficient.

Every durable workflow mutation performed under ownership MUST be fenced.

A stale authority whose lease expired MUST NOT advance the workflow after another authority obtained a newer lease/fence.

---

# 90. STALE PROCESS

Required race:

```text
A owns workflow

A pauses

lease expires

B acquires newer fence

B advances workflow

A resumes
```

A MUST be refused when attempting to commit with the stale fence.

---

# 91. PROCESS-LOCAL LOCKS INSUFFICIENT

The following cannot provide distributed correctness:

```text
Mutex

Promise queue

Node event loop serialization

in-memory Set

single process scheduler
```

They may optimize locally but cannot replace durable fencing.

---

# 92. DURABLE WORK REUSE

0.14 SHOULD reuse established 0.12 distributed coordination and durable-work primitives where semantically appropriate.

Do not create a second independent lease/fencing system without justification.

---

# 93. WORKFLOW VS DURABLE WORK

Keep distinction clear:

```text
WorkflowInstance
    semantic long-running application computation

DurableWork
    runtime mechanism for safely scheduling/claiming execution
```

DurableWork is infrastructure.

WorkflowDef is graph meaning.

---

# 94. CRASH RECOVERY

After startup, an authority must be able to discover workflow instances that are:

```text
runnable

retry-due

timer-due

recoverably waiting
```

without application intervention.

---

# 95. NO MANUAL RESUME FOR NORMAL CRASH

Application code must not be required to:

```text
scan stuck workflows

call resumeWorkflow after process crash

re-register timers

re-register event waits
```

for normal supported recovery.

---

# 96. WORKFLOW DISCOVERY

Recovery scanning must be bounded and operationally realistic.

Avoid:

```text
load every workflow instance into memory forever
```

SQLite reference implementation should support indexed eligible-work discovery.

---

# 97. STARTUP SAFETY

Multiple authorities starting concurrently against a fresh workflow store MUST safely initialize required metadata.

No ordinary startup race may leak raw SQLite lock errors.

---

# 98. CLAIM RACE

With 2/4/8 authorities racing one runnable workflow:

exactly one current fence may win execution ownership.

Other authorities must back off/refuse cleanly.

---

# 99. ACTION CLAIM RACE

Run the same workflow action step under deliberately synchronized authority race.

Required:

```text
logical action invocations = 1
logical workflow transitions = 1
```

Physical attempts may exceed one only where existing effect semantics allow it.

---

# 100. CRASH BEFORE ACTION EXECUTION

Crash after workflow activation is durable but before ActionDef begins.

Another authority must execute the same activation.

No permanent wedge.

---

# 101. CRASH DURING ACTION EXECUTION

Crash during ActionDef execution before logical commit.

Another authority must eventually retry/reconcile according to existing action transaction semantics.

No speculative workflow transition.

---

# 102. CRASH AFTER ACTION COMMIT

Critical case:

```text
ActionDef logical commit succeeds

authority dies before workflow records step completion
```

Recovery MUST NOT logically execute the action twice.

This is a release-blocking invariant.

---

# 103. CRASH AFTER WORKFLOW TRANSITION

Crash after durable workflow transition but before in-process scheduling of the next step.

Another authority must discover the new runnable step.

No permanent wedge.

---

# 104. CRASH AFTER TIMER DUE

Timer becomes due.

Serving authority dies before workflow transition.

Another authority must process the same logical timer activation exactly once.

---

# 105. CRASH DURING EVENT MATCH

Matching event is durable.

Authority processing match dies before workflow transition.

Another authority must still be able to match/reconcile it.

---

# 106. CRASH AFTER EVENT TRANSITION

Workflow transition caused by event commits.

Process dies before acknowledging/advancing event-processing cursor.

Replay may occur physically.

Logical workflow transition must remain exactly once.

---

# 107. FAILURE DOMAINS

Tests must explicitly distinguish:

```text
workflow-store crash boundary

action commit boundary

effect delivery boundary

scheduler boundary

event observation boundary

authority lease boundary
```

Do not infer one from another.

---

# 108. CROSS-AUTHORITY TOPOLOGY

Run workflows under:

```text
1 authority

2 authorities

8 authorities
```

with the same graph.

Application meaning must not change.

---

# 109. RANDOM ROUTING

Randomly route:

```text
workflow starts

ordinary API traffic

events

cancellation requests
```

across authorities.

Workflow ownership must remain transparent.

---

# 110. AUTHORITY SIGKILL

Use real:

```text
SIGKILL
```

at multiple workflow phases.

Graceful shutdown alone is insufficient.

---

# 111. AUTHORITY REPLACEMENT

Kill an authority permanently and start a new compatible authority.

Active workflows must remain recoverable.

No sticky routing.

---

# 112. MIXED BUILD

Workflow instances must bind a compatibility fingerprint sufficient to prevent a semantically different WorkflowDef from silently continuing an existing instance.

---

# 113. WORKFLOW COMPATIBILITY FINGERPRINT

A running workflow instance MUST record enough semantic identity to answer:

```text
is this runtime executing the same workflow meaning?
```

At minimum include the existing semantic compatibility information and WorkflowDef meaning.

---

# 114. PRESENTATION-ONLY CHANGES

Changes that do not alter workflow semantic meaning SHOULD NOT invalidate workflow compatibility.

---

# 115. SEMANTIC WORKFLOW CHANGE

Changing:

```text
action step target

branch predicate

event type

event correlation predicate

timer duration

control-flow edge

retry policy

completion meaning
```

must affect workflow semantic compatibility.

---

# 116. MIXED-BUILD FAIL-CLOSED

If authority B cannot safely continue instance I created under authority A's WorkflowDef semantics:

B MUST fail closed.

It MUST NOT silently interpret the persisted step id under new semantics.

---

# 117. RUNNING INSTANCE MIGRATION

Automatic migration of active workflow instances across incompatible WorkflowDef versions is OUT OF SCOPE for 0.14.

Fail closed.

Future workflow migration semantics may be added explicitly.

---

# 118. SERVER IR V8

WorkflowDef introduces new portable semantic vocabulary.

Therefore 0.14 SHOULD introduce:

```text
axiom.server.v8
```

Do not encode WorkflowDef only in private runtime metadata.

---

# 119. OLD IR FROZEN

Existing:

```text
axiom.server.v1 ... v7
```

must remain frozen.

Do not rewrite historical IR contracts.

---

# 120. COMPILER

Compiler must serialize valid WorkflowDefs into portable Server IR v8.

Invalid workflow graphs must fail with structured diagnostics.

---

# 121. WORKFLOW VALIDATION

Validation must cover at least:

```text
entry step exists

step ids unique

all edges resolve

terminal steps valid

no forbidden cycles

referenced ActionDefs exist

referenced EventDefs exist

input refs valid

binding refs valid

branch refs valid

event filter refs valid

timer expression valid

retry policy valid

terminal reachability

no impossible step kind combinations
```

---

# 122. UNREACHABLE STEPS

Validation SHOULD report unreachable workflow steps.

Whether this is warning or error must be explicit.

Preferred for 0.14:

```text
validation error
```

because unreachable workflow graph usually represents an authoring mistake.

---

# 123. TERMINAL REACHABILITY

Every possible control-flow path SHOULD be statically capable of reaching:

```text
complete
```

or:

```text
fail
```

unless it ends in an intentional durable wait that may never resolve.

---

# 124. STRUCTURED VALIDATION CODES

Add stable validation diagnostics.

Conceptual examples:

```text
WORKFLOW_ENTRY_NOT_FOUND

WORKFLOW_STEP_NOT_FOUND

WORKFLOW_CYCLE_NOT_ALLOWED

WORKFLOW_ACTION_NOT_FOUND

WORKFLOW_EVENT_NOT_FOUND

WORKFLOW_BINDING_NOT_FOUND

WORKFLOW_DUPLICATE_BINDING

WORKFLOW_INVALID_RETRY_POLICY

WORKFLOW_INVALID_TIMER

WORKFLOW_UNREACHABLE_STEP
```

Exact taxonomy may follow existing conventions.

---

# 125. NO GENERIC EXCEPTION FOR INVALID GRAPH

Invalid WorkflowDef must not fail as:

```text
TypeError

undefined is not a function

Cannot read property ...

SQLITE error
```

Graph defects require semantic diagnostics.

---

# 126. WORKFLOW EXPRESSION SCOPE

Define workflow expression scope explicitly.

Potential canonical scope:

```text
workflow inputs

durable workflow bindings

current event payload within wait-event matching/binding

structured current step result where explicitly supported

PRINCIPAL where semantically appropriate
```

Do not rely on generic global ref resolution.

---

# 127. STATEDEF ACCESS

0.14 SHOULD NOT automatically allow arbitrary direct StateDef refs in portable workflow branch expressions merely because authority runtime could technically resolve them.

If dynamic application state is needed:

prefer canonical ActionDef interaction.

This keeps workflow decisions explicit and durable.

---

# 128. PROVIDER QUERY ACCESS

Workflow branch expressions MUST NOT secretly execute QueryDefs.

A future first-class:

```text
wait-query

query step
```

may be designed separately.

0.14 should not hide network/storage reads inside a pure branch.

---

# 129. NONDETERMINISM

Pure workflow expressions must reject nondeterministic builtins such as:

```text
uuid()

random()

now()
```

except where time is explicitly captured by timer activation semantics.

---

# 130. TIMESTAMP CAPTURE

If workflow start time or activation time is available to expressions:

it must be a durable captured value.

Do not re-read wall clock during replay and call that the same semantic value.

---

# 131. WORKFLOWSTORE CONCURRENCY CONTRACT

WorkflowStore transition should conceptually provide:

```text
compare:
    instanceRevision
    fence

write:
    new durable workflow state

atomically
```

or equivalent.

---

# 132. SQLITE WORKFLOW ATOMICITY

SQLite reference store SHOULD use a transaction equivalent to:

```text
BEGIN IMMEDIATE

verify expected instance revision
verify current fence
write transition
advance instance revision

COMMIT
```

No optimistic check outside the transaction.

---

# 133. SQLITE LOST-TRANSITION REGRESSION

Construct multiple processes attempting conflicting workflow transitions from the same instance revision.

Exactly one transition may commit.

No silent overwrite.

---

# 134. SQLITE CONTENTION

Normal workflow concurrency MUST NOT leak:

```text
SQLITE_BUSY

SQLITE_LOCKED

ERR_SQLITE_ERROR

database is locked
```

to application semantics.

---

# 135. SQLITE CONCURRENT STARTUP

Test:

```text
2 processes

4 processes

8 processes
```

simultaneously initializing a fresh workflow store.

Target raw lock leakage:

```text
0
```

---

# 136. WORKFLOW OBSERVABILITY

Provide public runtime inspection conceptually equivalent to:

```ts
server.getWorkflow(instanceId)
```

and/or:

```ts
server.inspectWorkflow(instanceId)
```

It must expose semantic status without implementation secrets.

---

# 137. WORKFLOW INSPECTION FIELDS

Useful fields include:

```text
instanceId

workflowId

status

currentStepId

activationId

attempt

waitingReason

nextEligibleAt

createdAt

updatedAt

instanceRevision

failure summary
```

Do not expose:

```text
HMAC secrets

database file paths

raw SQL

provider credentials
```

---

# 138. STATIC AGENTAPI

AgentAPI MUST expose WorkflowDef semantics without executing the workflow.

Conceptually:

```text
analyzeWorkflow(workflowId)
```

---

# 139. AGENTAPI ANALYSIS

A cold agent should be able to determine:

```text
inputs

entry step

all steps

action dependencies

event dependencies

timer waits

branch conditions

retry policies

possible terminal outcomes

whether graph is acyclic

authorization context

possible wait reasons
```

---

# 140. WHY IS THIS WORKFLOW WAITING?

Runtime inspection should support answering:

```text
Why is workflow instance wf_123 waiting?
```

Example:

```text
step:
    wait_payment

reason:
    waiting for payment_confirmed

correlation:
    orderId = order_42

timeout:
    2026-09-05T10:00Z
```

---

# 141. WHAT CAN HAPPEN NEXT?

Agent/runtime inspection SHOULD make it possible to derive:

```text
what events could unblock this workflow?

when can its timer fire?

what action is next?

what terminal paths remain?
```

This is part of Axiom's AI-native design goal.

---

# 142. WORKFLOW HISTORY

0.14 SHOULD retain a bounded or durable semantic transition history sufficient for explainability and recovery.

At minimum:

```text
workflow started

step activated

step succeeded/failed

retry scheduled

event matched

timer fired

workflow completed/failed/cancelled
```

---

# 143. HISTORY IS NOT EVENT SOURCING REQUIREMENT

0.14 does NOT require all workflow state to be rebuilt exclusively by replaying an event log.

A durable current instance record plus transition history is acceptable.

---

# 144. HISTORY PORTABILITY

History entries exposed publicly should use semantic workflow concepts.

Do not expose:

```text
SQLite txn 392

worker pid 4121

WAL frame 202
```

as application meaning.

---

# 145. HISTORY ATTEMPTS VS LOGICAL EVENTS

Differentiate:

```text
logical step activation/success

physical execution attempts
```

This is important for debugging retries.

---

# 146. WORKFLOW START EVENT

Workflow start should be represented as one logical occurrence even if client start request is retried.

---

# 147. STATUS QUERY

Reading workflow status must be safe through any compatible authority.

No authority-local cache may permanently return stale terminal state.

---

# 148. LIVE QUERY INTEGRATION

0.14 MAY expose workflow instance data as provider-backed/internal runtime data for observability.

But WorkflowDef correctness MUST NOT depend on the application opening a live QueryDef.

---

# 149. NO WORKFLOW-WAITS-ON-LIVEQUERY IN 0.14

Do not introduce:

```text
wait until QueryDef returns X
```

in the base 0.14 release.

This combines two non-trivial durable observation models and should be specified separately if desired.

---

# 150. EXISTING LIVE QUERIES MUST NOT REGRESS

All 0.13.1 Phase 21 invariants remain release blockers.

Re-run:

```text
provider-record remote observation

1/2/8 topology

canonical delta model

cursor security

reconnect

slow consumer

SQLite lost-write

F2 validation

live conformance
```

---

# 151. EXISTING DISTRIBUTED AUTHORITY MUST NOT REGRESS

Re-run relevant 0.12/0.12.1 invariants:

```text
lease fencing

durable-work identity

effect logical identity

scheduler race

event dedup

StateDef coherence

SQLite concurrency

mixed-build fail-closed
```

---

# 152. EXISTING ACTION SEMANTICS MUST NOT REGRESS

Workflow-driven ActionDef invocation must produce the same canonical action meaning as direct ActionDef invocation under equivalent principal/arguments.

Workflow is orchestration over actions, not a second action runtime.

---

# 153. REFERENCE WORKFLOW 1 — ORDER FULFILLMENT

Provide a canonical reference workflow equivalent to:

```text
order_fulfillment

input:
    orderId

1 reserve_inventory
    action reserve_inventory
    -> wait_payment

2 wait_payment
    wait event payment_confirmed(orderId)
    timeout 7 days
    -> ship
    timeout -> cancel_reservation

3 ship
    action create_shipment
    -> complete

4 cancel_reservation
    action release_inventory
    -> fail

5 complete
    complete
```

This should exercise:

```text
action

event wait

timeout

branching via timeout edge

completion/failure

principal propagation

durability
```

---

# 154. REFERENCE WORKFLOW 2 — TIMER

Example:

```text
trial_expiry

input:
    accountId

wait 30 days

action expire_trial

complete
```

Use for timer restart/failover testing.

---

# 155. REFERENCE WORKFLOW 3 — RETRY

Example:

```text
provision_service

action provision
    retry:
        maxAttempts: 5
        initialDelay: 1s
        multiplier: 2

complete
```

Inject transient failures.

Prove durable retry state.

---

# 156. CONFORMANCE V8

Introduce:

```text
axiom.conformance.v8
```

with portable workflow fixtures.

Existing v1-v7 tiers remain frozen.

---

# 157. MINIMUM WORKFLOW CONFORMANCE FIXTURES

At minimum:

```text
workflow-start-complete

workflow-action-success

workflow-action-terminal-failure

workflow-action-on-error

workflow-action-retry

workflow-timer

workflow-event-match

workflow-event-nonmatch

workflow-event-timeout

workflow-branch-true

workflow-branch-false

workflow-cancel-waiting

workflow-start-idempotency

workflow-stale-transition-refused

workflow-mixed-build-refused
```

---

# 158. CONFORMANCE NEGATIVE CONTROLS

Corrupt expected results in multiple workflow fixtures.

Runner MUST fail.

The workflow conformance tier must not be vacuously green.

---

# 159. CONFORMANCE PORTABILITY

Workflow fixture semantics must not depend on:

```text
Node.js timers

SQLite rowids

process ids

filesystem path

JavaScript object identity
```

A future independent runtime must be able to implement the fixtures from the contract alone.

---

# 160. INDEPENDENT RUNTIME PRESSURE

0.14 is a particularly important release for cross-runtime discipline.

Every workflow semantic decision should be asked:

> Could a Rust or Kotlin runtime implement this from Server IR and conformance fixtures without reading the TypeScript implementation?

If not, the contract is underspecified.

---

# 161. NO JAVASCRIPT ACCIDENTS IN IR

Audit Server IR v8 for values such as:

```text
undefined

NaN

Infinity

Date object

RegExp object

function

class name

Promise

Error instance
```

Use explicit portable value representations.

---

# 162. DOCUMENTATION

Add a dedicated canonical workflow document.

Suggested:

```text
docs/WORKFLOWS.md
```

---

# 163. WORKFLOWS DOCUMENT MUST EXPLAIN

At minimum:

```text
what WorkflowDef is

how to start one

idempotent start

step types

workflow inputs/bindings

principal semantics

action invocation identity

logical vs physical exactly-once

event waits

timer semantics

retry semantics

cancellation

failure

crash recovery

multi-authority behaviour

compatibility

inspection

limitations
```

---

# 164. AGENT_REFERENCE

Update machine-oriented `AGENT_REFERENCE.md`.

A cold coding agent should discover WorkflowDef from:

```text
llms.txt
    ->
AGENT_REFERENCE
    ->
WORKFLOWS.md
    ->
.d.ts
    ->
AgentAPI
    ->
conformance
```

without framework source.

---

# 165. ANTI-PATTERN — MANUAL WORKFLOW STATE MACHINE

Document equivalent of:

```text
StateDef workflowStatus

if status == "waiting":
    setTimeout(...)
```

Why wrong:

* timer not durable;
* failover unsafe;
* retries application-owned;
* semantics invisible to AgentAPI.

Use WorkflowDef.

---

# 166. ANTI-PATTERN — RANDOM JOB IDS

Document why retrying a workflow action with a newly generated operation id can duplicate logical effects.

Stable activation identity is required.

---

# 167. ANTI-PATTERN — PROCESS TIMER

Forbidden correctness dependency:

```text
setTimeout(..., 86400000)
```

for durable workflow meaning.

---

# 168. ANTI-PATTERN — EVENT LISTENER GAP

Document:

```text
commit waiting state

then attach in-memory listener
```

without durable event boundary.

This creates a lost-event race.

---

# 169. ANTI-PATTERN — COMPENSATION AS ROLLBACK

Document that:

```text
cancelWorkflow()
```

does not magically reverse prior effects.

---

# 170. ANTI-PATTERN — STICKY ROUTING

Application must not pin a workflow instance to the authority that started it.

Any compatible authority may continue execution.

---

# 171. ANTI-PATTERN — APPLICATION LEADER

Application must not implement:

```text
if leader:
    run workflows
```

Workflow scheduling/ownership is framework infrastructure.

---

# 172. ANTI-PATTERN — POLLING WORKFLOW TABLE

Application must not periodically query workflow storage and manually execute due steps.

Framework runtime owns eligibility scanning.

---

# 173. SEMANTIC ESCAPE TARGET

Reference applications must require:

```text
manual job queue                     0

manual workflow-state machine        0

manual workflow locks                0

manual leader election               0

manual retry counter                 0

manual durable timer                 0

manual event subscription recovery   0

manual idempotency registry          0

manual workflow polling              0

sticky routing                       0

NativeOperation workflow logic       0

application SQL workflow logic       0
```

Target:

```text
E1
```

---

# 174. PERFORMANCE

Measure:

```text
workflow start latency

single transition latency

SQLite transition write cost

claim/lease cost

idle workflow scan cost

timer wake latency

event-match latency

retry scheduling cost

1/2/8 authority overhead
```

No arbitrary hard SLA for 0.14.

Correctness first.

---

# 175. BOUNDEDNESS

A large number of waiting workflows MUST NOT require one in-memory timer or event listener per instance if that creates unbounded authority memory.

Reference implementation should use indexed durable eligibility.

---

# 176. WAITING TIMER SCALE

Test:

```text
1

100

1,000

10,000
```

waiting timer workflows where practical.

Record:

```text
memory

poll/scan cost

startup cost
```

No requirement that all 10,000 execute in a unit test, but architecture must remain bounded.

---

# 177. EVENT WAIT SCALE

Likewise inspect:

```text
many workflow waits on same event type
```

Event matching must not leak memory indefinitely.

---

# 178. TERMINAL RETENTION

Define workflow retention policy separately from semantic status.

Example runtime configuration may permit GC after a retention window.

Deleting old terminal history MUST NOT alter active workflow semantics.

---

# 179. ACTIVE WORKFLOW MUST NOT EXPIRE

Retention GC MUST NOT delete:

```text
running

waiting

retrying
```

workflow instances.

---

# 180. START IDEMPOTENCY RETENTION

If terminal workflow records are eventually GC'd, define how long start idempotency keys remain protected from accidental duplicate recreation.

Do not silently claim eternal idempotency if records are deleted after one hour.

---

# 181. EXTERNAL EFFECT UNCERTAINTY

Reference workflow must include an action producing an externally visible effect and force:

```text
send succeeds

process dies before response
```

Workflow semantics must compose with existing effect uncertainty handling.

Do not invent workflow-specific fake exactly-once guarantees.

---

# 182. WORKFLOW ACTION WITHOUT EFFECT

Also test pure StateDef/provider-record ActionDef to isolate workflow transition correctness from external effect semantics.

---

# 183. EVENT DUPLICATE DELIVERY

Deliver same logical external event repeatedly.

Expected:

```text
one logical workflow transition
```

per matching wait activation.

---

# 184. EVENT OUT-OF-ORDER DELIVERY

Where event source permits out-of-order physical delivery, workflow matching must rely on logical event identity/observation boundary rather than socket arrival order.

---

# 185. EVENT BEFORE WAIT

Define explicitly:

```text
matching event committed before wait activation
```

Baseline recommendation:

it does NOT satisfy the wait unless WorkflowDef explicitly requests historical matching.

0.14 event wait means:

```text
wait for a matching event after this activation becomes semantically active
```

This must be documented.

---

# 186. EVENT DURING WAIT ACTIVATION

Matching event committed concurrently with wait activation MUST obey the no-gap boundary.

It must be classified deterministically as either:

```text
before activation
```

or:

```text
after activation
```

Never permanently lost in an undefined middle.

---

# 187. TIMER VS CANCELLATION

Race timer due against cancellation.

Exactly one terminal/control transition order must win according to instance CAS.

No resurrection after cancellation.

---

# 188. EVENT VS CANCELLATION

Same requirement for matching event vs cancellation.

---

# 189. ACTION COMPLETION VS CANCELLATION

Same requirement.

Document whether:

```text
action completion commits first
```

may activate next step before cancellation becomes terminal.

Whichever transition wins must remain durable and explainable.

---

# 190. COMPLETION VS CANCELLATION

If completion already committed:

later cancellation should return an explicit terminal-state result, not convert completed to cancelled.

---

# 191. FAILURE VS CANCELLATION

Define deterministic behaviour when both race.

Do not allow terminal status to flip repeatedly.

---

# 192. WORKFLOW RETRY VS CANCELLATION

Cancellation while waiting for retry prevents future attempt.

Scheduled retry wakeups after cancellation become harmless no-ops.

---

# 193. WORKFLOW RETRY VS AUTH CHANGE

Every retry must execute under the bound principal and current authorization semantics.

A previously authorized failed attempt does not guarantee later authorization.

---

# 194. WORKFLOW START VALIDATION

`startWorkflow` MUST reject:

```text
unknown workflowId

invalid arguments

unauthorized start

incompatible host capability

invalid idempotencyKey where constraints exist
```

with structured diagnostics.

---

# 195. HOST CAPABILITY

If a host lacks required durable workflow infrastructure:

starting a durable workflow must fail explicitly.

Do not silently downgrade to process-local workflow execution.

---

# 196. MEMORY MODE HONESTY

A memory workflow store may support development/test semantics.

Documentation must state:

```text
process restart loses workflows
```

if that is true.

It must not advertise durable cross-process safety.

---

# 197. SQLITE MODE HONESTY

SQLite reference runtime should advertise durable single-host/multi-process workflow capability consistent with its tested locking model.

Do not imply multi-region distributed database guarantees.

---

# 198. PROVIDER-AGNOSTIC GRAPH

The same WorkflowDef must work with:

```text
memory reference runtime

SQLite reference runtime
```

subject to documented durability capability differences.

No graph edits.

---

# 199. CAPABILITY DISCOVERY

Agent/runtime inspection should reveal whether current host can safely execute durable workflows.

Conceptually:

```text
workflowDurability:
    durable
    in-process
    unsupported
```

Exact API may differ.

---

# 200. FAIL-CLOSED DURABILITY

If graph requires durable WorkflowDef semantics but the runtime lacks durable workflow storage:

production/durable start must fail.

Do not silently give weaker meaning.

---

# 201. SECURITY — INSTANCE ACCESS

Reading/cancelling a workflow instance must respect authorization.

Possession of:

```text
instanceId
```

must not automatically grant access.

---

# 202. SECURITY — CROSS-PRINCIPAL ACCESS

Test:

```text
u1 starts workflow

u2 knows instanceId
```

u2 must not inspect/cancel it unless current authorization semantics allow that operation.

---

# 203. SECURITY — START IDEMPOTENCY KEY

Idempotency key alone must not become a secret bearer credential.

A different principal reusing the key must not receive another principal's workflow instance.

---

# 204. SECURITY — EVENT DATA

Workflow inspection must not expose event payload fields the inspecting principal is unauthorized to see if existing authorization semantics restrict them.

Define whether persisted bindings inherit workflow-instance visibility.

---

# 205. SECURITY — ERROR DATA

Do not expose:

```text
credentials

provider secrets

internal stack traces

SQL

HMAC secrets
```

through workflow failure/history APIs.

---

# 206. SECURITY — STALE PRINCIPAL

If the principal representation can expire or become invalid:

document execution behaviour explicitly.

Fail closed.

---

# 207. WORKFLOW NAMES DO NOT DRIVE SEMANTICS

Presentation-only names/descriptions must not alter semanticFingerprint.

Control graph meaning must.

---

# 208. SEMANTIC FINGERPRINT

WorkflowDef must participate in semanticFingerprint.

Changes to workflow execution meaning MUST alter it.

---

# 209. SCHEMA FINGERPRINT

Only WorkflowDef changes that alter schema semantics should affect schemaFingerprint according to existing fingerprint taxonomy.

Do not mechanically dump all workflow data into schemaFingerprint.

---

# 210. AUTHORITY COMPATIBILITY

Authorities executing existing workflow instances must agree on the semantic workflow contract.

Mixed incompatible authorities must fail closed.

---

# 211. WORKFLOW INSTANCE COMPATIBILITY

Persist compatibility information at workflow creation.

Do not derive continued compatibility solely from:

```text
workflowId == same string
```

---

# 212. OLD INSTANCE AFTER DEPLOY

Deploy semantically changed WorkflowDef while old instance is waiting.

New authority must detect incompatibility.

It must not execute:

```text
step "charge"
```

under changed semantics just because the step id still exists.

---

# 213. PRESENTATION CONTROL

Change only:

```text
display name

description

UI metadata
```

Old instance should remain compatible if semanticFingerprint remains unchanged.

---

# 214. PHASE 22 — BLIND EXTERNAL VALIDATION

After internal implementation is green:

publish:

```text
0.14.0-alpha.5
```

Then run a new blind external regression:

```text
Phase 22
Durable Workflows
```

---

# 215. BLIND TEST INPUT RULES

Tester receives only:

```text
published npm packages

shipped documentation

.d.ts

AgentAPI

public conformance

ordinary public runtime APIs
```

Tester MUST NOT receive:

```text
implementation report

design research note

repository source

internal tests

implementation hints
```

---

# 216. FRESH CONSUMER

Create a clean npm consumer.

Exact-pin every companion package to:

```text
0.14.0-alpha.5
```

No:

```text
workspace

npm link

file:

git:

local tarball

version mixing
```

---

# 217. BLIND DISCOVERY TASK

Starting only from:

> Build a durable long-running process that runs an action, waits for an external event or timeout, survives authority crashes, and eventually continues exactly once logically.

The tester must discover the intended WorkflowDef model from shipped artifacts.

---

# 218. EXTERNAL DISCOVERABILITY QUESTIONS

The blind report must answer:

1. What is a WorkflowDef?
2. How is a workflow started?
3. How is start made idempotent?
4. What step kinds exist?
5. What exactly is durable?
6. What is exactly-once logically?
7. What remains physically at-least-once?
8. How are retries represented?
9. How are timers represented?
10. How are events correlated?
11. What prevents event-registration gaps?
12. What prevents stale authority execution?
13. What happens on crash after ActionDef commit?
14. How is cancellation represented?
15. Does cancellation undo effects?
16. How are mixed builds handled?
17. How are workflows inspected?
18. How does principal propagation work?
19. What host capabilities are required?
20. What is intentionally out of scope?

Target:

```text
D1
```

---

# 219. EXTERNAL REFERENCE APPLICATION

Blind tester should construct at least one non-trivial workflow containing:

```text
ActionDef

wait-event

event timeout

timer

retry

completion

failure

cancellation
```

using no application orchestration infrastructure.

---

# 220. EXTERNAL SEMANTIC ESCAPE AUDIT

Scan consumer application for:

```text
manual workflow tables

manual workflow SQL

manual durable timers

manual retry loops

manual workflow polling

manual locks

leader election

Redis

custom pub/sub for workflow correctness

sticky routing

manual event recovery

manual idempotency store

NativeOperation orchestration
```

Target:

```text
all zero
```

and:

```text
E1
```

---

# 221. EXTERNAL START IDEMPOTENCY

Send duplicate concurrent start requests using same logical start identity.

Required:

```text
one workflow instance
```

Test uncertain response + retry.

---

# 222. EXTERNAL ACTION EXACTLY-ONCE LOGICAL TEST

Force crash:

```text
after ActionDef logical commit
before workflow step completion becomes visible to caller
```

Required:

```text
logical ActionDef invocation count = 1
workflow transition count = 1
```

---

# 223. EXTERNAL EFFECT HONESTY TEST

Where ActionDef creates external effect:

verify workflow does not overclaim physical exactly-once.

The observed behaviour must match documented Axiom effect semantics.

---

# 224. EXTERNAL EVENT NO-GAP TEST

Mandatory release blocker.

Race:

```text
workflow entering wait-event

matching event committing
```

At least:

```text
50 trials
```

Matching event must never be permanently lost if it belongs after the wait's semantic activation boundary.

---

# 225. EXTERNAL EVENT DUPLICATE TEST

Redeliver same logical event.

Target:

```text
one workflow transition
```

---

# 226. EXTERNAL EVENT NONMATCH TEST

Send many events of same type that fail correlation.

Workflow must remain waiting.

No false transition.

---

# 227. EXTERNAL EVENT TIMEOUT RACE

Race matching event and timeout repeatedly.

Target:

```text
exactly one edge wins
```

Never both.

---

# 228. EXTERNAL TIMER CRASH TEST

Kill authority:

```text
after timer activation

before due

at due

after scheduler claim

before workflow transition
```

Workflow must eventually advance once.

---

# 229. EXTERNAL RETRY TEST

Inject retryable failures.

Observe:

```text
attempt count durable

delay/backoff correct

logical action identity stable

eventual success or configured terminal failure
```

---

# 230. EXTERNAL RETRY CRASH TEST

Kill authority while waiting for retry.

Restart on another authority.

Retry schedule must survive.

---

# 231. EXTERNAL CANCELLATION TEST

Cancel workflow in:

```text
action pending

event waiting

timer waiting

retry waiting
```

Verify no future normal transition after committed cancellation.

---

# 232. EXTERNAL TERMINAL IMMUTABILITY

Try to stimulate:

```text
completed

failed

cancelled
```

instances using late timers/events/retries.

Terminal state must not resurrect.

---

# 233. EXTERNAL STALE AUTHORITY TEST

Use:

```text
SIGSTOP
```

or equivalent:

A owns instance.

Pause A.

Lease expires.

B advances instance.

Resume A.

A's stale transition MUST be fenced.

---

# 234. EXTERNAL 1/2/8 TEST

Run same workflow workload at:

```text
1 authority

2 authorities

8 authorities
```

Final logical workflow outcomes must be topology-equivalent.

---

# 235. EXTERNAL RANDOM ROUTING

Randomize authority handling of:

```text
start

event

cancel

inspection
```

No sticky ownership.

---

# 236. EXTERNAL SIGKILL CHAOS

With multiple workflows active:

randomly `SIGKILL` authorities and start replacements.

Every workflow must end in a legal canonical state.

No duplicate logical transitions.

No permanent wedges for workflows whose external waits are satisfiable.

---

# 237. EXTERNAL SQLITE RACE

Race multiple authorities on the same workflow instance revision.

Target:

```text
silent lost transitions = 0

double logical step commits = 0

raw SQLite leakage = 0
```

---

# 238. EXTERNAL CONCURRENT STARTUP

2/4/8 authorities against fresh SQLite workflow store.

Target:

```text
startup failures due ordinary contention = 0

raw DB lock leakage = 0
```

---

# 239. EXTERNAL MIXED-BUILD TEST

Create workflow instance under semantic build A.

Attempt continuation under semantically changed build B.

Required:

```text
fail closed
```

No silent continuation.

---

# 240. EXTERNAL PRESENTATION CONTROL

Change presentation-only metadata.

Compatible build should continue existing workflow.

---

# 241. EXTERNAL PRINCIPAL TEST

Workflow started by principal `u1`.

Later action execution must remain associated with `u1`.

Do not execute as:

```text
anonymous

host

admin
```

unless that is the original canonical principal.

---

# 242. EXTERNAL AUTHORIZATION CHANGE TEST

Start while action is authorized.

Change relevant authorization before later step.

Later action must be re-evaluated under current authorization semantics.

No privilege fossilization.

---

# 243. EXTERNAL INSPECTION TEST

Without source access, tester must be able to answer for a waiting workflow:

```text
what step is active?

why is it waiting?

what event could unblock it?

what timeout exists?

how many retries occurred?

what can happen next?
```

---

# 244. EXTERNAL CONFORMANCE

Run all workflow conformance v8 fixtures.

Use multiple reference stores where supported.

Negative controls MUST prove the runner is non-vacuous.

---

# 245. EXTERNAL REGRESSION — 0.13

Re-run critical Phase 21 live-query cases.

At minimum:

```text
provider-only cross-authority invalidation

1/2/8 live topology

cursor matrix

SIGKILL reconnect

SQLite lost-write
```

---

# 246. EXTERNAL REGRESSION — 0.12

Re-run selected distributed authority tests to prove workflow integration did not weaken leases/fencing/durable work.

---

# 247. FORBIDDEN COUNTERS

Phase 22 report must include explicit counters for:

```text
duplicate workflow instances from same start identity

lost committed workflow transitions

duplicate logical step transitions

duplicate logical ActionDef invocation

stale-owner successful commits

lost timer activations

lost matching events after wait activation

event+timeout both winning

retry counter regressions

workflow resurrection after terminal state

unauthorized workflow action execution

principal substitution

mixed-build silent continuation

topology-dependent workflow outcomes

manual application workflow locks

manual workflow polling

manual durable timers

manual retry loops

manual event recovery

manual idempotency registry

NativeOperation workflow orchestration

raw SQLITE_BUSY

raw SQLITE_LOCKED

ERR_SQLITE_ERROR

database is locked

silent SQLite workflow-store lost writes
```

Target:

```text
all zero
```

except explicitly permitted physical duplicate effect attempts under existing effect semantics.

---

# 248. RELEASE BLOCKERS

Any of the following blocks 0.14:

1. same start idempotency key can create two logical instances;
2. committed workflow transition can disappear after crash;
3. stale authority can commit after newer fence;
4. same activation can commit two logical transitions;
5. ActionDef can logically execute twice after crash boundary;
6. event can be permanently lost in wait-registration gap;
7. same event activation can transition twice;
8. event and timeout can both win;
9. timer can be permanently lost after workflow enters timer step;
10. timer can transition workflow twice;
11. retry state can be forgotten across crash;
12. cancelled workflow can resume;
13. completed workflow can resume;
14. failed workflow can resume;
15. cancellation claims to reverse an effect it did not reverse;
16. workflow principal can silently change across authorities;
17. authorization can be bypassed by durable execution;
18. semantically incompatible build can continue existing instance;
19. 1/2/8 authority topology changes logical outcome;
20. application needs sticky routing;
21. application needs workflow locks;
22. application needs leader election;
23. application needs manual durable timer infrastructure;
24. application needs manual retry infrastructure;
25. application needs manual event recovery;
26. application needs manual workflow-state machine;
27. application needs `NativeOperation` for ordinary workflow semantics;
28. raw SQLite lock/error leaks under supported contention;
29. workflow-store race silently loses committed transition;
30. critical 0.13 live-query invariant regresses;
31. critical 0.12 distributed-authority invariant regresses;
32. WorkflowDef requires framework source to understand;
33. portable conformance cannot distinguish correct from incorrect implementation;
34. blind external verdict is below `D1 / E1 / S1`.

---

# 249. INTERNAL IMPLEMENTATION PHASES

Recommended order:

### Phase 1 — semantic research

Resolve:

```text
WorkflowDef shape

step vocabulary

expression scopes

binding model

logical transition identity

ActionDef invocation identity

event observation boundary

timer identity

retry semantics

cancellation race semantics
```

Do not begin broad coding before these are written down.

### Phase 2 — portable core model

Implement:

```text
WorkflowDef

step types

validation

semantic fingerprint projection

static analysis
```

### Phase 3 — Server IR v8

Compile WorkflowDef to portable IR.

Freeze v1-v7.

### Phase 4 — WorkflowStore

Memory reference first.

Define CAS/revision/fencing contract.

### Phase 5 — SQLite WorkflowStore

Real durable multi-process implementation.

### Phase 6 — ownership/recovery

Reuse CoordinationProvider/DurableWork where appropriate.

Implement runnable-instance discovery.

### Phase 7 — ActionDef step

Stable logical invocation identity.

Crash reconciliation.

### Phase 8 — timer step

Durable activation + scheduler recovery.

### Phase 9 — wait-event

Durable observation boundary.

No-gap handoff.

### Phase 10 — branch/complete/fail

Pure deterministic transitions.

### Phase 11 — retry

Durable attempts/backoff.

### Phase 12 — cancellation

Linearized cancellation against active transitions.

### Phase 13 — AgentAPI/inspection

Static and runtime explainability.

### Phase 14 — conformance v8

Portable workflow fixtures + negative controls.

### Phase 15 — topology/crash suite

Real OS processes.

1/2/8 authorities.

### Phase 16 — historical regression

0.12 / 0.12.1 / 0.13.1.

### Phase 17 — docs/release

Pack/verify/consumer/probe.

### Phase 18 — publish alpha

Publish exact coherent package set.

### Phase 19 — blind Phase 22

Target `D1 / E1 / S1`.

---

# 250. IMPLEMENTATION REPORT

Produce:

```text
AXIOM_0_14_IMPLEMENTATION_REPORT.md
```

plus design/research note.

---

# 251. REQUIRED IMPLEMENTATION REPORT QUESTIONS — MODEL

Answer explicitly:

1. What is the exact WorkflowDef shape?
2. What step kinds exist?
3. Why are other step kinds deferred?
4. Are graph cycles permitted?
5. What is a workflow instance?
6. What data is immutable?
7. What data is single-assignment?
8. What is an activationId?
9. What is a workflow instance revision?
10. What exactly constitutes a logical transition?
11. Which transition operations are atomic?
12. What is terminal state?
13. How is semanticFingerprint affected?
14. Why is Server IR v8 required?
15. What does conformance v8 prove?

---

# 252. REQUIRED REPORT QUESTIONS — ACTION

Answer:

1. How does workflow invoke ActionDef?
2. What principal is used?
3. What is the stable logical invocation identity?
4. How is duplicate logical action execution prevented?
5. What happens if process dies before action starts?
6. What happens if it dies during action?
7. What happens after logical action commit but before workflow transition?
8. How do effects retain logical identity?
9. Which physical execution duplicates remain possible?
10. How are terminal vs retryable failures classified?

---

# 253. REQUIRED REPORT QUESTIONS — EVENT

Answer:

1. What does wait-event mean?
2. What event history/observation primitive is used?
3. What is the activation boundary?
4. How is the snapshot/register gap closed?
5. What happens if event arrives immediately before activation?
6. What happens immediately after activation?
7. What happens during activation?
8. How is event dedup applied?
9. Can one event unblock many workflows?
10. Does workflow consume events globally?
11. How is timeout raced with event?
12. How is crash during event processing recovered?

---

# 254. REQUIRED REPORT QUESTIONS — TIMER

Answer:

1. When is timer target evaluated?
2. Where is target persisted?
3. What is timer logical identity?
4. How is timer registration recovered?
5. What if process dies after activation but before scheduler record?
6. Can timer fire physically twice?
7. How is logical transition deduped?
8. What happens when timer and cancellation race?

---

# 255. REQUIRED REPORT QUESTIONS — DISTRIBUTION

Answer:

1. How is a runnable workflow claimed?
2. Which existing 0.12 primitives are reused?
3. What is the lease?
4. What is the fence?
5. How is stale owner rejected?
6. What happens under `SIGSTOP`?
7. What happens under `SIGKILL`?
8. How is a new authority able to continue?
9. Why is sticky routing unnecessary?
10. Why is a global leader unnecessary?
11. What makes 1/2/8 topology semantically equivalent?

---

# 256. REQUIRED REPORT QUESTIONS — CANCELLATION

Answer:

1. What exactly does cancellation guarantee?
2. What does it not guarantee?
3. How does cancel race with action completion?
4. How does cancel race with event match?
5. How does cancel race with timer?
6. How does cancel race with retry?
7. Can terminal state change after cancellation?
8. Why is compensation out of scope?

---

# 257. REQUIRED REPORT QUESTIONS — SECURITY

Answer:

1. What principal is stored?
2. Are raw credentials stored?
3. How is authorization re-evaluated?
4. Can another principal inspect an instance by knowing its id?
5. Can another principal cancel it?
6. How is idempotency key scoped?
7. Can workflow retries escalate privilege?
8. What error/event information is exposed through inspection?

---

# 258. REQUIRED INTERNAL REAL-PROCESS TESTS

At minimum:

```text
duplicate concurrent workflow start                  50

uncertain start response + retry                     50

2-authority claim race                               50

8-authority claim race                               50

crash before action                                  25

crash during action                                  25

crash after action logical commit                    50

crash after workflow transition                      25

event no-gap race                                    50

event duplicate delivery                             25

event vs timeout race                                50

timer crash matrix                                   50

retry crash matrix                                   50

cancel vs event                                      50

cancel vs timer                                      50

cancel vs action completion                          50

stale-owner SIGSTOP fencing                          25

mixed-build continuation refusal                     25

1-authority workflow workload                        25

2-authority workflow workload                        25

8-authority workflow workload                        25

SQLite conflicting transition race                   50

SQLite 8-process concurrent startup                  25
```

Increase where useful.

---

# 259. REAL OS PROCESS REQUIREMENT

Release-critical distributed tests MUST use real OS processes.

Do not emulate authorities as objects in one event loop and treat that as sufficient evidence.

---

# 260. INDEPENDENT SQLITE CONNECTIONS

Every authority process creates its own:

```text
WorkflowStore

PersistenceAdapter

DataProvider

CoordinationProvider
```

connections where applicable.

---

# 261. REAL FILESYSTEM

Run critical SQLite workflow races on a filesystem providing real inter-process locking.

Record environment in report.

---

# 262. REAL SIGKILL

Crash tests must use actual abrupt process death.

No cleanup callback.

No graceful lease release.

---

# 263. REAL SIGSTOP FOR STALE OWNER

At least one fencing test should pause rather than kill a process:

```text
SIGSTOP A

lease expires

B advances

SIGCONT A
```

Then prove A cannot commit stale work.

---

# 264. REFERENCE ORACLE

For workflow tests, define a canonical logical-history oracle.

Example:

```text
expected workflow transitions:
    started
    reserve_inventory succeeded
    wait_payment activated
    payment event matched
    create_shipment succeeded
    completed
```

Physical attempts may contain duplicates.

Logical history must match exactly.

---

# 265. LOGICAL VS PHYSICAL RESULT TABLE

Test reports should distinguish:

```text
logical activations

logical transitions

action logical invocations

effect logical instances

physical action attempts

physical effect attempts

scheduler attempts

event deliveries
```

Do not collapse them into one "executions" counter.

---

# 266. SUCCESS CONDITION

0.14 succeeds only if a cold external tester can establish:

> A WorkflowDef represents a durable, portable orchestration graph whose logical progression survives retries, process death, authority failover, timer delivery, event delivery, and ordinary distributed contention without application-owned orchestration infrastructure. Each workflow activation transitions at most once logically; actions preserve stable logical invocation identity; waits have no registration gap; stale owners are fenced; cancellation is durable but does not pretend to undo already committed external effects; and compatible 1/2/8-authority deployments produce the same logical workflow outcome.

and assigns:

```text
Discoverability:   D1

Semantic Escape:   E1

Safety:            S1
```

---

# 267. FREEZE RULE

Only after published:

```text
0.14.0-alpha.5
```

passes blind Phase 22 at:

```text
D1 / E1 / S1
```

mark:

```text
Axiom 0.14
Durable Workflows

EXTERNALLY VALIDATED

SEMANTIC MODEL FROZEN
```

---

# 268. POST-0.14

After 0.14 is externally validated:

```text
0.15
Authorization Completeness
```

remains the planned next semantic feature line.

Workflow authorization findings discovered during 0.14 should be fixed where they directly violate existing authorization semantics, but 0.14 should not expand into the full 0.15 authorization program.

---

# 269. FINAL DESIGN PRINCIPLE

A durable workflow is not:

```text
a background Promise

a persisted callback

a job queue entry

a cron task

a mutable JSON state blob

a process-local event listener

a collection of retries
```

It is a semantic computation with durable control position.

The runtime must be able to answer, after any supported crash:

```text
Which workflow is this?

Under which principal?

Which activation is current?

What has committed?

What has not committed?

What external action has already logically occurred?

Why is the workflow waiting?

What can unblock it?

What retry is due?

What timer is due?

Has it been cancelled?

Which authority may currently advance it?

Can this authority prove that its fence is current?

What is the only legal next logical transition?
```

If those questions have durable, portable answers, the workflow can survive:

```text
process death

authority replacement

duplicate delivery

lost connection

retries

event races

timer races

SQLite contention

mixed request routing
```

without the application taking ownership of orchestration correctness.

That is the semantic boundary Axiom 0.14 must establish.
