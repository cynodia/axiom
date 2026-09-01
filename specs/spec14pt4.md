# Axiom 0.14 Part 4 Specification
## Workflow Input Totality and Structural Validation Closure

**Target:** `0.14.0-alpha.3` or equivalent corrective release  
**Baseline:** published `0.14.0-alpha.3`  
**Recommended branch:** `spec14pt4-workflow-validation-closure`  
**Status:** Narrow corrective specification following focused external Phase 22 retest  
**Scope:** Close residual Phase 22 F1 and F2 findings only  
**F3 status:** EXTERNALLY CLOSED — do not redesign mixed-build compatibility  
**Required outcome:** focused external F1/F2 retest PASS, then resume remaining Phase 22

---

# 1. Purpose

The focused external retest of `0.14.0-alpha.3` established:

```text
F3 — mixed-build semantic compatibility
EXTERNALLY CLOSED

F1 — malformed workflow input totality
OPEN — narrow residual

F2 — tampered Server IR structural validation
OPEN — narrow residual
```

The corrective retest otherwise passed:

```text
mixed-build refusal
compatible recovery
presentation-only compatibility
mixed topology
missing compatibility evidence
action crash regression
event crash regression
stale-owner fencing
conformance
```

This specification closes only the remaining F1/F2 validation defects.

Do NOT redesign:

```text
WorkflowDef
workflow durability
authority compatibility
semantic fingerprinting
coordination
fencing
event recovery
action reconciliation
```

---

# 2. Primary Goal

All public Axiom surfaces that inspect, validate, compile, admit, or execute WorkflowDef semantics must be total over malformed workflow input.

For malformed input:

```text
Axiom semantic layer
    =>
structured refusal
```

Never:

```text
native TypeError
silent acceptance
partial semantic execution
permanent running wedge
```

---

# 3. Core Invariant

For every malformed WorkflowDef or workflow Server IR value `W` presented to a public semantic boundary:

```text
inspect(W)
validate(W)
compile(W)
admit(W)
execute(W)
```

must produce either:

```text
valid semantic result
```

or:

```text
structured Axiom diagnostic/refusal
```

It MUST NOT depend on host-language exceptions for correctness.

---

# 4. Phase 22 F1 Residual

`0.14.0-alpha.3` correctly fixed malformed-step handling in:

```text
validateGraph
compileToServerIR
AgentAPI.validate
```

but the external tester found that:

```text
AgentAPI.analyzeWorkflow
```

still performs an unsafe property read equivalent to:

```text
String(step.id)
```

before delegating to totality-guarded workflow helpers.

For:

```text
step = null
step = undefined
```

this produces:

```text
TypeError: Cannot read properties of null/undefined
```

Therefore F1 remains open.

---

# 5. F1 Required Fix

`AgentAPI.analyzeWorkflow` MUST be total over malformed WorkflowDef step arrays.

At minimum handle:

```text
unknown string kind
missing kind
null kind
numeric kind

step = null
step = undefined
step = string
step = number
step = boolean
step = array
step = {}
```

No direct property access may occur until the value is proven to have the required structural shape.

---

# 6. F1 Required Behaviour

For malformed workflow input, `AgentAPI.analyzeWorkflow` must produce the public structured failure behaviour appropriate to AgentAPI.

Prefer consistency with existing validation semantics:

```text
WORKFLOW_INVALID_STEP
```

where applicable.

The exact return/throw shape should follow existing AgentAPI conventions.

Forbidden:

```text
TypeError
ReferenceError
RangeError
"cannot read property"
"undefined is not..."
```

---

# 7. F1 Single Validation Path

Do not fix only the two observed lines with:

```text
if (step != null)
```

while leaving parallel unsafe traversal elsewhere.

Audit the entire `analyzeWorkflow` implementation for assumptions such as:

```text
step.id
step.kind
step.type
step.next
step.action
step.event
step.when
```

before structural validation.

Prefer:

```text
validate/normalize once
then analyze validated structure
```

or reuse the total workflow accessors introduced in pt3.

---

# 8. F1 Public Surface Matrix

