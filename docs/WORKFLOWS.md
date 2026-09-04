# Durable workflows

Axiom 0.16.0-alpha.1. The operational contract for **long-running semantic computations with
a durable control position** — orchestration that survives process death, authority
failover, retries, timer delivery, event delivery and ordinary distributed contention
without application-owned infrastructure. `axiom.server.v8`.

> The workflow graph owns durable orchestration meaning. The runtime owns scheduling,
> persistence, retries, leases, fencing, crash recovery and physical execution.

A durable workflow is **not** a background promise, a persisted callback, a job-queue entry,
a cron task, a mutable JSON state blob, a process-local event listener, or a bag of retries.
It is a `WorkflowDef` node: a closed step vocabulary and `Expression` trees over a closed
scope. There is no application script body of any kind.

---

## `WorkflowDef`

```ts
interface WorkflowDef extends NodeBase {
  kind: 'workflow';
  inputs?: WorkflowInput[];      // { id, valueType: TypeRef, required?: boolean } — immutable after start
  bindings?: WorkflowBinding[];  // { id, valueType, producedBy: <step id> } — single-assignment, read-only elsewhere
  entry: NodeId;                 // the first step
  steps: WorkflowStep[];
}
```

Inputs use canonical portable value types only — no host objects, closures, file
descriptors, sockets or class instances. Bindings replace a mutable workflow blob: each is
assigned **once** by its producing step and only read afterwards, which is what keeps replay
safe, static analysis strong and the model portable.

### Step vocabulary — the six of 0.14

| `type` | Fields | Meaning |
| --- | --- | --- |
| `action` | `action: NodeId`, `arguments?`, `next`, `onError?`, `retry?` | Invoke a canonical `ActionDef` under the workflow principal. |
| `wait-event` | `event: NodeId`, `where?` (bool), `bind?` (→ binding ids), `next`, `timeout?`, `onTimeout?` | Wait for a matching canonical `EventDef` occurrence. |
| `timer` | exactly one of `after: { seconds }` / `at: Expression`, `next` | Wait until a durable time. |
| `branch` | `when` (bool), `then`, `else` | Deterministic edge choice over durable workflow context. |
| `complete` | `output?` | Terminal → `completed`. |
| `fail` | `error?` | Terminal → `failed`. |

Deferred (a later release): `parallel`, `race`, `map`, `foreach`, child workflows,
`wait-query`, human tasks, compensation / sagas, loops. The graph **should be acyclic**;
`validateGraph` rejects a control-flow cycle (`WORKFLOW_CYCLE_NOT_ALLOWED`). Retries are
runtime policy and are not graph edges.

### Workflow expression scope

Every workflow expression (an action argument, `wait-event.where` / `bind`, `branch.when`,
`timer.at`, `complete.output`, `fail.error`) resolves against a **closed** scope:

- `ref(<input id>)` — an immutable start input;
- `ref(<binding id>)` — a durable single-assignment binding;
- `ref('EVENT')` — the matched event payload, **only** inside a `wait-event` step's `where`
  / `bind`;
- `ref('PRINCIPAL')` — the bound workflow principal.

**Not** a `StateDef` (`WORKFLOW_EXPRESSION_SCOPE`) — model dynamic application state as a
canonical `ActionDef` *before* the branch. **Not** a `QueryDef` — a branch never hides a
network/storage read. **Not** `now` / `uuid` / `random` (`WORKFLOW_NONDETERMINISTIC`) —
workflow decisions must be replayable; time enters only through a `timer` step's
captured-once target instant.

---

## Starting a workflow

```ts
const started = await server.startWorkflow({
  workflowId, arguments, credential, idempotencyKey,
});
// { instanceId, status } | { error: { code, message } }
```

**Idempotent start.** `WorkflowStartIdentity = { workflowId, principalFingerprint,
idempotencyKey, compatibilityFingerprint }`. Two `startWorkflow` calls with the same
`(workflowId, principal, idempotencyKey)` return the **same** `instanceId` — a retry after a
lost response is one logical instance, not two. Two different callers reusing the same
textual key under different principals never collide. Omitting `idempotencyKey` starts a
fresh instance every call.

**Principal.** The canonical principal the workflow was started under is bound to the
instance and every workflow-driven `ActionDef` executes as it — no authority-local service
principal, no privilege escalation. Capturing the principal does not freeze authorization:
each later action step re-evaluates current canonical authorization under that principal, and
a step whose action is no longer authorized **fails semantically** (it follows `onError` if
declared, else the workflow fails).

