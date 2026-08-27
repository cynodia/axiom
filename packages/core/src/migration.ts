import type { Expression } from './expressions.js';
import { walkExpression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type { EntityDef, FieldDef, LiteralValue, NodeBase } from './nodes.js';
import type { RelationshipDef } from './relationships.js';
import type { TypeRef } from './type-ref.js';

/**
 * A **semantic migration** between two consecutive schema versions (spec11 §14, §337).
 *
 * `MigrationDef` describes *semantic change* — "Order gains a required `status`, existing
 * records receive `'draft'`"; "`Account.name` becomes `givenName` + `familyName` by this
 * expression". It never describes physical execution: no SQL, no `ALTER TABLE`, no
 * database type names, no callbacks (spec11 §3). A `DataProvider` turns a migration into a
 * physical plan; the graph owns only the meaning (spec11 §127).
 *
 * The set of `MigrationDef` nodes in a graph must form a contiguous chain
 * `1 → 2 → … → graph.schemaVersion`. A gap makes the schema unreachable and is rejected by
 * `validateGraph` and refused at server startup (spec11 §13).
 *
 * Every operation is drawn from a **closed vocabulary of ten** (`MIGRATION_OPERATION_KINDS`,
 * spec11 §15). Record transformations reuse the ordinary Axiom `Expression` tree, evaluated
 * in an isolated scope whose only bindings are the source record (`ref(MIGRATION_OLD_SCOPE,
 * fieldId)`) and any constants the operation declares — never wall-clock, randomness or I/O
 * (spec11 §24, §25, §26).
 */
export interface MigrationDef extends NodeBase {
  kind: 'migration';
  /** The schema version this migration upgrades *from*. */
  fromSchema: number;
  /** The schema version this migration upgrades *to*. MUST equal `fromSchema + 1`. */
  toSchema: number;
  operations: MigrationOperation[];
  /**
   * Whether this migration can be undone (spec11 §61). `irreversible` is the honest default
   * for anything that discards information — Axiom does not synthesize a misleading inverse
   * (spec11 §62). `reverse-supplied` means `reverseOperations` carries an explicit
   * down-migration.
   */
  reversibility?: MigrationReversibility;
  /** An explicit down-migration, present only when `reversibility` is `reverse-supplied`. */
  reverseOperations?: MigrationOperation[];
}

export type MigrationReversibility = 'reversible' | 'irreversible' | 'reverse-supplied';

export const MIGRATION_REVERSIBILITIES: readonly MigrationReversibility[] = [
  'reversible',
  'irreversible',
  'reverse-supplied',
];

/**
 * The reserved scope id that binds one source record while a migration transform expression
 * is evaluated. Read a source field with `field(ref(MIGRATION_OLD_SCOPE), fieldId)`.
 *
 * It is a reserved id in the same family as `PRINCIPAL`: an author may not take it for a
 * graph node or an iteration scope.
 */
export const MIGRATION_OLD_SCOPE: NodeId = 'axiom_migration_old' as NodeId;

/** A named constant available to a migration transform expression, bound in its scope. */
export interface MigrationConstant {
  id: NodeId;
  value: LiteralValue;
}

export type MigrationOperationKind =
  | 'add-entity'
  | 'remove-entity'
  | 'add-field'
  | 'remove-field'
  | 'change-field'
  | 'populate-field'
  | 'transform-field'
  | 'transform-record'
  | 'add-relationship'
  | 'remove-relationship';

/** The complete, closed set of semantic migration operations (spec11 §15). */
export const MIGRATION_OPERATION_KINDS: readonly MigrationOperationKind[] = [
  'add-entity',
  'remove-entity',
  'add-field',
  'remove-field',
  'change-field',
  'populate-field',
  'transform-field',
  'transform-record',
  'add-relationship',
  'remove-relationship',
];

export interface MigrationOperationBase {
  /** Stable within the migration. Named by `approveDestructive` when the operation is destructive. */
  id: NodeId;
  /**
   * The author's explicit acknowledgement that this operation may discard persisted data
   * (spec11 §20). `validateGraph` rejects an operation the classifier proves destructive
   * that does not carry this (`MIGRATION_DESTRUCTIVE_UNMARKED`), and `executeMigration`
   * refuses to run a marked operation without matching `approveDestructive` (spec11 §21).
   */
  destructive?: boolean;
  metadata?: Record<string, unknown>;
}

/** Introduce a new entity (a new provider table / a new persisted state shape). */
export interface AddEntityOperation extends MigrationOperationBase {
  kind: 'add-entity';
  entity: EntityDef;
}

/** Drop an entity and all its rows. Destructive when the entity holds data. */
export interface RemoveEntityOperation extends MigrationOperationBase {
  kind: 'remove-entity';
  entityId: NodeId;
}

/**
 * Add a field to an existing entity. `populate` is **required** when `field.required` is
 * true — an existing row cannot become valid merely because the graph changed, and Axiom
 * does not invent a zero/empty/null value (spec11 §17, §18). `populate` is evaluated over
 * the old record.
 */
export interface AddFieldOperation extends MigrationOperationBase {
  kind: 'add-field';
  entityId: NodeId;
  field: FieldDef;
  populate?: Expression;
  constants?: MigrationConstant[];
}

/** Remove a field. Destructive when non-absent values may exist (spec11 §19). */
export interface RemoveFieldOperation extends MigrationOperationBase {
  kind: 'remove-field';
  entityId: NodeId;
  fieldId: FieldId;
}

/**
 * Change a field's type and/or `required` flag **in place**, keeping the same `FieldId` — a
 * label-only change, or a representation change within the provably-safe set. A change
 * outside the safe set needs `transform-field`; a narrowing change is destructive
 * (spec11 §22, §23).
 */
export interface ChangeFieldOperation extends MigrationOperationBase {
  kind: 'change-field';
  entityId: NodeId;
  fieldId: FieldId;
  to: { valueType?: TypeRef; required?: boolean };
}

/** Fill an existing field for every row from an expression over the old record. */
export interface PopulateFieldOperation extends MigrationOperationBase {
  kind: 'populate-field';
  entityId: NodeId;
  fieldId: FieldId;
  value: Expression;
  constants?: MigrationConstant[];
}

/**
 * Change the stored representation of one field via a typed, deterministic expression over
 * the old record (spec11 §24). `fromType` / `toType` make the intent inspectable and are
 * checked against the field's declared types.
 */
export interface TransformFieldOperation extends MigrationOperationBase {
  kind: 'transform-field';
  entityId: NodeId;
  fieldId: FieldId;
  fromType: TypeRef;
  toType: TypeRef;
  expression: Expression;
  constants?: MigrationConstant[];
}

/**
 * Rewrite a whole record into its new schema representation (spec11 §27). This is the
 * split/merge primitive (spec11 §28): `Account { name }` → `Account { givenName,
 * familyName }` is one `transform-record` with `removesFields: [name]` and
 * `addsFields: [givenName, familyName]`. `produce` is an `object` expression over the old
 * record whose entries replace or add fields; fields not mentioned and not in
 * `removesFields` are carried over unchanged.
 */
export interface TransformRecordOperation extends MigrationOperationBase {
  kind: 'transform-record';
  entityId: NodeId;
  produce: Expression;
  removesFields?: FieldId[];
  addsFields?: FieldId[];
  constants?: MigrationConstant[];
}

/** Introduce a relationship. Integrity is checked when the relationship is `required`. */
export interface AddRelationshipOperation extends MigrationOperationBase {
  kind: 'add-relationship';
  relationship: RelationshipDef;
}

/** Drop a relationship. Metadata-only — no row is rewritten. */
export interface RemoveRelationshipOperation extends MigrationOperationBase {
  kind: 'remove-relationship';
  relationshipId: NodeId;
}

export type MigrationOperation =
  | AddEntityOperation
  | RemoveEntityOperation
  | AddFieldOperation
  | RemoveFieldOperation
  | ChangeFieldOperation
  | PopulateFieldOperation
  | TransformFieldOperation
  | TransformRecordOperation
  | AddRelationshipOperation
  | RemoveRelationshipOperation;

/** Every `Expression` leaf a single operation contains, in no particular order. */
export function migrationOperationExpressions(operation: MigrationOperation): Expression[] {
  switch (operation.kind) {
    case 'add-field':
      return operation.populate ? [operation.populate] : [];
    case 'populate-field':
      return [operation.value];
    case 'transform-field':
      return [operation.expression];
    case 'transform-record':
      return [operation.produce];
    default:
      return [];
  }
}

/** Every `Expression` leaf a migration contains, including its reverse operations. */
export function migrationExpressions(migration: MigrationDef): Expression[] {
  return [
    ...migration.operations.flatMap(migrationOperationExpressions),
    ...(migration.reverseOperations ?? []).flatMap(migrationOperationExpressions),
  ];
}

/** The entity an operation acts on, or `undefined` for relationship operations. */
export function migrationOperationEntityId(operation: MigrationOperation): NodeId | undefined {
  switch (operation.kind) {
    case 'add-entity':
      return operation.entity.id;
    case 'remove-entity':
    case 'add-field':
    case 'remove-field':
    case 'change-field':
    case 'populate-field':
    case 'transform-field':
    case 'transform-record':
      return operation.entityId;
    default:
      return undefined;
  }
}

/** The field ids an operation writes or drops — its persistence-write footprint. */
export function migrationOperationFieldIds(operation: MigrationOperation): FieldId[] {
  switch (operation.kind) {
    case 'add-entity':
      return operation.entity.fields.map((field) => field.id);
    case 'add-field':
      return [operation.field.id];
    case 'remove-field':
    case 'change-field':
    case 'populate-field':
    case 'transform-field':
      return [operation.fieldId];
    case 'transform-record':
      return [...(operation.removesFields ?? []), ...(operation.addsFields ?? [])];
    default:
      return [];
  }
}

/** Field ids a transform expression reads from the old record (`ref(MIGRATION_OLD_SCOPE)`). */
export function migrationOperationReadFieldIds(operation: MigrationOperation): FieldId[] {
  const reads = new Set<FieldId>();
  for (const expression of migrationOperationExpressions(operation)) {
    walkExpression(expression, (node) => {
      if (
        node.kind === 'field' &&
        node.source.kind === 'ref' &&
        node.source.targetId === MIGRATION_OLD_SCOPE
      ) {
        reads.add(node.fieldId);
      }
    });
  }
  return [...reads];
}

/** Migrations ordered by `fromSchema` ascending. */
export function sortMigrations(migrations: readonly MigrationDef[]): MigrationDef[] {
  return [...migrations].sort((a, b) => a.fromSchema - b.fromSchema);
}

/**
 * The contiguous chain of migrations from `from` up to `to`, or `null` if any step is
 * missing or ambiguous (more than one migration for the same `fromSchema`). Used by
 * `validateGraph` and by the server startup gate to resolve a migration path (spec11 §13).
 */
export function migrationPath(
  migrations: readonly MigrationDef[],
  from: number,
  to: number,
): MigrationDef[] | null {
  if (to < from) {
    return null;
  }
  if (to === from) {
    return [];
  }
  const byFrom = new Map<number, MigrationDef[]>();
  for (const migration of migrations) {
    byFrom.set(migration.fromSchema, [...(byFrom.get(migration.fromSchema) ?? []), migration]);
  }
  const path: MigrationDef[] = [];
  for (let version = from; version < to; version += 1) {
    const candidates = byFrom.get(version) ?? [];
    if (candidates.length !== 1) {
      return null;
    }
    const step = candidates[0];
    if (step.toSchema !== version + 1) {
      return null;
    }
    path.push(step);
  }
  return path;
}

// --- Operation builders --------------------------------------------------------
// Migration operations are verbose and their invariants (populate required with a required
// field, stable field id on change-field) are easy to get wrong. These builders are the
// same convenience the `location` and `expression` builders provide; a graph may also be
// authored with plain object literals.

export function addEntity(id: NodeId, entity: EntityDef): AddEntityOperation {
  return { id, kind: 'add-entity', entity };
}

export function removeEntity(
  id: NodeId,
  entityId: NodeId,
  options: { destructive?: boolean } = {},
): RemoveEntityOperation {
  return { id, kind: 'remove-entity', entityId, ...options };
}

export function addField(
  id: NodeId,
  entityId: NodeId,
  field: FieldDef,
  options: { populate?: Expression; constants?: MigrationConstant[] } = {},
): AddFieldOperation {
  return { id, kind: 'add-field', entityId, field, ...options };
}

export function removeField(
  id: NodeId,
  entityId: NodeId,
  fieldId: FieldId,
  options: { destructive?: boolean } = {},
): RemoveFieldOperation {
  return { id, kind: 'remove-field', entityId, fieldId, ...options };
}

export function changeField(
  id: NodeId,
  entityId: NodeId,
  fieldId: FieldId,
  to: { valueType?: TypeRef; required?: boolean },
  options: { destructive?: boolean } = {},
): ChangeFieldOperation {
  return { id, kind: 'change-field', entityId, fieldId, to, ...options };
}

export function populateField(
  id: NodeId,
  entityId: NodeId,
  fieldId: FieldId,
  value: Expression,
  options: { constants?: MigrationConstant[] } = {},
): PopulateFieldOperation {
  return { id, kind: 'populate-field', entityId, fieldId, value, ...options };
}

export function transformField(
  id: NodeId,
  entityId: NodeId,
  fieldId: FieldId,
  spec: {
    fromType: TypeRef;
    toType: TypeRef;
    expression: Expression;
    constants?: MigrationConstant[];
    destructive?: boolean;
  },
): TransformFieldOperation {
  return { id, kind: 'transform-field', entityId, fieldId, ...spec };
}

export function transformRecord(
  id: NodeId,
  entityId: NodeId,
  spec: {
    produce: Expression;
    removesFields?: FieldId[];
    addsFields?: FieldId[];
    constants?: MigrationConstant[];
    destructive?: boolean;
  },
): TransformRecordOperation {
  return { id, kind: 'transform-record', entityId, ...spec };
}

export function addRelationship(id: NodeId, relationship: RelationshipDef): AddRelationshipOperation {
  return { id, kind: 'add-relationship', relationship };
}

export function removeRelationship(id: NodeId, relationshipId: NodeId): RemoveRelationshipOperation {
  return { id, kind: 'remove-relationship', relationshipId };
}
