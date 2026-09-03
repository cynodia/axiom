# Axiom

AI-native semantic application framework. An application is a typed semantic graph, not
source files.

## AI agents: read this first

**Read [`docs/AGENT_REFERENCE.md`](docs/AGENT_REFERENCE.md) before writing any Axiom code.**
It ships inside this package, so no repository access, web search or framework source
inspection is needed to obtain the contract.

| | |
| --- | --- |
| **What** | A semantic application framework. State, behavior, constraints, UI structure, presentation and authority are structured data executed by generic runtimes. |
| **Who for** | AI-authored applications. The primary author of an Axiom application is a coding agent; human readability is explicitly not the optimization target. |
| **Start** | [`docs/AGENT_REFERENCE.md`](docs/AGENT_REFERENCE.md) — the compressed operational contract for application authors. |
| **API contract** | The published `.d.ts` declarations in `dist/`. Authoritative for signatures, unions and branded types. |
| **Deeper semantics** | The focused documents in `docs/` — [map below](#documentation-map). |
| **Escalation** | `docs/AGENT_REFERENCE.md` → `.d.ts` → the focused `docs/` document for the topic → a minimal public-API probe. |

Axiom's vocabulary is deliberately unlike React, Vue, Angular, Svelte or Express: there is no
component, no hook, no JSX, no route handler, no ORM and no callback anywhere in the graph.
Guessing the API from those conventions produces graphs `validateGraph` rejects, so reading
the reference first is cheaper than any number of attempts.

**Reading the framework's implementation source should not be necessary to author an
application.** `docs/` plus the `.d.ts` declarations are intended to be sufficient on their
own. Source inspection is a legitimate tool for debugging Axiom itself; it is not the way to
discover normal consumer usage, and cloning the repository for that purpose is a sign the
documentation above was missed.

Shorter forms of the same routing: [`AGENTS.md`](AGENTS.md) and [`llms.txt`](llms.txt), both
at this package's root.

**Status: experimental / alpha.** The API may change between alpha releases. The
documentation in `docs/` describes this exact version, `0.15.0-alpha.2`.

## Installation

```bash
npm install @cynodia/axiom            # the graph, compiler, runtime and agent API
npm install @cynodia/axiom-ui         # semantic UI authoring patterns (build time only)
npm install @cynodia/axiom-server     # only if the application has an authority
```

Every release of this project is a pre-release and npm's `latest` tag points at it, so the
plain command above installs the current version. **There is no `alpha` dist-tag** — the tag
was removed once it stopped tracking releases, and `npm install @cynodia/axiom@alpha` now
fails with a 404. Pin the exact version instead when one is needed:
`npm install @cynodia/axiom@0.15.0-alpha.2`.

These are ES modules compiled to ES2022; import them with `import`, not `require`. There is
no published Axiom CLI. `@cynodia/axiom-server`'s SQLite persistence adapter additionally
needs a Node build that provides `node:sqlite` (Node 22 or newer); `isSqliteAvailable()`
reports its absence rather than failing at import.

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
| UI nodes | Semantic interaction structure (view, container, text, repeat, field-display, form, input, button, conditional, diagnostic, dialog). |
| `Presentation` | Semantic UX intent. Roles and tokens, never CSS. |
| `Theme` | Translation of presentation intent into visual design. |
| Renderer | Platform-specific materialization. Not part of the graph. |
| `StateDef.authority` | Who may commit a value: the client, or the server. The one declaration the split follows from. |
| `ServerIR` | The half an authority executes. Portable JSON. `axiom.server.v1` is frozen; the current contract is `axiom.server.v7`, computed from the document's vocabulary. |
| Semantic protocol | What a client may ask for: named actions with arguments, never mutation programs. |
| `PersistenceAdapter` | Where a decided value survives. Not part of the semantics. |

```text
ApplicationGraph → validateGraph → compileToIR      → runtime (+ theme → renderer) → page
                                 → compileToServerIR → authority (+ persistence)
```

Authority is **derived, never declared twice**: an action that writes server-owned state is a
server action, so where code runs cannot disagree with what it does. Full model:
`docs/AUTHORITY.md`.

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
14. **A client cannot commit server-authoritative state**, by any path. An action that writes it executes on the authority.
15. **The client is untrusted.** Guards, authorization and argument types are checked again on the authority.
16. **A client requests semantic actions, never mutation programs.** The protocol carries no way to send operations.
17. **`axiom.server.v1` is frozen and language-independent.** Its semantics are defined by `docs/AUTHORITY.md`, the published JSON Schemas and the conformance fixtures — not by this implementation.

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

## Documentation map

The complete operational contract ships with this package, in `docs/`. Every path below
resolves inside the installed package. Read `docs/AGENT_REFERENCE.md` first; reach for a
focused document when the reference is not specific enough for the question at hand.

| Need to understand | Read |
| --- | --- |
| **Compressed contract for authoring or modifying an app — start here** | [`docs/AGENT_REFERENCE.md`](docs/AGENT_REFERENCE.md) |
| Exact runtime guarantees, stated formally | [`docs/SEMANTIC_CONTRACT.md`](docs/SEMANTIC_CONTRACT.md) |
| Mistakes that compile but are wrong | [`docs/ANTI_PATTERNS.md`](docs/ANTI_PATTERNS.md) |
| Graph, node kinds, ids, types, entity value representation | [`docs/GRAPH_MODEL.md`](docs/GRAPH_MODEL.md) |
| Every expression kind, builtin, scope, presence and null rule | [`docs/EXPRESSIONS.md`](docs/EXPRESSIONS.md) |
| Addressing writable positions | [`docs/LOCATIONS.md`](docs/LOCATIONS.md) |
| Stored, derived, draft and ephemeral state | [`docs/STATE.md`](docs/STATE.md) |
| Actions, operations, guards, transactions, iteration | [`docs/ACTIONS_TRANSACTIONS.md`](docs/ACTIONS_TRANSACTIONS.md) |
| Constraints and transition constraints | [`docs/CONSTRAINTS.md`](docs/CONSTRAINTS.md) |
| Semantic UI nodes, interaction primitives and bindings | [`docs/UI.md`](docs/UI.md) |
| Presentation, UX intent, themes, value formatting | [`docs/PRESENTATION.md`](docs/PRESENTATION.md) |
| Runtime API, startup lifecycle and diagnostic codes | [`docs/RUNTIME.md`](docs/RUNTIME.md) |
| Validation codes and what rejects a graph | [`docs/VALIDATION.md`](docs/VALIDATION.md) |
| Server authority, the trust boundary, Server IR, the protocol, persistence, deployment | [`docs/AUTHORITY.md`](docs/AUTHORITY.md) |
| External systems: integration definitions, query operations, adapters, secrets | [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) |
| External effects: the outbox, retries, delivery guarantees, outcomes | [`docs/EFFECTS.md`](docs/EFFECTS.md) |
| Typed events, webhooks, the dispatch pipeline | [`docs/EVENTS.md`](docs/EVENTS.md) |
| Timed and lifecycle execution, event-invoked actions | [`docs/TRIGGERS.md`](docs/TRIGGERS.md) |
| Live inbound streams: lifecycle, delivery, deduplication, backpressure | [`docs/SUBSCRIPTIONS.md`](docs/SUBSCRIPTIONS.md) |
| Binary data: `BlobRef`, upload, download, authorization, orphans | [`docs/STORAGE.md`](docs/STORAGE.md) |
| Large authoritative datasets: `QueryDef`, relationships, read policy, providers, cursors, cache | [`docs/QUERIES.md`](docs/QUERIES.md) |
| Evolving a deployed schema: `MigrationDef`, fingerprint, the startup gate, `executeMigration`, providers | [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md) |
| Running N authority processes at once: ownership, leases, fencing, delivery guarantees, version skew | [`docs/DISTRIBUTED_AUTHORITY.md`](docs/DISTRIBUTED_AUTHORITY.md) |
| Observing a `QueryDef` result over time: live deltas, reconnect, cursor, backpressure, transport | [`docs/LIVE_QUERIES.md`](docs/LIVE_QUERIES.md) |
| Durable workflows: steps, bindings, event waits, timers, retries, cancellation, crash recovery | [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) |
| May this principal perform this operation: `AuthorizationPolicyDef`, closed scope, ALLOW/DENY, fail closed | [`docs/AUTHORIZATION.md`](docs/AUTHORIZATION.md) |
| Machine queries, mutation impact and graph transformations | [`docs/AGENT_API.md`](docs/AGENT_API.md) |

`docs/AGENT_REFERENCE.md` plus the `.d.ts` declarations are intended to be sufficient on
their own. If they are not, that is a documentation defect worth reporting rather than a
reason to read framework source.

## What is in the box

This package re-exports four, which can also be installed individually:

| Package | Responsibility |
| --- | --- |
| `@cynodia/axiom-core` | Graph, semantic types, expressions, locations, presentation, themes, validation. |
| `@cynodia/axiom-compiler` | Normalization into an IR, theme stylesheet, page emission. |
| `@cynodia/axiom-runtime` | State store, evaluation, mutation engine, constraint checking, renderer, routing. |
| `@cynodia/axiom-agent-api` | Semantic and presentation queries, mutation impact, transactional transformations. |

Two published packages are deliberately **not** re-exported, and are installed separately:

| Package | Why it stands apart |
| --- | --- |
| `@cynodia/axiom-server` | The authoritative runtime: Server IR execution, persistence adapters, the semantic protocol and the Node host. It imports `node:http` and `node:sqlite`, and a browser bundle must not. |
| `@cynodia/axiom-ui` | Semantic UI authoring patterns, expanded into ordinary graph nodes at **build time**. Re-exporting it would make every application carry an authoring dependency forever, and would make "this application no longer needs the toolkit" impossible to state or to test. |

## License

MIT

Copyright (c) 2026 AskTech AS.
