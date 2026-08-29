# Axiom 0.12.1 — Distributed State Coherence Hardening: implementation report

Release: `0.12.1-alpha.1`. Branch: `spec12.1-state-coherence`. Baseline: `0.12.0-alpha.1`.
Full model: `docs/DISTRIBUTED_AUTHORITY.md` §13a. This is a corrective hardening release —
it closes the four Phase 20 blind-external-regression findings and changes no graph
executable meaning.

**Internal release classification: A — DISTRIBUTED AUTHORITY.** F1 is closed by actual
revision-coherent authorities (not a documentation downgrade, not a hidden state leader).
F2 is closed. F3/F4 are closed. All 0.12 coordination invariants remain green. 1/2/N
authority `StateDef` equivalence passes with real OS processes. No §103 release blocker
fires.

Test totals: **1296** across the repo (server 485, incl. the new `distributed-state-coherence`
in-process + cross-process suites and `sqlite-persistence-contention` real-OS-process suite;
core 260, incl. malformed-`TypeRef`; agent-api 82). All green at 0.12.1-alpha.1.
`release:pack` / `release:verify` / `release:consumer-test` / `release:probe` pass.

---

## Answers to §102

**1. What exactly caused F1?** A running `AxiomServer` treated its in-memory `StateDef`
representation as independently authoritative. Nothing re-observed the durable persistence
revision after startup, so once another authority committed, this authority (a) served
stale state from `SnapshotRequest` / `snapshot()`, and (b) built every subsequent commit's
`expected` revision map from its stale local `revisions`, which persistence then refused
(`CONCURRENCY_CONFLICT`) forever — a permanent wedge. A fresh process loaded the correct
state, proving persistence held the truth.

**2. Which runtime object previously treated process-local state as authoritative?** The
`AxiomServer` in `packages/server/src/server.ts`: the `runtime` state store plus the
module-local `storeRevision` / `revisions` map, published by `snapshotOf()` and consulted
by `invokeCore`'s commit path, with no reconciliation against `persistence.revision()`.

**3. What is authoritative after 0.12.1?** The persistence provider. The in-memory `StateDef`
representation is formally an **authority-local cache** of persisted authoritative state
(`docs/DISTRIBUTED_AUTHORITY.md` §13a; JSDoc on `AxiomServer.snapshot`).

**4. What durable revision is used for coherence?** `persistence.revision()` — the same
monotonic commit-order integer persistence concurrency control already uses
(`PersistedState.revision` per state, `CommitOutcome.revision` global). No new counter.

**5. At what boundaries is revision checked?** `ensureStateCoherent()` is called: at the top
of `invokeCore` (covering every `ActionDef` invocation — client, trigger, scheduled,
event-invoked, effect-outcome — and therefore transaction opening, guard / authorization /
constraint / operation evaluation, and effect-argument evaluation); in `handle()` before
answering a protocol `SnapshotRequest`; on the `!outcome.committed` recovery path; and in
`start()` (as a re-loading loop). All of these run inside the server's single serialized
queue.

**6. How is a stale authority detected?** `ensureStateCoherent()` reads `persistence.revision()`
and compares it to `storeRevision`. `persisted > storeRevision` means another authority
committed and this authority is behind.

**7. How is state refreshed?** It re-reads `persistence.load()` and `runtime.hydrateState`s
each durable (non-derived) `StateDef` row, sets `revisions[stateId] = row.revision`, sets
`storeRevision = observed`, and calls `invalidateQueryCache()`.

**8. Is refresh whole-state or incremental?** Whole-state (`persistence.load()`), the
smallest change that is provably correct. The `PersistenceAdapter` contract exposes no
per-state change feed; an incremental refresh would need one and is deferred.

**9. How is a coherent state/revision pair guaranteed?** The refresh reads
`revision()` → `load()` → `revision()` again; if the second read differs, the store moved
during the load and the refresh repeats (bounded to 8 attempts, §19-§20). `start()` uses
the same read-load-reread loop.

**10. What happens if persistence changes during refresh?** The refresh repeats with the
newer observed revision rather than hydrating a mix of revisions. After the bound it takes
the last snapshot it read coherently.

**11. Can two local refreshes race?** Not within one authority: every caller of
`ensureStateCoherent()` runs inside the server's `serialize()` FIFO, so exactly one request
(hence one refresh) is in flight at a time. `coherentSnapshot()` also goes through
`serialize()`.

**12. Can local revision move backward?** No. `storeRevision` is only ever assigned a value
`> storeRevision` (or left unchanged); `ensureStateCoherent` early-returns when
`persisted <= storeRevision`. Monotonic (§22).

