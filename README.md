# Axiom

AI-native semantic application framework.

Axiom represents application behavior, state, UI structure, presentation and **authority** as
structured semantic data executed by generic runtimes. An application is a typed graph, not
source files: the JavaScript and HTML that reach a browser are output, and are never edited.

One graph produces the whole application. A `StateDef` declares who owns its value, and both
halves follow from that — the browser page and the authoritative server that decides its
mutations and persists them. Neither is written by hand: there is no route, controller,
handler, SQL statement or line of client JavaScript in an Axiom application.

**Status: experimental / alpha.** The API may change between alpha releases. This
documentation describes 0.9.0-alpha.1.

## Who this is for

> **The primary developer of an Axiom application is an AI coding agent.** Humans are a
> secondary audience, and human readability is explicitly **not** the primary optimization
> target.

Vue, React, Angular and Svelte assume a human is the principal author, and their abstractions
follow from that: readable source files, familiar syntax, manual navigation, line-oriented
debugging, textual diffs, conventions that lower human cognitive load. Those are the right
properties when a human writes the software. Axiom asks what a framework looks like when that
assumption is dropped, and optimizes instead for machine manipulation, semantic precision,
deterministic transformation, automatic verification, introspection and safe autonomous
modification.

The concrete difference is that **human-oriented source code is not a mandatory intermediate
representation**:

```text
conventional          AI-assisted                    Axiom
──────────────        ──────────────                 ──────────────
human intent          human intent                   human intent
     ↓                     ↓                              ↓
source code           agent                          agent
     ↓                     ↓                              ↓
framework             human-oriented source code     ApplicationGraph
     ↓                     ↓                              ↓
application           framework                      Axiom compiler + runtime
                           ↓                              ↓
                      application                    application
```

What that means for an agent working here:

- **Do not read, edit or reason about the generated output.** The emitted JavaScript, HTML and CSS are build products, like object files. Nothing is authored there and nothing should be patched there.
- **Modify the graph, not text.** Change a node, not a line. `AgentAPI` answers questions about semantics, reports the impact of a mutation, and applies transformations transactionally — see [`docs/AGENT_API.md`](docs/AGENT_API.md).
- **The failure modes are structural, not stylistic.** A wrong graph is rejected by `validateGraph` with a code and a path; there is no linter, no formatter and no house style to infer.
- **The documentation is part of the semantic contract and is written for you.** `docs/` is rule-oriented and machine-facing — invariants, truth tables, diagnostic codes, MUST and MUST NOT — not a tutorial set. It is tested against the implementation in both directions, so a documented code, symbol or method that no longer exists fails the build.

One honest caveat: a graph is JSON and round-trips losslessly, but applications in this
repository are still **authored as TypeScript builder functions** calling `addNode`. That is a
concession to human authoring and a known limit, not the intended end state — there is no
on-disk graph format and no semantic version control yet.

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
| UI nodes | Semantic interaction structure (view, container, text, repeat, field-display, form, input, button, conditional, diagnostic, dialog). |
| `Presentation` | Semantic UX and presentation intent. Roles and tokens, never CSS. |
| `Theme` | Translation of semantic presentation into visual design. |
| Renderer | Platform-specific materialization. Not part of the graph. |
| `StateDef.authority` | Who may commit a value: the client, or the server. The one declaration the split follows from. |
| `ServerIR` | The half an authority executes. Portable JSON, frozen as `axiom.server.v1`. |
| Semantic protocol | What a client may ask for: named actions with arguments, never mutation programs. |
| `PersistenceAdapter` | Where a decided value survives. Not part of the semantics. |
| `PRINCIPAL` | The caller, bound wherever an authority evaluates. Never sent by the client. |

```text
                            ApplicationGraph
                                   │
              ┌────────────────────┴────────────────────┐
         compileToIR                            compileToServerIR
              │                                          │
     client runtime ──── semantic protocol ────▶     authority
              │                                          │
     theme → renderer → page                    PersistenceAdapter
```