Test the same malformed workflow corpus through every relevant public surface:

```text
validateGraph
compileToServerIR
AgentAPI.validate
AgentAPI.analyzeWorkflow
```

Expected:

```text
structured refusal
native error count = 0
```

The same malformed semantic object must not be safely rejected by one public API and crash another.

---

# 9. F1 Totality Regression Guard

Add a reusable malformed-workflow corpus test rather than maintaining separate incomplete lists per package.

At minimum include:

```text
null step
undefined step
string step
number step
boolean step
array step
empty object
unknown step kind
missing step kind
null step kind
numeric step kind
```

Run the corpus against every public workflow analysis/validation boundary that accepts graph-level workflow input.

---

# 10. Phase 22 F2 Residual

The focused external retest confirmed that most tampered Server IR cases now fail correctly with:

```text
WorkflowIRError
WORKFLOW_INVALID_IR
```

However two residual classes remain.

### F2-A — semantic reference integrity

Examples admitted by alpha.2:

```text
bind -> undeclared binding id

binding.producedBy -> nonexistent producer

branch expression -> unknown ref id
```

Observed consequences included:

```text
permanent status:"running" wedge
history stops after event-matched
wedge survives complete authority restart
```

or silent dropping of invalid binding semantics.

### F2-B — malformed structural container shapes

Examples:

```text
steps = string
workflows[0] = null
workflows = string
```

can still reach unsafe workflow traversal and throw native `TypeError` during `createAxiomServer`.

Therefore F2 remains open.

---

# 11. F2 Primary Invariant

A workflow admitted into the runtime must already satisfy enough structural and reference integrity that normal workflow execution cannot encounter:

```text
missing step
unknown binding
unknown workflow ref
invalid container
invalid expression scope
```

and become permanently non-runnable.

Malformed IR must be rejected before workflow execution.

---

# 12. Structural Validation Must Be Total

`workflowStructuralProblems` or its replacement must itself be total over arbitrary hand-tampered workflow IR values.

It must not assume:

```text
workflows is an array
workflow is an object
steps is an array
step is an object
bindings is an array
binding is an object
```

before proving those shapes.

Conceptually:

```text
unknown input
    ↓
shape guards
    ↓
container validation
    ↓
element validation
    ↓
reference validation
    ↓
semantic structural validation
```

Never traverse first and validate later.

---

# 13. Required Container Validation

At minimum validate:

```text
workflows
workflow
workflow.inputs
workflow.bindings
workflow.steps
```

where present.

Test malformed values:

```text
null
undefined
string
number
boolean
object where array required
array where object required
```

All must fail structurally.

---

# 14. Required Step Validation

Before reading any step property, prove the step is a valid object shape.

Test:

```text
null
undefined
string
number
boolean
array
{}
unknown kind
```

Expected:

```text
WorkflowIRError / WORKFLOW_INVALID_IR
```

or canonical structured equivalent.

No native exception.

---

# 15. Required Binding Declaration Validation

If a workflow step writes/binds to a declared WorkflowBinding, the target binding must exist.

Example invalid IR:

```text
bindings:
  - id: known

wait-event:
  bind:
    value: ghost
```

where:

```text
ghost
```

is not declared.

This must be rejected at admission.

It must not wait until event execution.

---

# 16. Required Binding Producer Validation

If WorkflowBinding metadata identifies a producer step:

```text
binding.producedBy
```

then that producer must refer to a valid step consistent with the workflow's binding semantics.

Example:

```text
producedBy: ghost
```

must be rejected.

Do not silently drop or ignore invalid producer metadata.

---

# 17. Required Expression Reference Validation

Workflow expressions use a closed scope.

For each expression, validate references against the exact scope permitted at that workflow location.

Possible valid namespaces remain whatever 0.14 already defines, such as:

```text
workflow inputs
durable workflow bindings
EVENT where in scope
PRINCIPAL where in scope
```

An unknown ref id must be rejected.

Example:

```text
branch.when -> ref("ghost")
```

must fail before execution.

It must not create a workflow that reaches the branch and remains permanently `running`.

---

# 18. Expression Scope Must Remain Location-Aware

