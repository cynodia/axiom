# Actions and transactions

Axiom 0.7.0-alpha.1. An action is behavior expressed as data, executed as a transaction.

```ts
{
  id, kind: 'action', name?,
  parameters?: [{ id, name?, valueType?, required? }],
  guards?: [{ condition: Expression, failureMode?: { code, message? } }],
  preconditions?: Expression[],          // older, positional form
  failureModes?: [{ code, message? }],   // aligned with preconditions by index
  operations: Operation[],
  postconditions?: Expression[],
  destructive?: boolean,
  requiresConfirmation?: boolean,
  confirmationMessage?: string,
  confirmation?: { title?, description?, confirmLabel?, cancelLabel?, severity? },
}
```

## Guards and failure modes

Prefer `guards`: it pairs each condition with the failure it reports, so the two cannot
drift apart.

```ts
guards: [
  { condition: isDraft, failureMode: { code: 'not-draft', message: 'This order is confirmed.' } },
  { condition: hasLines, failureMode: { code: 'empty-order', message: 'Add a line first.' } },
]
```

The older parallel arrays align **by position**: `failureModes[2]` reports
`preconditions[2]`. The compiler normalizes `guards` into that form, so the IR always
carries aligned arrays and a refusal names the condition that actually failed:

```ts
result.diagnostics[0].details  // { preconditionIndex: 2, failureMode: 'insufficient-stock' }
```

`actionGuards(action)` returns the conditions however they were written.

### Guards evaluate in order, and the first failure stops

Declaration order is evaluation order. The first guard that does not hold refuses the
invocation, and evaluation stops there: later guards are not evaluated, and exactly one
`PRECONDITION_FAILED` is reported, naming that guard by position and by failure mode.

This is the contract, not an implementation detail, and it has three consequences worth
writing an action around:

- **A guard may rely on the guards before it.** Ordering `required(x)` ahead of a guard that reads a field of `x` is how the second one is kept evaluable.
- **A refusal names one cause.** Failures are not aggregated. An interface that wants to show every problem at once should express them as constraints, which are evaluated over the whole proposed state, rather than as guards.
- **A guard that cannot be evaluated fails.** It refuses, exactly as an unevaluable constraint counts as violated — never passes.

Aggregating guard failures would be a different feature with a different diagnostic shape,
and is deliberately not this one.

## Lifecycle

```text
resolve the action                 → ACTION_NOT_FOUND, stop
bind parameters                    → PARAMETER_MISSING for an absent required parameter, stop
evaluate preconditions in order    → PRECONDITION_FAILED { preconditionIndex, failureMode }, stop
ask for confirmation if required   → declined: stop
        ── nothing above opens a transaction; nothing has been mutated ──
BEGIN TRANSACTION (entry state is captured here)
        execute operations sequentially against provisional state
        evaluate entity constraints + schema conformance over proposed state
        evaluate transition constraints over entry state → proposed state
        evaluate postconditions
        any error-severity failure?
                no  → COMMIT
                yes → ROLL BACK every mutation of the transaction
re-render
```

`invokeAction(id, args?)` returns `{ ok, diagnostics }` for **that invocation**. No diffing
of global history is needed.

An action that writes server-authoritative state runs this lifecycle **on the authority**
instead, unchanged; the client dispatches it and receives the result. See
[`AUTHORITY.md`](AUTHORITY.md).

All four failure sources are evaluated; the action does not stop at the first.

## Operations

Seven kinds, enumerated by `OPERATION_KINDS`. `set`, `insert` and `remove` are the
mutations; each addresses a [`Location`](LOCATIONS.md).

### `set`

```ts
{ kind: 'set', target: Location, value: Expression }
```

Writes the value. A missing field along the path is created; a missing collection **item**
is `LOCATION_RESOLUTION_FAILED`.

### `insert`

```ts
{ kind: 'insert', target: Location, value: Expression, position?: 'start' | 'end' }
```

Appends by default. The target must address a collection; a non-array current value is
treated as `[]`. The constructed value is deep-cloned before storing.

### `remove`

```ts
{ kind: 'remove', target: CollectionItemLocation }
```

**A selector matching nothing is a no-op** — no mutation, no log entry, no diagnostic.

### `for-each`

```ts
forEach(collection: Expression, scopeId: NodeId, operations: MutationOperation[])
```

- The collection is evaluated **once**, before any member is mutated.
- Iteration N observes the provisional writes of iterations `< N`.
- It opens **no transaction of its own**: the mutations belong to the action's transaction.
- A failure in iteration N rolls back iterations `0..N-1` and the whole action.
- Nested operations MUST be mutations only. Nested iteration, navigation and invocation are not supported (`UNSUPPORTED_OPERATION`).
- `ref(scopeId)` is the current member, and a nested location may use it to address the canonical record that member points at.

Two members touching the same record debit it twice, and the invariant catches the total:

```text
stock 5 → member A (−3) → 2 → member B (−3) → −1 → `stock >= 0` fails → all rolled back
```

That is public contract, not incidental behavior. It is what lets an aggregate rule be
written as a per-record invariant.

### `invoke`

```ts
{ kind: 'invoke', actionId: NodeId, arguments?: Record<string, Expression> }
```

Runs another action. The nested transaction **joins the outermost** one and shares its
fate: if the nested action fails, everything rolls back and the enclosing action fails too.
Arguments are keyed by the target action's parameter ids.

### `navigate`

```ts
{ kind: 'navigate', routeId?: NodeId, path?: string, parameters?: Record<string, Expression> }
```

Changes the route. Parameters are keyed by route parameter id and are rendered as text. An
unresolvable `routeId` reports `ROUTE_NOT_FOUND`. Navigation is not a state mutation and is
not rolled back.

### `native`

```ts
{
  kind: 'native',
  implementationId: string,
  inputs?: Record<string, Expression>,
  resultTarget?: Location,
  declaredEffects?: NativeEffect[],
}
```

The controlled boundary for behavior the operation vocabulary cannot express.

- The implementation is registered with the runtime (`registerNativeOperation` or `nativeOperations`), never embedded in the graph. Missing → `NATIVE_OPERATION_MISSING`.
- Inputs are **cloned copies**; native code can never reach into managed state.
- Native code does not write state. It returns a value, which the mutation engine writes to `resultTarget` with source `native`.
- Without `declaredEffects`, dependency analysis reports `analysisComplete: false` and names the gap.

**Use it only where no semantic primitive exists.** A native operation is opaque to every
analysis Axiom offers.

## Authorization

```ts
authorization?: Expression
```

Whether the caller may invoke this action at all, evaluated **on the authority** with the
caller bound to `PRINCIPAL`, before any guard and before any transaction opens. It is
stripped from the client IR, so a client never learns the rule and cannot satisfy it by
claiming to.

A guard asks whether the application's state permits this invocation. Authorization asks
whether this *caller* may make it. See [`AUTHORITY.md`](AUTHORITY.md#authentication-and-authorization).

## Postconditions

Evaluated after the operations, inside the transaction, against proposed state. A failure
is `POSTCONDITION_FAILED` and rolls the action back. Use them for a property of the whole
action; use constraints for a property of the state.

## Confirmation

`requiresConfirmation: true` asks the host before the transaction opens. `confirmation`
describes what is asked, without constructing any dialog markup:

```ts
requiresConfirmation: true,
confirmation: {
  title: 'Confirm this order?',
  description: 'Confirming reduces stock for every line and seals the order.',
  confirmLabel: 'Confirm order',
  severity: 'warning',
},
```

A host that implements `confirmRequest` receives the structured request; a host that only
has `confirm(message)` receives a composed sentence. `confirmationMessage` overrides the
composed message.

A declined confirmation ends the invocation with `ok: false` and no diagnostics.

## Destructive intent

`destructive: true` declares that the action destroys something. It is what
`AgentAPI.findDestructiveActions()` reports, and presentation is inferred from it — a bound
button is presented as destructive without the graph saying so twice.

An action containing a `remove` operation is *treated* as destructive by inference, and
validation warns (`DESTRUCTIVE_ACTION_UNMARKED`) if it does not declare the flag, because
the declaration is what an agent reads.

`destructive` is metadata. It does not restrict anything — see
[Presentation never authorizes](PRESENTATION.md#presentation-never-authorizes-behavior).

## The mutation log

```ts
app.getMutationLog();
// [{ transactionId, source, sourceNodeId, operation, path, description,
//    oldValue?, newValue?, outcome }]
```

- `source` is `action` | `ui` | `system` | `native`.
- `description` renders the resolved path: `state_products → [product-1] → field_product_stock`.
- `outcome` is set when the surrounding transaction settles. Rejected attempts remain in the log as `rolled-back`.
- Only the outermost transaction decides an outcome, so the log never suggests that early iterations of a failed loop committed.
- `oldValue` / `newValue` are recorded unless `recordMutationValues: false`.

## Invalid usage

```ts
// WRONG — nested iteration is not supported and is rejected by validateGraph.
forEach(a, S1, [forEach(b, S2, [...])])
```

```ts
// WRONG — enforcing a rule by not offering the control.
{ kind: 'button', visibleWhen: isDraft, actionId: ACTION_EDIT }

// RIGHT — the control may be hidden for clarity, but the rule lives in the graph.
{ kind: 'transition-constraint', entityId: ENTITY_ORDER, expression: … }
```

```ts
// WRONG — a native operation for something the vocabulary expresses.
{ kind: 'native', implementationId: 'app.computeTotal', resultTarget: … }

// RIGHT
{ id: STATE_TOTAL, kind: 'state', derivation: sum(map(...)) }
```
