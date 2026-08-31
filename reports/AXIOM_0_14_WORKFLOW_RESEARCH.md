# Axiom 0.14 — Durable Workflows: design note (Phase 1)

Feature release. Baseline `0.13.1-alpha.1`. Branch `spec14-durable-workflows`. This note
resolves the Phase 1 gates of `specs/spec14.md` §249 before broad implementation.

> The workflow graph owns durable orchestration meaning. The runtime owns scheduling,
> persistence, retries, leases, fencing, crash recovery and physical execution.

---

## 1. `WorkflowDef` shape (§7, §13, §26)

A new graph node kind `workflow` (`packages/core/src/workflows.ts`):

```ts
interface WorkflowDef extends NodeBase {
  kind: 'workflow';
  inputs: WorkflowInput[];              // { id: NodeId, valueType: TypeRef, required?: boolean }
  bindings: WorkflowBinding[];          // { id: NodeId, valueType: TypeRef, producedBy: NodeId (step id) }
  entry: NodeId;                        // step id
  steps: WorkflowStep[];
}
```

Inputs are immutable after start. Bindings are **single-assignment**: each is `producedBy`
exactly one `wait-event` step and read-only everywhere else. No mutable JSON blob (§27).

## 2. Step vocabulary — the six of §9 (`WorkflowStep` discriminated on `type`)

| `type` | Fields | Meaning |
| --- | --- | --- |
| `action` | `id`, `action: NodeId`, `arguments: Record<string, Expression>`, `next: NodeId`, `onError?: NodeId`, `retry?: WorkflowRetryPolicy` | invoke a canonical `ActionDef` under the workflow principal |
| `wait-event` | `id`, `event: NodeId`, `where?: Expression` (bool), `bind?: Record<string, Expression>` (→ binding ids), `next: NodeId`, `timeout?: WorkflowDuration`, `onTimeout?: NodeId` | wait for a matching canonical `EventDef` occurrence |
| `timer` | `id`, `after?: WorkflowDuration` \| `at?: WorkflowInstant`, `next: NodeId` | wait until a durable time |
| `branch` | `id`, `when: Expression` (bool), `then: NodeId`, `else: NodeId` | deterministic edge choice over durable workflow context |
| `complete` | `id`, `output?: Record<string, Expression>` | terminal → `completed` |
| `fail` | `id`, `error?: Record<string, Expression>` | terminal → `failed` |

`WorkflowDuration = { seconds: number }` (portable, no cron, no ISO-8601 parsing in the
graph). `WorkflowInstant = { epochMs: number }` or an `Expression` over inputs resolving to
a number. `WorkflowRetryPolicy = { maxAttempts, initialDelaySeconds, backoffMultiplier,
maxDelaySeconds }` (§38).

Deferred (§10): `parallel`, `race`, `map`, `foreach`, `child-workflow`, `query-watch`,
`human-task`, `compensation`, `saga`, loops.

## 3. Expression scope (§126-§130)

A workflow expression (action argument, `wait-event.where`/`bind`, `branch.when`,
`complete.output`, `fail.error`, `timer.at`) resolves against a **closed** scope:

- `ref(<input id>)` — an immutable start input;
- `ref(<binding id>)` — a durable single-assignment binding (must be produced by an earlier
  step on every path to the reader);
- `ref('EVENT')` — the matched event payload, **only** inside a `wait-event` step's `where`
  / `bind`;
- `ref('PRINCIPAL')` — the bound workflow principal, where semantically appropriate.

**Not** `StateDef` (§127), **not** a `QueryDef` (§128 — `wait-query` is a future feature),
**not** `now`/`uuid`/`random` (§129). `timer.at` may reference a **start-captured** instant
only (§130). New validation code `WORKFLOW_EXPRESSION_SCOPE` for a `ref` outside this set,
`WORKFLOW_NONDETERMINISTIC` for a nondeterministic builtin.

## 4. Binding model (§26-§28)

