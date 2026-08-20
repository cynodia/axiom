# Axiom 0.3 — Semantic Mutation and Addressing

**Status:** Proposed technical specification
**Target release:** Axiom 0.3
**Prerequisite:** Axiom 0.2
**Primary objective:** Introduce an explicit semantic model for writable state locations and unify all application mutations under a single validated mutation architecture.

---

# 1. Purpose

Axiom 0.2 established a semantic Application Graph capable of describing multiple unrelated applications and executing them through a domain-independent runtime.

Axiom 0.3 SHALL address the next architectural weakness:

> Axiom currently models values semantically, but writable locations only implicitly.

An `Expression` answers:

> What value does this evaluate to?

It does NOT necessarily answer:

> Where in application state does this value live?

These concepts MUST be separated.

Axiom 0.3 SHALL introduce **Location** as a first-class semantic concept.

---

# 2. Core distinction

Axiom SHALL distinguish between:

```text id="25ybpk"
Expression<T>
```

and:

```text id="bpr3mb"
Location<T>
```

An Expression represents a computation producing a value.

A Location represents an addressable position in application state.

Conceptually:

```text id="t48qu8"
Expression
    ↓
evaluate()
    ↓
Value
```

versus:

```text id="sn43q5"
Location
    ↓
resolve()
    ↓
Writable state address
```

This distinction SHALL be enforced throughout:

* actions;
* operations;
* UI bindings;
* dependency analysis;
* validation;
* runtime mutation;
* agent queries.

---

# 3. Architectural invariant

After Axiom 0.3:

> No application state mutation may occur by mutating the JavaScript object returned by an arbitrary Expression.

This pattern MUST disappear from the runtime:

```ts id="vwvkko"
const target = evaluate(expression, scope);

target[fieldId] = value;
```

Expressions SHALL be treated as values.

Locations SHALL be treated as writable addresses.

---

# 4. Location type

Introduce:

```ts id="onnb4e"
export type Location =
    | StateLocation
    | FieldLocation
    | CollectionItemLocation;
```

Additional location types MAY be added later.

Axiom 0.3 SHOULD deliberately keep the initial vocabulary small.

---

# 5. StateLocation

Represents an entire mutable state node.

```ts id="zrvpgk"
export interface StateLocation {
    kind: 'state';

    stateId: NodeId;
}
```

Example:

```ts id="j0o5hh"
{
    kind: 'state',
    stateId: STATE_SELECTED_CUSTOMER
}
```

This explicitly means:

> Write to this state node.

---

# 6. FieldLocation

Represents a field within another location.

```ts id="m2q4sk"
export interface FieldLocation {
    kind: 'field';

    target: Location;

    fieldId: FieldId;
}
```

Example:

```ts id="nfwfbg"
{
    kind: 'field',

    target: {
        kind: 'state',
        stateId: STATE_CUSTOMER_DRAFT
    },

    fieldId: FIELD_CUSTOMER_NAME
}
```

This means:

> The `name` field of the Customer stored in `STATE_CUSTOMER_DRAFT`.

The location remains structurally traceable back to its state root.

---

# 7. CollectionItemLocation

A collection element MUST be addressable independently of the JavaScript object returned by a query.

Introduce:

```ts id="wyw98w"
export interface CollectionItemLocation {
    kind: 'collection-item';

    collection: Location;

    selector: CollectionSelector;
}
```

Initial selector:

```ts id="sfxicw"
export type CollectionSelector =
    | IdentitySelector
    | IndexSelector;
```

Identity selector:

```ts id="uzl78h"
export interface IdentitySelector {
    kind: 'identity';

    fieldId: FieldId;

    value: Expression;
}
```

Index selector:

```ts id="26uygx"
export interface IndexSelector {
    kind: 'index';

    index: Expression;
}
```

Identity SHOULD be preferred.

---

# 8. Example collection location

Instead of:

```text id="zcv3c8"
evaluate(find(products, id))
→ JavaScript Product object
→ mutate object
```

Axiom SHALL represent:

```ts id="mlsk91"
{
    kind: 'collection-item',

    collection: {
        kind: 'state',
        stateId: STATE_PRODUCTS
    },

    selector: {
        kind: 'identity',
        fieldId: FIELD_PRODUCT_ID,
        value: {
            kind: 'ref',
            targetId: PARAM_PRODUCT_ID
        }
    }
}
```

