import type { EdgeId, FieldId, NodeId } from './ids.js';

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: NodeId;
  fieldId?: FieldId;
  edgeId?: EdgeId;
  /** Where inside a value the problem is, such as `state_orders[2].field_lines[1]`. */
  path?: string;
  /** Structured context an agent can act on without parsing the message. */
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export const VALIDATION_CODES = {
  duplicateNodeId: 'DUPLICATE_NODE_ID',
  duplicateFieldId: 'DUPLICATE_FIELD_ID',
  danglingNodeRef: 'DANGLING_NODE_REF',
  danglingFieldRef: 'DANGLING_FIELD_REF',
  invalidTypeRef: 'INVALID_TYPE_REF',
  invalidEdgeKind: 'INVALID_EDGE_KIND',
  invalidUiChild: 'INVALID_UI_CHILD',
  invalidActionRef: 'INVALID_ACTION_REF',
  invalidStateRef: 'INVALID_STATE_REF',
  invalidRouteView: 'INVALID_ROUTE_VIEW',
  invalidExpressionRef: 'INVALID_EXPRESSION_REF',
  invalidRouteParameter: 'INVALID_ROUTE_PARAMETER',
  duplicateRoutePath: 'DUPLICATE_ROUTE_PATH',
  missingIdentityField: 'MISSING_IDENTITY_FIELD',
  unreachableUiNode: 'UNREACHABLE_UI_NODE',
  unknownStateRef: 'UNKNOWN_STATE_REF',
  derivedStateWrite: 'DERIVED_STATE_WRITE',
  fieldNotOnEntity: 'FIELD_NOT_ON_ENTITY',
  selectorOnNonCollection: 'SELECTOR_ON_NON_COLLECTION',
  fieldOnNonEntity: 'FIELD_ON_NON_ENTITY',
  identityFieldMismatch: 'IDENTITY_FIELD_MISMATCH',
  assignmentTypeMismatch: 'ASSIGNMENT_TYPE_MISMATCH',
  invalidSelectorType: 'INVALID_SELECTOR_TYPE',
  unsupportedExpression: 'UNSUPPORTED_EXPRESSION',
  unsupportedOperation: 'UNSUPPORTED_OPERATION',
  unsupportedConstraintScope: 'UNSUPPORTED_CONSTRAINT_SCOPE',
  invalidAggregation: 'INVALID_AGGREGATION',
  notACollection: 'NOT_A_COLLECTION',
  initialValueTypeMismatch: 'INITIAL_VALUE_TYPE_MISMATCH',
  initialValueUnknownField: 'INITIAL_VALUE_UNKNOWN_FIELD',
  initialValueMissingRequiredField: 'INITIAL_VALUE_MISSING_REQUIRED_FIELD',
  initialValueInvalidEntity: 'INITIAL_VALUE_INVALID_ENTITY',
  scopeShadowing: 'SCOPE_SHADOWING',
  scopeCollidesWithNode: 'SCOPE_COLLIDES_WITH_NODE',
  ephemeralStatePersisted: 'EPHEMERAL_STATE_PERSISTED',

  // Reusable expressions and grouping.
  /** A `field` read of a group position where the source is not a group, or the reverse. */
  invalidGroupField: 'INVALID_GROUP_FIELD',
  /** An entity declaring one of the reserved group field ids. */
  reservedFieldId: 'RESERVED_FIELD_ID',
  /** An `expression-ref` naming something that is not an expression definition. */
  unknownExpressionDef: 'UNKNOWN_EXPRESSION_DEF',
  /** A definition that reaches itself, directly or through another definition. */
  expressionDefCycle: 'EXPRESSION_DEF_CYCLE',
  /** A parameter the reference does not supply — the body would resolve nothing. */
  missingExpressionArgument: 'MISSING_EXPRESSION_ARGUMENT',
  /** An argument the definition declares no parameter for. */
  unknownExpressionArgument: 'UNKNOWN_EXPRESSION_ARGUMENT',

  // Presentation and UX. Everything here is a warning except an unknown token, which the
  // renderer genuinely cannot act on.
  unknownPresentationToken: 'UNKNOWN_PRESENTATION_TOKEN',
  presentationSemanticConflict: 'PRESENTATION_SEMANTIC_CONFLICT',
  multiplePrimaryActions: 'MULTIPLE_PRIMARY_ACTIONS',
  formWithoutPrimaryAction: 'FORM_WITHOUT_PRIMARY_ACTION',
  destructiveActionPresentedAsSuccess: 'DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS',
  destructiveActionUnmarked: 'DESTRUCTIVE_ACTION_UNMARKED',
  excessiveHorizontalActions: 'EXCESSIVE_HORIZONTAL_ACTIONS',
  emptyStateWithoutRecoveryAction: 'EMPTY_STATE_WITHOUT_RECOVERY_ACTION',
  /** A UI node kind the intended renderer cannot draw. */
  unsupportedUiNodeKind: 'UNSUPPORTED_UI_NODE_KIND',
  /** A dialog whose declaration cannot produce a usable dialog. */
  invalidDialog: 'INVALID_DIALOG',
  rigidHorizontalLayout: 'RIGID_HORIZONTAL_LAYOUT',
  conflictingSizing: 'CONFLICTING_SIZING',
  interactiveElementMissingLabel: 'INTERACTIVE_ELEMENT_MISSING_LABEL',
  formInputMissingLabel: 'FORM_INPUT_MISSING_LABEL',
  invalidHeadingStructure: 'INVALID_HEADING_STRUCTURE',
  opaquePresentation: 'OPAQUE_PRESENTATION',

  // Authority. A graph that cannot execute safely across the trust boundary is rejected
  // rather than left to fail at run time.
  clientWriteToServerState: 'CLIENT_WRITE_TO_SERVER_STATE',
  serverDependsOnClientState: 'SERVER_DEPENDS_ON_CLIENT_STATE',
  authorizationWithoutPrincipal: 'AUTHORIZATION_WITHOUT_PRINCIPAL',
  principalReferenceOnClient: 'PRINCIPAL_REFERENCE_ON_CLIENT',
  serverOnlyStateObserved: 'SERVER_ONLY_STATE_OBSERVED',
  invalidPrincipalEntity: 'INVALID_PRINCIPAL_ENTITY',
  missingActionArgument: 'MISSING_ACTION_ARGUMENT',

  // Integrations, effects, triggers and events.
  /** An `IntegrationOperationDef.integrationId`, or an operation's `operationId`, that does not resolve. */
  unknownIntegration: 'UNKNOWN_INTEGRATION',
  unknownIntegrationOperation: 'UNKNOWN_INTEGRATION_OPERATION',
  /** An `integration-query` operation naming an effect, or an `integration-effect` naming a query. */
  integrationOperationModeMismatch: 'INTEGRATION_OPERATION_MODE_MISMATCH',
  /** A missing required argument, or an argument the operation declares no parameter for. */
  integrationArgumentMismatch: 'INTEGRATION_ARGUMENT_MISMATCH',
  triggerActionNotFound: 'TRIGGER_ACTION_NOT_FOUND',
  triggerIntervalNotPositive: 'TRIGGER_INTERVAL_NOT_POSITIVE',
  /** An event id that does not resolve to an `EventDef` — a trigger's `eventId`, or an effect's success/failure event. */
  unknownEvent: 'UNKNOWN_EVENT',
  /** An `event` trigger targeting a client-authority action, or a `route-enter`/`route-leave` trigger targeting a server-authority one. */
  triggerWrongAuthority: 'TRIGGER_WRONG_AUTHORITY',
  /** A trigger — which always invokes with `source: 'system'` — targets an action whose `invocation.allowedSources` excludes `'system'`; the trigger could never succeed. */
  triggerTargetSourceMismatch: 'TRIGGER_TARGET_SOURCE_MISMATCH',
  /** `ActionDef.invocation.allowedSources` is present but empty — the action could never be invoked at all. */
  invalidInvocationSource: 'INVALID_INVOCATION_SOURCE',
  /** A client-authority trigger of a kind the intended trigger runtime does not execute — it would validate and compile but never fire (spec 8.1 §31-36). */
  clientTriggerUnsupported: 'CLIENT_TRIGGER_UNSUPPORTED',

  // Subscriptions and blob storage (0.9).
  /** A `SubscriptionDef` whose event has no trigger bound to it: a live source feeding nothing. */
  subscriptionEventUnreachable: 'SUBSCRIPTION_EVENT_UNREACHABLE',
  /** A `SubscriptionDef` in a graph with no server authority — nothing would ever activate it. */
  subscriptionWithoutAuthority: 'SUBSCRIPTION_WITHOUT_AUTHORITY',
  /** A delivery or lifecycle policy that cannot be executed as written — a non-positive queue, a dedup field that is not on the payload entity. */
  subscriptionInvalidPolicy: 'SUBSCRIPTION_INVALID_POLICY',
  /** A `StorageDef.blobEntityId`, or a blob operation's `storageId`, that does not resolve. */
  unknownStorage: 'UNKNOWN_STORAGE',
  /** A `StorageDef` whose `blobEntityId` is not the canonical `blobRefEntity()` shape. */
  invalidBlobEntity: 'INVALID_BLOB_ENTITY',
  /** A blob operation that cannot execute as written — inside a `for-each`, or with no readable key. */
  invalidBlobOperation: 'INVALID_BLOB_OPERATION',

  // Semantic data access & query layer (0.10). `validateGraph` rejects a query that could
  // not execute, rather than letting it validate and then fail at the provider.
  /** A `QueryDef.source`, a `RelationshipDef` endpoint entity, or a `ReadPolicyDef.entityId` that does not resolve to an entity. */
  unknownQueryEntity: 'UNKNOWN_QUERY_ENTITY',
  /** A `QueryRelationshipUse.relationshipId`, or a `query` operation's `queryId`, that does not resolve. */
  unknownRelationship: 'UNKNOWN_RELATIONSHIP',
  /** A `RelationshipDef` whose endpoints are inconsistent — a to-one whose `to.fieldId` is not the target's identity, a field not on its stated entity. */
  invalidRelationship: 'INVALID_RELATIONSHIP',
  /** A `QueryDef.readPolicyId` that does not resolve to a `read-policy` node. */
  unknownReadPolicy: 'UNKNOWN_READ_POLICY',
  /** A malformed `ReadPolicyDef` — non-boolean predicate, missing entity, or a scope that collides. */
  invalidReadPolicy: 'INVALID_READ_POLICY',
  /** More than one `ReadPolicyDef` governing the same entity. */
  duplicateReadPolicy: 'DUPLICATE_READ_POLICY',
  /** A `QueryDef.filter` that is not a boolean expression, or reads outside `rowScopeId` / parameters / `PRINCIPAL`. */
  invalidQueryPredicate: 'INVALID_QUERY_PREDICATE',
  /**
   * A `QueryDef` clause or a `ReadPolicyDef` predicate references a `StateDef`. A query
   * executes on the `DataProvider`, which binds no authority state; the reference would
   * evaluate to nothing at run time (spec13.1 F2). Bind a runtime-varying value through a
   * query parameter instead.
   */
  queryStateRefNotAllowed: 'QUERY_STATE_REF_NOT_ALLOWED',
  /** A `QuerySortKey` whose projected key is not an orderable type. */
  invalidQuerySort: 'INVALID_QUERY_SORT',
  /** A projected field that is not on the projection entity, or whose value type is incompatible. */
  invalidQueryProjection: 'INVALID_QUERY_PROJECTION',
  /** A `sum`/`average` aggregate over a non-numeric key, a `count` carrying a key, or a missing `as`. */
  invalidQueryAggregate: 'INVALID_QUERY_AGGREGATE',
  /** `groupBy` without `aggregate`, or a group key that is not comparable. */
  invalidQueryGrouping: 'INVALID_QUERY_GROUPING',
  /** A duplicate parameter id, an invalid parameter `TypeRef`, or a parameter id colliding with a node. */
  invalidQueryParameter: 'INVALID_QUERY_PARAMETER',
  /** Cursor pagination whose ordering is not provably deterministic — no unique key and no usable identity tie-breaker. */
  unstablePagination: 'UNSTABLE_PAGINATION',
  /** A `query` operation used where it cannot execute — inside a `for-each`. */
  invalidQueryOperation: 'INVALID_QUERY_OPERATION',
  /** A `provider-record` location whose entity does not resolve, or whose identity field is not that entity's identity. */
  invalidProviderRecordLocation: 'INVALID_PROVIDER_RECORD_LOCATION',

  // Durable workflows (0.14, spec14 §124). `validateGraph` rejects an internally
  // inconsistent `WorkflowDef` before it can be compiled or executed.
  /** `WorkflowDef.entry` does not name a step of that workflow. */
  workflowEntryNotFound: 'WORKFLOW_ENTRY_NOT_FOUND',
  /** A control-flow edge (`next`/`onError`/`then`/`else`/`onTimeout`) names a step that does not exist. */
  workflowStepNotFound: 'WORKFLOW_STEP_NOT_FOUND',
  /** Two steps in one workflow share an id, or a step id collides with a graph node id. */
  workflowDuplicateStepId: 'WORKFLOW_DUPLICATE_STEP_ID',
  /** A step whose `type` is outside `WORKFLOW_STEP_TYPES`, or whose shape is invalid for its type. */
  workflowInvalidStep: 'WORKFLOW_INVALID_STEP',
  /** The workflow control-flow graph contains a cycle (retries are runtime policy, not a cycle). */
  workflowCycleNotAllowed: 'WORKFLOW_CYCLE_NOT_ALLOWED',
  /** An `action` step references an `action` that does not exist. */
  workflowActionNotFound: 'WORKFLOW_ACTION_NOT_FOUND',
  /** A `wait-event` step references an `event` that does not exist. */
  workflowEventNotFound: 'WORKFLOW_EVENT_NOT_FOUND',
  /** A `bind` / expression names a `WorkflowBinding` the workflow does not declare, or reads one before its producer. */
  workflowBindingNotFound: 'WORKFLOW_BINDING_NOT_FOUND',
  /** Two steps declare themselves the producer of the same binding, or a `bind` assigns a binding twice. */
  workflowDuplicateBinding: 'WORKFLOW_DUPLICATE_BINDING',
  /** A `WorkflowRetryPolicy` with a non-positive `maxAttempts`/`initialDelaySeconds`, a `backoffMultiplier` < 1, or `maxDelaySeconds` < `initialDelaySeconds`. */
  workflowInvalidRetryPolicy: 'WORKFLOW_INVALID_RETRY_POLICY',
  /** A `timer` step with neither `after` nor `at`, both, or a non-positive `after.seconds`. */
  workflowInvalidTimer: 'WORKFLOW_INVALID_TIMER',
  /** A step unreachable from `entry` (spec14 §122 — an authoring mistake, not a warning). */
  workflowUnreachableStep: 'WORKFLOW_UNREACHABLE_STEP',
  /** A control-flow path that can neither reach `complete`/`fail` nor end in an intentional durable wait (spec14 §123). */
  workflowNoTerminal: 'WORKFLOW_NO_TERMINAL',
  /** A workflow expression references an id outside the workflow expression scope (inputs / bindings / EVENT / PRINCIPAL). */
  workflowExpressionScope: 'WORKFLOW_EXPRESSION_SCOPE',
  /** A workflow expression reads a nondeterministic builtin (`now`/`uuid`/`random`) outside captured-time semantics. */
  workflowNondeterministic: 'WORKFLOW_NONDETERMINISTIC',

  // Schema evolution & semantic migrations (0.11). `validateGraph` rejects an internally
  // inconsistent migration declaration before any persisted data is touched (spec11 §77, §78).
  /** A `MigrationDef` whose `fromSchema`/`toSchema` are not consecutive positive integers, or a migration whose `fromSchema` is at or beyond `graph.schemaVersion`. */
  invalidMigrationVersion: 'INVALID_MIGRATION_VERSION',
  /** No contiguous `MigrationDef` chain connects schema 1 to `graph.schemaVersion` — a step is missing (spec11 §13). */
  migrationPathNotFound: 'MIGRATION_PATH_NOT_FOUND',
  /** Two `MigrationDef` nodes share the same `fromSchema` — the upgrade path would be ambiguous. */
  migrationChainFork: 'MIGRATION_CHAIN_FORK',
  /** Two migration operations share an `id` — `approveDestructive` could not address them unambiguously. */
  duplicateMigrationOperationId: 'DUPLICATE_MIGRATION_OPERATION_ID',
  /** An `add-field` operation adds a `required` field with no `populate` expression — existing rows cannot become valid, and Axiom does not invent a value (spec11 §18). */
  migrationRequiredFieldWithoutDefault: 'MIGRATION_REQUIRED_FIELD_WITHOUT_DEFAULT',
  /** A `remove-field` / `remove-entity` / narrowing operation not marked `destructive: true` — dropping persisted data must be acknowledged, never silent (spec11 §19, §20, §77). */
  migrationDestructiveUnmarked: 'MIGRATION_DESTRUCTIVE_UNMARKED',
  /** A structurally malformed migration operation — an empty `change-field.to`, a `transform-record.produce` that is not an `object` expression, a relationship operation with no relationship. */
  invalidMigrationOperation: 'INVALID_MIGRATION_OPERATION',
  /** A migration transform expression that is not pure — it calls `now` or `uuid`, or reads a scope other than the old record and declared constants (spec11 §25, §26). */
  migrationTransformImpure: 'MIGRATION_TRANSFORM_IMPURE',
  /** A `transform-field` whose declared `toType` does not match the field's type in the target schema, or an `add-field` `populate` whose value cannot satisfy the field (spec11 §77). */
  migrationTransformTypeMismatch: 'MIGRATION_TRANSFORM_TYPE_MISMATCH',

  // Authorization completeness (0.15). `validateGraph` rejects a malformed or inconsistent
  // authorization policy before it can be compiled or executed; every failure is structured,
  // never a native exception (spec15 §36, §37, §38).
  /** An `AuthorizationPolicyDef` with no boolean `allow` expression, or a non-object policy value. */
  authorizationInvalidPolicy: 'AUTHORIZATION_INVALID_POLICY',
  /** An `AuthorizationPolicyDef.allow` expression references an id outside the policy scope (`PRINCIPAL` / `RESOURCE` / `OPERATION`). */
  authorizationInvalidScope: 'AUTHORIZATION_INVALID_SCOPE',
  /** An `authorizationPolicy` / `startPolicy` / `instanceAccessPolicy` id that does not resolve to an `authorization-policy` node. */
  authorizationUnknownPolicy: 'AUTHORIZATION_UNKNOWN_POLICY',
  /** An `AuthorizationPolicyDef.allow` expression calls `now` / `uuid` / `random` — authorization must be deterministic (spec15 §34). */
  authorizationNondeterministic: 'AUTHORIZATION_NONDETERMINISTIC',
} as const;
