# Axiom 0.14 Part 3 Specification
## Mixed-Build Compatibility Closure and Workflow Validation Hardening

**Target:** `0.14.0-alpha.2` or equivalent corrective release  
**Baseline:** published `0.14.0-alpha.1`  
**Recommended branch:** `spec14pt3-workflow-compatibility`  
**Status:** Corrective specification following Phase 22 blind external regression  
**Scope:** Close Phase 22 F3 release blocker and harden F1/F2 without expanding WorkflowDef semantics  
**Required eventual external outcome:** `D1 / E1 / S1`

---

# 1. Purpose

Phase 22 against published `0.14.0-alpha.1` produced:

```text
Discoverability: D1
Semantic Escape: E1
Safety:          S3

Verdict:
NOT EXTERNALLY VALIDATED
```

The release-blocking finding is:

```text
F3 — a semantically incompatible authority build can silently continue
     an in-flight workflow instance under changed WorkflowDef semantics.
```

Two additional hardening findings were discovered:

```text
F1 — malformed/unknown workflow step type can cause a native TypeError
     instead of a structured WORKFLOW_INVALID_STEP diagnostic.

F2 — hand-tampered Server IR can reach native runtime failure / wedge
     instead of failing closed with a structured semantic refusal.
```

This specification defines the corrective work required before Phase 22 may continue.

The existing Axiom 0.14 Durable Workflows semantic model remains authoritative.

This is NOT a new workflow feature release.

---

# 2. Phase 22 Evidence

Phase 22 demonstrated a deterministic mixed-build safety failure.

An in-flight workflow was:

```text
created under build A
parked at wait-event
instanceRevision = 3
```

A different authority using build B, whose WorkflowDef had different executable semantics, was then allowed to claim and advance the instance.

Build B drove the workflow to:

```text
instanceRevision = 6
terminal = failed
```

where build A would have completed it.

This reproduced:

```text
25 / 25 real OS-process trials
```

The presentation-only compatibility control passed:

```text
25 / 25
```

so the failure is specifically associated with semantic compatibility detection.

Direct inspection showed:

```text
semanticFingerprint(graphA)
!=
semanticFingerprint(graphB)
```

while:

```text
authorityA.compatibilityKey.semanticFingerprint
==
authorityB.compatibilityKey.semanticFingerprint
```

for WorkflowDef semantic changes.

Observed workflow changes that failed to affect the enforced authority compatibility key included:

```text
action-step ActionDef target
wait-event EventDef target
branch constant/expression
timer duration
```

and:

```text
compareAuthorityCompatibility(A, B)
```

incorrectly returned:

```text
{
  compatible: true,
  mismatches: []
}
```

The shipped semantic identity contract therefore contains two inconsistent notions of semantic identity:

```text
graph-level semantic identity
```

and:

```text
authority compatibility semantic identity
```

WorkflowDef participates in the first but not sufficiently in the second.

This is the primary defect addressed by spec14pt3.

---

# 3. Primary Safety Invariant

For compatible authority execution:

> No authority may interpret or advance an existing durable workflow instance using WorkflowDef semantics that are incompatible with the semantics under which that instance was created or previously advanced.

Formally:

```text
workflowSemanticMeaning(GA) != workflowSemanticMeaning(GB)

=>

authorityCompatibility(GA, GB).compatible == false
```

whenever the difference can alter execution of an in-flight workflow.

The following is forbidden:

```text
instance created under GA
+
authority running GB
+
GA workflow semantics != GB workflow semantics
+
authority accepts instance
+
authority advances instance using GB
```

The required result is:

```text
fail closed
```

before semantic advancement.

---

# 4. Compatibility Must Protect Durable Meaning

Authority compatibility is not merely deployment metadata.

For durable workflows it is part of the safety boundary.

A workflow instance may survive:

```text
process death
authority death
complete authority outage
authority replacement
rolling deployment
```

Therefore a replacement authority must prove that it interprets the durable workflow state compatibly.

The number of authorities must remain deployment topology, not application semantics.

The invariant remains:

```text
observableMeaning(
  executeWorkflow(W, compatibleAuthorities)
)
```

must not depend on which compatible authority claims the next activation.

An incompatible authority is not allowed to become an alternative interpreter of the same durable instance.

---

# 5. Design Gate G1 — One Canonical Semantic Projection

The implementation MUST NOT maintain independently evolving definitions of executable semantic identity.

The preferred architecture is:

```text
canonicalSemanticProjection(graph)
        |
        +--> semanticFingerprint(graph)
        |
        +--> authorityCompatibility semantic fingerprint
```

or an equivalent shared lower-level projection.

The exact implementation structure is not prescribed.

The invariant is.

There must be one authoritative answer to:

```text
Which graph changes alter executable semantic meaning?
```

WorkflowDef must participate in that same answer.

Forbidden architecture:

```text
graph fingerprint:
    manually maintained inclusion set A

authority compatibility fingerprint:
    independently maintained inclusion set B
```

where A and B can drift.

Phase 22 has demonstrated that such drift is safety-relevant.

---

# 6. Required Relationship Between Fingerprints

At minimum:

```text
if semanticFingerprint(graphA) != semanticFingerprint(graphB)
because of an executable WorkflowDef semantic change

then

the authority compatibility mechanism MUST detect incompatibility
```

This does NOT necessarily require the two exposed fingerprint strings to be byte-identical if they intentionally represent different scopes.

It DOES require that they derive compatibility-relevant workflow meaning from the same canonical semantic definition.

Do not fix F3 by merely adding four Phase 22 examples to an unrelated authority inclusion list.

The correction must be structural enough that future WorkflowDef semantic fields cannot silently escape authority compatibility.

---

# 7. WorkflowDef Semantic Projection

WorkflowDef executable meaning MUST participate in compatibility.

The canonical projection must include all workflow fields that can affect durable execution.

At minimum this includes:

```text
workflow identity where semantically relevant

inputs
bindings

entry step

step ids
step kinds

control-flow edges

step-specific executable semantics
```

The sections below define the required minimum coverage.

---

# 8. Workflow Inputs

Workflow input semantics must include all fields that affect accepted workflow invocation or later expression evaluation.

Examples include:

```text
input id/name
input type
requiredness
default semantic value, if supported
other executable validation semantics
```

Changing an input contract in a way that changes workflow meaning must be compatibility-relevant.

---

# 9. Workflow Bindings

Single-assignment WorkflowBinding semantics must be included.

This includes, where represented:

```text
binding identity
binding type
producer relationship
binding source semantics
```

Changing which value a later step receives must not remain authority-compatible merely because step ids are unchanged.

---

# 10. Entry Step

The workflow entry step is semantic.

Changing:

```text
entry: A
```

to:

```text
entry: B
```

must alter compatibility if it changes execution.

---

# 11. Step Identity and Kind

For every workflow step include:

```text
step id
step kind
```

Changing:

```text
action -> timer
```

or any other step kind substitution must be incompatible.

Step ids alone are not sufficient semantic identity.

---

# 12. Action Step Semantics

For:

```text
kind: action
```

the semantic projection must include all executable action-step meaning.

At minimum:

```text
ActionDef target
argument expressions
success/next edge
error edge
retry policy
```

Retry policy includes every field affecting retry behaviour, including where supported:

```text
maxAttempts
initialDelay
backoffMultiplier
maxDelay
retry classification/configuration
```

Phase 22 already proved that changing the ActionDef target must be incompatible.

Required controls must additionally prove changes to:

```text
arguments
retry policy
onError
next
```

are detected.

---

# 13. Wait-Event Step Semantics

For:

```text
kind: wait-event
```

include all executable semantics, including:

```text
EventDef/event target
correlation / where expression
binding mapping
success/next edge
timeout semantics
onTimeout edge
```

Changing:

```text
event A -> event B
```

must be incompatible.

Changing only the correlation predicate must also be incompatible.

Changing timeout behaviour must be incompatible.

---

# 14. Timer Step Semantics

For:

```text
kind: timer
```

include:

```text
after expression/value
at expression/value
next edge
```

where applicable.

Changing:

```text
after: 1 second
```

to:

```text
after: 5 seconds
```

must be incompatible.

Phase 22 directly demonstrated this failure mode in `0.14.0-alpha.1`.

---

# 15. Branch Step Semantics

