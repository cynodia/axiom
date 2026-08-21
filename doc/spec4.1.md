# Axiom 0.4.1 — Semantic Hardening Specification

**Status:** Proposed patch/minor architecture hardening release
**Baseline:** `@cynodia/axiom@0.4.0-alpha.1`
**Primary objective:** Remove semantic ambiguities and unsafe mutation paths discovered by External-Consumer Experiment #3 without expanding Axiom into a materially larger framework.

0.4.1 is explicitly a **semantic correctness and safety release**, not a feature-expansion release.

The external Order System experiment reached:

```text
A — FULLY EXPRESSIBLE
```

but exposed several cases where a valid graph can still rely on conventions, ambiguous runtime semantics, or incomplete dependency attribution.

0.4.1 SHALL harden those areas.

---

# 1. Scope

0.4.1 SHALL focus on five areas:

1. Transition/write invariants that protect canonical state regardless of mutation path.
2. Clear presence semantics for collections.
3. Unambiguous null semantics for collection expressions.
4. Correct field-level dependency attribution through iteration scopes.
5. Formal documentation and tests for provisional-state semantics in `for-each`.

Do NOT use 0.4.1 to add broad new UX, styling, persistence, networking or framework features.

---

# 2. Core problem: action preconditions do not protect Locations

Experiment #3 demonstrated the following:

```text
Confirmed Order
      │
      │ action: setLineQuantity(...)
      ▼
orderIsDraft precondition
      │
      ✕ rejected
```

but:

```text
Confirmed Order
      │
      │ input binding
      ▼
Location(OrderLine.quantity)
      │
constraints only
      │
      ✓ committed
```

A canonical-state input binding can therefore bypass an action-level business rule.

This is unacceptable for an AI-native semantic framework.

Correctness MUST NOT depend on the author remembering:

> “Do not bind this input directly to that Location.”

The graph itself should be able to express the write rule.

---

# 3. New concept: TransitionConstraint

Introduce a first-class semantic construct for rules governing state transitions.

Conceptual shape:

```ts
export interface TransitionConstraintDef {
    id: NodeId;

    kind: 'transition-constraint';

    name?: string;

    target:
        | NodeId
        | LocationPattern;

    expression: TransitionExpression;

    severity?: 'error' | 'warning';

    message?: string;
}
```

Exact naming may differ, but the concept MUST be first-class and serializable.

A transition constraint evaluates against:

```text
previous state
proposed state
```

rather than proposed state alone.

---

# 4. Transition expression context

Introduce semantic references to:

```text
previous(...)
proposed(...)
```

or an equivalent structured scope.

For an entity transition, the framework SHOULD expose:

```text
previous entity instance
proposed entity instance
```

Example conceptual rule:

```text
if previous.status == 'confirmed'
then proposed == previous
```

This means:

> Once an Order is confirmed, it may not change.

The rule applies regardless of whether the write originated from:

```text
Action
Input binding
Agent mutation
Runtime-mediated write
Future mutation path
```

---

# 5. Location-scoped write policies

If full entity transition constraints prove too broad for 0.4.1, support a narrower write-policy form.

Conceptually:

```ts
interface WritePolicyDef {
    id: NodeId;
    kind: 'write-policy';

    target: LocationPattern;

    when: TransitionExpression;
}
```

Example:

```text
Target:
    Order.lines

Rule:
    writable only when previous Order.status == 'draft'
```

The implementation MAY choose either:

```text
TransitionConstraint
```

or:

```text
WritePolicy
```

but the final architecture MUST support mutation-path-independent enforcement.

---

# 6. Mutation pipeline integration

Every governed mutation path MUST pass through transition checks.

Canonical flow:

```text
mutation request
      ↓
resolve Location
      ↓
current state
      ↓
apply provisionally
      ↓
proposed state
      ↓
entity constraints
      ↓
transition constraints
      ↓
postconditions
      ↓
commit / rollback
```

This applies to:

