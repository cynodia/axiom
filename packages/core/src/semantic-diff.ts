/**
 * Canonical semantic graph diffing (spec16 §34-38, §150-160).
 *
 * `diffSchema` (spec11) already classifies changes to entities, fields, states,
 * relationships and read policies — the *persistence-relevant* structure. `semanticDiff`
 * is the superset spec16 asks for: every other executable and presentation node kind,
 * classified into categories an agent or a reviewer can reason about (`semantic`,
 * `authorization`, `provider`, `workflow`, `query`, `presentation`, `metadata`), plus the
 * compatibility impact a change carries — does it move `semanticFingerprint`, does it move
 * `schemaFingerprint`, does it raise the required Server IR contract. It embeds
 * `diffSchema`'s result rather than re-deriving it, so there remains exactly one place that
 * classifies a schema change (spec5.1 §26 "one canonical location per semantic rule").
 *
 * A node compared by full JSON identity **after** stripping human metadata is exactly the
 * notion of "meaning" `semanticFingerprint` uses ({@link stripNonSemanticMetadata}), so a
 * rename or a `metadata` edit is reported as `metadata`, never as `semantic` — and a
 * presentation-only edit to a UI node or a route is `presentation`, never `authorization` or
 * `schema` (spec16 §155).
 */

import { diffSchema } from './schema-diff.js';
import type { SchemaDiff } from './schema-diff.js';
import { schemaFingerprint, canonicalJSON } from './schema-identity.js';
import { semanticFingerprint, stripNonSemanticMetadata } from './semantic-identity.js';
import { requiredServerContractForGraph } from './server-ir.js';
import type { ServerIRContract } from './server-ir.js';
import { SEMANTIC_NODE_KINDS } from './types.js';
import type { NodeKind } from './types.js';
import { UI_NODE_KINDS } from './ui.js';
import type { ApplicationGraph } from './graph.js';

/** The classification vocabulary a semantic diff entry may belong to. A change may belong to more than one. */
export const SEMANTIC_DIFF_CATEGORIES = [
  'semantic',
  'authorization',
  'schema',
  'provider',
  'workflow',
  'query',
  'presentation',
  'metadata',
] as const;
export type SemanticDiffCategory = (typeof SEMANTIC_DIFF_CATEGORIES)[number];

/** Kinds `diffSchema` already classifies in full field-level detail; excluded from the generic node loop. */
const SCHEMA_OWNED_KINDS: ReadonlySet<string> = new Set(['entity', 'state', 'relationship', 'read-policy']);
const PROVIDER_KINDS: ReadonlySet<string> = new Set(['integration', 'integration-operation', 'subscription', 'storage']);
const PRESENTATION_KINDS: ReadonlySet<string> = new Set<string>([...UI_NODE_KINDS, 'route']);

function kindCategory(kind: string): SemanticDiffCategory {
  if (kind === 'authorization-policy') return 'authorization';
  if (kind === 'query') return 'query';
  if (kind === 'workflow') return 'workflow';
  if (kind === 'migration') return 'schema';
  if (PROVIDER_KINDS.has(kind)) return 'provider';
  if (PRESENTATION_KINDS.has(kind)) return 'presentation';
  return 'semantic';
}

/** Field names whose change on a node makes the change authorization-semantic too (spec16 §156). */
const AUTHZ_FIELDS: readonly string[] = ['authorizationPolicy', 'authorization', 'startPolicy', 'instanceAccessPolicy'];

export interface SemanticDiffEntry {
  changeKind: 'added' | 'removed' | 'changed';
  nodeId: string;
  nodeKind: string;
  /** One or more classifications this change belongs to (spec16 §36). */
  categories: SemanticDiffCategory[];
  message: string;
}

export interface SemanticDiffCompatibilityImpact {
  semanticFingerprintChanged: boolean;
  schemaFingerprintChanged: boolean;
  /** Whether a mixed-build cluster could now disagree — either fingerprint moved. */
  authorityCompatibilityAffected: boolean;
  serverContractBefore: ServerIRContract;
  serverContractAfter: ServerIRContract;
  serverContractChanged: boolean;
  /** Whether the embedded schema diff has any `migration-required` / `destructive` entry. */
  migrationRequired: boolean;
}

