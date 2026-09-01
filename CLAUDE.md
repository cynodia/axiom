# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

Axiom is a research prototype of an **AI-native web application framework**. The
hypothesis is that an application should be stored as a **typed semantic graph**, not as
human-oriented source files: agents modify the graph, and a generic compiler and runtime
turn it into a working browser application whose generated JavaScript nobody reads.

* `specs/spec.md` — the 0.1 vision, research goals and metrics.
* `specs/spec2.md` — the 0.2 architecture: domain-independent compiler and runtime.
* `specs/spec3.md` — the 0.3 architecture: semantic mutation and addressing.
* `specs/spec4.md` — the 0.4 architecture: collection semantics and transactional iteration.
* `specs/spec4.1.md` — the 0.4.1 hardening release: mutation-path-independent rules,
  presence semantics, strict collection nulls and trustworthy dependency analysis.
* `specs/spec5.md` — the 0.5 presentation & UX semantic layer: semantic roles, layout and
  spacing tokens, device classes, themes, value formatting and accessible structure.
* `specs/spec5.1.md` — the agent-optimized documentation overhaul: `docs/` is a machine-facing
  operational contract, not a tutorial set.
* `specs/spec5.2.md` — the 0.5.2 presentation & UX hardening: render-instance identity, action
  diagnostics as semantic UI, theme-owned control affordances, and a type scale separate
  from the document outline.
* `specs/spec6.md` — the 0.6 server authority & persistent runtime: state authority, a
  portable Server IR, an authoritative runtime, persistence, a semantic protocol and
  authorization.
* `specs/spec6.1.md` — the 0.6.1 server runtime hardening & IR contract freeze: a working
  generated browser client for remote authority, a defined startup lifecycle, the `changes`
  contract, request-identity isolation, and `axiom.server.v1` frozen as a language-independent
  contract with published schemas and addressable conformance fixtures.
* `specs/spec7.md` — the **0.7 semantic UI authoring layer: `@cynodia/axiom-ui` published,
  declaration-owned expansion with drift and materialization, `entity-form` covering create
  *and* edit, options sources, expression-capable pattern text, canonical `group` and named
  reusable expressions, and real-browser dialog conformance**.
* `specs/spec8.md` — the **0.8 integrations, effects & triggers release**: `IntegrationDef`/
  `IntegrationOperationDef` (query vs effect), `integration-query`/`integration-effect`
  operations, the post-commit transactional-outbox effect model, `TriggerDef` (interval,
  delay, lifecycle, event) invoking ordinary actions under a system principal, `EventDef`
  and the semantic event pipeline, and `axiom.server.v3`.
* `specs/spec8.1.md` — the **0.8.1 integration & trigger hardening release**: runtime-owned
  (not adapter-cooperative) `integration-query` timeout, `ActionDef.invocation
  .allowedSources` closing the client/system invocation-source trust gap, deterministic/
  real-host scheduling parity for simultaneous triggers, `CLIENT_TRIGGER_UNSUPPORTED`
  rejecting a trigger kind the intended runtime cannot execute, the structured effect-outcome
  envelope (`effectOutcomeEntity`), and `axiom.server.v4`.
* `specs/spec8.2.md` — the **0.8.2 integration & trigger polish / contract-clarity
  release**: `validateForBrowser` alongside the deliberately target-neutral
  `validateGraph`, `effectLog()` reporting `running`/`attempts` truthfully while an adapter
  call is outstanding, the full effect-outcome envelope and `EFFECT_CORRELATION_ID_FIELD`
  documented field by field, `getTriggeredEvents()` replacing the misleadingly-named
  `getWebhookEvents()`, `retryable` absent/true/false semantics documented and tested, the
  conformance manifest's `contract` field renamed to `baseContract`, and the portable
  conformance suite expanded to 24 fixtures with a public `runConformanceFixture`/
  `runConformanceSuite` reference runner. No new IR vocabulary; `axiom.server.v4` remains
  latest.
* `specs/spec9.md` — the **0.9 external I/O & streaming release**: `SubscriptionDef` as the
  third external-interaction direction (the world → Axiom) delivering into the existing
  `EventDef` → `TriggerDef` → `ActionDef` pipeline, a six-state subscription lifecycle with
  runtime-owned reconnect policy, at-least-once delivery with restart-durable deduplication,
  bounded queues and four explicit backpressure policies, `StorageDef` + `BlobRef` for
  portable binary object storage with declared read/upload authorization and a
  staged-then-committed lifecycle, the `blob-metadata`/`blob-commit`/`blob-delete`
  operations, and `axiom.server.v5`. Reports:
  `AXIOM_0_9_IMPLEMENTATION_REPORT.md` and `AXIOM_0_9_IO_RESEARCH.md`.
* `specs/spec10.md` — the **0.10 semantic data access & query layer**: `QueryDef` (a
  demand-driven read over authoritative data too large to materialize — fixed named clauses,
  every leaf an ordinary `Expression`), `RelationshipDef` (explicit, never inferred),
  `ReadPolicyDef` (row-level; field-level deferred) AND-ed into every query's effective
  filter on the authority, the `DataProvider` contract with `createMemoryDataProvider` and
  `createSqliteDataProvider` reference providers, opaque fingerprinted keyset cursors, a
  `query` action operation and a `provider-record` `Location` for transactional mutation of
  never-materialized rows, a client `createQueryStore` lifecycle, a principal/policy
  fingerprinted result cache, `axiom.server.v6` and the `axiom.conformance.v4` fixture
  format. Reports: `AXIOM_0_10_IMPLEMENTATION_REPORT.md` and `AXIOM_0_10_QUERY_RESEARCH.md`.
  Full model: `docs/QUERIES.md`.
* `specs/spec11.md` — the **0.11 schema evolution & semantic migrations**: `graph.schemaVersion`
  (a monotonic integer) and a deterministic `schemaFingerprint` over persistence-relevant
  structure only; `MigrationDef` with a closed vocabulary of ten operations and pure
  `Expression` transforms read in the `MIGRATION_OLD_SCOPE`; a classified `diffSchema` +
  `migrationCoversDiff`; `axiom.server.v7`; the server planner (`planMigration` /
  `explainMigration`), the durable `MigrationMetadataStore` + lease lock, a keyset-batched
  crash-resumable executor (`runMigration`), memory + SQLite `MigrationRowStore`s with
  verified parity; `executeMigration` under a host-minted `MigrationPrincipal` with explicit
  destructive approval; the `createAxiomServer` startup gate (no hopeful start);
  `getMigrationStatus`; cursor + query-cache invalidation on migration; the
  `axiom.conformance.v5` fixture tier; AgentAPI `inspectSchema` / `diffSchema` /
  `migrationImpact`; the string builtins `trim` / `substring-before` / `substring-after`
  (v7). Reports: `AXIOM_0_11_IMPLEMENTATION_REPORT.md` and `AXIOM_0_11_MIGRATION_RESEARCH.md`.
  Full model: `docs/MIGRATIONS.md`.
* `specs/spec12.md` — the **0.12 distributed authority release**: N authority processes over
  one shared persistence provider, no graph change, no application code aware of a cluster —
  "one authority ≈ N authorities" for committed state and all framework-owned async work.
  A `CoordinationProvider` (memory + SQLite reference) issuing durable, leased, **fenced**
  per-work-item ownership claims (`generation` — expiry authorises nothing, only a reclaim
  fences); a generic `DurableWorkStore` claim state machine (logical/physical split,
  `uncertainAttempts`); the multi-authority outbox (`createDistributedEffectRunner` — exactly-once
  logical creation, at-least-once physical execution, exactly-once durable completion,
  idempotency key = `logicalEffectId`, durable retry); the distributed scheduler
  (`scheduleId@dueInstant` firing identity, `catchUp`); `ExternalEventDedupStore`
  (`source + externalEventId`, `EVENT_ID_CONFLICT`); `SubscriptionCursorStore` (per-subscription
  order, fenced monotonic cursor); durable-revision cache coherence (`CACHE_COHERENCE`,
  staleness bound 0); the versioned `semanticFingerprint` + `AuthorityCompatibilityKey`
  (fail-closed mixed-build refusal, `INCOMPATIBLE_AUTHORITY`); `createAxiomServer` wiring +
  host config knobs + `server.authority()` / `inspectDistributedWork()`; AgentAPI
  `inspectDistributedSemantics()`; **Server IR retained at `axiom.server.v7`** (0.12 adds no IR
  vocabulary); the `axiom.conformance.v6` tier + `runCoordinationConformanceSuite`; real-OS-process
  race/chaos/8-authority/large-queue tests. Reports: `AXIOM_0_12_IMPLEMENTATION_REPORT.md` and
  `AXIOM_0_12_DISTRIBUTED_RESEARCH.md`. Full model: `docs/DISTRIBUTED_AUTHORITY.md`.
