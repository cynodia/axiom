# Axiom

AI-native semantic web application framework.

**Status: experimental / alpha.** Axiom is a research prototype. Its API may change
between alpha releases, and it is not production-ready.

An Axiom application is not source code. It is a typed semantic graph of entities,
fields, state, actions, constraints, routes and UI nodes. A generic compiler normalizes
that graph and a generic runtime executes it in an unmodified browser — the JavaScript
and HTML that reach the browser are output, never something you maintain by hand.

## Installation

```bash
npm install @cynodia/axiom@alpha
```

## A minimal application

```ts
import {
  ApplicationGraph,
  binary,
  call,
  compileToHtml,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  synchronizeEdges,
  validateGraph,
} from '@cynodia/axiom';
import type { ActionDef, ButtonNode, RouteDef, StateDef, TextNode, ViewNode } from '@cynodia/axiom';

const COUNT = nodeId('state_count');
const INCREMENT = nodeId('action_increment');
const DISPLAY = nodeId('ui_display');
const BUTTON = nodeId('ui_increment');
const VIEW = nodeId('ui_view');

const graph = new ApplicationGraph('counter', 'Counter');

graph.addNode<StateDef>({
  id: COUNT,
  kind: 'state',
  name: 'count',
  valueType: primitiveType('number'),
  initialValue: 0,
});

// Values are expressions; writable positions are locations.
graph.addNode<ActionDef>({
  id: INCREMENT,
  kind: 'action',
  name: 'increment',
  operations: [
    { kind: 'set', target: stateLocation(COUNT), value: binary('add', ref(COUNT), literal(1)) },
  ],
});

graph.addNode<TextNode>({
  id: DISPLAY,
  kind: 'text',
  value: call('concat', literal('Count: '), call('to-string', ref(COUNT))),
});
graph.addNode<ButtonNode>({ id: BUTTON, kind: 'button', label: 'Add one', actionId: INCREMENT });
graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [DISPLAY, BUTTON] });
graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });

synchronizeEdges(graph);

const result = validateGraph(graph);
if (!result.valid) {
  throw new Error(result.errors.map((problem) => problem.message).join('\n'));
}

// Run it headlessly...
const host = createMemoryHost({ path: '/' });
const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
app.start();
app.invokeAction(INCREMENT);
console.log(app.getState(COUNT)); // 1

// ...or emit a self-contained page.
const page = compileToHtml(graph);
```

## Actions are transactions

This is the guarantee the framework is built around:

> An Axiom action executes as a semantic transaction. Its mutations are applied
> provisionally, the relevant constraints are evaluated against the resulting **proposed
> state**, and either the complete action commits or every one of its state mutations is
> rolled back.

That includes iteration. If an action reduces stock for twenty order lines and the
seventeenth breaks an invariant, the first sixteen do not survive — you never write
rollback logic yourself, and `runtime.getMutationLog()` shows every attempted write with
its `outcome` of `committed` or `rolled-back`.

Within one action, each `for-each` iteration reads the state the previous iterations
proposed. Two lines for the same product debit it twice:

```text
stock 5  →  line A (−3)  →  2  →  line A (−3)  →  −1  →  stock >= 0 fails  →  all rolled back
```

That is a guarantee, not an implementation detail: an aggregate rule can be expressed as a
simple per-record invariant.

## What is enforced, and where

Two kinds of rule, and they answer different questions:

| | Question | Applies to |
| --- | --- | --- |
| **Constraint** | Is this state allowed? | Every instance of an entity, wherever it is stored — including instances nested inside other entities. |
| **Transition constraint** | Is this *change* allowed? | The instance as it was when the transaction began, compared with the instance the transaction proposes. |

A transition constraint is what makes a rule like "a confirmed order never changes" hold
no matter which path attempts the write:

```ts
graph.addNode<TransitionConstraintDef>({
  id: ORDER_SEALED,
  kind: 'transition-constraint',
  entityId: ORDER,
  previousScopeId: PREVIOUS,
  proposedScopeId: PROPOSED,
  message: 'A confirmed order cannot be changed.',
  expression: binary(
    'or',
    binary('neq', field(ref(PREVIOUS), STATUS), literal('confirmed')),
    binary('eq', ref(PROPOSED), ref(PREVIOUS)),
  ),
});
```

