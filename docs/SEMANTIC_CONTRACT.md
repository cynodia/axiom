# Semantic contract

Axiom 0.6.0-alpha.1. Runtime guarantees, stated formally. This file defines behavior; it
does not teach. Where this file and any specification in `doc/` disagree, this file
describes the implementation and is authoritative.

`MUST` / `MUST NOT` describe guaranteed behavior. `MAY` describes a documented option.

## State

### Stored state

- A state with no `derivation` is **stored**. Its value lives in the runtime store.
- Stored values MUST be deeply frozen on entry. An assignment to any object read out of the store throws in strict mode.
- `getState` MUST return a deep clone. Mutating the result cannot change application state.
- The store is written in exactly one place. Every write MUST pass through the mutation subsystem.

### Derived state

- A state with a `derivation` is **derived**. It MUST NOT be written by anything.
- A write is rejected at authoring time (`DERIVED_STATE_WRITE` from `validateGraph`) and at runtime (`DERIVED_STATE_WRITE` diagnostic; the write does not occur).
- A derived value MUST be recomputed from its derivation and handed out as a frozen deep copy. It never shares an object with the state it was derived from.
- Derived values are cached. The cache MUST be cleared by every state write and on every route change.
- If a derivation cannot be evaluated, the diagnostic is reported and the value is `null` for that read.

### Draft state

- `draft: true` marks work in progress.
- Draft states MUST be skipped by instance validation (schema conformance and entity constraints).
- An input write rooted in a draft state MUST NOT be guarded per keystroke.
- Transition constraints still apply to any entity instance the write reaches.

### Ephemeral state

- `ephemeral: true` marks presentation state — expanded, selected, open — rather than a domain fact.
- Ephemeral states MUST be skipped by instance validation and MUST NOT be guarded per keystroke, like drafts.
- Declaring `persistence` on an ephemeral state is a validation error (`EPHEMERAL_STATE_PERSISTED`).
- `ephemeral` changes what a state *is*. It MUST NOT change what is permitted: a write that reaches domain state is governed exactly as before.

### Canonical state

- **Canonical** state is stored state that is neither draft nor ephemeral. Instance validation applies to it.
- Canonical state MUST be valid after every governed write. A governed write that would leave it invalid is rolled back.
- Canonical state MAY be invalid on arrival — restored from storage, or seeded by `hydrateState`. Pre-existing invalidity MUST NOT make the rest of the application unwritable: an input write is judged on the violations *it introduces*. An action is stricter and MUST leave the whole application valid.

### Initialization and persistence

Order, per state, at runtime construction:

1. Derived states are skipped.
2. If `persistence.kind === 'local-storage'` and the host provides storage, the stored value is read from `persistence.key ?? "<graphId>:<stateId>"`. An unparseable value reports `PERSISTED_STATE_UNREADABLE` (warning) and falls through.
3. Otherwise `initialValue`, deep-cloned.
4. Otherwise the type default: `optional` → `null`, `collection` → `[]`, `number` → `0`, `boolean` → `false`, other primitive → `''`, `enum` → the first value, `entity` → `null`.

- `persistence.kind: 'memory'` is the default behavior and stores nothing outside the runtime.
- `persistence.kind: 'remote'` validates and **does nothing**. It is declared, not executed.
- A write to a persisted state writes through immediately.

## Transactions

### Boundaries

- An action invocation opens exactly one transaction, **after** parameter binding, preconditions and confirmation have all succeeded. A refusal at any of those stages mutates nothing and opens no transaction.
- An input write opens its own transaction.
- `hydrateState` opens its own transaction.
- A nested transaction (an `invoke` operation) MUST join the outermost open transaction and share its fate. It does not snapshot separately.

### Entry state

- **Entry state** is committed state as it stood immediately before the *outermost* open transaction began.
- Entry state is what a transition constraint means by "previous". It is not the previous operation, and not the previous iteration.

### Provisional state

- Operations execute **sequentially in declaration order** against provisional state.
- Operation N MUST observe the writes of operations `< N`.
- A read inside a transaction reads provisional state, not entry state.

