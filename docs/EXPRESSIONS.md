# Expressions

Axiom 0.6.2-alpha.1. An expression describes **what value is computed**. It is a tree of
plain data, never source text and never a callback. Evaluation is pure: an expression MUST
NOT change state.

To describe *where* a value is written, see [`LOCATIONS.md`](LOCATIONS.md).

## Semantics

- 15 expression kinds, enumerated by `EXPRESSION_KINDS`. Every kind is implemented; a kind that validated and then did nothing would be a defect.
- Always use the builders. Never hand-write the discriminated union.
- An expression that cannot be evaluated throws `ExpressionEvaluationError`. The runtime catches it at each boundary — derivation, precondition, constraint, operation, render — and reports a diagnostic. Nothing returns a value *and* a failure.

## Conversions

Three coercions decide most edge cases. They are shared by every kind.

**Truthiness** (`and`, `or`, `not`, `conditional`, predicates, `visibleWhen`):

| Value | Truthy |
| --- | --- |
| `[]` | **`false`** |
| `[x]` | `true` |
| `''` | `false` |
| `'x'` | `true` |
| `0` | `false` |
| `null` / `undefined` | `false` |
| `{}` | `true` |

A collection is truthy only when non-empty. This is the one coercion most likely to
surprise: use `count(...) > 0` when you mean "has members" and want it to read that way.

**Text** (`concat`, `to-string`, `lowercase`, comparison of non-numbers, rendering):
`null`/`undefined` → `''`; string → itself; number/boolean → `String(v)`; anything else →
`JSON.stringify(v)`.

**Number** (`add`, `subtract`, `multiply`, `divide`, `negate`): `Number(value ?? 0)`. A
non-numeric string therefore yields `NaN` rather than an error, and comparisons against
`NaN` are false — a guard fails closed rather than passing on a value it could not compute.

**Equality** (`eq`, `neq`, `contains`, `one-of`, identity selectors, transition-constraint
change detection) is structural and key-order independent. `null` and `undefined` are
equal to each other and to nothing else.

## Expression kinds

### `literal(value)`

Literal data. Structured values are allowed; executable text is not.

- Output: the value as written.
- Validation: none.

### `ref(targetId)`

