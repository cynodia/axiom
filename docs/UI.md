# UI

Axiom 0.9.0-alpha.2. Eleven semantic UI node kinds describe **what exists and what it does**.
How it looks is [presentation](PRESENTATION.md).

All eleven share `UIBase`:

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
{
  kind: 'form',
  target: Expression,
  children: NodeId[],
  submitActionId?: NodeId,
  submitLabel?: string,
  submitButtonId?: NodeId,
}
```

Groups controls and optionally submits an action. `target` is the record the form is about;
it is a read, and does **not** define where the children write — each input carries its own
location.

Two ways to give a form a submit control:

| | Declare | Behaviour |
| --- | --- | --- |
| **Simple** | `submitActionId` (+ `submitLabel`) | The renderer generates the button, wrapped in an action group, presented as the primary action. |
| **Advanced** | `submitButtonId` | A declared `ButtonNode` inside the form is the submit control. |

The advanced form exists because a generated button cannot be addressed: the declared one
stays an ordinary graph node, so it can sit in an action group of your choosing, carry an
icon and its own presentation, and be queried like any other control — while still
receiving native form-submit behaviour.

```ts
graph.addNode<ButtonNode>({
  id: UI_ADD, kind: 'button', label: 'Add line', actionId: ACTION_ADD_LINE,
  presentation: { uxRole: 'primary-action', icon: 'add' },
});
graph.addNode<FormNode>({
  id: UI_LINE_FORM, kind: 'form', target: ref(STATE_DRAFT_LINE),
  children: [UI_PRODUCT, UI_QUANTITY, UI_REFUSAL, UI_ACTIONS],
  submitButtonId: UI_ADD,
});
```

- `submitButtonId` MUST name a `ButtonNode` among the form's descendants.
- The submit action is `submitActionId ?? <that button>.actionId`. If both are given they MUST agree. **That one resolution is used everywhere** — execution, validation, presentation inference, `AgentAPI` form structure and UX warnings — so a form with a declared submit button is a form with a primary action, and nothing has to infer it a second way.
- The declared control is rendered with `type="submit"` and no click handler of its own, so a click runs the action exactly once.
- `submitLabel` is ignored when `submitButtonId` is given.

**A declared submit button keeps its arguments.** Submitting the form and clicking the button
are the same invocation: the same `arguments`, evaluated in the same scope, at the moment the
control is used. This matters most inside a `repeat`, where the button's arguments are what
say *which row* — a submit path that ignored them would invoke a parameterized action with
nothing bound and be refused.

```ts
graph.addNode<ButtonNode>({
  id: UI_CONFIRM, kind: 'button', label: 'Confirm', actionId: ACTION_CONFIRM,
  arguments: { [PARAM_ORDER]: field(ref(UI_ORDER_ROW), F_ORDER_ID) },   // survives form submit
});
```

An action parameter that is `required` and never supplied is `MISSING_ACTION_ARGUMENT` at
authoring time — from a `button`, and from a `form` that submits an action without one.

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

**`inputValidation` defaults to `'immediate'`** — in `createAxiomRuntime` and therefore in
every generated page.

| Mode | Entity constraints per keystroke | Transition constraints | Accessibility |
| --- | --- | --- | --- |
| `'immediate'` (default) | evaluated; a write that would break a hard invariant is rolled back | always evaluated | the refused control is marked `aria-invalid` and the reason is announced beside it |
| `'deferred'` | **not** evaluated; validity is left to the next action | always evaluated | a control is marked invalid only when a transition constraint refuses it |

A refused write reports the violation with `details.source: 'input'`, plus an
`INPUT_REJECTED` warning naming the control. The control is marked `aria-invalid`, the
reason is rendered next to it in a `role="alert"` element, and `aria-describedby` relates
the two. All three are keyed by render instance, so only the refused row is affected.

### `button`

```ts
{ kind: 'button', label: string | Expression, actionId: NodeId, arguments?: Record<string, Expression>, destructive?: boolean }
```

Invokes an action. `arguments` is keyed by the **action parameter id**; passing an unknown
parameter is a validation error, and omitting a required one is `MISSING_ACTION_ARGUMENT`.
`destructive` may be declared here, but declaring it on the action is enough — presentation
is inferred from the action.

#### Pending actions

An action the authority executes is not finished when the button is released. While its
answer is outstanding the control renders:

```html
<button data-node="ui_place" data-control="ui_place"
        data-pending="true" aria-busy="true" disabled>Place order</button>