### Commit and rollback

- On commit, every mutation of the transaction becomes committed state.
- On rollback, the store MUST be restored to entry state. Every mutation of the transaction is undone, including mutations made by nested transactions.
- Only the outermost transaction decides an outcome. A nested transaction shares its parent's.
- Every attempted mutation stays in the mutation log with `outcome: 'committed'` or `'rolled-back'`. The log MUST NOT suggest that early iterations of a failed loop committed.

### `for-each`

- The collection expression MUST be evaluated **once**, before any member is mutated.
- Iteration N MUST observe provisional writes from iterations `< N`.
- `for-each` MUST NOT open a transaction of its own.
- A failure in any iteration rolls back every iteration, and the whole enclosing action.
- Nested operations MUST be mutations only (`set`, `insert`, `remove`). Nested iteration, navigation and invocation are not supported.

### Failure aggregation

An action rolls back if any of the following produced an error-severity diagnostic:

1. an operation (including a mutation, an unevaluable expression, a missing native implementation, an unresolvable route);
2. entity constraints or schema conformance over proposed state;
3. transition constraints over entry state → proposed state;
4. postconditions.

All four are evaluated; the action does not stop at the first.

## Mutations

Every state change is a `set`, `insert` or `remove` against a `Location`.

| | Target must address | Missing target |
| --- | --- | --- |
| `set` | any position | a missing **field** is created; a missing **collection item** is `LOCATION_RESOLUTION_FAILED` |
| `insert` | a collection | a non-array current value is treated as `[]`; an unresolvable path is `LOCATION_RESOLUTION_FAILED` |
| `remove` | a collection item | **a selector matching nothing is a no-op**: no mutation, no log entry, no diagnostic |

- A write MUST rebuild the path from the root state. It MUST NOT depend on the identity of an object an expression returned.
- A read through a missing field or a missing collection item yields `null`.
- `insert` appends by default; `position: 'start'` prepends.
- `insert` deep-clones the constructed value before storing it.
- A `native` operation receives cloned inputs and MUST NOT be able to reach into managed state. Its return value is written through the mutation engine with source `native`.

### Write paths

| Path | Source | Preconditions | Entity constraints | Transition constraints |
| --- | --- | --- | --- | --- |
| Action | `action` | yes | yes | yes |
| `for-each` inside an action | `action` | of the enclosing action | yes, once at the end | yes, once at the end |
| Input binding | `ui` | n/a | yes, unless the root state is draft or ephemeral, or `inputValidation: 'deferred'` | **always** |
| `native` result | `native` | of the enclosing action | yes | yes |
| **`hydrateState`** | `system` | **no** | **no** | **no** |

- `hydrateState` still passes through the mutation engine: derived-state writes are refused, values are frozen, and the write is logged. It evaluates no semantics.
- An input write that is refused is rolled back, the violation is reported with `details.source: 'input'`, and an `INPUT_REJECTED` warning names the control that kept its previous value.
- `inputValidation: 'deferred'` turns off the per-keystroke entity-constraint check entirely. Transition constraints are unaffected.

## Constraints

### `ConstraintDef`

- Evaluated after every governed mutation, against **proposed state**.
- With `entityId`: evaluated once per canonical instance of that entity, with the instance bound to `ref(entityId)`.
- Without `entityId`: evaluated once, in the root scope.
- Instances are found by walking every canonical state value against its declared `TypeRef`. An entity nested inside a collection inside another entity MUST be validated where it actually lives.
- `severity: 'error'` (the default) blocks the write. `severity: 'warning'` MUST NOT block any write.
- A constraint that cannot be evaluated MUST count as violated.

### Schema conformance

Evaluated alongside constraints on every canonical instance:

| Check | Code |
| --- | --- |
| A field with `required: true` is present (not `null`/`undefined`) | `REQUIRED_FIELD_MISSING` |
| An `enum` value is one of the declared values | `ENUM_VALUE_INVALID` |
| A `number` field holds a number; a `boolean` field holds a boolean | `TYPE_MISMATCH` |

