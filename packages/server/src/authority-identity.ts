/**
 * This authority build's compatibility identity, computed from the Server IR (spec12 §43-§45).
 *
 * `packages/core`'s `semanticFingerprint` projects an `ApplicationGraph`; the authoritative
 * runtime only ever sees the normalized `ServerIR`. This module is the ServerIR-side
 * equivalent: the same idea (hash the executable meaning, exclude names / UI / annotation),
 * applied to the slices a `ServerIR` actually carries. It is deterministic and versioned so
 * a future non-JS runtime reconstructs the same bytes (spec12 §95, §96).
 *
 * The resulting {@link AuthorityCompatibilityKey} is what `createDurableWorkStore` stamps as
 * its `authorityKey`: an incompatible / older build then refuses to claim work a newer build
 * created (spec12 §44, §47).
 *
 * **spec14pt3 §5 G1 — one canonical semantic projection.** The slices this hashes are keyed
 * by `core`'s {@link EXECUTABLE_KINDS} — the *same* list the graph-level `semanticFingerprint`
 * iterates — through {@link SERVER_IR_EXECUTABLE_SLICES}. Phase 22 F3 was exactly the failure
 * this now prevents: `WorkflowDef` had been added to `EXECUTABLE_KINDS` (so
 * `semanticFingerprint(graph)` moved for a workflow semantic change) but this projection's
 * hand-maintained slice list omitted `workflows`, so two authorities running different
 * workflow semantics reported `compatible: true` and one silently advanced an in-flight
 * instance under changed meaning. A `server` test now pins that every `EXECUTABLE_KINDS`
 * member is projected here.
 */

import { createHash } from 'node:crypto';
import {
  EXECUTABLE_KINDS,
  SEMANTIC_FINGERPRINT_VERSION,
  authorityCompatibilityKey,
  canonicalJSON,
  canonicalWorkflowForFingerprint,
  compatibilityKeyString,
  usesAuthorizationVocabulary,
  type AuthorityCompatibilityKey,
  type ServerIR,
} from './deps.js';

/**
 * spec15pt2 §35 — the authorization-evaluator semantics version stamped into an
 * authority's compatibility key when the Server IR carries authorization vocabulary.
 * `alpha.1` did not stamp this field; `alpha.2` (three-valued absent-value-safe evaluator)
 * does, so a mixed `alpha.1`/`alpha.2` cluster over one authorization-bearing graph is
 * fail-closed incompatible.
 */
export const AUTHORIZATION_RUNTIME_VERSION = 'axiom.authz.v2';

type ExecutableKind = (typeof EXECUTABLE_KINDS)[number];

const NON_SEMANTIC_KEYS = new Set(['name', 'description', 'label', 'metadata', 'axiom.authoring']);

function stripNonSemantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNonSemantic);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (NON_SEMANTIC_KEYS.has(key) || v === undefined) continue;
      out[key] = stripNonSemantic(v);
    }
    return out;
  }
  return value;
}

// Both are **total** over a hand-tampered `ServerIR` slice (spec14pt4 §31): a slice that is
// the wrong shape entirely (a string where an array is expected, say) projects to nothing
// rather than throwing. A structurally invalid workflow is then refused by the engine's
// admission validator with a structured `WorkflowIRError`; the compatibility key is never
// the place a malformed IR surfaces as a native error. Valid graphs always have
// array/object slices, so no valid fingerprint moves.
function sortedRecord(record: unknown): unknown[] {
  if (!record || typeof record !== 'object') return [];
  return Object.entries(record as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => stripNonSemantic(v));
}
function sortedList(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];
  return [...list]
    .sort((a, b) => (String((a as { id?: unknown })?.id) < String((b as { id?: unknown })?.id) ? -1 : String((a as { id?: unknown })?.id) > String((b as { id?: unknown })?.id) ? 1 : 0))
    .map((entry) => stripNonSemantic(entry));
}

/**
 * The Server IR slice carrying each executable graph kind. Keyed by `core`'s
 * {@link EXECUTABLE_KINDS} so this projection and the graph-level `semanticFingerprint`
 * cannot disagree about what is executable (spec14pt3 §5, §6, §189).
 *
 * `since` marks a slice added after `axiom.server.v1..v7` were frozen (`'v8'` = workflows,
 * `'v9'` = authorization policies): it contributes to the fingerprint **only when
 * non-empty**, exactly as `core`'s `semanticProjection` skips an empty kind — so every graph
 * that does not use that vocabulary keeps a byte-identical authority fingerprint (spec14pt3
 * §35, §38, §103; spec15 §39, §132). The 13 pre-v8 slices stay unconditionally present (an
 * empty array included) to keep *their* frozen bytes unchanged.
 */