* action operations;
* input bindings;
* `for-each`;
* agent/runtime semantic writes.

Host-level administrative APIs MAY remain outside this contract if explicitly documented.

---

# 7. Input bindings

Input bindings MUST no longer be a semantic loophole.

If an input writes to a canonical Location protected by a transition rule, the input mutation MUST:

1. run transactionally;
2. evaluate relevant entity constraints;
3. evaluate relevant transition constraints;
4. rollback if the write is disallowed;
5. emit structured diagnostics.

Expected behavior for the Order System case:

```text
Order.status == confirmed
input attempts quantity = 7
      ↓
transition constraint
      ↓
rejected
      ↓
value unchanged
```

---

# 8. Draft-state behavior

Preserve the existing draft distinction.

Draft state MAY temporarily violate ordinary value constraints where explicitly allowed by current semantics.

Transition constraints protecting canonical entities SHOULD generally not apply to unrelated draft state unless the draft itself is targeted.

The distinction remains:

```text
draft state
    may temporarily be incomplete

canonical state
    must satisfy invariants and transition policies
```

---

# 9. Previous-state semantics

Transition rules require precise semantics for “previous”.

For one transaction:

```text
previous
```

means:

> committed state as it existed immediately before the transaction began.

It MUST NOT mean:

* previous operation in the same transaction;
* previous iteration of `for-each`;
* most recently provisionally mutated value.

The transaction also has:

```text
proposed
```

meaning:

> complete current provisional state including all operations executed so far in the transaction.

This distinction MUST be documented.

---

# 10. Multi-operation transition rules

Transition constraints MUST evaluate against the full proposed state after the relevant mutation phase.

Example:

```text
Action:
    set Order.status = confirmed
    mutate other fields
```

A transition rule can reason about:

```text
previous.status
proposed.status
```

and other fields in the proposed entity.

Do not evaluate transition rules only against isolated operation-level values.

---

# 11. P0 — Presence semantics

Experiment #3 established:

```text
required([])
    == false

required('')
    == false

required(0)
    == true

required(false)
    == true
```

This conflates:

```text
presence
```

with:

```text
non-empty collection/string
```

and causes surprising behavior.

0.4.1 SHALL separate these concepts.

---

# 12. New canonical presence definition

Recommended semantics:

```text
present(null)        = false
present(undefined)   = false

present([])          = true
present('')          = true
present(0)           = true
present(false)       = true
```

Presence answers only:

> Does a value exist?

It does not answer:

> Is this value non-empty?

---

# 13. `required`

`required(value)` SHOULD adopt true presence semantics.

Therefore:

```text
required([])    → true
required('')    → true
required(0)     → true
required(false) → true
required(null)  → false
```

If backward compatibility prevents changing `required`, introduce a new explicit builtin:

```text
present(...)
```

and deprecate ambiguous behavior.

However, the preferred direction is to correct the semantic contract before stable release.

---

# 14. Explicit emptiness checks

Use separate collection/string predicates:

```text
is-empty(value)
non-empty(value)
```

Expected examples:

```text
is-empty([])   → true
is-empty([1])  → false
is-empty('')   → true
is-empty('x')  → false
```

Do not encode emptiness via `required`.

---

# 15. `coalesce`

`coalesce` SHOULD be nullish/presence-based rather than “non-empty”-based.

Expected:

```text
coalesce(null, []) → []
coalesce([], [1])  → []
coalesce('', 'x')  → ''
coalesce(0, 1)     → 0
coalesce(false, true) → false
```

This fixes the Experiment #3 case where:

```text
coalesce(lines, literal([]))
```

could never return the empty collection fallback.

---

# 16. Backward compatibility note

Changing presence semantics may alter behavior in existing alpha applications.

This is acceptable before stable release if:

* documented clearly;
* covered by migration notes;
* versioned as an intentional semantic correction.

Do NOT preserve surprising semantics merely for alpha compatibility.

---

# 17. P0 — Null semantics for collection expressions

