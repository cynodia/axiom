# Axiom 0.4 — Collection Semantics & Transactional Iteration

**Status:** Proposed technical specification
**Baseline:** `@cynodia/axiom@0.3.1-alpha.1`
**Primary objective:** Extend Axiom's existing semantic model so agents can express aggregation, projection, nested invariants, and atomic multi-record mutations without application-specific JavaScript.

The 0.4 release MUST preserve the architectural model validated by the first two external-consumer experiments. This is an extension of the existing model, **not a redesign**.

---

# 1. Motivation

Two independent external-consumer experiments have established a useful boundary for Axiom 0.3.

Experiment #1 demonstrated that an agent with no prior Axiom knowledge could construct a complete Book Library application using only the published npm package, documentation and TypeScript declarations. CRUD, routing, persistence, locations, constraints, derived state, UI and transactional mutation were expressible entirely through the Application Graph.

Experiment #2 extended the problem into order management and exposed the current semantic boundary:

```text
Axiom 0.3

scalar/entity semantics
        │
        ├── expressions
        ├── locations
        ├── constraints
        ├── mutations
        └── transactions
                │
                │ strong
                ↓

collection semantics
        │
        ├── filter
        ├── find
        ├── count
        └── sum [declared but non-functional]
                │
                │ current boundary
                ↓
        projection
        aggregation
        transactional iteration
        aggregate invariants
```

0.4 SHALL move this boundary without weakening the explicit semantic representation that makes Axiom analyzable by agents.

---

# 2. Non-goals

0.4 is NOT primarily a UI release.

Do not redesign:

* `ApplicationGraph`;
* `Location`;
* `Expression`;
* transaction architecture;
* canonical node representation;
* runtime host abstraction;
* routing architecture;
* persistence architecture.

Do not introduce:

* arbitrary JavaScript expressions;
* callbacks stored in the graph;
* user-provided runtime functions;
* opaque reducers;
* application-specific code execution as part of semantic evaluation.

The graph MUST remain serializable, inspectable and statically analyzable.

---

# 3. Fundamental invariant

Preserve the central 0.3 distinction:

```text
Expression = what value?

Location = where value?
```

0.4 adds:

```text
Collection Expression
    = how are many values transformed?

ForEach Operation
    = which semantic mutation is performed
      for each member?
```

A collection expression MUST remain an `Expression`.

A mutation target MUST remain a `Location`.

`for-each` MUST NOT turn expressions into writable references.

---

# 4. P0 — Semantic contract correctness

Before adding new capabilities, eliminate situations where the public semantic contract accepts constructs that runtime does not meaningfully implement.

## 4.1 No silent semantic failure

A construct that:

1. is publicly declared;
2. typechecks;
3. passes `validateGraph`;

MUST have defined runtime semantics.

This is prohibited:

```text
TypeScript
   ✓

validateGraph
   ✓

runtime
   → null / ignored / silently not evaluated
```

If runtime does not support a construct, validation or compilation MUST reject it.

Introduce an appropriate diagnostic such as:

```text
UNSUPPORTED_EXPRESSION
UNSUPPORTED_OPERATION
UNSUPPORTED_CONSTRAINT_SCOPE
```

Silent semantic degradation is considered a release-blocking defect.

---

# 5. P0 — `sum`

`sum` is already part of the public builtin vocabulary and MUST be implemented correctly.

Canonical semantics:

```text
sum(Collection<number>) → number
```

Examples:

```text
sum([1, 2, 3]) → 6

sum([]) → 0
```

Non-numeric input MUST NOT silently produce `null`.

Invalid types SHOULD be rejected by validation/type inference where statically knowable.

Runtime SHOULD additionally emit a structured diagnostic if malformed runtime data reaches `sum`.

Do NOT overload `sum` with projection semantics.

This:

```text
sum(collection, selector)
```

is not required.

Projection belongs to `map`.

---

# 6. P1 — MapExpression

Add a first-class collection projection expression.

Conceptual representation:

```ts
interface MapExpression {
    kind: 'map';

    collection: Expression;

    itemId: NodeId;

    expression: Expression;
}
```

Exact naming may follow existing Axiom conventions.

`itemId` introduces an iteration scope analogous to `RepeatNode`.

Example semantics:

```text
map(
    order.lines,
    line → line.quantity
)
```

produces:

```text
[2, 3, 1]
```

A more important example:

```text
map(
    order.lines,
    line →
        line.quantity * line.unitPrice
)
```

