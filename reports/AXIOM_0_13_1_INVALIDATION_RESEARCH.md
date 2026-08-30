# Axiom 0.13.1 — Live Query Invalidation Coherence Hardening: design note

Corrective release. Baseline `0.13.0-alpha.1`. Branch `spec13.1-invalidation-coherence`.
Closes the two Phase 21 blind-external regression findings (verdict was `D2 / E1 / S3`):

- **F1 (release-blocking)** — a provider-record-only Axiom commit does not become observable
  to a remote authority's live-query invalidation, because it never advances the durable
  signal the remote authority polls. 0.13.0 masked this in its own cross-process test by also
  bumping a durable `StateDef` counter — exactly the "sync pulse" spec13.1 §50/§111 forbid.
- **F2** — a `QueryDef` expression that references a `StateDef` passes `validateGraph`, is
  reported as a live dependency by `queryDependencies` / `analyzeLiveQuery`, and then
  silently evaluates wrong (the query execution scope binds no `StateDef`).

No new graph node kinds, no `LiveQueryDef`, no new QueryDef expression scope, no mandatory
broadcast, no application-facing topology flag. Server IR stays `axiom.server.v7`;
`semanticFingerprint` / `schemaFingerprint` unchanged for every previously *valid* graph.
Conformance stays `axiom.conformance.v7` (additive fixtures only).

---

## G1 — the authoritative observable quantity

> What durable monotonic value means "canonical observable application meaning may have
> changed"?

0.13.0 relied on the accidental assumption `persistence.revision() == revision of all
canonical Axiom mutations`. That is false: a provider-record mutation is applied through
`DataProvider.applyMutations` and touches no `PersistenceAdapter`.

**0.13.1 defines the observable quantity as a pair, projected to one local scalar:**

| Component | Owner | Advances on | Durable across processes |
| --- | --- | --- | --- |
| `stateRevision` | `PersistenceAdapter` (`persistence.revision()`) | every committed `StateDef` write (0.6 / 0.12.1) | yes (SQLite), in-memory (memory) |
| `dataGeneration` | each `DataProvider` (`observedMutationGeneration()`) | every successful `applyMutations` batch | **yes for SQLite** (row in the same DB), in-memory for the memory provider |

The server maintains a single monotonic `applicationRevision` — "how many distinct
committed application-meaning changes this authority has observed" — that it advances
whenever **either** durable component advances (a local commit it performed, or a remote
advance it polled). `applicationRevision` is:

- **local to one authority** — it is a count of *observations*, not a shared clock. Two
  authorities' `applicationRevision` values are not comparable, and nothing compares them.
- what the live-query engine's per-registration "have I re-evaluated past this?" dedup uses,
  and what a live-query cursor's `rev` records (informational: `resumeLiveQuery` always
  re-evaluates and emits a `reset`, so `rev` never needs cross-authority meaning).

This is **not** an accidental dual clock (§14). There is one logical question — "has
committed application meaning moved since revision *R* I last evaluated?" — answered by
observing two durable sources and collapsing them to one local monotonic counter. The two
sources are never exposed as one comparable number, and the cursor never carries a
`stateRevision`/`dataGeneration` a peer would misread.

### Why not one shared application-level revision (§13, §15)?