Experiment #3 found inconsistent behavior:

```text
filter(null) → []
count(null)  → 0
map(null)    → [] + diagnostic
sum(null)    → null + diagnostic
```

This is too ambiguous.

A collection expression MUST have one consistent null policy.

---

# 18. Recommended null policy: strict

Preferred 0.4.1 semantics:

```text
filter(null) → evaluation failure
map(null)    → evaluation failure
sort(null)   → evaluation failure
find(null)   → evaluation failure
count(null)  → evaluation failure
sum(null)    → evaluation failure
```

Empty collection remains valid:

```text
filter([]) → []
map([])    → []
count([])  → 0
sum([])    → 0
```

This creates a clean distinction:

```text
null
    = missing/invalid collection value

[]
    = valid empty collection
```

This is substantially easier for agents to reason about.

---

# 19. Alternative null-safe policy

A null-safe collection policy MAY be chosen instead:

```text
null treated as []
```

but if so, it MUST apply consistently across all collection operations and MUST NOT emit an error diagnostic while returning a normal-looking value.

This is prohibited:

```text
map(null) → [] + ERROR
```

Choose either:

```text
failure
```

or:

```text
normal null-safe evaluation
```

never both.

---

# 20. Static validation of nullable sources

Where type information makes it possible, `validateGraph` SHOULD warn or reject collection operators applied to potentially nullable values.

For example:

```text
map(
    field(
        find(...),
        lines
    ),
    ...
)
```

may evaluate against:

```text
null.lines
```

if `find` returns no item.

If the static model can identify this possibility, report something like:

```text
POSSIBLY_NULL_COLLECTION_SOURCE
```

This is optional if current inference cannot support it reliably.

Runtime semantics MUST still be deterministic regardless.

---

# 21. P0 — Field dependency attribution

Experiment #3 found two agent-safety bugs.

## Under-reporting reads

A field referenced through an iteration scope may not appear in:

```text
getFieldReaders(fieldId)
```

Example:

```text
OrderLine.quantity
```

is read by:

* order total projection;
* aggregate inventory preconditions;

but `getFieldReaders(quantity)` returned empty.

## Over-reporting writes

Fields read while computing a written value may be attributed as written.

Example:

```text
addLineToOrder
```

reads:

```text
Product.unitPrice
```

but may be reported as a writer of it.

This is incorrect semantic metadata.

---

# 22. Separate read and write attribution

Dependency derivation MUST treat:

```text
write target
```

and:

```text
value expression
```

separately.

Given:

```text
set target = valueExpression
```

derive:

```text
writes:
    fields represented by target Location

reads:
    fields referenced by valueExpression
    fields referenced by target selectors
```

Do not fold value-expression fields into write metadata.

---

# 23. Scope-aware field reads

Field reads inside:

```text
map
filter
find
sort
for-each
repeat
```

MUST resolve through iteration scope metadata.

If:

```text
field(ref(scopeId), FIELD_QUANTITY)
```

appears inside a projection, dependency analysis MUST attribute:

```text
FIELD_QUANTITY
```

as a read.

The fact that `expressionFieldIds()` already finds these fields should be reused rather than reimplemented inconsistently.

---

# 24. Agent API correctness requirement

The following queries MUST become trustworthy:

```text
getFieldReaders(fieldId)
getFieldWriters(fieldId)
getMutationImpact(location)
```

Axiom's AI-native premise depends on these answers being semantically correct.

It is preferable to:

```text
return incomplete/unknown metadata explicitly
```

than silently return false certainty.

If analysis is incomplete, return a structured indicator such as:

```text
analysisComplete: false
```

rather than silently omitting dependencies.

---

# 25. Regression case: OrderLine.quantity

The 0.4.1 test suite MUST assert that:

```text
getFieldReaders(F_LINE_QUANTITY)
```

includes all relevant semantic consumers:

* line total derivation;
* order total derivation;
* quantity validation;
* aggregate stock checks;
* any other expressions that structurally read the field.