produces:

```text
[200, 150, 75]
```

and therefore:

```text
sum(
    map(
        order.lines,
        line →
            line.quantity * line.unitPrice
    )
)
```

produces the order total.

## 6.1 Scope

Inside the map expression:

```text
ref(itemId)
```

MUST resolve to the current member.

Nested maps MUST have deterministic lexical scope.

Inner scopes MAY shadow outer scopes only according to explicitly defined resolution rules.

## 6.2 Type inference

Given:

```text
Collection<A>
```

and mapping expression:

```text
A → B
```

the inferred type MUST be:

```text
Collection<B>
```

This information MUST be available to validation.

---

# 7. P1 — Collection composition

The following composition MUST work:

```text
sum(
    map(
        filter(
            collection,
            predicate
        ),
        projection
    )
)
```

This is a core 0.4 acceptance pattern.

For example:

```text
sum(
    map(
        filter(
            order.lines,
            line.productId == product.id
        ),
        line.quantity
    )
)
```

must semantically represent:

> Total requested quantity of this product across the order.

This capability is necessary for aggregate invariants.

---

# 8. P1 — ForEachOperation

Add semantic transactional iteration to actions.

Conceptual shape:

```ts
interface ForEachOperation {
    kind: 'for-each';

    collection: Expression;

    itemId: NodeId;

    operations: MutationOperation[];
}
```

The exact operation union should follow existing architecture.

Example:

```text
for each line in order.lines:

    set
        Product[line.productId].stock

    to
        Product[line.productId].stock
        - line.quantity
```

## 8.1 Atomicity

This is non-negotiable.

A `for-each` does NOT create independent transactions.

The entire containing action remains one transaction:

```text
Action
  │
  ├─ mutation A
  │
  ├─ forEach
  │    ├─ mutation B1
  │    ├─ mutation B2
  │    └─ mutation B3
  │
  └─ mutation C
          │
          ↓
   proposed state
          │
    constraints
      ↙       ↘
   valid      invalid
     ↓           ↓
   COMMIT    ROLLBACK ALL
```

If iteration 17 of 20 violates an invariant, mutations from iterations 1–16 MUST NOT remain committed.

---

# 9. ForEach scope and Locations

Expressions inside a `for-each` MUST be able to reference the current item:

```text
ref(forEachItemId)
```

Locations MUST be able to incorporate expressions from this scope.

For example:

```text
itemFieldLocation(
    PRODUCTS,
    PRODUCT_ID,
    field(
        ref(LINE_SCOPE),
        LINE_PRODUCT_ID
    ),
    PRODUCT_STOCK
)
```

must identify the canonical Product referenced by the current OrderLine.

This preserves Axiom's rule:

```text
iteration value
      ↓
Expression

canonical product stock
      ↓
Location
```

No object aliasing is introduced.

---

# 10. Aggregate invariant acceptance case

0.4 MUST correctly represent the following case.

Canonical state:

```text
Product A
stock = 5
```

Order:

```text
Line 1
Product A
quantity = 3

Line 2
Product A
quantity = 3
```

The relevant semantic expression is conceptually:

```text
requested =
    sum(
        map(
            filter(
                order.lines,
                line.product == product.id
            ),
            line.quantity
        )
    )
```

Constraint:

```text
requested <= product.stock
```

Confirmation MUST fail.

After failure:

```text
Product A stock == 5
Order status == draft
```

No partial mutation may survive.

This SHALL be an explicit regression/acceptance test for 0.4.

---

# 11. P0 — Nested entity constraints

0.3 does not reliably enforce entity constraints when entity values occur inside nested collections.

0.4 MUST define the semantics explicitly.

Recommended invariant:

> Entity constraints apply to every canonical occurrence of that entity type reachable through typed application state.

Example:

```text
Order
 └── lines: Collection<OrderLine>
```

Given:

```text
OrderLine.quantity > 0
```

every `OrderLine` nested in every `Order` MUST satisfy that constraint.

This MUST apply recursively.

For example:

```text
State<Order>
  └── Collection<OrderLine>
       └── ProductSnapshot
```

Constraints associated with each typed entity MUST be evaluated at the appropriate value scope.

---

# 12. Constraint scope

When evaluating an entity-scoped constraint, `ref(entityId)` SHOULD continue to mean:

> the entity instance currently under validation.

This behavior MUST be formally documented and tested.

Nested validation must establish the appropriate scope before evaluating each entity constraint.