Updating the product name becomes:

```ts id="np7cpl"
{
    kind: 'field',

    target: productLocation,

    fieldId: FIELD_PRODUCT_NAME
}
```

This explicitly identifies:

```text id="xtt1oh"
STATE_PRODUCTS
      ↓
Product[id = X]
      ↓
name
```

---

# 9. Location resolution

Introduce a runtime resolver.

Conceptual API:

```ts id="iv91xu"
resolveLocation(
    location: Location,
    scope: RuntimeScope
): ResolvedLocation;
```

A `ResolvedLocation` SHALL provide controlled access:

```ts id="o4c0v8"
export interface ResolvedLocation<T = unknown> {
    read(): T;

    write(value: T): void;

    rootStateId: NodeId;

    path: ResolvedPath;
}
```

Application runtime code MUST mutate state through this abstraction.

---

# 10. Resolved path

A resolved location SHOULD retain semantic provenance.

Example:

```text id="adzyce"
STATE_PRODUCTS
collection-item(id=42)
FIELD_PRODUCT_NAME
```

Represented conceptually as:

```ts id="wr5g2b"
{
    rootStateId: STATE_PRODUCTS,

    segments: [
        {
            kind: 'collection-item',
            identity: 42
        },
        {
            kind: 'field',
            fieldId: FIELD_PRODUCT_NAME
        }
    ]
}
```

This information MAY later be used for:

* logging;
* debugging;
* fine-grained subscriptions;
* persistence;
* audit trails;
* distributed synchronization.

---

# 11. Unified mutation operation

Replace specialized mutation semantics where practical with a generic operation:

```ts id="a1pkk6"
export interface SetOperation {
    kind: 'set';

    target: Location;

    value: Expression;
}
```

Example:

```ts id="1of1s0"
{
    kind: 'set',

    target: {
        kind: 'field',

        target: {
            kind: 'state',
            stateId: STATE_CUSTOMER_DRAFT
        },

        fieldId: FIELD_CUSTOMER_NAME
    },

    value: {
        kind: 'ref',
        targetId: PARAM_NEW_NAME
    }
}
```

---

# 12. Collection operations

Collection operations SHOULD remain explicit because they express semantic intent beyond simple assignment.

Recommended operations:

```ts id="19jibp"
export type MutationOperation =
    | SetOperation
    | InsertOperation
    | RemoveOperation;
```

Insert:

```ts id="kvnz3e"
export interface InsertOperation {
    kind: 'insert';

    target: Location;

    value: Expression;
}
```

Remove:

```ts id="1d5w4f"
export interface RemoveOperation {
    kind: 'remove';

    target: CollectionItemLocation;
}
```

This replaces ambiguous operations based on evaluated object identity.

---

# 13. No implicit object mutation

The following patterns SHALL be prohibited inside the generic runtime:

```ts id="a9j3ch"
object[field] = value;

array.push(value);

array.splice(...);
```

unless they occur inside the implementation of the Location/Mutation subsystem itself.

All semantic mutation MUST pass through the mutation engine.

---

# 14. Mutation engine

Introduce a dedicated mutation subsystem.

Conceptual API:

```ts id="aqh7la"
mutationEngine.apply(
    operation,
    scope
);
```

Internally:

```text id="6m8ftc"
Mutation Operation
       ↓
Validate target
       ↓
Resolve Location
       ↓
Evaluate value
       ↓
Apply mutation
       ↓
Record affected locations
       ↓
Recompute derived state
       ↓
Evaluate invariants
       ↓
Commit / rollback
```

---

# 15. Mutation result

Mutation execution SHOULD return semantic information.

```ts id="avdb5c"
export interface MutationResult {
    affectedStates: NodeId[];

    affectedLocations: ResolvedPath[];
}
```

Example:

```text id="45rsin"
Affected state:
    STATE_PRODUCTS

Affected location:
    STATE_PRODUCTS
      → Product[id=42]
      → FIELD_PRODUCT_NAME
```

This becomes useful for both runtime optimization and agent observability.

