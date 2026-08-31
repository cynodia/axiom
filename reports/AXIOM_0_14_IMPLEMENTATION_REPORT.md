# Axiom 0.14 — Durable Workflows: implementation report

Release: `0.14.0-alpha.1`. Branch: `spec14-durable-workflows`. Baseline: `0.13.1-alpha.1`.
Design note: `AXIOM_0_14_WORKFLOW_RESEARCH.md`. Full model: `docs/WORKFLOWS.md`.
Pre-publish corrective pass: `specs/spec14pt2.md` (F1 / F2 crash-safety closure) — **CLOSED**,
see §"spec14pt2 closure" below.

**Classification target: Durable Workflows.** A `WorkflowDef` is a first-class graph node —
a long-running semantic computation with a durable control position. The graph owns
orchestration meaning; the runtime owns scheduling, persistence, retries, per-instance
leases, fencing, crash recovery and physical execution. No application script body, no
mutable workflow blob, no application-owned state machine.

Test totals: **1421** across the repo, all green at `0.14.0-alpha.1` (server 584 incl.
`workflow-engine` (9), `workflow-store` (memory + SQLite parity incl. the F2 durable-journal
contract + concurrent-transition race, 3), `workflows-server` (5), `workflow-conformance`
(13 fixtures + suite + 2 negative controls), **`workflow-crash-matrix` (7 real-OS-process
scenarios — spec14pt2)**, `persistence` (+2 F1 idempotency-record cases); agent-api 93 incl.
`analyzeWorkflow` + workflow validation (6); core 275 incl. the `WORKFLOW_*` validation
codes). `npm run build`, `npm test`, `release:pack` / `verify` / `consumer-test` / `probe`
and the documentation tests pass.

The `workflow-crash-matrix` suite spawns real independent OS processes over shared SQLite
files and SIGKILL/SIGSTOPs them at the narrowest crash boundaries; `AXIOM_WF_TRIALS` sets
the trial count (default 50 — the spec14pt2 release-gate figure; the F1 and F2-Case-A runs
each take ~65 s at 50).

## What shipped (spec14 §249 phases)

| Phase | State | Notes |
| --- | --- | --- |
| 1 semantic research | ✅ | `AXIOM_0_14_WORKFLOW_RESEARCH.md` — all Phase-1 gates. |
| 2 portable core model | ✅ | `core/workflows.ts`, `validateWorkflow` (15 codes), `'workflow'` in `SEMANTIC_NODE_KINDS` + `EXECUTABLE_KINDS`. |
| 3 Server IR v8 | ✅ | `SERVER_IR_CONTRACTS` += `axiom.server.v8`; `usesWorkflowVocabulary`; compiler serializes `workflows`; `server-ir.v8.schema.json`. v1–v7 frozen. |
| 4 memory WorkflowStore | ✅ | `createMemoryWorkflowStore` — full logical semantics. |
| 5 SQLite WorkflowStore | ✅ | `createSqliteWorkflowStore` — `BEGIN IMMEDIATE`, revision + fence check **inside** the transaction, `busy_timeout`, `INSERT OR IGNORE` init. Parity + conflicting-transition race tested. |
| 6 ownership / recovery | ✅ | reused 0.12 `CoordinationProvider` lease+fence; `recoverRunnable` poll loop; incompatible-build refusal. |
| 7 ActionDef step | ✅ | stable logical invocation identity `<instanceId>/<activationId>`; `pendingAction` marker + durable `recordActionOutcome` reconciliation; **spec14pt2 F1** — the authority now commits a durable idempotency record atomically with the ActionDef's state, so a full process restart is reconciled without a second logical invocation. |
| 8 timer step | ✅ | target captured once; the waiting row *is* the timer; recovery from the store. |
| 9 wait-event | ✅ | Model B — registration committed with the transition; `sinceEventSeq` boundary; **spec14pt2 F2** — replay now from a **durable cross-authority** `WorkflowStore` journal (not a process-local one), so a match survives the routing authority's death; dedup unchanged; fanout. |
| 10 branch / complete / fail | ✅ | pure deterministic transitions. |
| 11 retry | ✅ | durable `attempt` + `nextEligibleAt` backoff; not-due guard on `advance`. |
| 12 cancellation | ✅ | fenced durable transition to `cancelled`; not rollback; terminal instances never resurrected; cancel-vs-transition linearized on `instanceRevision`. |
| 13 AgentAPI / inspection | ✅ | `AgentAPI.analyzeWorkflow`; `server.getWorkflow` / `inspectWorkflows` / `workflowHistory`. |
| 14 conformance v8 | ✅ | `axiom.conformance.v8` — `workflow-conformance.ts`, `scripts/workflow-conformance.mjs` (13 fixtures + manifest), public runner, 2 negative controls. |
| 15 topology / crash suite | ✅ | in-process fencing/CAS + concurrent-transition race, **plus** the spec14pt2 real-OS-process `workflow-crash-matrix`: F1 SIGKILL ×50, F2 Case A SIGKILL ×50, Case B wait-vs-event race ×50 (deterministic before/after classification, no lost event), Case C duplicate + across-restart replay, 2- & 8-authority claim races (exactly one logical transition), SIGSTOP stale-owner (fenced write refused, zero stale commits). |
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