**Governed paths** — actions, `for-each` iterations, and input bindings — all evaluate
entity constraints *and* transition constraints against the proposed state, and roll the
whole transaction back if either refuses. You do not have to remember not to bind an input
to a protected location: binding it and typing into it is simply refused, with a
`TRANSITION_CONSTRAINT_VIOLATION` naming the rule, the entity, and the previous and
proposed values.

**`hydrateState` is not governed.** It replaces a state value outright for hosts, tests and
seeding, and evaluates nothing. It is deliberately not named like a normal write.

**"Previous" means transaction entry** — committed state as it was before the outermost
transaction began. Not the previous operation, and not the previous iteration.

## Collections

Values are described by expressions, writable positions by **locations**. Collections add
projection, aggregation and ordering to the first, and iteration to the second.

```ts
import { binary, field, filter, forEach, map, ref, sum } from '@cynodia/axiom';

// An order total: project each line to its amount, then sum the projection.
const orderTotal = sum(
  map(ref(LINES), LINE, binary('multiply', field(ref(LINE), QUANTITY), field(ref(LINE), PRICE))),
);

// How much of one product this order asks for, across every line that mentions it.
const requested = sum(
  map(
    filter(ref(LINES), LINE, binary('eq', field(ref(LINE), PRODUCT), field(ref(P), PRODUCT_ID))),
    LINE,
    field(ref(LINE), QUANTITY),
  ),
);

// Reduce the stock of every product the order mentions — one mutation per line, one
// transaction for the action.
const confirm = forEach(ref(LINES), LINE, [
  {
    kind: 'set',
    target: fieldLocation(
      itemLocation(stateLocation(PRODUCTS), identitySelector(PRODUCT_ID, field(ref(LINE), PRODUCT))),
      STOCK,
    ),
    value: binary('subtract', currentStock, field(ref(LINE), QUANTITY)),
  },
]);
```

None of this is a callback. `map`, `sort`, `filter`, `find`, `every`, `some`, `flatten`,
`conditional` and `for-each` are data: they serialize, they validate, and an agent can ask
what they read and write.

**Collection operators are strict about their source.** `null` means a missing or invalid
collection and fails the evaluation; `[]` means an empty collection and works normally
(`sum([])` is `0`, `count([])` is `0`, `every([])` is `true`). Nothing returns a
plausible-looking value while reporting a failure. Where a collection may legitimately be
absent, say so:

```ts
coalesce(field(ref(CURRENT_ORDER), LINES), literal([]))
```

**Presence is not emptiness.** `required(value)` asks only whether a value exists:

```text
required(null) → false      required([])  → true
required(0)    → true       required('')  → true
required(false)→ true
```

Use `is-empty` / `non-empty` for collections and strings, and `coalesce` to fall back on
absence — which means falling back *to* an empty collection now works.

## Presentation and UX intent

Four things are kept apart on purpose:

| | Describes | Lives in |
| --- | --- | --- |
| **UI semantics** | What exists — views, containers, text, repeats, forms, inputs, buttons. | The graph |
| **Presentation semantics** | What it *means* and how it is organized — roles, layout, spacing, sizing, device classes. | The graph |
| **Theme** | What those meanings look like — colours, type scale, spacing values, radii, breakpoints. | The graph's `theme` |
| **Renderer** | How any of it reaches a screen — CSS, classes, media queries, DOM. | The framework |

An application says `role: 'destructive'`, not `color: '#c62a20'`. There is no inline style
model, no CSS property model, and no way to store a function anywhere in the graph.

```ts
graph.addNode<ContainerNode>({
  id: ACTIONS,
  kind: 'container',
  children: [CANCEL, SAVE],
  presentation: {
    uxRole: 'action-group',
    responsive: { compact: { layout: 'vertical' } },
  },
});
```

`uxRole: 'action-group'` is high-information: it already implies a horizontal, wrapping,
centre-aligned, end-justified group. You annotate where intent differs from the default,
not on every node.

### Resolution order

Every resolved property is decided by exactly one layer, lowest first:

```text
renderer defaults  →  theme  →  inherited  →  semantic inference  →  node  →  responsive
```

`resolvePresentation` records which layer won, so precedence is inspectable rather than
folklore:

