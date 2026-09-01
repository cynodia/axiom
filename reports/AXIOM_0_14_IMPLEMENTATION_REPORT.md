# Axiom 0.14 — Durable Workflows: implementation report

Release: `0.14.0-alpha.4`. Branch: `spec14-durable-workflows`. Baseline: `0.13.1-alpha.1`.
Design note: `AXIOM_0_14_WORKFLOW_RESEARCH.md`. Full model: `docs/WORKFLOWS.md`.
Pre-publish corrective pass: `specs/spec14pt2.md` (F1 / F2 crash-safety closure) — **CLOSED**,
see §"spec14pt2 closure" below.

**Classification target: Durable Workflows.** A `WorkflowDef` is a first-class graph node —
a long-running semantic computation with a durable control position. The graph owns
orchestration meaning; the runtime owns scheduling, persistence, retries, per-instance
leases, fencing, crash recovery and physical execution. No application script body, no
mutable workflow blob, no application-owned state machine.

Test totals: **1455** across the repo, all green at `0.14.0-alpha.4` (server 609 incl.
`workflow-engine` (9), `workflow-store` (memory + SQLite parity incl. the F2 durable-journal
contract + concurrent-transition race, 3), `workflows-server` (5), `workflow-conformance`
(13 fixtures + suite + 2 negative controls), **`workflow-crash-matrix` (7 real-OS-process
scenarios — spec14pt2)**, **`workflow-compat` (10 — spec14pt3 F3/F1/F2 in-process)**,
**`workflow-mixed-build` (6 real-OS-process — spec14pt3 F3)**, **`workflow-ir-totality` (8 —
spec14pt4 F2 + spec14pt5 admission-surface)**, `persistence` (+2 F1 idempotency-record
cases); agent-api 98 incl.
`analyzeWorkflow` + workflow validation (6) + the spec14pt3/pt4 malformed-step matrix; core
279 incl. the `WORKFLOW_*` validation codes + workflow semantic-identity). `npm run build`,
`npm test`, `release:pack` / `verify` / `consumer-test` / `probe` and the documentation
tests pass.

Real-OS-process suites spawn independent processes over shared SQLite files.
`workflow-crash-matrix` SIGKILL/SIGSTOPs at the narrowest crash boundaries (`AXIOM_WF_TRIALS`,
default 50); `workflow-mixed-build` runs semantically divergent builds against one shared
store (`AXIOM_WF_MIXED_TRIALS`, default 25 — the spec14pt3 §120 figure; each of the three
semantic-variant refusal tests takes ~57 s at 25).

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
| 17 docs / release prep | ✅ | `docs/WORKFLOWS.md`, `AGENT_REFERENCE` §DURABLE WORKFLOWS, `AUTHORITY.md` / `DISTRIBUTED_AUTHORITY.md` compatibility sections, `VALIDATION.md`, anti-patterns #72–#80, README + facade doc-map rows, `CLAUDE.md` entries. Version bump to `0.14.0-alpha.4` across every manifest / doc line / `llms.txt` / `package-lock.json`. |
| 18 publish `0.14.0-alpha.4` | ⏳ | post this session — `release:pack` / `verify` / `consumer-test` / `probe` are the gate (§143). |
| 19 blind Phase 22 | ⏳ | focused F3 external rerun first (§119, §120), then resume §125 mandatory areas; freeze only on `D1 / E1 / S1`. |

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

## spec14pt3 closure — Phase 22 F3 (release blocker) + F1 / F2 hardening

Phase 22 against published `0.14.0-alpha.4` returned `D1 / E1 / S3` with **F3**: a
semantically incompatible authority build silently continued an in-flight workflow instance
under changed `WorkflowDef` semantics (25/25 real-process trials). `specs/spec14pt3.md` is
the corrective pass; all three findings are **CLOSED**. Corrective release: **`0.14.0-alpha.4`**.
Server IR stays **`axiom.server.v8`**; conformance stays **`axiom.conformance.v8`** (no new
vocabulary, no fixture edits). The 0.14 workflow model is unchanged (§4, §50, §51).

### F3 — WorkflowDef in authority compatibility

