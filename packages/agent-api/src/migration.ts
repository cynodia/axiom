import {
  DEFAULT_SCHEMA_VERSION,
  diffSchema,
  migrationCoversDiff,
  schemaFingerprint,
  schemaProjection,
} from '@cynodia/axiom-core';
import type {
  ApplicationGraph,
  MigrationDef,
  MigrationOperation,
  SchemaChangeClass,
  SchemaDiff,
  SchemaDiffEntry,
} from '@cynodia/axiom-core';

/**
 * Authoring-time schema-evolution inspection for an agent (spec11 §56-58, §93).
 *
 * These functions answer, from the graph alone, what an agent needs before proposing or
 * approving an upgrade: what the schema currently is, what a diff between two versions
 * changes, whether the migration chain covers it, and which application semantics — queries,
 * actions, read policies, constraints, UI — reference something a migration touches. The
 * runtime planner (`planMigration` / `explainMigration` in `@cynodia/axiom-server`) answers
 * the execution-side questions.
 */

export interface SchemaInspection {
  schemaVersion: number;
  schemaFingerprint: string;
  entities: Array<{
    id: string;
    identityFieldId: string | null;
    fieldCount: number;
    requiredFieldCount: number;
  }>;
  persistedStates: Array<{ id: string; derived: boolean; authority: 'client' | 'server' }>;
  relationships: Array<{
    id: string;
    from: { entityId: string; fieldId: string };
    to: { entityId: string; fieldId: string };
    cardinality: 'to-one' | 'to-many';
  }>;
  readPolicies: Array<{ id: string; entityId: string }>;
  migrations: Array<{
    id: string;
    fromSchema: number;
    toSchema: number;
    operationCount: number;
    destructiveOperationCount: number;
  }>;
  /** Whether a contiguous migration chain connects schema 1 to `schemaVersion`. */
  chainComplete: boolean;
}

function destructiveOps(migration: MigrationDef): number {
  return migration.operations.filter(
    (operation) =>
      operation.destructive === true ||
      operation.kind === 'remove-field' ||
      operation.kind === 'remove-entity' ||
      (operation.kind === 'transform-record' && (operation.removesFields?.length ?? 0) > 0),
  ).length;
}

/** A structural summary of the schema a graph declares (spec11 §89 `inspectSchema`). */
export function inspectSchema(graph: ApplicationGraph): SchemaInspection {
  const projection = schemaProjection(graph);
  const migrations = graph.getNodesByKind('migration') as MigrationDef[];
  const byFrom = new Map(migrations.map((migration) => [migration.fromSchema, migration]));
  let chainComplete = true;
  for (let version = 1; version < projection.schemaVersion; version += 1) {
    const step = byFrom.get(version);
    if (!step || step.toSchema !== version + 1) {
      chainComplete = false;
      break;
    }
  }

  return {
    chainComplete,
    schemaVersion: projection.schemaVersion,
    schemaFingerprint: schemaFingerprint(graph),
    entities: projection.entities.map((entity) => ({
      id: entity.id,
      identityFieldId: entity.identityFieldId,
      fieldCount: entity.fields.length,
      requiredFieldCount: entity.fields.filter((field) => field.required).length,
    })),
    persistedStates: projection.states.map((state) => ({
      id: state.id,
      derived: state.derived,
      authority: state.authority,
    })),
    relationships: projection.relationships.map((relationship) => ({
      id: relationship.id,
      from: relationship.from,
      to: relationship.to,
      cardinality: relationship.cardinality,
    })),
    readPolicies: projection.readPolicies.map((policy) => ({ id: policy.id, entityId: policy.entityId })),
    migrations: [...migrations]
      .sort((a, b) => a.fromSchema - b.fromSchema)
      .map((migration) => ({
        id: String(migration.id),
        fromSchema: migration.fromSchema,
        toSchema: migration.toSchema,
        operationCount: migration.operations.length,
        destructiveOperationCount: destructiveOps(migration),
      })),
  };
}

/**
 * The terse semantic diff render of spec11 §58 — `+` added, `-` removed, `~` changed,
 * never a JSON text diff.
 */