---

# 26. Regression case: Product.unitPrice

The test suite MUST assert that:

```text
addLineToOrder
```

is:

```text
reader of Product.unitPrice
```

but NOT:

```text
writer of Product.unitPrice
```

unless a real target Location writes that field.

---

# 27. P1 — `for-each` provisional-state contract

Experiment #3 established an important runtime fact:

```text
for-each iteration N
```

observes provisional writes made by:

```text
iterations 1..N-1
```

Example:

```text
stock = 5

line 1: -3
line 2: -1

observed:
5 → 2 → 1
```

This behavior is correct and valuable.

0.4.1 SHALL make it an explicit public guarantee.

---

# 28. Formal `for-each` semantics

Within one action transaction:

```text
initial committed state
        ↓
provisional transaction state
        ↓
iteration 1
        ↓
updated provisional state
        ↓
iteration 2
        ↓
updated provisional state
        ↓
...
```

Each iteration reads the latest provisional state.

No iteration receives an isolated snapshot of the action-entry state.

---

# 29. Why this matters

This behavior enables:

```text
stock >= 0
```

to protect repeated-product debits without a separately materialized aggregate stock mutation plan.

For example:

```text
stock = 5

line A = 3
line A = 3
```

for-each produces:

```text
5 → 2 → -1
```

then:

```text
stock >= 0
```

fails against proposed state and the complete transaction rolls back.

This guarantee MUST be documented and regression-tested.

---

# 30. P1 — Host-level `setState`

Experiment #3 found:

```text
runtime.setState(...)
```

can bypass semantic constraints.

This MUST be explicitly classified.

Choose one of two models.

## Model A — administrative API

Document:

> `setState` is a host/testing/administrative facility and does not participate in application semantic enforcement.

Rename if necessary:

```text
unsafeSetState
setStateUnchecked
hydrateState
```

to prevent misuse.

## Model B — governed API

Route it through:

```text
mutation engine
constraints
transition constraints
transaction
```

For 0.4.1, Model A is acceptable and simpler.

But the API MUST NOT appear equivalent to a normal semantic write if it is not.

---

# 31. P1 — Transition rule diagnostics

A rejected transition should return a structured runtime diagnostic.

Recommended:

```text
TRANSITION_CONSTRAINT_VIOLATION
```

with details such as:

```ts
{
    transitionConstraintId,
    entityId?,
    location?,
    previousValue?,
    proposedValue?,
    source
}
```

Avoid requiring agents to infer that a generic `CONSTRAINT_VIOLATION` came from a transition rule.

---

# 32. Mutation provenance

Diagnostics SHOULD distinguish mutation source:

```text
action
input
agent
host
system
native
```

For example:

```ts
details: {
    source: 'input',
    nodeId: UI_QUANTITY_INPUT
}
```

This makes mutation-path bugs much easier to diagnose.

---

# 33. P1 — Transition dependency analysis

Transition constraints MUST participate in semantic analysis.

Agent API should be able to answer:

```text
What rules protect this Location?

What transition constraints read Order.status?

What writes could violate confirmed-order immutability?
```

This is especially valuable because transition constraints exist precisely to protect write paths globally.

---

# 34. P2 — Universal quantifier

Experiment #3 had to express:

```text
every line satisfies p
```

as:

```text
is-empty(
    filter(
        lines,
        NOT p
    )
)
```

This is semantically valid but indirect.

Add:

```text
every(collection, scopeId, predicate)
```

and optionally:

```text
some(collection, scopeId, predicate)
```

Conceptual semantics:

```text
every([]) → true
some([])  → false
```

This is P2, not required for semantic safety.

---

# 35. P2 — Conditional expression

Add a structured conditional expression.

Conceptual:

```ts
interface ConditionalExpression {
    kind: 'conditional';

    condition: Expression;

    whenTrue: Expression;

    whenFalse: Expression;
}
```