---

# 16. UI binding changes

Current input bindings based on:

```ts id="xzzfqf"
binding: {
    target: Expression,
    fieldId: FieldId
}
```

SHALL be replaced.

Preferred representation:

```ts id="op6j8r"
export interface InputBinding {
    location: Location;
}
```

Example:

```ts id="dyyb3u"
{
    kind: 'input',

    binding: {
        location: {
            kind: 'field',

            target: {
                kind: 'state',
                stateId: STATE_CUSTOMER_DRAFT
            },

            fieldId: FIELD_CUSTOMER_EMAIL
        }
    }
}
```

The runtime SHALL NOT directly mutate evaluated expression objects.

---

# 17. UI mutation pipeline

An input change SHALL execute through the same mutation infrastructure as actions.

Conceptually:

```text id="33fy0s"
Browser input event
       ↓
InputBinding
       ↓
Location
       ↓
Mutation Engine
       ↓
State
       ↓
Derived state
       ↓
Constraints
       ↓
UI
```

There MUST NOT be a separate hidden mutation mechanism inside the UI renderer.

---

# 18. Input validation

After a UI mutation, applicable constraints SHALL be evaluated.

The runtime MAY support two validation modes:

```ts id="y8fpnc"
type InputValidationMode =
    | 'immediate'
    | 'deferred';
```

For Axiom 0.3, `immediate` MAY be the default.

The important requirement is that UI mutation and action mutation share the same semantic infrastructure.

---

# 19. Derived state is read-only

Derived state SHALL NOT be directly writable.

The validator MUST reject:

```ts id="3p12nb"
{
    kind: 'state',
    stateId: DERIVED_CURRENT_PRODUCT
}
```

when used as a mutation target.

Instead the graph MUST identify the underlying writable state.

For example:

```text id="ef20gt"
STATE_PRODUCTS
      ↓
Product[id = route.productId]
```

This eliminates accidental reliance on JavaScript reference aliasing.

---

# 20. Location validation

Introduce:

```ts id="2tvl8w"
validateLocation(
    location: Location,
    graph: ApplicationGraph
): ValidationIssue[];
```

Validation SHALL detect:

* unknown state IDs;
* writes to derived state;
* unknown field IDs;
* field/entity type mismatches;
* collection selector applied to non-collection;
* field selector applied to incompatible type;
* invalid index expression type where statically knowable;
* identity field incompatible with collection item type.

---

# 21. Location type inference

The framework SHOULD be capable of determining the type addressed by a Location.

Introduce conceptually:

```ts id="0mtbz2"
inferLocationType(
    location: Location,
    graph: ApplicationGraph
): TypeRef;
```

Example:

```text id="k78ws4"
Location:
STATE_PRODUCTS
 → Product[id=42]
 → FIELD_PRODUCT_NAME

Type:
primitive:string
```

This allows the validator to verify assignment compatibility.

---

# 22. Assignment type validation

Given:

```ts id="kgg6ik"
{
    kind: 'set',
    target: location,
    value: expression
}
```

the validator SHOULD compare:

```text id="52w9lh"
inferLocationType(target)
```

with:

```text id="wznfsb"
inferExpressionType(value)
```

Axiom 0.3 does not require a complete static type checker.

However, obvious incompatible assignments SHOULD be rejected.

Example:

```text id="8us3md"
string field ← collection<Product>
```

SHALL be invalid when both types are statically known.

---

# 23. Dependency derivation

Dependency edges SHALL distinguish reads from writes using Location semantics.

Given:

```ts id="r2pgt7"
{
    kind: 'set',
    target: productNameLocation,
    value: newNameExpression
}
```

Axiom SHALL derive:

```text id="ukgx4k"
Action
   ├── writes → STATE_PRODUCTS
   └── reads  → sources referenced by newNameExpression
```

The Location itself may contain expressions.

For example:

```text id="05s1wo"
Product[id = PARAM_PRODUCT_ID]
```

The selector expression is a **read dependency**.

Therefore:

```text id="kyznkt"
Action
   ├── reads  → PARAM_PRODUCT_ID
   └── writes → STATE_PRODUCTS
```

---

# 24. Field-level dependency metadata

