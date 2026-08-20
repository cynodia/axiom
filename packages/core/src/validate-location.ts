import { VALIDATION_CODES } from './diagnostics.js';
import type { ValidationIssue } from './diagnostics.js';
import type { NodeId } from './ids.js';
import { inferLocationType, locationCapabilities } from './infer.js';
import type { SemanticContext } from './infer.js';
import { locationRootStateId } from './location.js';
import type { Location } from './location.js';

export interface LocationValidationOptions {
  /** Node the location belongs to, for diagnostics. */
  ownerId?: NodeId;
  /** Whether the location will be written to. Read-only uses skip writability checks. */
  requireWritable?: boolean;
}

/**
 * Structural validation of a location: does every state, field and selector it names
 * exist, do they fit together, and may it be written to?
 */
export function validateLocation(
  location: Location,
  context: SemanticContext,
  options: LocationValidationOptions = {},
): ValidationIssue[] {
  const problems: ValidationIssue[] = [];
  const ownerId = options.ownerId;
  const report = (code: string, message: string, extra: Partial<ValidationIssue> = {}): void => {
    problems.push({ code, message, ...(ownerId ? { nodeId: ownerId } : {}), ...extra });
  };

  walk(location, context, report);

  if (problems.length === 0 && options.requireWritable) {
    const capabilities = locationCapabilities(location, context);
    if (!capabilities.writable) {
      report(
        VALIDATION_CODES.derivedStateWrite,
        `${locationRootStateId(location)} is derived state and cannot be written to; address the state the value is stored in instead`,
      );
    }
  }

  return problems;
}

type Report = (code: string, message: string, extra?: Partial<ValidationIssue>) => void;

function walk(location: Location, context: SemanticContext, report: Report): void {
  switch (location.kind) {
    case 'state': {
      if (!context.getState(location.stateId)) {
        report(VALIDATION_CODES.unknownStateRef, `Location references unknown state ${location.stateId}`);
      }
      return;
    }
    case 'field': {
      walk(location.target, context, report);
      const entry = context.getField(location.fieldId);
      if (!entry) {
        report(
          VALIDATION_CODES.danglingFieldRef,
          `Location references unknown field ${location.fieldId}`,
          { fieldId: location.fieldId },
        );
        return;
      }
      const parent = inferLocationType(location.target, context);
      const resolved = parent?.kind === 'optional' ? parent.valueType : parent;
      if (!resolved) {
        return;
      }
      if (resolved.kind !== 'entity') {
        report(
          VALIDATION_CODES.fieldOnNonEntity,
          `Field ${location.fieldId} was selected on a ${resolved.kind} value, which has no fields`,
          { fieldId: location.fieldId },
        );
        return;
      }
      if (entry.entityId !== resolved.entityId) {
        report(
          VALIDATION_CODES.fieldNotOnEntity,
          `Field ${location.fieldId} belongs to ${entry.entityId}, not to ${resolved.entityId}`,
          { fieldId: location.fieldId },
        );
      }
      return;
    }
    case 'collection-item': {
      walk(location.collection, context, report);
      const parent = inferLocationType(location.collection, context);
      const resolved = parent?.kind === 'optional' ? parent.valueType : parent;
      if (resolved && resolved.kind !== 'collection') {
        report(
          VALIDATION_CODES.selectorOnNonCollection,
          `An item selector was applied to a ${resolved.kind} value`,
        );
        return;
      }
      if (location.selector.kind !== 'identity') {
        return;
      }
      const entry = context.getField(location.selector.fieldId);
      if (!entry) {
        report(
          VALIDATION_CODES.danglingFieldRef,
          `Item selector references unknown field ${location.selector.fieldId}`,
          { fieldId: location.selector.fieldId },
        );
        return;
      }
      const item = resolved?.kind === 'collection' ? resolved.itemType : undefined;
      const itemType = item?.kind === 'optional' ? item.valueType : item;
      if (itemType?.kind === 'entity' && entry.entityId !== itemType.entityId) {
        report(
          VALIDATION_CODES.identityFieldMismatch,
          `Item selector uses field ${location.selector.fieldId} of ${entry.entityId}, but the collection holds ${itemType.entityId}`,
          { fieldId: location.selector.fieldId },
        );
      }
      return;
    }
    default:
      report(
        VALIDATION_CODES.unknownStateRef,
        `Unknown location kind "${(location as { kind: string }).kind}"`,
      );
  }
}
