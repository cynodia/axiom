# Axiom UI Toolkit — Agent Reference

`@cynodia/axiom-ui` 0.7.0-alpha.2. Semantic UI patterns for Axiom.

Read this plus [`PATTERN_CATALOG.json`](PATTERN_CATALOG.json) and the `.d.ts` declarations.
Nothing else should be necessary.

## What a pattern is

A pattern is **not a component**. It has no runtime existence, renders nothing and owns no
state. It is a function from a declaration to ordinary Axiom UI nodes, run once at authoring
time.

```
pattern declaration  →  expansion  →  canonical Axiom UI  →  presentation  →  renderer
```

After expansion the application is an ordinary Axiom application. `validateGraph`,
`compileToIR`, `AgentAPI` and the runtime see nodes, not patterns. **Do not look for a
pattern at runtime; there is none.**

## Using it

```ts
import { axiomUi } from '@cynodia/axiom-ui';

const rootId = axiomUi.expand(graph, {
  pattern: 'entity-list',
  instance: 'product_list',        // stable, yours, and the root of every generated id
  source: STATE_PRODUCTS,
});
```

`expand` returns the id of the root node it created. Put that id in a `view`'s children, or in
another pattern's `content` slot.

A declaration is **plain data**: no functions, no callbacks, no JSX. Slots take node ids or
nested declarations, never markup.

## Discovering what exists

```ts
import { axiomUi, listPatterns, describePattern } from '@cynodia/axiom-ui';

listPatterns(axiomUi);                      // ['action-bar','entity-form','entity-list','metric-grid','page']
describePattern(axiomUi, 'entity-list');    // required, optional, inputs, slots, produces, inferred
```

`describePattern(...).inferred` tells you what a pattern works out for itself, and from what.
**Do not restate anything listed there.** The same content is in `PATTERN_CATALOG.json` if you
prefer to read it without running code.

## What is inferred, and what is not

The rule: **the toolkit infers what the graph already says; you supply application-specific UX
choices.**

Inferred from the graph — do not repeat these:

| | from |
| --- | --- |
| the entity a collection holds | the state's `valueType` |
| a field's label | `FieldDef.name` |
| a field's control | `FieldDef.valueType` (`boolean` → checkbox, `number` → stepper, `enum` → select) |
| whether a control is required | `FieldDef.required` |
| field order | the entity's declaration order |
| number / boolean / date / datetime formats | `FieldDef.valueType` |
| destructive emphasis | `ActionDef.destructive` |
| the primary action of a form | its submit action |
| a metric's label | the `name` of the state its value reads |
| whether a form creates or edits | `draft` (create) or `target` (edit) — the two are different semantics, not a flag |

**Never inferred**, because nothing in the graph says it — supply these explicitly:

- **currency and percentage formats.** A `number` does not say which, and guessing from a field named `price` would be a heuristic you could not predict. Pass `formats`.
- **which fields matter in a list.** The default is every field but the identity; narrow it with `fields`.
- **where a form writes.** `draft: S` creates a record in a draft state; `target: { state, identity }` edits the member of a collection that `identity` selects. Exactly one is given, and the mode follows from which. A form that gave neither, or both, is refused at the declaration.
- **a choice drawn from application data.** A field whose value identifies another record takes an `options` source: `options: { [F_ORDER_PRODUCT]: { source: ref(STATE_PRODUCTS), scopeId, valueFieldId, labelFieldId } }`.

## Creating and editing

```ts
// Create: controls write into a draft state, which is not checked per keystroke, because a
// half-filled new record is incomplete by definition.
{ pattern: 'entity-form', instance: 'new_product', draft: STATE_DRAFT, submit: ACTION_ADD }

// Edit: controls write into the addressed member of a collection. Every write is
// transactional against every hard invariant, and a value that breaks one is rolled back.
{
  pattern: 'entity-form',
  instance: 'edit_product',
  target: { state: STATE_PRODUCTS, identity: ref(ROUTE_PARAM_CODE) },
  submit: ACTION_SAVE,
}
```

The identity field of the entity is what addresses the member; an entity without one cannot be
edited this way and says so (`NO_IDENTITY_FIELD`). An edit form omits the identity field from
its controls, because an identity is what addresses a record, not something to retype.

## User-visible text can be an expression

A pattern input carrying user-visible **value** text takes `string | Expression`:

```ts
{ pattern: 'page', instance: 'detail', title: field(productInRoute(), F_PRODUCT_NAME) }
```