| Question (spec14pt3 §146) | Answer |
| --- | --- |
| 1. Why did `semanticFingerprint(graph)` detect WorkflowDef changes while `AuthorityCompatibilityKey.semanticFingerprint` did not? | Two projections. `core`'s `semanticProjection` iterates `EXECUTABLE_KINDS`, which spec14 correctly added `'workflow'` to — so the *graph-level* fingerprint moved. The *authority-side* projection, `serverIrSemanticProjection` in `packages/server/src/authority-identity.ts`, was a **hand-maintained slice list** (`actions`, `constraints`, … `queries`) that spec14 never extended with `workflows`. So `serverIrSemanticFingerprint` — and therefore the enforced `AuthorityCompatibilityKey` — was blind to every workflow executable change. |
| 2. The exact divergent mechanism? | `serverIrSemanticProjection`'s literal 13-field object vs. `core`'s `EXECUTABLE_KINDS`-driven loop. Independently maintained inclusion sets that drifted — the architecture spec14pt3 §5 forbids. |
| 3. The single authoritative semantic projection now? | `EXECUTABLE_KINDS` (exported from `core/semantic-identity.ts`) is the one source of truth for "which graph kinds carry executable meaning". `serverIrSemanticProjection` now **iterates `EXECUTABLE_KINDS`** via `SERVER_IR_EXECUTABLE_SLICES` (`kind → { field, shape }`), and a `packages/server` test asserts every `EXECUTABLE_KINDS` member has a slice. Workflows pass through `core`'s `canonicalWorkflowForFingerprint` (step / input / binding order is not semantic) in *both* projections, so they cannot disagree. |
| 4. How does WorkflowDef enter authority compatibility? | `SERVER_IR_EXECUTABLE_SLICES.workflow = { field: 'workflows', shape: 'list', since: 'v8' }`. `since: 'v8'` ⇒ the slice contributes only when non-empty, so every pre-workflow graph's authority fingerprint is byte-identical to alpha.1 (§35, §38, §103 — verified: a non-workflow `serverIrSemanticProjection` has no `workflows` key). A workflow graph gets `"workflows": [...]` and its fingerprint moves. |
| 5. Referenced ActionDefs included transitively? | Yes — by construction. The projection hashes the **whole** `ir.actions` slice, not only workflow-referenced ids, so a changed `ActionDef` body flips the fingerprint even if the workflow text is untouched (test: "a transitively-referenced ActionDef change flips compatibility"). |
| 6. Referenced EventDefs transitively? | Yes, identically — the whole `ir.events` slice is hashed. |
| 7. Which WorkflowDef fields are semantic? | `inputs` (id/type/required), `bindings` (id/type/`producedBy`), `entry`, and per step: `id`, `type`, control-flow edges (`next` / `then` / `else` / `onError` / `onTimeout`), `action` / `event` target, `arguments` / `where` / `bind` / `when` / `output` / `error` expression trees, `retry` policy (all four fields), `timeout`, `after` / `at`. Direct tests cover each. |
| 8. Presentation-only fields? | `name`, `description`, `label` anywhere in the workflow (stripped by `stripNonSemantic`), and **step declaration order** (`canonicalWorkflowForFingerprint` sorts by id). Both proven not to move the fingerprint. |
| 9. Identity stored with an instance? | The `AuthorityCompatibilityKey` string (`compatibilityKeyString` = canonical JSON of `{ schemaVersion, schemaFingerprint, serverContract, semanticFingerprint }`), written durably in the **same** `WorkflowStore.createIdempotent` transaction that creates the instance (SQLite: one `INSERT` inside `BEGIN IMMEDIATE`; §173 — no crash gap). |
| 10. Exact refusal point? | `createWorkflowEngine.advance()` — after `store.load`, after the terminal check, **before** `runStep` (so before any `ActionDef` invoke, event / timer / branch transition, binding write or `instanceRevision` CAS). Also in `deliverEventToWaits` (before the event-match transition), in `startWorkflow` (an existing incompatible instance is returned as `INCOMPATIBLE_AUTHORITY`, never reused), and in `cancelWorkflow` (a `cancelled` transition is compatibility-gated). A missing / empty / malformed stored fingerprint is incompatible (`isCompatible` requires a non-empty exact string match — never "missing ⇒ compatible", §175). |
| 11. Can an incompatible authority mutate `instanceRevision`? | No — verified in-process (2 engines / 1 store) and across 25 real-process trials per semantic variant: revision, status, current step, bindings and logical history are byte-unchanged after an incompatible authority is given every opportunity (poll loop, explicit event, cancel). |
| 12. Invoke an ActionDef? | No — `S_COUNT` (a `StateDef` the action increments by 1) stays `0` on the incompatible authority in every trial; it becomes `1` only once a compatible authority resumes. |
| 13. Match an event? | No — the incompatible authority may journal the canonical event as infrastructure (so a compatible authority reconciles it later) but applies no `where` / `bind` semantics and writes no `event-matched` transition. |
| 14. Fire a timer? | No — with the timer long overdue the incompatible authority still writes no `timer-fired` transition; a compatible authority fires it once. |
| 15. Can a semantically identical fresh process recover the instance? | Yes — the "presentation-only build B continues it" (25/25) and "compatible A2 completes it" controls pass; the fix binds instances to `semanticFingerprint`, never to process / authority identity. |
| 16. Still leaderless? | Yes — no leader, no sticky routing, no homogeneous-build assumption. Compatibility only decides *eligibility* to interpret a given instance; compatible authorities still compete for the fenced per-instance lease. 2- and 8-authority mixed (half compatible / half a semantic B) deployments: only compatible authorities advance, final meaning == all-A oracle. |
| 17. Server IR still `axiom.server.v8`? | Yes — no IR vocabulary change; `server-ir.v8.schema.json` unchanged. |
| 18. Conformance still `axiom.conformance.v8`? | Yes — 13/13 workflow fixtures unchanged; compatibility is a multi-build property the conformance runner does not model, so it is covered by the dedicated `workflow-compat` / `workflow-mixed-build` regression tests (§92 allows this). |