const SERVER_IR_EXECUTABLE_SLICES: Record<
  ExecutableKind,
  { field: keyof ServerIR; shape: 'record' | 'list'; since?: 'v8' | 'v9' }
> = {
  action: { field: 'actions', shape: 'record' },
  integration: { field: 'integrations', shape: 'list' },
  'integration-operation': { field: 'integrationOperations', shape: 'record' },
  trigger: { field: 'triggers', shape: 'list' },
  event: { field: 'events', shape: 'list' },
  subscription: { field: 'subscriptions', shape: 'list' },
  'read-policy': { field: 'readPolicies', shape: 'list' },
  query: { field: 'queries', shape: 'list' },
  expression: { field: 'expressionDefs', shape: 'record' },
  constraint: { field: 'constraints', shape: 'list' },
  'transition-constraint': { field: 'transitionConstraints', shape: 'list' },
  storage: { field: 'storages', shape: 'list' },
  relationship: { field: 'relationships', shape: 'list' },
  workflow: { field: 'workflows', shape: 'list', since: 'v8' },
  'authorization-policy': { field: 'authorizationPolicies', shape: 'list', since: 'v9' },
};

/**
 * The canonical executable-meaning projection of a Server IR: everything a distributed
 * worker executes — actions, constraints, transition constraints, expression defs,
 * integrations + operations, triggers, events, subscriptions, storages, read policies,
 * relationships, queries, **and workflows** — plus the schema version. Nothing a rename
 * touches. Built by iterating {@link EXECUTABLE_KINDS} so a future primitive cannot be
 * omitted (spec14pt3 F3 root cause).
 */
export function serverIrSemanticProjection(ir: ServerIR): Record<string, unknown> {
  const projection: Record<string, unknown> = {
    fingerprintVersion: SEMANTIC_FINGERPRINT_VERSION,
    schemaVersion: ir.schemaVersion ?? 1,
  };
  for (const kind of EXECUTABLE_KINDS) {
    const slice = SERVER_IR_EXECUTABLE_SLICES[kind];
    let raw: unknown = ir[slice.field];
    // Workflows are canonicalized (authoring order of steps / inputs / bindings is not
    // semantic) through the *same* core helper the graph-level fingerprint uses (spec14pt3
    // §5 G1, §64), so the two projections cannot disagree about a workflow.
    if (kind === 'workflow' && Array.isArray(raw)) {
      raw = raw.map((w) => canonicalWorkflowForFingerprint(w as Record<string, unknown>));
    }
    const projected =
      slice.shape === 'record'
        ? sortedRecord(raw as Record<string, unknown> | undefined)
        : sortedList(raw as ReadonlyArray<{ id: unknown }> | undefined);
    if (slice.since !== undefined && projected.length === 0) continue;
    projection[slice.field as string] = projected;
  }
  return projection;
}

export { SERVER_IR_EXECUTABLE_SLICES };

export function serverIrSemanticFingerprint(ir: ServerIR): string {
  return createHash('sha256').update(canonicalJSON(serverIrSemanticProjection(ir))).digest('hex');
}

/** The full compatibility key for the authority executing this Server IR (spec12 §45). */
export function serverIrCompatibilityKey(ir: ServerIR): AuthorityCompatibilityKey {
  return authorityCompatibilityKey({
    schemaVersion: ir.schemaVersion ?? 1,
    schemaFingerprint: ir.schemaFingerprint ?? '',
    serverContract: String(ir.contract),
    semanticFingerprint: serverIrSemanticFingerprint(ir),
    // Only an authorization-bearing IR gets the evaluator-version discriminator, so a graph
    // with no policy rolls alpha.1 → alpha.2 unaffected (spec15pt2 §35).
    ...(usesAuthorizationVocabulary(ir as never) ? { authorizationRuntime: AUTHORIZATION_RUNTIME_VERSION } : {}),
  });
}

/** The stable string form stamped onto durable work as `authorityKey`. */
export function serverIrCompatibilityKeyString(ir: ServerIR): string {
  return compatibilityKeyString(serverIrCompatibilityKey(ir));
}