`page.title`, `page.description`, a metric's `label` and `description`, and a form's `title`,
`description` and `submitLabel` all accept either. A caption that is the same on every record
is a string; a title that names the record on screen is an expression.

## Composition

Patterns nest. `page` takes `content` and `actions`; `entity-list` takes `rowExtra`. A slot
accepts a node id or another declaration.

```ts
axiomUi.expand(graph, {
  pattern: 'page',
  instance: 'products',
  title: 'Products',
  content: [
    { pattern: 'entity-list', instance: 'product_list', source: STATE_PRODUCTS },
    { pattern: 'entity-form', instance: 'new_product', draft: STATE_DRAFT, submit: ACTION_ADD },
  ],
});
```

## When no pattern fits

**Compose. Do not wait for a pattern and do not reach for CSS.** Patterns emit ordinary Axiom
UI nodes, so ordinary nodes sit beside them. Build the part the toolkit does not know with
`container`, `text`, `conditional`, `field-display`, and put pattern expansions inside it.

The same applies to a requirement inside a pattern — a per-row badge, a warning marker. Put a
`conditional` node in the `rowExtra` slot. You do not need to reproduce the generated
structure, and there is no CSS or DOM escape hatch to reach for.

## Referring to the current row

Inside `entity-list`, a row's fields and a row action's arguments are expressions evaluated in
the row's scope. Build them with the helpers, which derive the repeat's id from the instance:

```ts
import { rowField } from '@cynodia/axiom-ui';

rowActions: [ACTION_DELETE_PRODUCT],
rowArguments: { [ACTION_DELETE_PRODUCT]: { [PARAM_PRODUCT]: rowField('product_list', F_PRODUCT_ID) } },
```

## Diagnostics

A declaration is checked against the graph **before** any node is created, and a mistake points
at the declaration:

```
[SOURCE_NOT_A_COLLECTION] product_list.source: Low stock is not a collection, so it has no rows to list.
[FIELD_NOT_ON_ENTITY] product_list.fields[1]: field_order_total is not a field of Product.
[MISSING_ACTION_ARGUMENT] bar.actions[0]: Delete product requires param_product; supply it under arguments.
```

A refused expansion creates nothing. `validateGraph` still runs afterwards and is still final —
toolkit checks are an earlier, better-located diagnostic, never a replacement.

## Understanding what a pattern did

```ts
const expansion = axiomUi.inspect(graph, 'product_list');
expansion.declaration;   // what you wrote
expansion.nodeIds;       // what it generated
expansion.explanations;  // why it chose what it chose
```

`explanations` is prose written by the pattern — which field got which format and from what,
why an action landed in the row action group, why an empty state exists.

## Ownership

Generated nodes record who owns them. The default is `declaration`: **the declaration is the
source of truth, and editing a generated node is drift** that `detectDrift` reports and the
next build overwrites. To take ownership of the result instead, `materializePattern`. See
[`OWNERSHIP.md`](OWNERSHIP.md).

## When not to add a pattern

A new pattern is justified by **recurring semantic UX intent**, not by recurring visual
structure. Before adding one, require evidence that it recurs, that its inference is
meaningful, that expansion removes semantic restatement, that customization stays composable,
and that canonical primitives alone are unnecessarily repetitive. A missing composition is not
a missing pattern.

Two things are never patterns:

- **Interaction behaviour.** A pattern can only emit nodes that already exist, so focus movement, containment, `Escape`, typeahead and active descendant are unreachable from here. They are canonical semantics — `dialog` is one, and `combobox` is classified as the next.
- **Anything that generates behaviour.** No pattern creates state, an action, a constraint or an authority. A pattern that generated an action would be hiding the part of an application that decides what happens.

## Rules

- **MUST** give every declaration a stable, unique `instance`. Generated ids derive from it.
- **MUST NOT** put a function, closure or DOM node in a declaration.
- **MUST NOT** edit generated nodes under `declaration` ownership; use a slot, an option, or materialize.
- **MUST NOT** use `rendererOverrides` or any CSS mechanism to achieve a layout a pattern option or a semantic node can express.
- **SHOULD** compose patterns and canonical nodes when no pattern fits, rather than approximating with the wrong one.
- Patterns own UX structure — hierarchy, grouping, empty states, responsive intent. Themes own visual design. Neither owns behaviour: no pattern creates state, an action or a constraint.
