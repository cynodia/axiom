import { VALIDATION_CODES } from './diagnostics.js';
import type { ValidationIssue, ValidationResult } from './diagnostics.js';
import type { Expression } from './expressions.js';
import { walkExpression } from './expressions.js';
import type { NodeId } from './ids.js';
import type { EntityDef } from './nodes.js';
import type { AnyNode } from './types.js';
import { MIGRATION_OLD_SCOPE, migrationPath } from './migration.js';
import type { MigrationConstant, MigrationDef, MigrationOperation } from './migration.js';
import { canonicalJSON } from './schema-identity.js';
import type { TypeRef } from './type-ref.js';

/**
 * The migration-validation pass (spec11 §77, §78). Runs once over the whole graph, after
 * per-node validation, and reports on:
 *
 * - the migration chain: contiguous from schema 1 to `graph.schemaVersion`, no fork, no
 *   `from == to`, no downgrade, every migration in range;
 * - operation well-formedness: `add-field` of a required field carries a `populate`;
 *   `remove-field`/`remove-entity` are acknowledged `destructive`; `change-field.to` is
 *   not empty; `transform-record.produce` is an `object` expression;
 * - transform purity: no `now`/`uuid` and no scope read other than the old record and the
 *   operation's declared constants (spec11 §25, §26);
 * - transform typing: a `transform-field.toType` matches the field's type in the target
 *   schema (spec11 §77).
 *
 * It deliberately does **not** attempt to reconstruct each intermediate schema version —
 * that is what the compiler's schema-diff coverage check does with the previous graph. This
 * pass catches everything decidable from the target graph and the migration nodes alone.
 */