For:

```text
kind: branch
```

include:

```text
when expression
then edge
else edge
```

Changing the branch predicate while preserving all step ids must alter compatibility.

Changing either branch edge must alter compatibility.

Phase 22 directly demonstrated a branch semantic change escaping compatibility.

---

# 16. Complete Step Semantics

For:

```text
kind: complete
```

include all terminal output meaning.

For example:

```text
output expressions
result bindings
terminal semantic payload
```

where supported.

Two builds that produce different canonical workflow completion output are semantically different.

---

# 17. Fail Step Semantics

For:

```text
kind: fail
```

include all terminal failure meaning.

For example:

```text
error code
error expression
error payload
```

where supported.

A workflow that terminates with different semantic failure meaning is not automatically compatible.

---

# 18. Control-Flow Edges

All executable control-flow edges are semantic.

This includes at least:

```text
entry
next
then
else
onError
onTimeout
```

Changing an edge while retaining the same steps must alter compatibility.

Example:

```text
action.next = complete
```

versus:

```text
action.next = waitForApproval
```

must be incompatible.

---

# 19. Expression Semantics

Workflow expressions must use the framework's canonical expression semantic representation.

Do NOT fingerprint host-language accidents such as:

```text
object identity
property insertion order
source formatting
function identity
memory address
module path
```

Equivalent canonical expressions should remain equivalent.

Semantically different expressions must not collide merely because they occur at the same step id.

---

# 20. Presentation-Only Exclusions

Presentation-only metadata MUST remain outside executable compatibility.

Examples, where genuinely presentation-only:

```text
displayName
description
documentation text
UI label
UI grouping
presentation metadata
```

Changing only presentation must preserve compatibility.

The Phase 22 presentation-only control must remain:

```text
25 / 25 compatible
```

This is an important negative control.

A fix that simply fingerprints the entire serialized graph is therefore not automatically acceptable.

---

# 21. No Accidental Compatibility Over-Tightening

The F3 correction must not turn every graph-byte difference into semantic incompatibility.

Required principle:

```text
semantic change      -> incompatible
presentation change  -> compatible
serialization noise  -> compatible
```

Examples of serialization noise that must not create false incompatibility include, where applicable:

```text
object key ordering
non-semantic metadata ordering
build-local paths
process ids
timestamps generated by build tooling
package installation path
```

---

# 22. Compatibility and In-Flight Workflow Instances

An existing workflow instance must retain enough durable compatibility identity to allow a future authority to determine whether it may interpret the instance.

The implementation must explicitly answer:

```text
What compatibility identity is persisted with the workflow instance?

When is it captured?

What authority identity is compared against it?

At what point is the comparison performed?

Can an incompatible authority claim the instance before refusal?

Can it mutate the instance before refusal?
```

The safety requirement is:

```text
no semantic workflow transition may commit under an incompatible build
```

---

# 23. Compatibility Check Placement

Compatibility refusal must occur before executable workflow semantics are applied.

At minimum, before:

```text
action invocation
event matching transition
timer transition
branch evaluation/transition
retry execution
complete transition
fail transition
cancellation logic that depends on incompatible workflow interpretation
```

Infrastructure may inspect incompatible instances sufficiently to report them.

It may not semantically advance them.

---

# 24. Claiming an Incompatible Instance

Prefer fail-closed behaviour that avoids treating incompatibility as ordinary runnable work.

If an authority temporarily claims/leases an instance before discovering incompatibility due to architectural constraints, it must:

```text
perform no semantic transition
perform no ActionDef invocation
consume no workflow event activation
fire no workflow timer logically
mutate no workflow binding
```

and must release/allow lease expiry safely.

No permanent corruption or wedge may result.

---

# 25. Mixed-Build Error Surface

An incompatible continuation must produce a structured Axiom error/diagnostic.

The exact identifier may follow existing compatibility conventions.

It must clearly communicate:

```text
workflow instance incompatible with current authority build
```

and ideally expose safe diagnostic identity such as:

```text
instance semantic fingerprint
authority semantic fingerprint
workflow id
instance id
```

without exposing secrets.

Do NOT leak:

```text
HMAC keys
database paths
raw SQL
credentials
internal stack traces
```

---

# 26. Mixed-Build Inspection

A current authority should still be able to report enough safe diagnostic information for operators to understand why an instance is not runnable.

Where public inspection supports it, expose a reason equivalent to:

```text
incompatible-build
```

rather than making the instance appear silently stuck.

Do not require this if it would introduce new semantic API surface beyond the corrective scope, but existing inspection surfaces should be honest.

---

# 27. Mixed-Build Topology

Compatibility must be evaluated per authority.

Scenario:

```text
A1 compatible with instance
A2 compatible with instance
B1 incompatible with instance
```

Required:

```text
A1/A2 may progress instance
B1 must refuse
```

The presence of B1 in the deployment must not poison the workflow for compatible authorities.

No cluster-wide leader or homogeneous-build assumption may be introduced.

---

# 28. Rolling Deployment Safety

Test:

```text
old build A
new semantically incompatible build B
both temporarily running
```

Existing A instances may continue only on compatible A authorities.

B must refuse them.

Likewise instances created under B must not be silently interpreted by incompatible A authorities.

This is leaderless mixed-build fail-closed behaviour.

Do not solve F3 by requiring sticky routing.

---

# 29. Design Gate G2 — Workflow Definition Fingerprint vs Whole-Graph Fingerprint

The implementation must explicitly decide and document the compatibility granularity.

Possible safe models include:

```text
A. instance stores whole executable graph semantic fingerprint

B. instance stores WorkflowDef-specific semantic fingerprint plus
   any transitive semantic dependencies needed to execute it

C. another canonical compatibility identity with equivalent safety
```

The implementation is not required to choose a particular model.

However, if using WorkflowDef-local identity, it MUST account for transitive dependencies.

---

# 30. Transitive Dependency — ActionDef

A workflow action step references an ActionDef.

If the referenced ActionDef's executable semantics change while WorkflowDef text remains identical, determine whether the workflow remains safe to continue.

The expected default is:

```text
ActionDef semantic change affecting workflow execution
=>
incompatible in-flight workflow
```

unless Axiom's existing semantic model explicitly guarantees another safe interpretation.

The corrective implementation must not protect only the WorkflowDef container while ignoring changed referenced executable definitions.

---

# 31. Transitive Dependency — EventDef

Likewise, if wait-event references an EventDef whose semantic contract changes, compatibility must reflect any change that alters workflow event meaning.

Do not fingerprint merely:

```text
event id string
```

if executable EventDef semantics can change behind that id.

---

# 32. Transitive Dependency — Expressions and Types

Changes to semantic types or expression definitions used by the workflow must participate according to existing graph semantic fingerprint rules.

Prefer reuse of existing graph semantic identity rather than recreating a workflow-specific dependency walker unless necessary.

---

# 33. Existing Graph semanticFingerprint Is the Oracle

Phase 22 found:

```text
axiom-core semanticFingerprint(graph)
```

already changed for the tested WorkflowDef semantic mutations.

Treat this as strong evidence that the canonical graph-level semantic model already knows these changes are semantic.

The correction should therefore preferentially align authority compatibility with that canonical semantic model rather than inventing a third definition.

---

# 34. Fingerprint Stability

The correction must remain deterministic across:

```text
process restart
different installation directories
different authority process ids
independent Node processes
equivalent object construction order
```

Equivalent semantic graphs must produce compatible identity.

---

# 35. Existing Non-Workflow Compatibility

Do not regress authority compatibility for graphs without WorkflowDef.

Required:

```text
existing 0.12 / 0.13 compatibility behaviour remains unchanged
```

unless a pre-existing correctness bug is independently discovered.

This corrective release is not an opportunity to redesign all semantic identity.

---

# 36. Server IR Version

No new graph or IR vocabulary is introduced.

Therefore the expected Server IR remains:

```text
axiom.server.v8
```

Do NOT create:

```text
axiom.server.v9
```

solely for this correction unless implementation proves an externally serialized IR contract must actually change.

If no IR schema changes are necessary:

```text
server-ir.v8 schema remains unchanged
```

---

# 37. Conformance Version

Expected:

```text
axiom.conformance.v8
```

No conformance version bump is required merely for corrective fixtures.