This solves cases where `coalesce` is being abused as general conditional logic.

Type inference SHOULD require compatible result types where statically knowable.

---

# 36. P2 — FlattenExpression

Add:

```text
flatten(Collection<Collection<T>>) → Collection<T>
```

This addresses the current inability to project:

```text
Collection<Order>
    ↓
map(order → order.lines)
    ↓
Collection<Collection<OrderLine>>
```

into:

```text
Collection<OrderLine>
```

Do not implement arbitrary recursive flattening in 0.4.1.

One level is sufficient.

---

# 37. P2 — ScopeId type

Iteration binders currently use ordinary `NodeId`, although they are not graph nodes.

Introduce a branded type:

```ts
export type ScopeId =
    string & { readonly __brand: 'ScopeId' };
```

and:

```ts
createScopeId()
scopeId(...)
```

Use in:

```text
map
filter
find
sort
for-each
repeat
```

where appropriate.

This helps prevent accidental node/scope confusion.

---

# 38. Scope shadowing validation

`validateGraph` SHOULD detect reused scope IDs in nested lexical scopes where shadowing would be ambiguous or unintended.

Suggested code:

```text
DUPLICATE_SCOPE_ID
```

or:

```text
SCOPE_SHADOWING
```

The validation policy MAY permit deliberate shadowing later, but alpha authoring should favor explicit uniqueness.

---

# 39. Preconditions and failureModes

Experiment #3 confirmed a positional relationship:

```text
preconditions[i]
↔
failureModes[i]
```

This is fragile.

0.4.1 SHOULD replace parallel arrays with an explicit paired structure.

Recommended:

```ts
interface ActionGuard {
    condition: Expression;

    failureMode?: FailureMode;
}
```

then:

```ts
ActionDef {
    guards?: ActionGuard[];
}
```

Backward compatibility MAY retain:

```text
preconditions
failureModes
```

temporarily.

New APIs and documentation SHOULD prefer paired guards.

---

# 40. No semantic expansion through JavaScript callbacks

All new 0.4.1 features MUST remain serializable semantic data.

Prohibited:

```text
transition: (previous, proposed) => ...
every: (item) => ...
conditional: () => ...
```

Use explicit expressions and scope IDs.

---

# 41. Validation updates

`validateGraph` MUST understand:

* transition constraints;
* previous/proposed scopes;
* Location patterns if introduced;
* ScopeId usage;
* conditional expressions;
* every/some if added;
* flatten if added.

Validation SHOULD reject:

```text
transition rule with invalid target
invalid previous/proposed field ref
non-boolean transition expression
scope reference outside scope
scope shadowing where prohibited
flatten(non-collection-of-collection)
conditional branch type mismatch
```

---

# 42. Runtime updates

Runtime MUST ensure:

* input mutations use transition checks;
* action mutations use transition checks;
* for-each mutations use transition checks;
* nested operations see the same transaction-entry `previous` state;
* `proposed` reflects current provisional state;
* transition failure rolls back the full transaction;
* diagnostic identifies transition failure source.

---

# 43. Order-system regression fixture

The existing Order System MUST remain a 0.4.1 acceptance fixture.

Add one new canonical test:

```text
Confirmed order
quantity = 2
```

Create an input directly bound to:

```text
Order.lines[...].quantity
```

Attempt:

```text
quantity = 7
```

Expected in 0.4.1:

```text
rejected
quantity remains 2
TRANSITION_CONSTRAINT_VIOLATION
```

This test MUST pass without relying on UI hiding or omission of the input.

---

# 44. Action-path regression

The existing action:

```text
setLineQuantity
```

on a confirmed order MUST continue to fail.

Transition protection and action guard MAY both reject it.

The framework SHOULD avoid duplicate noisy diagnostics where possible.

---

# 45. Draft-order edit regression

For:

```text
Order.status = draft
```

the same Location MUST remain writable through:

```text
action
input
```

provided ordinary constraints pass.

