# Axiom 0.10 — Semantic Query Layer Research

Companion to `specs/spec10.md` and the forthcoming `AXIOM_0_10_IMPLEMENTATION_REPORT.md`.
This document is the record spec §4 requires: three competing query architectures built far
enough to judge, evaluated against the nine criteria spec §4 names, and a decision with its
reasons. It is written before the public API is frozen and does not change once the
implementation report supersedes it.

---

## 1. The problem, stated in Axiom's own terms

Every prior release added a semantic node whose *leaves* are ordinary `Expression` trees:
`ActionDef.guards[].condition`, `ConstraintDef.expression`, `ForEachOperation.collection`,
`StateDef.derivation`, `TriggerDef.enabledWhen`, `StorageDef.readAuthorization`. Structure
at the top, expressions at the bottom. Nothing in Axiom has ever introduced a second
expression language, and CLAUDE.md's "Expressive power arrives as structure" rule forbids
it.

0.10 must let a graph say *"the 50 most recent confirmed orders for this customer, with the
customer name, one page at a time"* against a table of 500,000 rows, and have a provider
execute that without Axiom ever materializing the 500,000. The question §4 poses is: **what
shape does that semantic description take?**

Constraints that pre-decide large parts of the answer:

| Source | Constraint |
| --- | --- |
| spec §3 | No `SELECT` / `JOIN` / table alias / SQL fragment / ORM entity / repository method in application-facing vocabulary. |
| spec §6 | Client invokes `queryId + typed arguments`, never an AST. So whatever the shape, it is **registered in the graph**, not submitted from the browser. |
| spec §8 | Filter operators "should align with existing Expression semantics where possible. Avoid creating two subtly different comparison languages." |
| spec §17 | "Do not duplicate arithmetic/expression semantics inside the query system." |
| spec §9 | A required predicate that cannot be pushed down must **fail**, not fall back to JS filtering (unless a bounded source opts in). |
| spec §93 | IR carries no closure, function, `Promise`, JS `Date`, SQL, ORM object, provider instance. |
| spec §41 | `expressionRef()` must not become hidden I/O. Expression evaluation stays pure and synchronous. |
| CLAUDE.md | `core` / `runtime` / `compiler` / `agent-api` contain no domain vocabulary. A query primitive is domain-neutral or it does not ship. |

So a `QueryDef` is a graph node with `id`, typed `parameters`, an authoritative `source`, a
typed result, dependency info (§5), and it survives compilation into the portable Server IR
under a newly-computed contract version (§92).

---

## 2. The three prototypes

Each was built as a throwaway branch: the `core` type, a hand-written `recentOrders`
equivalent over a 4-entity order schema (`Customer`, `Product`, `Order`, `OrderLine`), a
memory executor, and a translation to a fake relational plan sufficient to judge pushdown.
No runtime wiring, no UI, no persistence. ~250–400 LOC each.

### Prototype A — declarative query clauses

`QueryDef` is a record of named clauses, each clause its own small closed vocabulary:

```ts
interface QueryDef {
  kind: 'query';
  id: NodeId;
  parameters: QueryParameter[];          // TypeRef-typed
  source: NodeId;                        // entity id
  where?: QueryPredicate;                // { op: 'eq' | 'and' | 'contains' | …, … }
  orderBy?: QuerySortKey[];              // { field: FieldId, direction, nulls }
  project?: QueryProjection;             // { fields: FieldId[], computed: {…}, relations: {…} }
  groupBy?: FieldId[];
  aggregate?: QueryAggregate[];          // { fn: 'count'|'sum'|…, field?: FieldId, as: FieldId }
  page?: { strategy: 'cursor' | 'offset'; maxSize: number };
}
```

`QueryPredicate` is a *new* discriminated union: `{ op: 'eq', field, value }`,
`{ op: 'and', operands: [] }`, `{ op: 'contains', field, value }`, etc. `value` is either a
literal or `{ param: <id> }`.

