# spec14pt6 — Workflow Cancellation Authorization Closure

**Target:** `0.14.0-alpha.5`  
**Baseline:** `0.14.0-alpha.4`  
**Scope:** Narrow corrective fix for the final Phase 22 finding F4.

## Problem

`server.cancelWorkflow(instanceId, credential)` currently accepts a credential argument but does not enforce it.

Externally reproduced:

```text
principal c1 starts workflow W
principal c2 knows W.instanceId
c2 calls cancelWorkflow(W, credential_c2)
→ cancellation succeeds
```

This is a cross-principal authorization gap on a durable mutating operation.

F1, F2 and F3 are already externally closed. All previously de-scoped Phase 22 areas are green. Do not expand scope beyond cancellation authorization unless strictly required.

---

## Required invariant

A workflow cancellation must be authorized under the calling principal before any durable cancellation mutation occurs.

```text
unauthorized principal
    →
structured authorization refusal
    →
no workflow mutation
```

Never:

```text
unauthorized principal
    →
cancelled workflow
```

The supplied credential must therefore be resolved and enforced, not ignored.

---

## Authorization semantics

Do not implement cancellation as an unauthenticated operation.

Prefer existing Axiom authorization semantics rather than introducing a workflow-specific security model.

Do not hardcode:

```text
callerPrincipal == workflowStartPrincipal
```

unless that is already the canonical authorization rule.

Cancellation should use the same principal / authorization machinery used elsewhere in Axiom so that current authorization policy determines whether the caller may perform the operation.

The authorization decision must happen before the durable transition to `cancelled`.

---

## Preserve existing cancellation semantics

The fix must preserve:

```text
idempotent cancellation
fenced transitions
terminal-state immutability
crash safety
mixed-build compatibility
principal preservation
```

Authorized cancellation must behave exactly as before.

Unauthorized cancellation must not:

```text
change instanceRevision
append cancellation history
claim the workflow
wake the workflow
alter timers/events
change terminal state
```

---

## Required tests

At minimum:

### Owner / authorized principal

```text
c1 starts W
c1 cancels W
→ succeeds
→ W becomes cancelled
```

### Cross-principal refusal

```text
c1 starts W
c2 attempts cancelWorkflow(W, credential_c2)
→ structured authorization refusal
→ W remains unchanged
```

### Continue after refused cancellation

```text
c1 starts W
c2 cancellation refused
workflow continues normally
→ no corruption or stuck state
```

### Failover

Run the authorization check from a different authority than the one that started the workflow.

Required:

```text
same authorization result
principal identity preserved
no topology-dependent behavior
```

### Terminal control

Existing behavior for cancellation of already-terminal workflows must remain unchanged.

---

## Error behavior

Use the existing canonical authorization error/diagnostic mechanism.

Do not introduce a native exception or a new ad-hoc workflow security error if an established Axiom authorization refusal already exists.

Required:

```text
structured refusal
no native TypeError
no silent success
```

---

## No semantic expansion

Do not add new WorkflowDef vocabulary.

Expected unchanged:

```text
Server IR               axiom.server.v8
Conformance             axiom.conformance.v8
semantic fingerprint    unchanged
WorkflowDef             unchanged
persistence schema      unchanged unless absolutely required
```

Do not redesign authorization generally. Authorization completeness remains the subject of 0.15.

This fix only closes the concrete 0.14 cancellation hole.

---

## Regression requirements

Keep green:

```text
spec14pt2 crash safety
spec14pt3 mixed-build compatibility
spec14pt4 validation totality
spec14pt5 admission totality

retry durability
effect honesty
principal preservation / auth re-evaluation
terminal immutability
retention
SQLite contention
0.12 conformance
0.13 conformance
workflow conformance v8
```

No large new chaos matrix is required unless this fix touches workflow execution, fencing, or persistence paths beyond cancellation.

---

## External retest

Publish the coherent package set as:

```text
0.14.0-alpha.5
```

Then run a focused external F4 retest from a fresh consumer.

Required external result:

```text
authorized cancellation       PASS
cross-principal cancellation  REFUSED
workflow mutation on refusal  0
topology-dependent auth       0
```

Also run a small cancellation regression smoke for:

```text
idempotency
terminal immutability
fencing
```

If green:

```text
F1 CLOSED
F2 CLOSED
F3 CLOSED
F4 CLOSED

Phase 22 COMPLETE
D1 / E1 / S1
```

At that point `0.14 Durable Workflows` may be declared externally validated and the 0.14 semantic model can be frozen.

Then proceed to:

```text
0.15 — Authorization Completeness
```

---

## Final instruction

Keep this fix surgical.

The defect is simply:

```text
cancelWorkflow(instanceId, credential)
accepts a credential but does not enforce authorization.
```

Make cancellation an authorized durable mutation using existing Axiom authorization semantics, preserve all existing workflow guarantees, publish `0.14.0-alpha.5`, and externally close F4.