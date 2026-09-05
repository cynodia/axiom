# Runtime

Axiom 0.16.0-alpha.2. The runtime executes an `ApplicationIR`. It is domain-independent: it
contains no knowledge of any application.

## Constructing

```ts
import { compileToIR } from '@cynodia/axiom';
import { createAxiomRuntime, createBrowserHost, createMemoryHost } from '@cynodia/axiom';

const app = createAxiomRuntime({
  ir: compileToIR(graph),
  rootElement,                     // a DomElement
  host,                            // a HostEnvironment
  nativeOperations?: Record<string, (inputs) => unknown>,
  remote?: RemoteGateway,                       // required for server-authoritative state,
                                                // and required *before* start()
  inputValidation?: 'immediate' | 'deferred',   // DEFAULT: 'immediate'
  recordMutationValues?: boolean,               // default true
});
app.start();
```

`compileToIR(graph)` throws `GraphValidationError` on an invalid graph. Pass
`{ validate: false }` only to inspect an IR you already know is broken.

## Hosts

The runtime takes its whole environment through a `HostEnvironment` and reads nothing from
globals.

| Host | Use |
| --- | --- |
| `createBrowserHost()` | A real page. Used by the generated HTML. |
| `createMemoryHost({ path?, confirm?, storage? })` | Headless. An in-memory DOM, deterministic `now()` and `uuid()`, recorded confirmations. |

`createMemoryHost` is framework code, not test scaffolding: the same renderer that drives a
page can be driven with no browser and no jsdom.

```ts
interface HostEnvironment {
  document: DomDocument;
  getPath(): string;
  pushPath(path: string): void;
  onPathChange(listener: () => void): void;
  confirm(message: string): boolean;
  confirmRequest?(request: ConfirmationRequest): boolean;   // preferred when available
  now(): string;
  uuid(): string;
  storage?: { read(key): string | null; write(key, value): void };
  report?(message: string): void;
  queryIntegration?(operationId: string, args, options: { timeoutMs? }): Promise<IntegrationQueryOutcome>;
}
```

`queryIntegration` is only ever called by the authoritative runtime executing an
`integration-query` operation. A browser host never implements it: no client-compiled
action ever contains one, because integrations default server-only. See
[`INTEGRATIONS.md`](INTEGRATIONS.md).

Memory-host helpers for driving and inspecting a rendered tree: `findAll`, `findByNodeId`,
`findByTag`, `textOf`, `typeInto`, `toggle`, `click`, `submit`. Every rendered element
carries `data-node="<node id>"`.

## API

