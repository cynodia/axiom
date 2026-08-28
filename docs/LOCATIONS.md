# Locations

Axiom 0.11.1-alpha.1.

```text
Expression = a value
Location   = an address of a writable position
```

No application state may be changed by mutating the JavaScript object some expression
happened to return. Expressions produce values; **locations name writable positions**.

## Semantics

- A location is plain data describing a path from a root state to a position inside it.
- Every location is structurally traceable to its root state with `locationRootStateId(location)`.
- A write **rebuilds the path from the root state** rather than editing in place. A mutation therefore never depends on the identity of an object an expression returned.
- Stored state is deeply frozen, so an accidental `object[field] = value` throws in strict mode instead of silently corrupting state.

## Kinds

| Kind | Builder | Addresses |
| --- | --- | --- |
| `state` | `stateLocation(stateId)` | a whole state value |
| `field` | `fieldLocation(target, fieldId)` | one field of another location |
| `collection-item` | `itemLocation(collection, selector)` | one item of a collection location |

Selectors:

| Selector | Builder | Matches |
| --- | --- | --- |
| identity | `identitySelector(fieldId, valueExpression)` | the first item whose `fieldId` equals the value. **Preferred.** |
| index | `indexSelector(indexExpression)` | the item at that position |

Prefer identity. An index is positional and silently addresses a different record when the
collection is reordered or an earlier item is removed.

Shorthand for the most common shape — one field of one item of a collection state:

```ts
itemFieldLocation(stateId, identityFieldId, identityValue, fieldId)
```

## Examples

```ts
// A whole state.
stateLocation(STATE_DRAFT_LINE)

// A field of a state that holds an entity.
fieldLocation(stateLocation(STATE_DRAFT_LINE), F_LINE_PRODUCT)

// One item of a collection state, selected by identity.
const routedOrder = itemLocation(
  stateLocation(STATE_ORDERS),
  identitySelector(F_ORDER_ID, ref(PARAM_ROUTE_ORDER)),
);

// A field of that item.
fieldLocation(routedOrder, F_ORDER_STATUS)

// A field of an item of a collection field of an item — nesting is unbounded.
fieldLocation(
  itemLocation(
    fieldLocation(routedOrder, F_ORDER_LINES),
    identitySelector(F_LINE_ID, ref(PARAM_REMOVE_LINE)),
  ),
  F_LINE_QUANTITY,
)
```

### A location inside `for-each`

Inside an iteration, `ref(scopeId)` is the current member. A location may use it to
address the canonical record that member *points at* — which is how one action reduces
stock across many records without ever aliasing an object:

```ts
{
  kind: 'for-each',
  collection: currentLines,
  scopeId: SCOPE_LINE,
  operations: [
    {
      kind: 'set',
      target: fieldLocation(
        itemLocation(
          stateLocation(STATE_PRODUCTS),
          identitySelector(F_PRODUCT_ID, field(ref(SCOPE_LINE), F_LINE_PRODUCT)),
        ),
        F_PRODUCT_STOCK,
      ),
      value: binary('subtract', currentStock, field(ref(SCOPE_LINE), F_LINE_QUANTITY)),
    },
  ],
}
```

## Runtime behavior

Reads through a location never fail:

| Read through | Result |
| --- | --- |
| a missing field | `null` |
| a missing collection item | `null` |
| a non-collection where an item was expected | `null` |

Writes are stricter:

| Write through | Result |
| --- | --- |
| a missing field | the field is **created** |
| a field of a non-record | the record is **created** |
| a missing collection item | `LOCATION_RESOLUTION_FAILED` |
| a non-collection where an item was expected | `LOCATION_RESOLUTION_FAILED` |
| derived state | `DERIVED_STATE_WRITE`; the write does not occur |

There is one asymmetry worth knowing without probing for it: **`remove` with a selector
that matches nothing is a no-op** — no mutation, no log entry, no diagnostic — while `set`
through a selector that matches nothing is `LOCATION_RESOLUTION_FAILED`.

## Analysis

A location is fully analyzable, which is what makes "if I change this, what does it
affect?" answerable from the graph alone:

```ts
locationRootStateId(location)     // the state it is rooted in
locationFieldIds(location)        // fields a write touches, outermost first — write dependencies
locationSelectorFieldIds(location)// fields read in order to address it
locationExpressions(location)     // selector values and indexes — read dependencies
locationsEqual(a, b)              // structural equality
```

`AgentAPI.getMutationImpact(location)` uses exactly these.

## Validation

| Situation | Code |
| --- | --- |
| Unknown state | `UNKNOWN_STATE_REF` |
| Unknown field | `DANGLING_FIELD_REF` |
| A field selected on a non-entity value | `FIELD_ON_NON_ENTITY` |
| A field that belongs to a different entity | `FIELD_NOT_ON_ENTITY` |
| An item selector on a non-collection | `SELECTOR_ON_NON_COLLECTION` |
| An identity selector using a field of the wrong entity | `IDENTITY_FIELD_MISMATCH` |
| An index selector that is statically not a number | `INVALID_SELECTOR_TYPE` |
| A write target rooted in derived state | `DERIVED_STATE_WRITE` |
| An obviously incompatible assigned value | `ASSIGNMENT_TYPE_MISMATCH` |

## Invalid usage

```ts
// WRONG — derived state is a read-only copy. Rejected by validateGraph and by the runtime.
{ kind: 'set', target: stateLocation(STATE_CURRENT_ORDER), value: … }

// RIGHT — address the state the value is actually stored in.
{ kind: 'set', target: fieldLocation(routedOrder, F_ORDER_STATUS), value: … }
```

```ts
// WRONG — an index selector is positional; removing an earlier line silently retargets it.
itemLocation(routedLines, indexSelector(literal(0)))

// RIGHT
itemLocation(routedLines, identitySelector(F_LINE_ID, ref(PARAM_LINE)))
```