---

# 13. P0 — Initial state validation

`initialValue` MUST be validated against its `TypeRef`.

This includes recursive validation of:

* primitives;
* entities;
* collections;
* nested entities;
* required fields;
* field IDs;
* field types.

The 0.3 failure mode where:

```ts
{
    title: "Dune"
}
```

is supplied where:

```ts
{
    [FIELD_TITLE]: "Dune"
}
```

is required MUST no longer silently succeed.

Suggested validation codes:

```text
INITIAL_VALUE_TYPE_MISMATCH
INITIAL_VALUE_UNKNOWN_FIELD
INITIAL_VALUE_MISSING_REQUIRED_FIELD
INITIAL_VALUE_INVALID_ENTITY
```

Diagnostics SHOULD include:

```text
stateId
entityId
fieldId where applicable
value path
expected type
actual value/type
```

Example path:

```text
state_orders[2].field_order_lines[1].field_quantity
```

This is substantially more useful to an agent than a textual error alone.

---

# 14. Runtime constraints use proposed state

Preserve and formally document existing transactional behavior discovered experimentally.

Constraint evaluation during an action MUST operate against the **proposed post-mutation state**, not intermediate committed state.

Conceptually:

```text
current state
     ↓
apply operations provisionally
     ↓
proposed state
     ↓
evaluate constraints
     ↓
commit OR rollback
```

This behavior is now part of the public semantic contract.

---

# 15. Mutation log semantics

Preserve mutation logging for transactions.

Every attempted write SHOULD expose:

```text
location
oldValue
newValue
outcome
transaction/action identity
```

Outcomes SHOULD include at least:

```text
committed
rolled-back
```

A failed multi-item `for-each` MUST make it possible to observe that the transaction was rolled back.

The log MUST NOT misleadingly imply that earlier iterations committed independently.

---

# 16. P1 — Runtime diagnostics contract

Add a public diagnostic vocabulary analogous to `VALIDATION_CODES`.

For example:

```ts
export const RUNTIME_DIAGNOSTIC_CODES = {
    PRECONDITION_FAILED: 'PRECONDITION_FAILED',
    POSTCONDITION_FAILED: 'POSTCONDITION_FAILED',
    CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
    REQUIRED_FIELD_MISSING: 'REQUIRED_FIELD_MISSING',
    EXPRESSION_EVALUATION_FAILED: 'EXPRESSION_EVALUATION_FAILED',
    LOCATION_RESOLUTION_FAILED: 'LOCATION_RESOLUTION_FAILED'
} as const;
```

Exact vocabulary should reflect actual runtime behavior.

Diagnostics SHOULD be structured:

```ts
interface RuntimeDiagnostic {
    code: RuntimeDiagnosticCode;
    message: string;

    actionId?: NodeId;
    constraintId?: NodeId;
    stateId?: NodeId;
    location?: Location;

    transactionId?: string;

    details?: Record<string, unknown>;
}
```

Agents SHOULD NOT have to parse diagnostic prose.

---

# 17. Diagnostic lifetime

0.3 diagnostics accumulate globally.

0.4 SHOULD provide a clear way to obtain diagnostics belonging to one invocation.

Preferred:

```ts
const result = runtime.invokeAction(...);

result.ok;
result.diagnostics;
```

The result diagnostics MUST represent that invocation.

Global diagnostic history MAY remain available separately.

For example:

```ts
runtime.diagnostics()
runtime.clearDiagnostics()
```

but application logic should not need to diff arrays to determine why the current action failed.

---

# 18. P1 — Derived dependency graph must not become stale

Consumers MUST NOT be responsible for manually keeping semantic dependency edges synchronized.

The following state must become impossible:

```text
ApplicationGraph semantics correct
        +
edges stale
        ↓
validateGraph() correct
runtime correct
AgentAPI reasoning incorrect
```

Edges SHOULD become derived/indexed data.

Recommended architecture:

```text
canonical graph nodes
        ↓
semantic dependency derivation
        ↓
cached dependency index
        ↓
AgentAPI queries
```

The index MAY be lazy and invalidated by graph mutations.

`synchronizeEdges()` MAY remain temporarily for compatibility but SHOULD NOT be required for correctness.

---

# 19. P2 — SortExpression

Add ordering to collection expressions.

Conceptually:

```ts
interface SortExpression {
    kind: 'sort';

    collection: Expression;
    itemId: NodeId;
    by: Expression;
    direction?: 'asc' | 'desc';
}
```