* `specs/spec12.1.md` — the **0.12.1 distributed state coherence hardening** release, closing
  four Phase 20 blind-regression findings: **F1** (release-blocking) — a running `AxiomServer`
  now treats its in-memory `StateDef` as an authority-local cache and re-observes the durable
  `persistence.revision()` before every authoritative operation (`ensureStateCoherent` in
  `server.ts` — `handle(SnapshotRequest)`, `invokeCore`, the `!outcome.committed` recovery
  path, `start()`), reloading when behind; a lost optimistic race returns `CONCURRENCY_CONFLICT`
  and the authority reconciles instead of wedging. New async `server.coherentSnapshot()`; the
  sync `snapshot()`/`getState()` are documented as the local view as of the last request.
  **F2** — `createSqlitePersistence` wraps every statement in `runWithBusyHandling` + `PRAGMA
  busy_timeout` (new `busyTimeoutMs` option); no raw `SQLITE_BUSY`/`ERR_SQLITE_ERROR` escapes,
  residual contention on commit is a refused `CommitOutcome`. **F3** — `validateTypeRef` /
  `containsGroupType` / `describeType` are null-safe; a malformed `TypeRef` is `INVALID_TYPE_REF`,
  never a thrown `TypeError`. **F4** — `AxiomServer.inspectDistributedWork()` gains `.schedules`;
  `inspectDistributedSemantics()` pointers all resolve and it gains `stateCoherence`. No new
  graph/IR vocabulary; Server IR stays `axiom.server.v7`, conformance stays `axiom.conformance.v6`,
  `schemaFingerprint`/`semanticFingerprint` unchanged. Named regressions:
  `distributed-state-coherence*.test.ts`, `sqlite-persistence-contention.test.ts` (real OS
  processes). Report: `AXIOM_0_12_1_IMPLEMENTATION_REPORT.md`.
* `specs/spec13.md` — the **0.13 realtime / live canonical queries release**: a `QueryDef`
  result observed over time. `AxiomServer.openLiveQuery` / `resumeLiveQuery` / `closeLiveQuery`
  / `inspectLiveQueries` return an `AsyncIterable<LiveQueryMessage>` (`initial` → `update`
  (`LiveQueryDelta`) / `reset` / `error` / `closed`) — no application transport, polling,
  broadcast, fan-out, sticky routing or diffing. Pure graph analysis in **core**
  (`live-query.ts`): the canonical delta model `insert`/`remove`/`update`/`move`/`reset`
  (`diffResults` / `applyDelta`, recompute-and-compare, `move` only for a real relative-order
  change via LCS), conservative static `queryDependencies` / `commitAffectsQuery` (`broad` on
  an unresolved `ref`), and `queryLiveCapability` (`live-capable` / `live-capable-reset-only`
  for aggregate|grouped|no-identity / `not-live-capable` for `now`|`uuid`). **server**
  (`live-query.ts`, `live-query-channel.ts`, `live-query-conformance.ts`): `LiveQueryIdentity`,
  the HMAC-sealed fail-closed `axiom.live-query-cursor.v1` (server-sent, no ACK; bound to
  query / principal / arguments / policy / `{ serverContract, schemaFingerprint,
  semanticFingerprint }`), `createLiveQueryEngine` (revision-driven re-evaluation, coalescing,
  bounded slow-consumer → `reset`), a bounded `LiveSubscriptionStore`, the idle-authority
  `liveQueryPollMs` revision poll for remote commits, `serveLiveQueryChannel` /
  `createLiveQueryChannelClient` / `createInMemoryChannelPair` (transport glue, not
  normative). `AgentAPI.analyzeLiveQuery`. New `axiom.conformance.v7` tier
  (`conformance/live/`, `runLiveQueryConformanceFixture` / `Suite` — folds the stream and
  asserts equality with a fresh one-shot execution). **No new graph vocabulary; Server IR
  stays `axiom.server.v7`** (`semanticFingerprint` is computed *from* the IR). Also fixed a
  spec12.1 F1-class defect in passing: `createSqlitePersistence.commit` read its optimistic
  conflict check *outside* `BEGIN IMMEDIATE`, so two OS processes could both pass it and both
  commit — a lost write. Real-process test: `live-query-cross-process.test.ts`. Reports:
  `AXIOM_0_13_IMPLEMENTATION_REPORT.md` and `AXIOM_0_13_LIVE_QUERY_RESEARCH.md`. Full model:
  `docs/LIVE_QUERIES.md`.
