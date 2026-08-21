# Validation

Axiom 0.5.1-alpha.1. Validation is authoring-time structural checking. It is not the same
as runtime constraint evaluation — see [`CONSTRAINTS.md`](CONSTRAINTS.md) for the four
layers of correctness.

## Semantics

```ts
const result = validateGraph(graph);
// { valid: boolean, errors: ValidationIssue[], warnings: ValidationIssue[] }
```

- `valid` is `errors.length === 0`. **Warnings never make a graph invalid.**
- `compileToIR(graph)` throws `GraphValidationError` when `valid` is `false`. Its `problems` property carries the errors. `{ validate: false }` skips the check; use it only for diagnostics.
- An invalid graph MUST NOT be executed.

```ts
interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: NodeId;
  fieldId?: FieldId;
  edgeId?: EdgeId;
  path?: string;                        // e.g. 'state_orders[2].field_lines[0]'
  details?: Record<string, unknown>;    // structured context; never parse the message
}
```

Validation resolves **every** reference: nodes, fields, edges, expressions, locations, UI
children, route targets. It also rejects writes to derived state, fields that do not belong
to the addressed entity, selectors and iterations over non-collections, aggregations over
non-numeric collections, and obviously incompatible assignments.

`AgentAPI.validate()` is the same check.

## Codes

49 codes, exported as `VALIDATION_CODES`. Every one is reachable.

### Ids and references

| Code | Raised when |
| --- | --- |
| `DUPLICATE_NODE_ID` | Two nodes share an id. |
| `DUPLICATE_FIELD_ID` | Two entities declare the same field id. |
| `DANGLING_NODE_REF` | A reference to a node that does not exist, or an unknown node kind. |
| `DANGLING_FIELD_REF` | A reference to a field that does not exist, including an identity field an entity does not declare. |
| `INVALID_EDGE_KIND` | An edge with a kind outside `EDGE_KINDS`. |

### Types

| Code | Raised when |
| --- | --- |
| `INVALID_TYPE_REF` | A malformed `TypeRef`, or one naming an unknown entity. |
| `ASSIGNMENT_TYPE_MISMATCH` | A `set` whose value is obviously incompatible with the target. |
| `INVALID_AGGREGATION` | An aggregate over something statically non-numeric, or with no argument. |
| `NOT_A_COLLECTION` | A collection operator over something statically not a collection. |

### Expressions and scopes

| Code | Raised when |
| --- | --- |
| `INVALID_EXPRESSION_REF` | A `ref` to an id that is not a resolvable scope, state, entity or parameter. |
| `UNSUPPORTED_EXPRESSION` | A `call` naming a function that is not built in. |
| `SCOPE_SHADOWING` | An iteration `scopeId` that shadows an enclosing iteration scope. |
| `SCOPE_COLLIDES_WITH_NODE` | An iteration `scopeId` equal to the id of a graph node. |

### Locations and state

| Code | Raised when |
| --- | --- |
| `UNKNOWN_STATE_REF` | A location naming a state that does not exist, or an unknown location kind. |
| `DERIVED_STATE_WRITE` | A write target rooted in derived state. |
| `FIELD_ON_NON_ENTITY` | A field selected on a value that has no fields. |
| `FIELD_NOT_ON_ENTITY` | A field that belongs to a different entity than the one addressed. |
| `SELECTOR_ON_NON_COLLECTION` | An item selector applied to a non-collection. |
| `IDENTITY_FIELD_MISMATCH` | An identity selector using a field of the wrong entity. |
| `INVALID_SELECTOR_TYPE` | An index selector that is statically not a number. |
| `EPHEMERAL_STATE_PERSISTED` | `ephemeral: true` together with `persistence`. |

### Initial values

Recursive, with a `path` naming the position.

| Code | Raised when |
| --- | --- |
| `INITIAL_VALUE_TYPE_MISMATCH` | A seed value of the wrong shape for its declared type. |
| `INITIAL_VALUE_UNKNOWN_FIELD` | A record key that is not a field of the entity — **this is what catches data keyed by field name**. |
| `INITIAL_VALUE_MISSING_REQUIRED_FIELD` | A `required` field absent from a seed record. |
| `INITIAL_VALUE_INVALID_ENTITY` | The type names an entity that does not exist. |