export function validateMigrations(nodes: readonly AnyNode[], schemaVersion: number): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const migrations = nodes.filter((node): node is MigrationDef => node.kind === 'migration');
  const entities = new Map<NodeId, EntityDef>();
  for (const node of nodes) {
    if (node.kind === 'entity') {
      entities.set(node.id, node);
    }
  }

  // --- Chain shape ----------------------------------------------------------
  const seenFrom = new Map<number, NodeId>();
  for (const migration of migrations) {
    const { fromSchema, toSchema } = migration;
    if (
      !Number.isInteger(fromSchema) ||
      !Number.isInteger(toSchema) ||
      fromSchema < 1 ||
      toSchema !== fromSchema + 1
    ) {
      errors.push({
        code: VALIDATION_CODES.invalidMigrationVersion,
        message: `Migration ${migration.id} declares fromSchema=${fromSchema}, toSchema=${toSchema}; a migration must step one positive integer forward`,
        nodeId: migration.id,
        details: { fromSchema, toSchema },
      });
      continue;
    }
    if (fromSchema >= schemaVersion) {
      errors.push({
        code: VALIDATION_CODES.invalidMigrationVersion,
        message: `Migration ${migration.id} upgrades ${fromSchema}→${toSchema}, but the graph's schemaVersion is ${schemaVersion}`,
        nodeId: migration.id,
        details: { fromSchema, toSchema, schemaVersion },
      });
    }
    const existing = seenFrom.get(fromSchema);
    if (existing) {
      errors.push({
        code: VALIDATION_CODES.migrationChainFork,
        message: `Migrations ${existing} and ${migration.id} both upgrade from schema ${fromSchema}`,
        nodeId: migration.id,
        details: { fromSchema, first: String(existing) },
      });
    } else {
      seenFrom.set(fromSchema, migration.id);
    }
  }

  if (schemaVersion > 1) {
    const path = migrationPath(migrations, 1, schemaVersion);
    if (path === null) {
      errors.push({
        code: VALIDATION_CODES.migrationPathNotFound,
        message: `No contiguous migration chain connects schema 1 to the declared schemaVersion ${schemaVersion}`,
        details: { from: 1, to: schemaVersion },
      });
    }
  }

  // --- Operation ids are globally unique ---------------------------------
  const seenOperationId = new Map<NodeId, NodeId>();
  for (const migration of migrations) {
    for (const operation of [...migration.operations, ...(migration.reverseOperations ?? [])]) {
      const owner = seenOperationId.get(operation.id);
      if (owner) {
        errors.push({
          code: VALIDATION_CODES.duplicateMigrationOperationId,
          message: `Migration operation id ${operation.id} is used by both ${owner} and ${migration.id}`,
          nodeId: migration.id,
          details: { operationId: String(operation.id) },
        });
      } else {
        seenOperationId.set(operation.id, migration.id);
      }
    }
  }

  // --- Per-operation semantics -----------------------------------------
  for (const migration of migrations) {
    for (const operation of migration.operations) {
      validateOperation(operation, migration, entities, errors);
    }
    for (const operation of migration.reverseOperations ?? []) {
      validateOperation(operation, migration, entities, errors);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateOperation(
  operation: MigrationOperation,
  migration: MigrationDef,
  entities: Map<NodeId, EntityDef>,
  errors: ValidationIssue[],
): void {
  switch (operation.kind) {
    case 'add-field': {
      if (operation.field.required === true && operation.populate === undefined) {
        errors.push({
          code: VALIDATION_CODES.migrationRequiredFieldWithoutDefault,
          message: `Migration ${migration.id}: add-field ${operation.field.id} is required but has no populate expression — existing rows cannot be made valid`,
          nodeId: migration.id,
          details: { operationId: String(operation.id), fieldId: String(operation.field.id) },
        });
      }
      if (operation.populate) {
        checkTransformPurity(operation.populate, operation.constants, operation, migration, errors);
      }
      return;
    }
    case 'remove-field':
    case 'remove-entity': {
      if (operation.destructive !== true) {
        errors.push({
          code: VALIDATION_CODES.migrationDestructiveUnmarked,
          message: `Migration ${migration.id}: ${operation.kind} must be marked \`destructive: true\` — dropping persisted data is never silent`,
          nodeId: migration.id,
          details: { operationId: String(operation.id), kind: operation.kind },
        });
      }
      return;
    }
    case 'change-field': {
      if (operation.to.valueType === undefined && operation.to.required === undefined) {
        errors.push({
          code: VALIDATION_CODES.invalidMigrationOperation,
          message: `Migration ${migration.id}: change-field ${operation.fieldId} changes nothing — \`to\` has neither valueType nor required`,
          nodeId: migration.id,
          details: { operationId: String(operation.id) },
        });
      }
      return;
    }
    case 'populate-field': {
      checkTransformPurity(operation.value, operation.constants, operation, migration, errors);
      return;
    }
    case 'transform-field': {
      checkTransformPurity(operation.expression, operation.constants, operation, migration, errors);
      const entity = entities.get(operation.entityId);
      const field = entity?.fields.find((candidate) => candidate.id === operation.fieldId);
      if (field && !typesEqual(field.valueType, operation.toType)) {
        errors.push({
          code: VALIDATION_CODES.migrationTransformTypeMismatch,
          message: `Migration ${migration.id}: transform-field ${operation.fieldId} declares toType that does not match the field's type in the target schema`,
          nodeId: migration.id,
          details: { operationId: String(operation.id), fieldId: String(operation.fieldId) },
        });
      }
      return;
    }
    case 'transform-record': {
      if (operation.produce.kind !== 'object') {
        errors.push({
          code: VALIDATION_CODES.invalidMigrationOperation,
          message: `Migration ${migration.id}: transform-record.produce must be an \`object\` expression`,
          nodeId: migration.id,
          details: { operationId: String(operation.id) },
        });
      }
      checkTransformPurity(operation.produce, operation.constants, operation, migration, errors);
      return;
    }
    case 'add-relationship': {
      if (operation.relationship?.kind !== 'relationship') {
        errors.push({
          code: VALIDATION_CODES.invalidMigrationOperation,
          message: `Migration ${migration.id}: add-relationship carries no relationship definition`,
          nodeId: migration.id,
          details: { operationId: String(operation.id) },
        });
      }
      return;
    }
    case 'remove-relationship': {
      if (!operation.relationshipId) {
        errors.push({
          code: VALIDATION_CODES.invalidMigrationOperation,
          message: `Migration ${migration.id}: remove-relationship names no relationship`,
          nodeId: migration.id,
          details: { operationId: String(operation.id) },
        });
      }
      return;
    }
    default:
      return;
  }
}

/**
 * A migration transform expression may read only the old record (`ref(MIGRATION_OLD_SCOPE)`),
 * the operation's declared constants, and its own nested iteration scopes. It may never call
 * `now` or `uuid` (spec11 §25, §26).
 */
function checkTransformPurity(
  expression: Expression,
  constants: readonly MigrationConstant[] | undefined,
  operation: MigrationOperation,
  migration: MigrationDef,
  errors: ValidationIssue[],
): void {
  const allowed = new Set<NodeId>([MIGRATION_OLD_SCOPE]);
  for (const constant of constants ?? []) {
    allowed.add(constant.id);
  }
  // Nested iteration scopes an operator introduces (filter/find/map/sort/every/some/group)
  // bind their own ids; collect them so a `ref` into one is not flagged.
  walkExpression(expression, (node) => {
    if (
      node.kind === 'filter' ||
      node.kind === 'find' ||
      node.kind === 'map' ||
      node.kind === 'sort' ||
      node.kind === 'every' ||
      node.kind === 'some' ||
      node.kind === 'group'
    ) {
      allowed.add((node as { scopeId: NodeId }).scopeId);
    }
  });

  let impure = false;
  let strayScope: NodeId | undefined;
  walkExpression(expression, (node) => {
    if (node.kind === 'call' && (node.function === 'now' || node.function === 'uuid')) {
      impure = true;
    }
    if (node.kind === 'ref' && !allowed.has(node.targetId)) {
      strayScope = node.targetId;
    }
  });

  if (impure) {
    errors.push({
      code: VALIDATION_CODES.migrationTransformImpure,
      message: `Migration ${migration.id}: a transform expression calls a non-deterministic builtin (now/uuid); migrations must be reproducible (spec11 §26)`,
      nodeId: migration.id,
      details: { operationId: String(operation.id) },
    });
  }
  if (strayScope !== undefined) {
    errors.push({
      code: VALIDATION_CODES.migrationTransformImpure,
      message: `Migration ${migration.id}: a transform expression reads ${strayScope}; it may read only the old record and declared constants`,
      nodeId: migration.id,
      details: { operationId: String(operation.id), scope: String(strayScope) },
    });
  }
}

function typesEqual(a: TypeRef, b: TypeRef): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}

/** Convenience for callers that only need the boolean. */
export function migrationsValid(nodes: readonly AnyNode[], schemaVersion: number): boolean {
  return validateMigrations(nodes, schemaVersion).valid;
}