Authority is **derived, never declared twice**: an action that writes server-owned state is a
server action, so where code runs cannot disagree with what it does. The client is given the
types and the values it may see, and none of the rules it is not trusted with — those are
evaluated again where the state lives. Full model:
[`docs/AUTHORITY.md`](docs/AUTHORITY.md).

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
22. **A remote client is given its gateway before it starts.** A generated page wires its own; a hand-built runtime must pass `remote` to `createAxiomRuntime`, not add one afterwards.
23. **`start()` renders first, then synchronizes.** Awaiting it means authoritative state has been applied; an unreachable authority is a diagnostic, not an exception, and `authoritativeStateLoaded()` says which happened.
24. **A declared submit button invokes its action with its own arguments**, whether clicked or submitted through the form.
25. **`InvokeResponse.changes` names every observable state whose value moved, and no others.** Not what was written, not what was recomputed — what changed.
26. **`axiom.server.v1` is frozen and language-independent.** Its semantics are defined by [`docs/AUTHORITY.md`](docs/AUTHORITY.md#server-ir-v1-is-frozen), the published JSON Schemas and the conformance fixtures — not by this implementation.
27. **External systems are reached through typed integration operations**, never through `NativeOperation` or a request embedded in the graph. Full model: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).
28. **An external query is explicit execution, resolved before the transaction it feeds opens** — never a pure `Expression`. A query never runs mid-transaction.
29. **External effects are not rollback-capable state mutations.** Reaching `integration-effect` only records intent; the adapter runs only after the transaction commits. Full model: [`docs/EFFECTS.md`](docs/EFFECTS.md).
30. **Effect intent is committed atomically with the state write that requested it**, before external execution — the outbox invariant. A crash between the two does not lose it, for the two shipped `PersistenceAdapter`s.
31. **A trigger invokes an ordinary action**, under exactly the guards, constraints, transition constraints and authorization any other caller is subject to — never a weaker path. Full model: [`docs/TRIGGERS.md`](docs/TRIGGERS.md).
32. **A triggered or event-originated action runs under a system context, never an impersonated user.** `principal: null`, exactly like an anonymous client request; authorization still evaluates.
33. **An event is a typed fact, validated before any action sees it; an action is where work happens.** Full model: [`docs/EVENTS.md`](docs/EVENTS.md).
34. **The external world reaches Axiom through a `SubscriptionDef`, never a callback.** A delivery becomes an `EventDef` payload and enters the same `EventDef → TriggerDef → ActionDef` pipeline everything else does. Full model: [`docs/SUBSCRIPTIONS.md`](docs/SUBSCRIPTIONS.md).
35. **Subscription delivery is at-least-once, per-subscription ordered, and never silently lossy.** The queue is always bounded, and a policy that may discard an event says so in the graph. Two subscriptions have no ordering relationship at all.
36. **OS I/O primitives are not graph vocabulary.** No path, socket, stream, file descriptor or subprocess. They live inside an adapter, where a Node runtime and a future Rust one may implement the same graph with entirely different primitives. Full model: [`docs/ANTI_PATTERNS.md`](docs/ANTI_PATTERNS.md).
37. **Binary data is a `BlobRef` in state and bytes out of band.** Upload and download are one host transport for every application; possession of a key is never permission. Full model: [`docs/STORAGE.md`](docs/STORAGE.md).
38. **Authoritative data too large to materialize is a `QueryDef`, not a `StateDef`.** The graph names the source, filter, sort, projection, relationships, aggregation, pagination and read policy; a `DataProvider` decides SQL, indexes and execution plan. The client invokes a query by id and never a query language. Full model: [`docs/QUERIES.md`](docs/QUERIES.md).
39. **A read policy is declared once and enforced on the authority.** Its predicate is AND-ed into every query's effective filter before the provider runs, so it scopes rows, aggregates and relationship traversals uniformly — and a client argument can never remove it.

## Installation

```bash
npm install @cynodia/axiom            # the graph, compiler, runtime and agent API
npm install @cynodia/axiom-ui         # semantic UI authoring patterns (build time only)
npm install @cynodia/axiom-server     # only if the application has an authority
```

The server package is separate rather than re-exported, because it imports `node:http` and
`node:sqlite` and a browser bundle must not.

`@cynodia/axiom-ui` is separate for a different reason: it is an **authoring** dependency that
disappears after expansion. Re-exporting it from the facade would make every application carry
it forever, and would make "this application no longer needs the toolkit" — the property
[materialization](packages/ui-toolkit/docs/OWNERSHIP.md) exists to give you — impossible to
state or to test.

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

