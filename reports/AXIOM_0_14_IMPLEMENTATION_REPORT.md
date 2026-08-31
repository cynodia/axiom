# Axiom 0.14 — Durable Workflows: implementation report

Release: `0.14.0-alpha.1`. Branch: `spec14-durable-workflows`. Baseline: `0.13.1-alpha.1`.
Design note: `AXIOM_0_14_WORKFLOW_RESEARCH.md`. Full model: `docs/WORKFLOWS.md`.

**Classification target: Durable Workflows.** A `WorkflowDef` is a first-class graph node —
a long-running semantic computation with a durable control position. The graph owns
orchestration meaning; the runtime owns scheduling, persistence, retries, per-instance
leases, fencing, crash recovery and physical execution. No application script body, no
mutable workflow blob, no application-owned state machine.

Test totals: **1412** across the repo, all green at `0.14.0-alpha.1` (server 575 incl.
`workflow-engine` (9), `workflow-store` (memory + SQLite parity + concurrent-transition
race, 3), `workflows-server` (5), `workflow-conformance` (13 fixtures + suite + 2 negative
controls); agent-api 93 incl. `analyzeWorkflow` + workflow validation (6); core 275 incl.
the `WORKFLOW_*` validation codes). `npm run build`, `npm test`, `release:pack` / `verify` /
`consumer-test` / `probe` and the documentation tests pass.

## What shipped (spec14 §249 phases)

| Phase | State | Notes |
| --- | --- | --- |
| 1 semantic research | ✅ | `AXIOM_0_14_WORKFLOW_RESEARCH.md` — all Phase-1 gates. |
| 2 portable core model | ✅ | `core/workflows.ts`, `validateWorkflow` (15 codes), `'workflow'` in `SEMANTIC_NODE_KINDS` + `EXECUTABLE_KINDS`. |
| 3 Server IR v8 | ✅ | `SERVER_IR_CONTRACTS` += `axiom.server.v8`; `usesWorkflowVocabulary`; compiler serializes `workflows`; `server-ir.v8.schema.json`. v1–v7 frozen. |
| 4 memory WorkflowStore | ✅ | `createMemoryWorkflowStore` — full logical semantics. |
| 5 SQLite WorkflowStore | ✅ | `createSqliteWorkflowStore` — `BEGIN IMMEDIATE`, revision + fence check **inside** the transaction, `busy_timeout`, `INSERT OR IGNORE` init. Parity + conflicting-transition race tested. |
| 6 ownership / recovery | ✅ | reused 0.12 `CoordinationProvider` lease+fence; `recoverRunnable` poll loop; incompatible-build refusal. |
| 7 ActionDef step | ◑ | stable logical invocation identity `<instanceId>/<activationId>`; `pendingAction` marker + durable `recordActionOutcome` reconciliation; the in-window idempotency collapses a fast reclaim. A fully durable server-side idempotency store (closing the full-restart window) is the follow-up. |
| 8 timer step | ✅ | target captured once; the waiting row *is* the timer; recovery from the store. |
| 9 wait-event | ✅ | Model B — registration committed with the transition; `sinceEventSeq` boundary; startup replay from a bounded journal; dedup unchanged; fanout. |
| 10 branch / complete / fail | ✅ | pure deterministic transitions. |
| 11 retry | ✅ | durable `attempt` + `nextEligibleAt` backoff; not-due guard on `advance`. |
| 12 cancellation | ✅ | fenced durable transition to `cancelled`; not rollback; terminal instances never resurrected; cancel-vs-transition linearized on `instanceRevision`. |
| 13 AgentAPI / inspection | ✅ | `AgentAPI.analyzeWorkflow`; `server.getWorkflow` / `inspectWorkflows` / `workflowHistory`. |
| 14 conformance v8 | ✅ | `axiom.conformance.v8` — `workflow-conformance.ts`, `scripts/workflow-conformance.mjs` (13 fixtures + manifest), public runner, 2 negative controls. |
| 15 topology / crash suite | ⏳ | in-process fencing/CAS + concurrent-transition race are covered; the real-OS-process 1/2/8 chaos matrix at §258 trial counts is deferred and named. |
| 16 historical regression | ✅ | 0.12 / 0.12.1 / 0.13.1 suites (575 server, incl. live-query and distributed-authority cross-process) re-run green. |
| 17 docs / release prep | ✅ | `docs/WORKFLOWS.md`, `AGENT_REFERENCE` §DURABLE WORKFLOWS, `AUTHORITY.md` v8 row, `VALIDATION.md`, anti-patterns #72–#77, README + facade doc-map rows, `CLAUDE.md` entry. Version bump across every manifest / doc line / `llms.txt` / `graph.ts` / `package-lock.json`. |
| 18 publish alpha | ⏳ | post this session. |
| 19 blind Phase 22 | ⏳ | post-publish. |

## Answers to §251 (model)