**13. What happens after `CONCURRENCY_CONFLICT`?** The failed transaction's in-memory
mutations are undone (`hydrateState(before)`), then `ensureStateCoherent()` reloads the
winning durable state (the persisted revision has advanced), then the losing invocation
returns `CONCURRENCY_CONFLICT`. The authority is not wedged: its next request runs from the
reconciled state.

**14. Is the losing `ActionDef` automatically replayed?** No.

**15. Why or why not?** An action may contain non-idempotent operations (an external effect,
a message). Replay is only safe when an existing contract proves it, and Axiom has no such
proof for arbitrary actions (§12, §56). The default is: losing invocation →
`CONCURRENCY_CONFLICT`; authority → refreshes for subsequent requests. A caller that wants
to retry decides per action.

**16. Authoritative snapshot linearization point.** The value of `persistence.revision()`
observed by `ensureStateCoherent()` at the start of handling the `SnapshotRequest`; the
returned `(states, revision)` pair is coherent at that revision (or a newer one if a commit
landed and was reloaded during the same handling).

**17. Transaction base-revision linearization point.** The value of `persistence.revision()`
observed at the top of `invokeCore` (before any guard / operation runs). The commit's
`expected` map is built from the `revisions` map as reconciled to that point.

**18. Commit linearization point.** `persistence.commit(...)` performs the atomic
compare-and-write: it commits iff every written state's stored revision still equals the
`expected` value, producing `CommitOutcome.revision = previous + 1`. SQLite does this inside
`BEGIN IMMEDIATE ... COMMIT`.

**19. Conflict-recovery linearization behaviour.** On a refused commit the authority
re-observes `persistence.revision()` and reloads to that revision before returning; the
losing invocation's linearization point is "refused, no effect", after the winning commit.

**20. How are synchronous snapshot/getState APIs made coherent?** They are documented (design
gate §40, option 3) as the **authority-local view as of the last handled request** — a
synchronous read of the cache. The coherent paths are `handle(SnapshotRequest)` (protocol)
and the new async `AxiomServer.coherentSnapshot()`. Because `handle()` reconciles at the top
of every request, in a request-driven deployment the sync view is never indefinitely stale;
a caller wanting a guaranteed-current read uses the protocol or `coherentSnapshot()`.

**21. Did any public API become async?** One was **added**: `AxiomServer.coherentSnapshot():
Promise<StateSnapshot>`. No existing signature changed.

**22. If so, how was compatibility handled?** Purely additive — `snapshot()` / `getState()` /
`revision()` keep their synchronous signatures and behaviour (now documented as the local
view). Existing single-authority code is unaffected.

**23. How do event-triggered actions obtain coherent `StateDef`?** They invoke through
`invokeCore` (via `invokeSystem` ← `dispatchEvent` ← `fireEvent`), which calls
`ensureStateCoherent()` first. `dispatchEvent` itself runs inside `serialize()`.

**24. How do scheduled actions obtain coherent `StateDef`?** Same path — a scheduled trigger
fires an action through `invokeCore`. (Under distributed authority the *firing* is also
fenced by the 0.12 scheduler; the *state* it reads is reconciled by
`ensureStateCoherent()`.)

**25. How do distributed effect-producing actions remain transactionally correct?** The
action still runs as one transaction: state mutations + effect intents commit atomically
through `persistence.commit({ writes, effects })`. `ensureStateCoherent()` runs *before* the
action, so the transaction's base is coherent; if the commit still loses a race, `effects`
were part of the refused commit and are never persisted or dispatched.

**26. Can a losing transaction leak an effect?** No. Effect intents are passed to
`persistence.commit` alongside the state writes; a refused commit persists neither. The
distributed effect runner (0.12) only ever picks up intents that were durably committed. A
regression test races two effect-producing invocations and asserts one committed set of
effects.

**27. How was F2 fixed?** `createSqlitePersistence` now sets `PRAGMA busy_timeout` on open
and wraps every statement (`load`, `commit`, `revision`, `loadPendingEffects`,
`recordEffectAttempt`, and schema `init`) in `runWithBusyHandling` — the same bounded-retry
+ structured-recognition helper the migration and coordination providers use. The whole
`commit` body (conflict check + `BEGIN IMMEDIATE` write) runs behind it, so a physical lock
we wait out is re-checked against current revisions (a concurrent writer becomes a
legitimate `CONCURRENCY_CONFLICT`, §32).

