# Agent reference

Axiom 0.15.0-alpha.1. Compressed operational contract. Read this plus the `.d.ts`
declarations before authoring or modifying an Axiom application.

Formal guarantees: [`SEMANTIC_CONTRACT.md`](SEMANTIC_CONTRACT.md). Mistakes that compile:
[`ANTI_PATTERNS.md`](ANTI_PATTERNS.md).

## Start here

```bash
npm install @cynodia/axiom            # graph, compiler, runtime, agent API
npm install @cynodia/axiom-ui         # semantic UI authoring patterns, build time only
npm install @cynodia/axiom-server     # only if a StateDef declares server authority
```

Everything is imported from `@cynodia/axiom`; the four re-exported packages need not be
installed individually. There is no published CLI.

A complete runnable skeleton — graph, state, action, UI, route, compile, run — is the
minimal application in [`../README.md`](../README.md). Read this document for the rules;
copy that for the shape.

**Escalation order.** This document → the `.d.ts` declarations → the focused document for the
topic → a minimal public-API probe: build the smallest graph that isolates the question, call
`validateGraph`, read the returned codes. Reading Axiom's own implementation source is for
debugging the framework, not for authoring an application.

**How much of this to read.** Everything up to and including
[Agent API](#agent-api) applies to every Axiom application. If no `StateDef` declares
`authority: 'server'`, the application is client-only and
[SERVER AUTHORITY](#server-authority) onwards — authority, integrations, effects, triggers,
subscriptions, storage — describes capability it does not use; skim the headings and stop.
Read [`ANTI_PATTERNS.md`](ANTI_PATTERNS.md) **before** the first attempt, not the second:
collection nulls, repeat scope binding and identity-over-index selectors all shape a first
draft.

**Do not guess from React, Vue, Angular, Svelte or Express.** Axiom has no component, no hook,
no JSX, no route handler, no ORM and no callback in the graph. There is no `formatter: fn`, no
`validator: fn`, no raw-CSS channel and no stored closure anywhere; new capability arrives as
an inspectable node, never as a function you supply.

## Glossary

One canonical term per concept. These are not interchangeable.

| Term | Meaning |
| --- | --- |
| **Graph** | `ApplicationGraph`. The authoritative application representation. |
| **Node** | Any graph member: entity, state, action, constraint, transition-constraint, route, or one of nine UI kinds. |
| **Expression** | A pure value computation. Never writes. |
| **Location** | An address of a writable position. |
| **Operation** | One step of an action: `set` `insert` `remove` `for-each` `invoke` `navigate` `native`. |
| **Mutation** | A `set`, `insert` or `remove` against a Location. The only way state changes. |
| **Guard** | An action precondition paired with the failure it reports. Refuses *this invocation*. |
| **Constraint** | An invariant over proposed state. Refuses *any* state that breaks it. |
| **Transition constraint** | An invariant over previous → proposed state. Refuses a *change*. |
| **Validation** | Authoring-time structural checking (`validateGraph`). |
| **Diagnostic** | A structured runtime failure record. |
| **Presentation** | Semantic UX intent on a UI node. |
| **Theme** | Translation of presentation intent into visual values. |

"Rule" is not an Axiom concept; say guard, constraint or transition constraint.

## Graph construction

```ts
const graph = new ApplicationGraph(id, name);      // version defaults to '0.11.2'
graph.addNode<StateDef>({ id, kind: 'state', ... }); // returns NodeId; throws if id exists
graph.getNode<StateDef>(id);                        // deep clone, or undefined
graph.updateNode(node);                             // write a modified node back
graph.removeNode(id);
graph.getNodesByKind('action');
graph.listNodes();
graph.getField(fieldId);                            // → { entityId, field } | undefined
graph.setTheme(partialTheme);
graph.serialize() / ApplicationGraph.deserialize(json);
```

- Reads return **deep clones**. Mutating a fetched node changes nothing; call `updateNode`.
- Edges are **derived on demand** from the current nodes (`graph.semanticEdges()`), cached against a revision counter. `synchronizeEdges(graph)` materializes them into graph data; correctness never depends on calling it.
- `addNode` with no `id` generates one (`createNodeId(kind)`).

## Ids

`NodeId`, `FieldId`, `EdgeId` are branded strings. Build with `nodeId()`, `fieldId()`,
`edgeId()`; generate with `createNodeId(prefix)`, `createFieldId(prefix)`.

Names are metadata for humans. **Nothing resolves by name.**

## TypeRef

Types are structures, never strings.

| Builder | Shape |
| --- | --- |
| `primitiveType(p)` | `{ kind: 'primitive', primitive }` where `p` ∈ `string` `number` `boolean` `date` `datetime` `binary` |
| `entityType(id)` | `{ kind: 'entity', entityId }` |
| `collectionType(t)` | `{ kind: 'collection', itemType }` |
| `optionalType(t)` | `{ kind: 'optional', valueType }` |
| `enumType([...])` | `{ kind: 'enum', values }` |

## ENTITY VALUE INVARIANT

Runtime entity records are keyed by **`FieldId`**.

Correct:

```ts
{ [F_TITLE]: 'Dune', [F_AUTHOR]: 'Frank Herbert' }
```

Incorrect — validated and rejected:

```ts
{ title: 'Dune', author: 'Frank Herbert' }
```

`initialValue` is walked against its `TypeRef` recursively. Data keyed by field *name*
produces `INITIAL_VALUE_UNKNOWN_FIELD` plus `INITIAL_VALUE_MISSING_REQUIRED_FIELD`, with a
`path` such as `state_orders[2].field_lines[0]`. It never surfaces later as an
inexplicably empty UI.

This applies to every record: `initialValue`, `hydrateState` values, `object` expression
output, and anything read back with `getState`.

## Expressions

Every kind is in `EXPRESSION_KINDS`. Full semantics: [`EXPRESSIONS.md`](EXPRESSIONS.md).

```ts
literal(v) ref(id) field(src, fieldId) object(entries, entityId?)
binary(op, l, r) unary(op, operand) call(fn, ...args) conditional(c, t, f)
filter(src, scopeId, predicate) find(src, scopeId, predicate)
map(src, scopeId, projection) sort(src, scopeId, by, direction?)
every(src, scopeId, predicate) some(src, scopeId, predicate) flatten(src)
group(src, scopeId, by) expressionRef(expressionId, args?)
```

- `group` partitions a collection: `Collection<A>` → `Collection<Group<K, A>>`, read with `groupKey(g)` and `groupItems(g)`. Groups appear in **first-seen key order**, members keep source order, keys compare structurally. Nothing is sorted — use `sort` for that.
- `expressionRef` evaluates a named `ExpressionDef` node: the calculation exists **once** in the graph and every consumer references it. Arguments are evaluated in the calling scope; **the body is evaluated in an isolated scope** that sees its parameters and application state and nothing else, so a definition means the same thing everywhere and its scope ids can never collide with a caller's.

Builtins (17): `required` `is-empty` `non-empty` `length` `contains` `concat` `coalesce`
`one-of` `count` `sum` `lowercase` `to-string` `trim` `substring-before` `substring-after`
`now` `uuid`. `trim` / `substring-before` / `substring-after` are `axiom.server.v7`
vocabulary.

Binary operators: `eq` `neq` `gt` `gte` `lt` `lte` `and` `or` `add` `subtract` `multiply`
`divide`. Unary: `not` `negate`.

### Presence semantics

`required(x)` asks only whether a value exists.

| Value | `required` | `is-empty` | truthy in a condition |
| --- | --- | --- | --- |
| `null` / `undefined` | `false` | `true` | `false` |
| `[]` | **`true`** | `true` | **`false`** |
| `[x]` | `true` | `false` | `true` |
| `''` | **`true`** | `true` | `false` |
| `'  '` (whitespace) | `true` | **`true`** | `true` |
| `0` | **`true`** | `false` | `false` |
| `false` | **`true`** | `false` | `false` |
| `{}` | `true` | `false` | `true` |

Field-level `required: true` means *present*, not non-blank. Express "must not be blank"
as a constraint using `non-empty`.

### Collection null semantics

Collection operators are strict: `null` is a missing collection and **fails**; `[]` is a
present empty collection and behaves normally. Nothing returns a plausible value alongside
a failure.

| Applied to | `[]` | `null` |
| --- | --- | --- |
| `map` `filter` `sort` | `[]` | error |
| `find` | `null` | error |
| `every` | `true` | error |
| `some` | `false` | error |
| `flatten` | `[]` | error |
| `count` | `0` | error |
| `sum` | `0` | error |
| `length` | `0` | `0` (falls back to text length) |
| `for-each` | zero iterations | error |

An error is an `ExpressionEvaluationError`, caught at each boundary (derivation,
precondition, constraint, operation, render) and reported as a diagnostic. **A constraint
that cannot be evaluated counts as violated, never as satisfied.**

Where a collection may legitimately be absent, say so:

```ts
coalesce(field(ref(CURRENT_ORDER), F_LINES), literal([]))
```

`sum` additionally fails if any member is not a finite number, so a malformed aggregation
cannot quietly satisfy a guard.

### Scope resolution

A `ref` resolves its `targetId` against the scope chain, innermost first, then state:

```text
innermost iteration scope → … → outermost iteration scope
  → action parameters → route parameters
  → state
```

Unresolved → `UNRESOLVED_REFERENCE`.

| Scope | Introduced by | Bound id |
| --- | --- | --- |
| Route parameter | `RouteDef.parameters[].id` | the parameter id |
| Action parameter | `ActionDef.parameters[].id` | the parameter id |
| Repeat item | `RepeatNode` | **the repeat node's own id** |
| Collection item | `filter` `find` `map` `sort` `every` `some` | the expression's `scopeId` |
| Iteration member | `for-each` | the operation's `scopeId` |
| Entity under validation | `ConstraintDef.entityId` | **the entity node's id** |
| Transition previous / proposed | `TransitionConstraintDef` | `previousScopeId` / `proposedScopeId` |

Iteration scopes are ordinary `NodeId`s, not a distinct branded type. Validation prevents
misuse: a scope id MUST NOT shadow an enclosing scope (`SCOPE_SHADOWING`) and MUST NOT be
the id of a graph node (`SCOPE_COLLIDES_WITH_NODE`).

An action parameter with the same id as a route parameter shadows it.

## Locations

`Expression` = value. `Location` = address. Full detail: [`LOCATIONS.md`](LOCATIONS.md).

```ts
stateLocation(stateId)
fieldLocation(target, fieldId)
itemLocation(collection, selector)
identitySelector(fieldId, valueExpression)     // preferred
indexSelector(indexExpression)
itemFieldLocation(stateId, identityFieldId, identityValue, fieldId)   // shorthand
```

```ts
// order → the line with this id → its quantity
fieldLocation(
  itemLocation(routedLines, identitySelector(F_LINE_ID, ref(SCOPE_LINE))),
  F_LINE_QUANTITY,
)
```

- Every location is traceable to its root state (`locationRootStateId`).
- A write **rebuilds the path from the root state**; it never depends on the identity of an object an expression returned.
- Writing derived state is rejected at validation (`DERIVED_STATE_WRITE`) and at runtime.
- `locationExpressions()` are read dependencies; `locationFieldIds()` are write dependencies.

## State

```ts
{ id, kind: 'state', valueType, initialValue?, derivation?, draft?, ephemeral?, persistence? }
```

| Kind | Written by | Instance validation | Notes |
| --- | --- | --- | --- |
| Stored | actions, input bindings, `hydrateState` | yes | The default. |
| Derived (`derivation`) | nothing | skipped | Recomputed on demand, handed out as a frozen deep copy. |
| Draft (`draft: true`) | as stored | skipped | Work in progress. Input writes are not guarded per keystroke. |
| Ephemeral (`ephemeral: true`) | as stored | skipped | A UI fact, not a domain fact. MUST NOT be persisted. |

`persistence`: `{ kind: 'memory' }` and `{ kind: 'local-storage', key? }` work.
`{ kind: 'remote', sourceId }` validates and **does nothing**.

Absent `initialValue`, a state starts at the default for its type: `optional` → `null`,
`collection` → `[]`, `number` → `0`, `boolean` → `false`, other primitive → `''`,
`enum` → its first value, `entity` → `null`.

## Actions and transactions

```ts
{
  id, kind: 'action', parameters?, guards?, preconditions?, failureModes?,
  operations, postconditions?, destructive?, requiresConfirmation?,
  confirmationMessage?, confirmation?,
}
```

Prefer `guards: [{ condition, failureMode }]`. The older parallel `preconditions` /
`failureModes` arrays align **by position** — `failureModes[2]` reports
`preconditions[2]` — and the compiler normalizes `guards` into them.

Lifecycle, exactly:

```text
resolve action            → ACTION_NOT_FOUND
bind parameters           → PARAMETER_MISSING (required parameter absent)
evaluate preconditions    → PRECONDITION_FAILED { preconditionIndex, failureMode }
confirmation (if required)→ declined ends the invocation
  ── no transaction has been opened up to this point; nothing was mutated ──
BEGIN TRANSACTION
  execute operations sequentially against provisional state
  evaluate entity constraints against proposed state
  evaluate transition constraints against entry state → proposed state
  evaluate postconditions
COMMIT if nothing failed, otherwise ROLL BACK EVERY MUTATION
re-render
```

`invokeAction` returns `{ ok, diagnostics }` for **that invocation**.

### Operations

| Kind | Semantics |
| --- | --- |
| `set` | Writes `value` to `target`. |
| `insert` | Appends `value` to the collection at `target`; `position: 'start'` prepends. |
| `remove` | Removes the selected item. **A selector matching nothing is a no-op, not an error.** |
| `for-each` | Runs nested mutations once per member. Mutations only — no nested iteration, navigation or invocation. |
| `invoke` | Runs another action inside the same transaction. Its failure fails the enclosing action. |
| `navigate` | Changes route. Not transactional. |
| `native` | Escape hatch. Receives cloned inputs, returns a value written to `resultTarget`. |

### `for-each`

```text
collection read ONCE, before any member is mutated
iteration N observes provisional writes from iterations < N
no transaction of its own — it runs inside the action's transaction
a failure in iteration N rolls back iterations 0..N-1 as well
```

Two members touching the same record therefore debit it twice:

```text
stock 5 → member A (−3) → 2 → member B (−3) → −1 → `stock >= 0` fails → all rolled back
```

That is a guarantee. It is what lets an aggregate rule be written as a per-record
invariant.

Locations inside the iteration may use `ref(scopeId)` to address the canonical record the
current member points at.

## Constraints

| | Question | Bound scope | Evaluated |
| --- | --- | --- | --- |
| `ConstraintDef` | Is this state allowed? | the instance, bound to `entityId` | once per canonical instance, after every governed mutation |
| `TransitionConstraintDef` | Is this change allowed? | `previousScopeId`, `proposedScopeId` | once per instance that existed at transaction entry and is not identical now |

- Without `entityId`, a constraint is evaluated once in the root scope.
- `severity: 'error'` (default) blocks. `severity: 'warning'` **never** blocks a write.
- Instances are found by walking state values against their declared types, so an entity nested inside a collection inside another entity is validated where it actually lives.
- A transition constraint requires the entity to declare `identityFieldId`; without one the rule is **silently skipped**.
- A removed instance has a proposed value of `null`. **A newly inserted instance has no previous state and is not evaluated** — govern creation with an action guard or an entity constraint.

Schema conformance runs alongside constraints on every canonical instance: required fields
present (`REQUIRED_FIELD_MISSING`), enum membership (`ENUM_VALUE_INVALID`), and number and
boolean types (`TYPE_MISMATCH`).

## UI nodes

Every kind is in `UI_NODE_KINDS`: `view` `container` `text` `repeat` `field-display` `form`
`input` `button` `conditional` `diagnostic` `dialog`. Detail: [`UI.md`](UI.md).

Every kind carries the same base, and `visibleWhen` lives here rather than in
`presentation`:

```ts
{ id, kind, name?, visibleWhen?: Expression, presentation?: Presentation, metadata? }
```

- `RepeatNode` binds the current item to **the repeat node's own id**; the template refers to it as `ref(repeatNodeId)`.
- `InputNode.binding` is `{ location }` — no expression, no field id. An input write goes through the same mutation engine and transaction as an action.
- `ButtonNode.arguments` is keyed by **action parameter id**.
- `FormNode` submits either a generated button (`submitActionId` + `submitLabel`) or a declared one (`submitButtonId`), which stays an ordinary queryable node.
- **`DialogNode` is how you ask for confirmation in a modal**, not `ActionDef.requiresConfirmation`. The two are different things: `requiresConfirmation` delegates to the host's own confirmation — `window.confirm` in a browser — which the application cannot label, focus, style or observe. A `dialog` declares the accessible name, the content, what closes it and where focus starts and returns; the runtime performs focus movement, containment, `Escape` and the ARIA relationships. Use `requiresConfirmation` for a coarse "are you sure" with no content of its own, and a `dialog` for anything a person needs to read.
- `DiagnosticNode` presents why an action refused. See [Action diagnostics](#action-diagnostics).
- `visibleWhen` and `ConditionalNode` are interaction behavior, **not authorization**.

### Render instances

A node inside a `repeat` is rendered once per member, so `NodeId` alone cannot identify a
rendered element.

```text
NodeId          = semantic graph identity      → data-node
RenderInstance  = runtime presentation identity → data-instance
```

Every renderer-generated id and relationship — element `id`, label `for`,
`aria-describedby`, error-region ids, control lookup, focus restoration — is keyed by the
**render instance**, so state never leaks between rows. Identity prefers the member's own
identity field and falls back to a deterministic index; nested repeats compose.

The graph still holds one node. `AgentAPI` reasons about that node, never about instances.

## Authoring UI: pattern, primitive, or node

Nodes are the model. They are not the only authoring surface, and choosing between the three
is a decision an agent should make deliberately:

| The requirement is | Use | Where |
| --- | --- | --- |
| recurring application UX that expands deterministically into existing semantics | a **pattern** | `@cynodia/axiom-ui` |
| interaction behaviour the runtime must perform | a **canonical interaction primitive** | `dialog`, in core |
| custom but already expressible | **canonical nodes**, composed | this document |
| genuinely unsupported presentation | `rendererOverrides.web.className`, and nothing more | [`PRESENTATION.md`](PRESENTATION.md) |

The five patterns are `page`, `metric-grid`, `entity-list`, `entity-form` and `action-bar`.
Expansion happens **at authoring time**: afterwards the graph is ordinary canonical Axiom, and
nothing at run time knows a pattern existed. Ownership defaults to the **declaration**, so
editing a generated node is drift, reported per node and per property; `materializePattern`
hands ownership to the graph when an edit is what you actually want. A pattern never creates
state, an action, a constraint or an authority.

Interaction behaviour is never a pattern: a pattern can only emit nodes that already exist, so
focus movement, containment, `Escape`, typeahead and active descendant are unreachable from one
— see [interaction primitives](UI.md#interaction-primitives) for the classification, including
`combobox`, which is classified and not implemented.

## Action diagnostics

The runtime already knows why an action refused. A `DiagnosticNode` makes that available
to the semantic UI, so an application never duplicates an action's guards as derived state
to explain them.

```ts
{ kind: 'diagnostic', actionId: ACTION_CONFIRM_ORDER, severity?: 'error' | 'warning' }
```

Lifecycle — deterministic, and the whole contract:

| Event | Record |
| --- | --- |
| Invocation refused | `outcome: 'failed'` with that invocation's diagnostics |
| Invocation succeeded | `outcome: 'ok'`, no diagnostics — the message clears |
| Confirmation declined | `outcome: 'cancelled'`, no diagnostics |
| `clearDiagnostics()` | record removed |
| Navigating to another route | every record removed |

- The record holds **only the most recent invocation** of that action.
- `severity` is the lowest severity presented; `'error'` (default) presents only errors.
- Multiple diagnostics are presented in the order they were reported.
- Messages come from the structured diagnostic — `failureMode.message`, `ConstraintDef.message` — never from renderer wording.
- The region is a live region: `role="alert"` for errors, `role="status"` for warnings, rendered even when empty so later content is announced. The initiating control gets `aria-describedby` pointing at it while it has content.
- `app.getActionOutcome(actionId)` reads the record.

## Presentation

Semantic UX intent on any UI node, entirely optional. Full vocabulary:
[`PRESENTATION.md`](PRESENTATION.md).

```ts
presentation: {
  role?, uxRole?, emphasis?, density?, textRole?, surface?, treatment?, icon?,
  accessibleLabel?, description?, layout?, sizing?, padding?, gap?, format?,
  control?, responsive?, rendererOverrides?,
}
```

Every value is a closed vocabulary, exported as an array; a token outside it is a validation
**error**, never a silently ignored value. The four an application reaches for constantly:

| Property | Vocabulary | Array |
| --- | --- | --- |
| `layout` | `vertical` `horizontal` `grid` `stack` | `LAYOUT_KINDS` |
| `gap`, `padding` | `none` `xsmall` `small` `medium` `large` `xlarge` | `SPACING_TOKENS` |
| `textRole` | `body` `caption` `label` `heading` `title` `display` | `TEXT_ROLES` |
| `density` | `compact` `comfortable` `spacious` | `DENSITIES` |

`layout: 'horizontal'` is shorthand for `layout: { kind: 'horizontal', gap?, align?, justify?,
wrap?, columns? }` — a bare token or the object, never a third form. `stack` is a tight
vertical column, not overlapping children. Every other vocabulary — roles, UX roles, surfaces,
treatments, icons, control variants, sizing, value formats, device classes —
is in [`PRESENTATION.md`](PRESENTATION.md); read it before guessing a token.

Resolution precedence, lowest first:

```text
renderer defaults → theme → inherited → semantic inference → node → responsive
```

`ResolvedPresentation.origins` records which layer decided each property. `density` is the
only property that inherits.

**A text role is typography; `headingLevel` is the outline.** A monetary total wants
`textRole: 'display'` with `headingLevel: 'none'`. Omitted, the level follows the text role
(`display` → 1, `title` → 2, `heading` → 3), which is the 0.5.0 mapping kept for
compatibility.

**A control's internal arrangement comes from `theme.buttons`**, not from node
presentation. An ordinary button — label only, or icon plus label, in any role — needs no
corrective `layout` or `padding`.

**PRESENTATION NEVER AUTHORIZES BEHAVIOR.** `hidden` ≠ forbidden. `role: 'destructive'` is
not a constraint. Enforcement belongs to guards, constraints and transition constraints.

## Compilation and running

```ts
const ir = compileToIR(graph);                  // throws GraphValidationError if invalid
const html = compileToHtml(graph, { title?, appearance?, remote? });
const css = createThemeStylesheet(ir.theme);

const app = createAxiomRuntime({ ir, rootElement, host, remote?, nativeOperations?, inputValidation?, recordMutationValues? });
await app.start();                              // render → restore → load authoritative state
```

`start()` renders synchronously and then loads authoritative state when a gateway is
configured; awaiting it means that has happened. **The gateway must be passed to
`createAxiomRuntime`, before `start()`.** A failed load reports `AUTHORITY_UNREACHABLE` and
leaves `authoritativeStateLoaded()` false — it never throws, and never looks like empty data.

`compileToHtml` wires the browser-safe gateway into the generated page whenever the IR
contains a remote action, so a server-authoritative application needs no client JavaScript
of its own. `remote: { endpoint }` points it elsewhere; `remote: false` switches it off.

`compileToIR` refuses an invalid graph. Pass `{ validate: false }` only for diagnostics.

Hosts: `createBrowserHost()` for a page, `createMemoryHost()` for headless use. The runtime
reads nothing from globals.

## Runtime API

| Member | Governed | Notes |
| --- | --- | --- |
| `invokeAction(id, args?)` | yes | Returns this invocation's `{ ok, diagnostics }`. |
| `getState(id)` | — | Deep clone. |
| **`hydrateState(id, value)`** | **NO** | Administrative. Evaluates no precondition, constraint or transition constraint. For hosts, tests and seeding. |
| `navigate(path)` / `currentRoute()` | — | |
| `diagnostics()` / `clearDiagnostics()` | — | Running log. |
| `getMutationLog()` | — | Every attempted mutation with source, path and `outcome`. |
| `registerNativeOperation(id, fn)` | — | |
| `start()` / `render()` | — | `start()` is render → restore → synchronize, and returns a promise. Rendering is a full re-render; focus and caret are restored by node id. |
| `invokeActionAsync(id, args?)` | yes | Awaits the outcome, an authority's answer included. |
| `syncAuthoritativeState()` | — | Loads and applies the authoritative snapshot. Idempotent. |
| `authoritativeStateLoaded()` | — | Whether a snapshot has been applied. Not the same question as "is this collection empty". |
| `settled()` | — | Resolves when no remote invocation is outstanding — how to await an action a click or a form submit started. |

## Diagnostics

30 runtime codes, all in `RUNTIME_DIAGNOSTIC_CODES`. Match on `code`, never on the message.
Full table with `details` fields: [`RUNTIME.md`](RUNTIME.md#diagnostic-codes).

```ts
const result = app.invokeAction(CONFIRM_ORDER);
if (!result.ok) {
  const failure = result.diagnostics.find(
    (d) => d.code === RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED,
  );
  failure?.details; // { preconditionIndex: 2, failureMode: 'insufficient-stock' }
}
```

## Validation

`validateGraph(graph)` → `{ valid, errors, warnings }`. `valid` is `errors.length === 0`;
warnings never make a graph invalid. 72 codes in `VALIDATION_CODES`, grouped in
[`VALIDATION.md`](VALIDATION.md).

**`validateGraph(graph)` with no options is target-neutral by design** (spec 8.2 §2-4): a
graph is never rejected for a renderer or trigger runtime nobody named. This means a bare
`validateGraph(graph).valid === true` does **not** by itself guarantee the graph is
executable by the browser client — a UI node kind no renderer implements, or a
client-authority trigger kind the browser trigger runtime does not execute
(`CLIENT_TRIGGER_UNSUPPORTED`), both validate silently under the no-options call. Use
`validateForBrowser(graph)` (`@cynodia/axiom-compiler`) for a validate-only check against
real browser capabilities, or call `compileToIR(graph)` directly — it applies those same
capabilities and throws `GraphValidationError` on exactly what `validateForBrowser` would
report as an error. See [Renderability](#renderability) below for the parallel UI-kind gate.

```ts
validateGraph(graph).valid;          // target-neutral: accepts every UI kind and trigger kind
validateForBrowser(graph).valid;     // browser-real: same as compileToIR's validation step
```

## Agent API

```ts
const agent = new AgentAPI(graph);
agent.getMutationImpact(location);   // writers, derived states, constraints, views + analysisComplete
agent.findDestructiveActions();
agent.getFieldReaders(fieldId) / agent.getFieldWriters(fieldId);
agent.resolvePresentation(nodeId) / agent.getFormStructure(formId);
agent.transact((tx) => { tx.setDensity(FORM, 'compact'); }, { reason });
```

`getMutationImpact` reports `analysisComplete: false` with `analysisGaps` when something —
a native operation with undeclared effects — cannot be analyzed. **An incomplete answer
says so; it is never presented as exhaustive.** Detail: [`AGENT_API.md`](AGENT_API.md).

## SERVER AUTHORITY

Full model: [`AUTHORITY.md`](AUTHORITY.md). These are the invariants to know before
authoring an application that crosses the trust boundary.

1. **AUTHORITY** — a client cannot commit server-authoritative state, by any path.
2. **EXECUTION** — a server action executes against state the authority owns, on the authority.
3. **TRUST** — a client's validation results, derived values and claims are never authoritative.
4. **TRANSACTION** — one semantic action commits atomically or not at all, wherever it runs.
5. **CONCURRENCY** — two actions cannot both commit from incompatible snapshots.
6. **PROTOCOL** — a client requests semantic actions, never mutation programs.
7. **SERIALIZATION** — authoritative behavior is data. No closure, no arbitrary code.
8. **BOOTSTRAP** — a remote client is given its gateway before it starts.
9. **STARTUP** — `start()` renders, then synchronizes; a failed load is a diagnostic.
10. **FORM SUBMIT** — a declared submit button invokes with its own arguments, clicked or submitted.
11. **IDEMPOTENCY** — a generated request id is unique across runtime instances; records are scoped by principal.
12. **CHANGES** — `changes` names every observable state whose value moved, and no others.
13. **PORTABILITY** — `axiom.server.v1` is frozen and language-independent. It is not the *current* contract: a document declares the oldest contract that carries its vocabulary; `axiom.server.v7` is current (migrations, schema identity).
14. **INTEGRATION** — external systems are accessed through typed integration operations.
15. **QUERY** — an external query is explicit action/trigger execution, never a pure `Expression`.
16. **EFFECT** — external effects are not rollback-capable state mutations.
17. **OUTBOX** — effect intent is committed before external execution, atomically with the state write that requested it.
18. **TRIGGER** — triggers invoke ordinary actions, under the same guards, constraints and authorization.
19. **EVENT** — events are typed facts; actions perform work.
20. **SECRET** — credentials never live in graph semantics.

```ts
{ id: STATE_PRODUCTS, kind: 'state', authority: 'server' }                  // the authority owns it
{ id: STATE_AUDIT,    kind: 'state', authority: 'server', serverOnly: true } // and the client never sees it
```

- `authority` defaults to `'client'`. **Every 0.5.x graph is unchanged and still runs with no server.**
- Authority is separate from persistence: one says who decides a value, the other where a decided value survives.
- **Where an action executes is derived, never declared**: an action that writes any server-authoritative state is a server action.
- A server action reaches the client as its id, name and parameters only — no operations, no guards, no failure modes, no authorization.
- A server action MUST NOT read client state. Pass the value as an action parameter; that is what a draft is for.

```ts
compileToIR(graph)         // the client half, filtered at the boundary
compileToServerIR(graph)   // what an authority executes: no UI, no presentation, no routes
```

### Authorization

```ts
graph.setPrincipalEntity(ENTITY_USER);
{ kind: 'action', authorization: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('admin')), … }
```

`PRINCIPAL` is bound to a record keyed by the principal entity's field ids, and **only where
an authority evaluates** — which is everywhere on the authority, not only in `authorization`:
guards, operation values, postconditions and constraints alike. That is how a record says who
caused it without a client being asked to claim an identity:

```ts
{ fieldId: F_ORDER_PLACED_BY, value: field(ref(PRINCIPAL), F_USER_ID) }
```

Reading it anywhere a client evaluates is `PRINCIPAL_REFERENCE_ON_CLIENT`. A rule that cannot
be evaluated denies. An anonymous caller has no principal: attributes read from it are absent,
so any rule naming one is false. `requiresConfirmation` is interaction, not authorization.

### Running one

One graph, one process — the generated page and the authority that answers it:

```ts
await serveAxiomApplication({
  serverIR: compileToServerIR(graph),
  page: compileToHtml(graph),
  persistence: await createSqlitePersistence({ location: 'app.db' }),
  authenticate: (credential) => resolveUser(credential),
  port: 3000,
});
```

`GET /` is the page, `POST /axiom` the semantic endpoint. No route, controller, handler, SQL
or client JavaScript is authored. **There is no published Axiom CLI.** The halves also run
separately: `serveOverHttp({ server, port })` is the bare authority, and
`createDirectTransport(server)` drives one in-process for tests.

A remote invocation returns `{ ok: false, pending: true }` and its outcome arrives later,
through the same action-outcome lifecycle a local refusal uses — so a `diagnostic` node
presents a server refusal exactly as it presents a local one, and the control that started it
renders `aria-busy` and refuses a second press until it settles.

## INTEGRATIONS, EFFECTS, TRIGGERS

Full model: [`INTEGRATIONS.md`](INTEGRATIONS.md), [`EFFECTS.md`](EFFECTS.md),
[`TRIGGERS.md`](TRIGGERS.md), [`EVENTS.md`](EVENTS.md). These are the invariants to know
before authoring an application that reaches an external system or reacts to time or an
event.

1. **INTEGRATION INVARIANT** — external systems are accessed through typed integration operations; the graph never carries an SDK, a host name or a secret.
2. **QUERY INVARIANT** — external queries are explicit execution, resolved before the transaction they feed opens — never a pure `Expression`. `timeoutMs` is enforced by the runtime itself, not left to adapter cooperation; a non-cooperating adapter cannot wedge the invocation past its deadline (spec 8.1 §15-25).
3. **EFFECT INVARIANT** — external effects are not rollback-capable state mutations. Reaching `integration-effect` only records intent; the adapter runs only after commit. The outcome reaches a follow-up action as a structured envelope (`effectOutcomeEntity` — `EFFECT_ID_FIELD`/`EFFECT_OPERATION_ID_FIELD`/…), never a raw result or a formatted string requiring text parsing to correlate (spec 8.1 §37-41).
4. **OUTBOX INVARIANT** — effect intent is committed atomically with the state write that requested it, before external execution, so a crash between the two does not lose it.
5. **TRIGGER INVARIANT** — a trigger invokes an ordinary action, under exactly the guards, constraints, transition constraints and authorization any other caller is subject to. Every invocation this authority runs — client request or trigger tick — is serialized against every other one, so simultaneous same-period triggers commit one at a time identically on the deterministic and the real host (spec 8.1 §26-30).
6. **EVENT INVARIANT** — an event is a typed fact, validated against its declared payload type before any action sees it; an action is where work happens.
7. **SECRET INVARIANT** — integration credentials live in host configuration (`AxiomServerOptions.integrations`), never in `ApplicationGraph`.
8. **INVOCATION SOURCE INVARIANT** — a system-originated invocation (trigger, event, effect outcome) and an anonymous client request are distinct authoritative facts; a client cannot forge the former (`ExecutionContext.source` is server-computed, never read from protocol data), and `ActionDef.invocation.allowedSources` lets an action restrict which it accepts independently of `authorization`'s identity check (spec 8.1 §3-14).

```ts
{ kind: 'integration', id: INTEGRATION_DEVICE_PROVIDER }
{
  kind: 'integration-operation', id: OP_FETCH_STATUS, integrationId: INTEGRATION_DEVICE_PROVIDER,
  mode: 'query', resultType: primitiveType('string'),
}
{
  kind: 'action', id: ACTION_REFRESH,
  operations: [
    { kind: 'integration-query', operationId: OP_FETCH_STATUS, bindAs: SCOPE_STATUS },
    { kind: 'set', target: stateLocation(STATE_STATUS), value: ref(SCOPE_STATUS) },
  ],
}
{ kind: 'trigger', id: TRIGGER_POLL, actionId: ACTION_REFRESH, when: { kind: 'interval', everyMs: 5000 } }
```

- `mode: 'query'` may bind its result into scope (`bindAs`) for later operations in the same action; `mode: 'effect'` never runs synchronously and its outcome reaches an action only through a dispatched `succeededEventId`/`failedEventId`.
- A trigger's target action runs where the action itself runs — server if it writes server state or calls an integration, client only for `route-enter`/`route-leave`. Derived, never declared, exactly like ordinary action authority.
- A triggered/event-originated invocation runs with `principal: null`, `source: 'system'` — the same as an anonymous client request, never an impersonated user. Authorization still evaluates, and `invocation.allowedSources` is checked before it: `{ invocation: { allowedSources: ['system'] } }` refuses a direct client `InvokeRequest` with `INVOCATION_SOURCE_NOT_ALLOWED`, which is what protects a webhook- or effect-outcome-only action from being forged by a client that guessed its id.
- `createDeterministicServerHost().advance(ms)` fires due timers deterministically; no trigger test waits on a real clock.

```ts
agent.listIntegrations() / agent.listIntegrationOperations(id?);
agent.getActionsUsingIntegration(id) / agent.getEffectsForAction(actionId);
agent.getTriggersForAction(actionId) / agent.getTimedTriggers();
agent.getActionsTriggeredByEvent(eventId) / agent.getTriggeredEvents();  // graph-static: has a bound trigger, not "was delivered"
agent.getExternalDependencies();   // { integrations, operations } — the deployment manifest
agent.getSystemOnlyActions() / agent.getTriggersTargetingClientOnlyActions();
agent.isClientInvocable(actionId) / agent.isSystemOnly(actionId);
```

Portable artifacts, for a runtime written in another language:

```
@cynodia/axiom-server/conformance                     the fixture manifest (fixture.format, below)
@cynodia/axiom-server/conformance/<name>.json         one fixture, pure data
@cynodia/axiom-server/schema/server-ir.v1.schema.json JSON Schema for axiom.server.v1 (frozen)
@cynodia/axiom-server/schema/server-ir.v2.schema.json JSON Schema for axiom.server.v2
@cynodia/axiom-server/schema/server-ir.v3.schema.json JSON Schema for axiom.server.v3
@cynodia/axiom-server/schema/server-ir.v4.schema.json JSON Schema for axiom.server.v4
@cynodia/axiom-server/schema/server-ir.v5.schema.json JSON Schema for axiom.server.v5
@cynodia/axiom-server/schema/server-ir.v6.schema.json JSON Schema for axiom.server.v6
@cynodia/axiom-server/schema/server-ir.v7.schema.json JSON Schema for axiom.server.v7
@cynodia/axiom-server/schema/server-ir.v8.schema.json JSON Schema for axiom.server.v8
@cynodia/axiom-server/schema/server-ir.v9.schema.json JSON Schema for axiom.server.v9 (latest)
@cynodia/axiom-server/schema/protocol.v1.schema.json  JSON Schema for the protocol
@cynodia/axiom-server/conformance/queries/<name>.json one query conformance fixture (axiom.conformance.v4)
@cynodia/axiom-server/conformance/migrations/<name>.json one migration conformance fixture (axiom.conformance.v5)
```

This list is generated/tested content, not hand-maintained prose: `packages/demo/test
/documentation.test.ts` fails if a shipped `schema/*.json` file is missing from it or a
listed file no longer exists (spec 8.2 §43-45). `runConformanceFixture`/
`runConformanceSuite` (`@cynodia/axiom-server`) are the public runner over that fixture
format — see [`AUTHORITY.md`](AUTHORITY.md#conformance) for `fixture.conformance` (the
fixture-format version) vs `fixture.serverIR.contract` (the per-fixture Server IR contract)
vs the manifest's own `conformance`/`protocol`/`release` fields — three separate concepts,
never conflated under one "contract" name (spec 8.2 §9-10).

Boundary diagnostics: `UNKNOWN_SERVER_ACTION` `ARGUMENT_TYPE_MISMATCH` `AUTHORIZATION_DENIED`
`INVOCATION_SOURCE_NOT_ALLOWED` `CONCURRENCY_CONFLICT` `MALFORMED_REQUEST`
`AUTHORITY_UNREACHABLE`, plus `SERVER_STATE_WRITE` and `REMOTE_ACTION_UNAVAILABLE` on the
client.

## SUBSCRIPTIONS AND STORAGE

Full model: [`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md), [`STORAGE.md`](STORAGE.md). The external
world reaching *in*, and binary data, which 0.8 had no vocabulary for.

The external-interaction model is exactly three directions. Anything else is one of them
wearing a different name.

| Direction | Shape | Vocabulary |
| --- | --- | --- |
| Query | Ask; wait for a finite answer. | `integration-query`, `blob-metadata` |
| Effect | Tell; no answer joins the transaction. | `integration-effect`, `blob-commit`, `blob-delete` |
| Subscription | The world tells you, while you are listening. | `SubscriptionDef` → `EventDef` |

1. **SUBSCRIPTION INVARIANT** — a long-lived external source is a `SubscriptionDef`, never a client, a socket or a callback in the graph. A delivery becomes an `EventDef` payload and enters the existing `EventDef → TriggerDef → ActionDef` pipeline; there is no second event system.
2. **RAW-I/O INVARIANT** — OS I/O primitives are not graph vocabulary. No `readFile(path)`, `openSocket(host, port)`, `exec(command)`, `spawn(process)`, file descriptor, Node stream or POSIX path exists or will. They live inside an adapter, which is exactly what lets a Rust runtime implement the same graph with different primitives.
3. **DELIVERY INVARIANT** — at-least-once; effectively-once where `delivery.deduplicateBy` names an external identity, and that deduplication survives a restart when the persistence adapter is durable. Per-subscription ordering is guaranteed; cross-subscription ordering is guaranteed to be **nothing**.
4. **BACKPRESSURE INVARIANT** — the queue is always bounded (`maxQueued`, default 64) and the default policy (`block`) cannot lose an event. A policy that may discard one (`drop-oldest`/`drop-newest`) is declared in the graph and reports `SUBSCRIPTION_DELIVERY_DROPPED` every time. Loss is never silent and never a default.
5. **SHUTDOWN INVARIANT** — after `server.stop()`, no delivery reaches application state. A stopped subscription answers `stopped` to everything, including deliveries already in flight.
6. **BLOB INVARIANT** — bytes never enter the graph, the Server IR or canonical state. A `BlobRef` (`blobRefEntity()` — key, media type, size, filename?, checksum?) is what state holds, and it discloses nothing about the provider.
7. **BLOB AUTHORIZATION INVARIANT** — possession of a key is not permission. `StorageDef.readAuthorization` is evaluated with the caller bound to `PRINCIPAL` and the `BlobRef` bound to `ref(<storageId>)`; a store with no rule serves nothing. A key that names nothing is refused identically to one the caller may not read.
8. **STAGED-COMMIT INVARIANT** — an object store does not join an Axiom transaction, and nothing pretends it does. An upload lands `staged`; `blob-commit` promotes it post-commit. A refused transaction leaves a sweepable staged object, never a state referencing bytes that were never claimed. A failed `blob-delete` leaves state correct and the orphan visible in `blobLog()`.

```ts
{ kind: 'subscription', id: SUB_STATUS, integrationId: INTEGRATION, source: 'device-status',
  eventId: EVENT_STATUS_CHANGED,
  lifecycle: { autoStart: true, required: false, reconnect: { policy: 'exponential', maxAttempts: 5, delayMs: 1000 } },
  delivery: { maxQueued: 32, backpressure: 'block', deduplicateBy: F_DELIVERY_ID, maxAttempts: 1, onFailure: 'report' } }

{ kind: 'storage', id: STORAGE_LOGS, blobEntityId: ENTITY_BLOB,
  readAuthorization: <Expression>, uploadAuthorization: <Expression>,
  acceptedMediaTypes: ['text/plain'], maxSizeBytes: 8388608 }

{ kind: 'blob-metadata', storageId: STORAGE_LOGS, blobKey: <Expression>, bindAs: SCOPE_BLOB }
{ kind: 'blob-commit',   storageId: STORAGE_LOGS, blobKey: <Expression> }
{ kind: 'blob-delete',   storageId: STORAGE_LOGS, blobKey: <Expression> }
```

Lifecycle: `inactive → starting → active → reconnecting → failed`, plus `stopped`. Startup
decides what activates; application code never calls `start()`. A failed source leaves the
application running unless `lifecycle.required`.

Subscription vs. webhook vs. polling — three different things, do not conflate them:

| | What it is | Vocabulary |
| --- | --- | --- |
| Webhook | Externally initiated finite request; each delivery enters independently. | host `webhooks` → `EventRequest` |
| Subscription | Standing semantic interest in a long-lived source. | `SubscriptionDef` |
| Polling | You ask, repeatedly, on a schedule. | `interval` `TriggerDef` → `integration-query` |

Upload is `POST /axiom/blob/<storageId>` and download is `GET /axiom/blob/<storageId>/<key>`
— one host transport for every Axiom application. Application-authored upload/download
routes: zero.

```ts
agent.listSubscriptions() / agent.getSubscriptionsForIntegration(id);
agent.getEventForSubscription(id) / agent.getActionsReachableFromSubscription(id);
agent.getExternalEventSources();   // { subscriptions, events, integrations }
agent.listStorages() / agent.getActionsUsingStorage(id) / agent.getStoragesWithoutAccessRules();

server.subscriptionLog() / server.subscriptionStatus(id);   // state, counters, last delivery, last failure
server.blobLog();                                           // storage effects and their outcomes
server.stageBlob(storageId, principal, upload);
server.authorizeBlobRead(storageId, key, principal);
server.authorizeBlobUpload(storageId, principal, { mediaType, size });
```

Adapters: `SubscriptionAdapter` (`createScriptedSubscriptionAdapter` is the deterministic
fake) and `BlobStorageAdapter` (`createMemoryBlobStore`). A declared subscription or store
with no registered adapter fails `start()` rather than staying silently inert.

Diagnostics: `SUBSCRIPTION_ADAPTER_MISSING` `SUBSCRIPTION_START_FAILED`
`SUBSCRIPTION_DELIVERY_DROPPED` `SUBSCRIPTION_DELIVERY_FAILED` `BLOB_STORE_MISSING`
`BLOB_NOT_FOUND` `BLOB_ACCESS_DENIED` `BLOB_TOO_LARGE` `BLOB_MEDIA_TYPE_REJECTED`
`BLOB_OPERATION_FAILED` `BLOB_STORAGE_UNAVAILABLE` `BLOB_METADATA_FAILED`.

## SEMANTIC DATA ACCESS & QUERY LAYER

Full model: [`QUERIES.md`](QUERIES.md). For authoritative data too large to materialize as a
`StateDef` — 500,000 orders, years of audit rows. The graph owns the meaning; a
`DataProvider` owns execution. `axiom.server.v6`.

```ts
// A registered query: one node, fixed named clauses, every leaf an ordinary Expression.
graph.addNode<QueryDef>({
  id: QUERY_RECENT_ORDERS, kind: 'query',
  source: ENTITY_ORDER, rowScopeId: SC_ROW,
  parameters: [{ id: P_STATUS, valueType: enumType([...]) }],
  filter: binary('eq', field(ref(SC_ROW), F_STATUS), ref(P_STATUS)),   // boolean; PRINCIPAL, params in scope
  sort: [{ key: field(ref(SC_ROW), F_CREATED_AT), direction: 'desc' }], // canonical identity appended as tie-breaker
  relationships: [{ relationshipId: REL_ORDER_ACCOUNT, bindAs: SC_ACCOUNT }],
  projection: { entityId: ENTITY_ORDER_SUMMARY, fields: [{ id: F_S_NAME, value: field(ref(SC_ACCOUNT), F_ACCOUNT_NAME) }, ...] },
  aggregate: [{ function: 'count' | 'sum' | 'min' | 'max' | 'average', key?: Expression, as: FieldId }],
  groupBy: [Expression],                                               // first-seen key order; present only with aggregate
  pagination: { strategy: 'cursor' | 'offset', maxPageSize, defaultPageSize },
  readPolicyId: POLICY_ORDER,
});

graph.addNode<RelationshipDef>({ id, kind: 'relationship', cardinality: 'to-one' | 'to-many',
  from: { entityId, fieldId }, to: { entityId, fieldId } });           // explicit, never inferred

graph.addNode<ReadPolicyDef>({ id, kind: 'read-policy', entityId, rowScopeId,
  predicate });   // boolean over row + PRINCIPAL; AND-ed into every query's filter, server-side

// Inside an action, before the transaction opens; makes the action server-authority:
{ kind: 'query', queryId, arguments?, bindAs }

// Mutate a provider-backed row by identity, no collection materialized:
{ kind: 'set', target: providerRecordFieldLocation(ENTITY_ORDER, F_ID, ref(P_ID), F_STATUS), value: literal('confirmed') }
```

Client protocol: `{ kind: 'query', queryId, arguments?, cursor?, pageSize?, offset? }` →
`{ kind: 'query-result', ok, diagnostics, page? | aggregate?, revision }`. The client
invokes a query **by id**, never a query language. `page.nextCursor` is opaque — store it
and hand it back; never parse it.

Client lifecycle: `createQueryStore(fetcher)` — a `QueryView` per `{queryId, arguments}` key
with `load` / `refresh` / `loadMore` / `reset` / `subscribe`. States:
`idle | loading | ready | refreshing | error` (`QUERY_LIFECYCLE_STATES`). A failed first
load → `error` with no data; a failed refresh → `error` with the last good data still
visible.

Server: `createAxiomServer({ ir, dataProvider | dataProviders, cursorSecret?, queryCache? })`.
`createMemoryDataProvider({ rows })` and `createSqliteDataProvider({ location, entities, seed })`
are the reference providers, semantically identical. Cache identity includes a principal and
read-policy fingerprint; any committed mutation clears it. `server.clearQueryCache()` /
`server.queryCacheStats()`.

AgentAPI: `listQueries()` `getQuery(id)` `explainQuery(id)` `getQueryEntities(id)`
`getQueryFields(id)` `getQueryRelationships(id)` `getReadPolicyForQuery(id)`
`getActionsInvalidatingQuery(id)` `getQueriesInvalidatedByAction(actionId)` `listRelationships()`
`listReadPolicies()`; `getMutationImpact(location).affectedQueries`.

Portable: `runQueryConformanceFixture` / `runQueryConformanceSuite` over the
`axiom.conformance.v4` fixtures in `conformance/queries/`.

Diagnostics: `QUERY_NOT_FOUND` `QUERY_ARGUMENT_TYPE_MISMATCH` `QUERY_CAPABILITY_UNSUPPORTED`
`QUERY_CURSOR_INVALID` `QUERY_PAGE_SIZE_EXCEEDED` `QUERY_PROVIDER_FAILURE`
`QUERY_RESULT_TYPE_MISMATCH` `QUERY_PROVIDER_MISSING` (boundary); `QUERY_RESOLVER_UNAVAILABLE`
`QUERY_OPERATION_FAILED` (a `query` operation in the runtime). Validation:
`UNKNOWN_QUERY_ENTITY` `UNKNOWN_RELATIONSHIP` `INVALID_RELATIONSHIP` `UNKNOWN_READ_POLICY`
`INVALID_READ_POLICY` `DUPLICATE_READ_POLICY` `INVALID_QUERY_PREDICATE` `INVALID_QUERY_SORT`
`INVALID_QUERY_PROJECTION` `INVALID_QUERY_AGGREGATE` `INVALID_QUERY_GROUPING`
`INVALID_QUERY_PARAMETER` `UNSTABLE_PAGINATION` `INVALID_QUERY_OPERATION`
`INVALID_PROVIDER_RECORD_LOCATION`.

## SCHEMA EVOLUTION & SEMANTIC MIGRATIONS

Full model: [`MIGRATIONS.md`](MIGRATIONS.md).

A deployed application evolves its semantic model and persisted data through
**`MigrationDef`** nodes — never application SQL, an ORM migration, a callback or a manual
schema-version check. `graph.schemaVersion` is a monotonic integer (default `1`), distinct
from the npm version and the Server IR contract. `schemaFingerprint(graph)` is a
deterministic hash of every persistence-relevant fact and nothing else — renaming a `label`
does not change it.

A `MigrationDef` has `fromSchema` / `toSchema` (differ by one), and `operations` from a
closed set of ten: `add-entity` `remove-entity` `add-field` `remove-field` `change-field`
`populate-field` `transform-field` `transform-record` `add-relationship`
`remove-relationship` (`MIGRATION_OPERATION_KINDS`). The set of migrations must form a
contiguous chain `1 → … → schemaVersion`. `transform-record` is the split/merge primitive.

Transform expressions (`populate` / `value` / `expression` / `produce`) are ordinary
`Expression` trees read in an isolated scope: `field(ref(MIGRATION_OLD_SCOPE), fieldId)`,
declared constants, and nested iteration scopes only. They MUST be pure — `now` / `uuid` /
any other scope read throw. The string builtins `trim` `substring-before` `substring-after`
(v7 vocabulary) exist for record transforms like splitting a name.

Any `MigrationDef`, or a `schemaVersion > 1`, makes the Server IR **`axiom.server.v7`**,
carrying `schemaVersion`, `schemaFingerprint` and `migrations`.

Authoring-time: `validateGraph` rejects a broken chain, an unmarked destructive op, an
impure or mistyped transform, an add-required-without-populate. `diffSchema(prev, next)`
(core) classifies each change; `migrationCoversDiff` proves the chain covers the diff.
AgentAPI: `inspectSchema()` `diffSchema(previous)` `migrationImpact(previous)`
`explainSchemaDiff(diff)`.

Runtime (`@cynodia/axiom-server`): `planMigration(ir, { fromVersion })` (pure) →
`SemanticMigrationPlan`; `explainMigration(plan)` (the §56 account); `executeMigration({ ir,
metadata, rows, principal: migrationAuthority('id'), approveDestructive })` — **host-only**,
no `ServerRequest` branch; `getMigrationStatus(metadata)`. Row transforms are keyset-batched
and checkpointed — a crash resumes to the identical result, a re-run is a no-op, a 2M-row
migration is bounded memory. Destructive operations need explicit `approveDestructive` or
zero writes occur. The target version commits only after post-migration validation.

Startup gate: `createAxiomServer({ ir, migrationMetadata })` → `start()` refuses on anything
but `compatible` / `fresh` — `SCHEMA_MIGRATION_REQUIRED` / `SCHEMA_INCOMPATIBLE` /
`MIGRATION_IN_PROGRESS` / `MIGRATION_FINGERPRINT_MISMATCH`. `server.schemaGate()` reports
without starting. While a migration runs, all requests get `MIGRATION_IN_PROGRESS`.

Providers: `createMemoryRowStore` + `createMemoryMigrationStore` (deterministic reference);
`createSqliteRowStore` + `createSqliteMigrationStore` (real `ALTER TABLE`, batched keyset
`UPDATE`, `_axiom_migration_*` tables). Both derive equivalent target data. Portable:
`runMigrationConformanceFixture` over the `axiom.conformance.v5` fixtures in
`conformance/migrations/`.

There is **no published Axiom CLI**. Every schema/migration operation is a public library
function — `inspectSchema`, `diffSchema`, `explainSchemaDiff`, `migrationImpact` (from
`@cynodia/axiom-agent-api`); `planMigration`, `explainMigration`, `executeMigration`,
`getMigrationStatus` (from `@cynodia/axiom-server`). A host builds its own command around
them. (The Axiom repository has a private, unpublished CLI over the same functions for
maintainer use.)

Diagnostics: `SCHEMA_MIGRATION_REQUIRED` `SCHEMA_INCOMPATIBLE` `MIGRATION_IN_PROGRESS`
`MIGRATION_STATE_CORRUPTED` `MIGRATION_PATH_NOT_FOUND` `MIGRATION_APPROVAL_REQUIRED`
`MIGRATION_DESTRUCTIVE` `MIGRATION_PROVIDER_UNSUPPORTED` `MIGRATION_TRANSFORM_FAILED`
`MIGRATION_VALIDATION_FAILED` `MIGRATION_CHECKPOINT_INVALID` `MIGRATION_FINGERPRINT_MISMATCH`
`MIGRATION_NOT_AUTHORIZED` `MIGRATION_FAILED` (boundary). Validation:
`INVALID_MIGRATION_VERSION` `MIGRATION_PATH_NOT_FOUND` `MIGRATION_CHAIN_FORK`
`DUPLICATE_MIGRATION_OPERATION_ID` `MIGRATION_REQUIRED_FIELD_WITHOUT_DEFAULT`
`MIGRATION_DESTRUCTIVE_UNMARKED` `INVALID_MIGRATION_OPERATION` `MIGRATION_TRANSFORM_IMPURE`
`MIGRATION_TRANSFORM_TYPE_MISMATCH`.

## DISTRIBUTED AUTHORITY

Full model: [`DISTRIBUTED_AUTHORITY.md`](DISTRIBUTED_AUTHORITY.md).

The authoritative runtime may run as **N processes at once** over one shared persistence
provider, with **no graph change and no application code that knows a cluster exists**. One
authority and N authorities produce the same committed state and the same framework-owned
async work. Deployment topology is not application semantics.

Quick answers:

| Question | Answer |
| --- | --- |
| Do I write locking code? | **No.** Never an application lock, never `SETNX` in a `native` op. |
| Do I need Redis? | **No.** `memory` and `SQLite` reference providers ship; 0.12 semantics use no provider's vocabulary. |
| Are external effects generically exactly-once? | **No.** Exactly-once *logical* creation and *durable completion*; at-least-once *physical* execution unless the provider is idempotent. |
| Can multiple authorities race work safely? | **Yes**, with a capable `coordination` provider — activated automatically, no flag. |
| Can a stale owner commit after losing ownership? | **No.** Every durable-work write is fenced on a per-resource generation; a reclaim advances it. |
| Is deployment topology graph semantics? | **No.** No node kind, operation or IR field is added; a distributed graph compiles byte-identically. |

`createAxiomServer({ coordination, workStorage, distributed: { instanceId, leaseDurationMs,
renewIntervalMs, workerConcurrency, claimBatchSize, pollIntervalMs } })` — an unsafe combo
(`renewIntervalMs >= leaseDurationMs`) **throws**. `server.authority()` →
`{ instanceId, distributed, coordination: capabilities|null, config, compatibilityKey }`;
`server.inspectDistributedWork()` → live effect work items + incompatible items.

Every framework-owned async unit — outbox effect, scheduled firing, subscription cursor — is
a leased, fenced, per-item ownership claim: `pending → claimed(ownerId, generation) →
succeeded/failed/retry`. Lease expiry authorises nothing; only a reclaim (which mints a
higher generation) fences the prior owner (`WORK_FENCED`). `logicalEffectId` (= the effect
intent id) never changes across retries; `idempotencyKey` defaults to it (§7 of the full
doc). Retry backoff is durable, not a process timer. An attempt whose outcome was never
recorded increments `uncertainAttempts` and is retried with the same key — Axiom never
claims physical exactly-once.

Scheduled `interval` / `delay` firings are gated on a fenced claim keyed by
`"<scheduleId>@<dueInstant>"` (epoch-aligned for intervals; the constant `afterMs` for a
delay), so N pollers cause one firing. Missed firings: `catchUp` = `latest` (default) / `all`
/ N, always caught up by one authority.

External event ingestion deduplicates on `source + externalEventId` (durable payload
fingerprint): `accepted` / `duplicate` / `EVENT_ID_CONFLICT` (same id, different payload) /
`unidentified` (no stable id → at-least-once). An id is **never synthesised** from a
timestamp, an instance id or a UUID.

Subscription cursors: per-subscription monotonic `sequence` (no cross-subscription order),
fenced + monotonic advancement (`fenced` / `stale-sequence`), reconnect from the durable
cursor through any authority.

Cache coherence: durable revision observation — each entry records `observedRevision`,
re-checked against `persistence.revision()` before every authoritative read → staleness
bound **0** revisions; correctness does not depend on broadcast. `CACHE_COHERENCE` states it.

State coherence (spec12.1): a running authority's in-memory `StateDef` is an
**authority-local cache** of persisted truth, not an independent store. The durable revision
is re-observed before **every** authoritative operation (`handle(SnapshotRequest)`, action
invocation, trigger / scheduled / event action, transaction start); a behind authority
reloads the persisted state so it executes from a coherent revision. A transaction begins
from the revision it will commit against. After a lost optimistic race the losing
invocation returns `CONCURRENCY_CONFLICT` (no silent replay) **and** the authority reloads
the winning state — it never stays wedged. `localRevision` is monotonic. No sticky-session
routing and no application `reloadState()` call are required. Sync `snapshot()` / `getState()`
are the local view as of the last request; `coherentSnapshot()` and the protocol
`SnapshotRequest` reconcile first. `inspectDistributedSemantics().stateCoherence` states it.

Version skew: the **compatibility key** is `{ schemaVersion, schemaFingerprint,
serverContract, semanticFingerprint }`, compared **fail-closed**. `semanticFingerprint`
(core, versioned) hashes executable meaning — action bodies, operations, triggers, policies,
queries, expression defs — and excludes names / UI / routes / themes / metadata / order;
distinct from `schemaFingerprint`. Durable work is stamped with its creator's key; an
authority whose key differs refuses to claim it (`INCOMPATIBLE_AUTHORITY`). Migration
ownership stays 0.11 host-controlled — no second coordination system.

Providers advertise capabilities (`distributed-lease`, `fencing`, `atomic-work-claim`,
`durable-retry`, `event-dedup`, `durable-subscription-cursor`, `revision-observation`); a
missing one **fails explicitly**, never a silent single-node fallback. Portable
`axiom.conformance.v6` fixtures (`conformance/distributed/`) + `runCoordinationConformanceSuite`.
Server IR stays `axiom.server.v7`.

Diagnostics: `WORK_IN_PROGRESS` `WORK_FENCED` `WORK_NOT_CLAIMABLE` `INCOMPATIBLE_AUTHORITY`
`EVENT_ID_CONFLICT`.

## LIVE QUERIES

Full model: [`LIVE_QUERIES.md`](LIVE_QUERIES.md).

A **`QueryDef` result observed over time**. `server.openLiveQuery({ queryId, arguments?,
credential? })` → `AsyncIterable<LiveQueryMessage> & { subscriptionId, cursor(), close() }`.
Messages: `initial` (coherent result + revision) → `update` (a `LiveQueryDelta`) / `reset`
(whole result) / `error` (last result stands) / `closed`. The application writes **no**
transport, polling, broadcast, fan-out, sticky routing or diffing.

Capability (`queryLiveCapability`, `AgentAPI.analyzeLiveQuery`): `live-capable` (incremental
`insert`/`remove`/`update`/`move`, keyed by the source entity's identity field);
`live-capable-reset-only` (aggregate / grouped / no identity field → whole `reset`s);
`not-live-capable` (reads `now` / `uuid` → `openLiveQuery` returns `LIVE_QUERY_NOT_CAPABLE`).

Delta model (`@cynodia/axiom-core`: `diffResults` / `applyDelta` / `rowKey`): recompute-and-
compare, correctness before minimal diff. `key` = stringified identity value. `move` only for
a real relative-order change (LCS of surviving keys), never an index shift from an
insert/remove above. `insert`/`move` carry a target index into the final result. Applying
`initial` + the stream reproduces a fresh one-shot `QueryDef` execution exactly — the
conformance oracle.

Invalidation: conservative static dependency set (`queryDependencies`) — source entity, used
relationship endpoints, read-policy entity; an unresolved `ref` → `broad` (re-evaluate on
every commit). Local commits wake the engine synchronously; a **remote** commit — a
`StateDef` *or* a `provider-record` mutation — is seen through the **observable application
revision**, projected from two durable sources re-observed on an interval (`liveQueryPollMs`,
default 250): `stateRevision` (`persistence.revision()`, StateDef commits) and
`dataGeneration` (Σ of each provider's `observedMutationGeneration()`, advanced **atomically
inside `applyMutations`**). `server.revisionInspection()` → `{ applicationRevision,
stateRevision, dataGeneration }` (kept distinct). No broadcast, no sticky routing, no Redis.
Every `provider-record` mutation committed through an Axiom `ActionDef` (insert / update /
delete) participates — a `StateDef` "sync pulse" is **not** required. A non-Axiom write
straight to the provider store is not observed until the next Axiom commit (documented
limit). `DataProvider.capabilities.mutationObservation` = `'durable'` (SQLite) /
`'in-process'` (memory) / `'none'`; `openLiveQuery` on a writable `'none'` provider is
refused `LIVE_QUERY_PROVIDER_NOT_OBSERVABLE`.

QueryDef scope: a query clause (and a `ReadPolicy` predicate) may reference `ref(rowScopeId)`
/ parameters / relationship binds / `PRINCIPAL` / nested iteration scopes — **not** a
`StateDef`. A `StateDef` ref is `QUERY_STATE_REF_NOT_ALLOWED` at `validateGraph` /
`compileToServerIR`; `analyzeLiveQuery` → `not-live-capable` +
`dependencies.unsupportedStateRefs`; runtime guards a hand-built IR. Bind a runtime-varying
value as a query **parameter**.

Authorization: `ReadPolicy` + principal bound into every re-evaluation; a row that becomes
invisible leaves as `remove` / `reset`; unauthorized data never retained past one
re-evaluation. Reconnect re-establishes it from scratch.

Reconnect: `server.resumeLiveQuery(cursor, { queryId, ... })` through **any** compatible
authority; first message is a `reset` at the current revision — a replay gap always resolves
as a `reset`. Cursor = `axiom.live-query-cursor.v1`, server-sent, **no ACK**, HMAC-sealed,
fail-closed on query / principal / arguments / policy (`LIVE_QUERY_CURSOR_INVALID`) or
schema / semantic / contract (`LIVE_QUERY_CURSOR_INCOMPATIBLE`); a presentation-only change
still resumes.

Delivery: at-least-once logical, update identity `(subscriptionId, toRevision)`;
per-subscription monotonic-by-revision order, nothing across subscriptions; intermediate
revisions may be coalesced; slow consumer bounded (`maxPendingChanges`, default 256 →
collapse to one `reset`). Physical network delivery is the transport adapter's to describe.

Transport: `serveLiveQueryChannel(server, channel)` + `createLiveQueryChannelClient(channel)`
pump the handle over any duplex frame channel (`open`/`resume`/`close` ⇄
`message`/`error`/`closed`); `createInMemoryChannelPair()` for tests / worker transport. Not
application code, not normative.

Portable tier: `axiom.conformance.v7` (`conformance/live/`), `runLiveQueryConformanceFixture`
/ `runLiveQueryConformanceSuite`. Server IR stays `axiom.server.v7`.

Diagnostics: `LIVE_QUERY_NOT_CAPABLE` `LIVE_QUERY_CURSOR_INVALID`
`LIVE_QUERY_CURSOR_INCOMPATIBLE` `LIVE_QUERY_EVALUATION_FAILED`
`LIVE_QUERY_PROVIDER_NOT_OBSERVABLE` `QUERY_STATE_REF_NOT_ALLOWED`.

## DURABLE WORKFLOWS

Full model: [`WORKFLOWS.md`](WORKFLOWS.md).

A `WorkflowDef` (graph node kind `workflow`) is a long-running semantic computation with a
**durable control position** — not a background promise, a persisted callback, a job-queue
entry, a cron task, a mutable JSON blob or a process-local listener. No application script
body. Server IR `axiom.server.v8`; a graph with no workflow compiles to the byte-identical
v1–v7 it always did and its `semanticFingerprint` is unchanged.

Steps (six, portable): `action` (invoke an `ActionDef` under the workflow principal;
`onError` edge; `retry` policy), `wait-event` (wait for a matching canonical `EventDef`;
`where` predicate, `bind` → single-assignment bindings, `timeout` + `onTimeout`), `timer`
(`after: {seconds}` / `at: Expression`, target captured once), `branch` (deterministic
`when` → `then`/`else`), `complete` (→ `completed`, `output`), `fail` (→ `failed`, `error`).
Acyclic — `validateGraph` rejects a control-flow cycle.

Expression scope (closed): `ref(<input id>)`, `ref(<binding id>)`, `ref('EVENT')` (only in a
`wait-event` `where`/`bind`), `ref('PRINCIPAL')`. **Not** a `StateDef`
(`WORKFLOW_EXPRESSION_SCOPE`), **not** a `QueryDef`, **not** `now`/`uuid`/`random`
(`WORKFLOW_NONDETERMINISTIC`). Model dynamic state as an `ActionDef` before a branch.

Start: `server.startWorkflow({ workflowId, arguments, credential, idempotencyKey })` →
`{ instanceId, status }`. Idempotent on `(workflowId, principalFingerprint, idempotencyKey,
compatibilityFingerprint)` — a retry after a lost response is one logical instance. The
principal is bound; every action step runs as it and re-evaluates current authorization.

Identity: `instanceRevision` (monotone durable) + a coordination `fence` — every transition
is a CAS `R + fence → R+1`, atomic, check *inside* the write transaction. `activationId` =
`"<stepId>#0"` (a future loop feature revisits without changing instance identity). Action
invocation identity = `"<instanceId>/<activationId>"`, used as the `ActionDef` request id so
a crash between "action committed" and "transition recorded" reconciles rather than
double-executing. **Exactly-once logical transition** per activation; **not** exactly-once
physical effect execution (effect system governs that; logical effect identity is stable
across workflow retries).

Event waits: the durable wait registration (`eventId`, correlation, `sinceEventSeq`) commits
in the *same* transition — no "waiting then subscribe" gap. Driven by Axiom's single inbound
event pipeline; startup/failover replays a match that landed in a crash window from
`sinceEventSeq`; existing dedup means a wait transitions at most once; fanout (a match
unblocks every independently-matching instance, never global consume). Event vs timeout:
exactly one wins on `instanceRevision`.

Timers: target instant computed once on activation and stored — a restart does not
recompute `now + after`. Physically at-least-once firing, logically exactly-once transition.
The waiting row *is* the timer.

Retries: `retry: { maxAttempts, initialDelaySeconds, backoffMultiplier, maxDelaySeconds }`.
Retryable vs terminal is structured, never message-string parsing. Attempt count +
`nextEligibleAt` are durable (authority death does not reset). Lease/fencing → one current
executor.

Cancellation: `server.cancelWorkflow(instanceId, credential)` — idempotent, a fenced durable
transition to `cancelled`. **Authorized**: `credential` is resolved and its principal
fingerprint must match the one the instance was started under, else `AUTHORIZATION_DENIED`
with **no** mutation (no `instanceRevision`, no history, no wake); resolves the same on any
authority. Already-terminal cancellation stays idempotent for any caller. **Not** rollback
(committed actions / dispatched effects stand; no auto-compensation). A later timer/event
does not transition a terminal instance. Terminal states are durable and irreversible; a
stale authority cannot resurrect one.

Multi-authority: leaderless. Any compatible authority advances any eligible instance;
per-instance lease+fence (reused 0.12 `CoordinationProvider`); stale owner refused. Startup
discovers runnable / retry-due / timer-due / recoverably-waiting instances and advances them
— the application does **not** scan stuck workflows, call `resumeWorkflow`, or re-register
timers/waits. Same logical outcome at 1 or N authorities.

Compatibility (safety boundary, not deployment metadata): an instance durably records the
`AuthorityCompatibilityKey` at creation. `semanticFingerprint` covers `WorkflowDef`
executable meaning — **changing a step's `action` / `event` target, argument or `where`
expression, `retry` policy, `timer` duration, `branch` predicate, `complete`/`fail` output,
or any control-flow edge (`next` / `then` / `else` / `onError` / `onTimeout` / `entry`), or
the body of a referenced `ActionDef` / `EventDef`, makes existing in-flight instances
incompatible with the new build.** An incompatible authority fails closed *before* any
semantic step — no transition, no `ActionDef` invoke, no event/timer/branch, no
`instanceRevision` advance — and leaves the instance for a compatible authority; it is never
auto-failed or auto-cancelled, and `cancelWorkflow` from an incompatible build is refused.
Presentation-only changes (`name` / `description` / `label`) and step declaration order are
**not** semantic. A semantically identical fresh process recovers instances normally. There
is no workflow instance migration in 0.14.

Totality: every surface that inspects / validates / compiles / admits / executes a
`WorkflowDef` is total over malformed input. `validateGraph` / `AgentAPI.validate` /
`AgentAPI.analyzeWorkflow` / `compileToServerIR` produce a structured diagnostic (or
structured `Error`), never a native `TypeError`, for a `null` / non-object step, a
non-array `steps` / `inputs` / `bindings`, or an unknown step kind. A hand-tampered Server
IR is refused at admission — `createAxiomServer` / `createWorkflowEngine` throw
`WorkflowIRError` (`WORKFLOW_INVALID_IR`) — for those container shapes **and** for broken
references (a `bind` to an undeclared binding, a `producedBy` to a non-step, a `ref` outside
the closed workflow scope, a `now`/`uuid`/`random` call). Unknown references are invalid,
never silently dropped; an admitted workflow can never wedge permanently `running` on one.

Inspection: `server.getWorkflow(instanceId)` / `inspectWorkflows(limit)` — `status`,
`currentStepId`, `activationId`, `attempt`, `waitingReason`, `nextEligibleAt`,
`instanceRevision`, `failure`, `output`, `compatible` /
`incompatibleReason: 'incompatible-build'` (no secrets). `server.workflowHistory(instanceId)`
— the durable transition log. `AgentAPI.analyzeWorkflow(workflowId)` — static: inputs, steps
+ edges, action/event dependencies, terminal outcomes, acyclicity, possible wait reasons.

`WorkflowStore`: `createMemoryWorkflowStore()` (single process), `createSqliteWorkflowStore({
location })` (cross-process — `BEGIN IMMEDIATE`, check inside the transaction, `busy_timeout`,
`CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` init). Portable tier
`axiom.conformance.v8` (`conformance/workflow/`), `runWorkflowConformanceFixture` / `Suite`.

Diagnostics (validation): `WORKFLOW_ENTRY_NOT_FOUND` `WORKFLOW_STEP_NOT_FOUND`
`WORKFLOW_DUPLICATE_STEP_ID` `WORKFLOW_INVALID_STEP` `WORKFLOW_CYCLE_NOT_ALLOWED`
`WORKFLOW_ACTION_NOT_FOUND` `WORKFLOW_EVENT_NOT_FOUND` `WORKFLOW_BINDING_NOT_FOUND`
`WORKFLOW_DUPLICATE_BINDING` `WORKFLOW_INVALID_RETRY_POLICY` `WORKFLOW_INVALID_TIMER`
`WORKFLOW_UNREACHABLE_STEP` `WORKFLOW_NO_TERMINAL` `WORKFLOW_EXPRESSION_SCOPE`
`WORKFLOW_NONDETERMINISTIC`.

## AUTHORIZATION

Full model: [`AUTHORIZATION.md`](AUTHORIZATION.md). **0.15 is phased.** Phase B added the
vocabulary, `validateGraph` totality, the single semantic projection and `axiom.server.v9`.
**Phase C (this build) enforces `ActionDef.authorizationPolicy`** — one `authorize()`
evaluator on every `action.invoke` path (direct call, workflow action step, scheduler- and
event-triggered action, retry, failover), conjoined with any legacy `ActionDef.authorization`
expression, re-evaluated on every invocation against current policy. **Phase D enforces
`QueryDef.authorizationPolicy` (`query.read`)** — the same evaluator gates a one-shot query,
a `query` operation inside an action and a live-query open, before any provider call;
`ReadPolicyDef` still filters rows, AND-ed into the effective filter so `filter`/`sort`/
`limit`/aggregate see only the authorized dataset. **Phase E** — `WorkflowDef.startPolicy`
decides `workflow.start` (a denied start creates no instance), `instanceAccessPolicy`
decides `workflow.cancel` / `.inspect` / `.history` when declared; with none, cancel keeps
the spec14pt6 owner-fingerprint baseline and `getWorkflow` / `inspectWorkflows` /
`workflowHistory` stay operator-inspection APIs (an explicit trust boundary, not on the
protocol). Unauthorized inspection ⇒ `undefined` / `[]` (no existence leak); terminal
cancel stays idempotent for any caller. **Phase F** — a live query re-checks `query.read`
against the **re-resolved** caller on every re-evaluation, so a revoked principal stops the
stream (`{ kind: 'error', code: 'AUTHORIZATION_DENIED' }`); the current caller drives row
filtering, so lost/gained access to a row is a `remove`/`insert` delta; `resumeLiveQuery`
re-resolves + re-authorizes and refuses a cursor issued for a different principal.
`subscription.open` (`SubscriptionDef`) is an infrastructure trust boundary — no graph
policy, the adapter contract is the boundary. Every graph-defined `AuthorizationPolicyDef`
reference is now enforced; `AUTHORIZATION_ENFORCEMENT_UNAVAILABLE` /
`usesUnenforcedAuthorizationVocabulary` are the dormant fail-closed extension point
(spec4 §4).

One authorization language. An `AuthorizationPolicyDef` (graph node kind
`authorization-policy`) is a single boolean `allow` `Expression`. Exactly `true` ⇒ ALLOW;
`false`, an absent policy, or **any** evaluation error ⇒ DENY (fail closed). Closed
expression scope — the three reserved ids exported from core: `ref(PRINCIPAL)`
(`'axiom_principal'`, the id `ActionDef.authorization` already uses), `ref(RESOURCE)`
(`'axiom_resource'` — for `action.invoke`, a `{ id, kind }` descriptor), `ref(OPERATION)`
(`'axiom_operation'` — resolves to the canonical operation string). **Not** a `StateDef`
(`AUTHORIZATION_INVALID_SCOPE`), **not** a `QueryDef`, **not** `now`/`uuid`/`random`
(`AUTHORIZATION_NONDETERMINISTIC`). Referenced by id: `ActionDef.authorizationPolicy`
(`action.invoke`), `QueryDef.authorizationPolicy` (`query.read`, distinct from `readPolicyId`
row filtering), `WorkflowDef.startPolicy` (`workflow.start`),
`WorkflowDef.instanceAccessPolicy` (`workflow.inspect`/`.history`/`.cancel`). Legacy
`ActionDef.authorization` (an `Expression`) and `ReadPolicyDef` coexist; when both a policy
and a legacy expression are present the effective decision is their conjunction. Canonical
operation ids: `AUTHORIZATION_OPERATIONS`. The pure ALLOW/DENY combiner is
`decideAuthorization` (core).

`AuthorizationPolicyDef` is in `EXECUTABLE_KINDS` — editing `allow` from ALLOW to DENY moves
`semanticFingerprint` and the `AuthorityCompatibilityKey`; a `name`/`description` change
does not; a graph with **no** authorization vocabulary compiles to the byte-identical v1–v8
document it always did. Totality: every validate/compile/analyze surface is total over a
`null` / non-object policy / non-plain `allow` — structured diagnostic, never a native
`TypeError`.

Static analysis: `AgentAPI.analyzeAuthorization()` → what protects every action / query /
workflow surface, per-policy dependencies + a secret-free rule `summary`, the `unprotected`
list (surfaces with no explicit boundary), and per-workflow `privilegeReviewActions`
(policy-carrying action steps the start principal is not statically proven to satisfy). It
never claims authorization it cannot prove and exposes no runtime secret. Primitive:
`authorizationPolicyDependencies(policy)` (core).

Conformance: `axiom.conformance.v9` (`conformance/authorization/`),
`runAuthorizationConformanceFixture` / `Suite` — a compiled Server IR + principals +
provider rows + a deterministic driver script, each step carrying the independently-computed
decision; verified over memory and SQLite.

Diagnostics (validation): `AUTHORIZATION_INVALID_POLICY` `AUTHORIZATION_INVALID_SCOPE`
`AUTHORIZATION_NONDETERMINISTIC` `AUTHORIZATION_UNKNOWN_POLICY`. Runtime refusal:
`AUTHORIZATION_DENIED` — `details.operation` (`action.invoke` / `query.read` /
`workflow.start` / `workflow.cancel`) + `details.reason`
(`policy-denied`/`policy-error`/`legacy-denied`/`legacy-error`/`owner-mismatch`), terminal,
not retryable, carries no state value / credential / claim. A denied `query` operation
inside an action surfaces as `QUERY_OPERATION_FAILED` with `details.code =
'AUTHORIZATION_DENIED'` and rolls the action back. A denied `workflow.inspect` /
`workflow.history` returns `undefined` / `[]` (no existence leak).

## Metadata classes

```ts
metadata: { [AUTHORING_METADATA_KEY]: { … }, tracked: true }
//          ↑ stripped from every compiled artifact       ↑ kept
```

Authoring metadata describes how a node was authored, never how it executes. Stripped from
client IR, server IR and the generated page by default; `compileToIR(graph, {
includeAuthoringMetadata: true })` keeps it for a tool. Nothing may branch on it at run time.

## Renderability

```ts
validateGraph(graph, { renderer: BROWSER_RENDERER_CAPABILITIES });  // UNSUPPORTED_UI_NODE_KIND
compileToIR(graph);                                                 // applies it by default
```

A UI node kind is only in the contract if a renderer implements it. A renderer publishes
`{ target, supportedUiKinds }` and must implement everything it publishes.

Capabilities describe **node-kind** support, not partial support: a renderer cannot yet say
that it draws a kind but not one of its options. Nothing in the current vocabulary needs that,
and it is a deliberate future extension rather than an oversight.

The same gate exists for client-authority triggers, since the browser trigger runtime
implements no `TriggerSpec.kind` at all:

```ts
validateGraph(graph, { triggerRuntime: BROWSER_TRIGGER_CAPABILITIES });  // CLIENT_TRIGGER_UNSUPPORTED
compileToIR(graph);                                                     // applies it by default
```

`CLIENT_TRIGGER_UNSUPPORTED`'s message states the remediation, not only the refusal: move
the trigger's target action to server authority, or compile for a trigger runtime that
publishes the kind (`compileToIR(graph, { triggerRuntime })`). Full model:
[`TRIGGERS.md`](TRIGGERS.md#where-a-trigger-executes).

## Named expressions

```ts
graph.addNode<ExpressionDef>({
  id: X_LOW_STOCK,
  kind: 'expression',
  name: 'Low stock',
  parameters: [{ id: P_SOURCE, valueType: collectionType(entityType(E_PRODUCT)) }],
  expression: filter(ref(P_SOURCE), SC, binary('lte', field(ref(SC), F_STOCK), ref(S_THRESHOLD))),
});

expressionRef(X_LOW_STOCK, { [P_SOURCE]: ref(S_PRODUCTS) })   // in any number of consumers
```

- **MUST** supply every declared parameter; an unsupplied one is `MISSING_EXPRESSION_ARGUMENT`.
- **MUST NOT** reach the caller's scope from the body. It resolves parameters and state only.
- A definition that reaches itself is `EXPRESSION_DEF_CYCLE`.
- Dependencies are graph edges: `agent.getExpressionConsumers(id)`, `agent.getExpressionDependencies(id)`, and a consumer's read edges include everything the definition reads — so an answer does not change because a calculation was given a name.

## Serialization

The whole graph, theme included, is JSON. `graph.serialize()` /
`ApplicationGraph.deserialize()` round-trip losslessly.

No construct anywhere in the graph may hold a function. There is no `formatter: fn`, no
`validator: fn`, no stored closure, and no way to add one. Values are cloned with
`structuredClone`, not a JSON round trip, so `NaN` is not disguised as `null`.