Axiom SHOULD begin supporting field-level write information.

The graph edge itself MAY continue to target a state node while carrying metadata:

```ts id="d6m4qe"
{
    from: ACTION_UPDATE_PRODUCT_NAME,

    to: STATE_PRODUCTS,

    kind: 'writes',

    metadata: {
        fieldIds: [
            FIELD_PRODUCT_NAME
        ]
    }
}
```

Alternatively a separate semantic dependency representation MAY be introduced.

The important capability is that an agent can eventually distinguish:

```text id="rj1ckj"
writes Product.name
```

from:

```text id="4g6o16"
writes Product.stockQuantity
```

---

# 25. Agent query improvements

The Agent API SHALL support:

```ts id="nt7xqx"
getReaders(stateId)

getWriters(stateId)

getFieldReaders(fieldId)

getFieldWriters(fieldId)
```

Recommended additional query:

```ts id="n86lr2"
getMutationImpact(location)
```

Conceptual response:

```ts id="nx7ijy"
{
    directWriters: [...],

    dependentDerivedStates: [...],

    affectedConstraints: [...],

    affectedViews: [...]
}
```

This is particularly important for AI context reduction.

---

# 26. Mutation provenance

Every runtime mutation SHOULD be capable of carrying provenance.

```ts id="6dxl81"
export interface MutationContext {
    source:
        | 'action'
        | 'ui'
        | 'system'
        | 'native';

    sourceNodeId?: NodeId;

    transactionId?: string;
}
```

Example:

```text id="2v56gx"
Mutation

source:
    UI_INPUT_CUSTOMER_NAME

location:
    STATE_CUSTOMER_DRAFT
      → FIELD_CUSTOMER_NAME

oldValue:
    "Alice"

newValue:
    "Alicia"
```

Recording full old/new values MAY be configurable.

---

# 27. Runtime transactions

Action execution SHALL operate transactionally.

Recommended lifecycle:

```text id="5t9up7"
BEGIN RUNTIME TRANSACTION

snapshot affected state

apply mutations

recompute derived state

evaluate postconditions

evaluate invariants

if valid:
    COMMIT

otherwise:
    ROLLBACK
```

UI mutations SHOULD use the same transaction mechanism.

---

# 28. Transaction scope

Axiom 0.3 MAY continue using coarse state snapshots internally.

It is NOT necessary to implement persistent data structures or fine-grained undo immediately.

The semantic API, however, MUST expose transactions independently of the snapshot implementation.

This allows optimization later without changing graph semantics.

---

# 29. Constraint relationship to mutation

A constraint SHOULD be queryable by the state/fields it reads.

Example:

```text id="pbkz3l"
CONSTRAINT_PRODUCT_NAME_REQUIRED
        │
        reads
        ▼
FIELD_PRODUCT_NAME
```

When a mutation affects that field, the runtime can determine which constraints require evaluation.

Axiom 0.3 MAY initially reevaluate all invariants.

However, dependency information SHOULD make selective evaluation possible later.

---

# 30. Read-only Locations

A future need exists for semantically addressable but non-writable locations.

Axiom 0.3 MAY introduce:

```ts id="izqf95"
interface LocationCapabilities {
    readable: boolean;
    writable: boolean;
}
```

At minimum:

```text id="m2a7nd"
mutable state:
    readable + writable

derived state:
    readable only
```

The validator SHALL enforce writability.

---

# 31. Persistence boundary

Location semantics SHOULD NOT initially imply persistence semantics.

For example:

```text id="4jqwue"
STATE_PRODUCTS
 → Product[id=42]
 → name
```

identifies a logical application location.

Whether the state is:

* in memory;
* localStorage-backed;
* remote;
* database-backed;

is a separate concern.

This separation is intentional.

A future persistence layer SHOULD be able to observe semantic mutations without changing application definitions.

---

# 32. Native operation restrictions

Native operations MAY mutate external systems.

However, native code MUST NOT silently mutate Axiom-managed state.

If native code needs to update Axiom state, it MUST return a value or request a mutation through the mutation engine.

Bad:

```ts id="d6ybhq"
nativeOperation(() => {
    runtime.state.foo.bar = 42;
});
```

Correct conceptual model:

