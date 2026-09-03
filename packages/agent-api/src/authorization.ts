import {
  authorizationPolicyDependencies,
  authorizationPolicyProblems,
  workflowActionIds,
  type ApplicationGraph,
  type AuthorizationPolicyDef,
  type ActionDef,
  type QueryDef,
  type WorkflowDef,
} from '@cynodia/axiom-core';

/**
 * Static, graph-derivable authorization analysis (spec15 §42, §43, §44). The AgentAPI works
 * over an `ApplicationGraph`, not a running authority, so it answers the *semantic*
 * questions — what protects each surface, what a policy depends on, which surfaces have no
 * explicit authorization boundary, whether a workflow can reach an action requiring
 * permissions its start principal is not proven to hold. It never claims a principal *is*
 * authorized where it cannot prove it (spec15 §50), and it reports policy **structure**, not
 * any runtime secret (spec15 §83).
 *
 * Live decisions and their reasons are the authority's job (`AUTHORIZATION_DENIED` with
 * `details.reason`).
 */

/** How one authorization policy reads its closed scope, plus a secret-free rendering. */
export interface AuthorizationPolicyAnalysis {
  policyId: string;
  /** Field ids read off `PRINCIPAL`. */
  principalFields: string[];
  /** Field ids read off `RESOURCE`. */
  resourceFields: string[];
  /** Whether the policy references `OPERATION`. */
  readsOperation: boolean;
  /** A verdict when `allow` is a constant `literal` (spec15 §8), else `null`. */
  constant: 'always-allow' | 'always-deny' | null;
  /** A structured, secret-free one-line rendering of the rule (spec15 §44). */
  summary: string;
  /** Any `AUTHORIZATION_*` validation problems on this policy. */
  problems: string[];
}

export type OperationProtection =
  | { kind: 'policy'; policyId: string }
  | { kind: 'legacy-expression' }
  | { kind: 'policy+legacy'; policyId: string }
  | { kind: 'read-policy'; readPolicyId: string }
  | { kind: 'policy+read-policy'; policyId: string; readPolicyId: string }
  | { kind: 'owner-fingerprint' }
  | { kind: 'infrastructure' }
  | { kind: 'public' };

/** One protected (or unprotected) semantic surface. */
export interface OperationCoverage {
  operation: string;
  nodeId: string;
  nodeKind: 'action' | 'query' | 'workflow';
  protection: OperationProtection;
  /** True when the surface has no explicit authorization boundary and could carry one. */
  unresolved: boolean;
}

export interface WorkflowAuthorizationAnalysis {
  workflowId: string;
  start: 'policy' | 'public';
  startPolicyId: string | null;
  instanceAccess: 'policy' | 'owner-fingerprint';
  instanceAccessPolicyId: string | null;
  /** Each distinct `ActionDef` a step invokes, with that action's own protection. */
  actionDependencies: Array<{ actionId: string; protection: OperationProtection }>;
  /**
   * spec15 §101 — action steps whose `ActionDef` requires a policy. Static analysis cannot
   * prove the workflow's start principal satisfies that policy, so each is a
   * privilege-amplification surface to review (the runtime enforces it per step, §10).
   */
  privilegeReviewActions: string[];
}

