# Constraints

Axiom 0.13.0-alpha.1. Two constructs, answering different questions. They are not
interchangeable.

| | Question | Sees |
| --- | --- | --- |
| `ConstraintDef` | Is this state allowed? | the proposed instance |
| `TransitionConstraintDef` | Is this *change* allowed? | the instance at transaction entry **and** as proposed |

Four layers of correctness, which should not be confused:

1. `validateGraph` — is the graph structurally sound? (authoring time)
2. Schema conformance — does an instance satisfy `required` and its `TypeRef`? (runtime)
3. `ConstraintDef` — is this state allowed? (runtime)
4. `TransitionConstraintDef` — is this change allowed? (runtime)

## ConstraintDef

```ts
{
  id, kind: 'constraint', name?,
  expression: Expression,
  entityId?: NodeId,
  severity?: 'error' | 'warning',   // default 'error'
  message?: string,
}
```

### Semantics

- With `entityId`: evaluated **once per canonical instance** of that entity, with the instance bound to `ref(entityId)`.
- Without `entityId`: evaluated once, in the root scope — so it can read state directly.
- Instances are found by walking every canonical state value against its declared `TypeRef`. An entity nested inside a collection inside another entity is validated **where it actually lives**, not only at the top level.
- Draft, ephemeral and derived states are skipped.
- Evaluated after every governed mutation, against proposed state.
- `severity: 'error'` (default) blocks the write. `severity: 'warning'` **never** blocks any write.
- A constraint that cannot be evaluated counts as **violated**.

### Example

```ts
graph.addNode<ConstraintDef>({
  id: CONSTRAINT_STOCK,
  kind: 'constraint',
  name: 'Stock is never negative',
  entityId: ENTITY_PRODUCT,
  message: 'Stock can never fall below zero.',
  expression: binary('gte', field(ref(ENTITY_PRODUCT), F_PRODUCT_STOCK), literal(0)),
});
```

`ref(ENTITY_PRODUCT)` is the instance under validation. The entity's **node id** is the
bound scope id.

### What it can and cannot express

Can: any property of a single instance, including properties of its nested collections
(`sum`, `every`, `count` over its own fields).

Cannot: a property that depends on the *previous* value, on another instance of the same
entity, or on the identity of what changed. For the first, use a transition constraint. For
the others, use an action guard, or a constraint without `entityId` that reads state.

An aggregate rule across records is usually best expressed as a per-record invariant plus
`for-each`, because iteration N sees the writes of iterations `< N`:

```text
stock 5 → line A (−3) → 2 → line B (−3) → −1 → `stock >= 0` fails → all rolled back
```

## Schema conformance

Evaluated alongside constraints on every canonical instance. It needs no declaration.

| Check | Code |
| --- | --- |
| A field with `required: true` is present (not `null`/`undefined`) | `REQUIRED_FIELD_MISSING` |
| An `enum` value is one of the declared values | `ENUM_VALUE_INVALID` |
| A `number` field holds a number; a `boolean` field holds a boolean | `TYPE_MISMATCH` |

`required` means **present**. `0`, `false`, `''` and `[]` all satisfy it. To reject a blank
string, add a constraint:

```ts
expression: call('non-empty', field(ref(ENTITY_ORDER), F_ORDER_REFERENCE))
```

## TransitionConstraintDef

```ts
{
  id, kind: 'transition-constraint', name?,
  entityId: NodeId,               // MUST declare identityFieldId
  previousScopeId: NodeId,
  proposedScopeId: NodeId,
  expression: Expression,
  severity?: 'error' | 'warning', // default 'error'
  message?: string,
}
```

### Semantics

