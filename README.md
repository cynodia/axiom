# Axiom

AI-native semantic application framework.

Axiom represents application behavior, state, UI structure and presentation as structured
semantic data executed by generic runtimes. An application is a typed graph, not source
files: the JavaScript and HTML that reach a browser are output, and are never edited.

**Status: experimental / alpha (0.6.0-alpha.x).** The API may change between alpha
releases. This documentation describes 0.6.0-alpha.1.

## Canonical mental model

| Concept | Is |
| --- | --- |
| `ApplicationGraph` | The authoritative representation of an application. Everything else is derived from it. |
| `Expression` | What value is computed. Pure; never writes. |
| `Location` | Where a writable value lives. An address, not a value. |
| `StateDef` | A stored or derived application value. |
| `ActionDef` | A transactional semantic operation. |
| `ConstraintDef` | An invariant over proposed state. |
| `TransitionConstraintDef` | An invariant over previous committed state → proposed state. |
| UI nodes | Semantic interaction structure (view, container, text, repeat, field-display, form, input, button, conditional). |
| `Presentation` | Semantic UX and presentation intent. Roles and tokens, never CSS. |
| `Theme` | Translation of semantic presentation into visual design. |
| Renderer | Platform-specific materialization. Not part of the graph. |

```text
ApplicationGraph → validateGraph → compileToIR → runtime (+ theme → renderer) → application
```

## Load-bearing invariants

An agent authoring or modifying an Axiom application MUST know these. Each is stated in
full in the linked contract.

1. **Entity runtime values are keyed by `FieldId`, not by field name.** `{ [F_TITLE]: 'Dune' }`, never `{ title: 'Dune' }`.
2. **Expressions produce values; Locations name writable addresses.** Mutating an object an expression returned changes nothing — stored state is deeply frozen and throws.
3. **Derived state is read-only.** Writing it is rejected by `validateGraph` and by the runtime.
4. **An action is a transaction.** Either every mutation commits or every mutation rolls back.
5. **Operations execute sequentially against provisional transaction state.** Operation N sees the writes of operations < N.
6. **`for-each` iteration N observes provisional writes from iterations < N.** The collection itself is read once, before the first mutation.
7. **Constraints are evaluated against proposed state**, per instance of the entity, wherever that instance is stored — including nested inside other entities.
8. **Transition constraints compare the instance at transaction entry with the instance proposed.** They govern change and removal of instances that already existed; a newly inserted instance has no previous state and is not evaluated.
9. **Input writes are governed** by entity constraints and transition constraints, through the same engine and transaction as an action. Binding an input to a protected location does not bypass anything.
10. **`hydrateState` is administrative and bypasses semantic enforcement.** It evaluates no precondition, no constraint and no transition constraint.
11. **Presentation never authorizes behavior.** `hidden` ≠ forbidden. Enforcement belongs to action guards, constraints and transition constraints.
12. **`null` and `[]` are semantically distinct.** `null` is a missing collection and fails a collection operator; `[]` is a present, empty collection and behaves normally.
13. **`required(x)` asks only whether a value exists.** `required([])`, `required('')`, `required(0)` and `required(false)` are all `true`.
14. **A collection is truthy only when non-empty.** `[]` is falsy in a condition; `[x]` is truthy.
15. **Business rules MUST NOT be encoded in presentation, visibility or UI structure.**
16. **`NativeOperation` is an escape hatch.** Use it only where no semantic primitive exists, and declare its effects or dependency analysis reports itself incomplete.
17. **Edges are derived on demand.** `synchronizeEdges` materializes them but correctness does not depend on calling it.
18. **A theme changes presentation only.** It cannot change an action, a constraint, a location, state or routing.
19. **A client cannot commit server-authoritative state**, by any path. An action that writes it executes on the authority.
20. **The client is untrusted.** Its validation results, derived values and claims are never authoritative; guards, authorization and argument types are checked again on the authority.
21. **A client requests semantic actions, never mutation programs.** The protocol carries no way to send operations.

## Installation

```bash
npm install @cynodia/axiom
```

## Minimal complete application

<!-- readme-example:start -->
```ts
import {
  ApplicationGraph,
  binary,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom';
import type {
  ActionDef,
  ButtonNode,
  ConstraintDef,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom';

// Ids are branded strings. Nothing ever resolves by name.
export const COUNT = nodeId('state_count');
export const INCREMENT = nodeId('action_increment');
const LIMIT = nodeId('constraint_limit');
const DISPLAY = nodeId('ui_display');
const BUTTON = nodeId('ui_increment');
const VIEW = nodeId('ui_view');
const ROUTE = nodeId('route_root');

export function createMinimalGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('counter', 'Counter');

  graph.addNode<StateDef>({
    id: COUNT,
    kind: 'state',
    name: 'count',
    valueType: primitiveType('number'),
    initialValue: 0,
  });

  // A value is an Expression. The position written to is a Location.
  graph.addNode<ActionDef>({
    id: INCREMENT,
    kind: 'action',
    name: 'increment',
    operations: [
      { kind: 'set', target: stateLocation(COUNT), value: binary('add', ref(COUNT), literal(1)) },
    ],
  });

  // An invariant over proposed state. Breaking it rolls the whole action back.
  graph.addNode<ConstraintDef>({
    id: LIMIT,
    kind: 'constraint',
    name: 'The count never exceeds three',
    message: 'The count never exceeds three.',
    expression: binary('lte', ref(COUNT), literal(3)),
  });

  // Presentation is intent: a text role and a value format, not a font size.
  graph.addNode<TextNode>({
    id: DISPLAY,
    kind: 'text',
    value: ref(COUNT),
    presentation: { textRole: 'title', format: { kind: 'number' } },
  });
  graph.addNode<ButtonNode>({
    id: BUTTON,
    kind: 'button',
    label: 'Add one',
    actionId: INCREMENT,
    presentation: { uxRole: 'primary-action', icon: 'add' },
  });
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', name: 'Counter', children: [DISPLAY, BUTTON] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });

  return graph;
}

export function runMinimalExample(): number {
  const graph = createMinimalGraph();

  const validation = validateGraph(graph);
  if (!validation.valid) {
    throw new Error(
      validation.errors.map((problem) => `[${problem.code}] ${problem.message}`).join('\n'),
    );
  }

  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    app.invokeAction(INCREMENT);
  }

  // Three succeeded; the fourth broke the invariant and was rolled back entirely.
  return app.getState(COUNT) as number;
}
```
<!-- readme-example:end -->