## Deferred, honestly (spec14 §10, §153-§155)

- A narrative reference-application harness (`order_fulfillment` / `trial_expiry` /
  `provision_service`) beyond the conformance fixtures and the crash matrix.
- Every §10 deferred step kind and `wait-query`.
- The durable event journal and idempotency table are **bounded** buffers (default 8192 /
  authority idempotency-window). They cover crash and failover windows, not unbounded
  history; retention past that is implementation-owned.

## spec14pt2 closure

The `specs/spec14pt2.md` corrective pass is **CLOSED**. Both gaps are shipped, not deferred.

### §4 preserved model

No change to `WorkflowDef`, the six step kinds, single-assignment bindings, the closed
expression scope, acyclicity, `instanceRevision` + fence CAS, leaderless ownership, or
"cancellation is not rollback". **Server IR stays `axiom.server.v8`; conformance stays
`axiom.conformance.v8`** (no new vocabulary; the conformance runner simply drops the unused
explicit event `seq` it used to pass — the memory `WorkflowStore` now allocates it). No
loops / parallel / race / child workflows / compensation / sagas / `wait-query` were added.

### F1 — durable ActionDef invocation reconciliation

| Question (spec14pt2 §6) | Answer |
| --- | --- |
| Where is the ActionDef logical invocation outcome stored durably? | In the persistence adapter, in the **same transaction** as the ActionDef's `StateDef` writes. `PersistenceCommit.idempotency = { key, response, window }`; `createMemoryPersistence` and `createSqlitePersistence` (`axiom_state_idempotency` table: `seq AUTOINCREMENT`, `key UNIQUE`, `response`, `at`) both implement `loadIdempotentResponse` / `recordIdempotentResponse`. |
| What key identifies it? | The authority's principal-scoped request identity `recordKey(principal, "<instanceId>/<activationId>")` — the workflow engine passes the stable logical invocation id as the request id, so it is identical on every authority and every retry/reclaim. |
| Is it visible after full process restart? | Yes — it is a committed SQLite row. `invokeCore` consults `loadIdempotentResponse(replayKey)` after `ensureStateCoherent()` and before any execution; a fresh process with an empty in-memory `replies` map returns the canonical response and does not run the action body. |
| Is it shared across authorities? | Yes — one shared database file; any compatible authority reads the same row. |
| What exact crash boundary was tested? | `workflow-crash-matrix.test.ts` wraps the `WorkflowStore` in the worker so the authority SIGKILLs itself the instant the engine calls `recordActionOutcome` — i.e. **after** `invokeAction` returned (ActionDef state + idempotency record committed atomically) and **before** the `step-succeeded` transition. A *fresh* authority then recovers. Also covered: the recovery authority is spawned only after the first is confirmed dead (complete restart, no process-local state). |
| How many real-process trials? | 50 by default (`AXIOM_WF_TRIALS`), run and green; smaller counts run in CI. |
| Can a second logical ActionDef invocation occur after a committed first invocation? | **No.** Across all 50 trials `S_COUNT` (a `StateDef` the action increments by exactly 1) is `1`, and the durable history carries exactly one `step-succeeded` and one `completed`. Physical effect *attempts* remain governed by the existing at-least-once effect system; the logical ActionDef invocation and each step transition are exactly-once. |

