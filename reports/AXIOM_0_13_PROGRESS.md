# Axiom 0.13 — Realtime / Live Canonical Queries progress

Working notes. Superseded by `AXIOM_0_13_IMPLEMENTATION_REPORT.md`. Branch:
`spec13-live-queries`. Baseline: `0.12.1-alpha.1`.

Design gates resolved in `AXIOM_0_13_LIVE_QUERY_RESEARCH.md` (spec13 §185, all 40 questions).

**Frozen decisions:**

- No new graph vocabulary (§5, §6, §148). Server IR stays `axiom.server.v7` (§151) —
  `semanticFingerprint` is computed *from* the IR, never carried *in* it.
- Logical identity = `{ queryId, argumentsFingerprint, principalFingerprint,
  policyFingerprint, compatibilityFingerprint }` + a runtime `subscriptionId`.
- Durable resumable position = the versioned, HMAC-sealed `axiom.live-query-cursor.v1`
  cursor (server-sent, no ACK, §85). In-authority state = the last materialized result,
  bounded by the query's max page size.
- Reference correctness path = **recompute-and-diff** over the ordinary `DataProvider`
  (§56). `query-delta` is an optional provider optimisation that changes latency/CPU only.
- Model A revision-first replay for the no-gap handoff (§10, §11).
- Canonical delta model: `insert` / `remove` / `update` / `move` / `reset` (§13-§16).
- New conformance tier `axiom.conformance.v7` for live fixtures (§152); `v1..v6` byte-frozen.
- No application transport / polling / broadcast / diff code (§87). Reference WebSocket host
  adapter maps `LiveQueryHandle` → frames.

## Phase status (spec13 §184)