Do not solve unknown refs by globally allowing every possible workflow ref.

Existing scope restrictions remain.

Examples:

```text
EVENT
```

may only be valid where 0.14 already defines it.

Likewise:

```text
StateDef
QueryDef
now()
uuid()
random()
```

remain prohibited according to existing workflow semantics.

This correction tightens validation; it does not expand expression scope.

---

# 19. Required Step Reference Validation

Every control-flow reference must resolve.

At minimum:

```text
entry
next
then
else
onError
onTimeout
```

must point to valid steps where required.

Existing alpha.2 checks that already cover these must remain.

---

# 20. Required Action Reference Validation

For action steps:

```text
action target
```

must resolve according to existing Server IR semantics.

Missing or malformed targets fail admission.

Existing alpha.2 behaviour must remain.

---

# 21. Required Event Reference Validation

For wait-event steps:

```text
event target
```

must resolve according to existing Server IR semantics.

Existing alpha.2 behaviour must remain.

---

# 22. Required Timer Structural Validation

Existing alpha.2 timer tamper rejection must remain.

Continue testing malformed:

```text
after
at
duration shapes
missing required timing semantics
invalid primitive types
```

No regression.

---

# 23. Required Terminal Structural Validation

Existing alpha.2 complete/fail terminal validation must remain.

Malformed terminal payloads must not reach execution.

---

# 24. Graph-Context-Free vs Graph-Context Validation

pt3 introduced:

```text
workflowStructuralProblems
```

as graph-context-free admission validation.

pt4 must explicitly separate:

```text
pure structural validation
```

from:

```text
reference integrity requiring workflow/graph context
```

if necessary.

It is acceptable to have:

```text
workflowStructuralProblems(...)
workflowReferenceProblems(...)
```

or equivalent.

What matters is that the complete admission path performs both before execution.

---

# 25. Design Gate — One Admission Validator

Avoid multiple incomplete runtime validators.

Prefer a single authoritative admission path:

```text
Server IR
    ↓
structural validation
    ↓
reference/scope validation
    ↓
accepted workflow runtime model
```

`createWorkflowEngine` and `createAxiomServer` should not disagree about whether the same malformed workflow IR is admissible.

---

# 26. No Execution-Time Wedge as Validation Strategy

Execution-time guards remain useful defense-in-depth.

But this is NOT sufficient:

```text
invalid IR admitted
workflow starts
runtime discovers bad ref
workflow remains running forever
```

The primary fix is admission refusal.

Execution guards should only protect against impossible/corrupt states that escape admission unexpectedly.

---

# 27. Defense-in-Depth Runtime Behaviour

If invalid workflow state somehow reaches `runStep` / `advance` despite admission validation:

```text
fail explicitly
```

Do not:

```text
return without transition
retry forever
poll forever
silently ignore invalid ref
```

A corrupted instance must not become an unexplained infinite `running` workflow.

---

# 28. Runtime Corruption Failure

For impossible runtime corruption, a structured terminal/runtime failure is acceptable if admission could not reasonably have caught the corruption.

But hand-tampered IR supplied at server creation MUST be rejected at admission.

Keep distinct:

```text
invalid definition at admission
```

versus:

```text
durable state corruption discovered after admission
```

---

# 29. F2 Tampered IR Corpus

Build a reusable tampered-IR corpus.

At minimum include:

```text
workflows = null
workflows = string
workflows = object

workflows[0] = null
workflows[0] = string
workflows[0] = array

steps = null
steps = string
steps = object

step = null
step = string
step = number
step = array
step = {}

unknown step kind

dangling entry
dangling next
dangling then
dangling else
dangling onError
dangling onTimeout

missing action target
missing event target

invalid timer shape
invalid terminal shape

bind -> undeclared binding
binding.producedBy -> unknown step
branch expression -> unknown ref
other workflow expression -> unknown ref
```

Every case must fail deterministically.

---

# 30. F2 Required Result

For every tampered IR corpus entry:

```text
createAxiomServer(...)
```

or the appropriate public admission API must produce:

```text
WorkflowIRError
```

with:

```text
WORKFLOW_INVALID_IR
```

or canonical structured equivalent.

Required counters:

```text
native TypeError = 0
silent admission = 0
semantic execution = 0
permanent wedge = 0
```

---

# 31. No Raw Host Exceptions

Audit workflow admission code for unsafe operations such as:

```text
workflow.steps.map(...)
workflow.steps.filter(...)
step.id
binding.id
expression.kind
Object.entries(value)
```

without prior guards.

The correction should eliminate the class of defect, not merely the exact three shapes reported externally.

---

# 32. Public Type Documentation

If `.d.ts` claims workflow helper totality over hand-tampered IR, implementation must actually satisfy that claim.

Audit comments introduced in pt3.

Do not weaken the documentation merely to make the test pass unless the public boundary genuinely cannot support the promised semantics.

The preferred fix is implementation totality.

---

# 33. AgentAPI Totality

AgentAPI exists specifically to make graph semantics inspectable.

Therefore malformed semantic graphs must not crash static analysis.

Required principle:

```text
AgentAPI may report invalid semantics
AgentAPI must not require valid semantics merely to avoid TypeError
```

---

# 34. AgentAPI analyzeWorkflow Behaviour

For invalid WorkflowDef, `analyzeWorkflow` may:

```text
return structured analysis containing diagnostics
```

or:

```text
return/throw existing structured AgentAPI validation error
```

according to existing API conventions.

Do not invent a new incompatible result shape solely for pt4 if existing structured diagnostics can be reused.

---

# 35. AgentAPI Must Not Execute

The F1 correction must preserve:

```text
analyzeWorkflow
```

as static analysis only.

No:

```text
ActionDef execution
event subscription
timer scheduling
provider mutation
workflow instance creation
```

---

# 36. No Workflow Semantic Changes

The six step kinds remain exactly:

```text
action
wait-event
timer
branch
complete
fail
```

No new workflow semantics.

---

# 37. No Server IR Version Bump

Expected:

```text
axiom.server.v8
```

No serialized semantic vocabulary is being added.

Do not bump to v9 merely for validation hardening.

---

# 38. No Conformance Version Bump

Expected:

```text
axiom.conformance.v8
```

Existing fixtures remain valid.

Additional negative validation fixtures may be added without changing semantic contract version where existing conformance architecture permits.

---

# 39. No Semantic Fingerprint Changes

pt4 should not alter canonical semantic fingerprinting.

Required:

```text
valid graph fingerprints alpha.3
==
valid graph fingerprints alpha.2
```

for representative workflow and non-workflow graphs.

If a fingerprint changes, treat it as suspicious and explain before proceeding.

---

# 40. Do Not Touch F3 Architecture Without Need

F3 is externally closed.

Do not redesign:

```text
EXECUTABLE_KINDS
SERVER_IR_EXECUTABLE_SLICES
canonicalWorkflowForFingerprint
AuthorityCompatibilityKey
isCompatible
```

unless absolutely necessary for F1/F2.

Any change to these requires rerunning focused F3 external evidence.

---

# 41. F3 Smoke Regression

Even if compatibility code is untouched, run a small internal smoke test:

```text
semantic WorkflowDef change
    -> incompatible

presentation-only change
    -> compatible
```

No need for another full internal mixed-build matrix unless compatibility code changes.

---

# 42. Preserve Compatible Recovery

Existing:

```text
incompatible B refused
compatible A2 recovers
```

must remain green.

A small regression test is sufficient if compatibility code is untouched.

---

# 43. Preserve Action Crash Safety

Run existing automated spec14pt2 action crash regression.

Required:

```text
logical ActionDef invocation = 1
```

No need to expand trial counts unless pt4 touches action execution or persistence.

---

# 44. Preserve Event Crash Safety

Run existing event accepted → crash → recovery regression.

Required:

```text
event-matched = exactly 1
```

No need to redesign event journal.

---

# 45. Preserve Stale-Owner Fencing

Run existing stale-owner regression.

Required:

```text
successful stale commits = 0
```

---

# 46. Preserve Start Idempotency

No changes to start identity semantics.