```ts
const agent = new AgentAPI(graph);
agent.resolvePresentation(DELETE_BUTTON);
// { role: 'destructive', uxRole: 'destructive-action', density: 'comfortable', … ,
//   origins: { role: 'inferred', density: 'theme', 'layout.kind': 'inferred' } }
```

**Inheritance is deliberately narrow.** Only `density` cascades from a parent
(`INHERITED_PROPERTIES`). Nothing else does — a container with `emphasis: 'strong'` does
not make its whole subtree bold.

**Semantic inference** means presentation is derived from what the application already
says, rather than declared twice:

```ts
graph.addNode<ActionDef>({ id: DELETE, kind: 'action', destructive: true, operations: [...] });
graph.addNode<ButtonNode>({ id: BUTTON, kind: 'button', label: 'Delete', actionId: DELETE });
// The button is presented as destructive. It declares no role at all.
```

A button that submits its enclosing form becomes the primary action the same way. An
explicit `presentation.role` always wins; a contradiction — a destructive action presented
as a success — is reported as `DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS`.

### Responsive behaviour without breakpoints

Presentation names device classes — `compact`, `regular`, `wide` — never pixels. The
renderer owns the breakpoints (`theme.responsive`), and provides sensible behaviour with no
configuration at all: rows wrap, fixed grids give up columns, bounded widths stop being
bounded, and controls go full width on a narrow screen.

```ts
presentation: {
  layout: { kind: 'grid', gap: 'medium', columns: { mode: 'adaptive', minimum: 'medium' } },
  responsive: { compact: { padding: 'small' } },
}
```

### Vocabulary

Everything below is a closed set. A token outside it is a validation **error**, because a
renderer cannot act on a value it does not know.

| | Values |
| --- | --- |
| `role` | `primary` `secondary` `tertiary` `destructive` `success` `warning` `informational` `muted` |
| `uxRole` | `primary-action` `secondary-action` `destructive-action` `navigation-action` `form-section` `action-group` `navigation-group` `empty-state` `error-state` `warning-state` `success-state` `informational-state` `toolbar` `sidebar` `content-region` `header-region` `footer-region` |
| `emphasis` | `subtle` `normal` `strong` |
| `density` | `compact` `comfortable` `spacious` |
| `textRole` | `body` `caption` `label` `heading` `title` `display` |
| `surface` | `transparent` `base` `subtle` `raised` `inset` |
| `layout.kind` | `vertical` `horizontal` `grid` `stack` |
| `gap`, `padding` | `none` `xsmall` `small` `medium` `large` `xlarge` |
| `sizing.width` | `fit` `fill` `content` `narrow` `medium` `wide` |
| `align`, `justify` | `start` `center` `end` `stretch` (+ `between` for `justify`) |
| `treatment` | `plain` `badge` `pill` |
| `control` | `default` `switch` `checkbox` `radio-group` `select` `multiline` `stepper` |
| `icon` | `add` `delete` `edit` `save` `close` `warning` `success` `error` `information` `navigation-back` `navigation-forward` `menu` `search` `refresh` `settings` `more` |

### Value formatting

Formatting is presentation. The stored value never changes, and there is no way to supply
a function:

```ts
presentation: { format: { kind: 'currency', currency: 'NOK' } }   // 1250 → "NOK 1,250.00"
presentation: { format: { kind: 'percentage', decimals: 1 } }     // 0.421 → "42.1%"
presentation: { format: { kind: 'boolean', trueLabel: 'Read', falseLabel: 'Unread' } }
```

A display of a boolean, date or datetime field is formatted by inference, without being
asked. A value a format cannot describe falls back to its plain text rather than inventing
a plausible result.

### Theme

A theme is the one place concrete values belong, and it is plain serializable data. Declare
only what differs:

```ts
graph.setTheme({ appearance: 'dark', defaults: { density: 'compact' }, spacing: { medium: 8 } });
```

Light, dark and system appearances need no second graph. `DEFAULT_THEME` is a neutral,
accessible, responsive theme intended for business applications, and
`createThemeStylesheet(theme)` is the web renderer's translation of it into CSS custom
properties and rules.

**A theme cannot change behaviour.** Actions, constraints, transition constraints,
locations, state and routing are untouched by it — which is why "use a denser enterprise
identity" is one `setTheme` call rather than an edit to every node.

