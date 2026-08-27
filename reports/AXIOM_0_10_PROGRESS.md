# Axiom 0.10 — implementation progress tracker

Working notes for the autonomous build loop. Not a deliverable; superseded by
`AXIOM_0_10_IMPLEMENTATION_REPORT.md` at the end. Branch: `spec10-query-layer`.

Design authority: `reports/AXIOM_0_10_QUERY_RESEARCH.md` (the §4 decision).

## Phase status

| # | Phase | State |
| - | ----- | ----- |
| 0 | Research doc — §4 three-way comparison + decision | ✅ committed `9d4f1fd` |
| 1 | `core` vocabulary: `query.ts` / `relationships.ts` / `read-policy.ts`, type/index wiring, diagnostics codes, `axiom.server.v6` contract + `serverIRExpressions` + `ServerIR` fields | ✅ committed |
| 2 | `core` validation (`validate.ts`) for QueryDef/RelationshipDef/ReadPolicyDef + `infer.ts` result typing + `derive-edges.ts` read/reference edges + `validate-location.ts` for `provider-record` + `Location` extension | ⬜ |
| 3 | `compiler`: `compileToServerIR` emits queries/relationships/readPolicies + contract computation via `usesQueryVocabulary` + `compileToIR` strips them from client IR + effective-filter (policy conjunct) construction | ⬜ |
| 4 | `DataProvider` contract + capabilities + deterministic memory provider + `QueryPlan` inspection type (in `server`) | ⬜ |
| 5 | server runtime: query execution, cursor encode/verify (fingerprints), page-size enforcement, read-policy injection, aggregate/group, relationship batching (no N+1) | ⬜ |
| 6 | `query` operation wired into `Operation` union + `OPERATION_KINDS` + runtime execution + `provider-record` location resolution + transactional provider reads/writes | ⬜ |
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
- `demo/documentation.test.ts` "every Server IR contract has a row in AUTHORITY.md" — `axiom.server.v6`. Fixed in **phase 16**.
- `server/schema.test.ts` — expects `server-ir.v6.schema.json`. Fixed in **phase 9**.

Baseline before phase 1: 803 pass / 0 fail. After phase 1: 3 known-red (above), rest green.

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