export function explainSchemaDiff(diff: SchemaDiff): string {
  if (diff.entries.length === 0) {
    return `schema ${diff.fromVersion} → ${diff.toVersion}: no persistence-relevant change`;
  }
  const lines = [`schema ${diff.fromVersion} → ${diff.toVersion}  (verdict: ${diff.verdict})`];
  for (const entry of diff.entries) {
    const subject = entry.fieldId
      ? `${entry.entityId ?? '?'}.${entry.fieldId}`
      : entry.entityId ?? entry.stateId ?? entry.relationshipId ?? entry.readPolicyId ?? '?';
    lines.push(`  ${entry.mark} ${subject}  [${entry.class}] ${entry.message}`);
  }
  return lines.join('\n');
}

export interface MigrationImpact {
  fromVersion: number;
  toVersion: number;
  diff: SchemaDiff;
  verdict: SchemaChangeClass;
  /** Whether the migration chain in `next` accounts for every data-affecting diff entry. */
  covered: boolean;
  uncovered: SchemaDiffEntry[];
  dataLossPossible: boolean;
  affectedEntities: string[];
  affectedFields: string[];
  affectedQueries: string[];
  affectedActions: string[];
  affectedReadPolicies: string[];
  affectedConstraints: string[];
  affectedUiNodes: string[];
  /** Read-policy diff entries — an authorization-semantic change, distinct from a data change (spec11 §42). */
  authorizationChanges: string[];
}

const UI_KINDS = new Set([
  'view',
  'container',
  'text',
  'repeat',
  'field-display',
  'form',
  'input',
  'button',
  'conditional',
]);

/**
 * Impact analysis for a proposed upgrade (spec11 §57). Diffs `previous` against `next` and
 * reports which application semantics reference a field or entity the migration changes.
 */
export function migrationImpact(previous: ApplicationGraph, next: ApplicationGraph): MigrationImpact {
  const diff = diffSchema(previous, next);
  const changedFields = new Set(diff.entries.map((entry) => entry.fieldId).filter(Boolean) as string[]);
  const changedEntities = new Set(
    diff.entries.map((entry) => entry.entityId).filter(Boolean) as string[],
  );

  const migrations = next.getNodesByKind('migration') as MigrationDef[];
  const operations: MigrationOperation[] = migrations.flatMap((migration) => migration.operations);
  const coverage = migrationCoversDiff(diff, operations);

  const touchesChange = (nodeId: string): boolean => {
    for (const edge of next.getEdges(nodeId as never, { kinds: ['reads', 'writes', 'references'] })) {
      const fieldIds = (edge.metadata?.fieldIds as string[] | undefined) ?? [];
      if (fieldIds.some((id) => changedFields.has(id))) return true;
      if (changedEntities.has(String(edge.to))) return true;
    }
    return false;
  };

  const affectedQueries: string[] = [];
  const affectedActions: string[] = [];
  const affectedReadPolicies: string[] = [];
  const affectedConstraints: string[] = [];
  const affectedUiNodes: string[] = [];

  for (const node of next.listNodes()) {
    const id = String(node.id);
    if (node.kind === 'query') {
      if (changedEntities.has(String((node as { source: unknown }).source)) || touchesChange(id)) {
        affectedQueries.push(id);
      }
    } else if (node.kind === 'action') {
      if (touchesChange(id)) affectedActions.push(id);
    } else if (node.kind === 'read-policy') {
      if (changedEntities.has(String((node as { entityId: unknown }).entityId)) || touchesChange(id)) {
        affectedReadPolicies.push(id);
      }
    } else if (node.kind === 'constraint' || node.kind === 'transition-constraint') {
      if (changedEntities.has(String((node as { entityId: unknown }).entityId)) || touchesChange(id)) {
        affectedConstraints.push(id);
      }
    } else if (UI_KINDS.has(node.kind)) {
      if (touchesChange(id)) affectedUiNodes.push(id);
    }
  }

  return {
    fromVersion: diff.fromVersion,
    toVersion: diff.toVersion,
    diff,
    verdict: diff.verdict,
    covered: coverage.covered,
    uncovered: coverage.uncovered,
    dataLossPossible: diff.destructive.length > 0,
    affectedEntities: [...changedEntities].sort(),
    affectedFields: [...changedFields].sort(),
    affectedQueries: affectedQueries.sort(),
    affectedActions: affectedActions.sort(),
    affectedReadPolicies: affectedReadPolicies.sort(),
    affectedConstraints: affectedConstraints.sort(),
    affectedUiNodes: affectedUiNodes.sort(),
    authorizationChanges: diff.entries
      .filter((entry) => entry.authorizationChange)
      .map((entry) => entry.readPolicyId ?? '?'),
  };
}

export { DEFAULT_SCHEMA_VERSION };
