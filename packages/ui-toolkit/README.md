# Axiom UI Toolkit (research prototype)

Semantic UI patterns for [Axiom](https://github.com/cynodia/axiom). **Not published, not
stable, not a release.** This package exists to answer architecture questions.

A pattern compresses a UX concept into a declaration and expands it, at authoring time, into
ordinary Axiom UI nodes. It has no runtime existence. After expansion the application is a
canonical Axiom application that validates, compiles, executes and renders with this package
uninstalled.

```ts
axiomUi.expand(graph, {
  pattern: 'page',
  instance: 'products',
  title: 'Products',
  content: [{ pattern: 'entity-list', instance: 'product_list', source: STATE_PRODUCTS }],
});
```

Patterns: `page`, `metric-grid`, `entity-list`, `entity-form`, `action-bar`.

## Documentation

| | |
| --- | --- |
| [`docs/TOOLKIT_AGENT_REFERENCE.md`](docs/TOOLKIT_AGENT_REFERENCE.md) | Start here. The whole contract. |
| [`docs/PATTERN_CATALOG.json`](docs/PATTERN_CATALOG.json) | Machine-readable: inputs, slots, inferred values. Generated. |
| [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md) | Who owns a generated node after expansion. |
| [`docs/PROVENANCE.md`](docs/PROVENANCE.md) | What a node remembers, and why it never ships. |
| [`docs/PATTERN_AUTHORING.md`](docs/PATTERN_AUTHORING.md) | Defining patterns outside this package. |

Regenerate the catalogue with `npm run toolkit:catalog`.
