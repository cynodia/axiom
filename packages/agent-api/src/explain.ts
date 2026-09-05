import {
  actionOperations,
  type ActionDef,
  type ApplicationGraph,
  type NativeEffect,
  type NodeId,
  type StatePersistence,
  type TypeRef,
} from '@cynodia/axiom-core';
import { GraphQueries } from './queries.js';
import type { QueryExplanation } from './queries.js';
import { analyzeAuthorization } from './authorization.js';
import type { OperationProtection } from './authorization.js';
import { analyzeWorkflow } from './workflow.js';
import type { WorkflowAnalysis } from './workflow.js';
import { analyzeLiveQuery } from './live-query.js';
import type { LiveQueryAnalysis } from './live-query.js';

/**
 * Structured, machine-readable explanations of the semantic nodes an agent most often needs
 * to reason about before proposing a change (spec16 §17-21, §28-29). Every field here is
 * derived from the graph's own edges and node data — never from re-reading application
 * source — and an incomplete answer says so explicitly rather than presenting itself as
 * exhaustive (spec16 §16, §29, §102, §103).
 */

// --------------------------------------------------------------------------- explain action

export interface ActionExplanation {
  actionId: string;
  name?: string;
  parameters: Array<{ id: string; required: boolean; valueType?: TypeRef }>;
  /** States this action may read, and the specific fields where known. */
  reads: { stateIds: string[]; fieldIds: string[] };
  /** States this action may write, and the specific fields where known. */
  writes: { stateIds: string[]; fieldIds: string[] };
  /** Other actions this action invokes directly (an `invoke` operation). */
  invokesActions: string[];
  /** Integration operations this action calls, split by query/effect mode. */
  integrationQueries: string[];
  integrationEffects: string[];
  /** Registered `QueryDef`s this action runs via a `query` operation. */
  runsQueries: string[];
  /** Object stores this action reads, commits into, or deletes from. */
  storages: string[];
  /** Native operations embedded in this action, with their declared effects. */
  nativeOperations: Array<{ implementationId: string; declaredEffects: NativeEffect[] }>;
  /** How `action.invoke` is protected. */
  authorization: OperationProtection;
  /** Entity constraints and transition constraints that can refuse this action's write. */
  constraintsThatMayBlock: { constraints: string[]; transitionConstraints: string[] };
  /** What can cause this action to run other than a direct client invocation. */
  invokedBy: { triggers: string[]; workflowSteps: string[] };
  clientInvocable: boolean;
  systemOnly: boolean;
  destructive: boolean;
  /** False when a native operation without declared effects prevents a complete answer. */
  analysisComplete: boolean;
  analysisGaps: string[];
}

function fieldIdsOf(edges: readonly { to: NodeId; metadata?: Record<string, unknown> }[]): string[] {
  const ids = new Set<string>();
  for (const edge of edges) {
    for (const fieldId of (edge.metadata?.fieldIds as string[] | undefined) ?? []) {
      ids.add(fieldId);
    }
  }
  return [...ids].sort();
}

