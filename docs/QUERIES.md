# Semantic data access & the query layer

Axiom 0.14.0-alpha.4. The operational contract for demand-driven reads over authoritative
data that is too large to materialize as a `StateDef` — 500,000 orders, 5,000,000 order
lines, years of audit rows. `axiom.server.v6`.

> **The graph owns meaning. The provider owns execution.** The graph names the source, the
> filter, the sort, the projection, the relationships, the aggregation, the pagination and
> the read policy. A `DataProvider` decides SQL, indexes, storage layout and execution plan.
> Neither borrows from the other.

`StateDef` is unchanged and is still the right tool for anything that can reasonably be held
as a whole. The rule: *"Can this semantic value reasonably be materialized?"* Yes →
`StateDef`. No → `QueryDef`.

---

## `QueryDef`

One graph node with a fixed set of named clauses. **Every leaf value in every clause is an
ordinary Axiom `Expression`** — there is no second predicate or arithmetic language.

```ts
interface QueryDef extends NodeBase {
  kind: 'query';
  parameters?: QueryParameter[];   // TypeRef-typed; validated before the provider is touched
  source: NodeId;                  // an EntityDef id — the authoritative row type
  rowScopeId: NodeId;              // binds one source row for every expression below
  filter?: Expression;            // boolean. In scope: ref(rowScopeId), ref(<param id>), PRINCIPAL, relationship binds
  sort?: QuerySortKey[];          // [{ key: Expression, direction?: 'asc'|'desc', nulls?: 'first'|'last' }]
  relationships?: QueryRelationshipUse[];   // [{ relationshipId, bindAs, maxPageSize? }]
  projection?: QueryProjection;   // { entityId, fields: [{ id: FieldId, value: Expression }] }
  groupBy?: Expression[];         // group keys; present only with `aggregate`
  aggregate?: QueryAggregate[];   // [{ function: 'count'|'sum'|'min'|'max'|'average', key?: Expression, as: FieldId }]
  pagination?: QueryPagination;   // { strategy: 'cursor'|'offset', maxPageSize?, defaultPageSize? }
  readPolicyId?: NodeId;          // the ReadPolicyDef whose predicate is AND-ed into `filter`
}
```

Rules:

- **The clause set is the capability set.** A query with a `filter` needs the provider
  capability `filter`, one with `relationships` needs `relationship`, and so on. A provider
  that lacks a required capability, or that cannot translate a leaf expression, **rejects
  the query** with `QUERY_CAPABILITY_UNSUPPORTED`. It never loads the table and filters in
  memory.
- **The client invokes a query by id, never a query AST** (`{ kind: 'query', queryId,
  arguments }`). Security, complexity, dependency and performance characteristics stay
  inspectable before deployment.
- **A `QueryDef` survives compilation into `axiom.server.v6`.** It is stripped from the
  client IR — a client receives a typed page, never a clause.