### Accessibility

Semantic roles produce accessible structure, so the two cannot drift apart:

- `header-region`, `navigation-group`, `content-region`, `footer-region`, `sidebar` and
  `form-section` become `<header>`, `<nav>`, `<main>`, `<footer>`, `<aside>`, `<section>`.
- `textRole` `display` / `title` / `heading` become `<h1>` / `<h2>` / `<h3>`.
- `error-state` announces itself as an alert; the other status roles as a status.
- An input's label names its control by id, a required field is marked from the model's own
  `required`, help text is related with `aria-describedby`, and a refused write is
  announced next to the control it was refused on with `aria-invalid`.

Validation reports what it can determine reliably — `FORM_INPUT_MISSING_LABEL`,
`INTERACTIVE_ELEMENT_MISSING_LABEL`, `INVALID_HEADING_STRUCTURE`,
`DESTRUCTIVE_ACTION_UNMARKED` — and nothing speculative.

### UX findings

Presentation validation reports what a stylesheet could never tell you. All of it is
warnings; none of it stops an application from compiling:

```text
MULTIPLE_PRIMARY_ACTIONS          FORM_WITHOUT_PRIMARY_ACTION
DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS   DESTRUCTIVE_ACTION_UNMARKED
EMPTY_STATE_WITHOUT_RECOVERY_ACTION       EXCESSIVE_HORIZONTAL_ACTIONS
RIGID_HORIZONTAL_LAYOUT           CONFLICTING_SIZING
PRESENTATION_SEMANTIC_CONFLICT    OPAQUE_PRESENTATION
```

And it is queryable, which is the point:

```ts
agent.getPrimaryActions(VIEW);          // which action is the emphasised one here?
agent.getDestructiveActions(VIEW);      // which controls are dangerous?
agent.getFormsWithoutPrimaryAction();   // where is the hierarchy missing?
agent.getFormStructure(FORM);           // sections, required controls, action groups
agent.getResponsiveBehavior(ROW);       // what happens on a phone?
agent.findNodesByUxRole('empty-state'); // where are the empty states?
agent.getPresentationWarnings(VIEW);    // what is wrong with this screen?
```

### Presentation state

`StateDef.ephemeral: true` marks state that is a UI fact rather than a domain fact — which
panel is expanded, which tab is selected. Instance validation skips it and it may not be
persisted, and an agent can tell it from domain state with `getEphemeralStates()`.

Presentation never authorizes anything. Hiding a control is not the same as prohibiting an
operation: a rule belongs in a precondition or a transition constraint, and a governed
write is checked whether or not any control for it is visible.

### The escape hatch

`rendererOverrides` attaches renderer-specific presentation, and is explicitly the thing
semantic analysis does not understand:

```ts
presentation: { rendererOverrides: { web: { className: 'legacy-panel' } } }
```

It is keyed by renderer, it makes the node `opaque` in resolved presentation, it is
reported as `OPAQUE_PRESENTATION`, and `AgentAPI.getOpaquePresentationNodes()` lists every
node using it. Ordinary applications need none of it, and the acceptance fixtures use none.

## Diagnostics

Failures are structured. Match on `code` rather than reading the message:

```ts
import { RUNTIME_DIAGNOSTIC_CODES } from '@cynodia/axiom';

const result = app.invokeAction(CONFIRM_ORDER);
if (!result.ok) {
  const stock = result.diagnostics.find(
    (diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED,
  );
  console.log(stock?.details); // { preconditionIndex: 2, failureMode: 'insufficient-stock' }
}
```

`result.diagnostics` belongs to that invocation. `app.diagnostics()` keeps the history and
`app.clearDiagnostics()` empties it.

## What is in the box

`@cynodia/axiom` re-exports the framework packages, which can also be installed
individually:

| Package | Contents |
| ------- | -------- |
| `@cynodia/axiom-core` | The Application Graph, semantic types, expressions, locations, validation. |
| `@cynodia/axiom-compiler` | Normalization into an IR, and self-contained page emission. |
| `@cynodia/axiom-runtime` | The generic runtime: state, mutation engine, renderer, routing. |
| `@cynodia/axiom-agent-api` | Semantic queries, mutation impact, transactional transformations. |

## License

MIT

Copyright (c) 2026 AskTech AS.