- Evaluated on **every governed mutation path** — actions, `for-each`, `native` results and input bindings alike.
- "Previous" means **committed state as it stood immediately before the outermost transaction began**. Not the previous operation, and not the previous iteration.
- Instances are matched by identity value. The entity MUST declare `identityFieldId`; without one the rule is **silently skipped**.
- An instance whose value is structurally unchanged is skipped.
- A **removed** instance is a transition: `proposedScopeId` is bound to `null`.
- A **newly inserted** instance has no previous state and is **not evaluated**. Govern creation with an action guard or an entity constraint.
- A violation reports `TRANSITION_CONSTRAINT_VIOLATION` with `details`: `transitionConstraintId`, `entityId`, `identity`, `previousValue`, `proposedValue`.

### Example

```ts
graph.addNode<TransitionConstraintDef>({
  id: TRANSITION_ORDER_SEALED,
  kind: 'transition-constraint',
  name: 'A confirmed order never changes',
  entityId: ENTITY_ORDER,
  previousScopeId: SCOPE_PREVIOUS_ORDER,
  proposedScopeId: SCOPE_PROPOSED_ORDER,
  message: 'A confirmed order cannot be changed.',
  expression: binary(
    'or',
    // it was not confirmed …
    binary('neq', field(ref(SCOPE_PREVIOUS_ORDER), F_ORDER_STATUS), literal('confirmed')),
    // … or nothing about it changed
    binary('eq', ref(SCOPE_PROPOSED_ORDER), ref(SCOPE_PREVIOUS_ORDER)),
  ),
});
```

To protect only some fields, compare those fields rather than the whole instance:

```ts
binary(
  'or',
  binary('neq', field(ref(PREVIOUS), F_STATUS), literal('confirmed')),
  binary('eq', field(ref(PROPOSED), F_TOTAL), field(ref(PREVIOUS), F_TOTAL)),
)
```

### Why this exists

A transition constraint makes a business rule hold on **every** governed path. Correctness
never depends on an author remembering "do not bind an input to that location". Bind an
input straight into a confirmed order and typing into it is refused, with a diagnostic
naming the rule, the entity, and both values.

## Governed and ungoverned paths

| Path | Entity constraints | Transition constraints |
| --- | --- | --- |
| Action (including `for-each`, `invoke`, `native` results) | yes | yes |
| Input binding into canonical state | yes | yes |
| Input binding into draft or ephemeral state | skipped for that instance | **yes** |
| Input binding with `inputValidation: 'deferred'` | no | **yes** |
| **`hydrateState`** | **no** | **no** |

`hydrateState` is deliberately ungoverned: it is an administrative facility for hosts, tests
and seeding, and is named so that it cannot be mistaken for a semantic write.

## Judging only what changed

An input write is judged on the violations **it introduces**: the guard compares hard
violations before and after. Data that was already invalid — restored from storage, say —
does not make the rest of the UI unwritable.

Actions are stricter: an action must leave the whole application valid, not merely avoid
making it worse.

A transition constraint always applies on both paths, because it compares against
transaction entry and so can never be a pre-existing violation.

## Validation

| Situation | Code |
| --- | --- |
| A constraint expression referencing an unresolvable id | `INVALID_EXPRESSION_REF` |
| A transition constraint on an entity with no `identityFieldId` | `MISSING_IDENTITY_FIELD` |
| A constraint scope that cannot be supported | `UNSUPPORTED_CONSTRAINT_SCOPE` |

## Invalid usage

```ts
// WRONG — an entity constraint cannot see the previous value, so this can never hold.
{ kind: 'constraint', entityId: ENTITY_ORDER,
  expression: binary('neq', field(ref(ENTITY_ORDER), F_STATUS), literal('confirmed')) }

// RIGHT — a transition constraint sees both values.
{ kind: 'transition-constraint', entityId: ENTITY_ORDER, previousScopeId, proposedScopeId, expression: … }
```

```ts
// WRONG — a warning does not block anything. This is advice, not a rule.
{ kind: 'constraint', entityId: ENTITY_PRODUCT, severity: 'warning',
  expression: binary('gte', field(ref(ENTITY_PRODUCT), F_STOCK), literal(0)) }

// RIGHT — omit severity, or state 'error'.
```