### F1 — unknown workflow step validation

- **Malformed step that caused the Phase 22 `TypeError`:** a step object with an unknown
  `type` (and, in the harsher probes, a `null` step) reached `validateWorkflow`'s
  reachability / expression walk, where `workflowStepExpressions` / `workflowStepSuccessors`
  fell through their non-exhaustive `switch` and returned `undefined`, and a `null` step hit
  an unguarded `(step as {id}).id` read.
- **Where validation assumed a known kind:** `core/workflows.ts` accessors
  (`workflowStepSuccessors`, `workflowStepExpressions`, `workflowIsTerminalStep`,
  `workflowActionIds`, `workflowEventIds`) and `validate.ts`'s unreachable-step loop.
- **Now emitted:** `WORKFLOW_INVALID_STEP` (the already-public code — no new diagnostic).
  The accessors are total over any input (guarded by a new `isWorkflowStep` predicate +
  `default` cases returning `[]`); `validate.ts`'s `.id` reads are null-safe.
- **`validateGraph` / `compileToServerIR` agree:** `compileToServerIR` runs `validateGraph`
  and throws `GraphValidationError` carrying `WORKFLOW_INVALID_STEP`; a server test asserts
  the message contains that code and **not** `TypeError` / `Cannot read`.
- **Can malformed input still leak a native `TypeError`?** No — covered for unknown string
  kind, missing kind, `null` kind, numeric kind, `step = null`, `step = string`,
  `step = array`, `{}` (`native TypeError count = 0`).

### F2 — tampered Server IR fail-closed

- **Tampered shapes that previously wedged / threw:** unknown step kind, a `next` / `entry`
  edge to a non-existent step, a `null` step, a `timer` with neither `after` nor `at`, a
  missing `action` / `event` target, a malformed terminal.
- **Where invalid IR is now rejected:** at **admission** — `createWorkflowEngine` (and hence
  `createAxiomServer`) runs `workflowStructuralProblems` (a new `core` runtime-boundary
  check, graph-context-free) on every `WorkflowDef` and throws `WorkflowIRError` (structured
  `.problems`, no internals) before any instance can start or advance. Defence in depth: a
  step object mutated *after* construction is caught in `advance` (the instance is failed
  with a structured `workflow-invalid-step` reason rather than the poll loop spinning
  forever), and `runStep` has a total `default`.
- **Structured error produced:** `WorkflowIRError` (`code: 'WORKFLOW_INVALID_IR'`).
- **Can unknown workflow IR execute partially / reach an ActionDef or event transition?**
  No — admission refusal precedes engine construction; `0 native TypeError`,
  `0 silent execution`, `0 permanent wedge` across the tamper matrix.

### spec14pt2 regression (§94-§100)

`workflow-crash-matrix.test.ts` re-run: F1 SIGKILL-after-commit and F2 Case A
SIGKILL-before-transition (`S_COUNT == 1`, one `step-succeeded` / `event-matched`), Case B
race, Case C replay, 2-/8-authority claim races (one logical transition), SIGSTOP
stale-owner (refused) — all green. Start idempotency, timer target capture and event dedup
suites unaffected. Non-workflow `semanticFingerprint` / `serverIrSemanticFingerprint` /
`schemaFingerprint` and 0.12 / 0.13 authority-compatibility behaviour: unchanged (full
`packages/server` + `packages/core` suites green).

