import { createHash } from 'node:crypto';
import type { EntityDef, StateDef } from './nodes.js';
import type { RelationshipDef } from './relationships.js';
import type { ReadPolicyDef } from './read-policy.js';
import type { TypeRef } from './type-ref.js';
import type { ApplicationGraph } from './graph.js';

/**
 * Semantic schema identity (spec11 §6, §7, §9).
 *
 * The *semantic schema version* of an application is a monotonic integer, independent of
 * the npm package version (`0.11.0`), the Server IR contract (`axiom.server.v7`) and any
 * database engine's own schema version. A `MigrationDef` chain connects consecutive
 * integers. `ApplicationGraph.schemaVersion` carries it; it defaults to `1`.
 *
 * The *schema fingerprint* is a deterministic hash over every persistence-relevant semantic
 * fact and nothing else. Two graphs that differ only in names, descriptions, presentation,
 * authoring metadata, UI, routes, themes, query bodies, constraint expressions or
 * declaration order fingerprint **identically** (spec11 §9, §16). Any difference in an
 * entity's fields, a field's resolved type or `required`, an entity's identity field, a
 * persisted state's shape, a relationship's endpoints, or which entity a read policy
 * governs changes the fingerprint.
 *
 * Reasoning is by stable id (`NodeId`, `FieldId`), never by display name (spec11 §7):
 * renaming a `label` while keeping the `FieldId` does not change the fingerprint and
 * implies no data migration.
 */

/**
 * The fingerprint algorithm's own version, mixed into the hash. Bumping it (a deliberate,
 * documented change to what the projection includes) produces a new fingerprint space
 * rather than a silent, unexplainable "incompatible" verdict at some deployment.
 */
export const SCHEMA_FINGERPRINT_VERSION = 1;

/** The default semantic schema version of a graph that declares none. */
export const DEFAULT_SCHEMA_VERSION = 1;

/** A fully-expanded, order-independent view of one field's persistence contract. */
export interface FieldShape {
  id: string;
  type: TypeRef;
  required: boolean;
}

export interface EntityShape {
  id: string;
  identityFieldId: string | null;
  fields: FieldShape[];
}

export interface StateShape {
  id: string;
  type: TypeRef;
  derived: boolean;
  draft: boolean;
  authority: 'client' | 'server';
}

export interface RelationshipShape {
  id: string;
  from: { entityId: string; fieldId: string };
  to: { entityId: string; fieldId: string };
  cardinality: 'to-one' | 'to-many';
  required: boolean;
}

export interface ReadPolicyShape {
  id: string;
  entityId: string;
}

/**
 * The canonical, persistence-relevant projection of a schema. This is the structure the
 * fingerprint hashes and the structure `diffSchema` (spec11 §58) compares. It is portable
 * plain data — a future Rust implementation reconstructs it from the Server IR and hashes
 * the same bytes.
 */
export interface SchemaProjection {
  fingerprintVersion: number;
  schemaVersion: number;
  entities: EntityShape[];
  states: StateShape[];
  relationships: RelationshipShape[];
  readPolicies: ReadPolicyShape[];
}

/**
 * The persistence-relevant node sets a projection is built from. An `ApplicationGraph`
 * supplies these; so does a bag assembled from a Server IR.
 */
export interface SchemaSource {
  schemaVersion: number;
  entities: readonly EntityDef[];
  states: readonly StateDef[];
  relationships: readonly RelationshipDef[];
  readPolicies: readonly ReadPolicyDef[];
}

type SchemaInput = SchemaSource | ApplicationGraph;

function isGraph(input: SchemaInput): input is ApplicationGraph {
  return typeof (input as ApplicationGraph).getNodesByKind === 'function';
}

function toSource(input: SchemaInput): SchemaSource {
  if (!isGraph(input)) {
    return input;
  }
  return {
    schemaVersion: input.schemaVersion,
    entities: input.getNodesByKind('entity'),
    states: input.getNodesByKind('state'),
    relationships: input.getNodesByKind('relationship'),
    readPolicies: input.getNodesByKind('read-policy'),
  };
}

function canonicalType(type: TypeRef): TypeRef {
  switch (type.kind) {
    case 'collection':
      return { kind: 'collection', itemType: canonicalType(type.itemType) };
    case 'optional':
      return { kind: 'optional', valueType: canonicalType(type.valueType) };
    case 'enum':
      // Enum membership is a set, not a sequence — order it so a reordered declaration
      // does not read as a schema change.
      return { kind: 'enum', values: [...type.values].sort() };
    case 'group':
      return {
        kind: 'group',
        keyType: canonicalType(type.keyType),
        itemType: canonicalType(type.itemType),
      };
    default:
      return { ...type };
  }
}

function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Build the persistence-relevant projection of a schema. Everything a migration might have
 * to act on is in it; everything a migration never touches (spec11 §16) is left out.
 */
export function schemaProjection(input: SchemaInput): SchemaProjection {
  const source = toSource(input);

  const entities: EntityShape[] = byId(
    source.entities.map((entity) => ({
      id: String(entity.id),
      identityFieldId: entity.identityFieldId ? String(entity.identityFieldId) : null,
      fields: byId(
        entity.fields.map((field) => ({
          id: String(field.id),
          type: canonicalType(field.valueType),
          required: field.required === true,
        })),
      ),
    })),
  );

  const states: StateShape[] = byId(
    source.states
      // Ephemeral state is a UI fact, not a domain fact, and may never be persisted
      // (spec §46 governs *persisted* state) — it contributes nothing to the fingerprint.
      .filter((state) => state.ephemeral !== true)
      .map((state) => ({
        id: String(state.id),
        type: canonicalType(state.valueType),
        derived: state.derivation !== undefined,
        draft: state.draft === true,
        authority: (state.authority === 'server' ? 'server' : 'client') as 'client' | 'server',
      })),
  );

  const relationships: RelationshipShape[] = byId(
    source.relationships.map((relationship) => ({
      id: String(relationship.id),
      from: {
        entityId: String(relationship.from.entityId),
        fieldId: String(relationship.from.fieldId),
      },
      to: {
        entityId: String(relationship.to.entityId),
        fieldId: String(relationship.to.fieldId),
      },
      cardinality: relationship.cardinality,
      required: (relationship as { required?: boolean }).required === true,
    })),
  );

  const readPolicies: ReadPolicyShape[] = byId(
    source.readPolicies.map((policy) => ({
      id: String(policy.id),
      entityId: String(policy.entityId),
    })),
  );

  return {
    fingerprintVersion: SCHEMA_FINGERPRINT_VERSION,
    schemaVersion: source.schemaVersion,
    entities,
    states,
    relationships,
    readPolicies,
  };
}

/**
 * Deterministic JSON: every object's keys are emitted in sorted order, recursively, so two
 * structurally equal projections serialize to byte-identical strings regardless of how the
 * objects were built.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(',')}}`;
}

/** SHA-256 (hex) of a projection produced by {@link schemaProjection}. */
export function fingerprintProjection(projection: SchemaProjection): string {
  return createHash('sha256').update(canonicalJSON(projection)).digest('hex');
}

/**
 * The schema fingerprint of a graph or a Server IR schema source (spec11 §9). Pure and
 * synchronous. A provider stores this alongside the schema version; startup compares them.
 */
export function schemaFingerprint(input: SchemaInput): string {
  return fingerprintProjection(schemaProjection(input));
}
