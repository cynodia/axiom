# Authoring a pattern

For a third party defining patterns outside `@cynodia/axiom-ui`. Requires **no changes to
Axiom core, the runtime or any renderer**.

```ts
import { createToolkit, definePattern } from '@cynodia/axiom-ui';

const inventoryStatusPanel = definePattern<{
  pattern: 'inventory-status-panel';
  instance: string;
  threshold: number;
}>({
  name: 'inventory-status-panel',
  version: '1.0.0',
  purpose: 'A domain-specific panel reporting stock health.',
  inputs: { threshold: { kind: 'token', required: true, purpose: 'Below this, stock counts as low.' } },
  slots: [],
  produces: ['container', 'text'],
  expansion: [
    { part: 'root', kind: 'container', role: 'the panel' },
    { part: 'caption', kind: 'text', role: 'heading' },
  ],
  check(declaration, { graph, instance }) {
    return declaration.threshold > 0
      ? []
      : [{ code: 'INVALID_THRESHOLD', message: 'A threshold must be positive.', severity: 'error', path: `${instance}.threshold` }];
  },
  expand(declaration, context) {
    const caption = context.add({ id: context.id('caption'), kind: 'text', value: 'Stock health' }, 'caption');
    context.explain(`low stock counted below ${declaration.threshold}`);
    return context.add({ id: context.id('root'), kind: 'container', children: [caption] }, 'root');
  },
});

export const hospitality = createToolkit([inventoryStatusPanel]);
```

## The two halves

`inputs`, `slots`, `produces`, `purpose` and `version` are **data**, and the catalogue serves
them to agents. `check` and `expand` are authoring-time TypeScript and never reach a graph, an
IR or a runtime.

That split is the whole portability story: the part an agent must discover is data; the part
that only runs during a build is code. A pattern *definition* is not portable across
languages. A pattern *declaration*, and everything it expands into, is.

## Rules

- **MUST** create every node through `context.add(node, part)`. It stamps provenance, records the node for drift detection and keeps ids deterministic. A `graph.addNode` inside `expand` is invisible to all three.
- **MUST** derive ids with `context.id(part, index?)`. Never a counter, never a random value: expansion must be deterministic, and the same declaration must always produce the same graph.
- **MUST NOT** create state, actions, constraints or transition constraints. A pattern composes existing behaviour. Business semantics belong to the application.
- **MUST NOT** emit a colour, a length, a breakpoint, a CSS property or a renderer name. Emit roles, tokens and responsive intent; the theme decides how they look.
- **MUST NOT** accept a callback as an input. No `renderRow(item) => …`. Take a slot instead.
- **SHOULD** implement `check` for anything expansion assumes, so a mistake points at the declaration rather than at a generated node.
- **SHOULD** call `context.explain(...)` whenever the pattern decides something the author did not write. This is what an agent reads back.
- **SHOULD** declare `inferredWhenAbsent` on every optional input the pattern works out for itself. It is how an agent knows what it may leave out.

## Versioning

`version` is recorded in each generated node's provenance. It is what makes a stored expansion
reproducible and an upgrade diffable:

```ts
diffPatternExpansion(expansion, nextToolkit, scratchGraph);
// { added: [...], removed: [...], changed: [{ nodeId, property, from, to }] }
```

Change it whenever expansion output changes. An application should learn that an upgrade
reshapes it from a diff, not from a rendering.