Resolves an identifier against the scope chain, then state. See
[Scope semantics](#scope-semantics).

- Output: the bound value, or the state's current value.
- Unresolved at runtime: `UNRESOLVED_REFERENCE`.
- Validation: `INVALID_EXPRESSION_REF` if the id is neither a resolvable scope nor a state, entity or parameter.

### `field(source, fieldId)`

Reads one field of a record, by field id.

- Output: the field value; `null` if the source is not a record or the field is absent.
- Never throws.
- Validation: `DANGLING_FIELD_REF` if the field id does not exist.

```ts
field(ref(SCOPE_LINE), F_LINE_QUANTITY)
```

### `object(entries, entityId?)`

Constructs a record keyed by field id. This is how a new instance is built.

- Output: `{ [fieldId]: value, … }`. Fields not listed are absent, not `null`.
- `entityId` is optional metadata used by dependency analysis and by `addFieldToConstructors`. Supply it.
- Validation: every `fieldId` must exist; `entityId` must be an entity. Field membership of the entity is **not** checked here.

```ts
object([
  { fieldId: F_LINE_ID, value: call('uuid') },
  { fieldId: F_LINE_QUANTITY, value: literal(1) },
], ENTITY_LINE)
```

### `binary(operator, left, right)`

| Operator | Semantics |
| --- | --- |
| `eq` / `neq` | Structural equality, key-order independent. |
| `gt` `gte` `lt` `lte` | Numeric when **both** sides are numbers; otherwise lexicographic on their text form. |
| `and` / `or` | Truthiness, short-circuiting. Output is a boolean. |
| `add` `subtract` `multiply` | `Number(x ?? 0)` arithmetic. |
| `divide` | Division by zero yields **`null`**, not an error and not `Infinity`. |

### `unary(operator, operand)`

- `not` → `!truthy(operand)`.
- `negate` → `-Number(operand ?? 0)`.

### `call(fn, ...args)`

Calls a built-in. See [Built-in functions](#built-in-functions).

- Validation: `UNSUPPORTED_EXPRESSION` for an unknown name; `INVALID_AGGREGATION` if an aggregate is applied to something statically non-numeric.
- Runtime: an unknown name yields `UNSUPPORTED_EXPRESSION`.

### `conditional(condition, whenTrue, whenFalse)`

Both branches are expressions. Only the chosen branch is evaluated.

### Collection operators

All six bind the current member to `scopeId` and are strict about their source: `null`
fails, `[]` behaves normally.

| Builder | Input | Output | On `[]` |
| --- | --- | --- | --- |
| `filter(src, scopeId, predicate)` | `Collection<A>` | `Collection<A>` | `[]` |
| `find(src, scopeId, predicate)` | `Collection<A>` | `A \| null` | `null` |
| `map(src, scopeId, projection)` | `Collection<A>` | `Collection<B>` | `[]` |
| `sort(src, scopeId, by, direction?)` | `Collection<A>` | `Collection<A>` | `[]` |
| `every(src, scopeId, predicate)` | `Collection<A>` | `boolean` | **`true`** |
| `some(src, scopeId, predicate)` | `Collection<A>` | `boolean` | **`false`** |
| `flatten(src)` | `Collection<Collection<A>>` | `Collection<A>` | `[]` |

- `sort` orders by the projected key, ascending unless `direction: 'desc'`. Numbers compare numerically; anything else compares as text. The sort is stable.
- `flatten` collapses exactly one level, and fails if any member is not itself a collection.
- Validation: `NOT_A_COLLECTION` if the source is statically not a collection; `SCOPE_SHADOWING` / `SCOPE_COLLIDES_WITH_NODE` for a bad `scopeId`.

They compose, and type inference follows the composition:

```ts
// Total of one product across every line that mentions it.
sum(
  map(
    filter(ref(LINES), LINE, binary('eq', field(ref(LINE), F_PRODUCT), ref(PARAM_PRODUCT))),
    LINE,
    field(ref(LINE), F_QUANTITY),
  ),
)
```

## Built-in functions

14 names, enumerated by `BUILTIN_FUNCTIONS`. `AGGREGATE_FUNCTIONS` lists those that reduce
a collection of numbers (`sum`).

| Function | Arity | Input | Output | Notes |
| --- | --- | --- | --- | --- |
| `required` | 1 | any | `boolean` | **Presence only.** `[]`, `''`, `0`, `false` are all present. |
| `is-empty` | 1 | any | `boolean` | `null` → `true`; string → trimmed length 0; collection → length 0; anything else → `false`. |
| `non-empty` | 1 | any | `boolean` | `!is-empty`. |
| `length` | 1 | collection or any | `number` | Collection → member count; otherwise the length of its text form. Never fails. |
| `contains` | 2 | collection or text, any | `boolean` | Collection → structural membership. Text → **case-insensitive** substring. |
| `concat` | 0…n | any | `string` | Text form of each argument, joined with nothing between. |
| `coalesce` | 1…n | any | first **present** argument, else `null` | Nullish, not "non-empty" — falling back **to** `[]` works. |
| `one-of` | 2…n | value, options… | `boolean` | Structural equality against any option. |
| `count` | 1 | collection | `number` | **Fails on `null`.** `[]` → `0`. |
| `sum` | 1 | `Collection<number>` | `number` | **Fails on `null`, and on any non-finite or non-numeric member.** `[]` → `0`. |
| `lowercase` | 1 | any | `string` | Text form, lower-cased. |
| `to-string` | 1 | any | `string` | Text form. |
| `now` | 0 | — | `string` | ISO timestamp from the host. |
| `uuid` | 0 | — | `string` | Identifier from the host. |

`now` and `uuid` come from the `HostEnvironment`, so they are deterministic under
`createMemoryHost`.

### Presence vs emptiness

```ts
required(x)          // does x exist?
non-empty(x)         // does x have content?
coalesce(x, y)       // x unless x is absent
```

Field-level `required: true` means present. To reject a blank string, write a constraint:

```ts
{ kind: 'constraint', entityId: ENTITY, expression: call('non-empty', field(ref(ENTITY), F_NAME)) }
```

## Scope semantics

### Resolution order

`ref` walks the scope chain from the innermost binding outward, and consults state only if
nothing in the chain matched:

```text
innermost iteration scope → … → outermost iteration scope
  → action parameters → route parameters
  → state
```

An action parameter with the same id as a route parameter shadows the route parameter.
State is the last resort, so an iteration scope can never be shadowed *by* a state.

### What introduces a scope

| Scope | Introduced by | Bound id | Bound value |
| --- | --- | --- | --- |
| Route parameter | `RouteDef.parameters[].id` | the parameter id | the matched path segment, as a string |
| Action parameter | `ActionDef.parameters[].id` | the parameter id | the argument, or `null` |
| Repeat item | `RepeatNode` | **the repeat node's own id** | the current member |
| Collection item | `filter` `find` `map` `sort` `every` `some` | the expression's `scopeId` | the current member |
| Iteration member | `for-each` | the operation's `scopeId` | the current member |
| Entity under validation | `ConstraintDef.entityId` | **the entity node's id** | the instance being validated |
| Transition | `TransitionConstraintDef` | `previousScopeId` / `proposedScopeId` | the instance at entry / as proposed (`null` if removed) |

A `repeat` template refers to its item as `ref(<repeat node id>)`, not by `itemAlias`.
`itemAlias` is human-facing metadata.

### Shadowing rules

`ScopeId` is **not** a distinct branded type in 0.5; an iteration scope is an ordinary
`NodeId`. Validation enforces what the type system does not:

- A scope id MUST NOT shadow an enclosing iteration scope → `SCOPE_SHADOWING`.
- A scope id MUST NOT be the id of a graph node → `SCOPE_COLLIDES_WITH_NODE`.

Together these make the resolution order above unambiguous in any valid graph. Generate
scope ids as distinct constants, one per iteration site.

## Validation

| Situation | Code |
| --- | --- |
| `ref` to an id that is not a scope, state, entity or parameter | `INVALID_EXPRESSION_REF` |
| `field` or `object` naming an unknown field | `DANGLING_FIELD_REF` |
| `call` naming a function that is not built in | `UNSUPPORTED_EXPRESSION` |
| Aggregation over a statically non-numeric collection | `INVALID_AGGREGATION` |
| Collection operator over a statically non-collection | `NOT_A_COLLECTION` |
| Scope id shadowing an enclosing scope | `SCOPE_SHADOWING` |
| Scope id equal to a node id | `SCOPE_COLLIDES_WITH_NODE` |

Type inference is deliberately partial: it rejects obvious mismatches and stays silent
wherever a type depends on an iteration scope it cannot resolve.

## Invalid usage

```ts
// WRONG — a collection operator over a possibly-absent collection.
sum(map(field(ref(CURRENT_ORDER), F_LINES), LINE, …))

// RIGHT — state the absent case.
sum(map(coalesce(field(ref(CURRENT_ORDER), F_LINES), literal([])), LINE, …))
```

```ts
// WRONG — `required` does not mean "has members". [] is present.
call('required', field(ref(ORDER), F_LINES))

// RIGHT
binary('gt', call('count', field(ref(ORDER), F_LINES)), literal(0))
```

```ts
// WRONG — an expression cannot write. This changes nothing.
const order = find(ref(ORDERS), SCOPE, …);
// …then mutating `order` at runtime

// RIGHT — address the position.
{ kind: 'set', target: itemFieldLocation(ORDERS, F_ID, ref(PARAM_ID), F_STATUS), value: literal('confirmed') }
```