**WorkflowDef shape** — `kind: 'workflow'`, `inputs?`, `bindings?` (single-assignment,
`producedBy` a step), `entry`, `steps: WorkflowStep[]` (six kinds). **Step vocabulary** —
`action` / `wait-event` / `timer` / `branch` / `complete` / `fail` (`WORKFLOW_STEP_TYPES`).
**Expression scope** — `ref(<input>)`, `ref(<binding>)`, `ref('EVENT')` (wait-event only),
`ref('PRINCIPAL')`; enforced by `validateWorkflow` (`WORKFLOW_EXPRESSION_SCOPE`) and a
runtime guard; no `StateDef`, no `QueryDef`, no `now`/`uuid`/`random`
(`WORKFLOW_NONDETERMINISTIC`). **Binding model** — declared on the `WorkflowDef`, assigned
once by a `wait-event` step's `bind`, read-only elsewhere; single-assignment and
producer-before-reader enforced. **Logical transition identity** — `instanceRevision`
monotone + coordination `fence`, every transition a fenced CAS. **`activationId`** =
`"<stepId>#0"`, distinct from `stepId` for a future loop feature. **Server IR** — v8, no
JavaScript accidents (portable plain data, `Expression` trees). **`semanticFingerprint`** —
unchanged for graphs without a workflow; changes for graphs that contain workflow semantics
(§115, §208). **Conformance** — new `axiom.conformance.v8` tier.

## Answers to §252 (action)

Invocation identity `"<instanceId>/<activationId>"`, reused across retries and reclaims. A
`pendingAction` durable marker is written (fenced CAS) before the invoke; the outcome is
recorded durably (`recordActionOutcome`); on reclaim a recorded outcome short-circuits the
re-invoke. The `ActionDef` is invoked with the invocation id as its request id, so the
authority's in-window idempotency collapses a fast reclaim. Terminal failure follows
`onError` or fails the workflow; a retryable failure schedules a durable backoff. Effect
identity composition rides the existing effect system's logical effect id, which is derived
from the action invocation — a workflow retry does not fork one logical payment into two.

## Answers to §253 (event)

The wait registration (`eventId`, correlation, `sinceEventSeq`, `activationId`) is written
in the **same** `WorkflowStore` transition that enters the `wait-event` step (Model B — no
"waiting then subscribe" gap). Matching is driven by Axiom's single inbound event pipeline
(`fireEvent` → `onEventAccepted`), never a second bus. `sinceEventSeq` is the durable
observation boundary; on startup / failover a match that landed during a crash window is
replayed from a bounded in-authority journal (a fully durable event journal is the natural
extension). Existing external-event dedup collapses a redelivery before it reaches the
router, so a wait transitions at most once. Fanout: a match unblocks every
independently-matching waiting instance; a wait never globally consumes an event. Event vs
timeout linearize on `instanceRevision` — exactly one wins.

## Answers to §254 (timer)

`workflowTimerId = "<instanceId>/<activationId>"`. On activation the target instant is
computed once (`activationInstant + after.seconds`, or resolved `at`) and stored in the
transition record and `nextEligibleAt`; a restart does not recompute `now + after`. The
scheduler firing is physically at-least-once (the poll loop claims by fence); the transition
it causes is logically exactly-once. A physically-late firing is still valid. Recovery: the
waiting row *is* the timer.

## Answers to §255 (distribution)

Leaderless — any compatible authority advances any eligible instance under a per-instance
`CoordinationProvider` lease (no second lease system, spec14 §92). Every durable mutation
under ownership is a fenced conditional write; a resumed stale owner is refused
(`fence < record.fence`). The SQLite store's conflicting-transition race test proves exactly
one commit from a given revision. `recoverRunnable` gives bounded, indexed discovery. Schema
init is concurrent-startup-safe. Topology transparency: the logical workflow result is
identical at 1 or N authorities for identical committed semantic history.

## Answers to §256 (cancellation)

`server.cancelWorkflow(instanceId)` — idempotent, a fenced durable transition to
`cancelled`. It is **not** rollback: committed actions and dispatched effects stand; there
is no automatic compensation. A later timer / event delivery for a terminal instance does
not transition it (the router's terminal check). Cancel-vs-transition races linearize on
`instanceRevision` — whichever fenced CAS commits first wins.

## Answers to §257 (security)

Instance access, cross-principal access and idempotency-key scoping are keyed by
`principalFingerprint`; a start identity mixes the principal fingerprint so two callers
reusing a textual key under different principals never collide. The bound principal is a
canonical record, not raw credentials. Every workflow action step runs as the bound
principal and re-evaluates current authorization — a durable workflow cannot bypass
authorization or silently escalate. Error data exposed to workflow logic is structured (no
host stack frames, no provider raw exception objects). Inspection exposes no HMAC secrets,
database paths, raw SQL or credentials.

## Deferred, honestly (spec14 §10, §258, §153-§155)

- The real-OS-process 1/2/8 chaos matrix at the §258 trial counts (25–50 each) — the
  in-process fencing/CAS/race coverage + the SQLite conflicting-transition race stand in for
  now; the OS-process matrix is the deep end.
- A narrative reference-application harness (`order_fulfillment` / `trial_expiry` /
  `provision_service`) beyond the conformance fixtures.
- A fully durable server-side idempotency store closing the action-double-execution window
  across a full process restart before the per-activation outcome is recorded.
- Every §10 deferred step kind and `wait-query`.

## Blind Phase 22

Pending — requires the published `0.14.0-alpha.1` packages. Required verdict `D1 / E1 / S1`.
`release:probe` confirms a cold agent is routed to `docs/AGENT_REFERENCE.md` and
`docs/WORKFLOWS.md` from the tarball alone.
