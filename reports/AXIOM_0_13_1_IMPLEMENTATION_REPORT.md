# Axiom 0.13.1 — Live Query Invalidation Coherence Hardening: implementation report

Release: `0.13.1-alpha.1`. Branch: `spec13.1-invalidation-coherence`. Baseline:
`0.13.0-alpha.1`. Design note: `AXIOM_0_13_1_INVALIDATION_RESEARCH.md`. Full model:
`docs/LIVE_QUERIES.md`.

**Internal release classification target: B — LIVE CANONICAL QUERIES.** Corrective release.
Closes the two Phase 21 blind-external findings (verdict was `D2 / E1 / S3`). No new graph
or IR vocabulary. Server IR stays `axiom.server.v7`; `semanticFingerprint` /
`schemaFingerprint` unchanged for every previously valid graph. Conformance stays
`axiom.conformance.v7` (two additive fixtures).

Test totals: **1372** across the repo, all green at `0.13.1-alpha.1` (server 541 incl. the
new `live-query-invalidation` in-process suite and the expanded real-OS-process
`live-query-cross-process` suite — exact F1 repro, no-sync-pulse, crash-after-provider-
commit, 8-authority concurrent SQLite startup; core 275, agent-api 87). `npm run build`,
`npm test`, `release:pack` / `release:verify` / `release:consumer-test` / `release:probe`
and the documentation tests pass.

---

## Answers to §143 (F1)

**1. What exactly caused F1?** A `provider-record` mutation is applied through
`DataProvider.applyMutations` after the runtime transaction commits, and writes no durable
`StateDef`. The live-query invalidation poll observed only `persistence.revision()`, which a
provider-record-only action never moves. A remote authority therefore never re-evaluated,
and the live result depended on whether the serving authority happened to be the writer.

**2. What did `persistence.revision()` represent in 0.13.0?** The count of committed
`StateDef` write batches on the `PersistenceAdapter` — *not* "all canonical Axiom
mutations". The 0.13.0 poll treated it as the latter by accident.

**3. Why did `StateDef` writes wake provider-query updates?** A mixed action (or a test's
audit-counter "sync pulse") advanced `persistence.revision()`; the poll saw that, re-
evaluated *everything* (`broad`), and the query then also picked up the provider-record
change that had ridden along. Correct only by coincidence.

**4. What revision/generation is authoritative in 0.13.1?** A pair of durable sources,
projected to one local monotone scalar:
- `stateRevision` = `persistence.revision()` (StateDef commits).
- `dataGeneration` = Σ over each `DataProvider` of `observedMutationGeneration()` — a
  monotone counter advanced **atomically inside `applyMutations`**.
- `applicationRevision` = the server's local monotone count of *distinct observed
  application-meaning changes*, incremented whenever either source advances (a local commit
  it performed, or a remote advance its poll folded in). Local to one authority; nothing
  compares it across authorities.

**5. Which mutation paths advance it?** Every `provider-record` mutation committed through an
Axiom `ActionDef` — `set` on a `provider-record` field (insert *or* update) and `remove` on
a `provider-record` `Location` — advances `dataGeneration`. Every `StateDef` commit advances
`stateRevision`. A mixed action advances both. Batch: one `applyMutations` call → one
generation advance (§134), regardless of row count.

**6. Is advancement atomic with provider commit?** Yes. The SQLite provider's
`applyMutations` already ran `BEGIN IMMEDIATE … COMMIT`; 0.13.1 adds `UPDATE
_axiom_provider_meta SET value = value + 1 WHERE key = 'mutation_generation'` **inside** that
transaction. After `COMMIT` returns, rows and generation are durable together.

**7. What happens on crash after provider mutation?** Both the rows and the generation are
durable (they committed in one transaction). A newly started authority reads the current
`dataGeneration` and serves the correct initial result; a running remote authority observes
the advance on its next poll. Proven with a real SIGKILL immediately after the commit
returns (`live-query-cross-process.test.ts` §68/§116 arm).

**8. What happens on crash before revision advancement?** That state cannot exist for the
SQLite provider — the generation advance is not a separate step; it is a statement in the
same transaction as the row writes. A crash before `COMMIT` rolls back both.

**9. Can that state exist at all?** No, for the reference providers. A *custom* provider
that advanced its generation in a separate step would reintroduce the window; the contract
(`docs/LIVE_QUERIES.md`, `.d.ts`) states it must be atomic, and a provider that cannot do so
declares `mutationObservation: 'none'` and is refused for distributed live queries.