**28. Is `busyTimeoutMs` public?** Yes — `SqlitePersistenceOptions.busyTimeoutMs`.

**29. What is its default?** `DEFAULT_BUSY_TIMEOUT_MS` (2000 ms), shared with the migration /
coordination SQLite providers. `0` disables the native wait; the bounded retry still
applies.

**30. How are SQLite BUSY/LOCKED errors recognized?** By `isSqliteContentionError` in
`sqlite-contention.ts` — the primary result codes `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6)
via `node:sqlite`'s structured `errcode`/`code` fields, never by English message text.

**31. What errors are explicitly not treated as contention?** Everything else — constraint
violations, corruption, IO errors, malformed SQL, `database is not open`, and any other
`Error`. They propagate unchanged. A negative-control test operates on a closed database and
asserts the failure is not misclassified as (or swallowed by) contention handling.

**32. Is retry bounded?** Yes — `DEFAULT_BUSY_ATTEMPTS` (4) bounded retries with backoff on
top of the native `busy_timeout`. Never unbounded waiting. Residual contention on `commit`
after the window becomes a refused `CommitOutcome` (so the authority reconciles and the
caller may retry); on reads it surfaces as the typed `SqliteContentionError`, never a raw
`ERR_SQLITE_ERROR`.

**33. Did journal mode change?** No. No `PRAGMA journal_mode` / WAL change.

**34. Did transaction isolation/boundaries change?** No. `BEGIN IMMEDIATE ... COMMIT` around
the atomic state+effects write is unchanged; the optimistic revision check is unchanged;
crash durability is unchanged.

**35. Can concurrent startup leak raw SQLite contention?** No. Schema creation is itself run
behind `runWithBusyHandling` (`sqlitePersistence.init`). The F2 regression test spawns all
`3 writer + 5 reader` processes with `Promise.all` (concurrent startup against one file) and
asserts zero raw lock leakage across 30 trials.

**36. Did persistence-provider capability vocabulary change?** No. Existing `PersistenceAdapter`
semantics (`load`, `commit` with `expected` revisions, `revision()`) already provide
everything `ensureStateCoherent()` needs. No `revision-observation` / `coherent-state-load`
capability was added — justified because every adapter that implements the atomic
`commit(expected)` contract already exposes a coherent `load()` + `revision()`.

**37. Can an incapable provider silently run distributed `StateDef`?** The in-tree adapters
(`createMemoryPersistence`, `createSqlitePersistence`) both satisfy the contract. A
third-party adapter that did not implement `commit(expected)` / `revision()` coherently was
already unsafe for multi-authority use under 0.12; 0.12.1 adds no silent degradation path.

**38. How was F3 fixed?** `validateTypeRef` gains a guard: a `null` / non-object / missing-
`kind` `TypeRef` pushes a structured `INVALID_TYPE_REF` error and returns. `containsGroupType`
and `describeType` are made null-safe, and the `enum` branch checks `Array.isArray(values)`.
The fix is narrow — a well-formed graph validates byte-identically.

**39. What diagnostic now replaces the `TypeError`?** `VALIDATION_CODES.invalidTypeRef`
(`INVALID_TYPE_REF`), with a stable message ("Type reference in <id> is missing or
malformed").

**40. How was F4 fixed?** `AxiomServer.inspectDistributedWork()` now returns a real
`schedules: DurableWorkItemView[]` field (`distributedWorkStore.list('schedule-firing')`),
and `inspectDistributedSemantics()`'s subscription pointer was corrected to
`'AxiomServer.subscriptionLog()'`. Every `runtimeStateAvailableFrom` now names a real public
surface.

**41. Does every AgentAPI inspection pointer now resolve?** Yes — asserted structurally in
`agent-api/test/distributed.test.ts` against the set `{ inspectDistributedWork().effects,
.schedules, .incompatibleEffects, subscriptionLog(), authority() }`.

**42. Did `schemaFingerprint` change?** No — byte-identical for identical graphs across
0.11.2 / 0.12.0 / 0.12.1 (no schema-identity code touched).

**43. Did `semanticFingerprint` change?** No — 0.12.1 changes runtime execution, not graph
executable meaning; the projection is untouched.

**44. Did Server IR remain v7?** Yes. No new node kind, expression kind, operation or IR
field.

**45. Did conformance remain v6?** Yes. No new portable fixture *shape* is required; the F1
coherence scenario is a server-level regression (in-process + real OS process), not a new
`axiom.conformance.v7` vocabulary.

**46. Were historical fixtures byte-identical?** Yes — the `v1..v6` conformance fixtures and
the frozen `server-ir` schemas were not touched by the version bump.

**47. What is the 1/2/8-authority equivalence result?** Equivalent committed semantic state
in every topology. `distributed-state-coherence-race.test.ts`: N OS-process authorities
against one SQLite DB, each committed action read back from a different randomly-chosen
authority — every read observes the commit, all authorities converge. (Routine run N=4;
`AXIOM_AUTHORITIES=8` for the full count.)

**48. Event-distribution result replacing 6/3/1.** `1 → 6`, `2 → 6`, `N → 6` — six events
routed across 1 / 2 / N authorities, and every authority's subsequent authoritative read
observes `eventsSeen == 6`. The topology-dependent `6 / 3 / 1` is impossible.

**49. True concurrent-write result distribution.** Deterministic in-process race (shared
adapter): exactly one commit wins, exactly one `CONCURRENCY_CONFLICT`. Cross-process (4
processes releasing simultaneously): at least one wins, every other attempt is either a
commit or a clean `CONCURRENCY_CONFLICT` (no raw error), all converge.

**50. Does the losing authority recover for its next request?** Yes — asserted in both the
in-process and cross-process race tests: after losing, each authority accepts a fresh
deposit and every subsequent read is coherent.

**51. How many raw SQLite lock errors occurred?** Zero, across 30 trials of `3 writer + 5
reader` OS processes (the F2 named regression), plus zero in the coherence race suites'
`stderr` scans.

**52. How many stale authoritative reads occurred?** Zero — `staleReads` counter in the
cross-process coherence test is asserted `=== 0`; the F1 named regression asserts B's
protocol snapshot returns the committed value.

**53. How many permanent conflict wedges occurred?** Zero — every losing authority accepts
its next request in every race test.

**54. Did any previous 0.12 coordination invariant regress?** No. The full 0.12 coordination
race matrix (coordination-race, durable-work-race, distributed-effects-race,
distributed-scheduler-race, external-event-dedup-race, subscription-cursor-race,
mixed-build-race, revision-cache-race, eight-authority-chaos, chaos-matrix, large-queue) is
green, with every forbidden counter still zero.

**55. Final internal release classification.** **A — DISTRIBUTED AUTHORITY** (spec12.1 §104),
pending external validation.

**56. What remains for external validation?** Publish `@cynodia/axiom@0.12.1-alpha.1` +
`@cynodia/axiom-server@0.12.1-alpha.1` and re-run the Phase 20 blind external regression
from a fresh consumer (spec12.1 §105-§110): the F1 SnapshotRequest sequence (2 / 8
authorities, random routing), the event equivalence (`1/2/8 → 6`), the F2 SQLite stress
(target all-zero), and enough of the 0.12 coordination matrix to confirm no regression.
Target `D1 / E1 / S1`.

---

## Findings status

| Finding | Status | Regression |
| --- | --- | --- |
| F1 — multi-authority `StateDef` incoherence (release-blocking) | **closed** — revision-coherent authorities | `distributed-state-coherence.test.ts`, `distributed-state-coherence-race.test.ts` (real OS processes), updated `server.test.ts` |
| F2 — `createSqlitePersistence` leaks raw lock contention | **closed** — `runWithBusyHandling` on every statement, `busyTimeoutMs` option | `sqlite-persistence-contention.test.ts` (3 writers + 5 readers × 30 trials) + §69 negative control |
| F3 — malformed `TypeRef` throws `TypeError` from `validateGraph()` | **closed** — structured `INVALID_TYPE_REF` | `core/test/malformed-typeref.test.ts` |
| F4 — `inspectDistributedSemantics()` names a non-existent field | **closed** — `inspectDistributedWork().schedules` added; pointer corrected; `stateCoherence` added | `agent-api/test/distributed.test.ts`, `distributed-authority-server.test.ts` |

## §103 release blockers — none fire

Verified: B never serves stale `StateDef` after A's completed commit; no permanent wedge
after one conflict; `localRevision` never regresses; refresh never publishes a mixed-revision
snapshot; event-distributed result is topology-independent (`→ 6`); no losing transaction
leaks an effect; no raw SQLite lock contention escapes; concurrent startup never fails from
ordinary contention; the F1 fix needs no sticky routing, no manual refresh, and no hidden
state leader; refresh does not bypass migration or authorization gates; mixed-build refusal
still holds; no 0.12 fencing/reclaim invariant regressed; schema/semantic fingerprints
unchanged; Server IR still v7; no silent single-writer degradation.
