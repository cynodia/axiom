# Agent reference

Axiom 0.8.0-alpha.1. Compressed operational contract. Read this plus the `.d.ts`
declarations before authoring or modifying an Axiom application.

Formal guarantees: [`SEMANTIC_CONTRACT.md`](SEMANTIC_CONTRACT.md). Mistakes that compile:
[`ANTI_PATTERNS.md`](ANTI_PATTERNS.md).

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
const graph = new ApplicationGraph(id, name);      // version defaults to '0.8.0'
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

Builtins (14): `required` `is-empty` `non-empty` `length` `contains` `concat` `coalesce`
`one-of` `count` `sum` `lowercase` `to-string` `now` `uuid`.

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
13. **PORTABILITY** — `axiom.server.v1` is frozen and language-independent.
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
2. **QUERY INVARIANT** — external queries are explicit execution, resolved before the transaction they feed opens — never a pure `Expression`.
3. **EFFECT INVARIANT** — external effects are not rollback-capable state mutations. Reaching `integration-effect` only records intent; the adapter runs only after commit.
4. **OUTBOX INVARIANT** — effect intent is committed atomically with the state write that requested it, before external execution, so a crash between the two does not lose it.
5. **TRIGGER INVARIANT** — a trigger invokes an ordinary action, under exactly the guards, constraints, transition constraints and authorization any other caller is subject to.
6. **EVENT INVARIANT** — an event is a typed fact, validated against its declared payload type before any action sees it; an action is where work happens.
7. **SECRET INVARIANT** — integration credentials live in host configuration (`AxiomServerOptions.integrations`), never in `ApplicationGraph`.

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
- A triggered/event-originated invocation runs with `principal: null`, `source: 'system'` — the same as an anonymous client request, never an impersonated user. Authorization still evaluates.
- `createDeterministicServerHost().advance(ms)` fires due timers deterministically; no trigger test waits on a real clock.

```ts
agent.listIntegrations() / agent.listIntegrationOperations(id?);
agent.getActionsUsingIntegration(id) / agent.getEffectsForAction(actionId);
agent.getTriggersForAction(actionId) / agent.getTimedTriggers();
agent.getActionsTriggeredByEvent(eventId) / agent.getWebhookEvents();
agent.getExternalDependencies();   // { integrations, operations } — the deployment manifest
```

Portable artifacts, for a runtime written in another language:

```
@cynodia/axiom-server/conformance                     the fixture manifest
@cynodia/axiom-server/conformance/<name>.json         one fixture, pure data
@cynodia/axiom-server/schema/server-ir.v1.schema.json JSON Schema for the IR
@cynodia/axiom-server/schema/protocol.v1.schema.json  JSON Schema for the protocol
```

Boundary diagnostics: `UNKNOWN_SERVER_ACTION` `ARGUMENT_TYPE_MISMATCH` `AUTHORIZATION_DENIED`
`CONCURRENCY_CONFLICT` `MALFORMED_REQUEST` `AUTHORITY_UNREACHABLE`, plus `SERVER_STATE_WRITE`
and `REMOTE_ACTION_UNAVAILABLE` on the client.

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