```text id="lfhkg5"
Native Operation
      ↓
returns value
      ↓
Axiom SetOperation
      ↓
Location
```

This preserves semantic observability.

---

# 33. Runtime encapsulation

The internal state store SHOULD no longer expose mutable references to arbitrary runtime consumers.

Where practical:

```ts id="6h9s93"
state.get(...)
```

SHOULD be treated as read-only.

Mutation MUST occur through:

```ts id="4s4el4"
mutationEngine.apply(...)
```

This reduces the possibility of mutation bypassing graph semantics.

---

# 34. Expression purity

Expression evaluation SHOULD be pure with respect to Axiom-managed state.

Calling:

```ts id="75ww1d"
evaluate(expression)
```

MUST NOT mutate application state.

This SHALL become an explicit architectural invariant.

Expressions:

```text id="4w2ve5"
read
compute
select
transform
compare
```

Operations:

```text id="8ituxv"
mutate
insert
remove
navigate
invoke side effects
```

The distinction MUST remain clear.

---

# 35. Migration of existing operations

Existing:

```text id="fx6hlx"
set-state
update-field
add-item
remove-item
```

SHOULD be migrated approximately as follows:

```text id="dxo7nk"
set-state
    ↓
set(StateLocation)
```

```text id="7i1kjv"
update-field
    ↓
set(FieldLocation)
```

```text id="1qt1q9"
add-item
    ↓
insert(CollectionLocation)
```

```text id="lnzjka"
remove-item
    ↓
remove(CollectionItemLocation)
```

Compatibility aliases MAY temporarily exist internally.

They SHOULD NOT remain part of the canonical 0.3 model.

---

# 36. Demo migration

Both existing demonstration applications MUST migrate to Location-based mutation.

The migration MUST NOT require domain-specific runtime behavior.

Particular attention SHALL be paid to edit forms that currently rely on derived objects referencing objects inside collection state.

After migration, no correctness SHALL depend on JavaScript object aliasing.

---

# 37. Required aliasing test

Introduce a test where derived state deliberately returns a copy.

For example:

```ts id="ucqxjd"
currentProduct =
    clone(
        find(products, selectedProductId)
    )
```

Editing the product MUST either:

1. explicitly target the original Product location; or
2. explicitly target a separate draft state.

It MUST NOT work merely because both values happen to share JavaScript object identity.

This test is critical.

---

# 38. Draft editing pattern

Axiom SHOULD support two explicit editing patterns.

## Direct editing

```text id="m59pwr"
Input
  ↓
Location
  ↓
STATE_PRODUCTS
  ↓
Product[id=42]
  ↓
name
```

Changes immediately affect canonical state.

## Draft editing

```text id="ebmvhd"
STATE_PRODUCT_DRAFT
       ↓
Form inputs
       ↓
Save Action
       ↓
copy fields
       ↓
STATE_PRODUCTS
 → Product[id=42]
```

Both are valid.

The distinction MUST be explicit in the graph rather than accidental through object references.

---

# 39. Agent transformation example

Given:

> Add an editable optional phone number to Customer.

The agent should:

```text id="r6yso2"
1. Locate Customer.

2. Add FIELD_CUSTOMER_PHONE.

3. Locate customer edit form.

4. Determine its editing strategy:
      direct
      OR
      draft

5. Construct appropriate FieldLocation.

6. Bind InputNode to that Location.

7. Locate customer detail view.

8. Add field-display expression.

9. Validate locations.

10. Validate graph.

11. Commit.
```

No JavaScript object mutation logic is generated.

---

# 40. Canonical mutation example

Domain:

```text id="w3l5vo"
Product
    id
    name
    price
```

State:

```text id="98l4cg"
STATE_PRODUCTS : Collection<Product>
```

Action:

```text id="b3m6wn"
UpdateProductPrice
```

Canonical representation:

```ts id="fpchbg"
{
    kind: 'set',

    target: {
        kind: 'field',

        target: {
            kind: 'collection-item',

            collection: {
                kind: 'state',
                stateId: STATE_PRODUCTS
            },

            selector: {
                kind: 'identity',
                fieldId: FIELD_PRODUCT_ID,
                value: {
                    kind: 'ref',
                    targetId: PARAM_PRODUCT_ID
                }
            }
        },

        fieldId: FIELD_PRODUCT_PRICE
    },

    value: {
        kind: 'ref',
        targetId: PARAM_NEW_PRICE
    }
}
```