**10. How does SQLite implement the atomicity?** `_axiom_provider_meta(key TEXT PRIMARY KEY,
value INTEGER NOT NULL)` with a `'mutation_generation'` row seeded to 0 by `CREATE TABLE IF
NOT EXISTS` + `INSERT OR IGNORE` (concurrent-startup safe — tested with 8 real processes
racing a fresh DB). `applyMutations` runs `BEGIN IMMEDIATE`, the row writes, `UPDATE …
value + 1`, `COMMIT`. WAL + `busy_timeout` (from 0.13) absorb physical contention.

**11. How does the memory provider implement it?** An in-process integer incremented in the
same synchronous step as the row mutations. `mutationObservation: 'in-process'` — correct
within one process, no cross-process claim (the memory provider is single-process anyway).

**12. What must custom providers implement?** `observedMutationGeneration(): Promise<number>`
— a monotone counter advanced atomically with `applyMutations` — and
`capabilities.mutationObservation: 'durable'`. A provider that cannot: `'none'`, and
`openLiveQuery` for a query it backs is refused `LIVE_QUERY_PROVIDER_NOT_OBSERVABLE` rather
than served silently stale.

**13. What capability expresses support?** `ProviderCapabilities.mutationObservation`:
`'durable'` (cross-authority), `'in-process'` (single process), `'none'`.

**14. How does `liveQueryPollMs` consume the signal?** The idle poll reads
`persistence.revision()` **and** `Σ observedMutationGeneration()` each tick; if either
exceeds the folded-in value, it reconciles (`ensureStateCoherent()`, which also clears the
query cache — §75), advances `applicationRevision`, and calls `liveEngine.onCommit({ broad:
true })`. The old "poll `persistence.revision()` only" path is gone. Default 250 ms,
unchanged — 0.13.1 is not a latency release.

**15. How does local wakeup interact with durable observation?** A local commit advances
`applicationRevision` and calls `onCommit` synchronously with the *precise* dependency set
(the fast path). It also updates the folded-in `observedState` / `observedData`, so the poll
does not redundantly re-fire for local work. Local wakeup is an optimisation; the durable
sources are the correctness signal.

**16. How are mixed `StateDef`/provider transactions represented?** The existing 0.10
ordering is unchanged: runtime transaction → `persistence.commit` (advances `stateRevision`)
→ `commitProviderRecordStaging` (advances `dataGeneration`). These are **two commits**, not
one; 0.13.1 does not claim cross-surface atomicity it lacks. For live queries this is
sufficient: a remote authority that observes either advance re-evaluates against **both**
current surfaces, so it never serves a result mixing a new `StateDef` value with a stale
provider row for longer than one poll interval. `applicationRevision` advances once for the
action, after both halves.

**17. Does `StateDef` coherence use the same revision?** `StateDef` coherence (0.12.1) and
the query cache (0.12) continue to key on `persistence.revision()` for `StateDef` — that is
`stateRevision`, one of the two sources. They are unaffected and un-regressed (0.12.1
`distributed-state-coherence*` and lost-write races re-run green). `dataGeneration` is
additional, not a replacement.

**18. Does the query cache use the same revision?** The provider-backed one-shot query cache
is invalidated blindly on every commit (0.10 §72) including provider-record; the poll also
calls `ensureStateCoherent()` → `invalidateQueryCache()` before a remote re-evaluation, so a
live re-eval after a remote provider commit cannot be served a stale cached one-shot result
(tested).

**19. Does cursor meaning change?** No. The cursor's `rev` is `applicationRevision` at the
minting authority — still informational (`resumeLiveQuery` always re-evaluates fresh and
emits a `reset`). Its integrity and context binding (query / principal / arguments / policy
/ compatibility fingerprints) are byte-unchanged; all 0.13 cursor regressions re-run green.

**20. Does `semanticFingerprint` change?** No — for every previously valid graph. F1 is
runtime/provider infrastructure. F2 rejects graphs that were never validly executable, so
they had no defined fingerprint to preserve.

**21. Does Server IR change?** No — `axiom.server.v7`.

**22. Does the conformance version change?** No — `axiom.conformance.v7`, two additive
fixtures (`provider-only-sequence`, `f2-state-ref-refused`) plus their negative controls.
`v1..v6` and the existing 10 v7 fixtures byte-frozen.

---

## Answers to §144 (F2)

**1. Why did `validateGraph` accept `StateDef` refs in `QueryDef`?** `context.scopes`
contains every `state` node id globally (a `ref` to a state is legal in a constraint,
derivation, action, etc.), and `validateExpression`'s `ref` check only asks "is this id a
resolvable scope?". It never asked "is a `StateDef` in *this* owner's scope?".