`required` means present. `0`, `false`, `''` and `[]` all satisfy it.

### `TransitionConstraintDef`

- Evaluated on every governed mutation path, comparing entry state with proposed state.
- The entity MUST declare `identityFieldId`. Without one the rule is **silently skipped**.
- Instances are matched by identity value.
- An instance whose value is unchanged (structurally equal) is skipped.
- A **removed** instance is a transition: `proposedScopeId` is bound to `null`.
- A **newly inserted** instance has no previous state and is **not** evaluated. Govern creation with an action guard or an entity constraint.
- `severity` behaves as for `ConstraintDef`.
- A violation reports `TRANSITION_CONSTRAINT_VIOLATION` with `details`: `transitionConstraintId`, `entityId`, `identity`, `previousValue`, `proposedValue`.

Transition constraints are what make a business rule hold on every governed path. Their
correctness MUST NOT depend on an author remembering not to bind an input to a protected
location.

## Expressions

- Evaluation is pure. An expression MUST NOT change state.
- An expression that cannot be evaluated throws `ExpressionEvaluationError`, which the runtime catches at each boundary — derivation, precondition, constraint, operation, render — and turns into a diagnostic.
- Nothing returns a plausible value alongside a failure diagnostic.
- Collection operators are strict about their source: `null` fails, `[]` behaves normally.
- `sum` fails if any member is not a finite number.
- Values are cloned with `structuredClone`, never a JSON round trip, so `NaN` is not disguised as `null`.

Full per-kind semantics: [`EXPRESSIONS.md`](EXPRESSIONS.md).

## Authority

Full model: [`AUTHORITY.md`](AUTHORITY.md).

- `StateDef.authority` is `'client'` unless declared otherwise, so a graph with no authority metadata behaves exactly as it did in 0.5.x and needs no server.
- A client MUST NOT commit a mutation to server-authoritative state through any path. An input bound into one is a validation error; a runtime write is refused at the store's single write path.
- Where an action executes is **derived** from what it writes, following `for-each`, `invoke` and declared native effects. It is never declared, so it cannot disagree with the action.
- A server action MUST NOT read client-authoritative state, and server state MUST NOT derive from it.
- State marked `serverOnly` MUST be absent from the client IR, from snapshots, and from every answer — along with anything the client receives that reads it.
- An authority MUST resolve an action from its own IR, and MUST NOT accept semantic definitions, operations or validation results from a caller.
- An authority MUST validate arguments against declared parameter types before executing. Network data is untyped input.
- `authorization` is evaluated on the authority, before any guard and before any transaction opens. A rule that cannot be evaluated MUST deny. `requiresConfirmation` is interaction and MUST NOT be treated as authorization.
- The transaction guarantees above hold unchanged on the authority: the same semantic engine executes both halves.
- A semantic transaction MUST persist atomically. An adapter MUST NOT apply a subset of a transaction's writes, and MUST refuse a commit whose expected revisions no longer hold.
- Two actions MUST NOT both commit from incompatible snapshots. The authority serializes execution, and a stale commit is refused with `CONCURRENCY_CONFLICT`.
- A repeated `requestId` MUST be answered from the record rather than executed again.
- Server IR MUST be serializable, deterministic and free of closures, and MUST declare a contract version a runtime can refuse.

**Not guaranteed in 0.6**, and stated so rather than implied: read authorization per caller
or per record, external side effects participating in a transaction, realtime
synchronization, query semantics, and multi-node execution.

## Diagnostics as semantic UI

- The runtime MUST record the outcome of each action's most recent invocation: `'ok'`, `'failed'` or `'cancelled'`, with that invocation's diagnostics.
- The record MUST be replaced by the next invocation of the same action, whatever its outcome. It does not accumulate.
- `'ok'` and `'cancelled'` MUST carry no diagnostics.
- The record MUST be cleared by `clearDiagnostics()` and by navigating to another route.
- A `diagnostic` UI node MUST present the diagnostics of its action's record at or above its own severity, and nothing else.
- Diagnostics are ephemeral runtime state. They are not application state, are never persisted, and cannot be written.
- The runtime MUST re-render after every top-level action invocation, including one refused before a transaction was opened, so a refusal reaches the interface without the application arranging it.
- An application MUST NOT need to duplicate an action's guards, read console output, copy an `ActionResult` into its own state, or install a renderer-specific handler in order to present a refusal.