### Actions and operations

| Code | Raised when |
| --- | --- |
| `UNSUPPORTED_OPERATION` | An operation kind outside `OPERATION_KINDS`, or a `for-each` containing something other than a mutation. |
| `INVALID_ACTION_REF` | A button or form naming something that is not an action. |
| `INVALID_STATE_REF` | A reference that must be a state but is not. |

### Constraints

| Code | Raised when |
| --- | --- |
| `MISSING_IDENTITY_FIELD` | A transition constraint on an entity that declares no `identityFieldId`. |
| `UNSUPPORTED_CONSTRAINT_SCOPE` | A constraint scope the runtime cannot evaluate. |

### UI and routing

| Code | Raised when | Severity |
| --- | --- | --- |
| `INVALID_UI_CHILD` | A child id that is not a UI node. | error |
| `INVALID_ROUTE_VIEW` | A route naming something that is not a view. | error |
| `INVALID_ROUTE_PARAMETER` | A route parameter that does not match its path, or vice versa. | error |
| `DUPLICATE_ROUTE_PATH` | Two routes with the same path. | error |
| `UNREACHABLE_UI_NODE` | A UI node not reachable from any route. | **warning** |

### Presentation and UX

One error; the rest are warnings, because a UX judgement is advice and must not stop an
application from compiling.

| Code | Raised when | Severity |
| --- | --- | --- |
| `UNKNOWN_PRESENTATION_TOKEN` | A presentation or theme value, or a property name, outside the published vocabulary. Carries `path`, `details.value` and `details.allowed`. | **error** |
| `PRESENTATION_SEMANTIC_CONFLICT` | Declared presentation contradicts the application's own semantics. | warning |
| `DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS` | A destructive action presented as `success` or `informational`. | warning |
| `DESTRUCTIVE_ACTION_UNMARKED` | A bound action removes data but does not declare `destructive`. | warning |
| `MULTIPLE_PRIMARY_ACTIONS` | A form or action group presenting more than one action as primary. | warning |
| `FORM_WITHOUT_PRIMARY_ACTION` | A form with no primary action. | warning |
| `EMPTY_STATE_WITHOUT_RECOVERY_ACTION` | An `empty-state` with nothing to do about it. | warning |
| `EXCESSIVE_HORIZONTAL_ACTIONS` | More than five controls side by side. | warning |
| `RIGID_HORIZONTAL_LAYOUT` | Explicit `wrap: false`, horizontal, 3+ children, no `compact` override. | warning |
| `CONFLICTING_SIZING` | `minWidth` wider than `maxWidth`. | warning |
| `OPAQUE_PRESENTATION` | A node carries `rendererOverrides`, which semantic analysis cannot understand. | warning |

### Accessibility

Only structurally determinable checks. Nothing speculative.

| Code | Raised when | Severity |
| --- | --- | --- |
| `FORM_INPUT_MISSING_LABEL` | An input with no `label` and no `accessibleLabel`. | warning |
| `INTERACTIVE_ELEMENT_MISSING_LABEL` | A control with no accessible name — typically an icon-only button. | warning |
| `INVALID_HEADING_STRUCTURE` | A view with section headings and no title above them. | warning |

## Reading a result

```ts
const result = validateGraph(graph);
if (!result.valid) {
  for (const problem of result.errors) {
    console.error(`[${problem.code}] ${problem.path ?? problem.nodeId ?? ''} ${problem.message}`);
  }
}
// Warnings are worth reading; they are the UX and accessibility findings.
for (const finding of result.warnings) {
  console.warn(`[${finding.code}] ${finding.message}`);
}
```

`AgentAPI.getPresentationWarnings(viewId?)` narrows the presentation subset to one view.

## What validation does not do

Type inference is deliberately partial (`spec3 §22`): it rejects obvious mismatches and
stays silent wherever a type depends on an iteration scope it cannot resolve. A graph that
validates can still fail at runtime — for example a collection operator over a state that
happens to hold `null`. Those failures are runtime diagnostics, not validation errors.

Validation says nothing about whether an application is *correct*, only whether it is
structurally sound and internally consistent.
