# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

Axiom is a research prototype of an **AI-native web application framework**. The
hypothesis is that an application should be stored as a **typed semantic graph**, not as
human-oriented source files: agents modify the graph, and a generic compiler and runtime
turn it into a working browser application whose generated JavaScript nobody reads.

* `doc/spec.md` — the 0.1 vision, research goals and metrics.
* `doc/spec2.md` — the **0.2 architecture specification, which this codebase implements**.
  It is the authority on design decisions. §2 (invariants), §39–§41 (the domain
  independence tests), §44 (definition of done) and §49 (the architectural warning)
  settle most arguments.

The governing rule, from spec2 §2.4:

> `core`, `compiler`, `runtime` and `agent-api` must contain no knowledge of any
> application domain. A new application is a new graph, never a framework change.

`packages/core/test/architecture.test.ts` enforces this by scanning framework sources for
application vocabulary. It is a real test, not a guideline — check it before naming things.

## Commands

Requires **Node ≥ 22** — `npm test` relies on the test runner's native glob expansion of
`dist/test/**/*.test.js`, which Node 20 and earlier do not support.

```bash
npm install
npm run build               # tsc -b across all workspaces; also writes both demo pages
npm test                    # runs node:test over COMPILED output — build first, always

# CLI (after a build) — takes a compiled module that exports a graph or a builder
node packages/cli/dist/index.js inspect  packages/demo/dist/inventory.js --export=createInventoryGraph
node packages/cli/dist/index.js validate packages/demo/dist/issue-tracker.js --export=createIssueTrackerGraph
node packages/cli/dist/index.js build    packages/demo/dist/issue-tracker.js --export=createIssueTrackerGraph
node packages/cli/dist/index.js serve    packages/demo/dist/inventory.js --export=createInventoryGraph --port=3000
```

There is no linter, formatter, or CI. Match the style of the file you are editing.

## Layout

`packages/*`, npm workspaces + TypeScript project references. Dependencies are declared
twice and both must stay in sync: `file:../x` in `package.json`, and a `references` entry
in the package's `tsconfig.json`. Root `tsconfig.base.json` carries `paths` for `@axiom/*`
so editors and tests resolve to source.

| Package     | Owns |
| ----------- | ---- |
| `core`      | `ApplicationGraph`, node and field definitions, `TypeRef`, expressions, edge kinds, validation, edge derivation, the IR contract. No dependencies. |
| `agent-api` | Semantic queries, transactions, transformations, change sets. |
| `compiler`  | Validation + normalization into `ApplicationIR`, and page emission. |
| `runtime`   | State, expression evaluation, action execution, constraint checking, UI rendering, routing. |
| `cli`       | Graph loading, `inspect` / `validate` / `build` / `serve`. |
| `demo`      | Two applications: `issue-tracker.ts` and `inventory.ts`. |

Dependency direction is `core ← runtime ← compiler ← cli/demo`, with `agent-api` on
`core` alone. `ApplicationIR` lives in **core** rather than the compiler because it is the
contract *between* compiler and runtime; putting it in the compiler would create a cycle.

## The model

**Identity.** `NodeId`, `FieldId` and `EdgeId` are branded string types (`core/ids.ts`).
Build them with `nodeId()` / `fieldId()` / `edgeId()`, or generate with `createNodeId()`.
Fields are independently identifiable, and **instance data is keyed by `FieldId`** — a
record looks like `{ [F_ISSUE_TITLE]: 'text' }`, never `{ title: 'text' }`. Names are
metadata for humans; nothing resolves by name.

**Types are structures, not strings.** `TypeRef` is `primitive | entity | collection |
optional | enum` (`core/type-ref.ts`), with builders `primitiveType()`, `entityType()`,
`collectionType()`, `optionalType()`, `enumType()`.

**Expressions are trees, not text** (`core/expressions.ts`): `literal`, `ref`, `field`,
`object`, `binary`, `unary`, `call`, `filter`, `find`. A `ref` resolves an **id** against
the scope chain, in order: action parameters → iteration scopes → route parameters →
state. The iteration scope for a `repeat` is the repeat node's own id, and for
`filter`/`find` it is the expression's `scopeId`; that is why templates say
`ref(<repeat node id>)` rather than naming an alias.

**Nodes.** `entity`, `state`, `action`, `constraint`, `route`, plus the nine UI kinds
(`view`, `container`, `text`, `repeat`, `field-display`, `form`, `input`, `button`,
`conditional`). All of them live in the same graph and are discriminated by `kind`.

**Edges are derived, not hand written.** `synchronizeEdges(graph)` recomputes every
structural edge (`contains`, `reads`, `writes`, `binds`, `invokes`, `renders`,
`derives-from`, `constrains`, `routes-to`, `references`, `depends-on`) from the node
definitions and marks them `metadata.derived`. Call it after building or transforming a
graph; `Transaction.validate()` does it for you. Hand-added edges without that marker are
preserved.