## Documentation map

| Need to understand | Read |
| --- | --- |
| Compressed reference for authoring or modifying an app | [`docs/AGENT_REFERENCE.md`](docs/AGENT_REFERENCE.md) |
| Exact runtime guarantees, stated formally | [`docs/SEMANTIC_CONTRACT.md`](docs/SEMANTIC_CONTRACT.md) |
| Graph, ids, types, entity value representation | [`docs/GRAPH_MODEL.md`](docs/GRAPH_MODEL.md) |
| Every expression kind, builtin and scope rule | [`docs/EXPRESSIONS.md`](docs/EXPRESSIONS.md) |
| Addressing writable positions | [`docs/LOCATIONS.md`](docs/LOCATIONS.md) |
| Stored, derived, draft and ephemeral state | [`docs/STATE.md`](docs/STATE.md) |
| Actions, operations, transactions, iteration | [`docs/ACTIONS_TRANSACTIONS.md`](docs/ACTIONS_TRANSACTIONS.md) |
| Constraints and transition constraints | [`docs/CONSTRAINTS.md`](docs/CONSTRAINTS.md) |
| Semantic UI nodes and bindings | [`docs/UI.md`](docs/UI.md) |
| Presentation, UX intent, themes, formatting | [`docs/PRESENTATION.md`](docs/PRESENTATION.md) |
| Server authority, persistence, the trust boundary | [`docs/AUTHORITY.md`](docs/AUTHORITY.md) |
| Runtime API and diagnostic codes | [`docs/RUNTIME.md`](docs/RUNTIME.md) |
| Machine queries and graph transformations | [`docs/AGENT_API.md`](docs/AGENT_API.md) |
| Validation codes and what rejects a graph | [`docs/VALIDATION.md`](docs/VALIDATION.md) |
| Mistakes that compile but are wrong | [`docs/ANTI_PATTERNS.md`](docs/ANTI_PATTERNS.md) |

## Packages

`@cynodia/axiom` re-exports all four; installing it is normally enough.

| Package | Responsibility |
| --- | --- |
| `@cynodia/axiom-core` | Graph, semantic types, expressions, locations, presentation, themes, validation. |
| `@cynodia/axiom-compiler` | Validation, normalization into `ApplicationIR`, theme stylesheet, page emission. |
| `@cynodia/axiom-runtime` | State store, evaluation, mutation engine, constraint checking, renderer, routing. |
| `@cynodia/axiom-agent-api` | Semantic and presentation queries, mutation impact, transactional transformations. |
| `@cynodia/axiom-server` | The authoritative runtime: Server IR execution, persistence, protocol and transports. Installed separately, since it imports `node:http` and `node:sqlite`. |

## Working in this repository

Requires Node 22 or newer.

```bash
npm install
npm run build      # compiles every package and writes the three demo applications
npm test           # unit, validation, runtime, presentation, agent, architecture, documentation

node packages/cli/dist/index.js inspect  packages/demo/dist/order-system.js --export=createOrderSystemGraph
node packages/cli/dist/index.js validate packages/demo/dist/order-system.js --export=createOrderSystemGraph
node packages/cli/dist/index.js serve    packages/demo/dist/order-system.js --export=createOrderSystemGraph
```

Four unrelated applications are built from graphs alone in `packages/demo` and run on the
same compiler and runtime with no application-specific framework code. The order system is
the acceptance fixture for the 0.4 collection semantics and the 0.5 presentation layer; the
order desk is the 0.6 fixture, with stock and orders owned by an authority.

```bash
# The client page and the authority, from one graph, with durable state.
node packages/cli/dist/index.js serve packages/demo/dist/order-server.js \
  --export=createOrderServerGraph --port=3000 --store=desk.db
```

Specifications, in order: `doc/spec.md`, `doc/spec2.md`, `doc/spec3.md`, `doc/spec4.md`,
`doc/spec4.1.md`, `doc/spec5.md`, `doc/spec5.1.md`. `CLAUDE.md` orients work in the
codebase. **The implementation is authoritative over the specifications for existing
behavior**; where they disagree, the documentation above describes the implementation.

## Releasing

```bash
npm run release:prepare        # build, test, pack, verify, external consumer test
npm run release:publish:dry-run
npm run release:publish        # publishes as "latest" — one operation per package
```

`npm publish` accepts a single `--tag`, so every additional tag costs another registry call.
This project has no stable line yet: a separate `alpha` tag would only ever point where
`latest` already points, so publishing sets `latest` directly and nothing follows it. The
pre-release signal is the version string and the status line above.

Pass `--tag=<name>` for a release that should not become the default install.
`npm run release:dist-tag` remains for moving a tag by hand.

## License

MIT. Copyright (c) 2026 AskTech AS.