export function explainAction(graph: ApplicationGraph, actionId: NodeId): ActionExplanation | undefined {
  const action = graph.getNode<ActionDef>(actionId);
  if (!action || action.kind !== 'action') {
    return undefined;
  }
  const queries = new GraphQueries(graph);
  const reads = graph.getOutgoingEdges(actionId, { kinds: ['reads'] });
  const writes = graph.getOutgoingEdges(actionId, { kinds: ['writes'] });
  const references = graph.getOutgoingEdges(actionId, { kinds: ['references'] });
  const invokes = graph.getOutgoingEdges(actionId, { kinds: ['invokes'] });

  const integrationQueries: string[] = [];
  const integrationEffects: string[] = [];
  const runsQueries: string[] = [];
  const storagesTouched = new Set<string>();
  for (const edge of references) {
    const target = graph.getNode(edge.to);
    if (!target) continue;
    if (target.kind === 'integration-operation') {
      (target.mode === 'effect' ? integrationEffects : integrationQueries).push(target.id);
    } else if (target.kind === 'query') {
      runsQueries.push(target.id);
    }
  }
  for (const operation of actionOperations(action)) {
    if (operation.kind === 'blob-metadata' || operation.kind === 'blob-commit' || operation.kind === 'blob-delete') {
      storagesTouched.add(operation.storageId);
    }
  }

  const nativeOperations = actionOperations(action)
    .filter((operation): operation is Extract<typeof operation, { kind: 'native' }> => operation.kind === 'native')
    .map((operation) => ({ implementationId: operation.implementationId, declaredEffects: operation.declaredEffects ?? [] }));
  const analysisGaps = nativeOperations
    .filter((native) => native.declaredEffects.length === 0)
    .map((native) => `native operation "${native.implementationId}" does not declare its effects`);

  const writeEntityIds = new Set<string>();
  for (const edge of writes) {
    for (const entityEdge of graph.getOutgoingEdges(edge.to, { kinds: ['references'] })) {
      writeEntityIds.add(entityEdge.to);
    }
  }
  const constraints = graph
    .getNodesByKind('constraint')
    .filter((c) => c.entityId && writeEntityIds.has(c.entityId))
    .map((c) => c.id);
  const transitionConstraints = graph
    .getNodesByKind('transition-constraint')
    .filter((c) => writeEntityIds.has(c.entityId))
    .map((c) => c.id);

  const invokedByEdges = graph.getIncomingEdges(actionId, { kinds: ['invokes'] });
  const triggers = invokedByEdges
    .map((edge) => graph.getNode(edge.from))
    .filter((node): node is NonNullable<typeof node> => node?.kind === 'trigger')
    .map((node) => node.id);
  const workflowSteps = invokedByEdges
    .map((edge) => graph.getNode(edge.from))
    .filter((node): node is NonNullable<typeof node> => node?.kind === 'workflow')
    .map((node) => node.id);

  const authorization = analyzeAuthorization(graph).operations.find(
    (op) => op.nodeKind === 'action' && op.nodeId === actionId,
  )?.protection ?? { kind: 'public' as const };

  return {
    actionId: action.id,
    ...(action.name ? { name: action.name } : {}),
    parameters: (action.parameters ?? []).map((p) => ({
      id: p.id,
      required: p.required !== false,
      ...(p.valueType ? { valueType: p.valueType } : {}),
    })),
    reads: { stateIds: [...new Set(reads.map((e) => e.to))].sort(), fieldIds: fieldIdsOf(reads) },
    writes: { stateIds: [...new Set(writes.map((e) => e.to))].sort(), fieldIds: fieldIdsOf(writes) },
    invokesActions: invokes.map((e) => e.to).sort(),
    integrationQueries: [...new Set(integrationQueries)].sort(),
    integrationEffects: [...new Set(integrationEffects)].sort(),
    runsQueries: [...new Set(runsQueries)].sort(),
    storages: [...storagesTouched].sort(),
    nativeOperations,
    authorization,
    constraintsThatMayBlock: { constraints: constraints.sort(), transitionConstraints: transitionConstraints.sort() },
    invokedBy: { triggers: triggers.sort(), workflowSteps: workflowSteps.sort() },
    clientInvocable: queries.isClientInvocable(actionId),
    systemOnly: queries.isSystemOnly(actionId),
    destructive: action.destructive === true || actionOperations(action).some((op) => op.kind === 'remove'),
    analysisComplete: analysisGaps.length === 0,
    analysisGaps,
  };
}

// ---------------------------------------------------------------------------- explain state

export interface StateExplanation {
  stateId: string;
  name?: string;
  valueType: TypeRef;
  derived: boolean;
  draft: boolean;
  ephemeral: boolean;
  authority: 'client' | 'server';
  serverOnly: boolean;
  persistence: StatePersistence;
  hasInitialValue: boolean;
  /** Nodes that read this state: views, derived state, action conditions and reads. */
  readers: string[];
  /** Actions that mutate this state. */
  writers: string[];
  /** Entities this state's type holds instances of. */
  entities: string[];
  constraints: string[];
  transitionConstraints: string[];
}

export function explainState(graph: ApplicationGraph, stateId: NodeId): StateExplanation | undefined {
  const state = graph.getNode(stateId);
  if (!state || state.kind !== 'state') {
    return undefined;
  }
  const readers = graph.getIncomingEdges(stateId, { kinds: ['reads', 'binds', 'derives-from'] }).map((e) => e.from);
  const writers = graph
    .getIncomingEdges(stateId, { kinds: ['writes'] })
    .map((e) => graph.getNode(e.from))
    .filter((n): n is NonNullable<typeof n> => n?.kind === 'action')
    .map((n) => n.id);
  const entities = graph.getOutgoingEdges(stateId, { kinds: ['references'] }).map((e) => e.to);
  const entitySet = new Set(entities);
  const constraints = graph
    .getNodesByKind('constraint')
    .filter((c) => c.entityId && entitySet.has(c.entityId))
    .map((c) => c.id);
  const transitionConstraints = graph
    .getNodesByKind('transition-constraint')
    .filter((c) => entitySet.has(c.entityId))
    .map((c) => c.id);

  return {
    stateId: state.id,
    ...(state.name ? { name: state.name } : {}),
    valueType: state.valueType,
    derived: state.derivation !== undefined,
    draft: state.draft === true,
    ephemeral: state.ephemeral === true,
    authority: state.authority ?? 'client',
    serverOnly: state.serverOnly === true,
    persistence: state.persistence ?? { kind: 'memory' },
    hasInitialValue: state.initialValue !== undefined,
    readers: [...new Set(readers)].sort(),
    writers: [...new Set(writers)].sort(),
    entities: [...entitySet].sort(),
    constraints: constraints.sort(),
    transitionConstraints: transitionConstraints.sort(),
  };
}