- **`validateGraph` rejects a query that could not execute** rather than letting it validate
  and fail at the provider. See [`VALIDATION.md`](VALIDATION.md#semantic-data-access--query-layer-010).

### Filtering

Operators reuse `Expression` semantics: `binary('eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
| 'and' | 'or', …)`, `unary('not', …)`, and the `contains` built-in for substring/membership.
There is one comparison language, not two.

**Expression scope.** Every `QueryDef` clause (and a `ReadPolicyDef` predicate) is evaluated
by the `DataProvider`. In scope: `ref(rowScopeId)`, `ref(<parameter id>)`, `ref(<relationship
bindAs>)`, `PRINCIPAL`, and nested iteration scopes. **Not** a `StateDef` — the provider
binds no authority state, so `ref(<state id>)` in a query clause is rejected
(`QUERY_STATE_REF_NOT_ALLOWED`). Pass a runtime-varying value as a query parameter.

### Null semantics (frozen)

| Situation | Behaviour |
| --- | --- |
| `eq` / `neq` with a `null` operand | never matches; `null == null` is **false** |
| `lt` / `lte` / `gt` / `gte` with a `null` operand | never matches |
| `and` / `or` with `null` | `null` is treated as `false` |
| sort, `nulls` unspecified | `'last'` for `asc`, `'first'` for `desc` (nulls sort as +∞) |

The memory provider and the SQLite provider implement exactly this; the
`null-ordering` / `null-equality` conformance fixtures pin it.

### Collation and numerics

`string` compares by **Unicode code point** — never UTF-16 code unit, never a locale
collation. `datetime` compares as the code-point ordering of the normalized ISO-8601
string, which is also chronological for well-formed UTC values. Numbers are IEEE-754
binary64. No new temporal type: `date` / `datetime` primitives, ISO-8601 strings in the IR,
never a JavaScript `Date`.

### Sorting and stable ordering

Sort keys are ordered most-significant first. **Canonical identity is appended as a final,
ascending tie-breaker**, so pagination is a total order (spec §11). A cursor query whose
`source` entity has no `identityFieldId` is rejected with `UNSTABLE_PAGINATION`.

### Projection

`projection.entityId` names the entity a result row conforms to — usually a dedicated
summary entity. Projected values are `Expression`s, so `lineTotal = quantity * unitPrice` is
`binary('multiply', …)`, never a re-implemented arithmetic. A projection MUST NOT expose a
field the source entity's read policy forbids.

### Aggregation and grouping

`count` needs no `key`; every other function reduces the numeric projection `key`. An empty
result set sums to `0`, and `min`/`max`/`average` over it are `null`. Groups are produced in
**first-seen key order**, matching the `group` expression's contract — this ordering is
semantic, and a provider MUST NOT let it become database-dependent (the SQLite provider
orders groups by `MIN(_seq)`).

Aggregation happens **at the provider**. Counting 500,000 orders returns a number, never
500,000 rows.

---

## `RelationshipDef`

An explicit link between two entities, in one named traversal direction. Axiom **never
infers** a relationship from two fields sharing a primitive type.

```ts
interface RelationshipDef extends NodeBase {
  kind: 'relationship';
  from: { entityId: NodeId; fieldId: FieldId };
  to:   { entityId: NodeId; fieldId: FieldId };
  cardinality: 'to-one' | 'to-many';
}
```

- For `to-one`, `to.fieldId` MUST be the target entity's `identityFieldId`.
- For `to-many`, `from.fieldId` MUST be the source entity's `identityFieldId`.
- `Order → Customer` and `Customer → Order` are two definitions; the underlying join is the
  same, and which side is `from`/`to` is decided by traversal direction.

Traversal never implies unbounded materialization: a to-many use carries its own
`maxPageSize`, and a to-one join over a page of N source rows costs a **bounded** number of
provider calls — never N+1. The reference providers batch (index the target table once);
the `to-one-relationship` and N+1-gate tests are release gates.

---

## `ReadPolicyDef`

The read-side counterpart of `ActionDef.authorization`. Row-level for 0.10; **field-level
visibility is deferred** (spec §52) and this does not claim to solve it.

```ts
interface ReadPolicyDef extends NodeBase {
  kind: 'read-policy';
  entityId: NodeId;      // at most one policy per entity
  rowScopeId: NodeId;    // binds one candidate row
  predicate: Expression; // boolean over the row + PRINCIPAL; true ⇒ visible
}
```

Guarantees:

- **The client cannot remove it.** The effective filter a provider receives is
  `And(query.filter ?? true, policy.predicate)`, constructed on the authority with the
  policy's row scope rebound to the query's row scope. The raw policy never crosses the
  boundary.
- **Aggregates are policy-safe.** `count` / `sum` / … run over the post-policy row set — a
  principal permitted to see 3 of 10 rows gets `count = 3`.
- **Relationships are policy-safe.** Traversing to a related entity applies *that* entity's
  read policy too.
- **The principal is server-computed** from the authenticated `ExecutionContext`, never from
  a query argument. A hostile `orderHistory(customerId=B)` still evaluates the policy with
  `PRINCIPAL` = A and discloses nothing.

---

## Cursor pagination

Cursor (keyset) pagination is the canonical, consistency-preserving model.
`QueryPage<T> = { items, nextCursor: string | null, hasMore }`.

A cursor is **opaque application data**: a base64url token a client stores and hands back,
never parses. Inside it is the previous page's last-row position plus an HMAC-SHA-256
fingerprint of the query, the arguments, the principal, the read policy and the contract
version. Continuing a page verifies the fingerprint against the *current* request; any
mismatch is `QUERY_CURSOR_INVALID` and nothing is disclosed. A cursor from principal A
cannot resume A's position for B, and a cursor minted for one query cannot be replayed
against another.

Offset/limit is an optional provider convenience (`strategy: 'offset'`). Its behaviour under
concurrent mutation is not the normative consistency model.

`QueryDef.pagination.maxPageSize` and the provider's `maxPageSize` together set an
authority-enforced ceiling. A request above it is **refused** (`QUERY_PAGE_SIZE_EXCEEDED`),
never silently truncated.

---

## The `query` operation, and provider-backed mutation

Inside an action, before the transaction opens:

```ts
{ kind: 'query', queryId: NodeId, arguments?: Record<string, Expression>, bindAs: NodeId }
```

The result binds into scope for the operations that follow — the rows for a row query, the
aggregate rows for an aggregate query. A `query` operation reads Axiom's *own* authoritative
data (not an external system, so it is **not** an `integration-query`) and makes its action
**server-authority**. Never legal inside `for-each`.

To mutate a canonical provider-backed record without materializing the collection, address
it by identity with a `provider-record` location:

```ts
{ kind: 'set', target: providerRecordFieldLocation(ENTITY_ORDER, F_ORDER_ID, ref(P_ID), F_STATUS),
  value: literal('confirmed') }
```

The authority loads the addressed rows into the action's transaction, the **unchanged**
mutation engine applies the `set` / `remove` and re-checks every entity and transition
constraint over the proposed rows, and the provider commits the touched row set atomically
or not at all. A rollback sends the provider nothing. `stock >= 0` still blocks the commit
transactionally.

Isolation: the reference SQLite provider takes the addressed rows `BEGIN IMMEDIATE`, giving
read → validate → write with no lost update.

---

## The `DataProvider` contract

```ts
interface DataProvider {
  readonly capabilities: {
    supports: DataProviderCapability[];  // filter, sort, cursor, offset, projection, relationship,
                                         // aggregate, group, transactional-reads, local-evaluation
    maxPageSize: number;
  };
  query(query: ProviderQuery): Promise<ProviderResult<ProviderPage>>;
  aggregate(query: ProviderQuery): Promise<ProviderResult<AggregateResult>>;
  loadByIdentity(entityId, identityFieldId, values): Promise<ProviderResult<Row[]>>;
  applyMutations?(mutations: ProviderMutation[]): Promise<ProviderResult<null>>;
  explain(query: ProviderQuery): QueryPlan;   // pure; pushedFilter/pushedSort/… + unsupported[]
}
```

- Application code MUST NOT invoke a provider directly. The authoritative runtime does,
  after it has bound the principal, folded the read policy into the filter, clamped the page
  size and decoded the cursor.
- A missing capability MUST NOT produce a plausible-but-wrong result. Reject, don't
  approximate.
- `explain(query).unsupported` being non-empty means the query is rejected — the physical
  plan is inspectable without exposing SQL.

Reference providers: `createMemoryDataProvider({ rows })` (deterministic, in-memory,
declares `local-evaluation`) and `createSqliteDataProvider({ location, entities, seed })`
(one table per entity, one column per field, parametrized SQL, no handwritten application
SQL). They MUST produce **semantically identical** results; `provider-parity.test.ts` and
the `axiom.conformance.v4` fixtures check that.

---

## Client lifecycle

```ts
createQueryStore(fetcher)  // fetcher = the remote gateway's query(), or any transport
```

One `QueryView` per `{ queryId, arguments }` key:

```
idle ──load──▶ loading ──ok──▶ ready ──refresh/loadMore──▶ refreshing ──ok──▶ ready
                  │                                             │
                  │ fail                                        │ fail (data kept)
                  ▼                                             ▼
                error (no data) ◀──────────────────────────── error
```

- A **first load** that fails → `error` with no data. `loading` is distinguishable from
  `ready` with zero rows.
- A **refresh** that fails → `error`, but the last successful `page` stays visible. The UI
  never flashes empty.
- `refresh` and `loadMore` run in the `refreshing` state with the current data still shown.

`QUERY_LIFECYCLE_STATES` is the frozen list. An application reads one `QueryView`, not four
booleans per list.

---

## The query result cache

Conservative and correctness-first. Cache identity is every semantic factor that could
change the result: the query, an argument fingerprint, the page context, the contract, and
fingerprints of the **principal** and the **read-policy predicate**. Principal A's cached
page can never be served to principal B.

Any committed mutation clears the whole cache. Over-invalidation is acceptable; a
known-stale result is not. Configure with `AxiomServerOptions.queryCache =
true | { maxEntries } | false`; `server.clearQueryCache()` / `server.queryCacheStats()`.

---

## AgentAPI

`listQueries()` · `getQuery(id)` · `explainQuery(id)` (source, effective filter with the
read-policy conjunct called out, sort with the identity tie-breaker, projection, pagination,
entities and fields read, invalidating actions) · `getQueryParameters` · `getQueryEntities`
· `getQueryFields` · `getQueryRelationships` · `isAggregateQuery` · `getReadPolicyForQuery`
· `getActionsInvalidatingQuery` / `getQueriesInvalidatedByAction` · `listRelationships` ·
`listReadPolicies` · `getRelationshipsForEntity`. `getMutationImpact(location)` gains
`affectedQueries`.

---

## Portability

An independent runtime/provider implementer reproduces query behaviour from: this document,
`AUTHORITY.md`, `server-ir.v6.schema.json`, `protocol.v1.schema.json`, and the
`axiom.conformance.v4` fixtures in `conformance/queries/` — run through the public
`runQueryConformanceFixture` / `runQueryConformanceSuite`. No TypeScript source required.
