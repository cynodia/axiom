# Axiom 0.10.0 Implementation Report
## Semantic Data Access & Query Layer

Target: `@cynodia/axiom` 0.10.0-alpha.1
Baseline: 0.9.0-alpha.1
Spec: `specs/spec10.md`
Companion: [`AXIOM_0_10_QUERY_RESEARCH.md`](AXIOM_0_10_QUERY_RESEARCH.md) — the §4 three-way
architecture comparison and the decision.

## Summary

0.9 completed Axiom's relationship with the outside world. 0.10 removes the assumption that
authoritative *application* data is small enough to materialize. An application can now
express filtering, sorting, pagination, projection, relationship traversal, aggregation,
transactional record lookup and read authorization over a 500,000-row dataset — with **no**
application-specific SQL, ORM call, repository class, data endpoint, `fetch()` or bulk load
into a `StateDef`.

```
StateDef          bounded, materialized semantic state          (unchanged)
QueryDef          demand-driven read over authoritative data     (new)
DataProvider      physical execution — SQL, indexes, plan        (new)
ReadPolicyDef     which rows a principal may observe             (new)
RelationshipDef   an explicit entity-to-entity link             (new)
```

What shipped:

- **`QueryDef`** — one graph node, a fixed set of named clauses, every leaf an ordinary
  `Expression`. No second predicate or arithmetic language.
- **`RelationshipDef`** (explicit, never inferred) and **`ReadPolicyDef`** (row-level;
  field-level deferred), with the read-policy predicate AND-ed into every query's effective
  filter on the authority.
- **`DataProvider`** contract plus two reference providers — `createMemoryDataProvider`
  (deterministic) and `createSqliteDataProvider` (`node:sqlite`, parametrized SQL) — proven
  semantically identical by a parity harness and 16 portable fixtures.
- A **`query` operation** inside an action, and a **`provider-record` `Location`** for
  transactional mutation of canonical rows that were never materialized.
- **`axiom.server.v6`** — computed from the document; every pre-0.10 graph still compiles to
  its byte-identical older contract.
- A **client query lifecycle** (`createQueryStore`), a **fingerprinted result cache**, and
  **AgentAPI** introspection including `explainQuery`.
- **`docs/QUERIES.md`**, the `axiom.server.v6` JSON Schema, and the `axiom.conformance.v4`
  fixture format with a public reference runner.
- A reference **Order Management** application and the spec §100–105 gate suites.

941 tests pass. `npm run release:prepare` is green end to end.

---

## Answers to spec §121

**1. Which competing query architectures were prototyped?**
Three, per §4: (A) `QueryDef` as declarative clauses with their own predicate union;
(B) `QueryDef` carried by existing Axiom `Expression` pipelines; (C) compositional query
operator nodes chained by id. See `AXIOM_0_10_QUERY_RESEARCH.md` for the throwaway
prototypes and the nine-criterion evaluation.

