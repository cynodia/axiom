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
| 7 | ActionDef step — stable invocation id + `pendingAction` marker + durable `recordActionOutcome` reconciliation. Full-restart window before the outcome is recorded → follow-up durable idempotency store. | ◑ |
| 8 | Timer step — target captured once; the waiting row is the timer. | ✅ |
| 9 | wait-event — Model B registration with the transition; `sinceEventSeq` boundary; startup replay; dedup unchanged; fanout. | ✅ |
| 10 | branch / complete / fail — pure deterministic transitions. | ✅ |
| 11 | Retry — durable `attempt` + `nextEligibleAt` backoff, not-due guard. | ✅ |
| 12 | Cancellation — fenced durable transition, linearized on `instanceRevision`, not rollback. | ✅ |
| 13 | `AgentAPI.analyzeWorkflow`; `server.getWorkflow` / `inspectWorkflows` / `workflowHistory`. | ✅ |
| 14 | `axiom.conformance.v8` — 13 fixtures + manifest + public runner + 2 negative controls. | ✅ |
| 15 | in-process fencing/CAS + SQLite conflicting-transition race covered; real-OS-process 1/2/8 matrix at §258 counts deferred + named. | ◑ |
| 16 | 0.12 / 0.12.1 / 0.13.1 suites re-run green (575 server incl. cross-process). | ✅ |
| 17 | `docs/WORKFLOWS.md`, AGENT_REFERENCE §DURABLE WORKFLOWS, AUTHORITY v8 row, VALIDATION, anti-patterns #72–#77, doc-map rows, CLAUDE.md, version bump. `release:pack`/`verify`/`consumer`/`probe` green. | ✅ |
| 18 | Publish alpha. | ⏳ |
| 19 | Blind Phase 22 (`D1 / E1 / S1`). | ⏳ **post-publish** |

## Release classification target (spec14): B — LIVE CANONICAL QUERIES lineage / Durable Workflows