**Verdict: rejected.** `QueryPredicate` is precisely the "second subtly different
comparison language" spec §8 warns against. It has `eq`/`neq`/`lt`/… that mean *almost* what
`BinaryExpression` means but are re-specified for null handling, collation and coercion in a
separate place — two truth tables that must be kept identical by hand forever. Computed
projections (`lineTotal = quantity * unitPrice`, spec §17) either re-invent arithmetic in
`QueryProjection.computed` or awkwardly embed an `Expression` anyway, at which point the
predicate half's separateness is just inconsistency. Dependency analysis needs a second
walker (`walkQueryPredicate`) parallel to `walkExpression`, and `derive-edges.ts` /
`authority.ts` would resolve reads through two mechanisms that must agree. It scored well
only on *IR size* (compact) and *provider translation* (clause-to-plan is a near-literal
map).

### Prototype B — semantics carried by existing Axiom Expressions

`QueryDef` holds `Expression` trees directly. The body of a query looks like a `filter` /
`sort` / `map` pipeline over the source entity's collection, evaluated in a special scope
where the source is bound and pagination is a runtime concern layered on top:

```ts
interface QueryDef {
  kind: 'query';
  id: NodeId;
  parameters: QueryParameter[];
  source: NodeId;
  predicate?: Expression;   // boolean, scope = one source row bound to `source` id
  order?: SortExpression[];  // reuse the `sort` operator's key expressions
  projection?: Expression;   // an `object` expression, scope = one source row
  maxPageSize: number;
}
```

`recentOrders` becomes: `predicate = binary('eq', field(ref(SOURCE), F_STATUS), ref(P_STATUS))`,
`order = [{ key: field(ref(SOURCE), F_CREATED_AT), direction: 'desc' }]`,
`projection = object({ id: field(ref(SOURCE), F_ID), customerName: … })`.

**Verdict: adopt the leaves, reject the whole.** Reusing `Expression` for predicate,
projection and sort keys is unarguably right — one comparison language, one arithmetic, one
dependency walker, `expressionRef` reuse for free (spec §17), and type inference already
knows how to reject `sum` over a non-numeric projection. But *"the query is just an
expression pipeline"* fails four criteria hard:

- **Provider translation.** A free `filter(sort(map(…)))` tree can express things no
  relational provider can push down (`map` producing a nested collection, `flatten`,
  `find` inside a predicate). The provider would have to pattern-match a blessed subset and
  reject everything else — an implicit, undocumented grammar, which is spec §84's
  "valid-but-inexecutable" trap.
- **Pagination & stable ordering.** Cursor pagination (§12), the identity tie-breaker
  (§11) and the authority read-predicate injection (§47) have nowhere natural to live in a
  bare expression. They'd be bolted on beside it.
- **Explainability (§86).** "Explain this query" means re-deriving structure from an
  expression tree every time.
- **Aggregation without materialization (§25).** `sum(map(filter(coll)))` *is* the Axiom
  way to aggregate a materialized collection — and that is exactly the shape that tempts a
  provider (or a naive runtime) into `SELECT * ` then reduce in JS.

### Prototype C — compositional query operator nodes

Each stage is its own graph node — `QuerySource`, `QueryFilter`, `QuerySort`,
`QueryProject`, `QueryPaginate`, `QueryAggregate` — chained by id, the way UI nodes chain by
`children`:

```
QuerySource(Order) ─▶ QueryFilter(pred) ─▶ QuerySort(keys) ─▶ QueryProject(shape) ─▶ QueryPaginate(cursor,50)
```

**Verdict: rejected.** This is the most "graph-native" shape and it scored best on
*AgentAPI discoverability* (every stage is independently addressable and queryable) and
*plan inspection* (§31 — the stage list *is* the plan skeleton). But it is a large surface:
six new node kinds, six new edge-derivation cases, six validation clusters, six schema
fragments, and every one of them must round-trip through the Server IR. It multiplies IR
size by the stage count. Worse, an arbitrary DAG of stages re-opens the same
"which compositions can a provider actually execute" problem as B — a `QueryFilter` fed by a
`QueryAggregate` fed by another `QueryFilter` is a valid node chain and a provider
nightmare. Authoring compression is poor: five nodes and four edges to say what a customer
means by "recent orders". It is the right model for a *query optimizer project*, which spec
§115 explicitly says 0.10 is not.

---

## 3. Decision — **A-shaped container, B-shaped leaves**