export interface AuthorizationAnalysis {
  /**
   * Whether the graph carries any 0.15 authorization vocabulary — an `AuthorizationPolicyDef`
   * or an `authorizationPolicy` / `startPolicy` / `instanceAccessPolicy` reference. When
   * `true` the graph requires Server IR contract `axiom.server.v9`.
   */
  usesAuthorizationVocabulary: boolean;
  policies: AuthorizationPolicyAnalysis[];
  operations: OperationCoverage[];
  workflows: WorkflowAuthorizationAnalysis[];
  /** Every semantic surface with no explicit authorization boundary (spec15 §43). */
  unprotected: Array<{ nodeId: string; nodeKind: string; operation: string }>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A secret-free one-line rendering of common policy shapes; falls back to a dependency list. */
function summarize(policy: AuthorizationPolicyDef, deps: ReturnType<typeof authorizationPolicyDependencies>): string {
  if (deps.constant === 'always-allow') return 'always allows';
  if (deps.constant === 'always-deny') return 'always denies';
  const rendered = renderExpression((policy as { allow?: unknown }).allow);
  if (rendered) return `requires ${rendered}`;
  const parts: string[] = [];
  if (deps.principalFields.length) parts.push(`PRINCIPAL.{${deps.principalFields.join(', ')}}`);
  if (deps.resourceFields.length) parts.push(`RESOURCE.{${deps.resourceFields.join(', ')}}`);
  if (deps.readsOperation) parts.push('OPERATION');
  return parts.length ? `a predicate over ${parts.join(' and ')}` : 'a predicate';
}

/** Best-effort structural render — only shapes with no runtime-secret exposure. */
function renderExpression(expression: unknown): string | null {
  if (!expression || typeof expression !== 'object') return null;
  const e = expression as Record<string, unknown>;
  switch (e.kind) {
    case 'literal':
      return JSON.stringify(e.value);
    case 'ref':
      return refName(String(e.targetId));
    case 'field': {
      const src = renderExpression(e.source);
      return src ? `${src}.${String(e.fieldId)}` : null;
    }
    case 'unary': {
      const operand = renderExpression(e.operand);
      return operand ? `${String(e.operator)} ${operand}` : null;
    }
    case 'binary': {
      const l = renderExpression(e.left);
      const r = renderExpression(e.right);
      return l && r ? `${l} ${binaryOp(String(e.operator))} ${r}` : null;
    }
    case 'call': {
      const args = Array.isArray(e.arguments) ? e.arguments.map(renderExpression) : [];
      return args.every((a) => a !== null) ? `${String(e.function)}(${args.join(', ')})` : null;
    }
    default:
      return null;
  }
}

function refName(id: string): string {
  if (id === 'axiom_principal') return 'PRINCIPAL';
  if (id === 'axiom_resource') return 'RESOURCE';
  if (id === 'axiom_operation') return 'OPERATION';
  return id;
}

function binaryOp(op: string): string {
  return (
    { eq: '==', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', and: 'AND', or: 'OR' } as Record<string, string>
  )[op] ?? op;
}

export function analyzeAuthorization(graph: ApplicationGraph): AuthorizationAnalysis {
  const policyNodes = graph.getNodesByKind('authorization-policy') as AuthorizationPolicyDef[];
  const actions = graph.getNodesByKind('action') as ActionDef[];
  const queries = graph.getNodesByKind('query') as QueryDef[];
  const workflows = graph.getNodesByKind('workflow') as WorkflowDef[];
  const readPolicyEntities = new Set(
    (graph.getNodesByKind('read-policy') as Array<{ entityId?: unknown; id?: unknown }>).map((p) => String(p.entityId)),
  );
  const readPolicyByEntity = new Map(
    (graph.getNodesByKind('read-policy') as Array<{ entityId?: unknown; id?: unknown }>).map((p) => [
      String(p.entityId),
      String(p.id),
    ]),
  );

  const policies: AuthorizationPolicyAnalysis[] = policyNodes.map((policy) => {
    const deps = authorizationPolicyDependencies(policy);
    return {
      policyId: String((policy as { id?: unknown }).id),
      principalFields: deps.principalFields,
      resourceFields: deps.resourceFields,
      readsOperation: deps.readsOperation,
      constant: deps.constant,
      summary: summarize(policy, deps),
      problems: authorizationPolicyProblems(policy).map((p) => `[${p.code}] ${p.message}`),
    };
  });

  const operations: OperationCoverage[] = [];
  const unprotected: AuthorizationAnalysis['unprotected'] = [];

  for (const action of actions) {
    const policyId = asString((action as { authorizationPolicy?: unknown }).authorizationPolicy);
    const hasLegacy = (action as { authorization?: unknown }).authorization !== undefined;
    let protection: OperationProtection;
    if (policyId && hasLegacy) protection = { kind: 'policy+legacy', policyId };
    else if (policyId) protection = { kind: 'policy', policyId };
    else if (hasLegacy) protection = { kind: 'legacy-expression' };
    else protection = { kind: 'public' };
    const unresolved = protection.kind === 'public';
    operations.push({ operation: 'action.invoke', nodeId: String(action.id), nodeKind: 'action', protection, unresolved });
    if (unresolved) unprotected.push({ nodeId: String(action.id), nodeKind: 'action', operation: 'action.invoke' });
  }

  for (const query of queries) {
    const policyId = asString((query as { authorizationPolicy?: unknown }).authorizationPolicy);
    const readPolicyId =
      asString((query as { readPolicyId?: unknown }).readPolicyId) ??
      (readPolicyEntities.has(String((query as { source?: unknown }).source))
        ? (readPolicyByEntity.get(String((query as { source?: unknown }).source)) ?? null)
        : null);
    let protection: OperationProtection;
    if (policyId && readPolicyId) protection = { kind: 'policy+read-policy', policyId, readPolicyId };
    else if (policyId) protection = { kind: 'policy', policyId };
    else if (readPolicyId) protection = { kind: 'read-policy', readPolicyId };
    else protection = { kind: 'public' };
    const unresolved = protection.kind === 'public';
    operations.push({ operation: 'query.read', nodeId: String(query.id), nodeKind: 'query', protection, unresolved });
    if (unresolved) unprotected.push({ nodeId: String(query.id), nodeKind: 'query', operation: 'query.read' });
  }

  const protectionOf = (actionId: string): OperationProtection =>
    operations.find((o) => o.nodeKind === 'action' && o.nodeId === actionId)?.protection ?? { kind: 'public' };

  const workflowAnalyses: WorkflowAuthorizationAnalysis[] = workflows.map((workflow) => {
    const startPolicyId = asString((workflow as { startPolicy?: unknown }).startPolicy);
    const instanceAccessPolicyId = asString((workflow as { instanceAccessPolicy?: unknown }).instanceAccessPolicy);
    const actionIds = safeWorkflowActionIds(workflow).map(String);
    const actionDependencies = [...new Set(actionIds)].map((actionId) => ({
      actionId,
      protection: protectionOf(actionId),
    }));
    const privilegeReviewActions = actionDependencies
      .filter((d) => d.protection.kind === 'policy' || d.protection.kind === 'policy+legacy' || d.protection.kind === 'legacy-expression')
      .map((d) => d.actionId);

    // workflow.start
    operations.push({
      operation: 'workflow.start',
      nodeId: String(workflow.id),
      nodeKind: 'workflow',
      protection: startPolicyId ? { kind: 'policy', policyId: startPolicyId } : { kind: 'public' },
      unresolved: !startPolicyId,
    });
    if (!startPolicyId) unprotected.push({ nodeId: String(workflow.id), nodeKind: 'workflow', operation: 'workflow.start' });
    // workflow.cancel / .inspect / .history — owner-fingerprint is a defined default, not "unresolved".
    for (const op of ['workflow.cancel', 'workflow.inspect', 'workflow.history'] as const) {
      operations.push({
        operation: op,
        nodeId: String(workflow.id),
        nodeKind: 'workflow',
        protection: instanceAccessPolicyId ? { kind: 'policy', policyId: instanceAccessPolicyId } : { kind: 'owner-fingerprint' },
        unresolved: false,
      });
    }

    return {
      workflowId: String(workflow.id),
      start: startPolicyId ? 'policy' : 'public',
      startPolicyId,
      instanceAccess: instanceAccessPolicyId ? 'policy' : 'owner-fingerprint',
      instanceAccessPolicyId,
      actionDependencies,
      privilegeReviewActions,
    };
  });

  const usesAuthorizationVocabulary =
    policyNodes.length > 0 ||
    actions.some((a) => (a as { authorizationPolicy?: unknown }).authorizationPolicy !== undefined) ||
    queries.some((q) => (q as { authorizationPolicy?: unknown }).authorizationPolicy !== undefined) ||
    workflows.some(
      (w) =>
        (w as { startPolicy?: unknown }).startPolicy !== undefined ||
        (w as { instanceAccessPolicy?: unknown }).instanceAccessPolicy !== undefined,
    );

  return {
    usesAuthorizationVocabulary,
    policies,
    operations,
    workflows: workflowAnalyses,
    unprotected,
  };
}

function safeWorkflowActionIds(workflow: WorkflowDef): ReturnType<typeof workflowActionIds> {
  try {
    return workflowActionIds(workflow);
  } catch {
    return [];
  }
}