## Making it server-authoritative

The same model, with the state moved across the trust boundary. One word — `authority:
'server'` — decides that the client may read the seats but never write them, that claiming one
is an action the authority executes, and that its guard and its authorization rule never reach
the browser. This example runs, over real HTTP, in this repository's test suite.

<!-- readme-server-example:start -->
```ts
import {
  ApplicationGraph,
  PRINCIPAL,
  binary,
  collectionType,
  compileToHtml,
  compileToIR,
  compileToServerIR,
  createAxiomRuntime,
  createHttpRemoteGateway,
  createMemoryHost,
  entityType,
  field,
  fieldId,
  find,
  fieldLocation,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  object,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom';
import type { ActionDef, ConstraintDef, EntityDef, RouteDef, StateDef, ViewNode } from '@cynodia/axiom';
import { createMemoryPersistence, serveAxiomApplication } from '@cynodia/axiom-server';

const USER = nodeId('entity_user');
const F_USER_ID = fieldId('field_user_id');
const F_USER_ROLE = fieldId('field_user_role');
const SEAT = nodeId('entity_seat');
const F_SEAT_ID = fieldId('field_seat_id');
const F_SEAT_TAKEN_BY = fieldId('field_seat_taken_by');

const SEATS = nodeId('state_seats');
const CLAIM = nodeId('action_claim');
const P_SEAT = nodeId('param_seat');
const ONE_EACH = nodeId('constraint_one_each');
const SCOPE_SEAT = nodeId('scope_seat');
const VIEW = nodeId('ui_view');
const ROUTE = nodeId('route_root');

export function createSeatingGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('seating', 'Seating');

  // Whose fields an authorization rule reads through PRINCIPAL.
  graph.setPrincipalEntity(USER);
  graph.addNode<EntityDef>({
    id: USER,
    kind: 'entity',
    identityFieldId: F_USER_ID,
    fields: [
      { id: F_USER_ID, valueType: primitiveType('string'), required: true },
      { id: F_USER_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: SEAT,
    kind: 'entity',
    identityFieldId: F_SEAT_ID,
    fields: [
      { id: F_SEAT_ID, valueType: primitiveType('string'), required: true },
      { id: F_SEAT_TAKEN_BY, valueType: primitiveType('string') },
    ],
  });

  // One word makes this application full-stack. Everything else follows from it: the client
  // is given the type and the value but no way to write it, and the action that writes it
  // becomes an action the authority executes.
  graph.addNode<StateDef>({
    id: SEATS,
    kind: 'state',
    name: 'seats',
    authority: 'server',
    valueType: collectionType(entityType(SEAT)),
    initialValue: [{ [F_SEAT_ID]: 'a1' }, { [F_SEAT_ID]: 'a2' }],
  });

  const seat = (id: typeof P_SEAT) =>
    find(ref(SEATS), SCOPE_SEAT, binary('eq', field(ref(SCOPE_SEAT), F_SEAT_ID), ref(id)));

  graph.addNode<ActionDef>({
    id: CLAIM,
    kind: 'action',
    name: 'claim',
    // Checked on the authority, before any guard and before any transaction opens. A client
    // never learns the rule and cannot satisfy it by claiming to.
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('member')),
    parameters: [{ id: P_SEAT, valueType: primitiveType('string'), required: true }],
    guards: [
      {
        condition: binary('eq', field(seat(P_SEAT), F_SEAT_TAKEN_BY), literal(null)),
        failureMode: { code: 'seat-taken', message: 'That seat is already taken.' },
      },
    ],
    operations: [
      {
        kind: 'set',
        // The caller is bound on the authority, so the record says who claimed the seat
        // without the client ever being asked to state an identity.
        target: fieldLocation(
          itemLocation(stateLocation(SEATS), identitySelector(F_SEAT_ID, ref(P_SEAT))),
          F_SEAT_TAKEN_BY,
        ),
        value: field(ref(PRINCIPAL), F_USER_ID),
      },
    ],
  });

  // An invariant the authority evaluates over proposed state, per seat.
  graph.addNode<ConstraintDef>({
    id: ONE_EACH,
    kind: 'constraint',
    name: 'A seat identifies itself',
    entityId: SEAT,
    message: 'A seat must have an identifier.',
    expression: binary('neq', field(ref(SEAT), F_SEAT_ID), literal('')),
  });

  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', name: 'Seating', children: [] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });

  return graph;
}

export async function runSeatingExample(): Promise<string[]> {
  const graph = createSeatingGraph();
  const validation = validateGraph(graph);
  if (!validation.valid) {
    throw new Error(validation.errors.map((problem) => `[${problem.code}] ${problem.message}`).join('\n'));
  }

  // One graph, one process: the generated page at GET /, the semantic endpoint at POST
  // /axiom. No route, controller, handler or SQL is written by an application author.
  const running = await serveAxiomApplication({
    serverIR: compileToServerIR(graph),
    page: compileToHtml(graph),
    persistence: createMemoryPersistence(),
    authenticate: (credential) =>
      credential === 'ada' ? { [F_USER_ID]: 'ada', [F_USER_ROLE]: 'member' } : null,
    port: 0,
  });

  try {
    // A browser would use the generated page, which wires this gateway for itself. Building
    // the client by hand shows what the page does.
    const host = createMemoryHost({ path: '/' });
    const client = createAxiomRuntime({
      ir: compileToIR(graph),
      rootElement: host.root,
      host,
      remote: createHttpRemoteGateway({ endpoint: running.url, credential: () => 'ada' }),
    });
    await client.start();

    await client.invokeActionAsync(CLAIM, { [P_SEAT]: 'a1' });
    // The guard is evaluated where the state lives, so a second claim is refused there.
    await client.invokeActionAsync(CLAIM, { [P_SEAT]: 'a1' });

    const seats = client.getState(SEATS) as Record<string, string>[];
    return seats.map((entry) => `${entry[F_SEAT_ID]}: ${entry[F_SEAT_TAKEN_BY] ?? 'free'}`);
  } finally {
    await running.close();
  }
}
```
<!-- readme-server-example:end -->

