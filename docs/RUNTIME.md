# Runtime

Axiom 0.5.1-alpha.1. The runtime executes an `ApplicationIR`. It is domain-independent: it
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
  inputValidation?: 'immediate' | 'deferred',   // default 'immediate'
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
}
```

Memory-host helpers for driving and inspecting a rendered tree: `findAll`, `findByNodeId`,
`findByTag`, `textOf`, `typeInto`, `toggle`, `click`, `submit`. Every rendered element
carries `data-node="<node id>"`.

## API

| Member | Governed | Semantics |
| --- | --- | --- |
| `start()` | — | Subscribes to path changes and renders. Idempotent. |
| `render()` | — | Re-renders from current state. |
| `getState(id)` | — | A **deep clone** of the value. Derived state is recomputed. |
| `invokeAction(id, args?)` | **yes** | Runs the action as a transaction. Returns `{ ok, diagnostics }` for that invocation. |
| **`hydrateState(id, value)`** | **NO** | Replaces a state value outright. See below. |
| `navigate(path)` | — | Changes route. |
| `currentRoute()` | — | `{ route, parameters } \| null`. |
| `diagnostics()` | — | Every diagnostic reported so far. |
| `clearDiagnostics()` | — | Empties the running log. |
| `getMutationLog()` | — | Every attempted mutation, with source, path and outcome. |
| `registerNativeOperation(id, fn)` | — | Registers an implementation for a `native` operation. |

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

## Rendering

- Rendering is a **full re-render** on every state change. Focus and caret position are restored by node id.
- Only generic HTML elements are emitted: `div` `span` `form` `label` `input` `select` `option` `textarea` `button`, plus the landmark and heading elements a UX role or text role implies (`header` `footer` `nav` `main` `aside` `section` `h1` `h2` `h3`).
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

### Operations, routing, UI

| Code | Meaning | Typical source | `details` |
| --- | --- | --- | --- |
| `UNSUPPORTED_OPERATION` | An operation kind the runtime does not execute. | action | — |
| `ROUTE_NOT_FOUND` | A `navigate` operation naming an unresolvable route. | action | — |
| `NATIVE_OPERATION_MISSING` | No implementation registered for an `implementationId`. | `native` operation | — |
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