Run normal repository tests.

---

# 47. Preserve Principal Semantics

Do not modify workflow principal handling in this pass.

Principal/authorization remains part of the uncompleted Phase 22 suite.

---

# 48. Preserve Retention Semantics

Do not change action idempotency or event recovery retention in this pass unless independently required.

Retention remains pending external Phase 22 testing.

---

# 49. Required Unit Tests — F1

Add tests proving `AgentAPI.analyzeWorkflow` is total for:

```text
null
undefined
string
number
boolean
array
{}
unknown kind
missing kind
null kind
numeric kind
```

inside `workflow.steps`.

Expected:

```text
0 native errors
```

---

# 50. Required Unit Tests — F2 Containers

Add admission tests for:

```text
workflows = string
workflows = null
workflows[0] = null
workflows[0] = string
steps = string
steps = null
step = null
step = string
step = array
```

Expected:

```text
structured WorkflowIRError
```

---

# 51. Required Unit Tests — F2 References

Add admission tests for:

```text
bind -> undeclared binding
binding.producedBy -> ghost
branch ref -> ghost
```

plus equivalent unknown refs in other expression-bearing workflow steps where applicable.

Expected:

```text
structured WorkflowIRError
```

before workflow start/execution.

---

# 52. Required Restart Regression for Former Wedge

Reproduce the exact externally observed wedge shape:

```text
invalid binding/reference admitted
event matches
workflow reaches branch
status remains running forever
restart
still running
```

First prove the old shape is represented by the test.

With pt4:

```text
server admission must fail
```

There must be no workflow instance to wedge.

---

# 53. Required No-Silent-Drop Test

For:

```text
binding.producedBy -> ghost
```

the runtime previously could silently drop/ignore the invalid binding.

After pt4:

```text
admission refused
```

Forbidden:

```text
binding omitted
workflow continues
```

---

# 54. Required F1/F2 Cross-Surface Consistency

Where the same malformed semantic structure can be presented through both graph and Server IR surfaces:

```text
graph validation
AgentAPI
IR admission
```

must agree that it is invalid.

Error codes may differ by abstraction layer:

```text
WORKFLOW_INVALID_STEP
WORKFLOW_INVALID_IR
```

but no layer may silently accept what another identifies as structurally impossible.

---

# 55. Structured Error Quality

Errors should identify enough context to diagnose the problem.

Where possible include:

```text
workflow id
step id
binding id
field/path
problem code
```

Example conceptual diagnostics:

```text
workflow wf_order:
step wait_payment:
bind target "ghost" is not a declared workflow binding
```

Do not expose:

```text
SQL
filesystem paths
credentials
HMAC material
internal stack traces
```

---

# 56. Deterministic Diagnostics

The same malformed IR must produce the same semantic diagnostic regardless of:

```text
process
authority count
SQLite state
object insertion order
```

where semantically equivalent.

---

# 57. No Raw Validation Escape

Do not introduce an option such as:

```text
skipWorkflowValidation: true
unsafeWorkflowIR: true
```

as a workaround.

If internal trusted tests require bypass, keep it private and never part of application semantics/public API.

---

# 58. No NativeOperation Escape

Do not convert malformed workflow handling into NativeOperation or arbitrary host callbacks.

This remains validation infrastructure.

---

# 59. No Runtime Polling Fix

Do not "fix" wedges by periodically checking whether an invalid ref has become valid.

Workflow definition references are static semantics.

Invalid means invalid.

---

# 60. No Implicit Missing Binding Creation

Do not solve:

```text
bind -> ghost
```

by automatically creating binding `ghost`.

Bindings are declared semantic structure.

Unknown target must be rejected.

---

# 61. No Unknown Ref as Undefined

Do not evaluate:

```text
ref("ghost")
```

as:

```text
undefined
null
false
```

That would convert invalid semantics into plausible execution.

Reject it.

---

# 62. No Unknown Step Fallback

Do not map unknown step kinds to:

```text
fail
complete
no-op
```

Reject them.

---

# 63. No Malformed Container Coercion

Do not coerce:

```text
steps = "abc"
```