It MUST be deterministic.

Initial support SHOULD target:

```text
string
number
```

Do not overcomplicate locale-aware sorting in 0.4.

Example:

```text
sort(
    books,
    book.title,
    asc
)
```

---

# 20. P2 — Complete expression builders

Every public expression kind SHOULD have a corresponding authoring helper.

At minimum:

```text
literal
ref
field
object
binary
unary
call
filter
find
map
sort
```

An external consumer should not need to manually construct discriminated-union objects for some expression kinds while using helpers for others.

---

# 21. P2 — Typed handles

Explore a typed handle API without replacing canonical IDs.

Conceptually:

```ts
const books = defineState<Book[]>({...});
```

where `books` carries:

```text
NodeId
TypeRef
TypeScript T
```

This could enable:

```ts
runtime.getState(books)
```

to return:

```ts
Book[]
```

rather than:

```ts
unknown
```

Likewise:

```ts
runtime.invokeAction(addBook, {
    title: "...",
    author: "..."
});
```

could typecheck against declared parameters.

This feature MUST remain compatible with serialization.

The canonical graph continues to contain IDs and TypeRefs, not TypeScript runtime objects.

---

# 22. P2 — Authoring API

0.4 SHOULD begin reducing graph-construction verbosity.

However, DO NOT compromise canonical graph explicitness to accomplish this.

Introduce a higher-level authoring layer that deterministically expands into an `ApplicationGraph`.

Architecture:

```text
Agent / author
      ↓
Authoring API
      ↓
deterministic expansion
      ↓
ApplicationGraph
      ↓
validation/compiler/runtime
```

The canonical graph remains the source of semantic truth.

Potential authoring capabilities include:

```text
inline children
generated stable IDs
addText
addButton
addInput
repeat
conditional
bindField
displayField
```

Do not require consumers to construct an `AgentAPI.Transaction` merely to access convenient graph-building helpers.

---

# 23. Stable generated IDs

If the authoring API automatically generates IDs, generation MUST be deterministic where possible.

Equivalent authoring input SHOULD ideally produce equivalent semantic IDs.

This matters for:

* agent transformations;
* graph diffs;
* persistence;
* diagnostics;
* mutation impact;
* version control;
* reproducible builds.

Random IDs SHOULD not become the default solution to authoring convenience.

---

# 24. Formatting

Add minimal semantic value formatting.

Do NOT introduce arbitrary formatter callbacks.

Prefer structured hints or expressions.

Initial targets:

```text
boolean
number
currency
date/date-time
```

Example conceptual representation:

```ts
{
    kind: 'field-display',
    value: ...,
    format: {
        kind: 'currency',
        currency: 'NOK'
    }
}
```

Formatting remains presentation semantics, not application business logic.

---

# 25. Agent API awareness

The Agent API MUST understand new 0.4 constructs.

For `map`, `sort`, aggregate expressions and `for-each`, dependency analysis MUST identify underlying reads and writes.

Given:

```text
forEach order.lines:
    write Product.stock
```

an agent query such as:

```text
Which actions can modify Product.stock?
```

MUST identify the confirmation action.

Likewise:

```text
What depends on OrderLine.quantity?
```

must discover:

```text
line total
order total
stock requirements
confirmation constraints
affected views
```

as applicable.

New semantic primitives are incomplete until they are visible to agent reasoning.

---

# 26. Serialization

All new constructs MUST remain completely serializable.

Specifically prohibited inside canonical graph data:

```text
JavaScript functions
closures
class instances requiring prototype semantics
opaque callbacks
runtime code references
```

`MapExpression` and `ForEachOperation` therefore use explicit scope IDs and nested semantic expressions/operations.

---

# 27. Compiler requirements

`compileToIR` MUST normalize and preserve the semantics of:

```text
map
sort
for-each
nested constraints
```

Compiler output MUST NOT rely on application-specific generated JavaScript to implement them.

They are generic Axiom runtime capabilities.

`compileToHtml` must continue producing a self-contained generic runtime artifact.

---

# 28. Validation requirements

`validateGraph` MUST understand all new constructs.

For `map`:

* collection must be a collection;
* item scope must resolve correctly;
* projection expression must validate.

For `for-each`:

* source must be a collection;
* item scope must be available to nested operations;
* nested locations must validate;
* nested expressions must validate;
* operation types must remain compatible.

For `sum`:

* argument must infer to a numeric collection where statically knowable.

For nested constraints:

* constraint scopes must correspond to reachable typed entity values.

---

# 29. New validation tests

At minimum add tests for:

```text
map over non-collection
invalid map scope reference
sum over string collection
for-each over primitive
for-each over non-collection
invalid location inside for-each
type mismatch inside for-each set
nested entity constraint violation
invalid nested initial value
unknown field key in initial entity value
```

Every failure MUST produce a structured validation code.

---

# 30. Order-system acceptance application

The Experiment #2 order system becomes an explicit 0.4 acceptance fixture.

It MUST be possible to represent, without native/custom application code:

```text
Customer
Product
Order
OrderLine
```

with:

```text
quantity > 0
stock >= 0

lineTotal =
    quantity * unitPrice

orderTotal =
    sum(
        map(
            lines,
            quantity * unitPrice
        )
    )
```

and atomic confirmation.

---

# 31. Successful confirmation acceptance test

Given:

```text
Product A
price = 100
stock = 10

Order
status = draft

Line
Product A
quantity = 2
unitPrice = 100
```

Confirmation MUST result in:

```text
Product A stock = 8
Order status = confirmed
Order total = 200
```

Mutation log MUST identify the relevant committed writes.

---

# 32. Insufficient-stock rollback test

Given:

```text
Product A stock = 10
requested = 2

Product B stock = 3
requested = 5
```

confirmation MUST produce:

```text
failure
```

and:

```text
Product A stock = 10
Product B stock = 3
Order status = draft
```

State MUST be equivalent to state immediately before invocation.

No earlier `for-each` iteration may survive.

---

# 33. Aggregate-stock acceptance test

Given:

```text
Product A stock = 5

OrderLine #1
Product A
quantity = 3

OrderLine #2
Product A
quantity = 3
```

confirmation MUST fail because:

```text
sum(
    quantities for Product A
) = 6
```

and:

```text
6 > 5
```

After failure:

```text
Product A stock = 5
Order status = draft
```

This test MUST NOT be implemented through custom/native logic.

---

# 34. Historical pricing acceptance test

Given:

```text
Product.unitPrice = 100
```

when an OrderLine is created, its captured:

```text
OrderLine.unitPrice
```

may be stored as:

```text
100
```

After confirmation, changing:

```text
Product.unitPrice = 150
```

MUST NOT change the confirmed order total.

This verifies that Axiom can represent snapshots separately from live relationships.

No special new primitive is required unless implementation proves otherwise.

---

# 35. Confirmed-order immutability

The acceptance fixture MUST enforce semantically that confirmed orders cannot:

```text
change customer
add line
remove line
change quantity
confirm again
```

UI hiding is insufficient.

Attempts MUST fail through preconditions/constraints and leave state unchanged.

This worked in 0.3 and MUST remain a regression test.

---

# 36. Transactional semantics are now public contract

The following is promoted from observed behavior to required behavior:

> An Axiom action executes as a semantic transaction. Its mutations are applied provisionally, relevant constraints are evaluated against the resulting proposed state, and either the complete action commits or its state mutations are rolled back.

This guarantee MUST be documented prominently.

It is particularly important for AI-generated applications because correctness does not depend on the agent manually implementing rollback logic.

---

# 37. External-consumer test #3

After implementing 0.4, repeat the order-system experiment with a **fresh agent context**.

The agent MUST receive only:

```text
@cynodia/axiom@0.4.x
README
published .d.ts
```

It MUST NOT receive:

* the Axiom repository;
* the 0.3 order-system implementation;
* Experiment #2's report;
* internal implementation guidance.

The same original requirements should be given.

Success means the independent agent discovers and uses:

```text
map
sum
for-each
aggregate constraints
transactional rollback
```

without custom business logic.

---

# 38. Compatibility

0.4 SHOULD remain source-compatible with valid 0.3 graphs wherever semantics were already defined.

Breaking changes are acceptable only where 0.3 behavior was:

* undefined;
* silently incorrect;
* inconsistent with public types;
* unsafe.

In particular, fixing `sum` is NOT considered a breaking semantic change because returning `null` for a valid numeric aggregation was not meaningful supported behavior.

---

# 39. Release quality gates

0.4 MUST NOT be published until:

```text
npm build                  PASS
unit tests                 PASS
validation tests           PASS
runtime tests              PASS
compiler tests             PASS
agent API tests            PASS
npm pack verification      PASS
external consumer smoke    PASS
order acceptance fixture   PASS
```