## Render identity

- A UI node inside a `repeat` is rendered once per member. `NodeId` MUST NOT be used alone to identify a rendered element.
- Every renderer-generated identity and relationship — element id, label association, described-by relationships, error-region ids, control lookup, focus restoration — MUST be keyed by the render instance.
- A rendered identity MUST be unique within the document, deterministic, and stable while the member's identity is stable. Nested repeats MUST compose rather than collide.
- Where the collection's member type carries an identity field, that identity MUST be preferred, so the identity follows a member through reordering. Otherwise a deterministic index is used.
- Refusing a write in one rendered instance MUST NOT affect the accessibility state of another.
- The graph still contains one semantic node. `AgentAPI` reasons about the node, never about instances.

## Presentation

- Presentation MUST NOT affect behavior. Changing presentation or the theme cannot change an action, a constraint, a transition constraint, a location, state or routing.
- Presentation MUST NOT authorize behavior. `visibleWhen`, a hidden responsive override and a `destructive` role are all presentation; none is an authorization decision.
- Resolution precedence is: renderer defaults → theme → inherited → semantic inference → node → responsive. `ResolvedPresentation.origins` records the deciding layer for each property.
- `density` is the only property that inherits from a parent.
- `textRole` decides the type scale. `headingLevel` decides the document outline. Omitted, the level follows the text role (`display` → 1, `title` → 2, `heading` → 3); an explicit level always wins.
- A control's internal arrangement MUST come from the theme, not from node presentation. An ordinary button MUST render correctly with no corrective `layout` or `padding`.
- A token outside the published vocabulary is a validation **error**. Presentation and UX findings are warnings and MUST NOT make a graph invalid.
- A graph with no presentation metadata MUST still render as a usable application.

Full vocabulary and rules: [`PRESENTATION.md`](PRESENTATION.md).

## Diagnostics

- Validation produces `{ valid, errors, warnings }`. `valid` is `errors.length === 0`.
- `compileToIR` throws `GraphValidationError` on an invalid graph unless `{ validate: false }` is passed.
- Runtime diagnostics carry a `code` from `RUNTIME_DIAGNOSTIC_CODES`, a `severity`, and structured `details` where relevant. An agent MUST match on `code`, never on `message`.
- `invokeAction` returns the diagnostics **of that invocation**. `diagnostics()` is the running log; `clearDiagnostics()` empties it.
- The set of codes is public vocabulary. Every declared code is reachable.

Full table: [`RUNTIME.md`](RUNTIME.md#diagnostic-codes).

## Serialization

- The graph, including its theme, is JSON. `serialize()` / `deserialize()` round-trip losslessly.
- No graph construct may hold a function. There is no callback channel of any kind.
- Edges are derived from the current nodes on demand and cannot go stale. `synchronizeEdges` materializes them into graph data; no correctness property depends on calling it.

## Known limits

These are current implementation limits, not design intentions.

- Rendering is a full re-render. Focus and caret are restored by node id. `MutationResult.affectedLocations` is recorded but not used for fine-grained updates.
- Constraints are re-evaluated in full after every action, over every instance found by walking state.
- `for-each` contains mutations only.
- Type inference is deliberately partial: it rejects obvious mismatches and stays silent where a type depends on an iteration scope.
- Iteration scopes are ordinary `NodeId`s; misuse is caught by validation rather than by the type system.
- Remote persistence is declared but not executed.
- There are no asynchronous action semantics, and therefore no loading or pending presentation states.
- Change sets are in memory and per `AgentAPI` instance. There is no semantic version control and no on-disk graph format.
