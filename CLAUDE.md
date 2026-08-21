# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

Axiom is a research prototype of an **AI-native web application framework**. The
hypothesis is that an application should be stored as a **typed semantic graph**, not as
human-oriented source files: agents modify the graph, and a generic compiler and runtime
turn it into a working browser application whose generated JavaScript nobody reads.

* `doc/spec.md` — the 0.1 vision, research goals and metrics.
* `doc/spec2.md` — the 0.2 architecture: domain-independent compiler and runtime.
* `doc/spec3.md` — the 0.3 architecture: semantic mutation and addressing.
* `doc/spec4.md` — the 0.4 architecture: collection semantics and transactional iteration.
* `doc/spec4.1.md` — the **0.4.1 hardening release: mutation-path-independent rules,
  presence semantics, strict collection nulls and trustworthy dependency analysis**.
  Together with spec2–spec4 this is the authority on design decisions.

Two rules govern almost every decision:

> **Domain independence** (spec2 §2.4) — `core`, `compiler`, `runtime` and `agent-api`
> must contain no knowledge of any application domain. A new application is a new graph,
> never a framework change.

> **Addressed mutation** (spec3 §3) — no application state may be changed by mutating the
> JavaScript object some expression happened to return. Expressions produce values;
> **locations** name writable positions.

> **No silent semantic failure** (spec4 §4) — a construct that is publicly declared,
> typechecks and passes `validateGraph` must have defined runtime behaviour. If the
> runtime cannot execute something, validation has to reject it. A construct that
> validates and then quietly does nothing is a release-blocking defect.

> **Expressive power arrives as structure** (spec4 §41) — when Axiom gains capability, it
> gains an inspectable semantic node, never a callback. No `formatter: fn`, no
> `validator: fn`, no stored closures. The graph stays serializable and analyzable.

> **Rules bind the state, not the path** (spec4.1 §2) — if the graph says a business rule
> holds, every governed write path must be unable to violate it. Correctness may never
> depend on an author remembering "do not bind an input to that location".

Both are enforced by tests, not convention: `packages/core/test/architecture.test.ts`
scans framework sources for application vocabulary, and `packages/runtime/test/store.test.ts`
checks that state writes stay confined to the mutation subsystem.

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

`inspect` renders locations in readable form, which is the fastest way to see what an
action actually writes:

```
- receiveStock (action_receive_stock) [writes → products (On hand), reads → products (Id)]
    set products → [Id = id] → On hand
```

There is no linter, formatter, or CI. Match the style of the file you are editing.

## Packaging and release

Five packages are published to npm under the `@cynodia` scope; `cli` and `demo` are
marked `private` and never ship. Everything is MIT, copyright AskTech AS.

- **Compiled output only.** `files` whitelists `dist/**/*.js`, `dist/**/*.d.ts`, the
  README and the LICENSE. Tests compile to `dist-test/`, not `dist/`, so the publishable
  directory contains no test code by construction — don't move test output back under
  `dist/`. Declaration maps are generated but deliberately not shipped, since the sources
  they point at are not published.
- **No workspace protocol anywhere.** Inter-package dependencies are pinned to the exact
  release version (`"@cynodia/axiom-core": "0.3.1-alpha.1"`). npm still links them locally
  because the workspace version satisfies the range, so a published manifest and a local
  checkout resolve identically. `scripts/verify-packages.mjs` fails the release if a
  `file:`, `link:` or `workspace:` range ever reaches a tarball.
- **Every package keeps its own LICENSE and README** — npm does not inherit them from the
  repository root. The verifier checks the packed copies have not drifted.
- **Version bumps touch every manifest.** The publish script refuses to run if any is out
  of step with the root.

```bash
npm run release:prepare        # clean, build, test, pack, verify tarballs, consumer test
npm run release:publish:dry-run
npm run release:publish        # deliberate and manual; CI never publishes
npm run release:dist-tag       # point "latest" at this release
```

**npm owns `latest` whether you want it or not.** The first publish of a new package
claims `latest` regardless of `--tag`, and npm will not let it be deleted. So `latest`
exists, and every subsequent `--tag alpha` publish leaves it pointing at whichever version
was published first — a plain `npm install @cynodia/axiom` then silently hands out a stale
release. After publishing, run `npm run release:dist-tag` to move it. Check with
`npm view @cynodia/axiom dist-tags` rather than assuming.