### Tests added

`packages/core/test/semantic-identity.test.ts` (+4: workflow field sensitivity, presentation
control, transitive ActionDef, construction order); `packages/agent-api/test/workflow.test.ts`
(+2: F1 malformed-step matrix, `workflowStructuralProblems`);
`packages/server/test/workflow-compat.test.ts` (+10: `EXECUTABLE_KINDS` ↔ slice guard, every
§62 mutation flips compatibility, presentation / canonicalization / transitive controls, F2
admission refusal, F1/§41 consistency, in-process mixed-build §76-§78, start-identity
scoping); `packages/server/test/workflow-mixed-build.test.ts` (+6: real-OS-process — 3
semantic variants × 25 trials refused with A2 recovery, presentation-only × 25 continues,
2-/8-authority mixed topology). Repo total: **1444** tests green (from 1421).

## spec14pt4 closure — Phase 22 F1 / F2 residuals (`0.14.0-alpha.3`)

The focused external retest of `0.14.0-alpha.2` closed **F3** externally but found narrow
residuals: `AgentAPI.analyzeWorkflow` still read `step.id` before proving the step's shape
(F1), and IR admission did not yet prove every *container* shape or *reference* was valid
(F2). `specs/spec14pt4.md` is the narrow corrective — **F3 architecture is untouched**
(`EXECUTABLE_KINDS`, `SERVER_IR_EXECUTABLE_SLICES`, `canonicalWorkflowForFingerprint`,
`AuthorityCompatibilityKey`, `isCompatible` unchanged in behaviour; the only edits there add
`Array.isArray` / `typeof` guards that are no-ops for valid input — no valid graph's
`semanticFingerprint` moves). Server IR stays `axiom.server.v8`, conformance
`axiom.conformance.v8`, `SEMANTIC_FINGERPRINT_VERSION` unchanged. Both findings **CLOSED**.

### F1 — `AgentAPI.analyzeWorkflow` totality