```

and a second press does nothing — a second press is a second transaction, not a retry of the
first, and by the time it reached the authority it would be a legitimately different request.
The outcome is the ordinary `ActionOutcome` lifecycle (`pending` → `ok` / `failed`), so a
`diagnostic` node presents a server refusal exactly as it presents a local one. There is no
async vocabulary in the graph: `pending` is a runtime outcome, and this is the whole of its
presentation.

### `diagnostic`

```ts
{ kind: 'diagnostic', actionId: NodeId, severity?: 'error' | 'warning' }
```

Presents why an action refused. The runtime already knows; this makes it available to the
semantic UI, so an application never has to duplicate an action's guards as derived state
merely to explain them, read console output, or copy an `ActionResult` into its own state.

```ts
graph.addNode<DiagnosticNode>({
  id: UI_CONFIRM_REFUSAL, kind: 'diagnostic', actionId: ACTION_CONFIRM_ORDER,
});
```

Lifecycle — see [`RUNTIME.md`](RUNTIME.md#action-diagnostics) for the full contract:

| Event | What the region presents |
| --- | --- |
| The action was refused | that invocation's diagnostics |
| The action succeeded | nothing — the message clears |
| A confirmation was declined | nothing |
| `clearDiagnostics()`, or navigating away | nothing |

- Only the **most recent** invocation of that action is presented.
- `severity` is the lowest severity presented. `'error'` (the default) presents only errors; `'warning'` presents both.
- Messages come from the structured diagnostics — `failureMode.message` for a refused guard, `ConstraintDef.message` for a broken invariant. The renderer invents no wording.
- The region is a live region (`role="alert"` for errors, `role="status"` for warnings) and is rendered even when empty, so later content is announced. A control invoking the same action is related to it with `aria-describedby` while it has content.

### `dialog`

```ts
{
  kind: 'dialog',
  openWhen: Expression,           // true while it is open
  title: string | Expression,     // the accessible name; required
  description?: string | Expression,
  children: NodeId[],
  closeActionId: NodeId,          // what dismissal invokes
  modal?: boolean,                // default true
  initialFocusId?: NodeId,        // a descendant
  returnFocusId?: NodeId,         // usually whatever opened it
}
```

Content that interrupts, together with the interaction rules that make it a dialog rather
than a box that appears. It is the case where composing existing nodes stops being enough:
visibility is expressible with a `conditional`, but focus movement, focus containment,
`Escape`, focus return and the announcement to assistive technology are behaviour no node
describes.

**The graph says what; the runtime does how.**

| The graph declares | The runtime performs |
| --- | --- |
| what is open, and what closes it | moving focus in when it opens |
| the accessible name and description | containing focus while it is modal |
| the content | dismissing on `Escape` |
| whether it is modal | returning focus when it closes |
| where focus starts and returns to | `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-describedby` |

- **Openness is ordinary state.** `openWhen` is an expression over ordinary state — usually an `ephemeral` boolean — not hidden runtime state. Opening and closing therefore go through actions and the mutation log, and are as inspectable as anything else.
- **A closed dialog is absent, not hidden.** Nothing inside it renders, so nothing inside it is reachable by keyboard or by assistive technology.
- **Dismissal is not cancellation.** `Escape` invokes `closeActionId` and nothing else. Closing a dialog does not revert, cancel or roll anything back unless that action does — the runtime never infers that it should.
- **Focus moves in once**, when the dialog is first rendered open, not on every re-render. A full re-render must not take focus back from wherever the person moved it.
- `title` MUST NOT be empty: a dialog with no accessible name is `INVALID_DIALOG`. `initialFocusId` MUST be inside the dialog and `returnFocusId` MUST NOT be, since it has to exist after the dialog is gone.
- Nothing here names an element, a class, a position or a stacking order. A renderer that is not a browser implements the same semantics its own way.
- **Verified in a real browser.** Role, accessible name, `aria-modal`, focus entry, `Tab` and `Shift+Tab` containment, `Escape`, focus return to the correct render instance, a text field inside the dialog, and the absence of a closed dialog are all asserted against Chromium, not only against the in-memory host.
- **Keyboard containment, not pointer containment.** A modal contains focus and announces itself as modal. It does **not** currently make the rest of the document inert, so a pointer can still reach what is behind it. Declare the rule in a guard, never in the dialog — see [visibility is not authorization](#visibility-is-not-authorization).
- **Focus return prefers the exact render instance that opened it**, and falls back to another instance of the same control when the action removed that row. A destructive confirmation usually deletes the row its trigger was in; dropping focus to the top of the document instead would lose a keyboard user's place.

### `conditional`

```ts
{ kind: 'conditional', condition: Expression, whenTrue: NodeId[], whenFalse?: NodeId[] }
```

Renders one branch. The condition uses the truthiness rules in
[`EXPRESSIONS.md`](EXPRESSIONS.md#conversions) — note that `[]` is falsy.

## Interaction primitives

`dialog` is the first of a class, and the rule that puts it here rather than in a pattern
library is worth stating once:

> Interaction semantics that **cannot be reduced to existing canonical nodes** belong in core.

An authoring pattern can only emit nodes that already exist. So anything whose defining
behaviour is not a node — focus movement, containment, `Escape`, typeahead, active descendant,
the ARIA relationships that go with them — is unreachable from a pattern at any level of
cleverness, and has to be canonical semantics with runtime support.

| Candidate | Class | State |
| --- | --- | --- |
| `dialog` | canonical-semantic | implemented, browser-verified |
| `combobox` | canonical-semantic | **classified, not implemented** |
| `menu`, `tabs`, `accordion`, `tooltip`, `popover` | canonical-semantic | unexamined; each needs its own contract |
| focus trap, keyboard scheme, live announcement | renderer-only | reached through canonical semantics, never declared |
| page, metric grid, entity list, entity form, action bar | pattern-expandable | `@cynodia/axiom-ui` |

**Combobox** was probed deliberately because it looks least like a dialog: no modality, no
interruption, a control inside a form. It divides at the identical seam. Expressible today,
with no new node kind: the bound value, the option source (`InputNode.options`), option
identity and label, filtering, and open state — all ordinary state and expressions. Not
expressible at all: arrow-key navigation, active descendant, typeahead, `aria-expanded` and the
listbox relationships. Two primitives that share no shape dividing the same way is what makes
the split a rule rather than an observation about dialogs.

## Semantic UI authoring

Nodes are the model, not the authoring surface an application has to use. `@cynodia/axiom-ui`
adds five patterns that expand — at build time — into exactly the nodes described on this page.

**Which to reach for:**

| The requirement is | Use |
| --- | --- |
| recurring application UX that expands deterministically into existing semantics | a **pattern** (`page`, `metric-grid`, `entity-list`, `entity-form`, `action-bar`) |
| interaction behaviour that needs the runtime to do something | a **canonical interaction primitive** (`dialog`) |
| custom, but already expressible | **ordinary canonical nodes**, composed |
| genuinely unsupported presentation | the renderer escape (`rendererOverrides.web.className`), and nothing more |

A pattern is an authoring abstraction and nothing else: after expansion the application is an
ordinary Axiom application, and `validateGraph`, `compileToIR`, `AgentAPI` and the runtime know
nothing about patterns. Ownership defaults to the **declaration**, so editing a generated node
is drift rather than an edit. The contract travels with the package rather than being restated here: install
`@cynodia/axiom-ui` and read, inside **that** package,
`@cynodia/axiom-ui/docs/TOOLKIT_AGENT_REFERENCE.md`, its `README.md` and
`@cynodia/axiom-ui/docs/PATTERN_CATALOG.json` — the last is addressable as
`@cynodia/axiom-ui/catalog`. None of the three is in this package.

## Containment

`uiChildIds(node)` returns a node's children in render order, for every kind:

| Kind | Children |
| --- | --- |
| `view` `container` `form` | `children` |
| `repeat` | `templateId`, then `emptyTemplateId` |
| `conditional` | `whenTrue`, then `whenFalse` |
| others | none |

A UI node not reachable from any route is reported as `UNREACHABLE_UI_NODE` (a warning).

### The primary render path

`primaryChildIds(node)` walks the arrangement that appears when every collection has
members and every condition holds: a `repeat`'s `templateId` but not its `emptyTemplateId`,
a `conditional`'s `whenTrue` but not its `whenFalse`.

An alternative branch is not part of that path, because its content is never on screen at
the same time. Analysis of structure that appears together uses this rather than
`uiChildIds`:

- document-outline validation (`INVALID_HEADING_STRUCTURE`);
- `AgentAPI.getFormStructure`, so a heading inside an empty template is not described as one of the form's sections.

## Render instances

A UI node inside a `repeat` is rendered once per member. `NodeId` alone therefore cannot
identify a rendered element, and two concepts are kept distinct:

```text
NodeId          = semantic graph identity        → data-node
RenderInstance  = runtime presentation identity  → data-instance
Control         = the element a person operates  → data-control
```

Every renderer-generated identity and relationship is keyed by the render instance:

```text
element id          label for          aria-describedby
error-region ids    control lookup     focus restoration
```

So refusing a write in one row marks **that row** invalid, and nothing leaks into another.

Instance identity is:

- **semantic where it can be** — the value of the member entity's `identityFieldId`, so the identity follows a row through reordering;
- **a deterministic index otherwise** — where the member type cannot be resolved statically, or the identity value is absent or unusable in an id;
- **composing** for nested repeats, rather than colliding.

```html
<label data-node="ui_line_quantity" data-instance="ui_line_quantity--line-7f3a"
       for="axiom-control-ui_line_quantity--line-7f3a">
  <span class="axiom-input-label">Quantity</span>
  <input data-node="ui_line_quantity" data-control="ui_line_quantity"
         data-instance="ui_line_quantity--line-7f3a"
         id="axiom-control-ui_line_quantity--line-7f3a" type="number">
</label>
```

The exact encoding is an implementation detail; the properties above are the contract. The
graph still holds one node, and `AgentAPI` reasons about that node.

### `data-node` and `data-control`

One semantic node can render as more than one element: an input is a label wrapping a control,
and **both carry `data-node`, because both are that node**. Only one of them can be typed into,
and `data-node` cannot say which.

| Attribute | Selects | Cardinality |
| --- | --- | --- |
| `data-node` | every element that is this semantic node | one or more per rendering |
| `data-control` | the single element a person operates | exactly one, on nodes that have one |
| `data-instance` | this rendering of the node | one per element, inside a `repeat` |
| `data-variant` | the control variant chosen from presentation intent — `switch`, `stepper`, `radio-group` | on the control |

So `[data-control="ui_line_quantity"]` is the input, `[data-node="ui_line_quantity"]` is the
input and its label, and inside a repeat `[data-control="…"][data-instance="…"]` is one row's.
A `button` is its own control, so both attributes name the same element. A radio group has no
single element to operate, so the group itself carries `data-control`.

Semantic identity stays on the wrappers: `AgentAPI` and any tooling that reasons about the
graph needs to find every element a node produced, not only the interactive one.

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
