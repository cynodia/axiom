# Axiom 0.14 Pre-Publish Corrective Instruction

## Durable Workflow Crash-Safety Closure

`spec14` is structurally implemented and green, but **do not publish `0.14.0-alpha.3` yet**.

Before publish / blind Phase 22, close or conclusively prove the two remaining crash-safety gaps below.

The existing `spec14` remains authoritative. This instruction is a focused corrective pass, not a new feature specification.

---

# 1. F1 — Durable ActionDef Invocation Reconciliation

Current implementation has:

* stable logical workflow action invocation id:
  `<workflowInstanceId>/<activationId>`;
* durable `pendingAction`;
* durable workflow-side recorded action outcome;
* in-window idempotency / reclaim reconciliation.

However, the implementation report explicitly defers a fully durable server-side idempotency mechanism across a **full process restart before the per-activation outcome is durably recorded**.

That window conflicts with the spec14 invariant:

```text
ActionDef logically commits

authority dies before workflow records step completion

another authority/restart recovers the workflow
```

Required result:

```text
logical ActionDef invocation count == 1
workflow logical transition count == 1
```

A recovery authority MUST be able to prove that the same logical action invocation already committed and recover its canonical outcome without creating a second logical invocation.

## Required design

Use the existing stable invocation identity:

```text
<workflowInstanceId>/<activationId>
```

as a **durable cross-process / cross-authority idempotency identity**.

Prefer integrating this at the canonical ActionDef execution layer rather than creating workflow-specific duplicate semantics if possible.

The durable record must allow a fresh authority after complete process restart to distinguish at least:

```text
not started / no durable outcome

logically committed with canonical outcome

terminal logical failure where appropriate
```

Do not rely on:

```text
process memory

authority-local request cache

pendingAction alone

best-effort reconciliation

same-process retry
```

for this invariant.

## Required crash test

Real OS processes.

Shared durable stores.

Sequence:

```text
1. Start workflow.
2. Reach action activation A.
3. Authority X invokes ActionDef with stable workflow invocation identity.
4. ActionDef logically commits.
5. SIGKILL X at the narrowest possible point before the workflow activation outcome/transition is durably recorded.
6. Start or use authority Y.
7. Y recovers the same workflow activation.
8. Y must discover the prior logical action outcome.
9. Y transitions the workflow exactly once.
```

Required counters:

```text
logical ActionDef invocations        1
workflow action activations          1
workflow logical step transitions    1
duplicate logical effects            0
```

Physical effect attempts remain governed by existing Axiom effect semantics.

Run at least:

```text
50 trials
```

Also test a complete restart where the original authority process and all its process-local state are gone.

This is a release blocker.

---

# 2. F2 — Durable Event No-Gap Recovery Across Authority Death

Current implementation stores:

```text
wait registration
sinceEventSeq
activationId
```

atomically with the transition into `wait-event`.

That correctly closes the:

```text
waiting-state -> listener-registration
```

gap.

However, the current design note describes recovery using a bounded **in-authority** `WorkflowEventJournal`.

A durable `sinceEventSeq` is insufficient if the matching accepted event itself exists only in the dead authority's process-local journal.

Required invariant:

> Once an accepted canonical event can semantically satisfy an active workflow wait, enough durable/shared evidence must survive authority death for another compatible authority to replay or reconcile that event against the waiting activation.

## Required scenario

Real OS processes.

```text
Workflow W durably enters wait-event.
sinceEventSeq = N.

Matching canonical event E is accepted with seq N+1.

The authority that accepted / routed E dies before W's transition commits.

A different authority starts or takes ownership.
```

Required:

```text
W eventually matches E exactly once
```

without:

```text
client re-sending E

manual event replay

application polling

sticky routing

StateDef sync pulse

process-local journal from the dead authority
```

## Acceptable architectures

Any architecture is acceptable if it proves the invariant, for example:

```text
A. durable accepted-event journal shared by compatible authorities

B. durable event-delivery / workflow-match evidence

C. another shared recoverable event observation mechanism
```

