import {
  queryDependencies,
  queryLiveCapability,
  readPolicyForEntity,
  type ApplicationGraph,
  type EntityDef,
  type LiveCapability,
  type QueryDef,
  type ReadPolicyDef,
  type RelationshipDef,
  type StateDef,
} from '@cynodia/axiom-core';

/**
 * Static, graph-derivable live-query analysis (spec13 §38, §148, §149, §189 Q37/Q38).
 *
 * The AgentAPI works over an `ApplicationGraph`, not a running authority, so it answers the
 * *semantic* questions — can this `QueryDef` be observed live, incrementally or only as whole
 * resets, what committed changes invalidate it, and what a resume cursor is bound to — not
 * the live runtime state (that is `AxiomServer.inspectLiveQueries()`).
 *
 * Nothing here names a transport. A live query is a persistent semantic observation of a
 * canonical `QueryDef`; the runtime may poll and the provider may push, but the meaning is
 * fixed by the graph (spec13 §195).
 */
export interface LiveQueryAnalysis {
  queryId: string;
  /** `live-capable` (incremental), `live-capable-reset-only` (whole resets), or `not-live-capable`. */
  capability: LiveCapability;
  /** Ordered result — a sort-key change produces an explicit `move` (spec13 §16). */
  ordered: boolean;
  /** Aggregate / grouped — delivered only as `reset` (spec13 §14, §19). */
  aggregate: boolean;
  /** The row identity field the canonical delta model keys on, or `null` for a reset-only query. */
  identityFieldId: string | null;
  /**
   * Conservative static invalidation set (spec13 §26-§31): a committed change to any of these
   * entities or `StateDef`s may move the result. `broad` means the dependency is not
   * statically enumerable, so every commit re-evaluates.
   */
  dependencies: {
    entityIds: string[];
    stateIds: string[];
    broad: boolean;
    /** The read policy AND-ed into every evaluation, if one governs the source entity. */
    readPolicyId: string | null;
  };
  /**
   * What a `axiom.live-query-cursor.v1` resume token is bound to — a mismatch on any of these
   * is refused fail-closed on reconnect (spec13 §33-§35, §79-§81).
   */
  cursorBinding: string[];
  /** The delivery contract, stated honestly (spec13 §33, §41, §85). */
  delivery: {
    guarantee: 'at-least-once-logical';
    updateIdentity: 'subscriptionId + toRevision';
    ordering: 'per-subscription-monotonic-by-revision';
    revisionsMayBeCoalesced: true;
    cursorAcknowledgement: 'server-sent-no-ack';
  };
  /** Present when `capability` is not `live-capable` — why, in one line. */
  reason?: string;
}

/**
 * Analyze one `QueryDef`'s live-query semantics. Pure over the graph. Throws if `queryId`
 * does not name a `query` node.
 */
export function analyzeLiveQuery(graph: ApplicationGraph, queryId: string): LiveQueryAnalysis {
  const query = graph
    .getNodesByKind('query')
    .find((node) => String(node.id) === String(queryId)) as QueryDef | undefined;
  if (!query) {
    throw new Error(`analyzeLiveQuery: no query node "${queryId}"`);
  }

  const entities = graph.getNodesByKind('entity') as EntityDef[];
  const relationships = graph.getNodesByKind('relationship') as RelationshipDef[];
  const readPolicies = graph.getNodesByKind('read-policy') as ReadPolicyDef[];
  const stateIds = new Set(
    (graph.getNodesByKind('state') as StateDef[]).map((state) => String(state.id)),
  );

  const source = entities.find((entity) => String(entity.id) === String(query.source));
  const sourceIdentityFieldId = source?.identityFieldId ? String(source.identityFieldId) : undefined;
  // Mirror the authority's `policyForQuery`: an explicit `readPolicyId` wins, else the policy
  // that governs the source entity.
  const policy = query.readPolicyId
    ? readPolicies.find((candidate) => String(candidate.id) === String(query.readPolicyId))
    : readPolicyForEntity(readPolicies, query.source);

  const capability = queryLiveCapability(query, sourceIdentityFieldId);
  const aggregate = (query.aggregate?.length ?? 0) > 0 || (query.groupBy?.length ?? 0) > 0;
  const ordered = (query.sort?.length ?? 0) > 0;
  const deps = queryDependencies(query, policy, relationships, stateIds);

  const analysis: LiveQueryAnalysis = {
    queryId: String(query.id),
    capability,
    ordered,
    aggregate,
    identityFieldId:
      capability.capability === 'live-capable' && sourceIdentityFieldId ? sourceIdentityFieldId : null,
    dependencies: {
      entityIds: [...deps.entityIds].sort(),
      stateIds: [...deps.stateIds].sort(),
      broad: deps.broad,
      readPolicyId: policy ? String(policy.id) : null,
    },
    cursorBinding: [
      'queryId',
      'argumentsFingerprint',
      'principalFingerprint',
      'policyFingerprint',
      'compatibilityFingerprint (serverContract + schemaFingerprint + semanticFingerprint)',
      'hmac-sha256 integrity signature',
    ],
    delivery: {
      guarantee: 'at-least-once-logical',
      updateIdentity: 'subscriptionId + toRevision',
      ordering: 'per-subscription-monotonic-by-revision',
      revisionsMayBeCoalesced: true,
      cursorAcknowledgement: 'server-sent-no-ack',
    },
  };
  if (capability.capability !== 'live-capable') {
    analysis.reason = capability.reason;
  }
  return analysis;
}
