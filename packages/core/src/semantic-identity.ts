import { createHash } from 'node:crypto';
import { canonicalJSON } from './schema-identity.js';
import { AUTHORING_METADATA_KEY } from './authoring-metadata.js';
import type { ApplicationGraph } from './graph.js';

/**
 * Application **semantic** identity (spec12 §45, §46).
 *
 * `schemaFingerprint` (spec11) deliberately covers only *persistence-relevant* structure —
 * entity fields, types, `required`, identity fields, state shapes, relationships, which
 * entity a read policy governs — and deliberately excludes executable meaning: two graphs
 * whose actions do completely different things, but store the same shapes, fingerprint
 * identically. That is correct for deciding whether *data* needs migrating; it is not enough
 * to decide whether two authority processes may safely execute the **same durable work**.
 *
 * `semanticFingerprint` is the second identity: a deterministic hash over the executable
 * server-side meaning of a graph.
 *
 * ### Inclusions (what changes the semantic fingerprint)
 *
 * - `ActionDef` — parameters (id + type + required), guards / preconditions / failure modes,
 *   the full `operations` tree, postconditions, `authorization`, `invocation.allowedSources`,
 *   `destructive`, `requiresConfirmation`.
 * - `IntegrationDef` — capability domain; `IntegrationOperationDef` — `mode`, `resultType`,
 *   `parameters`, `retry`, `idempotent`, `timeoutMs`, `idempotencyKey`, `succeededEventId`,
 *   `failedEventId`, `clientSafe`.
 * - `TriggerDef` — `when`, `actionId`, `arguments`, `enabledWhen`, overlap policy,
 *   `invocationSource`.
 * - `EventDef` — `payloadType`.
 * - `SubscriptionDef` — `integrationId`, `eventId`, delivery / ordering / backpressure /
 *   reconnect policy, `deduplicateBy`, lifecycle.
 * - `ReadPolicyDef` — `entityId` and the `predicate` expression.
 * - `QueryDef` — every clause expression, ordering, pagination shape.
 * - `ExpressionDef` — `parameters` and the body `expression`.
 * - `ConstraintDef` / `TransitionConstraintDef` — `entityId`, `severity`, the expression(s),
 *   the bound scope ids.
 * - `StorageDef` — `readAuthorization` / `uploadAuthorization` expressions, `retry`.
 * - `RelationshipDef` — endpoints and cardinality (also in the schema fingerprint; repeated
 *   here so a semantic-only comparison is self-contained).
 * - `graph.schemaVersion`.
 *
 * ### Exclusions (what does NOT change it)
 *
 * - Every UI node kind, `RouteDef`, themes, presentation, `headingLevel`, icons.
 * - `name`, `description`, `label` anywhere in the tree — reasoning is by stable id.
 * - Anything under {@link AUTHORING_METADATA_KEY}, and free-form `metadata` (an annotation
 *   channel, not executable vocabulary — same treatment the schema fingerprint gives names).
 * - Declaration order — every collection is sorted by `id`.
 *
 * The projection is portable plain data and the algorithm is versioned
 * ({@link SEMANTIC_FINGERPRINT_VERSION}); a future non-JS runtime reconstructs it from the
 * Server IR and hashes the same bytes (spec12 §95, §96).
 */

/** The projection algorithm's own version, mixed into the hash (spec12 §46). */
export const SEMANTIC_FINGERPRINT_VERSION = 1;

const EXECUTABLE_KINDS = [
  'action',
  'integration',
  'integration-operation',
  'trigger',
  'event',
  'subscription',
  'read-policy',
  'query',
  'expression',
  'constraint',
  'transition-constraint',
  'storage',
  'relationship',
  'workflow',
] as const;

/** Keys removed everywhere in the tree — human metadata, never executable meaning. */
const NON_SEMANTIC_KEYS = new Set(['name', 'description', 'label', 'metadata', AUTHORING_METADATA_KEY]);

