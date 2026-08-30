# @cynodia/axiom-ui

Semantic UI authoring for [Axiom](https://github.com/cynodia/axiom). Pre-release
(`0.13.0-alpha.1`); the API may change.

**AI agents:** read [`docs/TOOLKIT_AGENT_REFERENCE.md`](docs/TOOLKIT_AGENT_REFERENCE.md)
before expanding a pattern, and `docs/AGENT_REFERENCE.md` inside the installed
`@cynodia/axiom` package before authoring an application.

A pattern compresses a recurring UX concept into a declaration and expands it, **at authoring
time**, into ordinary Axiom UI nodes. It has no runtime existence, renders nothing and owns
no state. After expansion the application is a canonical Axiom application that validates,
compiles, executes and renders with this package uninstalled.

```bash
npm install @cynodia/axiom @cynodia/axiom-ui
```

```ts
import { axiomUi } from '@cynodia/axiom-ui';

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

That declaration produces the containers, the heading levels, the landmark roles, the field
labels, the value formats implied by each field's type, the empty state, the responsive
stacking, the required markers and the diagnostic region. None of it was ever specific to
this application, which is what makes it the pattern's business rather than the author's.

## Five patterns

| | |
| --- | --- |
| `page` | A titled page: header region, page-level actions, content region. `title` accepts an expression. |
| `metric-grid` | A reflowing grid of named measures. Labels are inferred from the state each value reads. |
| `entity-list` | One row per member of a collection, with per-row actions and an empty state. |
| `entity-form` | Creates a record in a draft state, **or edits an existing one** addressed by expression. Fields can offer a choice drawn from application data. |
| `action-bar` | A group of controls whose emphasis comes from what the actions *are*. |

Five, deliberately. A new pattern needs evidence that the intent recurs, that its inference is
meaningful, and that canonical primitives alone are repetitive — not that a composition was
missing. See [`docs/TOOLKIT_AGENT_REFERENCE.md`](docs/TOOLKIT_AGENT_REFERENCE.md#when-not-to-add-a-pattern).

## When not to use a pattern

```
pattern            ordinary recurring application UX
   ↓
canonical nodes    custom composition that is already expressible
   ↓
renderer escape    genuinely unsupported presentation (a class name, and nothing more)
```

A dialog, a focus trap or a keyboard scheme is **not** a pattern: a pattern can only emit
nodes that already exist, and interaction behaviour is not a node. Those are canonical
semantics in `@cynodia/axiom-core` — see `docs/UI.md` in the facade package.

## Ownership

The declaration is the source of truth by default. A generated node is a build artifact:
re-expansion is authoritative, and editing one is **drift**, which `detectDrift` reports per
node and per property rather than silently overwriting. `materializePattern` is the explicit
alternative — it hands the nodes to the graph, after which the declaration is history and
edits are legitimate. Details in [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md).

## Documentation

| | |
| --- | --- |
| [`docs/TOOLKIT_AGENT_REFERENCE.md`](docs/TOOLKIT_AGENT_REFERENCE.md) | Start here. The whole contract. |
| [`docs/PATTERN_CATALOG.json`](docs/PATTERN_CATALOG.json) | Machine-readable: inputs, inferred values, **and the generated tree**. Generated from the definitions. |
| [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md) | Who owns a generated node after expansion, and how drift is resolved. |
| [`docs/PROVENANCE.md`](docs/PROVENANCE.md) | What a node remembers about how it was authored, and why it never ships. |
| [`docs/PATTERN_AUTHORING.md`](docs/PATTERN_AUTHORING.md) | Defining a pattern outside this package: 0 core, compiler, runtime or renderer changes. |

The catalogue is addressable from outside the package as `@cynodia/axiom-ui/catalog`, and a
worked reference application as `@cynodia/axiom-ui/example`.

MIT © AskTech AS
