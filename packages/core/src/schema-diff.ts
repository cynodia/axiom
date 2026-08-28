import { canonicalJSON, schemaProjection } from './schema-identity.js';
import type {
  EntityShape,
  FieldShape,
  ReadPolicyShape,
  RelationshipShape,
  SchemaProjection,
  StateShape,
} from './schema-identity.js';
import type { ApplicationGraph } from './graph.js';
import type { SchemaSource } from './schema-identity.js';
import type { MigrationOperation } from './migration.js';
import { migrationOperationEntityId, migrationOperationFieldIds } from './migration.js';
import type { TypeRef } from './type-ref.js';

/**
 * Static classification of a schema change (spec11 §59, §119). The framework never claims a
 * change is safe when it cannot prove it.
 *
 * - `presentation-only` — nothing persistence-relevant changed. No migration.
 * - `persistence-compatible` — the persisted representation is unchanged or strictly
 *   widened; existing rows remain valid without a rewrite (spec11 §16, §17).
 * - `migration-required` — meaning or representation changed in a way an existing row
 *   cannot satisfy on its own; an explicit `MigrationDef` operation is required.
 * - `destructive` — the change can discard persisted information (spec11 §20).
 * - `incompatible-ambiguous` — the change cannot be classified safely and its intent is
 *   ambiguous (e.g. one field removed and another added — never guessed as a rename,
 *   spec11 §60).
 */
export type SchemaChangeClass =
  | 'presentation-only'
  | 'persistence-compatible'
  | 'migration-required'
  | 'destructive'
  | 'incompatible-ambiguous';

export const SCHEMA_CHANGE_CLASSES: readonly SchemaChangeClass[] = [
  'presentation-only',
  'persistence-compatible',
  'migration-required',
  'destructive',
  'incompatible-ambiguous',
];

const CLASS_SEVERITY: Record<SchemaChangeClass, number> = {
  'presentation-only': 0,
  'persistence-compatible': 1,
  'migration-required': 2,
  destructive: 3,
  'incompatible-ambiguous': 4,
};

export type SchemaDiffEntryKind =
  | 'entity-added'
  | 'entity-removed'
  | 'identity-changed'
  | 'field-added'
  | 'field-removed'
  | 'field-type-changed'
  | 'field-required-changed'
  | 'state-added'
  | 'state-removed'
  | 'state-type-changed'
  | 'state-kind-changed'
  | 'relationship-added'
  | 'relationship-removed'
  | 'relationship-changed'
  | 'read-policy-added'
  | 'read-policy-removed'
  | 'read-policy-moved';

/** One classified difference between two schemas. */
export interface SchemaDiffEntry {
  kind: SchemaDiffEntryKind;
  class: SchemaChangeClass;
  /** `+` added, `-` removed, `~` changed — for a terse rendering (spec11 §58). */
  mark: '+' | '-' | '~';
  entityId?: string;
  fieldId?: string;
  stateId?: string;
  relationshipId?: string;
  readPolicyId?: string;
  /** True when the entry is an authorization-semantic change, not a data-schema change (spec11 §42). */
  authorizationChange?: boolean;
  /** True when the change may discard persisted data. Always set for `destructive`. */
  dataLoss?: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface SchemaDiff {
  fromVersion: number;
  toVersion: number;
  entries: SchemaDiffEntry[];
  /** The most severe class present, or `presentation-only` for an empty diff. */
  verdict: SchemaChangeClass;
  byClass: Record<SchemaChangeClass, number>;
  /** Entries that can discard persisted data. */
  destructive: SchemaDiffEntry[];
  /** Entries a `MigrationDef` operation must cover: `migration-required` + `destructive`. */
  needsMigration: SchemaDiffEntry[];
}

type SchemaInput = SchemaSource | ApplicationGraph;

function typesEqual(a: TypeRef, b: TypeRef): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}

function indexById<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * Classify a change to one field's type (spec11 §22, §23). The provably-safe set is small:
 * an identical type, or a widening to `optional T` of the same inner type, or an enum whose
 * membership only grew. Everything else needs an explicit transformation; a narrowing is
 * destructive.
 */