This verifies that the transition rule is not merely “make Location read-only”.

---

# 46. Presence regression tests

Required:

```text
required(null)  → false
required([])    → true
required('')    → true
required(0)     → true
required(false) → true

is-empty([])    → true
is-empty('')    → true

coalesce(null, []) → []
coalesce([], [1])  → []
```

If compatibility semantics differ, document the exact replacement contract and test it.

---

# 47. Collection null regression tests

For strict mode:

```text
map(null)    → failure
filter(null) → failure
sort(null)   → failure
count(null)  → failure
sum(null)    → failure
```

and:

```text
map([])   → []
count([]) → 0
sum([])   → 0
```

No expression may return a normal-looking value while simultaneously emitting a failure diagnostic.

---

# 48. Dependency regression tests

Required:

```text
getFieldReaders(OrderLine.quantity)
```

MUST include consumers under:

```text
map
filter
aggregate precondition
```

and:

```text
getFieldWriters(Product.unitPrice)
```

MUST NOT include an action that merely reads Product.unitPrice while writing OrderLine.unitPrice.

---

# 49. `for-each` regression tests

Required:

```text
stock = 5
lines = [3,1]
```

observed provisional sequence:

```text
5 → 2 → 1
```

and:

```text
stock = 5
lines = [3,3]
```

observed sequence:

```text
5 → 2 → -1
```

followed by:

```text
constraint failure
rollback all
stock = 5
```

---

# 50. Documentation requirements

0.4.1 README MUST explicitly document:

1. Action transaction semantics.
2. `for-each` provisional-state semantics.
3. Difference between entity constraints and transition constraints.
4. Which mutation paths are governed.
5. Presence semantics.
6. Collection null semantics.
7. Whether `setState` is administrative/unsafe.
8. Scope/binder semantics.
9. Diagnostics produced by transition rejection.

These are load-bearing semantics and MUST NOT require probe programs to discover.

---

# 51. External-consumer experiment #4

After 0.4.1 is published, rerun a focused consumer test.

The agent should receive a small order editor requirement containing a deliberate direct input binding into confirmed order state.

Do NOT tell it about transition constraints.

Success means it discovers that the framework itself protects the write path.

The key proof:

```text
confirmed order
      ↓
direct UI input
      ↓
attempted canonical write
      ↓
framework rejects
```

without the agent needing the convention:

```text
never bind an input here
```

---

# 52. Definition of Done

Axiom 0.4.1 is complete when:

* Business rules can protect state transitions independently of mutation path.
* Direct input binding can no longer bypass confirmed-order immutability.
* Transition rules can inspect previous and proposed state.
* Transition failures rollback transactionally.
* Transition failures emit structured diagnostics.
* Presence semantics distinguish missing from empty.
* `coalesce` can legitimately fall back to an empty collection.
* Collection null behavior is deterministic and consistent.
* No collection expression returns a plausible value alongside a failure diagnostic.
* Field-level readers include iteration-scope reads.
* Field-level writers exclude fields that are only read by value expressions.
* Agent API dependency results are trustworthy for the Order System.
* `for-each` provisional-state behavior is formally documented and tested.
* `setState` is clearly classified as governed or administrative.
* Scope IDs are distinguishable from node IDs, or scope misuse is otherwise validated.
* Existing 0.4 Order System remains fully expressible.
* No new feature requires opaque JavaScript callbacks or native escape hatches.

---

# 53. Release classification

0.4.1 is successful if the project moves from:

```text
Axiom 0.4

business semantics expressible
        ✓

but some correctness depends on
authoring conventions
```

to:

```text
Axiom 0.4.1

business semantics expressible
        ✓

critical write rules enforced
independently of mutation path
        ✓

semantic analysis trustworthy
        ✓

collection/value semantics
unambiguous
        ✓
```

The primary objective is not more expressive power.

It is:

> **If the graph says a business rule is true, Axiom itself should prevent every governed semantic write path from violating it.**
