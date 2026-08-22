import { VALIDATION_CODES } from './diagnostics.js';
import type { ValidationIssue } from './diagnostics.js';
import type { NodeId } from './ids.js';
import type { EntityDef, LiteralValue } from './nodes.js';
import type { TypeRef } from './type-ref.js';

/**
 * Checks a value against a declared `TypeRef`, recursively.
 *
 * One implementation serves two purposes that must not drift apart: seed data checked at
 * authoring time, and **untrusted input checked at the authority boundary**. Network data
 * is untyped, and TypeScript proves nothing about it, so the same walk that catches a
 * mistyped `initialValue` is what rejects a hostile argument.
 *
 * Entity records are keyed by `FieldId`. A record keyed by field *name* is reported as
 * unknown fields plus missing required ones, rather than surfacing later as absent data.
 */
export interface ValueCheckOptions {
  /** Where in the value the walk currently is, for diagnostics. */
  path: string;
  getEntity(id: NodeId): EntityDef | undefined;
  /** When true, a missing required field is allowed — a draft is incomplete by definition. */
  allowIncomplete?: boolean;
}

function describeType(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return type.primitive;
    case 'entity':
      return `a ${type.entityId} record`;
    case 'collection':
      return `a collection of ${describeType(type.itemType)}`;
    case 'optional':
      return `${describeType(type.valueType)} or nothing`;
    case 'enum':
      return `one of ${type.values.join(', ')}`;
    default:
      return 'an unknown type';
  }
}

function describeActual(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'a collection' : typeof value;
}

export function validateValueAgainstType(
  value: unknown,
  type: TypeRef,
  options: ValueCheckOptions,
): ValidationIssue[] {
  const problems: ValidationIssue[] = [];
  const { path } = options;
  const report = (code: string, message: string, extra: Partial<ValidationIssue> = {}): void => {
    problems.push({ code, message, path, ...extra });
  };

  if (type.kind === 'optional') {
    if (value === null || value === undefined) {
      return problems;
    }
    return validateValueAgainstType(value, type.valueType, options);
  }

  if (value === undefined || value === null) {
    report(
      VALIDATION_CODES.initialValueTypeMismatch,
      `${path} is ${value === undefined ? 'missing' : 'null'} but is declared as ${describeType(type)}`,
      { details: { expected: describeType(type), actual: describeActual(value) } },
    );
    return problems;
  }

  switch (type.kind) {
    case 'primitive': {
      const expected =
        type.primitive === 'number' ? 'number' : type.primitive === 'boolean' ? 'boolean' : 'string';
      if (typeof value !== expected) {
        report(
          VALIDATION_CODES.initialValueTypeMismatch,
          `${path} should be a ${type.primitive} but is ${describeActual(value)}`,
          { details: { expected: type.primitive, actual: describeActual(value), value } },
        );
        return problems;
      }
      // `NaN` and the infinities are numbers to JavaScript and nothing to a domain model.
      if (type.primitive === 'number' && !Number.isFinite(value)) {
        report(
          VALIDATION_CODES.initialValueTypeMismatch,
          `${path} should be a finite number but is ${String(value)}`,
          { details: { expected: 'a finite number', value: String(value) } },
        );
      }
      return problems;
    }
    case 'enum': {
      if (typeof value !== 'string' || !type.values.includes(value)) {
        report(
          VALIDATION_CODES.initialValueTypeMismatch,
          `${path} should be one of ${type.values.join(', ')} but is ${JSON.stringify(value)}`,
          { details: { expected: type.values, value } },
        );
      }
      return problems;
    }
    case 'collection': {
      if (!Array.isArray(value)) {
        report(
          VALIDATION_CODES.initialValueTypeMismatch,
          `${path} should be a collection but is ${describeActual(value)}`,
          { details: { expected: describeType(type), actual: describeActual(value) } },
        );
        return problems;
      }
      value.forEach((item, index) => {
        problems.push(
          ...validateValueAgainstType(item, type.itemType, { ...options, path: `${path}[${index}]` }),
        );
      });
      return problems;
    }
    case 'entity': {
      const entity = options.getEntity(type.entityId);
      if (!entity) {
        return problems;
      }
      if (typeof value !== 'object' || Array.isArray(value)) {
        report(
          VALIDATION_CODES.initialValueInvalidEntity,
          `${path} should be a ${entity.name ?? entity.id} record but is ${describeActual(value)}`,
          { details: { entityId: entity.id, actual: describeActual(value) } },
        );
        return problems;
      }
      const record = value as Record<string, LiteralValue>;
      const declared = new Map(entity.fields.map((field) => [String(field.id), field]));

      for (const key of Object.keys(record)) {
        if (!declared.has(key)) {
          report(
            VALIDATION_CODES.initialValueUnknownField,
            `${path}.${key} is not a field of ${entity.name ?? entity.id}. Records are keyed by field id, not by field name.`,
            { details: { entityId: entity.id, key, expected: [...declared.keys()] } },
          );
        }
      }

      for (const field of entity.fields) {
        const present = Object.prototype.hasOwnProperty.call(record, String(field.id));
        if (!present) {
          if (field.required && field.valueType.kind !== 'optional' && !options.allowIncomplete) {
            report(
              VALIDATION_CODES.initialValueMissingRequiredField,
              `${path} is missing required field ${field.name ?? field.id}`,
              { fieldId: field.id, details: { entityId: entity.id, fieldId: field.id } },
            );
          }
          continue;
        }
        problems.push(
          ...validateValueAgainstType(record[String(field.id)], field.valueType, {
            ...options,
            path: `${path}.${field.id}`,
          }),
        );
      }
      return problems;
    }
    default:
      return problems;
  }
}
