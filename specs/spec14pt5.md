# spec14pt5 — Final F2 Admission-Surface Totality Fix

**Target:** `0.14.0-alpha.4`
**Baseline:** published `0.14.0-alpha.3`
**Scope:** Extremely narrow corrective fix. Do not expand scope.

## Status entering this fix

The external `0.14.0-alpha.3` corrective retest established:

```text
Phase 22 F1 — EXTERNALLY CLOSED
Phase 22 F3 — EXTERNALLY CLOSED

Phase 22 F2 — OPEN, one narrow residual
```

All substantive F2 workflow validation failures are now fixed:

```text
invalid binding target          CLOSED
invalid producedBy              CLOSED
unknown expression ref          CLOSED
permanent running wedge         CLOSED
silent binding drop             CLOSED
malformed step handling         CLOSED
```

The only externally reproduced residual is an admission-surface totality gap in `createAxiomServer`.

---

# Problem

For hand-tampered Server IR:

```text
ir.workflows = number
```

or:

```text
ir.workflows = plain object
```

`createAxiomServer` throws a native `TypeError`.

The failure occurs before the workflow admission validator gets control, through the pre-validation path involving:

```text
createAxiomServer
    -> serverIRExpressions / understatedContract
    -> unsafe traversal of ir.workflows
    -> native TypeError
```

This is incorrect.

`createWorkflowEngine` already rejects equivalent malformed input correctly with structured workflow IR validation.

The required invariant is:

```text
malformed ir.workflows
    ->
structured WorkflowIRError / WORKFLOW_INVALID_IR
```

and never:

```text
malformed ir.workflows
    ->
native JavaScript exception
```

---

# Required Fix

Ensure `createAxiomServer` cannot semantically traverse `ir.workflows` before the workflow container shape has been validated.

The workflow admission validator must get the opportunity to reject malformed workflow IR before helpers such as:

```text
serverIRExpressions
understatedContract
workflowExpressions
```

perform assumptions or iteration over workflow structures.

Do not merely special-case the two externally observed values.

The complete container boundary should be total over arbitrary malformed values.

At minimum test:

```text
ir.workflows = null
ir.workflows = undefined
ir.workflows = string
ir.workflows = number
ir.workflows = boolean
ir.workflows = plain object
ir.workflows = array
```

Preserve the existing semantic distinction, if any, between:

```text
workflows absent
workflows = []
```

and malformed workflow data.

Do not coerce malformed values into valid ones.

For example, do NOT implement:

```text
Array.isArray(ir.workflows) ? ir.workflows : []
```

because that would silently erase malformed semantics.

Malformed present data must fail closed.

---

# Design Requirement

Prefer fixing the admission ordering/boundary rather than adding scattered guards to each failing helper.

Desired architecture:

```text
untrusted/tampered Server IR
        ↓
workflow container validation
        ↓
workflow structural/reference validation
        ↓
only then semantic traversal
        ↓
server construction
```

Helpers that can reasonably be exposed to tampered IR should still be total as defense-in-depth, but helper-level tolerance must not convert invalid IR into valid IR.

---

# Required Error Behaviour

For malformed present `ir.workflows`:

```text
createAxiomServer(...)
```

must reject with the existing structured workflow IR error mechanism:

```text
WorkflowIRError
WORKFLOW_INVALID_IR
```

or the exact canonical equivalent already used by `createWorkflowEngine`.

Prefer parity between:

```text
createWorkflowEngine
createAxiomServer
```

for the same malformed workflow IR.

Forbidden:

```text
TypeError
ReferenceError
RangeError
native iteration/property-access error
silent normalization to []
silent admission
partial server construction
workflow execution
```

---

# Required Tests

Add a focused admission-totality matrix.

For each malformed `ir.workflows` shape, run through:

```text
createWorkflowEngine
createAxiomServer
```

and verify consistent structured rejection where the value is invalid.

At minimum:

```text
number
plain object
boolean
string
null
```

plus any other malformed shapes supported by the public IR type boundary.

Explicitly reproduce the two external failures:

```text
workflows = 123
workflows = {}
```

Required:

```text
createAxiomServer native TypeError count = 0
createWorkflowEngine native TypeError count = 0

silent admission = 0
semantic execution = 0
```

---

# Pre-Admission Helper Audit

Audit every helper executed by `createAxiomServer` before workflow validation.

Especially inspect:

```text
serverIRExpressions
understatedContract
workflowExpressions
semantic/fingerprint helpers invoked during server construction
```