function stripNonSemantic(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNonSemantic);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (NON_SEMANTIC_KEYS.has(key) || v === undefined) {
        continue;
      }
      out[key] = stripNonSemantic(v);
    }
    return out;
  }
  return value;
}

function byId<T extends { id: unknown }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

export interface SemanticProjection {
  fingerprintVersion: number;
  schemaVersion: number;
  /** Executable nodes, grouped by kind, each group sorted by id, each node stripped of human metadata. */
  nodes: Record<string, unknown[]>;
}

type SemanticInput = ApplicationGraph;

/** Build the canonical executable-meaning projection of a graph (spec12 §46). */
export function semanticProjection(graph: SemanticInput): SemanticProjection {
  const nodes: Record<string, unknown[]> = {};
  for (const kind of EXECUTABLE_KINDS) {
    const group = graph.getNodesByKind(kind as Parameters<ApplicationGraph['getNodesByKind']>[0]);
    if (group.length === 0) {
      continue;
    }
    nodes[kind] = byId(group as Array<{ id: unknown }>).map((node) => stripNonSemantic(node));
  }
  return {
    fingerprintVersion: SEMANTIC_FINGERPRINT_VERSION,
    schemaVersion: graph.schemaVersion,
    nodes,
  };
}

/** SHA-256 (hex) of a graph's executable-meaning projection (spec12 §46). Pure, synchronous. */
export function semanticFingerprint(graph: SemanticInput): string {
  return createHash('sha256').update(canonicalJSON(semanticProjection(graph))).digest('hex');
}

// --------------------------------------------------------- authority compatibility key

/**
 * The durable runtime compatibility identity of one authority build (spec12 §45). Two
 * authorities may safely execute the same durable work iff their keys are equal.
 *
 * - `schemaVersion` / `schemaFingerprint` — the 0.11 identity, unchanged; a schema mismatch
 *   is already fatal per 0.11 migration safety (spec12 §42).
 * - `serverContract` — the Server IR contract the graph requires (`axiom.server.v7`, …); a
 *   runtime that speaks a different one cannot be assumed to execute the vocabulary.
 * - `semanticFingerprint` — executable meaning; catches "same schema, different action
 *   bodies" (spec12 §44), which the schema fingerprint cannot.
 */
export interface AuthorityCompatibilityKey {
  schemaVersion: number;
  schemaFingerprint: string;
  serverContract: string;
  semanticFingerprint: string;
}

export function authorityCompatibilityKey(
  parts: AuthorityCompatibilityKey,
): AuthorityCompatibilityKey {
  return {
    schemaVersion: parts.schemaVersion,
    schemaFingerprint: parts.schemaFingerprint,
    serverContract: parts.serverContract,
    semanticFingerprint: parts.semanticFingerprint,
  };
}

/** A stable, comparable string form for storing on a durable work item (spec12 §43). */
export function compatibilityKeyString(key: AuthorityCompatibilityKey): string {
  return canonicalJSON(authorityCompatibilityKey(key));
}

export interface CompatibilityComparison {
  compatible: boolean;
  /** Field names that differ, when not compatible — for an `INCOMPATIBLE_AUTHORITY` diagnostic. */
  mismatches: Array<keyof AuthorityCompatibilityKey>;
}

/**
 * Compare two authority compatibility keys. Fails **closed**: any difference in any field
 * makes them incompatible (spec12 §44 "fail closed when semantic compatibility cannot be
 * established"). There is no partial compatibility.
 */
export function compareAuthorityCompatibility(
  a: AuthorityCompatibilityKey,
  b: AuthorityCompatibilityKey,
): CompatibilityComparison {
  const fields: Array<keyof AuthorityCompatibilityKey> = [
    'schemaVersion',
    'schemaFingerprint',
    'serverContract',
    'semanticFingerprint',
  ];
  const mismatches = fields.filter((field) => a[field] !== b[field]);
  return { compatible: mismatches.length === 0, mismatches };
}