**Graph reads are deep clones.** Mutating a node you fetched changes nothing — write it
back with `updateNode`. This applies to the authoring graph only; the runtime works on the
IR and deliberately keeps live references so `update-field` can mutate a stored record.

**Validation is not optional.** `validateGraph` resolves every reference — nodes, fields,
edges, expressions, UI children, route targets — and `compileToIR` throws
`GraphValidationError` rather than compiling an invalid graph. Warnings (unreachable UI,
missing identity field) do not block.

**Behaviour is data.** An `ActionDef` has parameters, preconditions, operations,
postconditions and failure modes. Operations are `set-state`, `add-item`, `remove-item`,
`update-field`, `invoke`, `navigate` and `native`. An action runs as a transaction: the
runtime snapshots state, applies operations, then checks schema conformance and
constraints, and **restores the snapshot if anything fails**.

**Three layers of correctness**, don't confuse them:
1. `validateGraph` — is the graph structurally sound? (authoring time)
2. Schema conformance — do instances satisfy `required` and their `TypeRef`? (runtime)
3. `ConstraintDef` — declared invariants, evaluated per instance of `entityId` with that
   instance bound to the entity's id. (runtime)

**Draft state.** `StateDef.draft: true` marks work in progress. Draft and derived states
are skipped by instance validation, otherwise a half-filled form would fail every
invariant and roll back every action.

## Conventions

- ESM throughout (`"type": "module"`, `module: NodeNext`). **Relative imports need the
  `.js` extension** (`./graph.js`), even from `.ts` files.
- `strict` is on; `declaration` and `composite` are on for project references.
- Tests are `node:test` + `node:assert/strict` under `packages/*/test/`, compiled by a
  separate `tsconfig.test.json` into `dist/test/`. A package with tests builds both
  configs (`tsc -b tsconfig.json tsconfig.test.json`) and declares a `test` script.
- Never write an application-domain word into a framework package — not in code, not in a
  comment, not in an example. `ValidationIssue` is the single allowed collision (spec2 §26
  names the type), and it is listed explicitly in the architecture test.

## Where the tests live, and why

Test placement follows the dependency direction, which is why some tests are not in the
package they exercise:

- `core` — graph semantics, validation failures, and the architecture leak scan.
- `runtime` — the memory host and the browser bundle shape (no IR needed).
- `compiler` — normalization and page emission, **plus the runtime behaviour tests**:
  `compileToIR` is the only IR producer, and the compiler is the lowest package that can
  see both it and the runtime.
- `agent-api` — queries, transactions, and edge maintenance.
- `demo` — both applications end to end, and the two acceptance scenarios from spec2 §45
  and §46. `acceptance.test.ts` is the canonical demonstration: an agent adds a field and
  its UI purely through graph operations, and the application supports it immediately.

`@axiom/runtime` exports `createMemoryHost()` and an in-memory DOM. That is deliberate
framework code, not test-only scaffolding: the runtime takes its whole environment through
a `HostEnvironment`, so it can be driven headlessly without a browser or jsdom.

## How the browser page is produced

`packages/runtime/src/runtime.ts` is ordinary, type-checked TypeScript that imports
nothing at run time (only `import type` from core). `createRuntimeModuleSource()` reads
its own compiled `dist/runtime.js` and strips the `export` keywords — that is the entire
"bundler". The compiler then inlines that source, the IR as JSON, and a three-line
bootstrap into one self-contained page.

Consequences worth knowing:
- **`runtime.ts` must never gain a runtime import.** A value import would break inlining.
  Keep the DOM surface in `dom.ts` as types only.
- The runtime is fully type-checked and tested, unlike the 0.1 string-template runtime.
- The renderer talks to a narrow structural DOM interface, so no DOM lib types are needed
  in `tsconfig`.

## Current limits

- **Rendering is full re-render.** Every state change rebuilds the view and restores focus
  and caret position by node id. Fine at demo scale; incremental update is unimplemented.
- **`update-field` mutates live objects** in the store rather than resolving a write path.
  It works because reads inside the runtime are not cloned, but it is the sharpest edge in
  the design.
- **Remote persistence is declared but not executed** (`StatePersistence.kind: 'remote'`
  validates and does nothing). `memory` and `local-storage` work.
- **No arithmetic beyond `add`/`subtract`/`multiply`/`divide`**, no aggregation over a
  projection (no `map`/`sum`), and no conditional expression. Applications that need a
  branch express it with two actions or a `conditional` UI node.
- **Change sets are in memory** and per `AgentAPI` instance. There is no semantic version
  control and no on-disk graph format — graphs are still TypeScript builder functions,
  which remains a concession to human authoring.
- **Styling is a small set of presentation hints** mapped to CSS classes. Spec2 §36 says
  that is deliberate.

When adding a capability, push it **down into the graph model and out of the framework**.
If a demo application seems to need a framework change, the change must be justifiable in
domain-neutral terms — that test is what `packages/demo/src/inventory.ts` exists to apply.