Ask:

```text
Can malformed ir.workflows reach this function before admission validation?

If yes, can this function throw a native exception because it assumes
workflows is an array?
```

Either:

1. reorder validation so malformed IR cannot reach it, or
2. make the helper total as defense-in-depth,

preferably both where inexpensive.

Do not broaden this into unrelated validation refactoring.

---

# Preserve Existing Fixes

Do not regress the alpha.3 closures.

Keep green:

```text
AgentAPI.analyzeWorkflow malformed-input totality

invalid binding target rejection

invalid producedBy rejection

unknown expression reference rejection

nondeterministic workflow expression rejection

former permanent-running-wedge regression

former silent-binding-drop regression

tampered workflow/step container validation
```

---

# F1

F1 is externally closed.

Do not modify AgentAPI unless required by this fix.

A normal regression smoke is sufficient.

---

# F3

F3 is externally closed.

Do not modify:

```text
EXECUTABLE_KINDS
SERVER_IR_EXECUTABLE_SLICES
canonicalWorkflowForFingerprint
AuthorityCompatibilityKey
mixed-build compatibility semantics
```

No new mixed-build architecture work is required.

If compatibility/fingerprint code remains untouched, only existing regression tests need to stay green.

---

# Semantic Contract

This fix MUST NOT change valid Axiom semantics.

Expected:

```text
Server IR = axiom.server.v8
Conformance = axiom.conformance.v8
SEMANTIC_FINGERPRINT_VERSION unchanged
```

For valid graphs:

```text
semanticFingerprint(alpha.4)
==
semanticFingerprint(alpha.3)
```

No WorkflowDef vocabulary changes.

No migration.

No persistence format change.

---

# Regression Gates

Run the normal repository suite.

Also ensure existing:

```text
spec14pt2 crash safety
spec14pt3 mixed-build compatibility
spec14pt4 validation totality
workflow conformance v8
```

remain green.

There is no need to rerun large real-process matrices internally unless this narrow fix unexpectedly touches distributed execution or compatibility code.

---

# Version and Publish

Do not modify published `0.14.0-alpha.3`.

Version the coherent package set as:

```text
0.14.0-alpha.4
```

Run:

```text
npm test
release:pack
release:verify
release:probe
release:consumer-test
```

All must be green.

Publish the exact tested package set.

---

# External Retest

After publishing `0.14.0-alpha.4`, perform a minimal fresh-consumer external F2 retest.

The essential reproduction is:

```text
valid Server IR
    ↓
tamper ir.workflows = 123
    ↓
createAxiomServer
```

and:

```text
valid Server IR
    ↓
tamper ir.workflows = {}
    ↓
createAxiomServer
```

Expected for both:

```text
structured WorkflowIRError / WORKFLOW_INVALID_IR
native TypeError = 0
```

Also run the surrounding malformed-container matrix to ensure the fix is structural rather than two-value special-casing.

No full F1 retest is required if AgentAPI code is untouched.

No full F3 retest is required if compatibility/fingerprint code is untouched.

---

# Success Criterion

This corrective pass is complete when external evidence establishes:

```text
Phase 22 F1 — CLOSED
Phase 22 F2 — CLOSED
Phase 22 F3 — CLOSED
```

with specifically:

```text
createAxiomServer malformed-workflows native TypeError = 0
silent malformed-workflow admission = 0
```

At that point:

```text
spec14pt5 corrective retest: PASS
```

and the agent should immediately:

```text
RESUME THE ORIGINAL PHASE 22 TEST SPECIFICATION
```

from the previously de-scoped/not-run sections, against the latest published package set.

Do not start Phase 22 from scratch.

Do not freeze 0.14 yet.

The final freeze still requires completion of the remaining Phase 22 suite and:

```text
D1 / E1 / S1
```

---

# Final Instruction

Keep this fix surgical.

The remaining defect is not a workflow semantic problem, distributed-authority problem, or compatibility problem.

It is:

```text
createAxiomServer performs semantic inspection of malformed ir.workflows
before the workflow admission boundary has established that ir.workflows
has a valid container shape.
```

Fix that boundary.

Do not hide malformed input.

Do not coerce it.

Do not redesign workflows.

Make:

```text
createAxiomServer
```

as total over malformed workflow IR as:

```text
createWorkflowEngine
```

already is.

Then publish `0.14.0-alpha.4`, externally reproduce the exact two failures, verify structured refusal, and resume Phase 22.