This is intentionally more verbose than:

```ts id="dsjzq8"
product.price = newPrice;
```

The representation is not optimized for humans.

It is optimized for:

* unambiguous machine reasoning;
* structural validation;
* dependency derivation;
* transactional execution;
* agent modification;
* semantic inspection.

---

# 41. Serialization

Location MUST serialize without runtime-specific information.

A serialized graph SHALL NOT contain:

* JavaScript references;
* closures;
* pointers;
* DOM objects;
* runtime object identities.

A Location is purely semantic data.

This ensures Application Graph portability.

---

# 42. Location equality

Two structurally equivalent static Locations SHOULD be comparable.

Example:

```text id="qfdy1w"
STATE_CUSTOMER_DRAFT.email
```

can have deterministic semantic equality.

Dynamic locations:

```text id="vv3mwl"
STATE_PRODUCTS[Product.id = PARAM_ID]
```

have structural equality independent of the value of `PARAM_ID` at runtime.

This MAY later support caching and dependency indexing.

---

# 43. Inspector support

The CLI/inspector SHOULD render Locations in readable form.

Example:

```text id="m4bh16"
Action: UpdateProductName

Writes:
  STATE_PRODUCTS
    → Product[id = PARAM_PRODUCT_ID]
    → Product.name

Reads:
  PARAM_PRODUCT_ID
  PARAM_NEW_NAME
```

The internal representation remains ID-based.

Names are resolved only for human inspection.

---

# 44. Semantic mutation log

Runtime MAY expose:

```ts id="ndtp9m"
runtime.getMutationLog()
```

Example entry:

```text id="4hvkll"
Transaction: tx_781

Source:
  ACTION_UPDATE_PRODUCT

Mutation:
  SET

Location:
  STATE_PRODUCTS
    → Product[id=42]
    → Product.name

Result:
  committed
```

This is not required to be persistent in 0.3.

It is primarily an observability mechanism.

---

# 45. Agent safety benefit

Before performing a transformation, an agent SHOULD be able to determine:

```text id="lcy4z3"
What state can this action mutate?

What fields can this action mutate?

Which derived states depend on them?

Which constraints observe them?

Which views consume them?
```

These queries MUST be answerable structurally.

They SHOULD NOT require scanning implementation source code.

---

# 46. Tests

Axiom 0.3 MUST add tests for:

### Location resolution

* state;
* field;
* collection item;
* nested fields.

### Invalid locations

* missing state;
* derived state write;
* missing field;
* wrong entity field;
* collection selector on scalar state.

### Mutation

* set state;
* set field;
* insert collection item;
* remove collection item.

### UI bindings

* input modifies correct Location;
* constraint failure rolls back where appropriate;
* input cannot mutate derived state.

### Aliasing

* behavior remains correct when derived values are copied rather than shared references.

### Dependency derivation

* selectors produce reads;
* targets produce writes;
* field-level metadata is correct.

### Transactions

* successful commit;
* invariant rollback;
* multiple mutations rollback atomically.

---

# 47. Architecture test

Add a test or lint rule preventing direct mutation of state outside the mutation subsystem where practical.

At minimum, runtime code SHOULD be manually structured so that all writes occur in one clearly defined module.

Recommended package/module:

```text id="1nythf"
packages/runtime/src/mutation/
```

containing:

```text id="0dkr82"
resolve-location.ts
mutation-engine.ts
transaction.ts
```

---

# 48. Package changes

## `@axiom/core`

Add:

```text id="psd4qs"
location.ts
```

Owns:

* Location types;
* selectors;
* static location validation;
* location type inference.

Update:

* operations;
* UI bindings;
* edge derivation;
* graph validator.

---

## `@axiom/runtime`

Add:

```text id="0kct1a"
mutation/
    resolve-location.ts
    mutation-engine.ts
    transaction.ts
```

Runtime SHALL route all managed state writes through this subsystem.

---

## `@axiom/agent-api`

Add semantic queries:

