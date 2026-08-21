# UI

Axiom 0.5.1-alpha.1. Nine semantic UI node kinds describe **what exists and what it does**.
How it looks is [presentation](PRESENTATION.md).

All nine share `UIBase`:

```ts
{ id, kind, name?, visibleWhen?: Expression, presentation?: Presentation, metadata? }
```

## Node kinds

### `view`

```ts
{ kind: 'view', children: NodeId[] }
```

A routable, independently renderable root. A `RouteDef.viewId` must name one.

### `container`

```ts
{ kind: 'container', children: NodeId[], layout?: 'vertical' | 'horizontal' | 'stack' }
```

Groups children. `layout` is the 0.2 spelling and is superseded by
`presentation.layout`, which can say considerably more; it is still read as a fallback.

### `text`

```ts
{ kind: 'text', value: string | Expression }
```

A literal string or a computed value. `presentation.format` formats the value for display
without changing it; `presentation.textRole` decides whether it is body text or a heading.

### `repeat`

```ts
{ kind: 'repeat', source: Expression, templateId: NodeId, emptyTemplateId?: NodeId, itemAlias?: string }
```

Renders `templateId` once per member of `source`.

- The current member is bound to **the repeat node's own id**: the template refers to it as `ref(<repeat node id>)`.
- `itemAlias` is human-facing metadata and resolves nothing.
- `emptyTemplateId` is rendered instead when the collection has no members.
- A `source` that evaluates to `null` is an error, not an empty list. Use `coalesce(..., literal([]))`.

```ts
graph.addNode<RepeatNode>({ id: UI_LINES, kind: 'repeat', source: currentLines, templateId: UI_LINE_ROW });
graph.addNode<FieldDisplayNode>({
  id: UI_LINE_QTY, kind: 'field-display',
  source: ref(UI_LINES),            // ← the repeat node's id
  fieldId: F_LINE_QUANTITY,
});
```

### `field-display`

```ts
{ kind: 'field-display', source: Expression, fieldId: FieldId, label?: string }
```

Reads one field of the record `source` evaluates to. Read-only. The label defaults to the
field's `name`.

### `form`

```ts
{ kind: 'form', target: Expression, children: NodeId[], submitActionId?: NodeId, submitLabel?: string }
```

Groups controls and optionally submits an action. `target` is the record the form is about;
it is a read, and does **not** define where the children write — each input carries its own
location.

A `submitActionId` makes the rendered submit button the form's primary action.

### `input`

```ts
{
  kind: 'input',
  binding: { location: Location },
  label?: string,
  placeholder?: string,
  inputHint?: 'text' | 'email' | 'number' | 'password' | 'date' | 'checkbox' | 'multiline' | 'select',
  options?: { source: Expression, scopeId: NodeId, valueFieldId: FieldId, labelFieldId?: FieldId },
}
```

**An input writes to an addressed location** — no expression, no field id. An input change
goes through the same mutation engine and the same transaction machinery as an action.
There is no second write path inside the renderer.

- `options` offers a choice drawn from application data. Each candidate is bound to `scopeId` while `valueFieldId` and `labelFieldId` are read.
- The control is chosen from `presentation.control` first, then `inputHint`, then the type of the bound location.
- `required` is derived from the model — the `required` flag of the field the location addresses. Do not restate it.

Governance depends on what the location is **rooted in**:

| Rooted in | Per-keystroke behavior |
| --- | --- |
| canonical state | Entity constraints and transition constraints apply. A value that breaks a hard invariant is rolled back and the control re-renders with what is stored. |
| a `draft` or `ephemeral` state | Entity constraints are skipped. Transition constraints still apply to whatever instance the write reaches. |

With `inputValidation: 'deferred'` the per-keystroke entity-constraint check is off
entirely; transition constraints are unaffected.

A refused write reports the violation with `details.source: 'input'`, plus an
`INPUT_REJECTED` warning naming the control, and the control is marked invalid with an
announced message.

### `button`

```ts
{ kind: 'button', label: string | Expression, actionId: NodeId, arguments?: Record<string, Expression>, destructive?: boolean }
```

Invokes an action. `arguments` is keyed by the **action parameter id**; passing an unknown
parameter is a validation error. `destructive` may be declared here, but declaring it on
the action is enough — presentation is inferred from the action.

### `conditional`

```ts
{ kind: 'conditional', condition: Expression, whenTrue: NodeId[], whenFalse?: NodeId[] }
```

Renders one branch. The condition uses the truthiness rules in
[`EXPRESSIONS.md`](EXPRESSIONS.md#conversions) — note that `[]` is falsy.

## Containment

`uiChildIds(node)` returns a node's children in render order, for every kind:

| Kind | Children |
| --- | --- |
| `view` `container` `form` | `children` |
| `repeat` | `templateId`, then `emptyTemplateId` |
| `conditional` | `whenTrue`, then `whenFalse` |
| others | none |

A UI node not reachable from any route is reported as `UNREACHABLE_UI_NODE` (a warning).

## Visibility is not authorization

`visibleWhen` and `ConditionalNode` decide what is **rendered**. They decide nothing about
what is **permitted**.

```text
hidden ≠ forbidden
not rendered ≠ prohibited
```

A governed write is checked whether or not any control for it is visible. If a rule
matters, it belongs in an action guard, a constraint or a transition constraint. Hiding a
button is a clarity decision layered on top of a rule that already holds.

## Routing

```ts
{ kind: 'route', path: '/orders/:id', viewId: UI_ORDER_VIEW, parameters: [{ id: PARAM_ID, name: 'id' }] }
```

- A `:name` segment binds the parameter whose `name` matches; expressions reference the parameter's **id**.
- Parameter values are strings.
- Most-specific match wins: fewer dynamic segments first, then alphabetical by path.
- `app.navigate(path)`, `app.currentRoute()`, and the `navigate` operation all move between routes. Route parameters are part of the root scope, so a derived state may read them.

## Rendering

- Rendering is a **full re-render** on every state change. Focus and caret position are restored by node id.
- The renderer emits only semantic class names and generic HTML elements — including the landmark and heading elements a UX role implies. It writes no inline styles.
- Every element carries `data-node="<node id>"`, which is how a test or a host locates it.

## Validation

| Situation | Code |
| --- | --- |
| A child that is not a UI node | `INVALID_UI_CHILD` |
| A `submitActionId` or `actionId` that is not an action | `INVALID_ACTION_REF` |
| A button argument that is not a parameter of the action | `DANGLING_NODE_REF` |
| An input with no bound location | `UNKNOWN_STATE_REF` |
| A route naming a view that is not a view | `INVALID_ROUTE_VIEW` |
| A UI node unreachable from any route | `UNREACHABLE_UI_NODE` (warning) |

Accessibility and UX findings are listed in
[`VALIDATION.md`](VALIDATION.md#presentation-and-ux).

## Invalid usage

```ts
// WRONG — the template refers to the item by alias. `itemAlias` resolves nothing.
{ kind: 'repeat', itemAlias: 'line', templateId: T, source: … }
// …with the template using ref(nodeId('line'))

// RIGHT — refer to the repeat node's own id.
source: ref(UI_LINES_REPEAT)
```

```ts
// WRONG — an input cannot write through an expression.
{ kind: 'input', binding: { location: stateLocation(STATE_CURRENT_ORDER) } }  // derived state

// RIGHT — address where the value is stored.
{ kind: 'input', binding: { location: itemFieldLocation(STATE_ORDERS, F_ID, ref(PARAM_ID), F_STATUS) } }
```
