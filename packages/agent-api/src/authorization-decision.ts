import {
  decideAuthorization,
  evaluateAuthorizationExpression,
  type ActionDef,
  type ApplicationGraph,
  type AuthorizationCheckPart,
  type AuthorizationOperation,
  type AuthorizationPolicyDef,
  type NodeId,
  type QueryDef,
} from '@cynodia/axiom-core';

/**
 * Concrete authorization decision explanation (spec16 §26, §136-141), evaluated through the
 * **same** canonical, security-absence-aware evaluator the authority uses
 * (`evaluateAuthorizationExpression` / `decideAuthorization`, spec15pt3) — never a second,
 * tooling-only interpretation (spec16 §197). It performs no mutation, no provider call and no
 * effect: it is a pure function of the policy expression and the supplied principal /
 * resource, exactly like an ordinary static analysis (spec16 §133, §136).
 *
 * This is advisory. The real operation always re-authorizes on the authority; a prior
 * tooling result is never a token (spec16 §138).
 */
export interface AuthorizationDecisionRequest {
  actionId?: NodeId;
  queryId?: NodeId;
  principal?: Record<string, unknown> | null;
  resource?: Record<string, unknown> | null;
}

export interface AuthorizationPartResult {
  evaluated: boolean;
  ok?: boolean;
  value?: unknown;
}

export interface AuthorizationDecisionExplanation {
  operation: AuthorizationOperation;
  decision: 'ALLOW' | 'DENY';
  reason: string;
  policyId: string | null;
  policyResult: AuthorizationPartResult | null;
  legacyResult: AuthorizationPartResult | null;
}

function partResult(part: AuthorizationCheckPart): AuthorizationPartResult {
  return { evaluated: true, ok: part.ok, ...(part.ok ? { value: part.value } : {}) };
}

export function explainAuthorizationDecision(
  graph: ApplicationGraph,
  request: AuthorizationDecisionRequest,
): AuthorizationDecisionExplanation | undefined {
  let operation: AuthorizationOperation;
  let policyId: NodeId | undefined;
  let legacyExpression: ActionDef['authorization'] | undefined;

  if (request.actionId !== undefined) {
    const action = graph.getNode<ActionDef>(request.actionId);
    if (!action || action.kind !== 'action') return undefined;
    operation = 'action.invoke';
    policyId = action.authorizationPolicy;
    legacyExpression = action.authorization;
  } else if (request.queryId !== undefined) {
    const query = graph.getNode<QueryDef>(request.queryId);
    if (!query || query.kind !== 'query') return undefined;
    operation = 'query.read';
    policyId = query.authorizationPolicy;
  } else {
    return undefined;
  }

  const context = { principal: request.principal ?? null, resource: request.resource ?? null, operation };

  let policyPart: AuthorizationCheckPart | undefined;
  let policyResult: AuthorizationPartResult | null = null;
  if (policyId !== undefined) {
    const policy = graph.getNode<AuthorizationPolicyDef>(policyId);
    policyPart = policy && policy.kind === 'authorization-policy'
      ? evaluateAuthorizationExpression(policy.allow, context, 'policy')
      : { ok: false };
    policyResult = partResult(policyPart);
  }

  let legacyPart: AuthorizationCheckPart | undefined;
  let legacyResult: AuthorizationPartResult | null = null;
  if (legacyExpression !== undefined) {
    // Static analysis has no running StateDef to resolve a legacy expression's external
    // refs against, so an id outside the closed PRINCIPAL/RESOURCE/OPERATION scope fails
    // closed here exactly as it would with no resolver at runtime (spec15pt3).
    legacyPart = evaluateAuthorizationExpression(legacyExpression, context, 'legacy-action');
    legacyResult = partResult(legacyPart);
  }

  const result = decideAuthorization({
    ...(policyPart ? { policy: policyPart } : {}),
    ...(legacyPart ? { legacy: legacyPart } : {}),
  });

  return {
    operation,
    decision: result.decision,
    reason: result.reason,
    policyId: policyId ?? null,
    policyResult,
    legacyResult,
  };
}