export function classifyFieldTypeChange(
  from: TypeRef,
  to: TypeRef,
): { class: SchemaChangeClass; dataLoss: boolean } {
  if (typesEqual(from, to)) {
    return { class: 'presentation-only', dataLoss: false };
  }
  // Widen to optional: every existing value is still valid, absence is newly allowed.
  if (to.kind === 'optional' && typesEqual(from, to.valueType)) {
    return { class: 'persistence-compatible', dataLoss: false };
  }
  // Narrow away optional: existing nulls become invalid — needs population/proof.
  if (from.kind === 'optional' && typesEqual(from.valueType, to)) {
    return { class: 'migration-required', dataLoss: false };
  }
  // Enum membership growth is compatible; shrinkage can orphan stored values.
  if (from.kind === 'enum' && to.kind === 'enum') {
    const before = new Set(from.values);
    const after = new Set(to.values);
    const grewOnly = [...before].every((value) => after.has(value));
    if (grewOnly) {
      return { class: 'persistence-compatible', dataLoss: false };
    }
    return { class: 'destructive', dataLoss: true };
  }
  // A change of structural kind (primitive↔collection, entity target, …) always needs an
  // explicit transformation; treat a collapse to a scalar from a collection as lossy.
  if (from.kind === 'collection' && to.kind !== 'collection') {
    return { class: 'destructive', dataLoss: true };
  }
  return { class: 'migration-required', dataLoss: false };
}

function diffFields(entityId: string, before: EntityShape, after: EntityShape): SchemaDiffEntry[] {
  const entries: SchemaDiffEntry[] = [];
  const beforeFields = indexById<FieldShape>(before.fields);
  const afterFields = indexById<FieldShape>(after.fields);

  for (const [fieldId, field] of afterFields) {
    if (!beforeFields.has(fieldId)) {
      entries.push({
        kind: 'field-added',
        class: field.required ? 'migration-required' : 'persistence-compatible',
        mark: '+',
        entityId,
        fieldId,
        message: field.required
          ? `field ${fieldId} added as required — existing rows need a value (spec11 §18)`
          : `field ${fieldId} added as optional`,
      });
    }
  }
  for (const [fieldId, field] of beforeFields) {
    const next = afterFields.get(fieldId);
    if (!next) {
      entries.push({
        kind: 'field-removed',
        class: 'destructive',
        mark: '-',
        entityId,
        fieldId,
        dataLoss: true,
        message: `field ${fieldId} removed — stored values may be lost (spec11 §19)`,
      });
      continue;
    }
    if (!typesEqual(field.type, next.type)) {
      const classified = classifyFieldTypeChange(field.type, next.type);
      entries.push({
        kind: 'field-type-changed',
        class: classified.class,
        mark: '~',
        entityId,
        fieldId,
        dataLoss: classified.dataLoss,
        message: `field ${fieldId} type changed`,
        details: { from: field.type, to: next.type },
      });
    }
    if (field.required !== next.required) {
      entries.push({
        kind: 'field-required-changed',
        class: next.required ? 'migration-required' : 'persistence-compatible',
        mark: '~',
        entityId,
        fieldId,
        message: next.required
          ? `field ${fieldId} became required — existing rows may not satisfy it`
          : `field ${fieldId} became optional`,
      });
    }
  }
  return entries;
}

/**
 * The classified semantic difference between two schemas (spec11 §58). It is **not** a JSON
 * text diff: every entry names the semantic element that changed and carries the class the
 * framework can prove. A pure diff never pairs a removed field with an added one — that is
 * the ambiguous-rename case the author must resolve explicitly (spec11 §60).
 */