---

## Logical identity and exactly-once

- **`instanceRevision`** — a monotone durable integer. Every logical transition is a fenced
  compare-and-swap: `expected instanceRevision R + fence F → R+1`, atomically, with the
  check *inside* the write transaction. This linearizes every race — event vs timeout,
  cancel vs completion, two authorities on one step, stale owner vs new owner.
- **`activationId`** — identifies *this arrival at this step*, distinct from the step id so a
  future loop feature can revisit a step without changing instance identity. For 0.14
  (acyclic) it is `"<stepId>#0"`.
- **Action invocation identity** = `"<instanceId>/<activationId>"`. The workflow action step
  invokes the `ActionDef` through the ordinary authority path with this as the idempotency
  key. The authority commits a **durable idempotency record** in the *same* persistence
  transaction as the ActionDef's state writes, so a crash between "action committed" and
  "workflow transition recorded" — including a **full process restart** with no in-memory
  state — is reconciled: a recovery authority proves the invocation already committed and
  recovers its canonical outcome (`PersistenceAdapter.loadIdempotentResponse`) rather than
  executing the action a second time. The record can never be present without the matching
  durable state, and vice versa.
- **Exactly-once logical transition** for each activated step is guaranteed.
  **Exactly-once physical execution of an external effect is not** — that remains governed
  by the effect system. The distinction is deliberate and load-bearing: an effect an action
  dispatched from a workflow keeps a stable logical effect identity across workflow retries.

---

## Event waits — no gap

When a workflow durably enters a `wait-event` step, the transition record **includes** the
durable wait registration (`eventId`, correlation, `sinceEventSeq`, `activationId`),
committed in the **same** transaction — there is no "state = waiting, then subscribe"
window. Matching is driven by Axiom's single inbound event pipeline (the same one webhooks
and effect outcomes use): every accepted event is offered to matching waits whose `where`
predicate the payload satisfies. Every accepted event is first appended to a **durable
`WorkflowStore` journal** with a store-global monotone `seq`; `sinceEventSeq` is captured
from that journal's high-water mark. On startup / failover — and on every poll tick — every
event-waiting instance is rediscovered and the journal is replayed against it from
`sinceEventSeq`, so a matching event **survives the death of the authority that routed it**:
another compatible authority replays it from the shared journal with no client resend, no
manual replay, no sticky routing and no application polling. Existing external-event dedup
is unchanged and runs upstream, so a redelivered physical event transitions a wait **at most
once**; replaying the same journalled event any number of times yields **one** logical
transition. A matching event unblocks *every* independently-matching waiting instance
(fanout); a wait never globally consumes an event. An event that committed strictly before a
wait became live is deterministically **not** matched (it is in the past); an event
concurrent with wait activation is matched exactly once — no event is lost in the handoff.

`bind: { <bindingId>: Expression }` assigns declared bindings from `ref('EVENT')` when the
event matches and the transition commits. A `wait-event` step may declare a `timeout` and an
`onTimeout` edge; if the event and the timeout are concurrent, **exactly one** logical
transition wins (`instanceRevision` decides), never both.

---

## Timers

`timer` waits until a durable time. On activation the **target instant is computed once**
(`activationInstant + after.seconds`, or the resolved `at`) and stored in the transition
record — a restart does not recompute `now + after` and extend the wait. Scheduler firing
may be physically at-least-once; the workflow transition it causes is logically exactly-once.
A firing after the target time is still valid — the guarantee is *not before* the target,
*eventually after*, subject to scheduler availability. 0.14 does not promise hard real-time.
Recovery needs nothing special: the waiting row *is* the timer.

---

## Retries

An `action` step may declare `retry: { maxAttempts, initialDelaySeconds, backoffMultiplier,
maxDelaySeconds }`. Automatic retries apply only to **runtime-classified retryable**
failures (a transient infrastructure condition, a lease interruption before logical commit)
— never to a semantic business refusal. `retryable` vs terminal is a structured distinction;
workflow logic never parses an error-message string. Each physical attempt has its own
attempt number; the logical action identity is constant across attempts. The attempt count
and the next eligible execution time are **durable** — authority death does not reset
`attempt = 4` back to `1`. Lease/fencing ensures one current executor, so multiple
authorities never retry the same step as independent logical owners.

