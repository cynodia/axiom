# Axiom 0.10 — implementation progress tracker

Working notes for the autonomous build loop. Not a deliverable; superseded by
`AXIOM_0_10_IMPLEMENTATION_REPORT.md` at the end. Branch: `spec10-query-layer`.

Design authority: `reports/AXIOM_0_10_QUERY_RESEARCH.md` (the §4 decision).

## Phase status

| # | Phase | State |
| - | ----- | ----- |
| 0 | Research doc — §4 three-way comparison + decision | ✅ committed `9d4f1fd` |
| 1 | `core` vocabulary: `query.ts` / `relationships.ts` / `read-policy.ts`, type/index wiring, diagnostics codes, `axiom.server.v6` contract + `serverIRExpressions` + `ServerIR` fields | ✅ committed |
| 2 | `core` validation (`validate.ts`) for QueryDef/RelationshipDef/ReadPolicyDef + `derive-edges.ts` read/reference edges + `query.test.ts` (18 tests). **`Location` `provider-record` extension moved to phase 6** (it touches the runtime mutation subsystem — belongs with the action/mutation work). | ✅ committed |
| 3 | `compiler`: `compileToServerIR` emits queries/relationships/readPolicies + `axiom.server.v6` via `usesQueryVocabulary` + `compileToIR` strips all three kinds from client IR + `authorityContext`/`serverStateClosure` extended for query/policy state reads + `query-compile.test.ts` (3). **Effective-filter policy-conjunct construction moved to phase 5** (per-request, needs PRINCIPAL binding + scope substitution — belongs in the server runtime). | ✅ committed |
| 4 | `server`: `data-provider.ts` (DataProvider / ProviderCapabilities / ProviderQuery / ProviderPage / QueryPlan / ProviderMutation / requiredCapabilities), `query-eval.ts` (pure query-subset evaluator + frozen null/collation/code-point semantics), `memory-data-provider.ts` (deterministic reference provider: filter, multi-key sort, null ordering, keyset + offset pagination, projection, **batched** to-one/to-many traversal, count/sum/min/max/average, first-seen grouping, loadByIdentity, atomic applyMutations, explain). `data-provider.test.ts` (10). | ✅ committed |
| 5 | `server`: `query-runtime.ts` (rebindRef, effectiveFilter = And(filter, policy.predicate) with policy rowScope → query rowScope, identity tie-breaker appended, buildProviderQuery), `query-cursor.ts` (Web Crypto HMAC-SHA256 seal/open, SHA-256 fingerprints of queryId/args/principal/policy/contract, timing-safe compare), protocol `QueryRequest`/`QueryResponse`/`QueryPageResult`/`QueryAggregateResult`, `createAxiomServer` gains `dataProvider`/`dataProviders`/`cursorSecret`, `handle()` query branch, `runQuery()` (arg validation, page-size ceiling refusal, cursor verify against exact context, capability check + plan.unsupported, aggregate + row paths, cursor seal), 8 new `SERVER_DIAGNOSTIC_CODES.QUERY_*`. `query-runtime.test.ts` (10). | ✅ committed |
| 6a | `query` operation: `QueryOperation` in `Operation` union + `OPERATION_KINDS`; `actionUsesQuery` makes an action server-authority; validation (`invalidQueryOperation`); edge derivation; runtime pre-transaction resolution via `host.runQuery` (mirrors `integration-query`), no-op in-transaction case, `QUERY_RESOLVER_UNAVAILABLE`/`QUERY_OPERATION_FAILED` codes; `createAxiomServer` supplies `host.runQuery` via `executeQueryForOperation` (policy-injected, `activePrincipal`-bound, page-bounded). Tests: `collections.test.ts` probe, `query-runtime.test.ts` +1. | ✅ committed |
| 6b | `core` `Location` `provider-record` variant: `ProviderRecordLocation` + `providerRecordLocation`/`providerRecordFieldLocation` builders; `locationRootStateId` returns the source entity id, new `locationProviderEntityId`; `locationExpressions`/`locationSelectorFieldIds` cover the identity value; `inferLocationType`/`locationCapabilities` (writable) support it; `validate-location.ts` case (`invalidProviderRecordLocation`); `actionWritesProviderRecord` → server authority; `resolve-location.ts` throws an authority-only message. Tests: `query.test.ts` +2, `query-compile.test.ts` +1. | ✅ committed |
| 6c | `server`: `provider-record-runtime.ts` (staging state id, `providerEntitiesWritten`, `rewriteForStaging` provider-record→collection-item, `identityValuesToLoad`, `diffRows`→ProviderMutation, `stagingStateDef` — server-authority, NOT ephemeral so constraints run). `buildRuntime` injects staging states + rewritten actions into the runtime IR only (ServerIR untouched). `invokeCore`: loads addressed rows before the transaction, the rewritten action runs through the unchanged engine, `commitProviderRecordStaging` diffs staging and `applyMutations` atomically only on success, staging always cleared. `RemoveOperation.target` widened to accept `provider-record`; `mutation-engine.ts` + `resolve-location.ts` throw an authority-only message for a raw one. `provider-record.test.ts` (4): identity mutation without materializing, constraint rollback, valid set, remove. **Answers spec §118 = yes.** for-each-over-provider-rows deferred. | ✅ committed |
| 7 | `server`: `sql-query.ts` (query-subset Expression → parametrized SQL; frozen null/BINARY-collation/IEEE-754 semantics; values always bound, never identifiers; `UnsupportedQueryExpression` on anything outside the subset). `sqlite-data-provider.ts` (`createSqliteDataProvider` on `node:sqlite`: table-per-entity, column-per-field, pushed-down filter/sort/LEFT JOIN to-one/aggregate/GROUP BY with `MIN(_seq)` first-seen order, lexicographic keyset `WHERE` predicate with per-key NULL handling, `BEGIN IMMEDIATE` for writes, projection applied in JS over the bounded page — never 51 queries). `provider-parity.test.ts` (9): memory ≡ SQLite for filter/compound/multi-sort/null-order/projection+join/cursor pages/count-sum-min-avg/grouping/unsupported-rejection. **Answers spec §90.** | ✅ committed |
| 8 | `server/src/query-conformance.ts` (`QueryConformanceFixture` data model + portable `runQueryConformanceFixture` / `runQueryConformanceSuite` — `axiom.conformance.v4`). `scripts/query-conformance.mjs` generates 16 fixtures to `packages/server/conformance/queries/*.json` + manifest; wired into `conformance:generate`. `query-conformance.test.ts` (34): every fixture through memory AND SQLite + §89-coverage + memory≡SQLite parity. | ✅ committed |
| 9 | `core`: `SERVER_IR_V6_OPERATION_KINDS = ['query']`. `scripts/schema.mjs`: `server-ir.v6.schema.json` (queries/relationships/readPolicies top-level; QueryDef/RelationshipDef/ReadPolicyDef/ProviderRecordLocation/query-operation `$defs`; provider-record in Location + remove target — all gated `atLeast(v6)`, v1-v5 byte-unchanged). `protocol.v1.schema.json`: QueryRequest/QueryResponse/QueryPageResult/QueryAggregateResult added (additive; protocol id unchanged). `schema.test.ts`: v1-vocabulary assertion excludes v6 ops; new test validates all 16 query fixtures against the v6 schema. **`server/schema.test.js` known-red CLEARED — server suite fully green (237).** | ✅ committed |
| 10 | `runtime/src/query-state.ts`: `QUERY_LIFECYCLE_STATES` + `createQueryStore(fetcher)` — per-key `QueryView` with `load`/`refresh`/`loadMore`/`reset`/`subscribe`. Failed first load → `error` no data (distinguishable from ready-with-zero-rows §58); failed refresh → `error` but last good data kept (§60); `refresh`/`loadMore` → `refreshing` with data visible (§59). `remote.ts`: `query()` method + `RemoteQueryRequest`/`RemoteQueryResult`. Tests: `query-state.test.ts` (9) + `query-runtime.test.ts` client-store-over-real-authority (1). Full UI render wiring deferred to phase 11. | ✅ committed |
| 11 | `@cynodia/axiom-ui`: `entity-list` consumes QueryDef, pagination/filter controls, `metric-grid` aggregate consumption, async presentation states | ⬜ |
| 12 | `agent-api/src/queries.ts`: `listQueries`/`getQuery`, `listRelationships`/`getRelationship`/`getRelationshipsForEntity`, `listReadPolicies`/`getReadPolicyForEntity`/`getReadPolicyForQuery`, `getQueryParameters`/`isAggregateQuery`/`getQueryResultEntity`/`getQueryEntities`/`getQueryRelationships`/`getQueryFields`, `getActionsInvalidatingQuery` (conservative: writes a state holding a read entity, or a provider-record of one) + inverse `getQueriesInvalidatedByAction`, `explainQuery` (§86 structural account), `MutationImpact.affectedQueries`. `query-introspection.test.ts` (8). | ✅ committed |
| 13 | `server.ts`: conservative query result cache. Key = `[queryId, argsFingerprint, principalFingerprint, policyFingerprint, contract, cursor, pageSize, offset]` (spec §69). Bounded LRU-ish (default 128, `queryCache: {maxEntries}` / `false`). Any committed mutation (durable or provider-record) clears the whole cache (§72). `AxiomServer.clearQueryCache()` + `queryCacheStats()`. `query-runtime.test.ts` +5: served-from-cache, mutation clears it, **cross-principal B-never-gets-A-data (§70)**, disable, clearQueryCache. | ✅ committed |
| 14 | reference app `packages/demo/src/order-management.ts` + large dataset generation + Dashboard/Orders/Detail/Accounts/History screens | ⬜ |
| 15 | test suites: scale/bounded-materialization gate, N+1 gate, aggregate gate, hostile client suite, valid-but-wrong suite, memory/SQL parity | ⬜ |
| 16 | docs: `QUERIES.md` / `RELATIONSHIPS.md` / `READ_POLICY.md`, `AGENT_REFERENCE` section, `AUTHORITY.md` v6 row + semantics, `VALIDATION.md` codes, `ANTI_PATTERNS.md`, README map, `documentation.test.ts` drift green | ⬜ |
| 17 | version bump 0.10.0-alpha.1 across every manifest + `docs:sync` + `release:prepare` green + `AXIOM_0_10_IMPLEMENTATION_REPORT.md` (60 answers) + release classification | ⬜ |