The mechanism must preserve:

```text
event dedup

fanout semantics

sinceEventSeq observation boundary

event-before-wait semantics

event-during-wait no-gap semantics
```

Do not introduce a second application-facing message bus.

## Required crash tests

At minimum:

### Case A — event after wait activation

```text
wait registration commits
matching event commits
SIGKILL event-processing authority before workflow transition
new authority recovers
workflow transitions once
```

### Case B — event concurrent with wait activation

Race:

```text
wait activation
vs
matching event commit
```

At least:

```text
50 trials
```

Every event must be deterministically classified as:

```text
before activation
or
after activation
```

No event may disappear in an undefined handoff gap.

### Case C — duplicate replay

After crash recovery, replay the same logical event multiple times.

Required:

```text
one logical workflow transition
```

This is a release blocker.

---

# 3. Targeted Real-Process Distribution Tests

Before publish, add a minimal high-value real-process matrix.

Do not wait for blind Phase 22 to discover basic ownership/fencing defects.

Required:

```text
2 authorities claim same runnable workflow
8 authorities claim same runnable workflow

SIGSTOP stale owner:
    A owns workflow
    pause A
    lease expires
    B advances
    resume A
    A stale commit refused

SIGKILL after ActionDef logical commit
SIGKILL after event acceptance before workflow transition
```

For claim races:

```text
logical workflow transition count == 1
```

For stale-owner race:

```text
stale successful commits == 0
```

Use independent SQLite connections in real OS processes.

---

# 4. Preserve Existing Model

Do NOT expand spec14 while fixing these issues.

Keep frozen:

```text
WorkflowDef

six step kinds:
    action
    wait-event
    timer
    branch
    complete
    fail

single-assignment bindings

closed workflow expression scope

acyclic workflows

instanceRevision + fence CAS

leaderless ownership

cancellation is not rollback

Server IR axiom.server.v8

conformance axiom.conformance.v8
```

Do not add:

```text
loops
parallel
race
child workflows
compensation
sagas
wait-query
```

---

# 5. Historical Regression

After F1/F2 changes, rerun all existing tests.

Must remain green:

```text
0.12 distributed authority
0.12.1 StateDef coherence
0.13.1 live-query Phase-21-critical regressions
0.14 workflow validation
WorkflowStore CAS
timer
retry
cancellation
mixed-build refusal
conformance v8
```

Especially rerun:

```text
SQLite lost-write
SQLite contention
provider-record live invalidation
live 1/2/8 topology tests already present
cursor mixed-build refusal
```

---

# 6. Implementation Report Update

Update:

```text
AXIOM_0_14_IMPLEMENTATION_REPORT.md
```

The report must no longer describe F1 or F2 as deferred.

Add explicit answers:

## F1

```text
Where is ActionDef logical invocation outcome stored durably?

What key identifies it?

Is it visible after full process restart?

Is it shared across authorities?

What exact crash boundary was tested?

How many real-process trials?

Can a second logical ActionDef invocation occur after a committed first invocation?
```

## F2

```text
Where is accepted-event replay evidence stored?

Does it survive process death?

Can a different authority retrieve it?

How is sinceEventSeq used?

How is event-before-wait distinguished from event-after-wait?

How is event dedup preserved during replay?

What exact SIGKILL boundary was tested?

How many no-gap race trials?
```

---

# 7. Publish Gate

Do not publish `0.14.0-alpha.3` until:

```text
F1 durable action reconciliation:
    CLOSED

F2 durable event recovery:
    CLOSED

targeted real-process fencing:
    GREEN

full repository:
    GREEN

release:pack:
    GREEN

release:verify:
    GREEN

release:consumer-test:
    GREEN

release:probe:
    GREEN
```

Then publish the coherent `0.14.0-alpha.3` package set and run the full blind Phase 22 specification unchanged.

Required eventual external verdict:

```text
D1 / E1 / S1
```

Do not freeze the 0.14 semantic model before that external result.