export function diffSchema(previous: SchemaInput, next: SchemaInput): SchemaDiff {
  const before = schemaProjection(previous);
  const after = schemaProjection(next);
  const entries: SchemaDiffEntry[] = [];

  // --- Entities & fields -------------------------------------------------
  const beforeEntities = indexById<EntityShape>(before.entities);
  const afterEntities = indexById<EntityShape>(after.entities);
  for (const [entityId, entity] of afterEntities) {
    if (!beforeEntities.has(entityId)) {
      entries.push({
        kind: 'entity-added',
        class: 'persistence-compatible',
        mark: '+',
        entityId,
        message: `entity ${entityId} added`,
      });
      if (entity.fields.some((field) => field.required)) {
        // A brand-new entity with required fields is fine — it has no rows yet.
      }
    }
  }
  for (const [entityId, entity] of beforeEntities) {
    const nextEntity = afterEntities.get(entityId);
    if (!nextEntity) {
      entries.push({
        kind: 'entity-removed',
        class: 'destructive',
        mark: '-',
        entityId,
        dataLoss: true,
        message: `entity ${entityId} removed — all its rows are lost (spec11 §20)`,
      });
      continue;
    }
    if (entity.identityFieldId !== nextEntity.identityFieldId) {
      entries.push({
        kind: 'identity-changed',
        class: 'incompatible-ambiguous',
        mark: '~',
        entityId,
        message: `entity ${entityId} identity field changed — every row's identity is redefined`,
        details: { from: entity.identityFieldId, to: nextEntity.identityFieldId },
      });
    }
    entries.push(...diffFields(entityId, entity, nextEntity));
  }

  // --- Persisted states ------------------------------------------------
  const beforeStates = indexById<StateShape>(before.states);
  const afterStates = indexById<StateShape>(after.states);
  for (const [stateId] of afterStates) {
    if (!beforeStates.has(stateId)) {
      entries.push({
        kind: 'state-added',
        class: 'persistence-compatible',
        mark: '+',
        stateId,
        message: `state ${stateId} added — starts at its type default`,
      });
    }
  }
  for (const [stateId, state] of beforeStates) {
    const nextState = afterStates.get(stateId);
    if (!nextState) {
      entries.push({
        kind: 'state-removed',
        class: state.derived ? 'persistence-compatible' : 'destructive',
        mark: '-',
        stateId,
        dataLoss: !state.derived,
        message: state.derived
          ? `derived state ${stateId} removed — nothing persisted`
          : `state ${stateId} removed — its persisted value is lost`,
      });
      continue;
    }
    if (state.derived !== nextState.derived || state.draft !== nextState.draft) {
      entries.push({
        kind: 'state-kind-changed',
        class: 'migration-required',
        mark: '~',
        stateId,
        message: `state ${stateId} changed kind (derived/draft)`,
        details: {
          from: { derived: state.derived, draft: state.draft },
          to: { derived: nextState.derived, draft: nextState.draft },
        },
      });
    } else if (!typesEqual(state.type, nextState.type)) {
      const classified = classifyFieldTypeChange(state.type, nextState.type);
      entries.push({
        kind: 'state-type-changed',
        class: classified.class === 'presentation-only' ? 'migration-required' : classified.class,
        mark: '~',
        stateId,
        dataLoss: classified.dataLoss,
        message: `state ${stateId} value type changed`,
        details: { from: state.type, to: nextState.type },
      });
    }
  }

  // --- Relationships --------------------------------------------------
  const beforeRels = indexById<RelationshipShape>(before.relationships);
  const afterRels = indexById<RelationshipShape>(after.relationships);
  for (const [relationshipId, rel] of afterRels) {
    if (!beforeRels.has(relationshipId)) {
      entries.push({
        kind: 'relationship-added',
        class: rel.required ? 'migration-required' : 'persistence-compatible',
        mark: '+',
        relationshipId,
        message: rel.required
          ? `relationship ${relationshipId} added as required — referential integrity must be established`
          : `relationship ${relationshipId} added`,
      });
    }
  }
  for (const [relationshipId, rel] of beforeRels) {
    const nextRel = afterRels.get(relationshipId);
    if (!nextRel) {
      entries.push({
        kind: 'relationship-removed',
        class: 'persistence-compatible',
        mark: '-',
        relationshipId,
        message: `relationship ${relationshipId} removed — link metadata only, no row rewritten (spec11 §41)`,
      });
      continue;
    }
    if (canonicalJSON(rel) !== canonicalJSON(nextRel)) {
      entries.push({
        kind: 'relationship-changed',
        class: 'migration-required',
        mark: '~',
        relationshipId,
        message: `relationship ${relationshipId} endpoints or cardinality changed — records may be invalidated (spec11 §41)`,
        details: { from: rel, to: nextRel },
      });
    }
  }

  // --- Read policies (authorization-semantic, not data-schema) ------
  const beforePolicies = indexById<ReadPolicyShape>(before.readPolicies);
  const afterPolicies = indexById<ReadPolicyShape>(after.readPolicies);
  for (const [policyId, policy] of afterPolicies) {
    const prior = beforePolicies.get(policyId);
    if (!prior) {
      entries.push({
        kind: 'read-policy-added',
        class: 'persistence-compatible',
        mark: '+',
        readPolicyId: policyId,
        authorizationChange: true,
        message: `read policy ${policyId} added on ${policy.entityId} — no data rewrite, but visibility changes (spec11 §42)`,
      });
    } else if (prior.entityId !== policy.entityId) {
      entries.push({
        kind: 'read-policy-moved',
        class: 'persistence-compatible',
        mark: '~',
        readPolicyId: policyId,
        authorizationChange: true,
        message: `read policy ${policyId} now governs a different entity`,
        details: { from: prior.entityId, to: policy.entityId },
      });
    }
  }
  for (const [policyId] of beforePolicies) {
    if (!afterPolicies.has(policyId)) {
      entries.push({
        kind: 'read-policy-removed',
        class: 'persistence-compatible',
        mark: '-',
        readPolicyId: policyId,
        authorizationChange: true,
        message: `read policy ${policyId} removed — no data rewrite, but visibility widens (spec11 §42)`,
      });
    }
  }

  const byClass = Object.fromEntries(
    SCHEMA_CHANGE_CLASSES.map((cls) => [cls, 0]),
  ) as Record<SchemaChangeClass, number>;
  for (const entry of entries) {
    byClass[entry.class] += 1;
  }
  const verdict = entries.reduce<SchemaChangeClass>(
    (worst, entry) => (CLASS_SEVERITY[entry.class] > CLASS_SEVERITY[worst] ? entry.class : worst),
    'presentation-only',
  );

  return {
    fromVersion: before.schemaVersion,
    toVersion: after.schemaVersion,
    entries,
    verdict,
    byClass,
    destructive: entries.filter((entry) => entry.class === 'destructive'),
    needsMigration: entries.filter(
      (entry) => entry.class === 'migration-required' || entry.class === 'destructive',
    ),
  };
}

