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
} as const;