| Member | Governed | Semantics |
| --- | --- | --- |
| `start()` | — | The whole startup sequence: render, restore, then load authoritative state. Returns a promise; awaiting it means authoritative state has been applied. Idempotent. See [Startup](#startup). |
| `render()` | — | Re-renders from current state. |
| `getState(id)` | — | A **deep clone** of the value. Derived state is recomputed. |
| `invokeAction(id, args?)` | **yes** | Runs the action as a transaction. Returns `{ ok, diagnostics }` for that invocation. |
| **`hydrateState(id, value)`** | **NO** | Replaces a state value outright. See below. |
| `navigate(path)` | — | Changes route. |
| `currentRoute()` | — | `{ route, parameters } \| null`. |
| `diagnostics()` | — | Every diagnostic reported so far. |
| `clearDiagnostics()` | — | Empties the running log **and** every recorded action outcome. |
| `getActionOutcome(id)` | — | The outcome of that action's most recent invocation. See below. |
| `getMutationLog()` | — | Every attempted mutation, with source, path and outcome. |
| `getEffectIntents()` | — | Every `integration-effect` intent recorded so far — a log distinct from the mutation log, because an effect is not a state mutation. See [`EFFECTS.md`](EFFECTS.md). |
| `registerNativeOperation(id, fn)` | — | Registers an implementation for a `native` operation. |
| `invokeActionAsync(id, args?)` | **yes** | Awaits the outcome, including an authority's answer. For an action with a top-level `integration-query` operation, this is also what awaits the query itself — see [`INTEGRATIONS.md`](INTEGRATIONS.md). |
| `syncAuthoritativeState()` | — | Loads the authoritative snapshot and applies it. Idempotent; may be called at any time. See [`AUTHORITY.md`](AUTHORITY.md). |
| `authoritativeStateLoaded()` | — | Whether a snapshot has been applied. `false` also after a failed load, which is why it is not the same question as "is this collection empty". |
| `settled()` | — | Resolves when no remote invocation is outstanding. An action started by a click or a form submit leaves no promise for a caller to hold; this is how to wait for it without guessing a delay. |
| `evaluate(expression)` | — | Evaluates in the root scope, reporting rather than throwing. A pure read. |
| `evaluateWithBindings(expression, bindings)` | — | Evaluates with extra ids bound in scope, keyed by id. How a trigger's `arguments`/`enabledWhen` resolve `ref()` of the trigger's own id to read an event payload. |

### `hydrateState` bypasses semantic enforcement

```ts
app.hydrateState(STATE_ORDERS, orders);
```

It **does not** evaluate preconditions, entity constraints or transition constraints. It is
an administrative facility for hosts, tests and seeding, and is deliberately not named like
a normal write.

It does still pass through the mutation subsystem: a write to derived state is refused,
values are frozen on entry, and the write is logged with source `system`.

Application behaviour belongs in actions and input bindings, which are governed.

## Action diagnostics

The runtime records the outcome of each action's **most recent invocation**, which is what a
`diagnostic` UI node presents.

```ts
app.getActionOutcome(ACTION_CONFIRM_ORDER);
// { actionId, outcome: 'ok' | 'failed' | 'cancelled', diagnostics }
```

| Event | `outcome` | `diagnostics` |
| --- | --- | --- |
| The invocation was refused | `'failed'` | that invocation's diagnostics |
| The invocation succeeded | `'ok'` | empty |
| A required confirmation was declined | `'cancelled'` | empty |

- The record is **replaced** by the next invocation of the same action, whatever its outcome. There is no accumulation.
- It is cleared by `clearDiagnostics()` and by **navigating to another route** — a refusal is about the screen that produced it.
- `'ok'` and `'cancelled'` both carry no diagnostics, so a region presenting the action shows nothing after either. They are distinguished because the difference matters: `cancelled` means a person declined, not that the action was refused.
- A refusal that happens before a transaction opens — a missing parameter, a failed precondition — is recorded like any other. The runtime re-renders after every top-level invocation, so a refusal reaches the screen without the application arranging it.
- Diagnostics are **ephemeral runtime state**. They are not application state, are never persisted, and cannot be written.

`inputValidation` is unrelated: it governs per-keystroke input writes, not action outcomes.

## Input validation mode

`inputValidation` **defaults to `'immediate'`**, in `createAxiomRuntime` and therefore in
every generated page.

| | `'immediate'` (default) | `'deferred'` |
| --- | --- | --- |
| Entity constraints per keystroke | evaluated against proposed state | **not** evaluated |
| A write that breaks a hard invariant | rolled back; the control re-renders with what is stored | accepted into state until the next action |
| Transition constraints | always evaluated | always evaluated |
| `INPUT_REJECTED` | reported when a write is refused | reported only for a transition refusal |
| `aria-invalid` on the control | set when its last write was refused | same |

In both modes a write rooted in a `draft` or `ephemeral` state is unguarded per keystroke,
and transition constraints still apply.

## Rendering

- Rendering is a **full re-render** on every state change, and after every top-level action invocation. Focus and caret position are restored by **render instance**, so focus stays in the row it was in.
- Only generic HTML elements are emitted: `div` `span` `form` `label` `input` `select` `option` `textarea` `button`, plus the landmark and heading elements a UX role or heading level implies (`header` `footer` `nav` `main` `aside` `section` `h1`…`h6`).
- Every element carries `data-node` (the semantic node) and, inside a `repeat`, `data-instance` (this rendering of it). Renderer-generated ids and relationships are keyed by the instance — see [`UI.md`](UI.md#render-instances).
- The renderer emits semantic class names and **no inline styles**. What a class means is decided by the theme stylesheet.
- `MutationResult.affectedLocations` is recorded but not yet used for fine-grained updates.

## Emitting a page

```ts
const html = compileToHtml(graph, { title?, appearance? });
const css = createThemeStylesheet(theme);
```

The page is self-contained: the normalized IR as JSON, the runtime source inlined, a
two-line bootstrap, and the generated stylesheet. It resolves no modules at run time and
loads nothing over the network. `globalThis.__AXIOM_APP__` is the running runtime.

## Diagnostic codes

Public vocabulary. Match on `code`; never parse a message. Every code below is reachable.

```ts
interface RuntimeDiagnostic {
  code: RuntimeDiagnosticCode;
  message: string;
  severity: 'error' | 'warning';
  nodeId?; fieldId?; actionId?; constraintId?; stateId?; location?; transactionId?;
  details?: Record<string, unknown>;
}
```

### Action lifecycle

| Code | Meaning | Typical source | `details` |
| --- | --- | --- | --- |
| `ACTION_NOT_FOUND` | No action with that id. | `invokeAction`, an `invoke` operation | — |
| `PARAMETER_MISSING` | A `required` action parameter was absent. | `invokeAction` | — |
| `PRECONDITION_FAILED` | A guard was not satisfied. Nothing was mutated. | action | `preconditionIndex`, `failureMode` |
| `POSTCONDITION_FAILED` | A postcondition was not satisfied. Rolled back. | action | — |

### State rules

| Code | Meaning | Typical source | `details` |
| --- | --- | --- | --- |
| `CONSTRAINT_VIOLATION` | An entity constraint failed, or could not be evaluated. | any governed write | `entityId`, `instance` (when entity-scoped) |
| `TRANSITION_CONSTRAINT_VIOLATION` | A change a transition constraint forbids. | any governed write | `transitionConstraintId`, `entityId`, `identity`, `previousValue`, `proposedValue`, and `source` when the write came from an input |
| `REQUIRED_FIELD_MISSING` | A `required` field is absent from an instance. | schema conformance | — (`nodeId` is the entity, `fieldId` the field) |
| `ENUM_VALUE_INVALID` | A value outside the declared enum. | schema conformance | — |
| `TYPE_MISMATCH` | A `number` or `boolean` field holding something else. | schema conformance | — |

### Expressions

| Code | Meaning | Typical source | `details` |
| --- | --- | --- | --- |
| `UNRESOLVED_REFERENCE` | A `ref` that resolved to nothing. | any evaluation | `targetId` |
| `UNSUPPORTED_EXPRESSION` | An unknown expression kind, binary operator or function name. | any evaluation | `kind`, `operator` or `function` |
| `EXPRESSION_EVALUATION_FAILED` | Any other evaluation failure — most often a collection operator applied to `null`, or `sum` over a non-number. | any evaluation | `collectionOperator` and `received`, or `member` |

### Mutations

| Code | Meaning | Typical source | `details` |
| --- | --- | --- | --- |
| `LOCATION_RESOLUTION_FAILED` | A write path could not be resolved — usually a collection item the selector did not match. | `set`, `insert`, input | — |
| `MUTATION_FAILED` | A mutation failed for any other reason. | mutation engine | — |
| `DERIVED_STATE_WRITE` | An attempt to write derived state. The write did not occur. | any write path | — |
| `UNKNOWN_STATE` | An attempt to write a state that does not exist. | any write path | — |
| `INPUT_REJECTED` | **Warning.** An input write was rolled back; the control kept its previous value. Accompanied by the violation that caused it. | input binding | `source: 'input'` |
| `SERVER_STATE_WRITE` | A local write was attempted against state whose authority is the server. It did not occur — through any path, `hydrateState` included. | any write path | — |

### Operations, routing, UI

| Code | Meaning | Typical source | `details` |
| --- | --- | --- | --- |
| `UNSUPPORTED_OPERATION` | An operation kind the runtime does not execute. | action | — |
| `ROUTE_NOT_FOUND` | A `navigate` operation naming an unresolvable route. | action | — |
| `NATIVE_OPERATION_MISSING` | No implementation registered for an `implementationId`. | `native` operation | — |
| `REMOTE_ACTION_UNAVAILABLE` | An action belonging to the authority was invoked with no gateway configured, or the transport failed. | remote invocation | — |
| `AUTHORITY_UNREACHABLE` | **Warning.** `start()` could not load authoritative state: no answer from the authority. The page renders with what it has, and `authoritativeStateLoaded()` stays false. | startup | — |
| `INTEGRATION_UNAVAILABLE` | An `integration-query` operation ran, but the host has no `queryIntegration` capability configured. | `integration-query` | — |
| `INTEGRATION_TIMEOUT` | An integration query did not answer within its declared `timeoutMs`. | `integration-query` | `operationId` |
| `INTEGRATION_RESULT_INVALID` | A provider's response did not conform to the operation's declared `resultType`. | `integration-query` | `operationId` |
| `INTEGRATION_QUERY_FAILED` | An integration query failed for any other reason. Never carries a provider secret. | `integration-query` | `operationId`, `retryable` |
| `BLOB_STORAGE_UNAVAILABLE` | No host capable of reaching an object store is configured. Only the authoritative runtime ever reaches one. | `blob-metadata` | `storageId` |
| `BLOB_METADATA_FAILED` | A `blob-metadata` lookup failed: no such key, a still-staged object, or the store refused. The store's own code is in `details.code` rather than replacing the diagnostic code — a provider's vocabulary is not Axiom's. | `blob-metadata` | `storageId`, `code` |
| `QUERY_RESOLVER_UNAVAILABLE` | A `query` operation ran but no data provider is reachable — a bare client runtime, or an authority with no `DataProvider` registered. A `query` operation makes its action server-authority, so a client-compiled action never contains one. | `query` operation | `queryId` |
| `QUERY_OPERATION_FAILED` | A `query` operation's registered query failed to execute. The provider's own code is in `details.code`. Never carries a provider secret. | `query` operation | `queryId`, `code` |
| `UI_NODE_MISSING` | A child id that is not a UI node in the IR. | render | — |
| `UNSUPPORTED_UI_NODE` | An unknown UI node kind. | render | — |
| `PERSISTED_STATE_UNREADABLE` | **Warning.** A stored value could not be parsed; the initial value was used. | startup | — |

### Reading them

```ts
const result = app.invokeAction(CONFIRM_ORDER);
if (!result.ok) {
  const failure = result.diagnostics.find(
    (d) => d.code === RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED,
  );
  failure?.details;   // { preconditionIndex: 2, failureMode: 'insufficient-stock' }
}
```

`invokeAction` returns the diagnostics of **that invocation**; no diffing of global history
is required. `diagnostics()` is the running log, `clearDiagnostics()` empties it.

Two codes are warnings (`INPUT_REJECTED`, `PERSISTED_STATE_UNREADABLE`); the rest are
errors. An error-severity diagnostic reported during an action rolls the action back.

## Mutation log

```ts
app.getMutationLog();
// [{
//   transactionId, source: 'action' | 'ui' | 'system' | 'native', sourceNodeId,
//   operation: 'set' | 'insert' | 'remove',
//   path: { rootStateId, segments },
//   description: 'state_products → [product-1] → field_product_stock',
//   oldValue?, newValue?,
//   outcome: 'committed' | 'rolled-back',
// }]
```

- `outcome` is set when the surrounding transaction settles. Rejected attempts remain, marked `rolled-back`.
- Only the outermost transaction decides an outcome, so the log never suggests that early iterations of a failed loop committed.
- `recordMutationValues: false` omits `oldValue` / `newValue`.

## Startup

`start()` is the whole startup sequence, and it is the same three steps whether or not there
is an authority:

1. **Render**, synchronously, from the client IR's initial values. A page is on screen before any network call.
2. **Restore** persisted client state, where a state declares persistence.
3. **Load authoritative state**, when a gateway is configured — one snapshot request, applied through the ordinary write path, then one re-render.

```ts
const app = createAxiomRuntime({ ir, rootElement, host, remote });
await app.start();              // rendered, restored, synchronized
app.authoritativeStateLoaded(); // true
```

- `start()` returns a promise that settles when step 3 has settled. Not awaiting it is a legitimate choice for a page that renders progressively; the first two steps have already happened synchronously by the time it returns.
- **A gateway must be configured before `start()`.** Adding one afterwards does not retroactively synchronize — call `syncAuthoritativeState()`.
- **A failed load is a diagnostic, not an exception.** `AUTHORITY_UNREACHABLE` is reported, `start()` still resolves, the page still renders, and `authoritativeStateLoaded()` stays `false`. An empty authoritative collection and an unreachable authority are different situations, and the runtime does not conflate them.
- `start()` is idempotent: calling it twice does not re-render twice or fetch twice.

## Reaching an authority

An application with server-authoritative state gives the runtime a gateway:

```ts
const app = createAxiomRuntime({ ir, rootElement, host, remote: createRemoteGateway(transport) });
await app.start();
```

A generated page does this for itself — `compileToHtml` wires the browser-safe gateway into
the bootstrap whenever the IR contains a remote action, so an application author writes no
JavaScript at all. See [`AUTHORITY.md`](AUTHORITY.md#running-one).

`invokeAction` on a remote action returns `{ ok: false, pending: true }` immediately — a
click never blocks on the network — and the outcome arrives through the ordinary
action-outcome lifecycle. While it is outstanding the control that started it renders
`aria-busy` and refuses a second press. Full model: [`AUTHORITY.md`](AUTHORITY.md).

## The browser bundle

The runtime modules are ordinary type-checked TypeScript that import nothing at run time
except each other. `createRuntimeModuleSource()` concatenates their compiled output in
dependency order and strips the module syntax; the compiler inlines that, the IR as JSON,
and a bootstrap into one page.

**The runtime never imports a value from `@cynodia/axiom-core`.** Type-only imports are
erased; a value import would become `undefined` in the browser, and is rejected at build
time with `UnbundledDependencyError`. Anything core computes is resolved during compilation
and carried in the IR — which is why `ApplicationIR` holds `locationTypes`,
`locationRoots`, `locationRequired`, `theme` and `presentation`.
