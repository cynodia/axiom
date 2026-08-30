# Axiom 0.13 — Realtime / Live Canonical Queries: implementation report

Release: `0.13.0-alpha.1`. Branch: `spec13-live-queries`. Baseline: `0.12.1-alpha.1`.
Design gates: `AXIOM_0_13_LIVE_QUERY_RESEARCH.md` (all 40 §185 questions). Full model:
`docs/LIVE_QUERIES.md`.

**Internal release classification target: B — LIVE CANONICAL QUERIES.** A `QueryDef` result
is observed over time — subscribe, initial coherent result, canonical deltas, reconnect
through any compatible authority — with no application transport, polling, broadcast,
fan-out, sticky routing or diffing code, and no new graph vocabulary. Server IR stays
`axiom.server.v7`.

Test totals: **1356** across the repo, all green at `0.13.0-alpha.1` (server 527 incl. the
live-query in-process, channel-transport, `axiom.conformance.v7` and real-OS-process
cross-authority suites; core 274 incl. the pure delta / dependency / capability model;
agent-api 86 incl. `analyzeLiveQuery`; demo 213). `npm run build`, `npm test`,
`release:pack` / `release:verify` / `release:consumer-test` / `release:probe` pass.

## Out-of-scope defect fixed in passing (spec12.1 F1-class)

`createSqlitePersistence.commit` read its optimistic-concurrency conflict check — and the
revision it computed the next revision from — **outside** the `BEGIN IMMEDIATE` transaction.
Two OS-process authorities could each read revision *r*, each pass the check, each write
*r+1*, and each `COMMIT` with `committed: true`; the second silently clobbered the first and
a lost write survived forever. The check now runs inside `BEGIN IMMEDIATE` (RESERVED lock
up front), so a racing writer blocks and then conflicts honestly. The spec12.1 §60
cross-process race test is strengthened to assert the deterministic converged total (every
deposit lands exactly once) rather than a total derived from a racy post-race snapshot;
green 10/10 under repeated runs. `createSqliteDataProvider` also gained `PRAGMA
journal_mode = WAL` + `busy_timeout` for the shared-file multi-authority path.

---

## Answers to §189 (external questions)

**1. Can live capability be discovered without source?** Yes. `queryLiveCapability` /
`AgentAPI.analyzeLiveQuery` are on the published API and in `.d.ts`; `openLiveQuery` returns
`LIVE_QUERY_NOT_CAPABLE` with a reason for a nondeterministic query. `docs/LIVE_QUERIES.md`
has the capability table.

**2. Is `QueryDef` still canonical?** Yes. A live query opens the *same* `QueryDef` a
one-shot `query` request runs. The conformance runner folds the delivered stream and asserts
byte-equality with a fresh one-shot execution. No parallel "live query" node kind.

**3. Is transport absent from application semantics?** Yes. `openLiveQuery` returns an
`AsyncIterable<LiveQueryMessage>` naming no transport. `serveLiveQueryChannel` /
`createLiveQueryChannelClient` are framework glue over an abstract duplex channel; the
`ApplicationGraph` mentions no socket, URL, channel or frame.

**4. Can the initial snapshot lose a concurrent commit?** No. `openLiveQuery` runs inside
the authority's serialized turn: reconcile to the durable revision → capture *R* → evaluate
at *R* → register from *R*. No local commit interleaves, and a remote commit that lands
during the turn simply raises the revision the next re-evaluation observes (model A,
revision-first).

**5. Can a remote authority commit be missed permanently?** No. Every mutating path advances
the shared durable `persistence.revision()`; an authority serving live queries re-observes
it on `liveQueryPollMs` (default 250) and re-evaluates every live subscription with a
`broad` changeset on any advance it has not already processed. A missed poll is retried on
the next tick — the durable revision is authoritative, not the notification.

**6. Can reconnect occur through another authority?** Yes — proven with real OS processes
(`live-query-cross-process.test.ts`) and in `resumeLiveQuery` unit coverage. The resuming
authority holds no materialized result, re-evaluates fresh, and the first message is a
`reset` at the current revision.

**7. Can a stale owner advance the live position?** No. There is no per-subscription lease to
strand: the durable position is the HMAC-sealed cursor, re-verified fail-closed on every
resume. A stale process that keeps iterating its own in-memory handle affects only its own
consumer; it cannot move another authority's or a shared position.

**8. Can duplicate delivery corrupt the result?** No. A logical update is identified by
`(subscriptionId, toRevision)`; `applyDelta` of an already-applied `toRevision` is
idempotent (removes/updates by key, inserts replace an existing key). Logical delivery is
at-least-once and documented as such.

**9. Can lost delivery go undetected?** No. Each message carries the `toRevision` it brings
the consumer to; a gap is visible, and the safe recovery — `resumeLiveQuery` → `reset` —
always closes it.

**10. Can out-of-order delivery corrupt the result?** Per-subscription order is monotonic by
revision by construction (single queue, single writer). Across subscriptions there is no
order and none is implied.

**11. Can replay recover?** Yes — `resumeLiveQuery` from the last cursor yields a `reset` at
the current coherent revision.

**12. Can a replay gap reset safely?** Yes — a gap is *always* a `reset`, never a silent
incremental continuation, because a fresh authority has no prior materialized result to diff
against.

**13. Can a slow consumer cause unbounded growth?** No. Pending changes per subscription are
capped (`maxPendingChanges`, default 256); past the cap the queue collapses to a single
`reset`. Covered by the engine and the conformance `limit-boundary` fixture.