// ---------------------------------------------------------------- explain query / workflow

export interface FullQueryExplanation extends QueryExplanation {
  authorization: OperationProtection;
  liveCapability: LiveQueryAnalysis['capability']['capability'];
}

/** `explainQuery` plus the authorization surface and live-query capability (spec16 §18). */
export function explainQueryFull(graph: ApplicationGraph, queryId: NodeId): FullQueryExplanation | undefined {
  const queries = new GraphQueries(graph);
  const base = queries.explainQuery(queryId);
  if (!base) {
    return undefined;
  }
  const authorization = analyzeAuthorization(graph).operations.find(
    (op) => op.nodeKind === 'query' && op.nodeId === queryId,
  )?.protection ?? { kind: 'public' as const };
  return { ...base, authorization, liveCapability: analyzeLiveQuery(graph, queryId).capability.capability };
}

export interface FullWorkflowExplanation extends WorkflowAnalysis {
  startPolicyId: string | null;
  instanceAccessPolicyId: string | null;
  actionAuthorization: Array<{ actionId: string; protection: OperationProtection }>;
  privilegeReviewActions: string[];
}

/** `analyzeWorkflow` plus its authorization surface — start policy, instance access, and each step action's protection (spec16 §19). */
export function explainWorkflowFull(graph: ApplicationGraph, workflowId: NodeId): FullWorkflowExplanation {
  const base = analyzeWorkflow(graph, workflowId);
  const authz = analyzeAuthorization(graph).workflows.find((w) => w.workflowId === workflowId);
  return {
    ...base,
    startPolicyId: authz?.startPolicyId ?? null,
    instanceAccessPolicyId: authz?.instanceAccessPolicyId ?? null,
    actionAuthorization: authz?.actionDependencies ?? [],
    privilegeReviewActions: authz?.privilegeReviewActions ?? [],
  };
}

// --------------------------------------------------------------------------- explain graph

export interface GraphSummary {
  nodeCountsByKind: Record<string, number>;
  executableRoots: { actions: string[]; workflows: string[]; queries: string[] };
  securityBoundaries: { protectedActions: number; publicActions: number; protectedQueries: number; publicQueries: number };
  externalCapabilities: { integrations: number; subscriptions: number; storages: number };
  opaqueBoundaries: number;
}

/** A structural, domain-neutral graph summary (spec16 §161-162): counts and roots, never invented business prose. */
export function explainGraph(graph: ApplicationGraph): GraphSummary {
  const nodeCountsByKind: Record<string, number> = {};
  for (const node of graph.listNodes()) {
    nodeCountsByKind[node.kind] = (nodeCountsByKind[node.kind] ?? 0) + 1;
  }
  const authz = analyzeAuthorization(graph);
  const actionOps = authz.operations.filter((op) => op.nodeKind === 'action');
  const queryOps = authz.operations.filter((op) => op.nodeKind === 'query');
  let opaqueBoundaries = 0;
  for (const action of graph.getNodesByKind('action')) {
    opaqueBoundaries += actionOperations(action).filter((op) => op.kind === 'native').length;
  }
  return {
    nodeCountsByKind,
    executableRoots: {
      actions: graph.getNodesByKind('action').filter((a) => new GraphQueries(graph).isClientInvocable(a.id)).map((a) => a.id).sort(),
      workflows: graph.getNodesByKind('workflow').map((w) => w.id).sort(),
      queries: graph.getNodesByKind('query').map((q) => q.id).sort(),
    },
    securityBoundaries: {
      protectedActions: actionOps.filter((op) => !op.unresolved).length,
      publicActions: actionOps.filter((op) => op.unresolved).length,
      protectedQueries: queryOps.filter((op) => !op.unresolved).length,
      publicQueries: queryOps.filter((op) => op.unresolved).length,
    },
    externalCapabilities: {
      integrations: graph.getNodesByKind('integration').length,
      subscriptions: graph.getNodesByKind('subscription').length,
      storages: graph.getNodesByKind('storage').length,
    },
    opaqueBoundaries,
  };
}