Additionally:

```text
TypeScript errors                   0
validation warnings in fixtures    0
as any required by public examples 0
native operations in order fixture 0
```

---

# 40. Definition of Done

Axiom 0.4 is complete when all of the following are true:

* `sum(Collection<number>)` works.
* `sum([])` returns `0`.
* Invalid `sum` usage cannot silently evaluate to meaningless `null`.
* `MapExpression` exists and is statically analyzable.
* `map` composes with `filter` and `sum`.
* `ForEachOperation` exists.
* `for-each` participates in the containing action transaction.
* Failure during any iteration rolls back the complete action.
* Aggregate stock requirements can be expressed.
* The two-lines-for-one-product stock case is rejected.
* Nested entity constraints are either correctly enforced everywhere or rejected explicitly where unsupported.
* Initial state is recursively checked against its semantic type.
* Field-name-keyed entity seed data cannot silently pass as valid field-ID-keyed data.
* Runtime diagnostic codes are publicly defined.
* Per-action failure diagnostics are obtainable without diffing global history.
* Agent API dependency analysis understands `map` and `for-each`.
* Derived edge/index information cannot silently become stale.
* `sort` exists.
* Expression builder coverage is consistent.
* Existing Book Library semantics continue to work.
* The Order System acceptance fixture works without native/custom business logic.
* A fresh external agent can reproduce the order system using only the published package contract.

---

# 41. Explicit architectural principle for future releases

0.4 should establish this as a project-level rule:

> **When Axiom gains expressive power, add it as inspectable semantic structure rather than executable escape hatches.**

Therefore:

```text
GOOD

MapExpression
ForEachOperation
SortExpression
Location
Constraint
structured formatter
```

rather than:

```text
BAD

callback: (value) => ...
validator: function (...)
formatter: arbitraryJS
mutation: async () => ...
```

The former expands what an agent can reason about.

The latter merely turns Axiom back into another programming environment.

---

# 42. Recommended implementation order

## Phase 1 — Contract correctness

Implement:

```text
sum
initialValue validation
nested constraints
silent-failure regression tests
```

Do not proceed until all publicly accepted constructs either execute correctly or fail explicitly.

## Phase 2 — Collection expressions

Implement:

```text
MapExpression
map type inference
map validation
map runtime evaluation
filter → map → sum composition
aggregate-stock expression
```

## Phase 3 — Transactional iteration

Implement:

```text
ForEachOperation
iteration scope resolution
Location resolution inside iteration
nested operations
atomic rollback
mutation-log semantics
```

## Phase 4 — Agent semantics

Implement:

```text
dependency derivation for map
dependency derivation for for-each
field/state read/write impact
automatic or lazy semantic dependency index
AgentAPI query regression tests
```

## Phase 5 — Public contract

Implement:

```text
RUNTIME_DIAGNOSTIC_CODES
per-invocation diagnostics
transaction semantics documentation
constraint timing documentation
failure mode/precondition documentation
```

## Phase 6 — API completeness

Implement:

```text
SortExpression
complete expression builders
typed handles where feasible
```

## Phase 7 — Ergonomics

Implement:

```text
authoring/composition API
inline children
deterministic generated IDs
semantic formatting
DOM/test API cleanup
```

Do not allow ergonomics work to alter canonical graph semantics.

## Phase 8 — Acceptance

Run:

```text
Book Library regression
Order System acceptance fixture
aggregate-stock case
insufficient-stock rollback case
historical pricing case
confirmed-order immutability case
clean npm consumer test
fresh-agent external-consumer experiment
```

---

# 43. Central 0.4 acceptance statement

Axiom 0.4 SHALL demonstrate:

> An AI agent can represent non-trivial business logic over collections and relationships — including projection, aggregation, aggregate invariants and atomic multi-record state changes — entirely as inspectable Axiom semantics.

The canonical proof case is order confirmation:

```text
Order
  ↓
lines
  ↓
aggregate requested stock
  ↓
validate against inventory
  ↓
for each line
    reduce canonical Product.stock
  ↓
set Order.status = confirmed
  ↓
evaluate proposed state
  ↓
commit all or rollback all
```

No application-specific JavaScript, native operation or opaque callback may be required to implement this flow.

At that point Axiom has moved beyond semantic CRUD into a framework capable of representing meaningful transactional business logic while retaining full agent inspectability.
