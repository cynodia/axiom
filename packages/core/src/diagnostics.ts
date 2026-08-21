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
  rigidHorizontalLayout: 'RIGID_HORIZONTAL_LAYOUT',
  conflictingSizing: 'CONFLICTING_SIZING',
  interactiveElementMissingLabel: 'INTERACTIVE_ELEMENT_MISSING_LABEL',
  formInputMissingLabel: 'FORM_INPUT_MISSING_LABEL',
  invalidHeadingStructure: 'INVALID_HEADING_STRUCTURE',
  opaquePresentation: 'OPAQUE_PRESENTATION',
} as const;