`release:prepare` ends with `scripts/consumer-test.mjs`, which builds a project in a temp
directory from the tarballs alone — no workspace links, no path aliases, no relative
imports into the repo — and runs a Counter application written against the public API. If
you change what a package exports, that test is what proves an outside consumer can still
use it. `release:publish` additionally requires a clean git tree (`--allow-dirty` to
override), `npm whoami` to be `cynodia`, and a pre-release version, and publishes the
verified tarballs under the `alpha` dist-tag — never `latest`.

**Two-factor authentication.** The npm account has 2FA, so publishing *and* moving a
dist-tag each need a one-time password. `scripts/otp.mjs` handles this for both: it
prompts, or takes `--otp=<code>`, and because a code lasts about 30 seconds while five
packages go out in sequence, it asks for a fresh one and retries when a command is
rejected. Both scripts skip work already done — a version already on the registry, a tag
already pointing at this release — so re-running after a partial failure is safe.
These scripts need a real terminal for the prompt to appear. Automation should instead
authenticate with a granular access token that has "bypass 2FA" enabled — never commit
that token, or any credential, including to `.npmrc`.

## Working agreements

- **Add new files to git as you create them.** `git add` every file you introduce in the
  same session you introduce it; a change set that builds only because of untracked files
  is broken for everyone else. Staging is enough — don't commit unless asked.
- Don't commit or push unless the user asks for it.

## Layout

`packages/*`, npm workspaces + TypeScript project references. Dependencies are declared
twice and both must stay in sync: an exact version in `package.json` (never `file:` or
`workspace:` — see **Packaging** below), and a `references` entry in the package's
`tsconfig.json`. Root `tsconfig.base.json` carries `paths` for `@cynodia/axiom*` so editors
and tests resolve to source. Directory names stay short; npm names are scoped.

| Directory   | npm name | Owns |
| ----------- | -------- | ---- |
| `core`      | `@cynodia/axiom-core` | `ApplicationGraph`, node and field definitions, `TypeRef`, expressions, **locations**, edge kinds, validation, type inference, edge derivation, the IR contract. No dependencies. |
| `agent-api` | `@cynodia/axiom-agent-api` | Semantic queries, mutation impact, transactions, transformations, change sets. |
| `compiler`  | `@cynodia/axiom-compiler` | Validation + normalization into `ApplicationIR`, and page emission. |
| `runtime`   | `@cynodia/axiom-runtime` | State store, expression evaluation, the mutation subsystem, constraint checking, UI rendering, routing. |
| `axiom`     | `@cynodia/axiom` | The published facade: re-exports the four packages above. Application authors install only this. |
| `cli`       | *(private)* | Graph loading, `inspect` / `validate` / `build` / `serve`. |
| `demo`      | *(private)* | Two applications: `issue-tracker.ts` and `inventory.ts`. |

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
`object`, `binary`, `unary`, `call`, `filter`, `find`, `map`, `sort`, `every`, `some`,
`flatten`, `conditional`. Every kind has a
builder — never hand-write the discriminated union. A `ref` resolves an **id** against the
scope chain, in order: action parameters → iteration scopes → route parameters → state.
The iteration scope for a `repeat` is the repeat node's own id; for `filter`, `find`,
`map` and `sort` it is the expression's `scopeId`. Evaluation is pure: it never changes
state.

**Presence is not emptiness.** `required(x)` is true for `[]`, `''`, `0` and `false`, and
false only for null and undefined. Emptiness is `is-empty` / `non-empty`, and `coalesce`
falls back only on absence — so falling back to an empty collection works. Field-level
`required: true` likewise means present, not non-blank; express "must not be blank" as a
constraint.

**Collection operators are strict.** `null` is a missing collection and fails the
evaluation; `[]` is an empty collection and behaves normally. Nothing returns a plausible
value alongside a failure diagnostic — a failing expression throws
`ExpressionEvaluationError`, which the runtime catches at each boundary (derivation,
precondition, constraint, operation, render) and turns into a diagnostic. A constraint that
cannot be evaluated counts as violated, never as satisfied.

**Collections project, aggregate and order.** `map(source, scopeId, projection)` takes
`Collection<A>` to `Collection<B>`; `sum` reduces `Collection<number>` to a number (an
empty collection sums to zero); `sort(source, scopeId, by, direction)` orders by a
projected key. They compose — `sum(map(filter(…), …))` is the shape most aggregate rules
take — and type inference follows the composition, so an aggregation over something that
is statically not numeric is rejected before it ever runs.

