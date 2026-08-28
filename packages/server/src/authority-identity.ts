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
 */

import { createHash } from 'node:crypto';
import {
  SEMANTIC_FINGERPRINT_VERSION,
  authorityCompatibilityKey,
  canonicalJSON,
  compatibilityKeyString,
  type AuthorityCompatibilityKey,
  type ServerIR,
} from './deps.js';

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

function sortedRecord(record: Record<string, unknown> | undefined): unknown[] {
  return Object.entries(record ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => stripNonSemantic(v));
}
function sortedList<T extends { id: unknown }>(list: readonly T[] | undefined): unknown[] {
  return [...(list ?? [])]
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    .map((entry) => stripNonSemantic(entry));
}

/**
 * The canonical executable-meaning projection of a Server IR: actions, constraints,
 * transition constraints, expression defs, integrations + operations, triggers, events,
 * subscriptions, storages, read policies, relationships, queries, plus the schema version.
 * Everything a distributed worker executes; nothing a rename touches.
 */
export function serverIrSemanticProjection(ir: ServerIR): Record<string, unknown> {
  return {
    fingerprintVersion: SEMANTIC_FINGERPRINT_VERSION,
    schemaVersion: ir.schemaVersion ?? 1,
    actions: sortedRecord(ir.actions),
    constraints: sortedList(ir.constraints),
    transitionConstraints: sortedList(ir.transitionConstraints),
    expressionDefs: sortedRecord(ir.expressionDefs),
    integrations: sortedList(ir.integrations),
    integrationOperations: sortedRecord(ir.integrationOperations),
    triggers: sortedList(ir.triggers),
    events: sortedList(ir.events),
    subscriptions: sortedList(ir.subscriptions),
    storages: sortedList(ir.storages),
    readPolicies: sortedList(ir.readPolicies),
    relationships: sortedList(ir.relationships),
    queries: sortedList(ir.queries),
  };
}

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
  });
}

/** The stable string form stamped onto durable work as `authorityKey`. */
export function serverIrCompatibilityKeyString(ir: ServerIR): string {
  return compatibilityKeyString(serverIrCompatibilityKey(ir));
}