`QueryDef` is a **single node with a fixed, closed set of named clauses** (Prototype A's
container), and **every leaf value in every clause is an ordinary Axiom `Expression`**
(Prototype B's leaves). No `QueryPredicate` union. No operator nodes.

```ts
interface QueryDef extends NodeBase {
  kind: 'query';
  parameters?: QueryParameter[];        // TypeRef-typed; validated before provider execution (§7)
  source: NodeId;                       // an EntityDef id — the authoritative row type
  rowScopeId: NodeId;                   // binds one source row for the expressions below
  filter?: Expression;                  // boolean. `ref(rowScopeId)`, `ref(<param id>)`, `PRINCIPAL` in scope
  sort?: QuerySortKey[];                // [{ key: Expression, direction, nulls }]; identity appended (§11)
  projection?: QueryProjection;         // typed result shape; values are Expressions (§17)
  relationships?: QueryRelationshipUse[];// declared RelationshipDef ids + bound alias, to-one and bounded to-many
  aggregate?: QueryAggregate[];         // { function, key?: Expression, as: FieldId }
  groupBy?: Expression[];               // group keys; first-seen order per the `group` expression (§24)
  pagination: QueryPagination;          // { strategy: 'cursor' | 'offset', maxPageSize, defaultPageSize }
  readPolicyId?: NodeId;                // the ReadPolicyDef whose predicate is AND-ed in (§46-47)
}
```

Why this wins each criterion:

| Criterion (§4) | Why A-container + B-leaves |
| --- | --- |
| **Portability** | Clauses are a fixed enum of shapes → one JSON schema fragment, no open grammar. Leaves are `Expression`, already frozen and schema'd since `axiom.server.v1`. An independent Rust runtime reads a struct with known fields. |
| **Type safety** | `parameters` use `TypeRef`. `infer.ts` already types `Expression`; it extends to *"`filter` must be boolean"*, *"`aggregate.function: 'sum'` needs a numeric `key`"*, *"`projection` field types must match declared result"* — all reusing existing inference. |
| **AgentAPI discoverability** | A `QueryDef` is one node with named parts. "Which entities does it read / which relationships / does it aggregate / which policy" are field reads plus one `walkExpression` per clause — the same walk `getMutationImpact` already does. |
| **Provider translation** | The clause set *is* the capability set (§29): `filter` → capability `filter`, `sort` → `sort`, `relationships` → `relationship`, `aggregate` → `aggregate`, `pagination.strategy` → `cursor`/`offset`. A provider declares which it supports; a query needing an unsupported one is rejected pre-execution (§81, §84), never approximated. The leaf `Expression` still needs a translatable-subset check, but it is checked **per clause with a known role** (a `filter` leaf must be a boolean predicate over row fields, params and `PRINCIPAL` — not an arbitrary pipeline), which makes the subset documentable rather than implicit. |
| **Read-policy injection** | `readPolicyId` names a `ReadPolicyDef`; the effective filter the provider receives is `And(filter ?? true, readPolicy.predicate)` — constructed in the compiler/authority, never in the client IR (§47). One obvious place, one `binary('and', …)`. |
| **Dependency analysis** | Every leaf is `Expression`, so `walkExpression` + existing iteration-scope read attribution covers it. `derive-edges.ts` gains a `QueryDef` case that walks its clauses; `authority.ts` resolves through it identically. No parallel walker. |
| **IR size** | One node, ~7 optional clauses, leaves shared with the existing expression pool. Comparable to an `ActionDef`. Far below Prototype C. |
| **Authoring compression** | `recentOrders` is one `graph.addNode<QueryDef>({…})` call with 4–5 populated clauses. A customer's "recent orders" is a node, not a file. |
| **Explainability** | `explainQuery(id)` reads the clauses back in order and renders spec §86's block directly — source, effective filter (with the policy conjunct shown), sort with the identity tie-breaker, projection, pagination, and per-clause "provider supports / pushed down". No structure re-derivation. |

The one place this shape is weaker than Prototype C is that the *plan* (§30) is not itself a
node chain. It doesn't need to be: `QueryPlan` is a provider-produced inspection object
(§31) with `pushedFilters`, `pushedSort`, `pagination`, `projection`, `relationships`,
`aggregates`, `unsupported[]` — data, not graph. Tests assert against it without touching
SQL.

---

## 4. Supporting decisions taken in the same research

### 4.1 Relationships — explicit `RelationshipDef`, never inferred (spec §18–19, §40)

```ts
interface RelationshipDef extends NodeBase {
  kind: 'relationship';
  from: { entityId: NodeId; fieldId: FieldId };  // Order.customerId
  to: { entityId: NodeId; identityFieldId: FieldId }; // Customer.id
  cardinality: 'to-one' | 'to-many';
}
```

Inference from "two fields share a primitive type" is forbidden by §19 and would be a
security hazard under §51. To-one traversal (`Order → Customer`) is a batched key lookup —
the reference provider MUST resolve a page of 50 orders + `customer.name` in **2** provider
calls, not 51 (§22, §102); the memory provider does the same by construction so the
conformance fixtures catch a regression. To-many traversal (`Customer → Orders`) is only
legal inside a query when bounded — it carries its own `maxPageSize` and returns a
`QueryPage`, never an unbounded array (§21).

### 4.2 Read authorization — `ReadPolicyDef`, row-level for 0.10 (spec §45–53)

```ts
interface ReadPolicyDef extends NodeBase {
  kind: 'read-policy';
  entityId: NodeId;
  rowScopeId: NodeId;                 // one candidate row
  predicate: Expression;             // boolean over row fields + PRINCIPAL; true ⇒ row visible
}
```

- **Row-level only.** Field-level visibility (spec §52) is **deferred**, explicitly, and the
  implementation report will say so rather than claim row-level covers it.
- The policy predicate is AND-ed into the effective filter *before* the provider executes
  (§47), so it constrains rows, aggregates (§50) and relationship traversal (§51) uniformly —
  an aggregate is computed over the same post-policy row set, so "principal may see 3 of 10"
  gives `count = 3`.
- Principal is server-computed from the authenticated `ExecutionContext`, never from
  `QueryRequest` arguments (§56). A hostile `orderHistory(customerId=B)` still evaluates the
  policy with `PRINCIPAL` = A and discloses nothing (§48).
- Duplicated read-policy logic in application code is a zero-target metric (§106, §123): the
  policy exists once, as a node.

### 4.3 Temporal — reuse existing `date` / `datetime` primitives (spec §77)

`PrimitiveKind` already has `date` and `datetime`. Spec §77 says *"If Axiom already has
sufficient temporal semantics, reuse them"* and *"Do not use JavaScript Date in IR"* — the
IR already carries these as ISO-8601 strings, never `Date`. `createdAt >= from` is a
`binary('gte', field(ref(row), F_CREATED_AT), ref(P_FROM))` with both sides `datetime`.
Ordering by timestamp is a `sort` key of `datetime` type. **No new temporal type is
introduced.** Providers compare `datetime` as Unicode code-point ordering of the normalized
ISO string (which is also chronological for well-formed UTC ISO-8601), matching Axiom's
existing normative text collation (spec §79) so memory and SQLite agree.

### 4.4 Null semantics (spec §78) — frozen here

| Situation | Behaviour | Rationale |
| --- | --- | --- |
| `eq` / `neq` with a `null` operand | Not equal; `null == null` is **false** (yields `null`/absent, treated as non-match) | Matches Axiom's existing presence model — `null` is absence, and absence is not a value that equals another. Three-valued logic in the filter, two-valued at the boundary (a row matches or it doesn't). |
| `lt` / `lte` / `gt` / `gte` with `null` | Row does not match | Same reason; a comparison against absence has no truth. |
| Sort, `nulls` unspecified | `nulls: 'last'` for `asc`, `'first'` for `desc` (nulls sort as +∞) | One rule, provider-independent; SQLite's `NULLS FIRST/LAST` is emitted explicitly, never left to default. |
| `is-empty` / `non-empty` / `required` | Unchanged from core semantics | One language (§8). |