**Locations name writable positions** (`core/location.ts`): `state`, `field` (a field of
another location), and `collection-item` (an item of a collection location, selected by
identity — preferred — or by index). Build them with `stateLocation()`,
`fieldLocation()`, `itemLocation()`, `identitySelector()`, or the shorthand
`itemFieldLocation(stateId, identityFieldId, identityValue, fieldId)`. Every location is
structurally traceable to its root state via `locationRootStateId()`; the expressions
inside it (`locationExpressions()`) are read dependencies, and the fields it writes
(`locationFieldIds()`) are write dependencies.

**Nodes.** `entity`, `state`, `action`, `constraint`, `route`, plus the nine UI kinds
(`view`, `container`, `text`, `repeat`, `field-display`, `form`, `input`, `button`,
`conditional`). All of them live in the same graph and are discriminated by `kind`.

**Behaviour is data.** An `ActionDef` has parameters, guards (a condition paired with the
failure it reports — prefer these to the older positional `preconditions`/`failureModes`
arrays, which the compiler normalizes into), operations, postconditions and failure modes. Operations are `set`, `insert`, `remove` (the three
mutations, each addressing a `Location`), `for-each`, plus `invoke`, `navigate` and
`native`. An action runs as a transaction: mutations apply, constraints are then evaluated
against the **proposed state**, and **every mutation rolls back together** if anything
fails. That is public contract now (spec4 §36), not incidental behaviour.

**`for-each` iterates without opening a transaction of its own.** Its nested operations are
mutations only, they run in the action's transaction, and the *collection* is read once
before any member is mutated. Each iteration otherwise reads the latest provisional state,
so two members touching the same record debit it twice (5 → 2 → −1) and the invariant then
catches the total. A failure in the seventeenth iteration unwinds the first sixteen. Locations inside the iteration may use `ref(scopeId)` to address the
canonical record the current member points at — which is how one action reduces stock
across many records without ever aliasing an object.

**Failure modes line up with preconditions by position.** `failureModes[2]` is the message
for the third precondition; a refusal reports `details.preconditionIndex` and
`details.failureMode`, so a refusal says which condition failed rather than always naming
the first.

**Inputs write to a location too.** `InputNode.binding` is `{ location }` — no expression,
no field id. An input change goes through the same mutation engine and transaction as an
action; there is no second write path inside the renderer.

**Canonical state is always valid; drafts need not be.** A UI write whose location is
rooted in ordinary state is transactional with respect to hard invariants: if the value
would break one, the whole mutation rolls back and the control re-renders with what is
actually stored. A write rooted in a `draft: true` state is not guarded, because a draft is
incomplete by definition while it is being filled in — the action that commits it is where
it has to be valid. This is spec3 §38's two editing patterns made enforceable rather than
advisory, and which one an application uses is visible in the graph: look at what the
input's location is rooted in.

**Reads and writes are attributed separately.** A `set` writes the fields its *target*
location names and reads the fields its *value* expression consults; an `insert` writes the
fields the constructed record declares, not the fields read to compute them. Reads follow
iteration scopes and derived collections, so projecting a field inside a `map` over
`coalesce(field(ref(state), lines), [])` is still recorded as a read of that field of that
state. `getMutationImpact` reports `analysisComplete: false` with `analysisGaps` when
something — a native operation with undeclared effects — cannot be analyzed, rather than
presenting a partial answer as exhaustive.

**Edges cannot go stale.** `graph.semanticEdges()` and every `getEdges` query derive
relationships from the current nodes on demand, cached against a revision counter that
every mutation bumps. Nothing has to remember to resynchronize anything, and an AgentAPI
answer can never disagree with the graph. `synchronizeEdges(graph)` still exists to
*materialize* those edges into serialized graph data, but correctness no longer depends on
calling it. Write edges carry `metadata.fieldIds`, and reads are attributed through
iteration scopes — projecting a field inside a `map` is recorded as a read of that field
of the state the members came from.

**Graph reads are deep clones.** Mutating a node you fetched changes nothing — write it
back with `updateNode`.

**Validation is not optional.** `validateGraph` resolves every reference — nodes, fields,
edges, expressions, locations, UI children, route targets — and `compileToIR` throws
`GraphValidationError` rather than compiling an invalid graph. It also rejects writes to
derived state, fields that don't belong to the addressed entity, selectors and iterations
over non-collections, aggregations over non-numeric collections, and obviously
incompatible assignments.