## Known-red tests (expected until the noted phase)

- `demo/documentation.test.ts` "every validation code is documented" — new `VALIDATION_CODES` for query layer. Fixed in **phase 16**.
- `demo/documentation.test.ts` "every server diagnostic code is documented" — 8 new `SERVER_DIAGNOSTIC_CODES.QUERY_*`. Fixed in **phase 16**.
- `demo/documentation.test.ts` "every runtime diagnostic code is documented" — `QUERY_RESOLVER_UNAVAILABLE`, `QUERY_OPERATION_FAILED`. Fixed in **phase 16**.
- `demo/documentation.test.ts` "every Server IR contract has a row in AUTHORITY.md" — `axiom.server.v6`. Fixed in **phase 16**.
- `demo/documentation.test.ts` "every shipped server-ir schema file is named in AGENT_REFERENCE.md" — `server-ir.v6.schema.json`. Fixed in **phase 16**.
- ~~`server/schema.test.ts`~~ — CLEARED in phase 9.

**Server package is fully green as of phase 9.** All 5 remaining known-red are in `demo/documentation.test.ts`, fixed in phase 16 (docs).

Baseline before phase 1: 803 pass / 0 fail. After phase 4: 3 known-red (above), rest green.
Suites: core 175→193, compiler 139→142, server 165→175.