into iterable steps.

Do not coerce:

```text
workflows = object
```

into a one-element array.

Reject malformed IR.

---

# 64. Required Internal Test Count

Exact test count is not prescribed.

The current repository baseline after pt3 is:

```text
1444 tests
0 failures
```

pt4 must increase coverage sufficiently to include all residual external reproductions.

Final requirement:

```text
all repository tests green
```

---

# 65. Documentation

Update only documentation affected by F1/F2.

At minimum:

```text
VALIDATION.md
AGENT_REFERENCE.md
implementation report
progress/status
```

if needed.

Do not reopen F3 documentation unless compatibility code changes.

---

# 66. Validation Documentation

State clearly:

```text
malformed WorkflowDef values produce structured diagnostics

malformed workflow Server IR is rejected at admission

unknown binding/reference semantics are invalid

workflow analysis APIs are total over malformed workflow structure
```

---

# 67. Implementation Report

Add a pt4 section to:

```text
reports/AXIOM_0_14_IMPLEMENTATION_REPORT.md
```

Record:

```text
F1 residual root cause
F1 fix
F2 residual root causes
container totality fix
reference-integrity fix
tests added
regressions run
version
```

---

# 68. Required F1 Report Q&A

Answer:

```text
1. Why did validateGraph succeed in rejecting malformed steps while
   analyzeWorkflow still threw?

2. Which traversal read step.id before structural validation?

3. Is analyzeWorkflow now total over the full malformed-step corpus?

4. Does AgentAPI use the same validated workflow helpers as core?

5. Can any malformed step still produce a native TypeError?
```

---

# 69. Required F2 Report Q&A

Answer:

```text
1. Why were invalid binding references admitted?

2. Why did unknown refs become permanent running wedges?

3. Why could workflows/steps malformed container shapes reach
   workflowExpressions before structural refusal?

4. Where is container validation now performed?

5. Where is binding/reference integrity now validated?

6. Can an invalid binding target reach event execution?

7. Can an unknown branch ref reach branch execution?

8. Can a malformed workflow container produce native TypeError?

9. Is validation performed before workflow engine execution?

10. What defense-in-depth remains if corrupted state bypasses admission?
```

---

# 70. Versioning

`0.14.0-alpha.3` is already published and externally tested.

Do not overwrite it.

Recommended corrective version:

```text
0.14.0-alpha.3
```

Use coherent exact versions across all published `@cynodia/*` packages.

---

# 71. Release Gates

Before publishing alpha.3 run:

```text
npm test

release:pack
release:verify
release:consumer-test
release:probe

documentation tests
```

All must be green.

Publish the exact tested tree.

---

# 72. Focused External Retest Scope

After publishing alpha.3, run a very small external corrective retest.

Do NOT rerun the entire F3 matrix unless pt4 touched compatibility/fingerprint code.

Primary external target:

```text
F1
F2
```

---

# 73. External F1 Retest

Fresh npm consumer:

```text
@cynodia/*@0.14.0-alpha.3
```

Run malformed workflow corpus through:

```text
validateGraph
compileToServerIR
AgentAPI.validate
AgentAPI.analyzeWorkflow
```

Required:

```text
structured refusal for all malformed cases
native TypeError = 0
```

---

# 74. External F2 Retest — Container Shapes

Tamper valid Server IR into:

```text
workflows = string
workflows[0] = null
workflows[0] = string
steps = string
steps = null
step = null
step = string
step = array
```

Required:

```text
structured WorkflowIRError
native TypeError = 0
```

---

# 75. External F2 Retest — Reference Integrity

Tamper:

```text
bind -> undeclared binding
binding.producedBy -> ghost
branch expression -> ghost ref
```

and representative equivalent invalid expression refs.

Required:

```text
admission refused
```

Forbidden:

```text
workflow starts
event matches
running wedge
silent binding drop
```

---

# 76. External F3 Smoke Only

If compatibility code was untouched, external retest needs only a small smoke control:

```text
semantic workflow change -> incompatible
presentation-only change -> compatible
```

No need for another 25/25 F3 process matrix.