**Seed data is checked against its type, recursively.** `initialValue` is walked against
its `TypeRef` down through collections and nested entities. Records are keyed by **field
id**, so data keyed by field *name* is caught (`INITIAL_VALUE_UNKNOWN_FIELD` plus
`INITIAL_VALUE_MISSING_REQUIRED_FIELD`) rather than surfacing later as an inexplicably
empty UI. Diagnostics carry a `path` such as `state_orders[2].field_lines[0]` and
structured `details`.

**Four layers of correctness**, don't confuse them:
1. `validateGraph` — is the graph structurally sound? (authoring time)
2. Schema conformance — do instances satisfy `required` and their `TypeRef`? (runtime)
3. `ConstraintDef` — is this state allowed? Evaluated per instance of `entityId` with that
   instance bound to the entity's id. (runtime)
4. `TransitionConstraintDef` — is this *change* allowed? Evaluated with the instance as it
   was at transaction entry bound to `previousScopeId` and as proposed bound to
   `proposedScopeId`. A removed instance has a proposed value of nothing. (runtime)

Transition rules are what make a business rule hold on **every governed path** — actions,
`for-each`, and input bindings alike. `hydrateState` is deliberately *not* governed: it is
an administrative facility for hosts, tests and seeding, and is named so that it cannot be
mistaken for a semantic write.

Layers 2 and 3 apply to **every canonical occurrence** of an entity, found by walking
state values against their declared types. An entity nested inside a collection inside
another entity is validated where it actually lives, not only at the top level.

**Draft state.** `StateDef.draft: true` marks work in progress. Draft and derived states
are skipped by instance validation, otherwise a half-filled form would fail every
invariant and roll back every action.

**Derived state is read-only and copied.** A state with a `derivation` is recomputed on
demand and handed out as a frozen deep copy. Writing to it is rejected by the validator
and by the runtime. This is deliberate: it makes the aliasing the 0.2 runtime relied on
impossible, so an editor must address the record where it is actually stored — see
`packages/demo/test/acceptance.test.ts`, "editing a record works through its location".

## The mutation subsystem

`packages/runtime/src/mutation/` is the only place application state is written.

| Module | Role |
| ------ | ---- |
| `values.ts` | Cloning, deep freezing, comparison, coercion helpers. |
| `store.ts` | The state store. Owns the map, freezes everything on the way in, snapshots. |
| `transaction.ts` | Runtime transactions; nested ones join the outermost snapshot. |
| `resolve-location.ts` | `Location` → `ResolvedLocation` with `read()`, `write()` and a `ResolvedPath` of semantic provenance. |
| `mutation-engine.ts` | Applies `set` / `insert` / `remove`, records provenance and the mutation log. |

Three properties hold the design together:

- **Stored values are deeply frozen.** An accidental `object[field] = value` on anything
  read from the store throws in strict mode rather than silently corrupting state.
- **Writes rebuild the path** from the root state instead of editing in place, so a
  mutation never depends on the identity of an object an expression returned.
- **A change is only judged on what it changed.** The invariant guard compares violations
  before and after, so data that was already invalid — restored from storage, say — does
  not make the rest of the UI unwritable. Actions are stricter, per spec3 §27: an action
  must leave the whole application valid, not merely avoid breaking it further.

`runtime.getMutationLog()` returns every mutation with its source (`action` / `ui` /
`system` / `native`), the node that caused it, its transaction id, the resolved path
(`state_products → [product-1] → field_product_name`), and its `outcome` once the
surrounding transaction settles. Rejected attempts stay in the log as `rolled-back`.
Only the outermost transaction decides an outcome; a nested one shares its parent's fate —
so the log never suggests that early iterations of a failed `for-each` committed.

**Diagnostics are structured.** `RUNTIME_DIAGNOSTIC_CODES` is public vocabulary — including
`TRANSITION_CONSTRAINT_VIOLATION`, which carries the rule, the entity, and the previous and
proposed values, and `details.source` naming the mutation path; a
`RuntimeDiagnostic` carries `code`, `severity`, and where relevant `actionId`,
`constraintId`, `stateId`, `transactionId` and `details`. `invokeAction` returns the
diagnostics **of that invocation** — no diffing global history — while `diagnostics()` and
`clearDiagnostics()` manage the running log.