The memory provider and the SQLite provider both implement exactly this; conformance
fixtures `null-ordering` and `null-equality` pin it.

### 4.5 Cursor model (spec §12–13)

Keyset cursor, not offset. A cursor is an **opaque** base64url token wrapping
`{ queryId, sortValues[], identityValue, principalFingerprint, policyFingerprint, contractVersion }`,
signed/HMAC'd with a host key. Continuing a page decodes it, verifies the fingerprints
against the *current* request's principal and policy, and rejects with
`QUERY_CURSOR_INVALID` on any mismatch — a cursor from principal A or from a different
`QueryDef` cannot resume A's position for B (§13, §70, §104). Offset pagination is a
provider capability offered for convenience (§14), documented as non-consistent under
concurrent mutation, never the normative model.

### 4.6 Actions over provider-backed records (spec §37–44, §118)

- New operation `query` inside an action (spec §40): `{ kind: 'query', queryId, arguments, bindAs }`,
  resolved before the transaction opens, binding a `QueryPage` or single row into scope —
  the same shape as `integration-query`'s `bindAs`, but reading Axiom's *own* authoritative
  data, so it is **not** an `IntegrationDef` (spec §102, §5).
- A new `Location` selector variant — `provider-record` — addresses a canonical
  provider-backed row by `{ sourceEntityId, identityValue }`, so `confirmOrder(orderId)`
  mutates one row without loading the collection into a `StateDef` (§38). This extends
  `Location`, it does not fork the mutation model.