`bindings[]` is declared on the `WorkflowDef`. A `wait-event` step's `bind: { <bindingId>:
Expression }` assigns each named binding from `ref('EVENT')` / inputs / earlier bindings,
once, when the event matches and the transition commits. `branch.when` and later steps read
`ref(<bindingId>)`. Validation: `WORKFLOW_BINDING_NOT_FOUND` (read of an unknown/undeclared
binding), `WORKFLOW_DUPLICATE_BINDING` (two steps produce the same binding), and a
reachability check that a read is dominated by its producer.

## 5. Logical transition identity + `activationId` (§12, §31, §46, §85)

- `WorkflowInstance.instanceRevision` — a monotone durable integer. Every logical transition
  is a CAS: `expected instanceRevision R + fence F` → `R+1`, atomically (§85, §131, §132).
- `activationId` — a string identifying *this arrival at this step*, distinct from `stepId`
  so future loops can revisit a step. For 0.14 (acyclic) `activationId = "<stepId>#<n>"`
  where `n` is the count of prior activations of that step for this instance (always `0` for
  an acyclic graph; the counter exists so the identity survives a future loop feature).
- **Action invocation identity** (§31, §32) = `"<instanceId>/<activationId>"`. The workflow
  action step invokes the `ActionDef` through the ordinary authority path with this as the
  **idempotency key** (request-id), so a crash between "action committed" and "workflow
  transition recorded" is reconciled: the reclaiming authority replays with the same key,
  the idempotency store returns the prior response, and the transition then commits once
  (§32, §102, §222).
- **Effect identity** (§33) — an effect created by that action already keys on the action's
  logical effect id, which is now derived from the stable invocation identity, so a workflow
  retry does not fork `charge-card #1` and `#2` into unrelated logical payments.

## 6. Event observation boundary — no-gap (§54-§58) — **Model B**

When a workflow durably enters a `wait-event` step, the transition record **includes** the
durable wait registration: `{ eventId, correlationValues, sinceEventSeq, activationId }`.
The registration is committed in the **same** `WorkflowStore` transaction as the transition
(§48, §132) — there is no "state = waiting, then subscribe" window. Matching is driven by
the existing inbound event pipeline: `fireEvent` already dispatches every accepted event; a
new `WorkflowEventRouter` consults the `WorkflowStore` for waits whose `eventId` matches and
whose `where` predicate is satisfied by the payload, and performs the fenced transition. On
**startup / failover**, every `waiting`-on-event instance is rediscovered from the store
(§94) and, because `sinceEventSeq` is durable, a matching event that landed during a crash
window is replayed from the event journal (`ExternalEventDedupStore` already keeps a bounded
per-source history; 0.14 adds a monotone `eventSeq` to accepted events and a bounded
`WorkflowEventJournal` so a wait can scan `> sinceEventSeq`). Event dedup (§59) is
unchanged: a redelivered physical event with the same `(source, externalEventId)` is
collapsed before it reaches the router, so a wait transitions at most once.

Fanout (§60, §61): a matching event unblocks *every* independently-matching waiting
instance; a wait never globally consumes an event.

## 7. Timer identity + recovery (§44-§49)

`workflowTimerId = "<instanceId>/<activationId>"`. On entering a `timer` step the **target
instant is computed once** (`activationInstant + after.seconds`, or the resolved `at`) and
stored in the transition record (§45). A durable `WorkflowStore` row carries `nextEligibleAt
= target`. The workflow poll loop (below) claims timer-due instances by fence and performs
the transition; a physically-late firing is still valid (§49). Recovery (§48): the waiting
row *is* the timer — nothing separate to re-register.

## 8. Ownership / fencing / recovery (§87-§99, §131)

Leaderless. Reuse the 0.12 `CoordinationProvider` for the per-instance lease and the
`fence` (`generation`), exactly as `SubscriptionCursorStore` does — no second lease system
(§92). A runnable instance (status `running`, or `waiting` with `nextEligibleAt <= now`, or
retry-due) is claimed by `acquire(instanceId)`; every `WorkflowStore` transition is a
**fenced** conditional write (`WHERE instanceRevision = ? AND fence <= ?`), so a resumed
stale owner is refused (§89, §90, §133 — the exact SIGSTOP race of §263). Discovery (§94,
§96): the SQLite store has an index on `(status, nextEligibleAt)`; a bounded
`recoverRunnable(limit)` scan feeds the poll loop. Startup safety (§97, §135): schema init
is `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` under `busy_timeout`, proven with 8
concurrent processes.

## 9. Start idempotency (§18-§21)

`server.startWorkflow({ workflowId, arguments, credential, idempotencyKey })`.
`WorkflowStartIdentity = { workflowId, principalFingerprint, idempotencyKey,
compatibilityFingerprint }`. `WorkflowStore.createIdempotent(startIdentity, factory)` is an
atomic "insert-or-return-existing" (SQLite `INSERT … ON CONFLICT DO NOTHING` + read-back).
A retried start after an uncertain response returns the **same** `instanceId` (§21). No
`idempotencyKey` → a fresh instance every call (documented).

## 10. Cancellation (§75-§80)

`server.cancelWorkflow(instanceId, credential)` — idempotent. It is a fenced transition to
`cancelled` (durable, §79). It is **not** rollback (§76): committed actions and dispatched
effects stand; documentation says so plainly. A later timer/event delivery for a
`cancelled` instance is dropped by the router's terminal check (§79). Cancel-vs-transition
races (§78, §187-§192) linearize on `instanceRevision`: whichever fenced CAS commits first
wins; the loser observes the new revision and refuses.