Deferred within phases: `starts-with` / `startsWith` portable text predicate not added to
core `BUILTIN_FUNCTIONS` yet — `contains` covers spec §26's minimum. Add in phase 14 if the
reference app needs prefix search (touches core builtins + runtime eval + collections
enumeration test).

## Design decisions locked (from the research doc)

- `QueryDef` = one node, fixed clauses, `Expression` leaves. No `QueryPredicate` union.
- `RelationshipDef` symmetric, per-direction, never inferred. To-one `to.fieldId` must be target identity.
- `ReadPolicyDef` row-level only; field-level **deferred** (§52). One policy per entity. Predicate AND-ed server-side.
- Effective filter = `And(filter ?? true, readPolicy.predicate)`, built in compiler/authority.
- Cursor = opaque base64url, HMAC'd, wraps `{queryId, sortValues, identityValue, principalFingerprint, policyFingerprint, contractVersion}`.
- Temporal: reuse `date`/`datetime` primitives. No new type. ISO-8601 strings in IR.
- Null: `eq`/cmp with null ⇒ no match; sort nulls = last(asc)/first(desc) unless overridden.
- `query` action operation: `{kind:'query', queryId, arguments, bindAs}` — resolved pre-transaction, reads own authoritative data, NOT an integration.
- `provider-record` Location selector: `{sourceEntityId, identityValue}` — extends `Location`, no parallel mutation model.
- Contract `axiom.server.v6`, computed by `usesQueryVocabulary(ir)`.
- New conformance tier `axiom.conformance.v4` (scripted data providers).
- Domain-neutral example vocabulary in framework source: `Order` / `Account` / `Item` (NOT customer/product — architecture leak scan forbids those).