- The authoritative runtime already runs the client's semantic engine (CLAUDE.md, "The
  authoritative runtime reuses the client's semantic engine"). A provider-backed mutation
  loads the addressed rows into the transaction's provisional state, applies `set`/`remove`,
  re-checks entity + transition constraints over the proposed rows, and the provider commits
  the row set atomically or not at all (§42, §44). Isolation: the reference provider takes
  the addressed rows `FOR UPDATE` (SQLite: `BEGIN IMMEDIATE`), giving read→validate→write
  with no lost update (§42). `stock >= 0` still blocks the commit transactionally (§43).

### 4.7 Server IR contract version (spec §92)

Baseline is `axiom.server.v5` (0.9). The query vocabulary — `QueryDef`, `RelationshipDef`,
`ReadPolicyDef`, the `query` operation, the `provider-record` location — is a new,
independent reason a document is not a v5 document, computed from the document by a new
`usesQueryVocabulary(ir)` predicate exactly as `usesExternalIOVocabulary` computes v5. New
contract: **`axiom.server.v6`**. Every pre-0.10 graph still compiles to a byte-identical v5
(or earlier) document; the frozen v1–v5 conformance fixtures are untouched. One new schema,
`server-ir.v6.schema.json`; a new portable conformance format tier `axiom.conformance.v4`
adds scripted data providers.

---

## 5. Performance / security / portability targets (spec §107–109, §123)

| Axis | Target | How this design reaches it |
| --- | --- | --- |
| Performance | **Q1** — bounded, pushed down | Clause set = capability set; unsupported ⇒ reject (§9, §81). No `filter(...)` fallback path exists in the provider unless a bounded source sets `allowsLocalEvaluation: true`. Scale fixture (§100) runs against ≥500k generated rows in SQLite with an assertion that the runtime never holds more than one page. |
| Security | **R1** — robust across rows, aggregates, relationships, cache | Policy predicate AND-ed pre-execution; aggregates and traversals run over the post-policy row set; cache identity includes `principalFingerprint` + `policyFingerprint` (§69) and the cross-principal cache fixture (§70) is a release gate. |
| Portability | **P1** — implementable from docs + schema + fixtures | Fixed clause struct + frozen `Expression` schema + `server-ir.v6.schema.json` + ≥18 data-only conformance fixtures run through the public `runConformanceFixture` runner, memory and SQLite producing identical results (§89–91). |

---

## 6. What was explicitly deferred (spec §116)

Advanced full-text / fuzzy / vector search; **field-level read authorization**; live query
push (the identity model is designed to *admit* it later — cursor + query + principal
fingerprint is exactly what a server push needs to name an active query); automatic
indexes; cross-provider joins; distributed transactions; sophisticated (non-conservative)
cache invalidation; query optimizer hints. The core architecture leaves room for each; none
is on the 0.10 path.

---

## 7. Decision summary

> **`QueryDef` is a single graph node with a fixed set of named clauses. Every leaf is an
> ordinary Axiom `Expression`. Relationships and read policies are their own explicit nodes.
> Temporal reuses `date`/`datetime`. Cursors are opaque, fingerprinted keyset tokens.
> Actions reach provider-backed rows through an extended `Location`, not a parallel mutation
> model. The contract is `axiom.server.v6`, computed from the document.**

This is the shape the rest of the 0.10 implementation builds on.