**2. Why did dependency analysis advertise them?** `queryDependencies` added any `ref`
matching `knownStateIds` to `stateIds` — mirroring the (wrong) validation.

**3. Why could the runtime not bind them?** A `QueryDef` executes on the `DataProvider`,
whose expression scope is `{ PRINCIPAL, arguments, rowScopeId → row, relationship binds }` —
no authority state. `ref(<state id>)` resolved to `undefined`; comparisons went false; the
result came back empty.

**4. What is the canonical `QueryDef` expression scope?** `ref(rowScopeId)`,
`ref(<parameter id>)`, `ref(<relationship bindAs>)`, `PRINCIPAL`, and nested iteration-scope
ids introduced inside a clause.

**5. Which scopes may legally reference `StateDef`?** Constraint / transition-constraint
expressions, `StateDef.derivation`, action operations and locations, expression definitions,
UI expressions — everything evaluated *by the authority runtime*. **Not** a `QueryDef`
clause and **not** a `ReadPolicyDef` predicate (both provider-evaluated).

**6. What diagnostic now rejects invalid `QueryDef` `StateDef` refs?**
`QUERY_STATE_REF_NOT_ALLOWED` (`VALIDATION_CODES`, and mirrored in `SERVER_DIAGNOSTIC_CODES`
for the runtime guard). One error per offending `(query, stateId)` / `(policy, stateId)`.

**7. Does the compiler reject them?** Yes — `compileToServerIR` and `compileToIR` both run
`validateGraph` and throw `GraphValidationError`.

**8. Does AgentAPI report them invalid?** Yes — `AgentAPI.analyzeLiveQuery` →
`capability: 'not-live-capable'`, `reason` naming the ref, and
`dependencies.unsupportedStateRefs` populated (never `dependencies.stateIds`).

**9. Does `queryLiveCapability` report them invalid?** Yes when passed the optional
`knownStateIds` set — `not-live-capable` with a `StateDef` reason, checked before the
nondeterministic-builtin and aggregate checks.

**10. Does the runtime fail explicitly if invalid IR bypasses validation?** Yes — a shared
`queryStateRefProblem` guard in `runQuery` (one-shot) and `liveQueryContext` (`openLiveQuery`)
returns `QUERY_STATE_REF_NOT_ALLOWED` before touching the provider. Covered by a test that
hand-tampers a compiled IR.

**11. Were any previously valid canonical graphs affected?** No. An audit of the repo
(demos, conformance fixtures, tests) found no `QueryDef` clause or `ReadPolicy` predicate
referencing a `StateDef`. The 0.13.0 tests that did (`agent-api` / `core`
`live-query.test.ts`) were written against the broken behaviour and are corrected: the
threshold case is re-expressed as a query **parameter**, and a dedicated bad-query is added
to assert the rejection.

**12. Did `semanticFingerprint` rules change?** No. The projection is unchanged. A graph
that is now rejected was never validly executable.

---

## Release blockers (§149) — status

All 34 checked. F1 arms (1-14, 16, 17, 25) closed by the observable application revision +
atomic SQLite generation, proven with real OS processes (exact repro 20/20, no sync pulse,
crash-after-commit, 8-authority startup). F2 arms (21-24) closed by the consistent
`QUERY_STATE_REF_NOT_ALLOWED` across validate / compiler / deps / capability / AgentAPI /
runtime. Semantic-escape arms (25-31) — the reference workload needs **zero** manual
revision bumps, manual invalidation, broadcast, polling, sticky routing, provider-specific
coordination or `NativeOperation`. IR / fingerprint arms (32, 33) — unchanged. Regression
arms (15, 18-20) — 0.13 SQLite lost-write race, cursor binding, mixed-build refusal and
no-gap handoff all re-run green.

## Deferred / honestly out of scope

- A dedicated 1/2/8 full-reference-app harness (§109, §110) beyond the provider-only
  cross-process trials and the conformance fixtures — the same invalidation surface is
  exercised; a narrative multi-authority app is still worth adding.
- Every §192 item from 0.13 (production CDC, Redis, Kafka, global ordering, offline history,
  CRDT results).

## Blind external validation (§153, §160)

Pending — requires the published `0.13.1-alpha.1` packages. The full Phase 21 spec is to be
re-run substantially unchanged; F1 and F2 are named as mandatory regression areas without
disclosing the fix. `release:probe` confirms a cold agent is routed to
`docs/AGENT_REFERENCE.md` and `docs/LIVE_QUERIES.md` from the tarball alone. Required
verdict: `D1 / E1 / S1`.
