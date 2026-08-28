# Validation

Axiom 0.11.0-alpha.1. Validation is authoring-time structural checking. It is not the same
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

105 codes, exported as `VALIDATION_CODES`. Every one is reachable.

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
| `CLIENT_WRITE_TO_SERVER_STATE` | An input bound into server-authoritative state. See [Authority](#authority). |
| `MISSING_ACTION_ARGUMENT` | A control invokes an action without supplying a required parameter. |
| `UNSUPPORTED_UI_NODE_KIND` | A UI node kind the intended renderer cannot draw. |
| `INVALID_DIALOG` | A `dialog` whose declaration cannot produce a usable dialog. |
| `RESERVED_FIELD_ID` | An entity declaring a field id reserved for group results. |
| `INVALID_GROUP_FIELD` | Reading a group field from a non-group, or a non-group field from a group. |
| `UNKNOWN_EXPRESSION_DEF` | An `expression-ref` naming something that is not an expression definition. |
| `EXPRESSION_DEF_CYCLE` | An expression definition that reaches itself. |
| `MISSING_EXPRESSION_ARGUMENT` | An `expression-ref` that omits a declared parameter. |
| `UNKNOWN_EXPRESSION_ARGUMENT` | An `expression-ref` supplying a parameter the definition does not declare. |

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

### Integrations, effects, triggers and events

Full model: [`INTEGRATIONS.md`](INTEGRATIONS.md), [`EFFECTS.md`](EFFECTS.md),
[`TRIGGERS.md`](TRIGGERS.md), [`EVENTS.md`](EVENTS.md).

| Code | Raised when |
| --- | --- |
| `UNKNOWN_INTEGRATION` | An `IntegrationOperationDef.integrationId` that does not resolve to an `integration` node. |
| `UNKNOWN_INTEGRATION_OPERATION` | An `integration-query`/`integration-effect` operation's `operationId` that does not resolve to an `integration-operation` node. |
| `INTEGRATION_OPERATION_MODE_MISMATCH` | An `integration-query` naming an operation whose `mode` is `'effect'`, or an `integration-effect` naming one whose `mode` is `'query'`. |
| `INTEGRATION_ARGUMENT_MISMATCH` | A missing required argument to an integration operation, or an argument it declares no parameter for. |
| `TRIGGER_ACTION_NOT_FOUND` | A `TriggerDef.actionId` that does not resolve to an action. |
| `TRIGGER_INTERVAL_NOT_POSITIVE` | An `interval` trigger's `everyMs`, or a `delay` trigger's `afterMs`, that is not a positive number. |
| `UNKNOWN_EVENT` | An event id that does not resolve to an `EventDef` — a trigger's `eventId`, or an `integration-effect`'s `succeededEventId`/`failedEventId`. |
| `TRIGGER_WRONG_AUTHORITY` | An `event` trigger targeting a client-authority action (only the server dispatches events), or a `route-enter`/`route-leave` trigger targeting a server-authority one (only the client router dispatches those). |
| `TRIGGER_TARGET_SOURCE_MISMATCH` | A trigger — which always invokes with `source: 'system'` — targets an action whose `invocation.allowedSources` excludes `'system'`; the trigger could never succeed (spec 8.1 §3-9). |
| `INVALID_INVOCATION_SOURCE` | `ActionDef.invocation.allowedSources` is present but empty — the action could never be invoked at all. |
| `CLIENT_TRIGGER_UNSUPPORTED` | A client-authority trigger of a kind the intended trigger runtime does not execute — before 8.1 this validated and compiled anyway, and simply never fired (spec 8.1 §31-36). The browser trigger runtime executes no kind today. Only raised when a `triggerRuntime` is actually named — `validateGraph(graph)` with no options is target-neutral and never raises it; `validateForBrowser(graph)`/`compileToIR(graph)` name the real browser capabilities and do (spec 8.2 §2-6). The message states the remediation: move the target action to server authority, or compile for a trigger runtime that publishes the kind. |

### Subscriptions and object storage

Full model: [`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md) and [`STORAGE.md`](STORAGE.md).

| Code | Raised when |
| --- | --- |
| `SUBSCRIPTION_EVENT_UNREACHABLE` | A `SubscriptionDef` whose `eventId` no `TriggerDef{when:{kind:'event'}}` is bound to. Every delivery would be validated and then discarded — a live source feeding nothing. |
| `SUBSCRIPTION_WITHOUT_AUTHORITY` | A `SubscriptionDef` in a graph with no server-authoritative state. Subscriptions are authority-side; nothing would ever activate it. |
| `SUBSCRIPTION_INVALID_POLICY` | A delivery or lifecycle policy that cannot be executed as written: `maxQueued` below one, `maxAttempts` below one, an unknown backpressure policy, or a `deduplicateBy` that is not a field of the event's payload entity. |
| `UNKNOWN_STORAGE` | A blob operation's `storageId`, or a `StorageDef.blobEntityId`, that does not resolve. |
| `INVALID_BLOB_ENTITY` | A `StorageDef.blobEntityId` naming an entity that is not the canonical `blobRefEntity()` shape. The message names the missing fields. |
| `INVALID_BLOB_OPERATION` | A blob operation that cannot execute as written. |

### Semantic data access & query layer (0.10)

Full model: [`QUERIES.md`](QUERIES.md). `validateGraph` rejects a query that could not
execute rather than letting it validate and then fail at the provider (spec 0.10 §83-84).

| Code | Raised when |
| --- | --- |
| `UNKNOWN_QUERY_ENTITY` | A `QueryDef.source`, a `RelationshipDef` endpoint entity, or a `ReadPolicyDef.entityId` that does not resolve to an entity. |
| `UNKNOWN_RELATIONSHIP` | A `QueryRelationshipUse.relationshipId`, or a `query` operation's `queryId`, that does not resolve. |
| `INVALID_RELATIONSHIP` | A `RelationshipDef` whose endpoints are inconsistent — a to-one whose `to.fieldId` is not the target's identity, a to-many whose `from.fieldId` is not the source's identity, an endpoint field that is not on its stated entity, or two link fields of different primitive types. Also a query that traverses a relationship starting from an entity other than its `source`. |
| `UNKNOWN_READ_POLICY` | A `QueryDef.readPolicyId` that does not resolve to a `read-policy` node. |
| `INVALID_READ_POLICY` | A `ReadPolicyDef` with a non-boolean predicate, a missing entity, or a colliding row scope; also a query whose `readPolicyId` governs a different entity than the query's `source`. |
| `DUPLICATE_READ_POLICY` | More than one `ReadPolicyDef` governing the same entity — the effective filter would depend on which the compiler picked. |
| `INVALID_QUERY_PREDICATE` | A `QueryDef.filter` that is not a boolean expression. |
| `INVALID_QUERY_SORT` | A `QuerySortKey` whose projected key is not an orderable type (`string`, `number`, `boolean`, `date`, `datetime`, `enum`). |
| `INVALID_QUERY_PROJECTION` | A projected field that is not on the projection entity, or whose value type is incompatible with the declared field type. |
| `INVALID_QUERY_AGGREGATE` | A `sum`/`average` aggregate over a non-numeric key, a `min`/`max` over an unorderable key, a `count` that carries a key, or an aggregate with no result field. |
| `INVALID_QUERY_GROUPING` | `groupBy` without `aggregate`, or a group key that is not comparable. |
| `INVALID_QUERY_PARAMETER` | A duplicate parameter id, an invalid parameter `TypeRef`, a parameter or relationship bind id colliding with a node, or a non-positive `maxPageSize`. |
| `UNSTABLE_PAGINATION` | Cursor pagination over a source entity with no `identityFieldId` — there is no deterministic tie-breaker, so pages could repeat or skip rows (spec §11). |
| `INVALID_QUERY_OPERATION` | A `query` operation with a missing required argument, or an argument the query declares no parameter for. |
| `INVALID_PROVIDER_RECORD_LOCATION` | A `provider-record` location whose `sourceEntityId` does not resolve, or whose `identityFieldId` is not that entity's identity field. |

### Schema evolution & semantic migrations (0.11)

`validateGraph` rejects an internally inconsistent migration declaration before any
persisted data could be touched (spec11 §77, §78). A graph declares the schema it requires
with `graph.schemaVersion` (a monotonic integer, default `1`); a `MigrationDef` chain must
connect schema 1 to it. A migration transform reads the old record through the reserved
`MIGRATION_OLD_SCOPE` id.

| Code | Raised when |
| --- | --- |
| `INVALID_MIGRATION_VERSION` | A `MigrationDef` whose `fromSchema`/`toSchema` are not consecutive positive integers (`from == to`, a downgrade, or a jump of more than one), or a migration whose `fromSchema` is at or beyond `graph.schemaVersion`. |
| `MIGRATION_PATH_NOT_FOUND` | No contiguous `MigrationDef` chain connects schema 1 to the declared `graph.schemaVersion` — a step is missing (spec11 §13). |
| `MIGRATION_CHAIN_FORK` | Two `MigrationDef` nodes upgrade from the same schema version — the upgrade path would be ambiguous. |
| `DUPLICATE_MIGRATION_OPERATION_ID` | Two migration operations share an `id`; `approveDestructive` could not address them unambiguously. |
| `MIGRATION_REQUIRED_FIELD_WITHOUT_DEFAULT` | An `add-field` operation adds a `required` field with no `populate` expression — existing rows cannot be made valid, and Axiom does not invent a value (spec11 §18). |
| `MIGRATION_DESTRUCTIVE_UNMARKED` | A `remove-field` or `remove-entity` operation not marked `destructive: true` — dropping persisted data is acknowledged, never silent (spec11 §19, §20, §77). |
| `INVALID_MIGRATION_OPERATION` | A structurally malformed operation — an empty `change-field.to`, a `transform-record.produce` that is not an `object` expression, or a relationship operation naming no relationship. |
| `MIGRATION_TRANSFORM_IMPURE` | A migration transform expression that calls `now` or `uuid`, or reads a scope other than the old record (`MIGRATION_OLD_SCOPE`) and the operation's declared constants (spec11 §25, §26). |
| `MIGRATION_TRANSFORM_TYPE_MISMATCH` | A `transform-field` whose declared `toType` does not match the field's type in the target schema (spec11 §77). |

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
| `PRESENTATION_SEMANTIC_CONFLICT` | Declared presentation contradicts what the node it sits on actually is. See below. | warning |
| `DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS` | A destructive action presented as `success` or `informational`. | warning |
| `DESTRUCTIVE_ACTION_UNMARKED` | A bound action removes data but does not declare `destructive`. | warning |
| `MULTIPLE_PRIMARY_ACTIONS` | A form or action group presenting more than one action as primary. | warning |
| `FORM_WITHOUT_PRIMARY_ACTION` | A form with no primary action. | warning |
| `EMPTY_STATE_WITHOUT_RECOVERY_ACTION` | An `empty-state` with nothing to do about it. | warning |
| `EXCESSIVE_HORIZONTAL_ACTIONS` | More than five controls side by side. | warning |
| `RIGID_HORIZONTAL_LAYOUT` | Explicit `wrap: false`, horizontal, 3+ children, no `compact` override. | warning |
| `CONFLICTING_SIZING` | `minWidth` wider than `maxWidth`. | warning |
| `OPAQUE_PRESENTATION` | A node carries `rendererOverrides`, which semantic analysis cannot understand. | warning |

### Authority

The boundary between a client and an authority is structural, so a graph that could let a
client commit authoritative state does not compile. Full model:
[`AUTHORITY.md`](AUTHORITY.md).

| Code | Raised when | Severity |
| --- | --- | --- |
| `CLIENT_WRITE_TO_SERVER_STATE` | An input is bound into server-authoritative state. Bind it to a draft and commit through an action. | error |
| `SERVER_DEPENDS_ON_CLIENT_STATE` | A server action reads, or server state derives from, state the authority does not own. Pass the value as an action parameter. | error |
| `SERVER_ONLY_STATE_OBSERVED` | Something the client receives reads a `serverOnly` state — an input, a derivation, a UI expression. | error |
| `AUTHORIZATION_WITHOUT_PRINCIPAL` | An `authorization` expression with no principal entity declared. **Also raised as a warning** when an application has server state but no action declares authorization, so every caller may invoke everything. | error / warning |
| `PRINCIPAL_REFERENCE_ON_CLIENT` | `PRINCIPAL` is read where a client evaluates, or an `authorization` sits on an action no authority executes. | error |
| `MISSING_ACTION_ARGUMENT` | A `button`, or a `form` submitting without one, invokes an action with a required parameter it never supplies. The invocation would always be refused for a missing argument, so it is refused here instead. | error |
| `INVALID_DIALOG` | A `dialog` with an empty title (no accessible name), an initial focus target outside itself, or a return focus target inside itself. **Also a warning** when a non-modal dialog moves focus on open. | error / warning |
| `RESERVED_FIELD_ID` | An entity declares `field_group_key` or `field_group_items`. Both are reserved for the records a `group` expression returns; an id meaning one thing in one place and another elsewhere would defeat the reason ids exist. | error |
| `INVALID_GROUP_FIELD` | A `field` expression reads a group field from a source that is statically not a group, or reads anything other than the two group fields *from* a group. Read `groupItems` first, then the member's own fields. | error |
| `UNKNOWN_EXPRESSION_DEF` | An `expression-ref` names a node that is not an `ExpressionDef`. | error |
| `EXPRESSION_DEF_CYCLE` | An expression definition reaches itself, directly or through others. The message names the cycle. | error |
| `MISSING_EXPRESSION_ARGUMENT` | An `expression-ref` does not supply a parameter the definition declares. | error |
| `UNKNOWN_EXPRESSION_ARGUMENT` | An `expression-ref` supplies an argument the definition declares no parameter for. | error |
| `UNSUPPORTED_UI_NODE_KIND` | The graph contains a UI node kind the target renderer does not implement. Raised only when `validateGraph` is given a `renderer`; `compileToIR` supplies the browser renderer's capabilities by default. Without it a graph could validate and then render nothing — the failure would surface as a runtime `UNSUPPORTED_UI_NODE` diagnostic instead of an authoring error. | error |
| `INVALID_PRINCIPAL_ENTITY` | `principalEntityId` names something that is not an entity. | error |

### Accessibility

Only structurally determinable checks. Nothing speculative.

| Code | Raised when | Severity |
| --- | --- | --- |
| `FORM_INPUT_MISSING_LABEL` | An input with no `label` and no `accessibleLabel`. | warning |
| `INTERACTIVE_ELEMENT_MISSING_LABEL` | A control with no accessible name — typically an icon-only button. | warning |
| `INVALID_HEADING_STRUCTURE` | A malformed document outline. See below. | warning |

### Semantic conflicts

`PRESENTATION_SEMANTIC_CONFLICT` reports presentation that contradicts the node it sits on.
Every case is decided from the graph alone; none is a heuristic about taste.

| Declared | Why it conflicts |
| --- | --- |
| A control-only `uxRole` (`primary-action`, `secondary-action`, `destructive-action`, `navigation-action`) on a node that is not a button | only a control has a place in the action hierarchy |
| A region `uxRole` (`toolbar`, `sidebar`, `form-section`, `action-group`, `navigation-group`, `content-region`, `header-region`, `footer-region`) on a node that holds no children | there is no group to describe |
| `uxRole: 'navigation-action'` on a button whose action does not navigate — directly or through one level of `invoke` | the control claims to go somewhere |
| `uxRole: 'destructive-action'` on a button whose action declares no destructive intent | the control claims a danger the action does not have |
| `role: 'muted'` on the primary action | the emphasised control is de-emphasised |
| `treatment` other than `plain`, or a `format`, on a node that renders no value | there is nothing to present |
| A `format` whose kind the field's declared type could never be — `currency` on a string, `boolean` on a number, `date` on a boolean | the format cannot describe the value |
| A `control` variant on a node that is not an input | nothing is edited there |
| A numeric `headingLevel` on a node that is not text | only text can be a heading |

Related, and reported under their own codes: a destructive action presented as `success` or
`informational` (`DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS`), and an action that removes data
without declaring `destructive` (`DESTRUCTIVE_ACTION_UNMARKED`).

### Document outline

`INVALID_HEADING_STRUCTURE` is checked on **resolved heading levels**, not on rendered
markup, and only along each view's [primary render path](UI.md#the-primary-render-path) —
so headings in an empty template or a false branch, which are never on screen with the rest,
produce no findings.

Per reachable view, given the levels in render order:

| Reported when | `details` |
| --- | --- |
| The view has headings but none at level 1 | `primaryHeadings: 0` |
| More than one level-1 heading | `primaryHeadings: n` |
| A level more than one deeper than the previous heading — `1` then `3` | `from`, `to` |

A view with no headings at all has no outline to be wrong about and is never reported.
`details.levels` always carries the sequence that was analysed.

Because the check reads `headingLevel`, a value drawn at `display` scale with
`headingLevel: 'none'` — a monetary total, a dashboard statistic — is correctly not part of
the outline. See [`PRESENTATION.md`](PRESENTATION.md#type-scale-and-document-outline).

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