Values are cloned with `structuredClone`, not a JSON round trip: a JSON round trip turns
`NaN` into `null`, which would disguise a failed computation as an absent value.

## How the browser page is produced

The runtime modules are ordinary, type-checked TypeScript that import nothing at run time
except each other. `createRuntimeModuleSource()` concatenates their compiled output in
dependency order and strips the module syntax — that is the entire "bundler". The compiler
then inlines that source, the IR as JSON, and a two-line bootstrap into one page.

**The runtime must never import a value from `@cynodia/axiom-core`.** Type-only imports are fine
(they are erased). A value import would be stripped from the bundle and become `undefined`
in the browser, so `source.ts` now throws `UnbundledDependencyError` at build time if it
finds one. When the runtime needs something core computes, resolve it during compilation
and put it in the IR instead — `ApplicationIR.locationTypes` exists for exactly that
reason. Adding a module under `mutation/` means adding it to `RUNTIME_MODULES`.

## Where the tests live, and why

Test placement follows the dependency direction, which is why some tests are not in the
package they exercise:

- `core` — graph semantics, locations and their validation, type inference, and the
  architecture leak scan.
- `runtime` — the store's freezing and snapshot behaviour, location resolution, the
  memory host, the browser bundle's shape, and the mutation-confinement check.
- `compiler` — normalization and page emission, **plus the runtime behaviour tests**
  (`runtime.test.ts`, `mutation.test.ts`, `collections.test.ts`): `compileToIR` is the only
  IR producer, and the compiler is the lowest package that can see both it and the runtime.
  `collections.test.ts` enumerates `BUILTIN_FUNCTIONS`, `EXPRESSION_KINDS` and
  `OPERATION_KINDS` and executes every one, which is how "no silent semantic failure" is
  kept true as the vocabulary grows — add a construct without implementing it and that
  test fails.
- `agent-api` — queries, field-level dependencies, mutation impact, transactions.
- `demo` — the applications end to end, and the acceptance scenarios from spec2 §45/§46,
  spec3 §51/§52 and spec4 §30–§35. `order-system.ts` is the 0.4 acceptance fixture:
  projection, aggregation, aggregate guards and atomic multi-record confirmation, with no
  native operations anywhere in it.

`@cynodia/axiom-runtime` exports `createMemoryHost()` and an in-memory DOM. That is deliberate
framework code, not test-only scaffolding: the runtime takes its whole environment through
a `HostEnvironment`, so it can be driven headlessly without a browser or jsdom.

## Current limits

- **Rendering is full re-render.** Every state change rebuilds the view and restores focus
  and caret position by node id. `MutationResult.affectedLocations` is recorded but not yet
  used for fine-grained updates.
- **Invariants are re-evaluated in full** after every action, over every instance found by
  walking state. Constraint read dependencies are in the graph, so selective evaluation is
  possible but unimplemented.
- **`for-each` contains mutations only** — no nested iteration, navigation or invocation.
- **A malformed aggregation yields `NaN`** and a diagnostic. Comparisons against `NaN` are
  false, so a guard fails closed rather than passing on a value it could not compute.
- **`inputValidation: 'deferred'`** turns off the per-keystroke invariant check entirely,
  leaving validity to the next action. `'immediate'` is the default.
- **Warning-severity constraints never block a write.** Only error severity — the default
  — is treated as a hard invariant.
- **Remote persistence is declared but not executed** (`StatePersistence.kind: 'remote'`
  validates and does nothing). `memory` and `local-storage` work.
- **Type inference is deliberately partial** (spec3 §22): it rejects obvious mismatches and
  stays silent wherever a type depends on an iteration scope.
- **Iteration scopes are ordinary `NodeId`s**, not a distinct branded type. Misuse is
  caught by validation instead: a scope may not shadow an enclosing one, and may not take
  the id of a graph node.
- **No typed handles or higher-level authoring API yet** (spec4 §21–§23), and no semantic
  value formatting (§24). Graphs are still built by calling `addNode` with explicit ids.
- **Change sets are in memory** and per `AgentAPI` instance. There is no semantic version
  control and no on-disk graph format — graphs are still TypeScript builder functions,
  which remains a concession to human authoring.

When adding a capability, push it **down into the graph model and out of the framework**.
If a demo application seems to need a framework change, the change must be justifiable in
domain-neutral terms — that test is what `packages/demo/src/inventory.ts` exists to apply.