| Question (spec14pt4 §68) | Answer |
| --- | --- |
| 1. Why did `validateGraph` reject malformed steps while `analyzeWorkflow` still threw? | `validate.ts` was hardened in pt3; `analyzeWorkflow` (a separate `packages/agent-api` traversal) was not — it did `workflow.steps.filter((s) => reachable.has(String(s.id)))` and `for (const step of workflow.steps) { …step.type… }` with no shape guard. |
| 2. Which traversal read `step.id` before validation? | The reachable-steps `.filter`/`.map` and the wait-reasons `for…of` in `analyzeWorkflow`, plus `workflow.steps` / `.inputs` / `.bindings` assumed to be arrays. |
| 3. Total over the full malformed-step corpus now? | Yes. `analyzeWorkflow` runs the shared total `workflowStructuralProblems(workflow)` **first** and throws a structured `Error` (AgentAPI's existing "no workflow node" convention) if non-empty; the subsequent traversal additionally filters through `isWorkflowStep` and `Array.isArray`. Corpus: `null` / `undefined` / string / number / boolean / array / `{}` / unknown-kind / missing-kind / null-kind / numeric-kind step. |
| 4. Same validated helpers as core? | Yes — `workflowStructuralProblems`, `isWorkflowStep` from `@cynodia/axiom-core`. |
| 5. Any malformed step still a native `TypeError`? | No. `native error count = 0` across `validateGraph`, `AgentAPI.validate`, `AgentAPI.analyzeWorkflow` and `compileToServerIR` for the whole corpus. |

### F2 — IR admission container + reference totality

| Question (spec14pt4 §69) | Answer |
| --- | --- |
| 1. Why were invalid binding references admitted? | `workflowStructuralProblems` (pt3) checked step shape and control-flow edges but not `wait-event` `bind` targets, `WorkflowBinding.producedBy`, or expression `ref` scope — those were only enforced by `validateGraph` at authoring time, which a hand-tampered `ServerIR` bypasses. |
| 2. Why did unknown refs become permanent `running` wedges? | `evaluateWorkflowExpression`'s `ref` case throws for an id not in scope; the throw propagated out of `advance`, which `pollOnce` catches and ignores — so the instance stayed `running` and every poll re-threw. |
| 3. Why could a malformed `workflows` / `steps` container reach `workflowExpressions` before refusal? | `workflowExpressions` did `workflow.steps.flatMap(...)`; `createWorkflowEngine` did `options.workflows.flatMap(...)` and `new Map(options.workflows.map(...))`; `serverIrSemanticProjection`'s `sortedList` did `[...(list ?? [])]` — each assumes an array. |
| 4. Where is container validation now? | `workflowStructuralProblems` is total over *any* value: it proves `workflow` is an object and `steps` / `inputs` / `bindings` are arrays of the right element shape **before** any traversal. `createWorkflowEngine` guards `Array.isArray(options.workflows)`; `createAxiomServer` routes any non-`undefined`, non-empty-array `ir.workflows` into it unchanged (never `?? []`). `sortedList` / `sortedRecord` / `canonicalWorkflowForFingerprint` return empty/pass-through for a non-array/non-object slice. |
| 5. Where is binding / reference integrity validated? | In `workflowStructuralProblems`: a `wait-event` `bind` key must be a declared `WorkflowBinding` (`WORKFLOW_BINDING_NOT_FOUND`); every `WorkflowBinding.producedBy` must resolve to a step (`WORKFLOW_STEP_NOT_FOUND`); every workflow expression `ref` must resolve in that location's closed scope — inputs / bindings / `PRINCIPAL`, plus `EVENT` only inside a `wait-event` `where`/`bind` (`WORKFLOW_EXPRESSION_SCOPE`); no `now`/`uuid`/`random` (`WORKFLOW_NONDETERMINISTIC`). |
| 6. Can an invalid `bind` target reach event execution? | No — refused at admission; `createAxiomServer` throws `WorkflowIRError` and no instance is created. |
| 7. Can an unknown `branch` ref reach branch execution? | No — same. |
| 8. Can a malformed workflow container produce a native `TypeError`? | No — the full §29 tamper corpus (17 container + 10 reference shapes) throws `WorkflowIRError` / `WORKFLOW_INVALID_IR`; `native TypeError = 0`, `silent admission = 0`, `semantic execution = 0`, `permanent wedge = 0`. |
| 9. Validation before engine execution? | Yes — at `createWorkflowEngine` construction, which `createAxiomServer` calls before `server.start()`. |
| 10. Defense in depth if corrupt state bypasses admission? | `advance` wraps `runStep` in try/catch: a throw (e.g. a corrupt durable instance pointing at a bad ref) fails the instance with a structured `workflow-step-execution-error` terminal reason rather than letting `pollOnce` swallow it and retry forever. `runStep` also has a total `default`. |

### Changes

- **core** `workflows.ts` — `workflowStructuralProblems` is total over `unknown` and now also
  checks bind / producer / expression-scope / nondeterminism (`WorkflowStructuralProblem.code`
  widened with `WORKFLOW_BINDING_NOT_FOUND` / `WORKFLOW_EXPRESSION_SCOPE` /
  `WORKFLOW_NONDETERMINISTIC`); `workflowExpressions` and `canonicalWorkflowForFingerprint`
  guard a non-array `steps` / non-object workflow.
- **agent-api** `workflow.ts` — `analyzeWorkflow` runs `workflowStructuralProblems` first and
  filters traversal through `isWorkflowStep` / `Array.isArray`.
- **server** `authority-identity.ts` (`sortedList` / `sortedRecord` total), `workflows.ts`
  (`createWorkflowEngine` array guard + `advance` try/catch defense in depth), `server.ts`
  (`ir.workflows` routing).

### Tests added (+9; repo 1444 → 1453)

`agent-api/test/workflow.test.ts` +3 (analyzeWorkflow totality over the malformed corpus, no
native error; cross-surface consistency with `validateGraph`; valid workflow still analyzed).
`server/test/workflow-ir-totality.test.ts` +6 (valid control; 17 container tamper shapes →
`WorkflowIRError`; 10 reference tamper shapes → `WorkflowIRError`; former-wedge / no-silent-drop
regression — admission fails so there is no instance to wedge; `createWorkflowEngine` /
`createAxiomServer` parity; `compileToServerIR` malformed-step surface). spec14pt2/pt3
regressions (crash matrix, mixed-build, compat smoke) re-run green.

## spec14pt5 closure — Phase 22 F2 admission-surface totality (`0.14.0-alpha.4`)

The external retest of `0.14.0-alpha.3` closed **F1** and confirmed **F3**, and closed every
*substantive* F2 workflow-validation defect — but found **one narrow residual**: a
hand-tampered `ir.workflows = 123` or `ir.workflows = {}` made `createAxiomServer` throw a
native `TypeError` *before* the workflow admission validator got control, because
`understatedContract` → `serverIRExpressions(ir)` did `for (const workflow of ir.workflows ?? [])`
— a `for…of` over a non-iterable.

**Fix (the admission *boundary*, per §"Design Requirement", not scattered guards):**

- **`server.ts`** — `createAxiomServer` now validates the `ir.workflows` *container shape* at
  the very top, before `understatedContract` / `serverIRExpressions` / the compatibility
  fingerprint touch it: a present, non-array `workflows` throws the same
  `WorkflowIRError` / `WORKFLOW_INVALID_IR` `createWorkflowEngine` raises. Absent or `[]` is
  admissible; a malformed present value is **not** coerced to `[]`.
- **`core/server-ir.ts`** (defense in depth, both cheap) — `serverIRExpressions` iterates
  `Array.isArray(ir.workflows) ? ir.workflows : []`; `usesWorkflowVocabulary` requires a
  non-empty **array** (a string has a `.length` but is not workflow vocabulary).

Result: `createAxiomServer` is now as total over a malformed `ir.workflows` as
`createWorkflowEngine` already was — `number` / plain object / `boolean` / `string` / `null`
all yield a structured `WorkflowIRError`, `native TypeError count = 0`, `silent admission = 0`,
`semantic execution = 0`. F3 architecture (`EXECUTABLE_KINDS`, `SERVER_IR_EXECUTABLE_SLICES`,
`canonicalWorkflowForFingerprint`, `AuthorityCompatibilityKey`, mixed-build semantics) is
untouched; no valid graph's `semanticFingerprint` moves; Server IR `axiom.server.v8`,
conformance `axiom.conformance.v8`, `SEMANTIC_FINGERPRINT_VERSION` unchanged.

### F2 report Q&A (spec14pt5)

| Question | Answer |
| --- | --- |
| Where did the `TypeError` come from? | `serverIRExpressions` in `packages/core/src/server-ir.ts`: `for (const workflow of ir.workflows ?? [])` — `123 ?? []` is `123`, `{} ?? []` is `{}`, neither iterable. Reached via `createAxiomServer` → `understatedContract` → `requiredServerContract(serverIRExpressions(ir))`, which runs before `createWorkflowEngine`. |
| Where is the container boundary now? | The first statement of `createAxiomServer` after the contract-membership check: `ir.workflows` must be `undefined` or an array, else `WorkflowIRError('workflows is not an array')`. |
| Is malformed input coerced? | No — `undefined` / `[]` stay admissible; anything else present fails closed. There is no `Array.isArray(x) ? x : []`. |
| Parity with `createWorkflowEngine`? | Yes — same `WorkflowIRError`, same `WORKFLOW_INVALID_IR` code, same `'workflows is not an array'` message; a test drives both with the identical value. |
| Other pre-admission helpers? | `usesWorkflowVocabulary` and `serverIRExpressions` are now total by `Array.isArray` guard; the compatibility-fingerprint path (`sortedList` / `sortedRecord` / `canonicalWorkflowForFingerprint`) was already made total in spec14pt4 and runs after the new boundary check regardless. |

### Tests added (+2; repo 1453 → 1455)

`server/test/workflow-ir-totality.test.ts` +2: (a) `ir.workflows` ∈ {`123`, `{}`, keyed
object, `true`, `false`, string, `null`} → `createAxiomServer` **and**
`createWorkflowEngine` both throw `WorkflowIRError` / `WORKFLOW_INVALID_IR`, `native error
count = 0`; (b) `ir.workflows` ∈ {absent, `[]`} → server constructs and starts normally,
`inspectWorkflows()` is `[]`. spec14pt2/pt3/pt4 regressions re-run green.

## Blind Phase 22

Focused F1 / F2 external rerun pending — requires the published `0.14.0-alpha.4` packages
(`release:pack` / `verify` / `consumer-test` / `probe` are the gate). F1 externally closed at
alpha.3, F3 at alpha.2 — only small smoke controls are needed there (that code is untouched).
The essential F2 reproduction: tamper `ir.workflows = 123` then `= {}`, call
`createAxiomServer`, expect `WorkflowIRError` / `WORKFLOW_INVALID_IR`, `native TypeError = 0`.
After a green focused F1 / F2 rerun, resume the original Phase 22 spec from the previously
de-scoped §125 sections against the published set. Required eventual verdict `D1 / E1 / S1`;
the 0.14 semantic model is **not** frozen before that external result.