## 11. `WorkflowStore` contract (§81, §131)

```ts
interface WorkflowStore {
  createIdempotent(start: WorkflowStartIdentity, make: () => WorkflowInstanceInit): Promise<{ instance: WorkflowInstanceRecord; created: boolean }>;
  load(instanceId: string): Promise<WorkflowInstanceRecord | undefined>;
  loadByStart(start: WorkflowStartIdentity): Promise<WorkflowInstanceRecord | undefined>;
  transition(cas: { instanceId: string; expectedRevision: number; fence: number; next: WorkflowTransition }): Promise<{ ok: true; record: WorkflowInstanceRecord } | { ok: false; reason: 'revision' | 'fenced' | 'terminal' }>;
  recordAttempt(instanceId: string, attempt: WorkflowAttemptRecord): Promise<void>;
  recoverRunnable(now: number, limit: number): Promise<WorkflowInstanceRecord[]>;
  findEventWaits(eventId: string, limit: number): Promise<WorkflowEventWait[]>;
  history(instanceId: string): Promise<WorkflowHistoryEntry[]>;
  close?(): Promise<void>;
}
```

Memory + SQLite references. SQLite: one `axiom_workflow_instances` row per instance
(`instance_id` PK, `workflow_id`, `compat`, `principal`, `inputs` JSON, `status`,
`current_step`, `activation_id`, `attempt`, `bindings` JSON, `wait` JSON, `next_eligible_at`,
`instance_revision`, `fence`, `created_at`, `updated_at`, `failure` JSON), an
`axiom_workflow_history` append table, and an `axiom_workflow_starts` table keyed by the
start identity hash. Every `transition` runs `BEGIN IMMEDIATE; verify revision + fence;
write; revision+1; append history; COMMIT` (§132) — the check is **inside** the transaction
(the spec13.1 lesson).

## 12. Server IR v8 (§118-§120)

`SERVER_IR_CONTRACTS` gains `'axiom.server.v8'`; `SERVER_IR_LATEST_CONTRACT = v8`.
`requiredServerContract` / the doc-contract computation: a document with any `WorkflowDef`
is `v8`; a document with none is byte-identical to the v7 (or lower) it always was — the
committed v1..v7 conformance fixtures and schemas are unchanged (§119). `compileToServerIR`
serializes `workflows` into the IR. `axiom.server.v8` schema is generated and shipped.

## 13. `semanticFingerprint` / compatibility (§113, §116, §208-§211)

`'workflow'` joins `EXECUTABLE_KINDS` in `semanticProjection`. A graph with no workflow →
identical fingerprint (empty group skipped), so **no existing graph's fingerprint moves**
(§208) and `SEMANTIC_FINGERPRINT_VERSION` is not bumped. A running instance stores the
`AuthorityCompatibilityKey` string at start; an authority whose key differs **refuses to
advance it** (`INCOMPATIBLE_AUTHORITY`, fail-closed — §116, §211) exactly as the 0.12
`DurableWorkStore` does. A presentation-only change moves nothing (§114). A semantic
workflow change (§115) makes new instances incompatible with old authorities and vice
versa; old instances are not auto-migrated (§117, §212) — they run to completion on a
compatible authority or are surfaced as stranded.

## 14. Conformance v8 (§156-§159)

`axiom.conformance.v8` (`conformance/workflow/`): a fixture is a compiled `axiom.server.v8`
Server IR + inputs + a **deterministic driver script** (advance the clock, deliver an event,
run the poll) + the **required logical transition history** (§264) and terminal state.
Runner uses the memory `WorkflowStore` + `DeterministicServerHost`; physical attempt
duplication is allowed, logical history must match exactly. 15 fixtures of §157 + negative
controls (§158). v1..v7 frozen.

## 15. AgentAPI (§138-§141)

`AgentAPI.analyzeWorkflow(workflowId)` — pure over the graph: inputs, entry, every step with
its kind and edges, the set of `ActionDef` / `EventDef` dependencies, timer waits, branch
conditions, retry policies, the reachable terminal outcomes, acyclicity, and the possible
`waitingReason`s. `AxiomServer.getWorkflow(instanceId)` / `inspectWorkflow(instanceId)` —
the §137 semantic fields, no secrets.

---

## Non-goals restated (§10, §77, §149)

No `parallel`/`race`/`map`/`foreach`/child-workflow/loops/compensation/saga/`wait-query`, no
application script body, no arbitrary mutable blob, no workflow message bus, no automatic
compensation, no `wait-on-livequery`. `NativeOperation` count for ordinary workflow
semantics: 0.