Additive fixtures/controls may be added to v8 if compatible with the existing conformance contract.

---

# 38. Valid-Graph Fingerprint Expectations

For graphs without workflows:

```text
semanticFingerprint
schemaFingerprint
```

must remain unchanged from `0.14.0-alpha.1` unless the previous value was itself demonstrably incorrect.

For valid workflow graphs, authority compatibility behaviour must change as necessary to close F3.

Do not gratuitously perturb unrelated fingerprint outputs.

---

# 39. F1 — Unknown Workflow Step Validation

Phase 22 found a non-blocking validation defect:

> `validateGraph` can throw native `TypeError` for an unknown workflow step type instead of producing the documented structured workflow validation diagnostic.

This contradicts the public validation contract.

Correct it in spec14pt3.

---

# 40. F1 Required Invariant

For malformed workflow graph input containing an unknown/unsupported step kind:

```text
validateGraph(graph)
```

must return/produce a structured validation failure.

It MUST NOT expose:

```text
TypeError
Cannot read properties of undefined
undefined is not a function
native switch fallthrough accident
```

Expected diagnostic:

```text
WORKFLOW_INVALID_STEP
```

or the exact already-documented canonical diagnostic.

Do not invent a second diagnostic if one is already public.

---

# 41. F1 Compiler Consistency

The same malformed graph must fail consistently through:

```text
validateGraph
compileToServerIR
AgentAPI analysis where applicable
```

No layer should assume validation has already made the structure safe unless the public API contract explicitly guarantees validated-only input.

---

# 42. F1 Unknown Step Fields

Also probe malformed objects such as:

```text
{ kind: "unknown" }

{ kind: null }

{ kind: 123 }

{}

step entry that is not an object
```

where runtime input boundaries permit them.

All should fail structurally.

No native exception leakage.

---

# 43. F1 No Semantic Expansion

Do not add support for unknown step kinds.

The correct behaviour is refusal.

The six 0.14 portable workflow step kinds remain:

```text
action
wait-event
timer
branch
complete
fail
```

---

# 44. F2 — Tampered Server IR Fail-Closed

Phase 22 also found that hand-tampered Server IR does not always fail gracefully.

This is non-blocking relative to F3 but should be corrected in the same hardening pass.

Axiom's principle remains:

> Invalid semantic representation must fail explicitly rather than reaching plausible execution or native runtime failure.

---

# 45. F2 Threat Model

An ordinary graph compiler is expected to produce valid IR.

However, runtime boundaries may receive:

```text
stored IR
transported IR
hand-constructed IR
corrupted IR
older/mismatched IR
maliciously modified IR
```

The runtime must not assume that a `kind` field or step structure is valid merely because the object claims:

```text
axiom.server.v8
```

---

# 46. F2 Required Runtime Behaviour

For structurally invalid workflow IR:

```text
runtime accepts object
detects invalid workflow structure
refuses execution
returns/throws structured Axiom semantic error
```

It must NOT:

```text
execute a partial workflow
silently skip unknown step
guess a fallback step type
hang permanently because no handler exists
throw native TypeError
leak provider internals
```

---

# 47. F2 Minimum Tamper Cases

Test at least:

```text
unknown workflow step kind
missing active step
active step points to nonexistent step
missing required action target
missing required event target
invalid branch edge
invalid timer shape
invalid terminal shape
invalid binding reference
invalid workflow definition reference
```

Where appropriate also test:

```text
wrong primitive types
null in required fields
arrays where objects expected
```

---

# 48. F2 Runtime Guard Placement

Runtime validation may be:

```text
whole-IR validation at load/admission
```

or:

```text
targeted defensive guards at semantic execution boundaries
```

or both.

The implementation choice is open.

The required invariant is:

```text
tampered semantic IR cannot become executable meaning
```

---

# 49. F2 Structured Failure

Prefer an existing structured error family.

If a new diagnostic is necessary, it should clearly identify:

```text
invalid workflow IR
```

without exposing implementation details.

Do not expose raw errors such as:

```text
TypeError: handler is not a function
```

---

# 50. Preserve the 0.14 Workflow Model

spec14pt3 MUST NOT add new WorkflowDef features.

Remain frozen at the structural model already implemented:

```text
WorkflowDef

six step kinds:
    action
    wait-event
    timer
    branch
    complete
    fail

single-assignment WorkflowBindings

closed workflow expression scope

acyclic workflows

durable workflow instances

fenced CAS transitions

leaderless execution

durable action reconciliation

durable accepted-event replay

durable timers

durable retries

durable cancellation
```

---

# 51. Explicit Non-Goals

Do NOT add:

```text
loops
parallel
race
child workflows
subworkflows
compensation
sagas
wait-query
mutable workflow context blob
script bodies
arbitrary JavaScript callbacks
workflow-local message bus
workflow leader election
sticky routing
```

Do not redesign workflow durability while fixing compatibility.

---

# 52. Preserve F1 Action Crash-Safety Closure from spec14pt2

The durable ActionDef reconciliation invariant from spec14pt2 must remain intact.

Required:

```text
ActionDef logically commits

authority dies before workflow transition records completion

fresh authority recovers activation

logical ActionDef invocation count == 1
canonical state mutation count == 1
workflow logical transition count == 1
```

Do not regress durable ActionDef idempotency while changing semantic identity.

---

# 53. Preserve F2 Event No-Gap Closure from spec14pt2

The durable accepted-event journal invariant must remain intact.

Required:

```text
workflow wait active
matching event accepted
routing authority dies before workflow transition
fresh authority recovers

=>

original event still matches exactly once
```

No:

```text
client resend
sticky routing
manual replay
StateDef pulse
```

---

# 54. Preserve Fencing

Existing:

```text
instanceRevision + fence
```

CAS behaviour remains authoritative.

Changing compatibility identity must not weaken stale-owner fencing.

---

# 55. Preserve Leaderless Execution

Do not solve mixed-build safety by electing a global workflow leader.

Required deployment remains:

```text
compatible authorities independently compete for work
lease/fence decides ownership
```

Compatibility determines whether an authority is eligible to interpret a specific instance.

---

# 56. Preserve Principal Semantics

No compatibility fix may replace the workflow principal with:

```text
authority
system
admin
anonymous
```

Principal preservation remains unchanged.

Phase 22's remaining principal/authorization suite will be run after this correction.

---

# 57. Preserve Authorization Re-Evaluation

Do not freeze authorization decisions into the new compatibility fingerprint.

Workflow semantic compatibility and authorization are distinct.

A compatible workflow may later be denied because current authorization changed.

That is expected.

Do not fingerprint current authorization state.

---

# 58. Preserve Event Dedup Semantics

Do not include ephemeral event-journal sequence state in graph semantic identity.

Compatibility describes interpretation of the workflow definition, not current runtime progress.

---

# 59. Preserve Timer Runtime State Separation

Do not fingerprint captured runtime timer targets into authority graph compatibility.

Definition semantics:

```text
after 10s
```

are compatibility-relevant.

Instance runtime state:

```text
target = 2026-09-01T14:03:22Z
```

belongs to the durable workflow instance, not graph identity.

---

# 60. Preserve Retry Runtime State Separation

Definition:

```text
maxAttempts = 5
backoff = ...
```

is semantic compatibility.

Instance:

```text
attempt = 3
nextEligibleAt = ...
```

is durable runtime state.

Do not conflate them.

---

# 61. Preserve Workflow History Separation

Logical history is durable workflow evidence.

It must not be used as a substitute for definition compatibility.

An incompatible authority must not replay history under new semantics and infer that continuation is safe.

---

# 62. Required Internal Unit Tests — Fingerprint

Add direct tests proving semantic fingerprint/compatibility behaviour for at least:

```text
action target change
action argument change
action retry change
action next edge change
action onError edge change

wait-event event id change
wait-event where change
wait-event binding change
wait-event timeout change
wait-event onTimeout edge change

timer after change
timer at change
timer next edge change

branch predicate change
branch then edge change
branch else edge change

complete output change

fail error change

entry step change
```

Each semantic mutation must be detected as incompatible where relevant.

---

# 63. Required Internal Negative Controls — Presentation

Prove compatibility remains unchanged for presentation-only changes.

At minimum:

```text
description
display label/name if presentation-only
UI metadata if presentation-only
documentation metadata
```

Use only fields that the framework contract actually defines as non-semantic.

---

# 64. Required Canonicalization Controls

Construct semantically identical graphs through different object construction orders.

Expected:

```text
compatible
```

Where feasible:

```text
semantic fingerprint equal
```

No object insertion-order dependency.

---

# 65. Required Transitive Dependency Tests

If WorkflowDef references executable definitions, mutate those definitions without changing the workflow reference id.

At minimum test:

```text
referenced ActionDef semantic change
referenced EventDef semantic change where applicable
```

The test must determine whether authority compatibility correctly reflects the actual executable graph meaning.

If whole-graph semantic fingerprint already provides this safety, prove it.

---

# 66. Required Internal Mixed-Build Test — Action

Build A:

```text
workflow step calls actionA
```

Build B:

```text
same workflow id
same step ids
step calls actionB
```

Create instance under A.

Attempt continuation under B.

Expected:

```text
refused before action invocation
```

Counters:

```text
actionB logical invocations = 0
workflow transitions by B = 0
```

---

# 67. Required Internal Mixed-Build Test — Event

Build A waits for:

```text
eventA
```

Build B waits for:

```text
eventB
```

Create wait under A.

Attempt recovery/continuation under B.

Expected:

```text
B incompatible
```

B must not reinterpret the active wait as `eventB`.

---

# 68. Required Internal Mixed-Build Test — Branch

Build A:

```text
branch when true -> complete
```

Build B:

```text
branch when false -> fail
```

or equivalent semantic difference.

Create instance under A before branch evaluation.

Attempt continuation under B.

Expected:

```text
refused
```

B must not choose its own changed branch.

---

# 69. Required Internal Mixed-Build Test — Timer

Build A:

```text
after 1s
```

Build B:

```text
after 10s
```

Create instance under A before timer semantics are fully consumed.

Attempt B continuation.

Expected:

```text
refused
```

---

# 70. Required Internal Mixed-Build Test — Retry

Build A:

```text
maxAttempts = 2
```

Build B:

```text
maxAttempts = 5
```

Create retrying instance under A.

B must not reinterpret remaining retry semantics.

Expected:

```text
incompatible
```

---

# 71. Required Presentation-Only Process Control

Create instance under build A.

Build B differs only in presentation metadata.

B must continue it successfully.

Required:

```text
25 / 25
```

This is mandatory because over-fingerprinting is also a defect.

---

# 72. Required Real OS-Process F3 Reproduction Test

Reproduce the exact Phase 22 failure shape using real OS processes.

Baseline proof should demonstrate old behaviour if harness supports running published `0.14.0-alpha.1`:

```text
A creates instance
B semantically differs
B continues
wrong terminal meaning
```

Then run corrected build.

Expected:

```text
A creates instance
B semantically differs
B attempts continuation
B fails closed
instance durable meaning unchanged
```

Required:

```text
25 / 25 trials
```

---

# 73. F3 Four-Way External Shape

The corrected implementation must pass the four independent semantic mutations already discovered by Phase 22:

```text
action-step target
wait-event event id
branch constant/expression
timer duration
```

For every pair:

```text
semanticFingerprint(graphA)
!=
semanticFingerprint(graphB)
```

and authority compatibility must no longer report:

```text
compatible: true
```

unless a documented compatibility model proves that difference irrelevant to the particular instance, which is not expected for this corrective release.

---

# 74. compareAuthorityCompatibility Contract

Directly test:

```text
compareAuthorityCompatibility(keyA, keyB)
```

for semantic workflow changes.

Expected:

```text
compatible: false
mismatches: includes semantic fingerprint / semantic compatibility reason
```

The exact mismatch representation may follow existing API conventions.

---

# 75. Compatibility Key Introspection

If public:

```text
server.authority().compatibilityKey
```

remains inspectable, its semantic identity must visibly differ for semantically different WorkflowDef builds.

Do not expose secret data while doing so.

---

# 76. No Instance Mutation on Incompatibility

Record workflow instance before incompatible authority attempt:

```text
instanceRevision
status
active step
bindings
history
```

Attempt incompatible continuation.

Read again.

Expected:

```text
instanceRevision unchanged
status unchanged
active step unchanged
bindings unchanged
logical history unchanged
```

Infrastructure-only diagnostic observations may differ.

---

# 77. No Action Side Effect on Incompatibility

Use an ActionDef with an externally countable durable mutation.

Incompatible authority must be refused before action execution.

Expected:

```text
counter == 0
```

---

# 78. No Event Consumption on Incompatibility

For a waiting instance created under A, expose B to an event matching B's changed definition but not A's original definition.

B must not transition the instance.

The event must not be treated as consumed on behalf of that incompatible workflow interpretation.

---

# 79. No Timer Reinterpretation on Incompatibility

If A captured or expects timer semantics different from B, B must not recalculate or reinterpret the workflow under its definition.

Fail closed.

---

# 80. Compatible Authority Recovery Control

Create instance under A.

Kill A.

Start a fresh process using semantically identical build A2.

Expected:

```text
compatible
workflow recovers normally
```

This proves the fix does not accidentally bind instances to process identity.

---

# 81. Equivalent Independently Constructed Build Control

Construct the same graph independently in two processes/builds.

Expected:

```text
compatible
```

Do not require byte-identical JavaScript object creation history.

---

# 82. 2-Authority Mixed Deployment

Run:

```text
A-compatible authority
B-incompatible authority
```

against an A workflow instance.

Randomize claim timing.

Expected:

```text
B successful semantic transitions = 0
A may eventually advance
```

No permanent poisoning by B.

Minimum:

```text
25 trials
```

---

# 83. 8-Authority Mixed Deployment

Run a mixture such as:

```text
4 compatible A authorities
4 incompatible B authorities
```

against A instances.

Expected:

```text
only compatible authorities may advance
final meaning == all-A oracle
```

Minimum:

```text
10 workloads
```

Prefer 25.

---

# 84. Incompatible-Only Deployment

Create A instance.

Stop all A-compatible authorities.

Run only incompatible B authorities.

Expected:

```text
instance remains durably unadvanced
explicit incompatibility observable
no reinterpretation
```

When compatible A authority returns:

```text
instance may resume
```

This is fail-closed, not data loss.

---

# 85. Repeated Incompatible Claim Pressure

Hammer an A instance with incompatible B authorities.

Expected:

```text
no revision advancement
no history pollution
no side effects
no event-match transition
no timer transition
```

Then restore A and confirm recovery.

---

# 86. Crash During Compatibility Admission

Where feasible, kill an authority around compatibility checking/claiming.

Expected:

```text
no partial semantic transition
```

Existing fencing/CAS must recover normally.

---

# 87. F1 Validation Test Matrix

Add tests for unknown workflow step shapes.

At minimum:

```text
unknown string kind
missing kind
null kind
numeric kind
step = null
step = string
step = array
```

where input type boundaries allow.

Expected:

```text
structured validation failure
native TypeError count = 0
```

---

# 88. F1 Public Diagnostic Consistency

Confirm the public documentation and actual diagnostic agree.

If docs say:

```text
WORKFLOW_INVALID_STEP
```

then implementation must emit that diagnostic.

If the public canonical identifier is different, update documentation and implementation consistently only if changing it is backwards-safe and justified.

Prefer preserving the already-published documented identifier.

---

# 89. F2 Tampered IR Test Matrix

Create valid IR through public compiler.

Copy it.

Tamper tester-owned copy.

Cases:

```text
unknown step kind
missing referenced step
missing action id
missing event id
bad branch edge
bad timer
bad binding
bad terminal shape
```

Runtime must refuse each.

Expected:

```text
0 native TypeError
0 silent execution
0 permanent process wedge
```

---

# 90. F2 Tampered Compatibility Identity

Attempt to tamper with workflow semantic fields in IR while retaining stale compatibility metadata.

Runtime must not blindly trust contradictory representation if public architecture admits such an object.

At minimum fail closed.

Do not create a requirement to defend against cryptographically malicious local code beyond the public runtime boundary; the purpose is semantic consistency, not sandboxing trusted host code.

---

# 91. Existing Workflow Conformance

Run all existing:

```text
axiom.conformance.v8
```

workflow fixtures.

Expected:

```text
13 / 13
```

or the new additive total if fixtures are added.

---

# 92. Additive Conformance Fixture — Mixed Build

If the public conformance architecture can represent authority compatibility, add a fixture/control demonstrating:

```text
workflow semantic mutation
=>
incompatible
```

Do not force this into conformance if the runner cannot meaningfully model multi-build authority compatibility.

A dedicated compatibility regression test is acceptable.

---

# 93. Additive Negative Control

Where conformance is extended, include negative controls so the new fixture is non-vacuous.

Example:

```text
force expected compatible
```

for semantically different workflow graphs.

Runner must fail.

---

# 94. Regression — spec14pt2 Action Crash Safety

Rerun:

```text
SIGKILL after ActionDef durable commit
before workflow transition
fresh authority reconciliation
```

At least:

```text
20 trials
```

Prefer original 50 before publish if practical.

Required:

```text
durable counter == 1
one logical step-succeeded
one workflow continuation
```

---

# 95. Regression — spec14pt2 Event Crash Safety

Rerun:

```text
event accepted
SIGKILL before workflow transition
fresh authority replay
```

At least:

```text
20 trials
```

Prefer 50.

Required:

```text
one event-matched
```

---

# 96. Regression — Claim Race

Rerun:

```text
2 authorities
8 authorities
```

Expected:

```text
exactly one logical transition
```

---

# 97. Regression — Stale Owner

Rerun:

```text
SIGSTOP old owner
lease expiry
new owner advances
SIGCONT old owner
```

Expected:

```text
stale commit refused
```

---

# 98. Regression — Start Idempotency

Rerun selected:

```text
sequential duplicate
concurrent duplicate
uncertain response
principal isolation
```

Compatibility changes must not affect WorkflowStartIdentity semantics.

---

# 99. Regression — Timer Target Capture

Verify:

```text
timer target captured once
restart does not recompute
```

---

# 100. Regression — Event Dedup

Workflow compatibility changes must not alter canonical event dedup.

Same logical external event remains one canonical event occurrence according to existing semantics.

---

# 101. Regression — Non-Workflow Graph Compatibility

Use representative 0.13 graphs with:

```text
StateDef
ActionDef
EventDef
QueryDef
live queries
```

but no WorkflowDef.

Compare compatibility behaviour with `0.14.0-alpha.1`.

Expected:

```text
unchanged
```

except for independently demonstrated bugs.

---

# 102. Regression — Server IR

Verify:

```text
workflow graph:
    axiom.server.v8

non-workflow graph:
    retains expected historical minimum contract
```

Do not accidentally force all graphs to v8 if the compiler previously preserved lower required versions.

---

# 103. Regression — Semantic Fingerprint of Non-Workflow Graph

For representative graph with no workflow:

```text
semanticFingerprint before correction
==
semanticFingerprint after correction
```

unless implementation uses the already-existing graph fingerprint unchanged, in which case prove no perturbation.

---

# 104. Regression — Presentation-Only Workflow Graph

Presentation-only changes must remain compatible.

This test is mandatory.

An implementation that closes F3 by hashing the complete serialized WorkflowDef including descriptions fails this specification.

---

# 105. Documentation Update

Update canonical workflow/authority documentation to explicitly state:

> Durable workflow instances are bound to executable semantic compatibility. An authority whose graph changes the executable meaning of the workflow must fail closed rather than continue the instance under changed semantics.

Document:

```text
semantic workflow changes are incompatible
presentation-only changes remain compatible
authority/process identity is irrelevant
compatible replacement authorities may recover instances
```

---

# 106. semantic-identity Public Contract

Update the semantic identity documentation/type comments so WorkflowDef is explicitly included in executable semantic identity.

The previous public inclusion list that omitted WorkflowDef must not remain misleading.

If the type declaration contains an inclusion list, update it.

Do not merely fix implementation while leaving shipped `.d.ts` contract incorrect.

---

# 107. Agent Reference

Update `AGENT_REFERENCE.md` where appropriate so an AI author understands:

```text
changing executable WorkflowDef semantics can make existing instances
incompatible with the new build
```

Do not imply that changing step semantics is safe during an in-flight workflow.

---

# 108. Authority Documentation

Update `AUTHORITY.md` compatibility section.

Explain that authority compatibility covers WorkflowDef executable meaning in v8.

The documentation should make clear:

```text
topology may change
authority identity may change
semantic interpretation may not silently change
```

---

# 109. Workflow Documentation

Update `WORKFLOWS.md` with a short compatibility section.

At minimum explain:

```text
in-flight instances survive compatible authority replacement

semantically incompatible workflow definitions fail closed

presentation-only changes do not invalidate instances

workflow migration across incompatible definitions is not provided in 0.14
```

---

# 110. Migration Is Out of Scope

Do NOT implement workflow migration in spec14pt3.

If a WorkflowDef changes incompatibly while old instances exist:

```text
old instance waits for compatible authority/build
```

or follows whatever existing fail-closed operational behaviour is documented.

Do not add:

```text
instance upgrader
step remapping
binding migration
workflow version migration DSL
```

Those are future semantics.

---

# 111. No Automatic "Closest Step" Recovery

Never attempt:

```text
old step id missing
-> find similar new step
```

or:

```text
old event id changed
-> use new event
```

or:

```text
old action removed
-> skip it
```

Compatibility failure must be explicit.

---

# 112. No Semantic Replay Under New Definition

Do not solve mixed-build compatibility by replaying prior workflow history through build B to "catch up".

That would still reinterpret old durable meaning under new semantics.

Incompatible is incompatible.

---

# 113. No Compatibility Based Only on Step IDs

The following is insufficient:

```text
same workflow id
same step ids
same active step id
```

Phase 22 proved that meaning may change while all structural ids remain stable.

Executable fields matter.

---

# 114. No Compatibility Based Only on IR Version

The following is also insufficient:

```text
both builds use axiom.server.v8
```

IR contract compatibility means both understand the vocabulary.

It does NOT mean two graphs contain equivalent executable semantics.

Keep distinct:

```text
IR protocol compatibility
graph semantic compatibility
workflow instance compatibility
```

---

# 115. No Compatibility Based Only on schemaFingerprint

Schema compatibility is not sufficient.

A timer duration, branch predicate or ActionDef target may change without changing schema shape.

Executable semantic identity must participate.

---

# 116. Fingerprint Collision Assumption

Use the framework's existing cryptographic/canonical fingerprint mechanism.

Do not introduce a weaker ad-hoc hash for workflows.

This specification does not require proof against cryptographic hash collision beyond the existing Axiom semantic fingerprint threat model.

---

# 117. Compatibility Diagnostic Discoverability

An external consumer should be able to determine why an instance refuses to advance without repository source access.

Target remains:

```text
D1
```

At minimum public error/inspection/docs should make incompatibility identifiable.

---

# 118. Safety Classification After Correction

Closing F3 internally does NOT automatically restore:

```text
S1
```

Phase 22 remains incomplete.

The external tester must retest F3 and then continue the previously de-scoped Phase 22 sections.

---

# 119. Required Focused External F3 Rerun

After publishing the corrective package set, run a fresh external consumer test against the published version.

Do not test workspace packages.

Exact package versions only.

Required semantic mutations:

```text
action target
wait-event event id
branch predicate/constant
timer duration
retry policy
control-flow edge
```

Each must produce:

```text
incompatible
```

---

# 120. Focused External Process Trial

Re-run the original Phase 22 mixed-build process scenario.

Required:

```text
25 / 25
```

with:

```text
build A creates/parks instance
build B differs semantically
build B attempts progression
build B refused
instance unchanged
```

Forbidden counters:

```text
B logical transitions          0
B ActionDef invocations        0
B event matches                0
B timer transitions            0
instance revisions by B        0
```

---

# 121. Focused Presentation Control

Published corrective package must also pass:

```text
25 / 25
```

where B differs only by presentation metadata.

Expected:

```text
compatible
```

---

# 122. Focused F1 External Retest

From a fresh external consumer, construct malformed WorkflowDef with unknown step kind.

Expected:

```text
WORKFLOW_INVALID_STEP
```

or canonical structured equivalent.

Forbidden:

```text
TypeError
```

---

# 123. Focused F2 External Retest

Compile valid IR.

Tamper tester-owned copy.