A single shared revision would require the provider mutation and a `PersistenceAdapter`
revision bump to commit **atomically**. They live in different SQLite files (`data.db` vs
`state.db`); there is no cross-file transaction, so "write provider row, then bump
persistence revision" has the exact F1 crash window §16 forbids, only narrower. Model B —
the provider advances its **own** durable generation **inside its own `applyMutations`
transaction** — is genuinely atomic (§17 Model A, within the provider's commit domain), and
a future independent runtime implements it the same way: "your write path must expose a
durable monotone generation."

The implementation report records this as the deliberate choice and its cost (one extra
single-row UPDATE per provider mutation batch, §133).

---

## G2 — atomicity (no crash gap)

**SQLite provider.** `applyMutations` already runs `BEGIN IMMEDIATE … COMMIT`. 0.13.1 adds,
*inside that transaction*, `UPDATE _axiom_provider_meta SET value = value + 1 WHERE key =
'mutation_generation'`. So after `COMMIT` returns, the rows **and** the generation are
durable together; a crash before `COMMIT` leaves neither. There is no ordering in which
"committed provider meaning + permanently unobservable generation" can exist (§69). The
0.13 optimistic-concurrency-inside-`BEGIN IMMEDIATE` fix for `createSqlitePersistence`
stays; this is the analogous structure for the provider.

**Memory provider.** `applyMutations` bumps an in-process counter in the same synchronous
step. Not cross-process durable, and it says so via its capability.

**Mixed `StateDef` + provider-record transaction (§24).** The existing Axiom contract is:
the runtime transaction commits against the staging collections; then `persistence.commit`
writes the durable `StateDef`s (advancing `stateRevision`); then
`commitProviderRecordStaging` applies the provider mutations (advancing `dataGeneration`).
These are **two commits, not one** — that is unchanged from 0.10. 0.13.1 does not claim
cross-surface atomicity it does not have. What it guarantees for live queries: a remote
authority that observes *either* component advance re-evaluates the query against *both*
current surfaces, so it never serves a result mixing a new `StateDef` value with a stale
provider row for longer than one poll interval. The report states the exact ordering and
the (pre-existing, narrow) window in which an action's own two halves can diverge under a
crash between them — a concern for action durability, not for live-query correctness, since
the live query only ever reads committed data from both surfaces.

Provider `applyMutations` failure already rolls the whole action back (`providerFailure` →
refusal) before `dataGeneration` could advance (the bump is inside the same failed
transaction). A losing optimistic transaction never reaches `commitProviderRecordStaging`
(§23, §66).

---

## F1 — the DataProvider contract change

```ts
interface ProviderCapabilities {
  // … existing …
  /** How a committed provider mutation becomes observable for live-query invalidation. */
  mutationObservation: 'durable' | 'in-process' | 'none';
}

interface DataProvider {
  // … existing …
  /**
   * A monotone counter of committed mutation batches, advanced atomically with
   * `applyMutations`. Read cheaply and often by the live-query poll. A provider that does
   * not implement writes returns 0 forever. Present iff `capabilities.mutationObservation
   * !== 'none'`.
   */
  observedMutationGeneration?(): Promise<number>;
}
```

- `createSqliteDataProvider` → `'durable'`.
- `createMemoryDataProvider` → `'in-process'`.
- A custom provider with writes but no generation → `'none'`; `openLiveQuery` on a query
  whose source it backs returns `LIVE_QUERY_PROVIDER_NOT_OBSERVABLE` (fail-closed, §33,
  §123) — never "works locally, silently stale remotely".
- `'in-process'` is honest: the memory provider cannot be shared across OS processes anyway,
  so its live queries are single-authority by construction; no separate error is needed.

The name is a **semantic capability** ("a durable monotone mutation generation"), not
`WAL sequence` / `rowid` / `LSN` (§32). The SQLite row that backs it is infrastructure.

### Server integration

`AxiomServer`:

- `applicationRevision` (local, monotone). `reevaluate()` reports it as the result revision;
  the engine and cursor consume it.
- On a **local `StateDef` commit**: `applicationRevision = ++`, `observedState =
  outcome.revision`.
- On a **local provider-record commit**: `applicationRevision = ++`, `observedData = Σ
  provider.observedMutationGeneration()`; the existing synchronous `liveEngine.onCommit`
  with the precise `entityIds` stays (local fast path, §47).
- **Poll** (`liveQueryPollMs`, default 250, unchanged): read `persistence.revision()` and Σ
  provider generations. If either exceeds `observedState` / `observedData`, advance
  `applicationRevision`, `ensureStateCoherent()` (which also clears the query cache — §75),
  and `liveEngine.onCommit({ toRevision: applicationRevision, broad: true })`. The old
  "poll `persistence.revision()` only" model is gone (§45).
- `inspectLiveQueries()` / a new `revisionInspection()` expose `{ applicationRevision,
  stateRevision, dataGeneration }` distinctly (§117, §119) — a `StateDef`-only revision is
  never labelled "application revision".

Cache coherence (0.12) and `StateDef` coherence (0.12.1) continue to key on
`persistence.revision()` for `StateDef`; they are unaffected and un-regressed (§42, §43).
`ensureStateCoherent()` is still the reconcile primitive; the poll calls it so a live
re-evaluation after a remote provider commit cannot be served a stale cached one-shot
result (§75).

---

## F2 — QueryDef / StateDef scope, made consistent

**Canonical QueryDef expression scope** (unchanged, now enforced): `ref(rowScopeId)`,
`ref(<parameter id>)`, `ref(<relationship bindAs>)`, `PRINCIPAL`, and nested
iteration-scope ids introduced by `filter`/`map`/`find`/`sort`/`every`/`some` inside a
clause. **Not** `StateDef`. The query executes *by the provider*, which has no authority
state to bind.

New core helper `queryStateReferences(query, knownStateIds)` walks `filter`, every
`sort[].key`, every `projection.fields[].value`, every `groupBy` expression and every
`aggregate[].key`, and returns the `StateDef` ids referenced outside local scope.

| Layer | 0.13.0 | 0.13.1 |
| --- | --- | --- |
| `validateGraph` | accepts | `QUERY_STATE_REF_NOT_ALLOWED` (new `VALIDATION_CODES` member), one per offending `(query, stateId)` |
| `compileToServerIR` / `compileToIR` | compiles | throws `GraphValidationError` (via `validateGraph`) |
| `queryDependencies` | adds to `stateIds` | adds to a new `unsupportedStateRefs` set; **never** `stateIds` |
| `queryLiveCapability(query, idField, knownStateIds?)` | `live-capable` | `not-live-capable`, reason `"query expression references a StateDef, which QueryDef execution scope does not bind"` when `knownStateIds` is supplied and a ref matches |
| `AgentAPI.analyzeLiveQuery` | `live-capable` + state dep | `not-live-capable` + `dependencies.unsupportedStateRefs`, `reason` set |
| runtime query execution | silent wrong result | `buildProviderQuery` guards: a `StateDef` ref in a query clause throws a structured `QUERY_STATE_REF_NOT_ALLOWED` server diagnostic (defence in depth if invalid IR bypasses validation — §81) |

**ReadPolicy is a distinct scope (§82).** A `read-policy` node is validated separately
(`validateReadPolicy`). Its predicate runtime scope is *also* only `ref(rowScopeId)` +
`PRINCIPAL` — it too binds no `StateDef` — so 0.13.1 applies the same rejection to a
`read-policy` predicate's `StateDef` references, under the same code, and `queryDependencies`
routes a policy-predicate `StateDef` ref to `unsupportedStateRefs` as well. No existing
graph, demo or fixture references a `StateDef` from a `QueryDef` clause or a `ReadPolicy`
predicate (audited), so nothing previously valid is newly rejected. `semanticFingerprint`
rules are unchanged: a graph that is now rejected was never validly executable, so it had no
defined fingerprint to preserve (§92, §144.12).

**No semantic expansion (§83).** 0.13.1 does *not* add `StateDef` binding to `QueryDef`
scope to make §51-style tests easy. It makes the existing boundary explicit and uniform. A
future feature release may add first-class parameterisation from state if desired.

My own 0.13.0 tests that put `ref(stateId)` in a query filter
(`agent-api/test/live-query.test.ts`, `core/test/live-query.test.ts`) were written against
the broken behaviour and are corrected to assert rejection; the StateDef-dependency case is
re-expressed as a **query parameter** bound from an action, which is how a threshold that
varies at runtime is meant to reach a query.

---

## Server IR / fingerprints / conformance

| | Decision |
| --- | --- |
| Server IR | `axiom.server.v7` — F1 is runtime/provider infrastructure, F2 narrows validation to what the IR already means. No new portable vocabulary. |
| `semanticFingerprint` | unchanged for every valid graph. |
| `schemaFingerprint` | unchanged. |
| `AuthorityCompatibilityKey` | unchanged; two authorities at different `applicationRevision` reconcile, they do not become incompatible (§137). |
| Conformance | `axiom.conformance.v7`, additive fixtures: a portable F1 fixture (initial → provider-record mutation → observable-generation advance → re-evaluate → result changes) and F2 validation fixtures (unsupported `StateDef` ref rejected consistently). Negative control on each. `v1..v6` and the existing 10 v7 fixtures byte-frozen. |

---

## Non-negotiable invariants carried forward from 0.13.0

Canonical delta model, `insert`/`remove`/`update`/`move`/`reset`, `applyDelta` fold ==
fresh one-shot QueryDef, `move` only for a genuine relative-order change (LCS), cursor HMAC
integrity + fail-closed context binding, mixed-build refusal, reconnect through any
compatible authority, no-gap initial handoff, bounded slow-consumer → `reset`, aggregate
reset semantics, principal / parameter / ReadPolicy isolation, transport independence, the
SQLite lost-write fix (optimistic check inside `BEGIN IMMEDIATE`), zero raw SQLite leakage,
zero application semantic escape. All re-run; none may regress (§99-§108, §149).