export interface MigrationCoverage {
  covered: boolean;
  /** Diff entries that require a migration operation but have none. */
  uncovered: SchemaDiffEntry[];
  /** Operations that do not correspond to any diff entry. */
  unmatched: MigrationOperation[];
}

/**
 * Whether a set of migration operations accounts for exactly the data-affecting part of a
 * diff (spec11 §5, §60). Every `migration-required` / `destructive` entry must be covered by
 * an operation touching the same entity and field; every operation must correspond to a
 * diff entry. Uncovered entries mean the author forgot a change; unmatched operations mean
 * the migration describes a change the graphs do not contain.
 *
 * This is the primitive the compiler's `validateGraph` coverage check calls with the
 * previous graph, the next graph and `MigrationDef(N → N+1)`.
 */
export function migrationCoversDiff(
  diff: SchemaDiff,
  operations: readonly MigrationOperation[],
): MigrationCoverage {
  const opTargets = operations.map((operation) => ({
    operation,
    entityId: migrationOperationEntityId(operation) ? String(migrationOperationEntityId(operation)) : undefined,
    fieldIds: new Set(migrationOperationFieldIds(operation).map(String)),
    matched: false,
  }));

  const matches = (entry: SchemaDiffEntry, target: (typeof opTargets)[number]): boolean => {
    if (entry.entityId && target.entityId && target.entityId !== entry.entityId) {
      return false;
    }
    if (entry.fieldId) {
      return target.fieldIds.has(entry.fieldId);
    }
    return (
      (entry.entityId !== undefined && target.entityId === entry.entityId) ||
      entry.kind === 'relationship-changed' ||
      entry.kind === 'relationship-added' ||
      entry.kind === 'relationship-removed' ||
      entry.kind === 'state-type-changed' ||
      entry.kind === 'state-kind-changed' ||
      entry.kind === 'entity-added' ||
      entry.kind === 'entity-removed'
    );
  };

  // Every data-affecting entry must be covered by an operation.
  const uncovered: SchemaDiffEntry[] = [];
  for (const entry of diff.needsMigration) {
    const match = opTargets.find((target) => matches(entry, target));
    if (match) {
      match.matched = true;
    } else {
      uncovered.push(entry);
    }
  }
  // An operation is only "unmatched" if it corresponds to *no* diff entry at all — an
  // operation for a persistence-compatible change (making a field optional, adding a
  // relationship) is legitimate and matches its compatible entry.
  const unmatched = opTargets
    .filter((target) => !target.matched && !diff.entries.some((entry) => matches(entry, target)))
    .map((target) => target.operation);
  return { covered: uncovered.length === 0 && unmatched.length === 0, uncovered, unmatched };
}

export type { SchemaProjection };