export interface SemanticDiff {
  /** Every non-schema-owned node kind's add/remove/change, classified. Canonically ordered by id. */
  entries: SemanticDiffEntry[];
  /** The detailed field-level diff for entities, fields, states, relationships and read policies. */
  schema: SchemaDiff;
  compatibility: SemanticDiffCompatibilityImpact;
  /** Entry counts per category, `entries` only (the schema diff has its own `byClass`). */
  byCategory: Record<SemanticDiffCategory, number>;
  /** True when neither `entries` nor the schema diff found anything — a genuine no-op. */
  isNoOp: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function equalJSON(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}

function describeChange(kind: string, id: string, changeKind: 'added' | 'removed' | 'changed'): string {
  const verb = changeKind === 'added' ? 'added' : changeKind === 'removed' ? 'removed' : 'changed';
  return `${kind} ${id} ${verb}`;
}

/**
 * The canonical semantic difference between two graphs (spec16 §34-38). Pure and
 * side-effect-free: it reads both graphs and computes, never mutates either (spec16 §133).
 */
export function semanticDiff(before: ApplicationGraph, after: ApplicationGraph): SemanticDiff {
  const schema = diffSchema(before, after);

  const entries: SemanticDiffEntry[] = [];
  const kinds: readonly NodeKind[] = [...SEMANTIC_NODE_KINDS, ...UI_NODE_KINDS, 'route' as NodeKind].filter(
    (kind, index, all) => all.indexOf(kind) === index,
  );

  for (const kind of kinds) {
    if (SCHEMA_OWNED_KINDS.has(kind)) {
      continue;
    }
    const beforeById = new Map(before.getNodesByKind(kind).map((node) => [String((node as { id: unknown }).id), node]));
    const afterById = new Map(after.getNodesByKind(kind).map((node) => [String((node as { id: unknown }).id), node]));

    for (const [id, node] of afterById) {
      if (!beforeById.has(id)) {
        entries.push({
          changeKind: 'added',
          nodeId: id,
          nodeKind: kind,
          categories: [kindCategory(kind)],
          message: describeChange(kind, id, 'added'),
        });
        continue;
      }
      const previous = beforeById.get(id);
      if (equalJSON(previous, node)) {
        continue;
      }
      const strippedEqual = equalJSON(stripNonSemanticMetadata(previous), stripNonSemanticMetadata(node));
      const categories = new Set<SemanticDiffCategory>();
      if (strippedEqual) {
        categories.add('metadata');
      } else if (isPlainObject(previous) && isPlainObject(node)) {
        const changedFields = new Set([...Object.keys(previous), ...Object.keys(node)].filter(
          (key) => !equalJSON(previous[key], node[key]),
        ));
        const onlyAuthzFieldsChanged =
          changedFields.size > 0 && [...changedFields].every((key) => AUTHZ_FIELDS.includes(key));
        if (onlyAuthzFieldsChanged) {
          categories.add('authorization');
        } else {
          categories.add(kindCategory(kind));
          if ([...changedFields].some((key) => AUTHZ_FIELDS.includes(key))) {
            categories.add('authorization');
          }
        }
      } else {
        categories.add(kindCategory(kind));
      }
      entries.push({
        changeKind: 'changed',
        nodeId: id,
        nodeKind: kind,
        categories: [...categories],
        message: describeChange(kind, id, 'changed'),
      });
    }
    for (const id of beforeById.keys()) {
      if (!afterById.has(id)) {
        entries.push({
          changeKind: 'removed',
          nodeId: id,
          nodeKind: kind,
          categories: [kindCategory(kind)],
          message: describeChange(kind, id, 'removed'),
        });
      }
    }
  }

  entries.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.changeKind.localeCompare(b.changeKind)));

  const semanticFingerprintChanged = semanticFingerprint(before) !== semanticFingerprint(after);
  const schemaFingerprintChanged = schemaFingerprint(before) !== schemaFingerprint(after);
  const serverContractBefore = requiredServerContractForGraph(before);
  const serverContractAfter = requiredServerContractForGraph(after);

  const byCategory = Object.fromEntries(SEMANTIC_DIFF_CATEGORIES.map((c) => [c, 0])) as Record<
    SemanticDiffCategory,
    number
  >;
  for (const entry of entries) {
    for (const category of entry.categories) {
      byCategory[category] += 1;
    }
  }

  return {
    entries,
    schema,
    compatibility: {
      semanticFingerprintChanged,
      schemaFingerprintChanged,
      authorityCompatibilityAffected: semanticFingerprintChanged || schemaFingerprintChanged,
      serverContractBefore,
      serverContractAfter,
      serverContractChanged: serverContractBefore !== serverContractAfter,
      migrationRequired: schema.needsMigration.length > 0,
    },
    byCategory,
    isNoOp: entries.length === 0 && schema.entries.length === 0,
  };
}