**14. Can policy changes leak unauthorized rows?** No. The `ReadPolicy` predicate is AND-ed
into the effective filter on every re-evaluation; a row that becomes invisible leaves as a
`remove` / `reset`, and unauthorized data is never retained past one re-evaluation.

**15. Can another principal reuse a cursor?** No. The cursor binds a principal fingerprint;
a mismatch is `LIVE_QUERY_CURSOR_INVALID`, fail-closed, nothing disclosed.

**16. Can another `QueryDef` reuse a cursor?** No — the cursor binds `queryId`; mismatch is
`LIVE_QUERY_CURSOR_INVALID`.

**17. Can a same-schema / different-semantic build resume?** No. The cursor binds
`{ serverContract, schemaFingerprint, semanticFingerprint }`; a differing `semanticFingerprint`
is `LIVE_QUERY_CURSOR_INCOMPATIBLE` — the same fail-closed check the 0.12 distributed work
store applies.

**18. Does a presentation-only change remain compatible?** Yes. `semanticFingerprint` and
`schemaFingerprint` exclude UI / routes / themes / presentation / names / metadata, so the
cursor still resumes.

**19. Do ordering / limit queries remain correct?** Yes — recompute-and-diff makes them
correct by construction (`update-with-move`, `limit-boundary` fixtures; the fold-vs-fresh
oracle).

**20. Do aggregates remain correct?** Yes — `live-capable-reset-only`; every dependency
change delivers a whole `reset`, compared against a fresh aggregate execution
(`aggregate-reset` fixture).

**21. Do relationship changes invalidate correctly?** Yes — `queryDependencies` adds both
endpoint entities of a used or source-touching relationship to the invalidation set
(covered in `core/test/live-query.test.ts`).

**22. Do `StateDef` changes invalidate correctly?** Yes — a `StateDef` a query clause or the
effective policy predicate reads is in the dependency set; a commit that writes it wakes the
subscription.

**23. Do scheduled / event / effect-outcome changes propagate?** Yes — they commit through
the same `invokeCore` path, which advances the revision and calls `liveEngine.onCommit`; a
remote one is picked up by the revision poll.

**24. Does a lost broadcast / wakeup affect correctness?** No — there is no broadcast.
Correctness rests on the durable revision, re-observed every poll; a dropped notification is
not a correctness event.

**25. Does SQLite leak provider-native contention?** No — `createSqliteDataProvider` now uses
WAL + `busy_timeout`; a physical `SQLITE_BUSY` is absorbed, not surfaced as a query failure.
The cross-process test scans child stderr for raw SQLite errors and fails on any.

**26. Does 1 / 2 / 8 authority execution preserve live meaning?** Yes — the cross-process
test proves B observes A's commits; the meaning is "the authorized `QueryDef` result at a
committed revision" regardless of authority count.

**27–32. Does the application require Redis / locks / manual polling / manual diffing /
sticky routing / WebSocket logic?** No to all. Anti-patterns #65–#68 spell each out. The
reference channel transport is framework code.

**33. Are physical delivery guarantees described honestly?** Yes — `docs/LIVE_QUERIES.md`
"Delivery guarantees, stated honestly": at-least-once logical, per-subscription monotonic,
coalescible, bounded; physical network delivery is the adapter's to describe.

**34. Is cursor integrity fail-closed?** Yes — HMAC-SHA256, constant-time compare, and every
context mismatch is a refusal.

**35. Is authorization re-evaluated on reconnect?** Yes — `resumeLiveQuery` re-authenticates
the principal and re-resolves the policy, then checks the cursor's principal / policy
fingerprints before any evaluation.

**36. Is provider capability fallback discoverable?** The reference path is recompute-and-
diff over the ordinary `DataProvider` contract — no capability required. `query-delta` is
described as an optional future optimisation that changes no guarantee.

**37. Are live-ineligible `QueryDef`s diagnosed explicitly?** Yes — `LIVE_QUERY_NOT_CAPABLE`
with a reason string; `analyzeLiveQuery` reports it statically.

**38. Are runtime semantics inspectable through AgentAPI?** Yes — `AgentAPI.analyzeLiveQuery`
(capability, dependencies, identity field, cursor binding, delivery contract);
`AxiomServer.inspectLiveQueries()` for the live listing.

**39. Are conformance fixtures portable?** Yes — `axiom.conformance.v7` (`conformance/live/`),
each a self-contained `axiom.server.v7` Server IR + dataset + script + expectations; the
public runner uses only the `DataProvider` contract, over memory *and* SQLite providers,
with two negative controls.

**40. Can the tester falsify topology transparency?** The cross-process test is the standing
attempt: two real authorities, shared SQLite, a live query on B, commits on A — B converges
on the authoritative set through the durable revision alone.

---

## What is deferred (spec13 §192, honestly)

- A dedicated `demo` reference application graph (Phase 18) — the cross-process trial and the
  conformance fixtures exercise the same surface end to end; a narrative demo is still worth
  adding.
- A scale/security matrix beyond the current unit + cross-process coverage (Phase 19).
- A `query-delta` provider capability — the recompute-and-diff reference path is complete and
  correct; the optimisation is not required for any guarantee.
- Every §192 item (production CDC, Redis pub/sub provider, Kafka, global cross-subscription
  ordering, offline history, CRDT results, GraphQL-subscription compatibility, automatic
  client UI binding).

## Blind external validation (D1 / E1 / S1)

Pending — requires the published `0.13.0-alpha.1` packages. `release:probe` confirms a cold
agent is routed to `docs/AGENT_REFERENCE.md` and `docs/LIVE_QUERIES.md` from the tarball
alone.
