# Axiom 0.14 — Durable Workflows progress

Working notes. Superseded by `AXIOM_0_14_IMPLEMENTATION_REPORT.md`. Branch:
`spec14-durable-workflows`. Baseline: `0.13.1-alpha.1`.

Design gates resolved in `AXIOM_0_14_WORKFLOW_RESEARCH.md` (spec14 §249 Phase 1).

**Frozen decisions:** new graph node kind `workflow`; six portable step kinds (`action`,
`wait-event`, `timer`, `branch`, `complete`, `fail`); no application script body; no mutable
workflow blob (typed single-assignment bindings); closed workflow expression scope (inputs /
bindings / `EVENT` / `PRINCIPAL`, never `StateDef` / `QueryDef` / nondeterministic builtins);
`instanceRevision` + coordination `fence` CAS for every transition; Model B no-gap event wait
(registration committed in the same transition); Server IR `axiom.server.v8` (v1..v7 frozen);
`axiom.conformance.v8`; `semanticFingerprint` unchanged for graphs with no workflow (no
version bump). Reuse 0.12 `CoordinationProvider` for the per-instance lease/fence — no second
lease system.

## Phase status (spec14 §249)

| # | Phase | State |
| - | ----- | ----- |
| 1 | Semantic research — `AXIOM_0_14_WORKFLOW_RESEARCH.md` (WorkflowDef shape, step vocabulary, expression scope, binding model, logical transition identity, ActionDef invocation identity, event observation boundary, timer identity, retry semantics, cancellation race semantics). | ✅ |
| 2 | Portable core model — `packages/core/src/workflows.ts`: `WorkflowDef` + `WorkflowStep` union + `WorkflowInput` / `WorkflowBinding` / `WorkflowDuration` / `WorkflowRetryPolicy`; accessors (`workflowStepById`, `workflowStepSuccessors`, `workflowStepExpressions`, `workflowActionIds`, `workflowEventIds`, `workflowReachableSteps`, `workflowHasCycle`). `validateGraph` gains `validateWorkflow` — the §121 checks (entry / step ids / edges / cycle / action & event refs / binding decls & single-assignment / retry policy / timer / reachability / terminal reachability / expression scope / nondeterminism) with 15 `WORKFLOW_*` diagnostic codes. `'workflow'` joins `SEMANTIC_NODE_KINDS` and `EXECUTABLE_KINDS` (semantic projection) — a graph with no workflow keeps its fingerprint byte-for-byte. `docs/VALIDATION.md` updated. | ✅ |
| 3 | Server IR v8 — done. `server-ir.v8.schema.json` shipped; `docs/AUTHORITY.md` v8 row. | ✅ |
| 4 | `WorkflowStore` contract + `createMemoryWorkflowStore`. | ✅ |
| 5 | `createSqliteWorkflowStore` — CAS inside `BEGIN IMMEDIATE`, indexed discovery, `INSERT OR IGNORE` init; parity + conflicting-transition race tested. | ✅ |
| 6 | Ownership / recovery — reused 0.12 lease+fence; `recoverRunnable` poll loop; incompatible-build refusal. | ✅ |
| 7 | ActionDef step — stable invocation id + `pendingAction` marker + durable `recordActionOutcome` reconciliation. **spec14pt2 F1**: durable idempotency record committed atomically with the ActionDef state closes the full-restart window. | ✅ |
| 8 | Timer step — target captured once; the waiting row is the timer. | ✅ |
| 9 | wait-event — Model B registration with the transition; `sinceEventSeq` boundary; startup replay; dedup unchanged; fanout. **spec14pt2 F2**: replay from a durable cross-authority `WorkflowStore` event journal. | ✅ |
| 10 | branch / complete / fail — pure deterministic transitions. | ✅ |
| 11 | Retry — durable `attempt` + `nextEligibleAt` backoff, not-due guard. | ✅ |
| 12 | Cancellation — fenced durable transition, linearized on `instanceRevision`, not rollback. | ✅ |
| 13 | `AgentAPI.analyzeWorkflow`; `server.getWorkflow` / `inspectWorkflows` / `workflowHistory`. **spec14pt4 F1**: `analyzeWorkflow` is total over malformed steps (structured `Error`, never `TypeError`). | ✅ |
| 14 | `axiom.conformance.v8` — 13 fixtures + manifest + public runner + 2 negative controls. | ✅ |
| 15 | in-process fencing/CAS + SQLite conflicting-transition race, **plus** the spec14pt2 real-OS-process `workflow-crash-matrix` (F1 SIGKILL ×50, F2 A ×50, F2 B race ×50, F2 C replay, 2-/8-authority claim races, SIGSTOP stale owner). | ✅ |
| 16 | 0.12 / 0.12.1 / 0.13.1 suites re-run green (584 server incl. cross-process + the new crash matrix). | ✅ |
| 17 | `docs/WORKFLOWS.md`, AGENT_REFERENCE §DURABLE WORKFLOWS, AUTHORITY / DISTRIBUTED_AUTHORITY compatibility, VALIDATION (+ spec14pt4 totality), anti-patterns #72–#80, doc-map rows, CLAUDE.md, version bump to `0.14.0-alpha.3`. `release:pack`/`verify`/`consumer`/`probe` green. | ✅ |
| 18 | Publish `0.14.0-alpha.3`. | ⏳ |
| 19 | Blind Phase 22 — focused F1/F2 external rerun (F3 externally closed at alpha.2), then §125 mandatory areas; freeze only on `D1 / E1 / S1`. | ⏳ **post-publish** |
| — | **spec14pt2** F1/F2 crash-safety closure (`0.14.0-alpha.1`) — durable action idempotency + durable event journal. | ✅ |
| — | **spec14pt3** F3 mixed-build compatibility closure (`0.14.0-alpha.2`) — `WorkflowDef` in the authority `semanticFingerprint`. | ✅ |
| — | **spec14pt4** F1/F2 residual closure (`0.14.0-alpha.3`) — `analyzeWorkflow` + IR-admission totality over malformed / referentially-broken workflow input. | ✅ |

## Release classification target (spec14): B — LIVE CANONICAL QUERIES lineage / Durable Workflows
