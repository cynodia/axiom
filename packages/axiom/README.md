# Axiom

AI-native semantic application framework.

Axiom represents application behavior, state, UI structure and presentation as structured
semantic data executed by generic runtimes. An application is a typed graph, not source
files: the JavaScript and HTML that reach the browser are output, and are never edited.

**Status: experimental / alpha (0.5.2-alpha.x).** The API may change between alpha
releases. The documentation in `docs/` describes this exact version.

## Installation

```bash
npm install @cynodia/axiom@alpha
```

## Canonical mental model

| Concept | Is |
| --- | --- |
| `ApplicationGraph` | The authoritative representation of an application. |
| `Expression` | What value is computed. Pure; never writes. |
| `Location` | Where a writable value lives. An address, not a value. |
| `StateDef` | A stored or derived application value. |
| `ActionDef` | A transactional semantic operation. |
| `ConstraintDef` | An invariant over proposed state. |
| `TransitionConstraintDef` | An invariant over previous committed state → proposed state. |
| UI nodes | Semantic interaction structure. |
| `Presentation` | Semantic UX intent. Roles and tokens, never CSS. |
| `Theme` | Translation of presentation intent into visual design. |
| Renderer | Platform-specific materialization. Not part of the graph. |

```text
ApplicationGraph → validateGraph → compileToIR → runtime (+ theme → renderer) → application
```

## Load-bearing invariants

Know these before authoring an application. Each is stated in full in
`docs/SEMANTIC_CONTRACT.md`.

1. **Entity runtime values are keyed by `FieldId`**, not by field name.
2. **Expressions produce values; Locations name writable addresses.** Stored state is deeply frozen.
3. **Derived state is read-only.**
4. **An action is a transaction.** Every mutation commits, or every mutation rolls back.
5. **Operations see provisional state**, and `for-each` iteration N sees the writes of iterations `< N`.
6. **Constraints are evaluated against proposed state**, per instance, wherever it is stored.
7. **Transition constraints compare the instance at transaction entry with the instance proposed.** A newly inserted instance has no previous state and is not evaluated.
8. **Input writes are governed** by the same constraints, through the same engine and transaction.
9. **`hydrateState` bypasses semantic enforcement.** It is administrative.
10. **Presentation never authorizes behavior.** `hidden` ≠ forbidden.
11. **`null` and `[]` are distinct.** `null` fails a collection operator; `[]` does not. A collection is truthy only when non-empty.
12. **`required(x)` asks only whether a value exists.** `required([])` is `true`.
13. **A theme changes presentation only.**

## Minimal application

```ts
import {
  ApplicationGraph, binary, compileToIR, createAxiomRuntime, createMemoryHost,
  literal, nodeId, primitiveType, ref, stateLocation, validateGraph,
} from '@cynodia/axiom';
import type { ActionDef, ButtonNode, RouteDef, StateDef, TextNode, ViewNode } from '@cynodia/axiom';

const COUNT = nodeId('state_count');
const INCREMENT = nodeId('action_increment');
const VIEW = nodeId('ui_view');

const graph = new ApplicationGraph('counter', 'Counter');

graph.addNode<StateDef>({
  id: COUNT, kind: 'state', name: 'count',
  valueType: primitiveType('number'), initialValue: 0,
});

// A value is an Expression. The position written to is a Location.
graph.addNode<ActionDef>({
  id: INCREMENT, kind: 'action', name: 'increment',
  operations: [
    { kind: 'set', target: stateLocation(COUNT), value: binary('add', ref(COUNT), literal(1)) },
  ],
});

graph.addNode<TextNode>({
  id: nodeId('ui_display'), kind: 'text', value: ref(COUNT),
  presentation: { textRole: 'title', format: { kind: 'number' } },
});
graph.addNode<ButtonNode>({
  id: nodeId('ui_increment'), kind: 'button', label: 'Add one', actionId: INCREMENT,
  presentation: { uxRole: 'primary-action', icon: 'add' },
});
graph.addNode<ViewNode>({
  id: VIEW, kind: 'view', name: 'Counter',
  children: [nodeId('ui_display'), nodeId('ui_increment')],
});
graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });

if (!validateGraph(graph).valid) {
  throw new Error('invalid graph');
}

const host = createMemoryHost({ path: '/' });
const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
app.start();
app.invokeAction(INCREMENT);
console.log(app.getState(COUNT)); // 1
```

`compileToHtml(graph)` emits the same application as one self-contained page.

## Documentation

The complete operational contract ships with this package, in `docs/`.

| Need to understand | Read |
| --- | --- |
| Compressed reference for authoring or modifying an app | `docs/AGENT_REFERENCE.md` |
| Exact runtime guarantees | `docs/SEMANTIC_CONTRACT.md` |
| Graph, ids, types, entity value representation | `docs/GRAPH_MODEL.md` |
| Every expression kind, builtin and scope rule | `docs/EXPRESSIONS.md` |
| Addressing writable positions | `docs/LOCATIONS.md` |
| Stored, derived, draft and ephemeral state | `docs/STATE.md` |
| Actions, operations, transactions, iteration | `docs/ACTIONS_TRANSACTIONS.md` |
| Constraints and transition constraints | `docs/CONSTRAINTS.md` |
| Semantic UI nodes and bindings | `docs/UI.md` |
| Presentation, UX intent, themes, formatting | `docs/PRESENTATION.md` |
| Runtime API and diagnostic codes | `docs/RUNTIME.md` |
| Machine queries and graph transformations | `docs/AGENT_API.md` |
| Validation codes | `docs/VALIDATION.md` |
| Mistakes that compile but are wrong | `docs/ANTI_PATTERNS.md` |

Start with `docs/AGENT_REFERENCE.md`. It plus the `.d.ts` declarations are intended to be
sufficient on their own.

## What is in the box

This package re-exports four, which can also be installed individually:

| Package | Responsibility |
| --- | --- |
| `@cynodia/axiom-core` | Graph, semantic types, expressions, locations, presentation, themes, validation. |
| `@cynodia/axiom-compiler` | Normalization into an IR, theme stylesheet, page emission. |
| `@cynodia/axiom-runtime` | State store, evaluation, mutation engine, constraint checking, renderer, routing. |
| `@cynodia/axiom-agent-api` | Semantic and presentation queries, mutation impact, transactional transformations. |

## License

MIT

Copyright (c) 2026 AskTech AS.
