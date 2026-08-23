# State

Axiom 0.6.3-alpha.1. A `StateDef` is a named application value: stored, or computed from
other state.

```ts
{
  id, kind: 'state', name?,
  valueType: TypeRef,
  initialValue?: LiteralValue,
  derivation?: Expression,
  draft?: boolean,
  ephemeral?: boolean,
  persistence?: { kind: 'memory' } | { kind: 'local-storage', key? } | { kind: 'remote', sourceId },
}
```

## Kinds

| | Declared by | Written by | Instance validation | Guarded input writes |
| --- | --- | --- | --- | --- |
| **Stored** | neither flag | actions, input bindings, `hydrateState` | yes | yes |
| **Derived** | `derivation` | nothing | skipped | n/a — unwritable |
| **Draft** | `draft: true` | as stored | skipped | no |
| **Ephemeral** | `ephemeral: true` | as stored | skipped | no |

`authority: 'server'` is a separate axis: it says **who may commit** the value, not where it
is stored or whether it is validated. A client observes such a state and can never write it.
See [`AUTHORITY.md`](AUTHORITY.md).

**Canonical** state means stored state that is neither draft nor ephemeral. It is the state
constraints apply to.

## Stored state

```ts
graph.addNode<StateDef>({
  id: STATE_ORDERS,
  kind: 'state',
  name: 'orders',
  valueType: collectionType(entityType(ENTITY_ORDER)),
  initialValue: [
    { [F_ORDER_ID]: 'order-1', [F_ORDER_STATUS]: 'draft', [F_ORDER_LINES]: [] },
  ],
});
```

Records are keyed by field id. See
[`GRAPH_MODEL.md`](GRAPH_MODEL.md#entity-value-invariant).

Values are deeply frozen on entry to the store, and `getState` returns a deep clone.

### Initialization order

1. Derived states are skipped entirely.
2. `local-storage` persistence with a host that provides storage: the stored value is read from `persistence.key ?? "<graphId>:<stateId>"`. An unparseable value reports `PERSISTED_STATE_UNREADABLE` (warning) and falls through to the next step.
3. `initialValue`, deep-cloned.
4. The type default:

| Type | Default |
| --- | --- |
| `optional(...)` | `null` |
| `collection(...)` | `[]` |
| `primitive('number')` | `0` |
| `primitive('boolean')` | `false` |
| other primitive | `''` |
| `enum([a, …])` | `a` |
| `entity(...)` | `null` |

## Derived state

```ts
graph.addNode<StateDef>({
  id: STATE_ORDER_TOTAL,
  kind: 'state',
  name: 'currentOrderTotal',
  valueType: primitiveType('number'),
  derivation: sum(
    map(currentLines, SCOPE_LINE,
      binary('multiply', field(ref(SCOPE_LINE), F_QUANTITY), field(ref(SCOPE_LINE), F_PRICE))),
  ),
});
```

- Recomputed on demand and handed out as a **frozen deep copy**. It never shares an object with the state it was derived from.
- Cached; the cache is cleared by every state write and on every route change.
- A derivation is evaluated in the root scope, so it may read route parameters.
- Writing derived state is rejected at authoring time (`DERIVED_STATE_WRITE`) and at runtime.
- If the derivation cannot be evaluated, a diagnostic is reported and the value reads as `null`.

This is deliberate: it makes aliasing impossible, so an editor must address the record
where it is actually stored.

## Draft state

`draft: true` marks work in progress — the half-filled form.

- Instance validation (schema conformance and entity constraints) is skipped, because a draft is incomplete by definition.
- An input write rooted in a draft is **not** guarded per keystroke.
- The action that commits the draft is where it must be valid.

```ts
graph.addNode<StateDef>({
  id: STATE_DRAFT_LINE,
  kind: 'state',
  valueType: entityType(ENTITY_LINE),
  draft: true,
  initialValue: { [F_LINE_ID]: '', [F_LINE_PRODUCT]: '', [F_LINE_QUANTITY]: 1, [F_LINE_UNIT_PRICE]: 0 },
});
```

## Ephemeral state

`ephemeral: true` marks presentation state — which panel is expanded, which tab is
selected, whether a dialog is open. It is a UI fact, not a domain fact.

- Skipped by instance validation and unguarded per keystroke, like a draft.
- MUST NOT declare `persistence` (`EPHEMERAL_STATE_PERSISTED`).
- `AgentAPI.getEphemeralStates()` lists it, so an agent can tell UI state from domain state without guessing.

It changes what a state *is*, never what is permitted. A write that reaches domain state is
governed exactly as before.

```ts
graph.addNode<StateDef>({
  id: STATE_PANEL_OPEN,
  kind: 'state',
  name: 'panelOpen',
  valueType: primitiveType('boolean'),
  ephemeral: true,
  initialValue: false,
});
```

## Two editing patterns

Which one an application uses is visible in the graph — look at what an input's location is
rooted in.

| Pattern | Input bound to | Behavior |
| --- | --- | --- |
| **Direct edit** | canonical state | Transactional per keystroke. A value that breaks a hard invariant is rolled back and the control re-renders with what is actually stored. |
| **Draft then commit** | a `draft` state | Unguarded while it is filled in. The committing action is where validity is enforced. |

## Persistence

| `kind` | Behavior |
| --- | --- |
| `memory` | The default. Nothing outside the runtime. |
| `local-storage` | Read at startup, written through on every write, keyed by `key ?? "<graphId>:<stateId>"`. Requires a host that provides `storage`. |
| `remote` | **Validates and does nothing.** Declared, not executed. For state an authority owns, use `authority: 'server'` and give the authority a `PersistenceAdapter`. |

## Validation

| Situation | Code |
| --- | --- |
| `initialValue` inconsistent with `valueType` | `INITIAL_VALUE_TYPE_MISMATCH` and relatives |
| `ephemeral` together with `persistence` | `EPHEMERAL_STATE_PERSISTED` |
| `remote` persistence naming an unknown source | `DANGLING_NODE_REF` |
| A write target rooted in derived state | `DERIVED_STATE_WRITE` |

## Invalid usage

```ts
// WRONG — a stored field that duplicates something derivable. It will drift.
{ id: F_ORDER_TOTAL, valueType: primitiveType('number') }

// RIGHT — derive it.
{ id: STATE_ORDER_TOTAL, kind: 'state', derivation: sum(map(...)) }
```

```ts
// WRONG — using hydrateState as the application's write path. It enforces nothing.
app.hydrateState(STATE_ORDERS, nextOrders);

// RIGHT — a governed action.
app.invokeAction(ACTION_CONFIRM_ORDER);
```