Attempt runtime execution/admission.

Expected:

```text
structured fail-closed
```

Forbidden:

```text
native TypeError
silent execution
permanent wedge
```

---

# 124. Resume Phase 22 — Do Not Restart From Zero

After F3 focused rerun passes, resume the existing blind Phase 22.

Previously successful Phase 22 evidence may remain evidence unless the corrective change could plausibly affect that subsystem.

However, all tests directly touching:

```text
semantic fingerprint
authority compatibility
workflow admission
claiming
```

must be rerun.

---

# 125. Remaining Phase 22 Mandatory Areas

The following were explicitly de-scoped/not completed and MUST run before 0.14 freeze:

```text
retry durability §22–25

external effect honesty §26

principal preservation / authorization §53–55

terminal late-wakeup behaviour §50–52

event journal retention §74 / §77 / §127

start idempotency retention §75

action idempotency retention §76 / §126

SQLite contention stress §67

0.12 / 0.13 regressions §100–108

all required supported non-memory conformance runtimes
```

Do not classify 0.14 as externally validated before these are complete.

---

# 126. Special Attention — Action Idempotency Retention

The external test must still answer:

```text
Can a live workflow outlive the durable ActionDef idempotency evidence
needed to reconcile a committed activation?
```

If yes, test:

```text
action commits
workflow transition remains unresolved
idempotency evidence ages out
fresh authority reclaims
```

Forbidden:

```text
second logical ActionDef invocation
```

Acceptable:

```text
evidence retained long enough
```

or:

```text
fail closed because reconciliation proof unavailable
```

---

# 127. Special Attention — Event Journal Retention

The external test must still answer:

```text
Can replay evidence required by an active wait be trimmed?
```

Test:

```text
active wait
accepted post-boundary event
journal churn
authority death
fresh recovery
```

Forbidden:

```text
silent permanent wait caused by trimmed required event
```

---

# 128. Special Attention — Retry Durability

Complete Phase 22 retry testing.

At minimum:

```text
retryable action failure
durable attempt counter
durable nextEligibleAt
authority death
complete restart
late restart after due time
cancellation while retry waiting
```

Required:

```text
attempt counter does not reset
retry does not fire early
retry is not permanently lost
logical workflow transition remains exactly once
```

---

# 129. Special Attention — Effect Honesty

Complete external effect tests.

Distinguish:

```text
logical effect
physical effect attempt
```

Workflow durability must not claim physical exactly-once where Axiom's effect model only guarantees at-least-once physical attempts.

Required:

```text
stable logical effect identity
no duplicate logical effect due solely to workflow recovery
```

---

# 130. Special Attention — Principal Preservation

Complete:

```text
workflow started as u1
later action executes after authority replacement
```

Expected semantic principal:

```text
u1
```

not:

```text
authority
system
admin
anonymous
```

---

# 131. Special Attention — Authorization Re-Evaluation

Start workflow while future action is authorized.

Change authorization before that step.

Expected:

```text
current authorization evaluated
```

Do not fossilize authorization at workflow start.

Retry must also re-evaluate current authorization according to existing ActionDef semantics.

---

# 132. Special Attention — Terminal Late Wakeups

For each terminal state:

```text
completed
failed
cancelled
```

inject late:

```text
event
timer
retry wakeup
duplicate recovery
```

Expected:

```text
no resurrection
```

---

# 133. Special Attention — SQLite Stress

Run workflow transitions under meaningful concurrent SQLite contention.

Include other Axiom state/data activity where practical.

Forbidden:

```text
silent workflow transition loss
raw SQLITE_BUSY
raw SQLITE_LOCKED
raw "database is locked"
stale successful transition
```

within documented supported deployment conditions.

---

# 134. Required Historical Regression — 0.13 F1

Re-run provider-record-only cross-authority live-query invalidation.

Required:

```text
50 / 50 observed
StateDef sync pulse = none
```

---

# 135. Required Historical Regression — Live 1/2/8

Re-run:

```text
1 authority
2 authorities
8 authorities
```

provider-backed live-query topology workload.

Expected:

```text
same final live meaning
```

---

# 136. Required Historical Regression — Live Cursor

Re-run:

```text
cursor tampering
wrong query
wrong principal
wrong args
mixed semantic build
```

Expected fail-closed behaviour.

---

# 137. Required Historical Regression — SQLite Lost Write

Re-run existing StateDef SQLite lost-write contention matrix.

Expected:

```text
0 silent lost writes
```

---

# 138. Required Historical Regression — Distributed Fencing

Re-run selected 0.12 coordination/lease/fence tests.

Workflow compatibility changes must not weaken general authority fencing.

---

# 139. Required Historical Regression — Event Dedup

Verify workflow event journaling remains subordinate to canonical event dedup semantics.

No duplicate canonical event meaning.

---

# 140. Required Historical Regression — Effect Identity

Verify workflow action reconciliation does not create duplicate logical effect identities.

---

# 141. Required Historical Regression — Query StateRef Refusal

Re-run 0.13.1:

```text
QUERY_STATE_REF_NOT_ALLOWED
```

across:

```text
validation
compiler
AgentAPI
runtime guard
```

---

# 142. Full Internal Repository Gate

Before publish, all repository tests must be green.

Current baseline reported after spec14pt2:

```text
1421 tests
0 failures
```

spec14pt3 may increase the count.

Required:

```text
all tests green
```

---

# 143. Release Packaging Gate

Before publishing the corrective package set run:

```text
release:pack
release:verify
release:consumer-test
release:probe
documentation tests
```

All must be green against the final tree.

Do not publish from a tree different from the tested tree.

---

# 144. Versioning

Because `0.14.0-alpha.1` has already been externally tested and contains a release-blocking semantic compatibility defect, do not overwrite/reuse it.

Publish the corrective build as a new immutable version.

Recommended:

```text
0.14.0-alpha.2
```

All companion packages must use the exact coherent version.

No mixed:

```text
alpha.1 / alpha.2
```

package set.

---

# 145. Implementation Report

Update:

```text
reports/AXIOM_0_14_IMPLEMENTATION_REPORT.md
```

with a dedicated spec14pt3 section.

Record:

```text
Phase 22 F3 root cause
canonical semantic projection chosen
authority compatibility correction
WorkflowDef inclusion mechanism
transitive dependency treatment
presentation exclusions
F1 validation correction
F2 runtime IR correction
tests added
real-process trial results
versions
```

---

# 146. Required F3 Report Q&A

The implementation report must explicitly answer:

```text
1. Why did semanticFingerprint(graph) detect WorkflowDef changes while
   AuthorityCompatibilityKey.semanticFingerprint did not?

2. What was the exact duplicated/divergent semantic identity mechanism?

3. What is now the single authoritative semantic projection?

4. How does WorkflowDef enter authority compatibility?

5. Are referenced ActionDefs included transitively?

6. Are referenced EventDefs included transitively where required?

7. Which WorkflowDef fields are semantic?

8. Which fields are presentation-only?

9. What identity is stored with a workflow instance?

10. At what exact point is an authority refused?

11. Can an incompatible authority mutate instanceRevision?

12. Can an incompatible authority invoke an ActionDef?

13. Can an incompatible authority match an event?

14. Can an incompatible authority fire a timer?

15. Can a semantically identical fresh process recover the instance?

16. Does compatibility remain leaderless?

17. Did Server IR remain axiom.server.v8?

18. Did conformance remain axiom.conformance.v8?
```

---

# 147. Required F1 Report Q&A

Record:

```text
What malformed step caused the Phase 22 TypeError?

Where did validation assume a known step kind?

What structured diagnostic is now emitted?

Do validateGraph and compileToServerIR agree?

Can malformed input still leak a native TypeError?
```

---

# 148. Required F2 Report Q&A

Record:

```text
What tampered IR shape caused the runtime failure/wedge?

Where is invalid IR now rejected?

What structured error is produced?

Can unknown workflow IR execute partially?

Can invalid IR reach an ActionDef or event transition?
```

---

# 149. Anti-Pattern Documentation

Add or update anti-pattern guidance equivalent to:

```text
Do not treat matching workflow ids/step ids as semantic compatibility.

Do not treat matching Server IR version as graph semantic compatibility.

Do not continue an in-flight workflow under changed executable WorkflowDef
semantics.

Do not solve workflow upgrades with sticky routing.

Do not hash presentation metadata merely to make mixed-build checks stricter.
```