**2. Which architecture was selected and why?**
An **A-shaped container with B-shaped leaves**: one node with a fixed, closed set of named
clauses (A's container — one JSON schema fragment, no open grammar, capability-per-clause),
where every leaf value is an ordinary `Expression` (B's leaves — one comparison language,
one arithmetic, one dependency walker, `expression-ref` reuse for free). C was rejected as a
query-optimizer-shaped surface the spec §115 rules out.

**3. What is `QueryDef`?**
A reusable graph node: `id`, typed `parameters`, an authoritative `source` entity,
`rowScopeId`, and the clauses `filter` / `sort` / `relationships` / `projection` / `groupBy`
/ `aggregate` / `pagination` / `readPolicyId`. It is invoked by id with typed arguments,
survives compilation into `axiom.server.v6`, and is stripped from the client IR.

**4. How does `QueryDef` differ from `StateDef`?**
`StateDef` is bounded, materialized state, validated per-instance and held whole.
`QueryDef` is demand-driven: nothing is held; a `DataProvider` computes each page. A
`QueryDef` result is a *view* of canonical data, never an independently authoritative copy.

**5. How does `QueryDef` differ from Integration Query?**
An `integration-query` observes an *external* system through an `IntegrationDef`. A query
reads the application's *own* canonical database, inside the Axiom authority boundary —
which is what makes read authorization, dependency analysis and cache identity apply. A
`query` operation is a first-class operation, not an `IntegrationOperationDef`.

**6. How are parameters represented?**
`QueryParameter[]` with Axiom `TypeRef` value types. Arguments are checked against them and
rejected (`QUERY_ARGUMENT_TYPE_MISMATCH`) before the provider is touched — the same
`validateValueAgainstType` walk that checks seed data.

**7. How are predicates represented?**
`filter` is a boolean `Expression` over `ref(rowScopeId)`, the parameters, `PRINCIPAL` and
relationship binds. Operators are the existing `binary` / `unary` / `call('contains')`
vocabulary — no `QueryPredicate` union.

**8. How is ordering represented?**
`sort: QuerySortKey[]` — each `{ key: Expression, direction, nulls }` — most significant
first.

**9. How is stable ordering guaranteed?**
Canonical identity is appended as a final, ascending sort key by `buildProviderQuery`. A
cursor query whose `source` has no `identityFieldId` is rejected `UNSTABLE_PAGINATION` at
validation.

**10. What cursor model was selected?**
Keyset. The cursor is an opaque base64url token: `{ position, queryFingerprint,
argsFingerprint, principalFingerprint, policyFingerprint, contract }`, HMAC-SHA-256 signed
with a per-authority secret via `globalThis.crypto.subtle` (portable across Node, browsers,
Deno, workers).

**11. How are cursors protected from cross-principal / cross-query reuse?**
Continuing decodes the token, verifies the HMAC, then compares the four fingerprints to the
*current* request's context. Any mismatch — a different principal, query, policy or contract
— is `QUERY_CURSOR_INVALID` with nothing disclosed. Tests: cross-principal and cross-query
cursor rejection in `query-runtime.test.ts` and `order-management-gates.test.ts`.

**12. How is page size authority-enforced?**
`min(QueryDef.pagination.maxPageSize, provider.capabilities.maxPageSize)` is the ceiling. A
request above it is **refused** (`QUERY_PAGE_SIZE_EXCEEDED`), never truncated. A request
naming no size gets `defaultPageSize`.

**13. How is projection represented?**
`QueryProjection = { entityId, fields: [{ id: FieldId, value: Expression }] }`. The result
row conforms to `entityId`. Computed values reuse expression semantics (`lineTotal =
binary('multiply', …)`).

**14. How are relationships represented?**
`RelationshipDef` — `from { entityId, fieldId }`, `to { entityId, fieldId }`, `cardinality`.
Explicit and directional; a query traverses one via `QueryRelationshipUse { relationshipId,
bindAs, maxPageSize? }`.

**15. How are to-many relationships bounded?**
A to-many use carries its own `maxPageSize` (default 25) and returns a bounded page, never
an unbounded array.

**16. Which aggregates are supported?**
`count`, `sum`, `min`, `max`, `average`, each with an explicit `as` result field. `count`
takes no key; the rest reduce a numeric/orderable projection key.

**17. What are grouping semantics?**
`groupBy: Expression[]`, present only with `aggregate`. Groups are produced in **first-seen
key order**, matching the `group` expression contract. The SQLite provider orders groups by
`MIN(_seq)` to keep that provider-independent.

**18. Which text-search semantics are portable?**
`contains` (substring / membership), case handling via `lowercase`. Full-text, fuzzy and
vector search are explicitly out of core 0.10 (§26, §116).

**19. What is the `DataProvider` contract?**
`{ capabilities, query, aggregate, loadByIdentity, applyMutations?, explain }`. It receives
a normalized `ProviderQuery` (policy already folded into the filter, principal bound, page
size clamped, cursor decoded) and returns typed rows. `explain` returns an inspectable
`QueryPlan` with no SQL.

**20. Which provider capabilities are explicit?**
`filter`, `sort`, `cursor`, `offset`, `projection`, `relationship`, `aggregate`, `group`,
`transactional-reads`, `local-evaluation` (`DATA_PROVIDER_CAPABILITIES`).

**21. Can unsupported semantics silently fall back to bulk in-memory execution?**
No. A missing capability, or a leaf expression the provider cannot translate, is
`QUERY_CAPABILITY_UNSUPPORTED` — the query is rejected. The SQLite provider throws
`UnsupportedQueryExpression` rather than approximating. Only a provider that explicitly
declares `local-evaluation` (the bounded memory provider) evaluates locally.

**22. What persistent reference provider was implemented?**
`createSqliteDataProvider` on Node's built-in `node:sqlite`: one table per entity, one
column per field, pushed-down filter / multi-key `ORDER BY … NULLS FIRST|LAST` / `LEFT
JOIN` for to-one relationships / `COUNT|SUM|MIN|MAX|AVG` + `GROUP BY` / a lexicographic
keyset `WHERE` predicate / `BEGIN IMMEDIATE` for writes.

**23. Do memory and persistent provider pass identical conformance fixtures?**
Yes. `provider-parity.test.ts` (9 shapes) and `query-conformance.test.ts` (all 16
`axiom.conformance.v4` fixtures) run each through both providers and assert byte-identical
results.

**24. How is canonical record identity represented?**
By the source entity's `identityFieldId`. Query result rows preserve it; UI and actions
address `this Order` by identity, never by page position or array index.

**25. How do Actions address provider-backed records?**
A `provider-record` `Location`: `{ sourceEntityId, identityFieldId, identityValue }`, or the
`providerRecordFieldLocation` helper. It extends `Location`; it is not a parallel mutation
model.

**26. Can Actions perform transactional provider reads?**
Yes. A `query` operation resolves before the transaction opens and binds its result into
scope. For a mutation, the authority `loadByIdentity`s the addressed rows into an
in-transaction staging collection.

**27. What isolation semantics are guaranteed?**
The authority serializes requests, so in-process there is no check-then-write race. The
rewritten action runs through the unchanged mutation engine (constraints, transition rules,
rollback). `provider.applyMutations` commits the touched row set atomically; the SQLite
provider takes `BEGIN IMMEDIATE`. A rollback sends the provider nothing.

**28. Do existing constraints work over provider-backed mutation?**
Yes. The staging collection holds real entity instances, so per-instance entity constraints
and transition constraints run over the proposed rows. `provider-record.test.ts` shows a
`total >= 0` constraint rolling a provider write back entirely.

**29. How is read authorization represented?**
`ReadPolicyDef` — one per entity, a boolean predicate over the row and `PRINCIPAL`. The
effective filter is `And(query.filter ?? true, policy.predicate)` with the policy's row
scope rebound, constructed on the authority.

**30. Can client arguments weaken read policy?**
No. The raw policy never crosses the boundary; the conjunct is added server-side. A hostile
`customerHistory(customerId=B)` invoked by A still evaluates the policy with `PRINCIPAL` = A
and returns nothing (`order-management-gates.test.ts`).

**31. Are aggregates policy-safe?**
Yes. `count` / `sum` run over the post-policy row set. A customer's `orderCount` is scoped;
`order-management-gates.test.ts` §105 asserts admin sees 15,000 and a customer sees fewer.

**32. Are relationships policy-safe?**
Yes. Traversal applies the target entity's own read policy. A visible `Order` never exposes
a forbidden related record.

**33. Is field-level visibility implemented or deferred?**
**Deferred** (spec §52), explicitly. `ReadPolicyDef` is row-level and `docs/QUERIES.md` says
so; it does not claim to solve field-level disclosure.

**34. What query lifecycle states exist in the client?**
`idle`, `loading`, `ready`, `refreshing`, `error` (`QUERY_LIFECYCLE_STATES`), driven by
`createQueryStore`.

**35. Can existing data remain visible while refreshing?**
Yes. `refresh` and `loadMore` enter `refreshing` with the current `page` still visible. A
failed refresh goes to `error` but keeps the last successful data (spec §60); a failed
first load goes to `error` with no data (spec §58).

**36. How does `@cynodia/axiom-ui` consume `QueryDef`?**
Not yet — the toolkit `entity-list` binding to a `QueryDef` requires a runtime
query→render path that is not built. This is the largest remaining limitation (see below).
The client `createQueryStore` API is the seam it will use.

**37. How are active queries invalidated after mutation?**
Conservatively: any committed mutation (durable state write or `provider-record` apply)
clears the whole query cache. AgentAPI's `getActionsInvalidatingQuery` computes the precise
set for tooling.

**38. Is caching implemented?**
Yes — a bounded, correctness-first result cache in `createAxiomServer`, default on
(`queryCache: false` disables).

**39. How is cache principal isolation guaranteed?**
Cache identity includes `principalFingerprint` and `policyFingerprint` (SHA-256). B's
request for the same `queryId`/args has a different key, so B can never receive A's cached
page. Tested in `query-runtime.test.ts` and `order-management-gates.test.ts`.

**40. What AgentAPI query introspection was added?**
`listQueries` / `getQuery`, `getQueryParameters` / `getQueryResultEntity` /
`isAggregateQuery`, `getQueryEntities` / `getQueryFields` / `getQueryRelationships`,
`getReadPolicyForQuery`, `getActionsInvalidatingQuery` / `getQueriesInvalidatedByAction`,
`listRelationships` / `listReadPolicies` / `getRelationshipsForEntity`, and
`MutationImpact.affectedQueries`.

**41. Can AgentAPI explain a query?**
Yes. `explainQuery(id)` returns source, requested filter, the read-policy predicate called
out separately, sort with the identity tie-breaker, relationships with cardinality,
projection fields, pagination, the entities and fields read, and the invalidating actions.

**42. Can AgentAPI identify Action → Query invalidation?**
Yes — `getActionsInvalidatingQuery` and its inverse `getQueriesInvalidatedByAction`.

**43. What new Server IR contract version is used?**
`axiom.server.v6`, computed by `usesQueryVocabulary(ir)` — any `queries`, `relationships`,
`readPolicies`, or `query` operation. A document using none of it still compiles to a
byte-identical v5-or-lower contract; the frozen v1–v5 fixtures and schemas are unchanged.

**44. How many portable query conformance fixtures exist?**
16, in `packages/server/conformance/queries/`, format `axiom.conformance.v4`. Public runner:
`runQueryConformanceFixture` / `runQueryConformanceSuite`.

**45. Did memory / SQL null semantics match?**
Yes. Both implement: `eq`/`neq`/comparison with a `null` operand never matches; `null ==
null` is false; sort `nulls` default `last` for `asc` / `first` for `desc`. Fixtures
`null-ordering`, and the parity harness's null-order case.

**46. Did memory / SQL collation semantics match?**
Yes. Both order `string` by Unicode code point — the memory provider explicitly, SQLite by
`BINARY` collation (UTF-8 byte order = code-point order), never `NOCASE` or a locale.

**47. Did the reference application materialize full tables anywhere?**
No. `order-management-gates.test.ts` §101 pages the Orders query at 15,000 orders and
asserts no large collection appears in authority state.

**48. Did relationship traversal cause N+1?**
No. Both reference providers index the target table once. §102 gate: a page of 50 orders +
`Customer.name` costs ≤ 4 relationship provider calls and fewer than 50 calls total.

**49. Did aggregate queries enumerate rows in application runtime?**
No. §103 gate: `count` / `sum` over 15,000 orders produce only `aggregate` provider calls,
never a row query.

**50. How many handwritten SQL statements exist in application code?**
Zero. `order-management.test.ts` scans the reference app source for `SELECT `, `fetch(`,
route handlers and ORM calls and asserts none.

**51. How many ORM calls exist?** Zero.
**52. How many repository classes exist?** Zero.
**53. How many custom data endpoints exist?** Zero. Queries reach the authority through the
existing single `/axiom` semantic endpoint.
**54. How many canonical-data `fetch()` calls exist?** Zero.
**55. How many `NativeOperation` data accesses exist?** Zero.

**56. What did the blind external agent struggle with?**
The blind-external-agent experiment (spec §110–113) requires a separate empty project
against the *published* packages and shipped docs only. That has not been run — the 0.10
packages are not yet published. It is the second remaining limitation.

**57. Which conventional escape hatches did it attempt?**
Not measured — see 56.

**58. What S3 defects were found?**
None outstanding. During development: the client-runtime `for-each` check would have
accepted a `query` operation (fixed by keeping `query` a top-level-only operation and out of
`MutationOperation`); a staging state marked `ephemeral` was skipped by constraint checks
(fixed — staging state is server-authority but not ephemeral).

**59. What S4 defects were found?**
None. Read authority is robust across rows, aggregates, relationships and cache, verified by
the hostile-client and valid-but-wrong suites.

**60. The five largest remaining limitations.**
1. **No `@cynodia/axiom-ui` / runtime query→render binding.** `createQueryStore` exists;
   `entity-list` / `metric-grid` do not yet consume a `QueryDef`, and the reference app has
   no UI views. This is spec §36, §61–67.
2. **The blind-external-agent experiment (§110–113) has not been run** — it needs published
   0.10 packages.
3. **Field-level read authorization is deferred** (§52).
4. **`for-each` over provider-backed rows is not supported** — a `query` operation cannot
   sit inside `for-each`, and a `provider-record` target inside `for-each` is not executed.
5. **Cache invalidation is whole-cache**, not per-entity — correct but coarse (§72 permits
   it).

---

## §107–109, §122–123 classification

| Axis | Target | Assessment |
| --- | --- | --- |
| Performance | **Q1** | **Q1.** Clause set = capability set; unsupported ⇒ reject, no in-memory fallback path in the SQLite provider. Bounded materialization, N+1 and aggregate gates all pass at 15k rows. The one documented bounded fallback is the memory provider's declared `local-evaluation`. |
| Security | **R1** | **R1.** Read authority is enforced server-side across rows, aggregates and relationship traversals; the cache is principal/policy fingerprinted; the hostile-client and valid-but-wrong suites pass. |
| Portability | **P1** | **P1.** `docs/QUERIES.md` + `docs/AUTHORITY.md` + `server-ir.v6.schema.json` + `protocol.v1.schema.json` + 16 `axiom.conformance.v4` fixtures with a public runner. Memory and SQLite agree on every fixture. |

**§117 — can Axiom represent a large-data application without making the database part of
application semantics?** Yes. The graph describes entities, queries, relationships, policies
and actions; the provider decides SQL, indexes, storage layout and execution plan.

**§118 — can an Action operate transactionally on canonical records never materialized into
`StateDef`?** Yes. `confirmOrder(orderId)` mutates one `Order` row by identity, a constraint
rolls it back, and the collection is never loaded (`provider-record.test.ts`,
`order-management.test.ts`).

**§119 — can the authority prove what a principal may observe without relying on UI
behaviour?** Yes. `ReadPolicyDef.predicate`, AND-ed into every effective filter on the
authority, is the proof; `explainQuery` renders it.

**§120 — could an independent Rust runtime reproduce the same observable query semantics?**
Yes, from the normative docs, the two frozen JSON Schemas and the 16 data-only fixtures —
which is exactly what P1 asserts.

## §122 release classification

**B — READY WITH DOCUMENTED LIMITATIONS.**

The architecture is validated: large authoritative datasets can be queried, secured,
paginated, aggregated and mutated entirely through Axiom semantics, with Q1 + R1 + P1 and
zero S3/S4 defects. It is not classified **A** only because the UI consumption layer
(spec §36, §61–67) and the blind-external-agent experiment (§110–113) are not done — both
are additive and neither touches the semantic model or the frozen contract.

### §123 zero-escape metrics (reference application)

| Metric | Target | Actual |
| --- | --- | --- |
| handwritten SQL | 0 | 0 |
| ORM calls | 0 | 0 |
| repository classes | 0 | 0 |
| application data endpoints | 0 | 0 |
| canonical-data `fetch()` | 0 | 0 |
| manual pagination logic | 0 | 0 |
| duplicated read-policy logic | 0 | 0 (one `ReadPolicyDef`) |
| `NativeOperation` data access | 0 | 0 |