### F2 — durable event no-gap recovery across authority death

| Question (spec14pt2 §6) | Answer |
| --- | --- |
| Where is accepted-event replay evidence stored? | In a durable `WorkflowStore` journal: `axiom_workflow_event_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id, payload, at)` (memory reference mirrors it). `appendAcceptedEvent(eventId, payload)` inserts and returns the store-global `seq`; the engine journals every accepted event **before** routing it. |
| Does it survive process death? | Yes — a committed row. The append is `BEGIN IMMEDIATE` + insert + bounded trim + `COMMIT`. |
| Can a different authority retrieve it? | Yes — `readAcceptedEventsSince(eventId, sinceSeq, limit)` and `pendingEventWaits(limit)` are read by every authority's poll loop and startup path. |
| How is `sinceEventSeq` used? | Captured at `wait-event` registration from `latestAcceptedEventSeq()` (the `sqlite_sequence` high-water mark — monotone even after trimming) and stored in the durable wait. Replay reads strictly `> sinceEventSeq`. |
| How is event-before-wait distinguished from event-after-wait? | By `seq` vs `sinceEventSeq`. An event whose `seq <= sinceEventSeq` committed before the wait was live and is deterministically **not** matched (it is in the past). An event with `seq > sinceEventSeq` — whether it landed during the registration gap or after — is matched exactly once, by the live router or by the rescan the registration itself triggers, linearized on `instanceRevision`. |
| How is event dedup preserved during replay? | External-event dedup is unchanged and runs upstream of `onEventAccepted`, so each logical event is journalled once. Replaying a journalled event any number of times transitions a still-`waiting` instance once (the fenced CAS on `expectedRevision`) and is a no-op against a terminal/moved instance. |
| What exact SIGKILL boundary was tested? | `workflow-crash-matrix.test.ts` Case A wraps `WorkflowStore.transition` so the routing authority SIGKILLs itself the instant it goes to commit the `event-matched` transition — i.e. **after** the event is durably journalled, **before** the workflow moves. A fresh authority recovers it from the shared journal with no client resend, no manual replay, no polling, no sticky routing, no `StateDef` sync pulse. |
| How many no-gap race trials? | Case B (wait-activation vs matching-event commit) runs 50 real-process trials; every trial is classified deterministically as before- or after-activation with `before + after == trials` and no lost event. Case C proves duplicate + across-restart replay yields one logical transition. |

### §3 targeted real-process distribution

`workflow-crash-matrix.test.ts` also runs: **2** and **8** authorities racing to claim and
advance one runnable workflow → exactly one logical `step-succeeded` / `completed` and
`S_COUNT == 1`; and a **SIGSTOP** stale-owner race — authority A takes the per-instance
coordination lease, is frozen, its lease lapses, authority B advances the instance under a
fresh generation, A thaws and its scheduled fenced transition is **refused** (`fenced` /
`terminal` / `revision`) — zero stale successful commits. The workflow engine now also
honours the configured coordination `leaseDurationMs` (previously a fixed 15 s).

## Blind Phase 22

Pending — requires the published `0.14.0-alpha.1` packages. Required verdict `D1 / E1 / S1`.
`release:probe` confirms a cold agent is routed to `docs/AGENT_REFERENCE.md` and
`docs/WORKFLOWS.md` from the tarball alone.