```text id="xy91pi"
getFieldReaders()
getFieldWriters()
getMutationImpact()
```

Transformations creating inputs/actions SHALL construct valid Locations.

---

## `@axiom/compiler`

Compiler SHALL preserve Location semantics when normalizing/serializing the graph.

It MUST NOT lower Locations into arbitrary JavaScript mutation code as part of the canonical representation.

---

# 49. Explicitly deferred work

Axiom 0.3 SHALL NOT prioritize:

* additional UI widgets;
* CSS improvements;
* SSR;
* WebAssembly;
* database integration;
* authentication;
* networking architecture;
* WebSockets;
* visual editor;
* production optimization;
* distributed state;
* CRDTs;
* persistence redesign;
* sophisticated static type inference.

These are orthogonal to the 0.3 objective.

---

# 50. Definition of Done

Axiom 0.3 is complete when:

### Semantic model

* `Location` exists as a first-class type.
* Expressions cannot implicitly represent writable addresses.
* Derived state cannot be written.
* Fields within collection elements can be explicitly addressed.

### Runtime

* All Axiom-managed state mutations pass through the mutation engine.
* Runtime UI code performs no direct semantic state mutation.
* Expression evaluation is state-pure.
* Actions and inputs share mutation infrastructure.

### Validation

* Locations are structurally validated.
* Field/entity compatibility is checked.
* Writes to derived state are rejected.
* Obvious assignment type mismatches are rejected.

### Dependency graph

* Mutation targets generate correct state write dependencies.
* Selector expressions generate read dependencies.
* Field-level readers/writers can be queried.

### Transactions

* Mutations execute transactionally.
* Constraint/invariant failure can roll back mutations.
* Multiple mutations can roll back atomically.

### Demonstrations

* Issue Tracker works.
* Inventory works.
* Neither relies on object-reference aliasing.
* No domain-specific code is introduced into core/compiler/runtime.

---

# 51. Primary acceptance test

Given:

```text id="b8g5v8"
STATE_PRODUCTS : Collection<Product>

Product:
    id
    name
    price
```

and derived state:

```text id="bkrb6a"
CURRENT_PRODUCT =
    clone(find(STATE_PRODUCTS, ROUTE_PRODUCT_ID))
```

the application contains an editor for the current Product.

Changing:

```text id="4ix45u"
Product.name
```

MUST NOT depend on `CURRENT_PRODUCT` sharing object identity with the item inside `STATE_PRODUCTS`.

The input/action must explicitly address:

```text id="4fpz0i"
STATE_PRODUCTS
    → Product[id = ROUTE_PRODUCT_ID]
    → Product.name
```

After mutation:

```text id="fvc8zr"
STATE_PRODUCTS
```

contains the new name.

Derived state is recomputed.

The UI reflects the new value.

Dependencies correctly report:

```text id="89ct67"
writes:
    STATE_PRODUCTS
    Product.name

reads:
    ROUTE_PRODUCT_ID
```

This is the canonical Axiom 0.3 test.

---

# 52. Secondary acceptance test

Given the agent query:

> What can change Product.price, and what might be affected if Product.price changes?

The Agent API SHALL be able to return structurally:

```text id="fg4ps4"
Writers:
    UpdateProductPrice
    ProductPriceInput

Affected state:
    STATE_PRODUCTS

Affected derived state:
    STATE_INVENTORY_VALUE

Affected constraints:
    PRODUCT_PRICE_NON_NEGATIVE

Affected views:
    PRODUCT_DETAIL
    PRODUCT_LIST
    INVENTORY_SUMMARY
```

The answer MUST be derived from semantic graph relationships.

It MUST NOT require searching application source text.

---

# 53. Central research objective

Axiom 0.2 demonstrated:

> An application can be represented semantically and executed by a generic runtime.

Axiom 0.3 SHALL demonstrate:

> Every application state mutation can also be represented semantically, addressed precisely, validated structurally and reasoned about by an AI agent.

This distinction is fundamental.

An AI-native framework cannot merely describe what an application contains.

It must allow an agent to determine with certainty:

> If I change this, exactly what am I changing — and what can that affect?

Axiom 0.3 exists to make that question answerable from the Application Graph itself.