---

## Cancellation

```ts
await server.cancelWorkflow(instanceId, credential); // { ok: true, status } | { error }
```

Idempotent. Cancellation is a fenced durable transition to `cancelled`. It means **do not
continue executing future workflow steps** — it is **not** rollback: it does not undo
already-committed actions, it does not reverse dispatched external effects, and it is not a
distributed transaction. 0.14 has no automatic compensation. A later timer or event delivery
for a `cancelled` (or `completed` / `failed`) instance does not transition it. A
cancel-versus-transition race linearizes on `instanceRevision`: whichever fenced CAS commits
first wins.

**Cancellation is authorized.** `credential` is resolved to a canonical principal and its
fingerprint must match the one the instance was **started** under (spec14 §257 — instance
access is keyed by principal fingerprint), or the call is refused with the canonical
`AUTHORIZATION_DENIED` diagnostic and mutates nothing — no `instanceRevision` advance, no
history entry, no ownership claim. The check resolves identically on every authority (the
fingerprint is durable, `resolvePrincipal` is deterministic), so cancellation is not
topology-dependent. Cancelling an already-terminal instance stays idempotent for any caller.
General authorization completeness is 0.15's subject; this is the one cancellation rule.

Terminal statuses — `completed`, `failed`, `cancelled` — are durable and irreversible under
normal execution. A stale authority cannot resurrect a terminal workflow.

---

## Crash recovery and multi-authority behaviour

Workflow execution is **leaderless** — any compatible authority may advance any eligible
instance; there is no workflow leader, primary node or master process. A short per-instance
lease + fence (reused from the 0.12 `CoordinationProvider`) gates execution ownership; every
durable mutation under ownership is fenced, so a resumed stale owner is refused.

After startup an authority discovers instances that are runnable / retry-due / timer-due /
recoverably waiting and advances them — the application does **not** scan stuck workflows,
call `resumeWorkflow`, re-register timers or re-register event waits for normal supported
recovery. Discovery is bounded and indexed (`status, next_eligible_at`).

**Topology transparency:** the logical workflow result of a valid `WorkflowDef` is identical
whether one authority or N run it, for identical committed semantic history. A process
crash, authority crash, retry, lease expiry or request-routing change does not change the
logical outcome.

---

## Compatibility

> Durable workflow instances are bound to **executable semantic compatibility**. An
> authority whose graph changes the executable meaning of the workflow must fail closed
> rather than continue the instance under changed semantics.

A running instance durably stores the `AuthorityCompatibilityKey` (`{ schemaVersion,
schemaFingerprint, serverContract, semanticFingerprint }`) at creation, in the same
transaction that creates it. Before **any** semantic step — action invocation, event match,
timer fire, branch evaluation, retry, `complete` / `fail`, or a cancellation that would
transition the instance — an authority checks that key against its own. If it differs the
authority **refuses**: no `instanceRevision` advance, no `ActionDef` invocation, no event or
timer transition, no binding write. The instance is left exactly as it stands for a
compatible authority to resume; incompatibility is an execution-environment condition, never
an automatic `failed` or `cancelled`.