| # | Phase | State |
| - | ----- | ----- |
| 1 | Semantic model / design gates — `AXIOM_0_13_LIVE_QUERY_RESEARCH.md`, all 40 §185 questions answered before implementation. | ✅ |
| 2 | Live query identity + cursor — `packages/server/src/live-query.ts`: `LiveQueryIdentity` / `liveQueryIdentity` / `liveQueryIdentityKey` / `newSubscriptionId`; `LIVE_QUERY_CURSOR_VERSION = 'axiom.live-query-cursor.v1'`, `LiveCursorPayload`, `sealLiveCursor` (base64url body + HMAC-SHA256, `node:crypto`), `openLiveCursor` (constant-time compare, fail-closed), `liveCursorMatch` (returns first divergent field — `version`/`query`/`principal`/`parameters`/`policy`/`compatibility`). | ✅ |
| 3 | Initial result + no-gap handoff — `server.openLiveQuery` runs inside the authority's `serialize()` turn: reconcile (0.12.1 `ensureStateCoherent`) → capture revision R → evaluate at R → register from R, so no local commit interleaves (model A, §10, §11). | ✅ |
| 4 | Canonical result delta — `diffResults(prev, next, identityFieldId, ordered)`: recompute-and-compare against semantic row identity → `insert` / `remove` / `update` / `move`; falls back to a single `reset` when a result has no stable per-row identity, a duplicate identity appears, or the result is aggregate/grouped (`resetOnly`). `applyDelta` is the inverse (test oracle: applied stream == fresh `QueryDef` result). | ✅ |
| 5 | Dependency analysis — `queryDependencies(query, policy, relationships, knownStateIds)` walks `filter` / `sort[].key` / `projection.fields[].value` / `groupBy` / `aggregate[].key` / `policy.predicate` over the Expression trees; local scopes = rowScopeId + params + `PRINCIPAL` + relationship `bindAs` + nested iteration scopeIds; an unresolved `ref` sets `broad = true` (conservative, no false negatives, §27). `commitAffectsQuery(changeset, deps)`. | ✅ |
| 6 | Revision-driven re-evaluation — `createLiveQueryEngine().onCommit(changeset)` wakes every subscription whose dependency set the commit may have touched, re-evaluates via `spec.reevaluate()` (which reconciles first), diffs, and enqueues a delta / reset / nothing (false-positive invalidation → no client message). Wired into `server.ts` `invokeCore` **both** on the durable-commit path and on the provider-record early-return path (a provider-record commit writes no durable `StateDef`). | ✅ |
| 7 | Ordering / limit / aggregate semantics — recompute-and-diff makes these correct by construction; `packages/server/test/live-query.test.ts` asserts fresh-query equivalence for filter flips, sort-key moves, aggregate reset-only, and the applied-delta round-trip. | ✅ |
| 8 | Authorization — `ReadPolicy` + principal bound into every `reevaluate()` exactly as a one-shot query; the cursor binds `policyFingerprint` + `principalFingerprint`, so a reconnect with a changed policy/principal is refused `LIVE_QUERY_CURSOR_INVALID`, and a policy-relevant commit re-evaluates under the current policy (rows no longer visible → `remove`/`reset`). | ✅ |
| 9 | Durable logical subscription state — the cursor is the durable resumable position; `LiveSubscriptionStore` + `createMemoryLiveSubscriptionStore` (bounded, memory reference) retains `{ subscriptionId, identity, lastRevision, updatedAt }` for observability + GC, `DEFAULT_LIVE_SUBSCRIPTION_RETENTION_MS` (1 h) window with per-record `sweep()`; a reconnect past the window still works as a fresh-evaluation `reset`. Wired into the engine (`LiveQueryEngineOptions.subscriptionStore`). | ✅ |
| 10 | Distributed ownership / fencing — reconnect-anywhere + reset-on-fresh-authority means a lost owner never blocks a consumer (the durable position is the HMAC cursor, re-verified fail-closed on resume; there is no per-subscription lease to strand). The idle-authority **revision poll** (`liveQueryPollMs`, default 250) re-observes `persistence.revision()`; a `CommitChangeset.broad` wake re-evaluates every live subscription when another authority has committed (spec13 §31, §32, §68). Compatibility fingerprint in the cursor fences a mixed-build resume exactly as the 0.12 `DurableWorkStore` does. | ✅ |
| 11 | Reconnect / replay / reset — `server.resumeLiveQuery(cursor, request)`: `openLiveCursor` → `liveQueryContext` → `liveCursorMatch` (mismatch `compatibility` → `LIVE_QUERY_CURSOR_INCOMPATIBLE`, else `LIVE_QUERY_CURSOR_INVALID`) → fresh evaluate → `liveEngine.resume` (first message `reset` at the current coherent revision). Any compatible authority. | ✅ |
| 12 | Backpressure / coalescing — engine keeps a bounded pending-delta buffer per subscription (`maxPendingChanges`, default 256); over the bound it collapses the queue to a single `reset`. Consecutive dependency commits coalesce (position advances without a client message when the result is unchanged). A whole-result diff is delivered as a `reset` *message*, not an `update` wrapping a `reset` change. Covered by `live-query.test.ts` + conformance `aggregate-reset` / `limit-boundary`. | ✅ |
| 13 | SQLite cross-process reference — `live-query-cross-process.test.ts`: two real OS-process authorities over one shared SQLite persistence + one shared SQLite data provider (now WAL + `busy_timeout`). A live query opened on authority B observes provider-record commits made on authority A through the shared durable revision alone — no broadcast, no sticky routing. Folded stream converges to the authoritative set. | ✅ |
| 14 | Transport-independent server API — `openLiveQuery` / `resumeLiveQuery` / `closeLiveQuery` / `inspectLiveQueries` on `AxiomServer`; `LiveQueryHandle` = `AsyncIterable<LiveQueryMessage> & { subscriptionId, cursor(), close() }`. No Node stream, no socket. | ✅ |
| 15 | Real reference transport — `live-query-channel.ts`: `serveLiveQueryChannel(server, channel)` + `createLiveQueryChannelClient(channel)` pump a `LiveQueryHandle` over any duplex frame channel (`open`/`resume`/`close` ⇄ `message`/`error`/`closed`). `createInMemoryChannelPair` (structured-clone frames) stands in for a WebSocket in tests. A reference WebSocket host is ~4 lines and the application writes none of it. `live-query-channel.test.ts` (4). | ✅ |
| 16 | AgentAPI / inspection / explain — `analyzeLiveQuery(queryId)` in `packages/agent-api` (+ `AgentAPI.analyzeLiveQuery`): live capability + reason, dependency set (entities / states / read policy / `broad`), ordered/aggregate classification, row identity field, the six cursor-binding fields, and the honest delivery contract. `packages/agent-api/test/live-query.test.ts` (4) + `packages/core/test/live-query.test.ts` (14). | ✅ |
| 17 | Portable conformance — `axiom.conformance.v7` tier: `live-query-conformance.ts` (`LiveQueryConformanceFixture` = initial data + `QueryDef` + committed-mutation script + required `initial` + per-step `update`/`reset`/`none`; the runner also folds the stream with `applyDelta` and asserts equality with a fresh one-shot `QueryDef` execution). `scripts/live-query-conformance.mjs` writes 10 fixtures + manifest under `conformance/live/` (`baseContract: axiom.server.v7`). Public `runLiveQueryConformanceFixture` / `runLiveQueryConformanceSuite` over memory + SQLite providers; two negative controls. `v1..v6` untouched. | ✅ |
| 18 | Reference application — the cross-process trial (`live-query-cross-process.test.ts`) + the 10 `axiom.conformance.v7` fixtures exercise the full surface end to end. A dedicated narrative `demo` graph is deferred (see report). | ◑ |
| 19 | Chaos / scale / security — cursor tampering / principal / parameter / policy / compatibility mismatch, the false-positive-invalidation skip, reconnect-different-authority (real processes), and slow-consumer/coalescing (`limit-boundary` + engine `maxPendingChanges`) are covered. A dedicated large-scale matrix is deferred (see report). | ◑ |
| 20 | Documentation / release preparation — `docs/LIVE_QUERIES.md` (canonical), `docs/AGENT_REFERENCE.md` §LIVE QUERIES, `docs/AUTHORITY.md` diagnostic rows, anti-patterns #65–#68, README + facade README doc-map rows, `CLAUDE.md` spec13 entry. Version bump `0.12.1-alpha.1 → 0.13.0-alpha.1` across every manifest, doc line, `llms.txt`, `graph.ts` default, `package-lock.json`. `conformance:generate` runs `live-query-conformance.mjs`. `AXIOM_0_13_IMPLEMENTATION_REPORT.md` (all 40 §189 answers). `release:pack` / `verify` / `consumer-test` / `probe` green; `documentation.test.ts` green. | ✅ |
| 21 | Blind external validation (D1 / E1 / S1). | ⏳ **post-publish** |

## Out-of-scope defect fixed in passing

`packages/server/src/sqlite-persistence.ts` — the optimistic-concurrency conflict check
(and the revision it computes against) was read **outside** the `BEGIN IMMEDIATE`
transaction, so two OS processes could both pass the check against revision *r*, both write
*r+1*, and both `COMMIT` — the second silently clobbering the first while both returned
`committed: true`. A lost write then survived forever. This is a spec12.1 F1-class defect
(distributed `StateDef` coherence). Fixed: the check now runs inside `BEGIN IMMEDIATE`, so a
racing writer blocks on the RESERVED lock and then conflicts honestly. The spec12.1 §60
cross-process race test is strengthened to assert the deterministic converged total (every
deposit lands exactly once) rather than a total derived from a racy post-race snapshot;
green 10/10 under repeated runs.

## Release classification target (spec13 §153): **B — LIVE CANONICAL QUERIES**