Nothing in that file is transport code. `serveAxiomApplication` serves the generated page at
`GET /` and the semantic endpoint at `POST /axiom`, which are the same two for every Axiom
application; `compileToHtml` wires the browser gateway into the page, so a deployed
application needs no client JavaScript of its own.

What the authority — and only the authority — did:

| | |
| --- | --- |
| Evaluated the authorization rule | the client IR does not contain it |
| Evaluated the guard | the second claim was refused where the state actually lives |
| Bound `PRINCIPAL` | the seat records who took it; the client never sent an identity |
| Committed the transaction | atomically, against a `PersistenceAdapter` |
| Returned `changes` | every observable state whose value moved, and no others |

`packages/demo/src/order-server.ts` is the full fixture: drafts, `for-each`, transition
constraints, `serverOnly` state, diagnostics as UI and a parameterized form.

## Documentation map

Written for an unfamiliar coding agent rather than a human learner: one canonical location per
rule, MUST/MUST NOT, tables for edge cases, no tutorial padding. `docs/AGENT_REFERENCE.md`
plus the `.d.ts` declarations are meant to be sufficient on their own, and both ship inside
the published package — no repository access is needed to obtain the contract.

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
| Semantic UI nodes, interaction primitives and bindings | [`docs/UI.md`](docs/UI.md) |
| Authoring UI from patterns rather than nodes | [`docs/UI.md#semantic-ui-authoring`](docs/UI.md#semantic-ui-authoring) then [`@cynodia/axiom-ui`](packages/ui-toolkit/README.md) |
| Presentation, UX intent, themes, formatting | [`docs/PRESENTATION.md`](docs/PRESENTATION.md) |
| **Authority, the trust boundary, the protocol, persistence, deploying** | [**`docs/AUTHORITY.md`**](docs/AUTHORITY.md) |
| **Implementing a conforming runtime in another language** | [`docs/AUTHORITY.md`](docs/AUTHORITY.md#server-ir-v1-is-frozen) + the shipped schemas and fixtures |
| External systems: integration operations, adapters, secrets | [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) |
| External effects: the outbox, retries, delivery guarantees | [`docs/EFFECTS.md`](docs/EFFECTS.md) |
| Timed and lifecycle execution, event-invoked actions | [`docs/TRIGGERS.md`](docs/TRIGGERS.md) |
| Typed facts, webhooks, event dispatch | [`docs/EVENTS.md`](docs/EVENTS.md) |
| **Live external event streams: lifecycle, delivery, backpressure** | [`docs/SUBSCRIPTIONS.md`](docs/SUBSCRIPTIONS.md) |
| **Binary data: BlobRef, upload, download, authorization, orphans** | [`docs/STORAGE.md`](docs/STORAGE.md) |
| Runtime API, startup lifecycle and diagnostic codes | [`docs/RUNTIME.md`](docs/RUNTIME.md) |
| Machine queries and graph transformations | [`docs/AGENT_API.md`](docs/AGENT_API.md) |
| Validation codes and what rejects a graph | [`docs/VALIDATION.md`](docs/VALIDATION.md) |
| Mistakes that compile but are wrong | [`docs/ANTI_PATTERNS.md`](docs/ANTI_PATTERNS.md) |

## Packages

`@cynodia/axiom` re-exports the four browser-safe packages; installing it is normally enough.
An application with an authority installs `@cynodia/axiom-server` alongside it, and one whose
UI is authored from patterns installs `@cynodia/axiom-ui` as a build-time dependency.

| Package | Responsibility |
| --- | --- |
| `@cynodia/axiom-core` | Graph, semantic types, expressions, locations, presentation, themes, validation. |
| `@cynodia/axiom-compiler` | Validation, normalization into `ApplicationIR`, theme stylesheet, page emission. |
| `@cynodia/axiom-runtime` | State store, evaluation, mutation engine, constraint checking, renderer, routing. |
| `@cynodia/axiom-agent-api` | Semantic and presentation queries, mutation impact, transactional transformations. |
| `@cynodia/axiom-ui` | Semantic UI authoring: five patterns that expand into canonical UI nodes at build time, with provenance, ownership and drift tooling. Installed separately, and needed only while authoring. Ships the machine-readable [pattern catalogue](packages/ui-toolkit/docs/PATTERN_CATALOG.json). |
| `@cynodia/axiom-server` | The authoritative runtime: Server IR execution, persistence, the semantic protocol, transports, and the reference full-stack host. Installed separately, since it imports `node:http` and `node:sqlite`. Also ships the portable [conformance fixtures](docs/AUTHORITY.md#conformance) and the [JSON Schemas](docs/AUTHORITY.md#machine-readable-contracts) for `axiom.server.v1`. |

## Working in this repository

Requires Node 22 or newer.

```bash
npm install
npm run build      # compiles every package and writes the three demo applications
npm test           # unit, validation, runtime, presentation, agent, architecture, documentation

# packages/cli is a private development tool of this repository. It is not published, and
# nothing outside this checkout should depend on it.
node packages/cli/dist/index.js inspect  packages/demo/dist/order-system.js --export=createOrderSystemGraph
node packages/cli/dist/index.js validate packages/demo/dist/order-system.js --export=createOrderSystemGraph
node packages/cli/dist/index.js serve    packages/demo/dist/order-system.js --export=createOrderSystemGraph
```

Four unrelated applications are built from graphs alone in `packages/demo` and run on the
same compiler and runtime with no application-specific framework code. The order system is
the acceptance fixture for the 0.4 collection semantics and the 0.5 presentation layer; the
order desk is the 0.6 fixture, with stock and orders owned by an authority, and is driven end
to end through the generated page in `packages/demo/test/generated-page.test.ts`.

There is no published Axiom CLI: `packages/cli` is a private development tool of this
repository, and `serveAxiomApplication` is the supported way to run an application.

Specifications live in `specs/`, in order: `spec.md`, `spec2.md`, `spec3.md`, `spec4.md`,
`spec4.1.md`, `spec5.md`, `spec5.1.md`, `spec5.2.md`, `spec6.md`, `spec6.1.md`. `CLAUDE.md`
orients work in the codebase. **The implementation is authoritative over the specifications for existing
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
`npm run release:dist-tag` remains for moving a tag by hand, and
`npm run release:dist-tag -- --tag=<name> --rm` removes one that no longer means anything.

## License

MIT. Copyright (c) 2026 AskTech AS.