Use existing anti-pattern numbering conventions.

---

# 150. No Hidden Escape Hatch

The correction must not require application code to do:

```text
if (workflowVersion === "old") routeToOldServer()

if (workflowFingerprint === X) ...

sticky workflow routing

manual workflow migration

manual compatibility registry
```

Compatibility remains framework-owned.

Target remains:

```text
E1
```

---

# 151. No Topology Vocabulary in Workflow Graph

Do not add graph semantics such as:

```text
buildId
authorityId
nodeId
runOnVersion
runOnInstance
workflowHost
```

Deployment/version compatibility is runtime infrastructure, not application workflow control flow.

---

# 152. Compatibility vs Version String

Do not use package version alone as semantic compatibility.

Two builds with:

```text
same package version
different application graph
```

may be semantically incompatible.

Two independently constructed deployments with semantically identical graphs may be compatible.

Graph semantic identity is authoritative.

---

# 153. Compatibility vs Deployment Build ID

Likewise, a build/deployment identifier may be useful diagnostics but cannot replace semantic identity.

Forbidden rule:

```text
different build hash => incompatible
```

if the graph semantics are identical.

That would unnecessarily destroy rolling deployment compatibility.

---

# 154. Compatibility vs Schema Fingerprint

Keep distinct:

```text
schemaFingerprint
semanticFingerprint
```

Workflow executable changes such as:

```text
timer 1s -> 10s
branch true -> false
action A -> B
```

must not rely on schemaFingerprint to detect incompatibility.

---

# 155. Fail-Closed Definition

For this specification, fail-closed means:

```text
incompatible authority does not execute changed workflow meaning
```

It does NOT necessarily mean:

```text
entire server crashes
```

Preferred behaviour is controlled refusal.

The instance remains intact for a compatible authority.

---

# 156. No Automatic Failure of the Workflow Instance

An incompatible authority encountering an instance SHOULD NOT automatically transition the workflow itself to:

```text
failed
```

unless existing public semantics explicitly define incompatibility as a workflow failure.

Compatibility is primarily an execution-environment problem.

Preferred behaviour:

```text
instance remains at its existing durable semantic state
authority refuses to advance it
```

This allows a compatible authority to resume later.

---

# 157. No Automatic Cancellation

Likewise, incompatibility must not automatically mean:

```text
cancelled
```

Cancellation is application/operator semantic intent.

Do not conflate deployment incompatibility with workflow cancellation.

---

# 158. No Binding Rewrite

An incompatible authority must not attempt to translate old bindings into its new definition.

No migration semantics exist in 0.14.

---

# 159. No History Rewrite

Do not rewrite old history to match the new build.

History remains evidence of the workflow semantics that actually executed.

---

# 160. Existing Instance Identity

Workflow instance identity must remain stable through compatible process replacement.

Do not create a new instance merely because an authority changed.

---

# 161. Start Under New Semantic Build

A new start under build B may create a new B-semantic instance according to normal WorkflowStartIdentity rules.

Do not accidentally cause new starts to collide with an incompatible old instance in a way that silently reuses the old semantics.

Explicitly test the interaction between:

```text
WorkflowStartIdentity
semantic compatibility
```

if the same start identity can encounter an existing instance created under incompatible semantics.

The correct behaviour must be explicit and fail closed rather than silently returning/reusing an incompatible instance.

---

# 162. Start Idempotency Across Incompatible Builds

Mandatory design question:

```text
Build A starts workflow with start identity K.

Build B has incompatible WorkflowDef semantics.

Client repeats start identity K against B.
```

The runtime MUST NOT silently treat the existing A instance as a B-semantic idempotent start.

Acceptable behaviours include:

```text
return existing instance together with explicit incompatibility/refusal
```

or:

```text
structured incompatible-start error
```

according to existing API shape.

Unacceptable:

```text
reuse old instance and continue it under B
```

or:

```text
create second logical instance for the same still-protected start identity
without explicit semantics permitting it
```

Add tests.

---

# 163. Cancellation From Incompatible Build

Determine whether `cancelWorkflow(instanceId)` requires interpreting WorkflowDef executable semantics.

If cancellation is definition-independent durable control:

```text
it may potentially remain allowed
```

if this is consistent with existing semantics.

If cancellation depends on workflow definition interpretation:

```text
it must be compatibility-gated
```

Do not guess.

Document and test the chosen semantics.

Critical invariant:

```text
incompatible build cannot execute changed workflow business semantics
```

Cancellation must never cause automatic execution of B's changed steps.

---

# 164. Inspection From Incompatible Build

Read-only inspection may remain allowed if safe.

Prefer allowing operators to observe:

```text
instance exists
instance status
compatibility mismatch
```

without executing it.

Do not unnecessarily make operational diagnosis impossible.

---

# 165. Event Ingress With Mixed Builds

Canonical event acceptance must remain independent of which workflow build receives the external event where existing event semantics permit.

An incompatible workflow authority may accept/journal a canonical event as infrastructure, but it must not apply changed workflow matching semantics to an incompatible instance.

A compatible authority must still be able to reconcile the event later.

Test this if architecture routes events through mixed authorities.

---

# 166. Timer Discovery With Mixed Builds

An incompatible authority may discover that a workflow has durable timer-related work.

It must not interpret or transition it under changed semantics.

A compatible authority must remain able to process it.

---

# 167. Retry Discovery With Mixed Builds

Same principle for retry:

```text
incompatible authority may observe
but may not semantically execute
```

---

# 168. Action Reconciliation With Mixed Builds

Particularly important:

```text
A action logically commits
A dies before workflow transition
B is incompatible
```

B must NOT reconcile the pending activation using changed workflow semantics.

Later compatible A2 must still be able to reconcile the original action exactly once.

Add a targeted test.

---

# 169. Event Recovery With Mixed Builds

Likewise:

```text
A wait active
event accepted
A dies
B incompatible
```

B must not reinterpret the wait.

Later compatible A2 must still match the durable event according to A semantics.

Add a targeted test.

---

# 170. Timer Recovery With Mixed Builds

Likewise:

```text
A timer active
A dies
timer becomes due
B incompatible
```

B must not reinterpret it.

Later compatible A2 must recover the original timer semantics.

---

# 171. Compatibility Must Survive Complete Restart

Compatibility evidence must be durable enough that after:

```text
all authorities stop
```

a fresh incompatible build cannot claim ignorance and continue an old instance.

Required:

```text
instance compatibility identity survives complete process loss
```

---

# 172. Compatibility Identity Must Not Be Authority-Local Only

Forbidden:

```text
Map<instanceId, semanticFingerprint>
```

held only in process memory.

Durable instances require durable compatibility evidence.

---

# 173. Compatibility Evidence and WorkflowStore

If compatibility identity is stored in WorkflowStore, it must participate correctly in instance creation.

Required:

```text
instance creation
+
compatibility identity
```

must not have a crash gap that can create a durable instance with unknown semantic identity.

Prefer same durable creation transaction.

If another architecture is used, prove equivalent crash safety.

---

# 174. Existing Instances From alpha.1

Decide explicitly whether workflow instances created by `0.14.0-alpha.1` contain sufficient durable identity for `alpha.2` to determine compatibility.

Possible outcomes:

```text
A. alpha.2 can safely identify alpha.1 instances
```

or:

```text
B. alpha.1 instances lack sufficient proof and alpha.2 must fail closed
```

Do NOT infer compatibility optimistically.

Because alpha releases are pre-freeze, failing closed on insufficient historical compatibility evidence is acceptable.

Silent reinterpretation is not.

Document this.

---

# 175. Legacy Instance Fail-Closed

If an existing durable instance has:

```text
missing compatibility fingerprint
unknown fingerprint version
invalid compatibility metadata
```

then:

```text
do not advance
```

unless compatibility can be proven through another canonical mechanism.

No default:

```text
missing means compatible
```

---

# 176. Compatibility Metadata Tampering

If durable compatibility metadata is malformed/corrupt:

```text
fail closed
```

Do not silently replace it with current authority fingerprint and continue.

---

# 177. Fingerprint Algorithm Evolution

