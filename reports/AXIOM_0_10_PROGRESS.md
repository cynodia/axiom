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
| 6b | **`Location` `provider-record` selector** (`location.ts` + `validate-location.ts` + `resolve-location.ts` + `authority.ts` root-state handling) + transactional provider row load-into-transaction + `provider.applyMutations` post-commit atomic write + cross-record constraints over provider-backed rows | ⬜ |
| 7 | SQLite reference provider + parametrized SQL builder + memory/SQL parity harness | ⬜ |
| 8 | portable conformance fixtures (≥18, `axiom.conformance.v4`) + `runConformanceFixture` wiring + `conformance:generate` | ⬜ |
| 9 | `schema:generate` → `server-ir.v6.schema.json` + protocol schema (`QueryRequest`/`QueryResponse`) | ⬜ |
| 10 | client runtime query lifecycle (`idle`/`loading`/`ready`/`refreshing`/`error`), stale-but-visible, manual refresh, `remote.ts` query transport | ⬜ |
| 11 | `@cynodia/axiom-ui`: `entity-list` consumes QueryDef, pagination/filter controls, `metric-grid` aggregate consumption, async presentation states | ⬜ |
| 12 | `agent-api`: query introspection + `explainQuery` + Action→Query invalidation + mutation-impact extension | ⬜ |
| 13 | conservative cache + cache identity (principal/policy fingerprint) + cross-principal leak test + invalidation on mutation | ⬜ |
| 14 | reference app `packages/demo/src/order-management.ts` + large dataset generation + Dashboard/Orders/Detail/Accounts/History screens | ⬜ |
| 15 | test suites: scale/bounded-materialization gate, N+1 gate, aggregate gate, hostile client suite, valid-but-wrong suite, memory/SQL parity | ⬜ |
| 16 | docs: `QUERIES.md` / `RELATIONSHIPS.md` / `READ_POLICY.md`, `AGENT_REFERENCE` section, `AUTHORITY.md` v6 row + semantics, `VALIDATION.md` codes, `ANTI_PATTERNS.md`, README map, `documentation.test.ts` drift green | ⬜ |
| 17 | version bump 0.10.0-alpha.1 across every manifest + `docs:sync` + `release:prepare` green + `AXIOM_0_10_IMPLEMENTATION_REPORT.md` (60 answers) + release classification | ⬜ |

## Known-red tests (expected until the noted phase)

- `demo/documentation.test.ts` "every validation code is documented" — new `VALIDATION_CODES` for query layer. Fixed in **phase 16**.
- `demo/documentation.test.ts` "every server diagnostic code is documented" — 8 new `SERVER_DIAGNOSTIC_CODES.QUERY_*`. Fixed in **phase 16**.
- `demo/documentation.test.ts` "every runtime diagnostic code is documented" — `QUERY_RESOLVER_UNAVAILABLE`, `QUERY_OPERATION_FAILED`. Fixed in **phase 16**.
- `demo/documentation.test.ts` "every Server IR contract has a row in AUTHORITY.md" — `axiom.server.v6`. Fixed in **phase 16**.
- `server/schema.test.ts` — expects `server-ir.v6.schema.json`. Fixed in **phase 9**.

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