F3 already has external closure evidence from alpha.2.

If pt4 changes compatibility/fingerprint code, however:

```text
rerun focused F3 process matrix
```

before continuing Phase 22.

---

# 77. Focused pt4 Verdict

If all F1/F2 retests pass:

```text
Phase 22 F1 — CLOSED
Phase 22 F2 — CLOSED
Phase 22 F3 — CLOSED

spec14pt4 focused corrective retest:
PASS
```

Then:

```text
RESUME PHASE 22
```

---

# 78. Failure Rule

If any public analysis surface still produces:

```text
native TypeError
```

for the required malformed corpus:

```text
F1 remains OPEN
```

If any required tampered IR case:

```text
is admitted
executes partially
silently drops invalid semantics
permanently wedges
throws native TypeError
```

then:

```text
F2 remains OPEN
```

Do not resume the remainder of Phase 22 until both are closed.

---

# 79. Phase 22 Status After pt4

Even after successful pt4 external retest:

```text
Axiom 0.14 is NOT YET externally validated.
```

The original Phase 22 run intentionally de-scoped mandatory areas.

These still need to run.

---

# 80. Remaining Phase 22 Work

Resume the existing blind Phase 22 with the previously unexecuted sections, especially:

```text
retry durability

effect honesty

principal preservation

authorization re-evaluation

cross-principal inspection

terminal late wakeups

action reconciliation evidence retention

event recovery evidence retention

start idempotency retention

SQLite contention stress

0.12 distributed regressions

0.13 live-query regressions

required non-memory conformance/runtime coverage
```

Do not replace these with internal tests.

---

# 81. Final Freeze Gate

The Axiom 0.14 semantic model may be frozen only after completed external Phase 22 reports:

```text
Discoverability: D1
Semantic Escape: E1
Safety:          S1
```

with:

```text
Axiom 0.14 Durable Workflows
EXTERNALLY VALIDATED
```

Until then:

```text
DO NOT FREEZE
```

---

# 82. Definition of Done

spec14pt4 is complete when:

```text
1. AgentAPI.analyzeWorkflow is total over malformed WorkflowDef steps.

2. No required graph/AgentAPI malformed-step case produces native TypeError.

3. Workflow IR admission is total over malformed workflow/container shapes.

4. Invalid binding targets are rejected before execution.

5. Invalid binding producers are rejected before execution.

6. Unknown workflow expression refs are rejected before execution.

7. The former invalid-ref permanent-running wedge is impossible from admitted IR.

8. The former silent binding drop is impossible from admitted IR.

9. Tampered IR produces structured WorkflowIRError rather than native TypeError.

10. Runtime guards remain as defense-in-depth but are not the primary validator.

11. Workflow semantics remain unchanged.

12. Server IR remains axiom.server.v8.

13. Conformance remains axiom.conformance.v8.

14. Valid semantic fingerprints remain unchanged from alpha.2.

15. F3 compatibility architecture remains unchanged unless strictly necessary.

16. Action crash safety remains green.

17. Event crash safety remains green.

18. Stale-owner fencing remains green.

19. Full repository tests are green.

20. Release gates are green.

21. alpha.3 is published as a new immutable package set.

22. Fresh external F1/F2 retest passes.

23. Phase 22 then resumes from the previously de-scoped sections.
```

---

# 83. Final Instruction to the Implementing Agent

Keep this correction small.

F3 is externally closed.

Do not reopen the distributed workflow architecture.

The remaining defects are validation-totality defects:

```text
F1:
one public AgentAPI traversal assumes a valid step before proving it

F2:
IR admission does not yet prove every container and reference needed
for safe workflow execution
```

Fix those classes structurally.

The desired boundary is simple:

```text
malformed semantic input
        ↓
structured Axiom diagnostic
```

and never:

```text
malformed semantic input
        ↓
native JavaScript exception
```

or:

```text
malformed semantic input
        ↓
admitted workflow
        ↓
permanent running wedge
```

Once that boundary is true across graph validation, AgentAPI and Server IR admission, publish the corrective alpha, externally retest F1/F2, and resume the remaining blind Phase 22.