* `specs/spec13.1.md` — the **0.13.1 live query invalidation coherence hardening** release,
  closing two Phase 21 blind-external regression findings (`D2 / E1 / S3`). **F1**
  (release-blocking) — a `provider-record`-only Axiom commit was not observable
  cross-authority: it never advanced `persistence.revision()`, so a remote authority's
  live-query poll never fired (0.13.0 masked this in its own test with a `StateDef` "sync
  pulse"). Fix: an **observable application revision** projected from two durable sources —
  `stateRevision` (`persistence.revision()`) and `dataGeneration` (Σ of each
  `DataProvider.observedMutationGeneration()`, a monotone counter the SQLite provider
  advances **inside** the same `BEGIN IMMEDIATE` as `applyMutations`, so rows + evidence are
  atomic — no crash gap; the memory provider does it in-process).
  `ProviderCapabilities.mutationObservation` (`'durable'` / `'in-process'` / `'none'`);
  `openLiveQuery` on a writable `'none'` provider → `LIVE_QUERY_PROVIDER_NOT_OBSERVABLE`. The
  server's `applicationRevision` (local monotone, not cross-authority comparable) is what the
  live engine + cursor use; `AxiomServer.revisionInspection()` exposes the three distinctly.
  The idle poll re-observes both sources. **F2** — a `QueryDef` clause (or `ReadPolicy`
  predicate) referencing a `StateDef` passed `validateGraph`, was advertised as a live
  dependency, then silently evaluated wrong (the provider binds no authority state). Fix:
  `queryStateReferences` + `QUERY_STATE_REF_NOT_ALLOWED` — `validateGraph` /
  `compileToServerIR` reject it, `queryDependencies` routes it to `unsupportedStateRefs`
  (never `stateIds`), `queryLiveCapability(query, idField, knownStateIds?)` /
  `AgentAPI.analyzeLiveQuery` report `not-live-capable`, and a runtime guard catches a
  hand-built IR. Bind runtime-varying values as query parameters. **No new graph/IR
  vocabulary**; Server IR stays `axiom.server.v7`, `semanticFingerprint` / `schemaFingerprint`
  unchanged for valid graphs; conformance stays `axiom.conformance.v7` (additive fixtures:
  `provider-only-sequence`, `f2-state-ref-refused`). `createSqliteDataProvider` gains a
  durable `_axiom_provider_meta` generation row + concurrent-startup-safe init. Real-process
  tests in `live-query-cross-process.test.ts` (exact F1 repro, no-sync-pulse, crash-after-
  provider-commit, 8-authority concurrent startup) + `live-query-invalidation.test.ts`.
  Report: `AXIOM_0_13_1_IMPLEMENTATION_REPORT.md`, design note
  `AXIOM_0_13_1_INVALIDATION_RESEARCH.md`.
* `specs/spec14.md` — the **0.14 durable workflows release**: a first-class `WorkflowDef`
  graph node (kind `workflow`, `packages/core/src/workflows.ts`) — six portable steps
  (`action`, `wait-event`, `timer`, `branch`, `complete`, `fail`), **no script body**, no
  mutable blob (typed single-assignment `WorkflowBinding`s), closed expression scope (inputs
  / bindings / `EVENT` / `PRINCIPAL`; never `StateDef` / `QueryDef` / `now`·`uuid`·`random`).
  `validateWorkflow` + 15 `WORKFLOW_*` diagnostics (entry / step ids / edges / cycle /
  action & event refs / binding single-assignment / retry / timer / reachability / terminal
  reachability / expression scope / nondeterminism). **Server IR `axiom.server.v8`** (v1–v7
  frozen; a graph with no workflow is byte-identical and its `semanticFingerprint` is
  unchanged — `'workflow'` joins `EXECUTABLE_KINDS`, empty group skipped).
  `WorkflowStore` (`packages/server/src/workflow-store.ts`) — `createMemoryWorkflowStore`
  (single-process ref) + `createSqliteWorkflowStore` (cross-process ref: `BEGIN IMMEDIATE`
  with the `instanceRevision` + `fence` check **inside** the transaction, `busy_timeout`,
  `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` init). `createWorkflowEngine`
  (`workflows.ts`) — leaderless: `advance(instanceId)` under a reused 0.12
  `CoordinationProvider` lease+fence, every transition a fenced CAS; start idempotency on
  `WorkflowStartIdentity`; action step with stable logical invocation id
  `<instanceId>/<activationId>` (used as the `ActionDef` request id for crash
  reconciliation); Model-B no-gap event wait (registration committed with the transition,
  `sinceEventSeq` boundary, replay on startup, dedup unchanged); timer target captured once;
  durable retry backoff (`nextEligibleAt`); cancellation as a fenced durable transition (not
  rollback); crash-recovery poll loop (`recoverRunnable`). `createAxiomServer` wiring:
  `startWorkflow` / `cancelWorkflow` / `getWorkflow` / `inspectWorkflows` / `workflowHistory`,
  event-pipeline `onEventAccepted` hook, `workflowStore` option. `AgentAPI.analyzeWorkflow`.
  New **`axiom.conformance.v8`** tier (`conformance/workflow/`, 13 fixtures + 2 negative
  controls, `runWorkflowConformanceFixture` / `Suite` — deterministic driver script, folds
  to the required logical transition history). Reports:
  `AXIOM_0_14_IMPLEMENTATION_REPORT.md`, design note `AXIOM_0_14_WORKFLOW_RESEARCH.md`. Full
  model: `docs/WORKFLOWS.md`.
* `specs/spec14pt2.md` — the **0.14 pre-publish corrective pass** closing the two remaining
  crash-safety gaps before publish. **F1** — the workflow action step's ActionDef invocation
  is now durably exactly-once across a **full process restart**: `invokeCore` commits a
  `PersistenceCommit.idempotency` record `{ key, response }` in the *same* transaction as the
  state writes (`loadIdempotentResponse` / `recordIdempotentResponse` on both the memory and
  SQLite `PersistenceAdapter`s; `axiom_state_idempotency` table, bounded). A recovery
  authority with no in-memory request cache proves the invocation already committed and
  recovers its canonical outcome instead of re-executing. **F2** — accepted events are held
  in a **durable cross-authority journal** on the `WorkflowStore` (`appendAcceptedEvent` /
  `readAcceptedEventsSince` / `latestAcceptedEventSeq` / `pendingEventWaits`;
  `axiom_workflow_event_journal` with an `AUTOINCREMENT` store-global `seq`, bounded), so a
  match survives the death of the authority that routed the event — the engine's
  `onEventAccepted(eventId, payload)` (no caller-supplied seq) journals then routes, and the
  poll loop / startup replays the journal against every `pendingEventWaits` instance from its
  durable `sinceEventSeq`. The workflow engine honours the configured coordination
  `leaseDurationMs`. New real-OS-process suite `workflow-crash-matrix.test.ts` (F1 SIGKILL
  ×50, F2 Case A SIGKILL ×50, Case B wait-vs-event race ×50 deterministic classification,
  Case C duplicate/restart replay, 2- & 8-authority claim races, SIGSTOP stale-owner fence
  refusal; `AXIOM_WF_TRIALS` tunes the count). **No new graph/IR vocabulary**; Server IR
  stays `axiom.server.v8`, conformance stays `axiom.conformance.v8` (the conformance runner
  drops its unused explicit event seq).
* `specs/spec14pt3.md` — the **0.14 mixed-build compatibility closure** (`0.14.0-alpha.2`),
  closing Phase 22 **F3** (release blocker) + two hardening findings. **F3** — the
  authority-side `serverIrSemanticProjection` (`packages/server/src/authority-identity.ts`)
  was a hand-maintained slice list that never gained `workflows` when spec14 added them, so
  a workflow semantic change (action / event target, `where`, `branch` predicate, `timer`
  duration, `retry`, control-flow edge) moved `semanticFingerprint(graph)` but **not** the
  enforced `AuthorityCompatibilityKey.semanticFingerprint` — an incompatible authority
  silently advanced an in-flight instance. Fix: `EXECUTABLE_KINDS` is exported from
  `core/semantic-identity.ts` as the single source of truth; `serverIrSemanticProjection`
  now iterates it via `SERVER_IR_EXECUTABLE_SLICES` (a `server` test pins every kind is
  covered), and both projections pass workflows through `core`'s
  `canonicalWorkflowForFingerprint` (step / input / binding order is not semantic). The
  `workflows` slice is emitted only when non-empty, so every non-workflow graph's fingerprint
  is byte-identical to alpha.1. Transitive `ActionDef` / `EventDef` changes are covered by
  construction (the whole slice is hashed). Instance enforcement (fail closed *before* any
  semantic step, `startWorkflow` refuses an existing incompatible instance, `cancelWorkflow`
  is compat-gated, `WorkflowInspection.compatible` / `incompatibleReason`) uses `isCompatible`
  — a missing / empty stored fingerprint is incompatible. **F1** — `core/workflows.ts`
  accessors are total over malformed input (`isWorkflowStep` guard + `default` cases);
  `validate.ts` `.id` reads are null-safe; a bad step is `WORKFLOW_INVALID_STEP`, never a
  native `TypeError`. **F2** — `workflowStructuralProblems` (new `core` runtime-boundary
  check) runs at engine admission; `createWorkflowEngine` / `createAxiomServer` throw
  `WorkflowIRError` on structurally invalid workflow IR rather than reaching a wedge. New
  tests: `workflow-compat.test.ts` (in-process) + real-OS-process
  `workflow-mixed-build.test.ts` (semantic B refuses ×25 with compatible-A2 recovery,
  presentation-only B continues ×25, 2-/8-authority mixed topology; `AXIOM_WF_MIXED_TRIALS`).
  **No new graph/IR vocabulary**; Server IR stays `axiom.server.v8`, conformance stays
  `axiom.conformance.v8`; `SEMANTIC_FINGERPRINT_VERSION` unchanged (non-workflow fingerprints
  frozen).
* `specs/spec14pt4.md` — the **0.14 workflow input totality & structural validation closure**
  (`0.14.0-alpha.3`), closing the narrow Phase 22 **F1 / F2 residuals** the focused external
  retest of alpha.2 found. **F3 architecture is untouched** — the only edits to compatibility
  code add `Array.isArray` / `typeof` guards that are no-ops for valid input, so no valid
  graph's `semanticFingerprint` moves. **F1** — `AgentAPI.analyzeWorkflow` read `step.id`
  before proving the step's shape; it now runs the shared total `workflowStructuralProblems`
  first (structured `Error`, never a native `TypeError`) and filters traversal through
  `isWorkflowStep` / `Array.isArray`. **F2** — `workflowStructuralProblems` is now total over
  `unknown` (proves `workflow` is an object and `steps` / `inputs` / `bindings` are arrays of
  the right shape *before* any traversal) **and** checks reference integrity: a `wait-event`
  `bind` key must be a declared `WorkflowBinding` (`WORKFLOW_BINDING_NOT_FOUND`), every
  `WorkflowBinding.producedBy` must resolve to a step, every workflow expression `ref` must
  resolve in that location's closed scope (`WORKFLOW_EXPRESSION_SCOPE`), no `now`/`uuid`/
  `random` (`WORKFLOW_NONDETERMINISTIC`). `createWorkflowEngine` guards a non-array
  `workflows`; `createAxiomServer` routes any non-`undefined`, non-empty-array `ir.workflows`
  into the validator unchanged (never `?? []`); `sortedList` / `sortedRecord` /
  `canonicalWorkflowForFingerprint` / `workflowExpressions` are total over a tampered slice;
  `advance` wraps `runStep` in try/catch (defense in depth — a corrupt instance fails
  terminally, never an infinite `running` poll). The former "invalid ref → permanent
  `running` wedge that survives restart" is impossible: admission fails, so there is no
  instance. New tests: `agent-api/test/workflow.test.ts` (+3) + `server/test/workflow-ir-totality.test.ts`
  (+6: 17 container tamper shapes + 10 reference tamper shapes → `WorkflowIRError`, `native
  TypeError = 0`). **No new graph/IR vocabulary**; Server IR stays `axiom.server.v8`,
  conformance `axiom.conformance.v8`, `SEMANTIC_FINGERPRINT_VERSION` unchanged.

Together, spec2–spec14 are the authority on design decisions — **except where the
implementation already differs**. For existing behaviour the implementation is
authoritative, and `docs/` describes the implementation.

A handful of rules govern almost every decision:

> **Domain independence** (spec2 §2.4) — `core`, `compiler`, `runtime` and `agent-api`
> must contain no knowledge of any application domain. A new application is a new graph,
> never a framework change.

> **Addressed mutation** (spec3 §3) — no application state may be changed by mutating the
> JavaScript object some expression happened to return. Expressions produce values;
> **locations** name writable positions.

> **No silent semantic failure** (spec4 §4) — a construct that is publicly declared,
> typechecks and passes `validateGraph` must have defined runtime behaviour. If the
> runtime cannot execute something, validation has to reject it. A construct that
> validates and then quietly does nothing is a release-blocking defect.

> **Expressive power arrives as structure** (spec4 §41) — when Axiom gains capability, it
> gains an inspectable semantic node, never a callback. No `formatter: fn`, no
> `validator: fn`, no stored closures. The graph stays serializable and analyzable.

> **Rules bind the state, not the path** (spec4.1 §2) — if the graph says a business rule
> holds, every governed write path must be unable to violate it. Correctness may never
> depend on an author remembering "do not bind an input to that location".

> **Presentation is intent, not CSS** (spec5 §3) — the graph says `role: 'destructive'`,
> `gap: 'medium'`, `responsive: { compact: … }`. It never says a colour, a length, a media
> query or a CSS property, and `PresentationHints` must not become a bag of them. A theme
> is the only place concrete values live, and a theme can never change behaviour.

> **Presentation does not authorize behaviour** (spec5 §75) — hidden is not prohibited. A
> rule belongs in a precondition or a transition constraint; no UX metadata may stand in
> for one.

> **OS I/O primitives are not graph vocabulary** (spec9 §40-42) — no path, socket, stream,
> file descriptor or subprocess, ever. `readFile(path)`, `openSocket(host, port)` and
> `exec(command)` do not exist and will not be added. Low-level I/O belongs *inside* an
> adapter, which is exactly what lets a Rust runtime execute the same graph with different
> primitives. The graph says "receive device status updates" and "store this attachment";
> the adapter decides whether that is MQTT or a WebSocket, a directory or S3.

These are enforced by tests, not convention: `packages/core/test/architecture.test.ts`
scans framework sources for application vocabulary, `packages/runtime/test/store.test.ts`
checks that state writes stay confined to the mutation subsystem, and
`packages/compiler/test/presentation.test.ts` checks that no CSS reaches the IR.

## Commands

Requires **Node ≥ 22** — `npm test` relies on the test runner's native glob expansion of
`dist/test/**/*.test.js`, which Node 20 and earlier do not support.

```bash
npm install
npm run build               # tsc -b across all workspaces; also writes both demo pages
npm test                    # runs node:test over COMPILED output — build first, always
npm run test:browser        # real-Chromium dialog conformance; FAILS if Playwright is absent

npm run conformance:generate # rewrite packages/server/conformance/*.json + manifest.json
npm run conformance:run      # run the whole suite through the public runConformanceFixture API only
npm run schema:generate      # rewrite packages/server/schema/*.json
npm run toolkit:catalog      # rewrite packages/ui-toolkit/docs/PATTERN_CATALOG.json
npm run toolkit:metrics      # re-measure authoring compression into packages/ui-toolkit/metrics.json

# CLI (after a build) — a PRIVATE development tool of this repository, never published.
# Takes a compiled module that exports a graph or a builder.
node packages/cli/dist/index.js inspect  packages/demo/dist/inventory.js --export=createInventoryGraph
node packages/cli/dist/index.js validate packages/demo/dist/issue-tracker.js --export=createIssueTrackerGraph
node packages/cli/dist/index.js build    packages/demo/dist/issue-tracker.js --export=createIssueTrackerGraph
node packages/cli/dist/index.js serve    packages/demo/dist/inventory.js --export=createInventoryGraph --port=3000

# Schema evolution (spec11). `<model>` is a compiled module exporting a graph or a builder.
node packages/cli/dist/index.js schema status  packages/demo/dist/order-management-history.js --export=createOrderHistoryGraphD
node packages/cli/dist/index.js schema diff    packages/demo/dist/order-management-history.js --export=createOrderHistoryGraphD --against=packages/demo/dist/order-management-history.js --against-export=createOrderHistoryGraphA
node packages/cli/dist/index.js migrate plan   packages/demo/dist/order-management-history.js --export=createOrderHistoryGraphD --from=1
node packages/cli/dist/index.js migrate        packages/demo/dist/order-management-history.js --export=createOrderHistoryGraphD --from=1 --approve=op_split_name,op_drop_legacy --sqlite=state.db
node packages/cli/dist/index.js migrate status packages/demo/dist/order-management-history.js --sqlite=state.db
```

`inspect` renders locations in readable form, which is the fastest way to see what an
action actually writes:

```
- receiveStock (action_receive_stock) [writes → products (On hand), reads → products (Id)]
    set products → [Id = id] → On hand
```

There is no linter, formatter, or CI. Match the style of the file you are editing.

## Documentation is part of the contract

`docs/` is the canonical operational contract, written for an unfamiliar coding agent
rather than for a human learner: rule-oriented, MUST/MUST NOT, tables for edge cases, no
tutorial padding. `README.md` is the short entry point; `docs/AGENT_REFERENCE.md` plus the
`.d.ts` declarations are meant to be sufficient on their own.

**One canonical location per semantic rule** (spec5.1 §26):

| Layer | Carries |
| ----- | ------- |
| `README.md` | The mental model, the load-bearing invariants, one runnable example, the map. |
| `docs/AGENT_REFERENCE.md` | The compressed reference, including the truth tables. |
| `docs/<TOPIC>.md` | The full contract for that topic. |
| `.d.ts` comments | The local contract of that type. |
| Package READMEs | Responsibility, main exports, a pointer to `docs/`. Nothing else. |

Do not restate a rule in a second place. If a rule changes, change it where it lives and
let the others point there.

**`packages/demo/test/documentation.test.ts` fails on drift in either direction**: a
documented diagnostic code, vocabulary member, imported symbol or called method that no
longer exists, and an implemented one that is not documented. It also executes the
presence and collection-null truth tables against the runtime, checks every relative link,
and asserts the README example is character-identical to `packages/demo/src/minimal.ts` —
which is compiled and run. Edit one and you must edit the other.

`docs/` ships in the `@cynodia/axiom` tarball: `npm run docs:sync` copies it into
`packages/axiom/docs/` (generated, git-ignored, removed by `release:clean`), and
`scripts/verify-packages.mjs` fails the release if any document is missing from the
tarball. An external consumer must never need repository access to obtain the contract.

**Discoverability is part of the API.** A blind external-agent test found the contract only
after the agent had guessed at the API, failed, searched the web and cloned this repository —
`docs/AGENT_REFERENCE.md` was already installed the whole time. Documentation an unfamiliar
agent cannot discover costs almost as much as documentation that does not exist, so three
files at the facade's package root exist purely to route:

| File | Role |
| ---- | ---- |
| `packages/axiom/README.md` | The npm landing page. Its **first** section after the title is the entry point: what Axiom is, who it is for, `docs/AGENT_REFERENCE.md` as the start, the `.d.ts` as the API contract, and the escalation order. Then the documentation map. |
| `packages/axiom/AGENTS.md` | The cross-vendor agent instruction file. Routing and prohibitions only — never a copy of this file, which is maintainer-facing. |
| `packages/axiom/llms.txt` | The LLM documentation-discovery convention. A compact annotated index, not a second reference. |

All three must name `docs/AGENT_REFERENCE.md` in their first quarter, must reference only
paths the tarball actually contains, and must stay vendor-neutral — `AGENTS.md` and `llms.txt`
are conventions, not one model's file. `scripts/verify-packages.mjs` checks the packed
artifact, `scripts/discoverability-probe.mjs` (`npm run release:probe`) reconstructs what a
cold agent sees from the tarball alone, and the AI-entry-point tests in
`packages/demo/test/documentation.test.ts` check the sources. Adding a document to `docs/`
means adding a row to the facade README's map, or that test fails.

**There is deliberately no consumer-facing `CLAUDE.md` at the package root.** `AGENTS.md` is
the vendor-neutral convention and covers every agent; a second file would either duplicate it
or drift from it, and a `CLAUDE.md` inside `node_modules/@cynodia/axiom` is not auto-loaded by
Claude Code anyway — the file that is loaded is the *consuming project's* own. This `CLAUDE.md`
is maintainer-facing and must never be published.

**Every declared diagnostic code must be reachable.** An agent should never have to
discover a code by causing a failure, which is impossible for a code that can never occur.
Adding a code to `VALIDATION_CODES` or `RUNTIME_DIAGNOSTIC_CODES` means emitting it and
documenting it.

## Packaging and release

Five packages are published to npm under the `@cynodia` scope; `cli` and `demo` are
marked `private` and never ship. Everything is MIT, copyright AskTech AS.

- **Compiled output only.** `files` whitelists `dist/**/*.js`, `dist/**/*.d.ts`, the
  README and the LICENSE. Tests compile to `dist-test/`, not `dist/`, so the publishable
  directory contains no test code by construction — don't move test output back under
  `dist/`. Declaration maps are generated but deliberately not shipped, since the sources
  they point at are not published.
- **No workspace protocol anywhere.** Inter-package dependencies are pinned to the exact
  release version (`"@cynodia/axiom-core": "0.3.1-alpha.1"`). npm still links them locally
  because the workspace version satisfies the range, so a published manifest and a local
  checkout resolve identically. `scripts/verify-packages.mjs` fails the release if a
  `file:`, `link:` or `workspace:` range ever reaches a tarball.
- **Every package keeps its own LICENSE and README** — npm does not inherit them from the
  repository root. The verifier checks the packed copies have not drifted.
- **Version bumps touch every manifest.** The publish script refuses to run if any is out
  of step with the root.

```bash
npm run release:prepare        # clean, build, test, pack, verify tarballs, consumer test
npm run release:publish:dry-run
npm run release:publish        # deliberate and manual; CI never publishes
npm run release:dist-tag       # only to move a tag by hand
```

**One publish sets one tag.** `npm publish` accepts a single `--tag`, so maintaining a
second one costs another registry call per package — whichever order you choose. Every
version of this project is a pre-release, so a separate `alpha` tag would only ever point
where `latest` already points and would carry no information. `release:publish` therefore
publishes as `latest` and nothing follows it; the pre-release signal is the version string
and each README's status line.

Note that npm claims `latest` on a package's first publish whatever `--tag` says, and will
not let it be deleted — so `latest` exists regardless. Publishing to it directly is simply
admitting that. Check with `npm view @cynodia/axiom dist-tags` rather than assuming.

`scripts/dist-tag-lib.mjs` holds the tag logic, shared with `npm run release:dist-tag`, for
repairing a tag or introducing a second one when a stable line eventually exists. It also
removes one:

```bash
npm run release:dist-tag -- --tag=alpha --rm --dry-run   # show what would go
npm run release:dist-tag -- --tag=alpha --rm             # remove it everywhere
```

A tag left behind is worse than no tag. `alpha` was set by the 0.6.0 release and then frozen
there when publishing switched to `latest`, so `npm install @cynodia/axiom@alpha` kept handing
out 0.6.0 with nothing about the install saying so. Either keep a second tag in step on every
release — one extra registry call per package, for a tag that can only ever point where
`latest` points — or remove it. `latest` cannot be removed; npm creates it on first publish
and refuses, which the script checks before trying.

`release:prepare` ends with `scripts/consumer-test.mjs`, which builds a project in a temp
directory from the tarballs alone — no workspace links, no path aliases, no relative
imports into the repo — and runs a Counter application written against the public API. If
you change what a package exports, that test is what proves an outside consumer can still
use it. `release:publish` additionally requires a clean git tree (`--allow-dirty` to
override), `npm whoami` to be `cynodia`, and a pre-release version, and publishes the
verified tarballs as `latest` — see **One publish sets one tag** above.

**Two-factor authentication.** The npm account has 2FA, so publishing *and* moving a
dist-tag are both write operations that need it. Let npm authenticate on its own terms:
run the scripts in a real terminal and npm prints a URL, waits for the browser, and the
registry then treats the session as 2FA-satisfied for a few minutes — enough for all five
packages in one go.

Do not reach for `--otp=<code>` unless npm's own flow is unavailable. A typed one-time
password authenticates a *single request*, so a five-package release would need five codes
in sequence, each expiring in about thirty seconds. `scripts/otp.mjs` therefore passes
nothing by default and only falls back to prompting if a command is rejected — pre-empting
npm with `--otp` was exactly what made moving a dist-tag more painful than publishing.

Both scripts skip work already done — a version already on the registry, a tag already
pointing at this release — so re-running after a partial failure is safe. Unattended
automation should authenticate with a granular access token that has "bypass 2FA" enabled
instead; never commit that token, or any credential, including to `.npmrc`.

## Working agreements

- **Add new files to git as you create them.** `git add` every file you introduce in the
  same session you introduce it; a change set that builds only because of untracked files
  is broken for everyone else. Staging is enough — don't commit unless asked.
- Don't commit or push unless the user asks for it.

## Layout

`packages/*`, npm workspaces + TypeScript project references. Dependencies are declared
twice and both must stay in sync: an exact version in `package.json` (never `file:` or
`workspace:` — see **Packaging** below), and a `references` entry in the package's
`tsconfig.json`. Root `tsconfig.base.json` carries `paths` for `@cynodia/axiom*` so editors
and tests resolve to source. Directory names stay short; npm names are scoped.

| Directory   | npm name | Owns |
| ----------- | -------- | ---- |
| `core`      | `@cynodia/axiom-core` | `ApplicationGraph`, node and field definitions, `TypeRef`, expressions, **locations**, edge kinds, validation, type inference, edge derivation, the IR contract, **presentation, themes and presentation resolution**. No dependencies. |
| `agent-api` | `@cynodia/axiom-agent-api` | Semantic queries, mutation impact, transactions, transformations, change sets, presentation and UX queries. |
| `compiler`  | `@cynodia/axiom-compiler` | Validation + normalization into `ApplicationIR`, presentation resolution, the theme stylesheet, and page emission. |
| `runtime`   | `@cynodia/axiom-runtime` | State store, expression evaluation, the mutation subsystem, constraint checking, UI rendering, value formatting, routing. |
| `ui-toolkit` | `@cynodia/axiom-ui` | **Semantic UI authoring**: the five patterns, expansion, provenance, ownership, drift, diff and the machine-readable catalogue. Depends on `core` **only**, and is build-time: nothing it produces reaches a runtime. The directory keeps its research-era name; the npm name is what ships. |
| `axiom`     | `@cynodia/axiom` | The published facade: re-exports the four packages above. It deliberately does **not** re-export `@cynodia/axiom-ui` — an authoring dependency every application carried forever would make materialization untestable. |
| `cli`       | *(private)* | Graph loading, `inspect` / `validate` / `build` / `serve`. |
| `server`    | `@cynodia/axiom-server` | The authoritative runtime: Server IR execution, persistence adapters, integration/subscription/blob adapters, the semantic protocol, transports and the Node host. Depends on `core` and `runtime`. |
| `demo`      | *(private)* | Four applications: `issue-tracker.ts`, `inventory.ts`, `order-system.ts` and `order-server.ts` — plus the real-browser conformance tests, which is why Playwright is a devDependency here and nowhere else. |

Dependency direction is `core ← runtime ← compiler ← cli/demo`, with `agent-api` on `core`
alone, `ui-toolkit` on `core` alone, and `server` on `core` and `runtime`. The toolkit's tests
use the compiler and runtime, which are **not** declared as its dependencies: a published
authoring package must not drag the runtime in, and workspace hoisting resolves them for the
tests. `packages/ui-toolkit/test/architecture.test.ts` pins the published dependency set.

`ServerIR` lives in **core** for the same reason `ApplicationIR` does: it is the contract
*between* the compiler and a server runtime. `ApplicationIR` lives in **core** rather than the
compiler because it is the contract *between* compiler and runtime; putting it in the compiler
would create a cycle.

## The model

**Identity.** `NodeId`, `FieldId` and `EdgeId` are branded string types (`core/ids.ts`).
Build them with `nodeId()` / `fieldId()` / `edgeId()`, or generate with `createNodeId()`.
Fields are independently identifiable, and **instance data is keyed by `FieldId`** — a
record looks like `{ [F_ISSUE_TITLE]: 'text' }`, never `{ title: 'text' }`. Names are
metadata for humans; nothing resolves by name.

**Types are structures, not strings.** `TypeRef` is `primitive | entity | collection |
optional | enum` (`core/type-ref.ts`), with builders `primitiveType()`, `entityType()`,
`collectionType()`, `optionalType()`, `enumType()`.

**Expressions are trees, not text** (`core/expressions.ts`): `literal`, `ref`, `field`,
`object`, `binary`, `unary`, `call`, `filter`, `find`, `map`, `sort`, `every`, `some`,
`flatten`, `conditional`, `group`, `expression-ref`. Every kind has a
builder — never hand-write the discriminated union. A `ref` resolves an **id** against the
scope chain, in order: action parameters → iteration scopes → route parameters → state.
The iteration scope for a `repeat` is the repeat node's own id; for `filter`, `find`,
`map` and `sort` it is the expression's `scopeId`. Evaluation is pure: it never changes
state.

**Presence is not emptiness.** `required(x)` is true for `[]`, `''`, `0` and `false`, and
false only for null and undefined. Emptiness is `is-empty` / `non-empty`, and `coalesce`
falls back only on absence — so falling back to an empty collection works. Field-level
`required: true` likewise means present, not non-blank; express "must not be blank" as a
constraint.

**Collection operators are strict.** `null` is a missing collection and fails the
evaluation; `[]` is an empty collection and behaves normally. Nothing returns a plausible
value alongside a failure diagnostic — a failing expression throws
`ExpressionEvaluationError`, which the runtime catches at each boundary (derivation,
precondition, constraint, operation, render) and turns into a diagnostic. A constraint that
cannot be evaluated counts as violated, never as satisfied.

**Collections also partition.** `group(source, scopeId, by)` takes `Collection<A>` to
`Collection<Group<K, A>>`, read with `groupKey` / `groupItems` — two **reserved field ids**
(`core/group.ts`), because a group is a record and records are keyed by field id. The ordering
contract is semantics, not implementation: groups in first-seen key order, members in source
order, keys compared structurally, `[]` produces no groups and `null` fails like every other
collection operator. Nothing is sorted; `sort` is the operator whose job that is. A group type
may only appear in **derived** state, since nothing can construct one.

**A calculation can be named once and referenced.** An `ExpressionDef` node holds parameters
and a body; `expressionRef(id, args)` evaluates it. Arguments are evaluated in the caller's
scope and **the body in an isolated one** — parameters and state, nothing else — which is what
makes reuse sound and what stops one definition's scope ids from ever meeting a caller's.
Dependency analysis follows definitions, so a consumer's read edges are the same whether the
calculation was inlined or named; `derive-edges.ts` and `authority.ts` both resolve through
them, and an answer that changed with authoring style would be a defect.

**Collections project, aggregate and order.** `map(source, scopeId, projection)` takes
`Collection<A>` to `Collection<B>`; `sum` reduces `Collection<number>` to a number (an
empty collection sums to zero); `sort(source, scopeId, by, direction)` orders by a
projected key. They compose — `sum(map(filter(…), …))` is the shape most aggregate rules
take — and type inference follows the composition, so an aggregation over something that
is statically not numeric is rejected before it ever runs.

**Locations name writable positions** (`core/location.ts`): `state`, `field` (a field of
another location), and `collection-item` (an item of a collection location, selected by
identity — preferred — or by index). Build them with `stateLocation()`,
`fieldLocation()`, `itemLocation()`, `identitySelector()`, or the shorthand
`itemFieldLocation(stateId, identityFieldId, identityValue, fieldId)`. Every location is
structurally traceable to its root state via `locationRootStateId()`; the expressions
inside it (`locationExpressions()`) are read dependencies, and the fields it writes
(`locationFieldIds()`) are write dependencies.

**Nodes.** `entity`, `state`, `action`, `constraint`, `route`, plus the nine UI kinds
(`view`, `container`, `text`, `repeat`, `field-display`, `form`, `input`, `button`,
`conditional`). All of them live in the same graph and are discriminated by `kind`.

**Presentation is metadata on a UI node**, not a node kind of its own: `UIBase.presentation`
carries roles, layout, tokens, device classes, value formats and icons. 0.5 added no UI node
kinds, because a role on an existing node is more inspectable than a new one — see
**The presentation layer** below.

**Behaviour is data.** An `ActionDef` has parameters, guards (a condition paired with the
failure it reports — prefer these to the older positional `preconditions`/`failureModes`
arrays, which the compiler normalizes into), operations, postconditions and failure modes. Operations are `set`, `insert`, `remove` (the three
mutations, each addressing a `Location`), `for-each`, plus `invoke`, `navigate`,
`native`, the two integration operations and the three blob operations. An action runs as a transaction: mutations apply, constraints are then evaluated
against the **proposed state**, and **every mutation rolls back together** if anything
fails. That is public contract now (spec4 §36), not incidental behaviour.

**`for-each` iterates without opening a transaction of its own.** Its nested operations are
mutations only, they run in the action's transaction, and the *collection* is read once
before any member is mutated. Each iteration otherwise reads the latest provisional state,
so two members touching the same record debit it twice (5 → 2 → −1) and the invariant then
catches the total. A failure in the seventeenth iteration unwinds the first sixteen. Locations inside the iteration may use `ref(scopeId)` to address the
canonical record the current member points at — which is how one action reduces stock
across many records without ever aliasing an object.

**Failure modes line up with preconditions by position.** `failureModes[2]` is the message
for the third precondition; a refusal reports `details.preconditionIndex` and
`details.failureMode`, so a refusal says which condition failed rather than always naming
the first.

**Inputs write to a location too.** `InputNode.binding` is `{ location }` — no expression,
no field id. An input change goes through the same mutation engine and transaction as an
action; there is no second write path inside the renderer.

**Canonical state is always valid; drafts need not be.** A UI write whose location is
rooted in ordinary state is transactional with respect to hard invariants: if the value
would break one, the whole mutation rolls back and the control re-renders with what is
actually stored. A write rooted in a `draft: true` state is not guarded, because a draft is
incomplete by definition while it is being filled in — the action that commits it is where
it has to be valid. This is spec3 §38's two editing patterns made enforceable rather than
advisory, and which one an application uses is visible in the graph: look at what the
input's location is rooted in.

**Reads and writes are attributed separately.** A `set` writes the fields its *target*
location names and reads the fields its *value* expression consults; an `insert` writes the
fields the constructed record declares, not the fields read to compute them. Reads follow
iteration scopes and derived collections, so projecting a field inside a `map` over
`coalesce(field(ref(state), lines), [])` is still recorded as a read of that field of that
state. `getMutationImpact` reports `analysisComplete: false` with `analysisGaps` when
something — a native operation with undeclared effects — cannot be analyzed, rather than
presenting a partial answer as exhaustive.

**Edges cannot go stale.** `graph.semanticEdges()` and every `getEdges` query derive
relationships from the current nodes on demand, cached against a revision counter that
every mutation bumps. Nothing has to remember to resynchronize anything, and an AgentAPI
answer can never disagree with the graph. `synchronizeEdges(graph)` still exists to
*materialize* those edges into serialized graph data, but correctness no longer depends on
calling it. Write edges carry `metadata.fieldIds`, and reads are attributed through
iteration scopes — projecting a field inside a `map` is recorded as a read of that field
of the state the members came from.

**Graph reads are deep clones.** Mutating a node you fetched changes nothing — write it
back with `updateNode`.

**Validation is not optional.** `validateGraph` resolves every reference — nodes, fields,
edges, expressions, locations, UI children, route targets — and `compileToIR` throws
`GraphValidationError` rather than compiling an invalid graph. It also rejects writes to
derived state, fields that don't belong to the addressed entity, selectors and iterations
over non-collections, aggregations over non-numeric collections, and obviously
incompatible assignments.

**Seed data is checked against its type, recursively.** `initialValue` is walked against
its `TypeRef` down through collections and nested entities. Records are keyed by **field
id**, so data keyed by field *name* is caught (`INITIAL_VALUE_UNKNOWN_FIELD` plus
`INITIAL_VALUE_MISSING_REQUIRED_FIELD`) rather than surfacing later as an inexplicably
empty UI. Diagnostics carry a `path` such as `state_orders[2].field_lines[0]` and
structured `details`.

**Four layers of correctness**, don't confuse them:
1. `validateGraph` — is the graph structurally sound? (authoring time)
2. Schema conformance — do instances satisfy `required` and their `TypeRef`? (runtime)
3. `ConstraintDef` — is this state allowed? Evaluated per instance of `entityId` with that
   instance bound to the entity's id. (runtime)
4. `TransitionConstraintDef` — is this *change* allowed? Evaluated with the instance as it
   was at transaction entry bound to `previousScopeId` and as proposed bound to
   `proposedScopeId`. A removed instance has a proposed value of nothing. (runtime)

Transition rules are what make a business rule hold on **every governed path** — actions,
`for-each`, and input bindings alike. `hydrateState` is deliberately *not* governed: it is
an administrative facility for hosts, tests and seeding, and is named so that it cannot be
mistaken for a semantic write.

Layers 2 and 3 apply to **every canonical occurrence** of an entity, found by walking
state values against their declared types. An entity nested inside a collection inside
another entity is validated where it actually lives, not only at the top level.

**Draft state.** `StateDef.draft: true` marks work in progress. Draft and derived states
are skipped by instance validation, otherwise a half-filled form would fail every
invariant and roll back every action.

**Ephemeral state.** `StateDef.ephemeral: true` marks state that is a UI fact rather than a
domain fact — which panel is expanded, which tab is selected. Like a draft it is skipped by
instance validation and unguarded per keystroke; unlike a draft it may not be persisted.
It changes what a state *is*, never what is permitted: a write that reaches domain state is
governed exactly as before.

**Derived state is read-only and copied.** A state with a `derivation` is recomputed on
demand and handed out as a frozen deep copy. Writing to it is rejected by the validator
and by the runtime. This is deliberate: it makes the aliasing the 0.2 runtime relied on
impossible, so an editor must address the record where it is actually stored — see
`packages/demo/test/acceptance.test.ts`, "editing a record works through its location".

## The mutation subsystem

`packages/runtime/src/mutation/` is the only place application state is written.

| Module | Role |
| ------ | ---- |
| `values.ts` | Cloning, deep freezing, comparison, coercion helpers. |
| `store.ts` | The state store. Owns the map, freezes everything on the way in, snapshots. |
| `transaction.ts` | Runtime transactions; nested ones join the outermost snapshot. |
| `resolve-location.ts` | `Location` → `ResolvedLocation` with `read()`, `write()` and a `ResolvedPath` of semantic provenance. |
| `mutation-engine.ts` | Applies `set` / `insert` / `remove`, records provenance and the mutation log. |

Three properties hold the design together:

- **Stored values are deeply frozen.** An accidental `object[field] = value` on anything
  read from the store throws in strict mode rather than silently corrupting state.
- **Writes rebuild the path** from the root state instead of editing in place, so a
  mutation never depends on the identity of an object an expression returned.
- **A change is only judged on what it changed.** The invariant guard compares violations
  before and after, so data that was already invalid — restored from storage, say — does
  not make the rest of the UI unwritable. Actions are stricter, per spec3 §27: an action
  must leave the whole application valid, not merely avoid breaking it further.

`runtime.getMutationLog()` returns every mutation with its source (`action` / `ui` /
`system` / `native`), the node that caused it, its transaction id, the resolved path
(`state_products → [product-1] → field_product_name`), and its `outcome` once the
surrounding transaction settles. Rejected attempts stay in the log as `rolled-back`.
Only the outermost transaction decides an outcome; a nested one shares its parent's fate —
so the log never suggests that early iterations of a failed `for-each` committed.

**Diagnostics are structured.** `RUNTIME_DIAGNOSTIC_CODES` is public vocabulary — including
`TRANSITION_CONSTRAINT_VIOLATION`, which carries the rule, the entity, and the previous and
proposed values, and `details.source` naming the mutation path; a
`RuntimeDiagnostic` carries `code`, `severity`, and where relevant `actionId`,
`constraintId`, `stateId`, `transactionId` and `details`. `invokeAction` returns the
diagnostics **of that invocation** — no diffing global history — while `diagnostics()` and
`clearDiagnostics()` manage the running log.

Values are cloned with `structuredClone`, not a JSON round trip: a JSON round trip turns
`NaN` into `null`, which would disguise a failed computation as an absent value.

## How the browser page is produced

The runtime modules are ordinary, type-checked TypeScript that import nothing at run time
except each other. `createRuntimeModuleSource()` concatenates their compiled output in
dependency order and strips the module syntax — that is the entire "bundler". The compiler
then inlines that source, the IR as JSON, and a two-line bootstrap into one page.

**The runtime must never import a value from `@cynodia/axiom-core`.** Type-only imports are fine
(they are erased). A value import would be stripped from the bundle and become `undefined`
in the browser, so `source.ts` now throws `UnbundledDependencyError` at build time if it
finds one. When the runtime needs something core computes, resolve it during compilation
and put it in the IR instead — `ApplicationIR.locationTypes` exists for exactly that
reason — `ApplicationIR.presentation` and `ApplicationIR.theme` exist for the same one.
Adding any runtime module means adding it to `RUNTIME_MODULES`, in dependency order.

## The authority boundary

`packages/core/src/authority.ts` holds the model, `validate-authority.ts` the rules,
`compiler/src/server.ts` the Server IR, and `packages/server` the runtime that executes it.

**Authority is derived, never declared.** An action that writes any server-authoritative
state is a server action — following `for-each`, `invoke` and declared native effects — so
it can never disagree with what the action actually does. Nothing should add a field that
lets an author assert otherwise.

**The authoritative runtime reuses the client's semantic engine.** `createAxiomServer`
builds an `ApplicationIR` with no UI and no routes and runs `createAxiomRuntime` over it.
That is deliberate rather than convenient: transactions, provisional writes, `for-each`
ordering, constraints, transition rules, rollback and the mutation log are not
reimplemented, so a graph cannot behave differently because execution moved. Resist any
change that forks the engine.

**Both IRs normalize guards.** `compileToIR` and `compileToServerIR` must both turn `guards`
into aligned `preconditions` / `failureModes`; an authority that read one and not the other
would silently skip every guard. There is a test for this because it happened.

**The client's store has exactly one writer.** `writeState` refuses any write to a
server-authoritative state unless `applyingAuthoritative` is set, and applying an
authoritative answer still goes through it — `packages/runtime/test/store.test.ts` fails if a
second `store.write(` call site appears anywhere in `runtime.ts`.

**The contract identifier follows the vocabulary a document uses.** `axiom.server.v1` stays
frozen: it does not contain `group`, `expression-ref` or `expressionDefs`. A document that uses
any of them is labelled `axiom.server.v2` — computed from the document by
`requiredServerContract`, never asserted by hand — so an application that uses nothing from 0.7
still compiles to the byte-identical v1 document it always did, and the committed v1 conformance
fixtures are unchanged. `createAxiomServer` executes both and **refuses a document that
understates its contract**, because a runtime accepting vocabulary its label disclaims is how
two implementations come to disagree about the same file. There is one schema per contract;
`server-ir.v1.schema.json` is byte-frozen.

**Server IR is portable data, and `axiom.server.v1` is now frozen.** No closure, no host
object, no presentation, no UI. `packages/server/conformance/*.json` are committed fixtures —
Server IR plus expected results — and `packages/server/schema/*.json` are the generated JSON
Schemas for the IR and the protocol. Both ship, both are addressable through the package's
`exports` map, and both are checked against the runtime by tests. Regenerate with
`npm run conformance:generate` and `npm run schema:generate` after changing the semantics or
the vocabulary they cover.

**The browser is part of the test strategy, not a substitute for the memory host.** The
in-memory host is faithful enough for semantics and is where the fast tests live — but it is
*more forgiving than a DOM*, and that difference hid four real defects until Chromium ran:
`focus()` on a detached element does nothing; removing a focused input fires `change` on it and
re-enters the render; `localStorage` throws on property read in an opaque origin; and focus
return has to survive the return target being deleted by the very action that closed the dialog.
When a change touches focus, keys, storage or the document, `npm run test:browser` is the only
test that can confirm it.

A frozen contract means the semantics in `docs/AUTHORITY.md` — IEEE-754 binary64 arithmetic,
Unicode code-point text ordering, the deterministic host model, the JSON serialization
constraints, the diagnostic codes — may not change under this identifier. An incompatible
change needs `axiom.server.v2`, not a version bump. Fixture expectations are exhaustive
(a fixture that names changed states names all of them and no others), and no fixture may be
edited to match the runtime without deciding and documenting the intended semantics first.

**The client's write path must stay browser-only.** `packages/runtime/src/remote.ts` is the
gateway a generated page uses, and `packages/runtime/test/host.test.ts` fails if any `node:`
import, `require`, `process` or `Buffer` reference reaches the bundle. When the runtime needs
a type from core, `runtime-types.ts` holds a local copy rather than importing a value.

**A diagnostic crossing the trust boundary carries no state value.** `DISCLOSABLE_DETAIL_KEYS`
in `packages/server/src/server.ts` is a whitelist for exactly that reason: a detail added to
the runtime later is withheld until somebody decides it may cross. A transition rule's
`previousValue` is the record itself, and the caller may not be entitled to it.

## Authoring metadata and renderability

Two mechanisms added in 0.6.3, both generic rather than serving one consumer.

**`AUTHORING_METADATA_KEY` marks metadata that describes how a node was authored.**
`packages/core/src/authoring-metadata.ts` holds it; `compileToIR` and `compileToServerIR`
strip it unless `includeAuthoringMetadata` is passed. Anything under that key is inert by
construction, so nothing may branch on it at run time. It exists because free-form `metadata`
travels into the IR and across the trust boundary, which is right for data a runtime might
consult and wrong for a generated node's origin.

**A UI node kind is in the contract only if a renderer implements it.**
`RendererCapabilities` names a target and the kinds it can draw; `validateGraph(graph, {
renderer })` rejects the rest with `UNSUPPORTED_UI_NODE_KIND`, and `compileToIR` applies
`BROWSER_RENDERER_CAPABILITIES` by default. This closes a real gap: before 0.6.3 a kind could
be added to `UI_NODE_KINDS` and pass validation with no renderer support, surfacing only as a
runtime `UNSUPPORTED_UI_NODE` on a blank element. `packages/compiler/test/renderability.test.ts`
renders one node of every published kind and fails if the renderer does not handle it, so the
capability list cannot drift from the renderer.

## The external world

Three directions, and no more. Everything Axiom can do to or with the outside world is one
of them wearing a familiar name.

| Direction | Shape | Vocabulary |
| --- | --- | --- |
| Query | Ask; wait for a finite answer. | `integration-query`, `blob-metadata` |
| Effect | Tell; no answer joins the transaction. | `integration-effect`, `blob-commit`, `blob-delete` |
| Subscription | The world tells you, while you are listening. | `SubscriptionDef` → `EventDef` |

Storage looked like a fourth direction and is not: a metadata lookup *is* a query and a
commit or a delete *is* an effect. What it needed was a byte transport separate from the
semantic path, not a fourth direction.

**A subscription is a node, not a third `IntegrationOperationMode`.** It has lifecycle,
delivery and backpressure policy that a query and an effect have no concept of, and no
`resultType`, which they both require. `packages/core/src/subscriptions.ts` holds the
vocabulary, `packages/server/src/subscriptions.ts` the runtime,
`packages/server/src/subscription.ts` the adapter contract and the deterministic fake.

**There is exactly one inbound event pipeline.** A subscription delivery is validated against
`EventDef.payloadType` and dispatched through the same `fireEvent` a webhook and an effect
outcome use — `packages/server/src/subscriptions.ts` contains no dispatch logic of its own.
Do not add a second one.

**Delivery is at-least-once and never silently lossy.** The queue is always bounded; the
default policy (`block`) cannot lose an event; the two dropping policies are declared in the
graph and report every drop. Ordering is per subscription and is deliberately *nothing*
across subscriptions. `delivery.deduplicateBy` names a **payload** field carrying the
provider's identity — an Axiom-generated id would differ between an original and its
redelivery, which is the case deduplication exists for.

**Reconnect policy is Axiom's; reconnect mechanics are the adapter's.** An adapter reports a
lost transport and nothing else. Resist any change that lets an adapter choose a delay.

**Bytes never enter the graph, the Server IR or canonical state.** State holds a `BlobRef`
of five scalars (`packages/core/src/storage.ts`); bytes move through the host's own
`POST/GET /axiom/blob/…`. `blobRef()` in `packages/server/src/blobs.ts` is the single
whitelisting projection, in the same spirit as `DISCLOSABLE_DETAIL_KEYS` — a field added to
`StoredBlob` later does not reach a client until somebody decides it may.

**An object store does not join a transaction, and nothing pretends it does.** An upload
lands `staged`; `blob-commit` promotes it post-commit. A refused transaction leaves a
sweepable staged object rather than state referencing bytes nothing claimed; a failed
`blob-delete` leaves state correct and the orphan visible in `blobLog()`. Storage effects
ride the existing outbox — there is no second durability system.

**A store with no access rule serves nothing.** The safe default for a missing
`readAuthorization`/`uploadAuthorization` is refusal, and a key that names nothing is
answered identically to one the caller may not read, so the endpoint is not an oracle.

**`dialog` is the first interaction primitive.** The graph declares what is open, the
accessible name, the content, what closes it and whether it is modal; the runtime performs
focus movement, containment, `Escape`, focus return and the ARIA relationships. Dismissal
invokes the declared close action and means nothing else — closing is not cancelling. It is a
canonical node rather than a toolkit pattern because a pattern can only emit nodes that
already exist, and none of that behaviour was expressible.

## The presentation layer

`packages/core/src/presentation.ts` holds the vocabulary, `theme.ts` the translation layer,
`resolve-presentation.ts` the algorithm and `validate-presentation.ts` the findings. The
web renderer's half is `compiler/src/stylesheet.ts` plus `runtime/src/presentation-classes.ts`.

**Presentation is attached to UI nodes as `presentation?: Presentation`** and is entirely
optional. Every value in it is a closed vocabulary — `PRESENTATION_ROLES`, `UX_ROLES`,
`SPACING_TOKENS`, `TEXT_ROLES`, `SURFACE_ROLES`, `LAYOUT_KINDS`, `DEVICE_CLASSES` and the
rest are exported arrays — and a token outside the vocabulary is a validation **error**,
not a silently ignored value. Adding a token means adding it to the array, the resolver,
the stylesheet and `collections`-style enumeration tests, in that order.

**Resolution has six layers and they are ordered** (spec5 §40):

```
renderer defaults → theme → inherited → semantic inference → node → responsive
```

`ResolvedPresentation.origins` records which layer decided each property, which is how the
order is tested rather than asserted in prose. `density` is the *only* property that
inherits (`INHERITED_PROPERTIES`); do not add more without a reason the spec supports.

**Semantic inference is where node kinds and UX roles earn their keep.** A form is a raised
surface, a `toolbar` is a horizontal wrapping centred group, a button bound to a
`destructive` action is destructive, a button that submits its form is the primary action.
This is what keeps authoring compact — annotate where intent differs from the default, not
on every node. It also means a 0.4 graph gains all of it without being edited.

**The IR carries resolved presentation, still semantic.** `ApplicationIR.presentation` is
roles, tokens and device classes — never CSS. `packages/compiler/test/presentation.test.ts`
asserts that no colour, length or CSS property appears in it, because that is what keeps a
second renderer possible. Resolve *into* the IR, translate to CSS only in `stylesheet.ts`.

**A rendered element is identified by node *and* render instance.** A UI node inside a
`repeat` is rendered once per member, so `NodeId` alone cannot identify a rendered element.
Element ids, label associations, described-by relationships, error regions, control lookup
and focus restoration are all keyed by the instance — `data-node` carries the semantic node,
`data-instance` this rendering of it. Anything new that generates an id or a relationship
must be keyed the same way, or accessibility state leaks between rows.

**If many applications would need the same corrective presentation, it is a framework
default.** Control affordances belong in the theme (`theme.buttons`), not on every node. A
padding or gap token resolved to `none` emits no class, so a component's own metrics are
never overridden by the absence of a value.

**A type scale is not a document outline.** `textRole` decides how large text is drawn;
`headingLevel` decides whether it is a heading. Validation reads the resolved level, along
each view's primary render path only.

**The renderer emits class names and nothing else.** No inline styles, no computed lengths.
`presentationClassList` is the whole vocabulary of what reaches the DOM, and every class it
can emit has a rule in the generated sheet. Landmark elements and heading levels come from
UX roles and text roles, so accessibility cannot drift away from the declared structure.

**Themes are data and cannot change behaviour.** `graph.setTheme(partial)` merges over
`DEFAULT_THEME`; `graph.theme` is the completed one. A theme change must leave actions,
constraints, transition constraints, locations, state, routing and every `uiNode` byte-for-byte
identical — there are tests for exactly that in compiler and demo.

**Backward compatibility is a tested property.** `role: 'danger'` and `density: 'normal'`
are 0.2 spellings and are normalized, `ContainerNode.layout` is still read, and stripping
every presentation declaration from the order system leaves a working application. Do not
break any of those without a spec change.

## Where the tests live, and why

Test placement follows the dependency direction, which is why some tests are not in the
package they exercise:

- `core` — graph semantics, locations and their validation, type inference, and the
  architecture leak scan.
- `runtime` — the store's freezing and snapshot behaviour, location resolution, the
  memory host, the browser bundle's shape, and the mutation-confinement check.
- `compiler` — normalization and page emission, **plus the runtime behaviour tests**
  (`runtime.test.ts`, `mutation.test.ts`, `collections.test.ts`): `compileToIR` is the only
  IR producer, and the compiler is the lowest package that can see both it and the runtime.
  `collections.test.ts` enumerates `BUILTIN_FUNCTIONS`, `EXPRESSION_KINDS` and
  `OPERATION_KINDS` and executes every one, which is how "no silent semantic failure" is
  kept true as the vocabulary grows — add a construct without implementing it and that
  test fails.
- `agent-api` — queries, field-level dependencies, mutation impact, transactions, and the
  presentation and UX queries and transformations.
- `demo` — the applications end to end, and the acceptance scenarios from spec2 §45/§46,
  spec3 §51/§52, spec4 §30–§35 and spec5 §56–§61. `order-system.ts` is the acceptance
  fixture: projection, aggregation, aggregate guards and atomic multi-record confirmation
  with no native operations anywhere in it, *and* the presentation fixture —
  `order-system-presentation.test.ts` checks it has a header, navigation, sections,
  surfaces, formatted values, empty states, confirmation affordances and responsive order
  editing, with no application CSS, no escape hatch and no callback in the graph.

Presentation itself is tested in `core/test/presentation.test.ts` (resolution, precedence,
inference, themes), `core/test/presentation-validation.test.ts` (the deliberate mistakes of
spec5 §61) and `compiler/test/presentation.test.ts` (IR normalization, the class
vocabulary, formatting, accessible structure, the generated stylesheet).

`@cynodia/axiom-runtime` exports `createMemoryHost()` and an in-memory DOM. That is deliberate
framework code, not test-only scaffolding: the runtime takes its whole environment through
a `HostEnvironment`, so it can be driven headlessly without a browser or jsdom.

## Current limits

- **Rendering is full re-render.** Every state change rebuilds the view and restores focus
  and caret position by node id. `MutationResult.affectedLocations` is recorded but not yet
  used for fine-grained updates.
- **Invariants are re-evaluated in full** after every action, over every instance found by
  walking state. Constraint read dependencies are in the graph, so selective evaluation is
  possible but unimplemented.
- **`for-each` contains mutations only** — no nested iteration, navigation or invocation.
- **A malformed aggregation yields `NaN`** and a diagnostic. Comparisons against `NaN` are
  false, so a guard fails closed rather than passing on a value it could not compute.
- **`inputValidation: 'deferred'`** turns off the per-keystroke invariant check entirely,
  leaving validity to the next action. `'immediate'` is the default.
- **Warning-severity constraints never block a write.** Only error severity — the default
  — is treated as a hard invariant.
- **Backpressure is not conformance-fixture-expressible.** All four policies are implemented,
  documented normatively and covered by tests, but the fixture format cannot say "hold this
  delivery unresolved while asserting the queue depth". It is the one 0.9 rule whose
  *verification* stays TypeScript-only — see `AXIOM_0_9_IO_RESEARCH.md` §4.1.
- **Deduplication without a durable persistence adapter is in-process only** and does not
  survive a restart. `createMemoryPersistence` implements the durable pair; an adapter that
  does not leaves a bounded in-memory window.
- **No filesystem or object-store blob adapter ships** — the interface and
  `createMemoryBlobStore` do. Staged-orphan sweeping is exposed (`listStaged`), not scheduled.
- **No browser file-input node kind.** Blob upload and download are host HTTP endpoints; 0.9
  adds no browser behaviour for them. Adding one needs a renderer, a `RendererCapabilities`
  entry and real-Chromium tests, or it is exactly the inert-kind failure that gate prevents.
- **Remote persistence is declared but not executed** (`StatePersistence.kind: 'remote'`
  validates and does nothing). `memory` and `local-storage` work.
- **Type inference is deliberately partial** (spec3 §22): it rejects obvious mismatches and
  stays silent wherever a type depends on an iteration scope.
- **Iteration scopes are ordinary `NodeId`s**, not a distinct branded type. Misuse is
  caught by validation instead: a scope may not shadow an enclosing one, and may not take
  the id of a graph node.
- **No typed handles or higher-level authoring API yet** (spec4 §21–§23). Graphs are still
  built by calling `addNode` with explicit ids.
- **No loading or async presentation states** (spec5 §78). The action model is synchronous,
  and the spec says not to invent an asynchronous lifecycle to decorate. When actions gain
  one, `idle` / `pending` / `success` / `failure` belong here.
- **`stack` is a tight vertical column, not overlapping children** (spec5 §10). It is the
  0.2 meaning of `ContainerNode.layout: 'stack'`, kept because no use case needs overlap.
- **Presentation resolution is not incremental.** `resolvePresentationMap` walks every UI
  node, and `AgentAPI` recomputes it per call rather than caching, because a transaction
  mutates the graph underneath it. Correct, and not fast.
- **Only `density` inherits.** Spacing context and text-role defaults are listed as
  candidates in spec5 §39 and are deliberately not implemented.
- **The renderer's escape hatch is a class name only** (`rendererOverrides.web.className`).
  There is no raw-CSS channel in the graph, and adding one would need spec5 §51's opacity
  marking to stay true.
- **Change sets are in memory** and per `AgentAPI` instance. There is no semantic version
  control and no on-disk graph format — graphs are still TypeScript builder functions,
  which remains a concession to human authoring.

When adding a capability, push it **down into the graph model and out of the framework**.
If a demo application seems to need a framework change, the change must be justifiable in
domain-neutral terms — that test is what `packages/demo/src/inventory.ts` exists to apply.
