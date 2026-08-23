# Axiom UI Toolkit — Agent Reference

`@cynodia/axiom-ui` 0.2.0-research. Semantic UI patterns for Axiom.

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

**Never inferred**, because nothing in the graph says it — supply these explicitly:

- **currency and percentage formats.** A `number` does not say which, and guessing from a field named `price` would be a heuristic you could not predict. Pass `formats`.
- **which fields matter in a list.** The default is every field but the identity; narrow it with `fields`.
- **whether a form creates or edits.** Pass `mode`. Default `create`, which offers the identity field.

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

## Rules

- **MUST** give every declaration a stable, unique `instance`. Generated ids derive from it.
- **MUST NOT** put a function, closure or DOM node in a declaration.
- **MUST NOT** edit generated nodes under `declaration` ownership; use a slot, an option, or materialize.
- **MUST NOT** use `rendererOverrides` or any CSS mechanism to achieve a layout a pattern option or a semantic node can express.
- **SHOULD** compose patterns and canonical nodes when no pattern fits, rather than approximating with the wrong one.
- Patterns own UX structure — hierarchy, grouping, empty states, responsive intent. Themes own visual design. Neither owns behaviour: no pattern creates state, an action or a constraint.