Do not introduce an undocumented path where a future fingerprint algorithm change makes all old instances silently compatible.

If fingerprint format/version matters, make it explicit enough to fail closed on unknown formats.

A full workflow migration/versioning system remains out of scope.

---

# 178. Required Crash Test — Instance Creation Compatibility Evidence

If implementation changes durable instance creation metadata:

```text
start workflow
SIGKILL around instance creation
fresh authority recover
```

Expected:

```text
either no instance exists
or
complete instance with valid compatibility identity exists
```

Forbidden:

```text
durable instance exists with missing/ambiguous compatibility identity
and is treated as compatible
```

Minimum:

```text
25 trials
```

if the storage path changes materially.

---

# 179. Required Concurrency Test — Same Start, Different Semantic Builds

Race:

```text
build A start identity K
build B incompatible start identity K
```

against shared durable stores.

Expected:

```text
one canonical start identity outcome
no silent cross-semantic reuse
no duplicate logical workflows caused by race
```

Run:

```text
25 trials
```

if public deployment permits this scenario.

---

# 180. Required Forbidden Counters for spec14pt3

The corrective test report must include:

| Counter | Required |
| --- | ---: |
| incompatible authority successful logical workflow transitions | 0 |
| incompatible authority ActionDef logical invocations | 0 |
| incompatible authority event-match transitions | 0 |
| incompatible authority timer transitions | 0 |
| incompatible authority retry executions | 0 |
| incompatible authority binding mutations | 0 |
| incompatible authority instanceRevision advances | 0 |
| presentation-only false incompatibilities | 0 |
| native TypeError from unknown workflow step validation | 0 |
| native TypeError from tested tampered workflow IR | 0 |
| silent execution of tampered workflow IR | 0 |
| compatible fresh-authority recovery failures | 0 |
| regressions in action crash reconciliation | 0 |
| regressions in event crash recovery | 0 |
| stale-owner successful commits | 0 |

---

# 181. Required Corrective Result Table

Final implementation evidence should include:

| Area | Scenario | Trials | Expected |
| --- | --- | ---: | --- |
| F3 | action target semantic change | direct + process | incompatible |
| F3 | event id semantic change | direct + process | incompatible |
| F3 | branch semantic change | direct + process | incompatible |
| F3 | timer duration semantic change | direct + process | incompatible |
| F3 | retry semantic change | direct | incompatible |
| F3 | control edge semantic change | direct | incompatible |
| control | presentation-only change | 25 | compatible |
| recovery | compatible fresh process | 25 | resumes |
| mixed topology | compatible + incompatible authorities | 25 | only compatible advances |
| validation | unknown step kind | all malformed cases | structured refusal |
| IR | tampered workflow IR | all cases | structured refusal |
| regression | action commit → SIGKILL | 20+ | exactly once |
| regression | event accept → SIGKILL | 20+ | exactly once |
| regression | stale owner | 10+ | refused |
| regression | claim race | 2/8 authority | one advancement |

---

# 182. Internal Success Gate

spec14pt3 implementation is internally complete only when:

```text
F3 root cause fixed structurally

WorkflowDef executable semantics participate in authority compatibility

transitive executable dependencies accounted for

presentation-only control remains compatible

incompatible in-flight continuation fails closed

compatible replacement authority still recovers

F1 native validation TypeError eliminated

F2 tested tampered IR fails closed

existing spec14pt2 crash safety remains green

full repository green

release packaging gates green
```

---

# 183. Publish Gate

Do not publish the corrective release until:

```text
npm test                     GREEN
documentation tests          GREEN
release:pack                 GREEN
release:verify               GREEN
release:consumer-test        GREEN
release:probe                GREEN
```

and the focused real-process mixed-build tests are green.

---

# 184. External Test Gate

After publish, use a new clean consumer with exact package pins.

Do NOT expose implementation report or internal tests to the blind tester before the focused rerun.

First rerun F3.

If F3 still reproduces:

```text
STOP
NOT EXTERNALLY VALIDATED
Safety <= S3
```

Do not waste time running the remainder of Phase 22.

---

# 185. Resume Gate

Only after focused F3 external rerun is green:

```text
resume Phase 22
```

Run all previously de-scoped mandatory sections.

Do not treat focused F3 closure as full Phase 22 validation.

---

# 186. Required Final External Verdict

The 0.14 semantic model may be frozen only if the completed external Phase 22 ultimately reports:

```text
Axiom 0.14 Durable Workflows

Discoverability: D1
Semantic Escape: E1
Safety:          S1

EXTERNALLY VALIDATED
```

Anything below:

```text
D1 / E1 / S1
```

means:

```text
DO NOT FREEZE
```

---

# 187. Release Classification

If final Phase 22 succeeds, record:

```text
Axiom 0.14
Durable Workflows

Classification:
B — DURABLE WORKFLOWS

Server IR:
axiom.server.v8

Conformance:
axiom.conformance.v8

External validation:
D1 / E1 / S1

Status:
EXTERNALLY VALIDATED
SEMANTIC MODEL FROZEN
```

Use the project's existing classification vocabulary if the exact classification label differs.

---

# 188. Findings Closure Record

The final milestone record should explicitly list:

```text
Phase 22 F1
Unknown workflow step native TypeError
CLOSED

Phase 22 F2
Tampered workflow IR native failure / non-graceful refusal
CLOSED

Phase 22 F3
WorkflowDef omitted from enforced authority semantic compatibility
CLOSED
```

F3 is release-blocking.

F1/F2 are hardening findings.

---

# 189. Architectural Principle Established by This Correction

spec14pt3 should establish a general Axiom invariant:

> Every new graph primitive that changes executable semantic meaning must participate automatically in the canonical semantic identity used for distributed authority compatibility.

Future graph primitives must not require someone to remember:

```text
"also add this node to a second fingerprint inclusion list"
```

This is the deeper architectural correction behind F3.

---

# 190. Future Regression Guard

Add a generic regression guard if practical:

```text
for every executable graph primitive represented in canonical semantic projection,
authority semantic compatibility must consume the same projection
```

The goal is to make a future:

```text
WorkflowDef-like omission
```

difficult to introduce.

Do not over-engineer reflection/code generation if a simpler shared projection makes the invariant structural.

---

# 191. Definition of Done

spec14pt3 is DONE when all of the following are true:

```text
1. There is one authoritative executable semantic projection or equivalent
   structurally shared identity mechanism.

2. WorkflowDef executable semantics participate in it.

3. ActionDef/EventDef/transitive dependencies are handled consistently
   with graph semantic identity.

4. Authority compatibility detects every tested executable WorkflowDef change.

5. Presentation-only changes remain compatible.

6. An incompatible authority cannot semantically advance an existing workflow.

7. Compatible replacement authorities still recover workflows after full restart.

8. Missing/unknown compatibility evidence fails closed.

9. Unknown workflow step validation never leaks native TypeError.

10. Tested tampered workflow IR fails closed without native TypeError or wedge.

11. Server IR remains axiom.server.v8 unless an actual serialized-contract
    change proves otherwise.

12. Conformance remains axiom.conformance.v8 unless an actual contract
    change proves otherwise.

13. spec14pt2 ActionDef crash reconciliation remains exactly-once logically.

14. spec14pt2 accepted-event crash recovery remains no-gap.

15. fencing and claim races remain green.

16. full repository tests are green.

17. release packaging gates are green.

18. a new immutable corrective package set is published.

19. focused blind F3 external rerun passes.

20. the remainder of Phase 22 is resumed rather than skipped.

21. only a final D1 / E1 / S1 result permits 0.14 semantic freeze.
```

---

# 192. Final Instruction to the Implementing Agent

Treat this as a corrective safety pass.

Do not expand the workflow language.

Do not redesign Durable Workflows.

Do not optimize around the external test cases individually.

Fix the underlying semantic identity architecture so that:

```text
canonical executable graph meaning
```

and:

```text
distributed authority compatibility
```

cannot disagree about WorkflowDef.

Then close the two hardening defects, prove the correction with focused real-process tests, run the complete release gate, publish a coherent immutable corrective package set, and return it for continued blind Phase 22 falsification.

The goal is not:

```text
make Phase 22 green
```

The goal is:

```text
make it impossible for a compatible-authority check to approve
a different executable interpretation of an existing durable workflow.
```