`semanticFingerprint` covers `WorkflowDef` executable meaning: `inputs`, `bindings`, `entry`,
every step's kind and control-flow edges, and step-specific semantics — the `ActionDef` /
`EventDef` a step targets (and, transitively, those definitions' own bodies), an `action`
step's argument expressions / `retry` policy, a `wait-event` step's `where` / `bind` /
`timeout`, a `timer` step's `after` / `at`, a `branch` step's `when` and edges, and
`complete` / `fail` output/error expressions. It is computed from `core`'s single
`EXECUTABLE_KINDS` list, so it and the authority-compatibility fingerprint cannot disagree.

- **Semantically incompatible workflow definitions fail closed.** Changing any of the above
  while an instance is in flight strands that instance on incompatible authorities.
- **Presentation-only changes stay compatible.** `name`, `description`, `label` — anywhere
  in the workflow — move no fingerprint. Step *declaration order* is not semantic either
  (control flow is by explicit edges).
- **Authority / process identity is irrelevant.** A fresh process running a semantically
  identical build recovers the instance normally; topology and authority count may change
  freely.
- **Workflow migration across incompatible definitions is not provided in 0.14.** An old
  instance waits for a compatible authority; there is no instance upgrader, step remapping
  or binding migration, and none is inferred ("closest step" recovery never happens).
- A graph with **no** `WorkflowDef` compiles to the byte-identical `axiom.server.v1`–`v7`
  document it always did, and its `semanticFingerprint` / `schemaFingerprint` are unchanged.
- Pre-`0.16.0-alpha.1` instances carry a compatibility key computed before `WorkflowDef`
  participated; a corrected authority treats them as incompatible and fails closed (these
  are pre-freeze alpha releases — silent reinterpretation is the only unacceptable
  outcome).

---

## Inspection

`server.getWorkflow(instanceId)` / `server.inspectWorkflows(limit)` return the semantic
fields — `status`, `currentStepId`, `activationId`, `attempt`, `waitingReason`,
`nextEligibleAt`, `createdAt`, `updatedAt`, `instanceRevision`, `failure`, `output`,
`compatible` (whether *this* build may advance it; `incompatibleReason: 'incompatible-build'`
when not) — and **no** secrets (no HMAC keys, database paths, raw SQL, credentials).
Read-only inspection of an incompatible instance stays available so an operator can see
*why* it is not progressing rather than finding it silently stuck.
`server.workflowHistory(instanceId)` is the durable semantic transition log (`started`,
`step-activated`, `step-succeeded`, `step-failed`, `retry-scheduled`, `event-matched`,
`timer-fired`, `timeout-fired`, `branch-chosen`, `completed`, `failed`, `cancelled`) — a
bounded record, not an event-sourcing requirement.

`AgentAPI.analyzeWorkflow(workflowId)` is the static, graph-derived view: inputs, entry,
every step and its edges, the `ActionDef` / `EventDef` dependency sets, timer waits, branch
conditions, retry policies, the reachable terminal outcomes, acyclicity, and the kinds of
`waitingReason` an instance can produce.

---

## `WorkflowStore`

A provider-independent durable persistence abstraction: `createIdempotent`, `load`,
`loadByStart`, `transition` (fenced CAS), `recordActionOutcome` / `loadActionOutcome`,
`recoverRunnable`, `findEventWaits`, `history`, `list`. `createMemoryWorkflowStore()` is the
single-process reference; `createSqliteWorkflowStore({ location })` is the real cross-process
reference — independent OS-process connections, `BEGIN IMMEDIATE` with the revision + fence
check *inside* the transaction, `busy_timeout` + bounded retry so `SQLITE_BUSY` never
surfaces as application semantics, and `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`
init so concurrent startup is safe. No SQLite path / table / rowid / WAL position appears in
the contract or the graph.

---

## Portability

`axiom.conformance.v8` (`conformance/workflow/`) is the portable tier. A fixture is a
compiled `axiom.server.v8` Server IR + start arguments + a deterministic driver script
(advance the virtual clock, deliver an event, mark an action outcome) + the **required
ordered logical transition history** and terminal state. `runWorkflowConformanceFixture` /
`runWorkflowConformanceSuite` run it over the in-memory store; physical attempts may be
duplicated, the logical history must match exactly. A future independent runtime implements
the fixtures from the contract alone.

---

## Limitations

- The deferred step kinds above are not available.
- 0.14 has no `wait-query` (a workflow does not wait on a `QueryDef` result).
- Cancellation cannot interrupt an already-dispatched physical external effect; the
  framework stays honest about uncertain physical execution.
- **Physical** effect execution remains at-least-once (the effect system's contract); only
  the *logical* ActionDef invocation and each workflow step transition are exactly-once.
- The durable event journal and the durable idempotency table are **bounded** buffers
  (default 8192 journal entries / an idempotency window per authority config). They cover
  crash and failover windows, not indefinite history; a wait parked longer than the journal
  is retained past its `sinceEventSeq` is an implementation-owned retention concern.
- `WorkflowStore` bounded retention of terminal instances and history is
  implementation-owned; an active workflow never expires.
- Structurally invalid workflow IR (unknown step kind, dangling edge, malformed
  timer/terminal, missing entry) is refused at authority admission — `createAxiomServer`
  throws `WorkflowIRError` rather than starting with a workflow it cannot execute. Malformed
  step input to `validateGraph` produces a `WORKFLOW_INVALID_STEP` diagnostic, never a
  native error.
