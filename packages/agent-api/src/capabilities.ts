import { actionOperations } from '@cynodia/axiom-core';
import type { ApplicationGraph } from '@cynodia/axiom-core';
import { analyzeLiveQuery } from './live-query.js';

/**
 * Required-runtime-capability analysis (spec16 §30-31, §50-51). A graph declares no host or
 * provider; it requires *capability domains* — the closed vocabulary a conforming
 * `AxiomServer` already reasons about (persistence, coordination, durable workflow storage,
 * a scheduler, mutation observation for live queries, …). This module answers "what would
 * a runtime need to execute this graph", with the provenance for each requirement (spec16
 * §31), never a specific provider brand (spec16 §51).
 */
export const REQUIRED_CAPABILITIES = [
  'persistence',
  'coordination',
  'mutation-observation',
  'live-queries',
  'workflow-store',
  'event-journal',
  'scheduler',
  'effect-execution',
  'provider-transaction',
  'blob-storage',
  'subscription-adapter',
] as const;
export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];

export interface CapabilityRequirement {
  capability: RequiredCapability;
  required: boolean;
  /** Why this capability is or is not required — structural, not a guess (spec16 §31). */
  reasons: string[];
}

export interface CapabilityAnalysis {
  requirements: CapabilityRequirement[];
  /** Only the capabilities this graph actually requires. */
  requiredCapabilities: RequiredCapability[];
}

export function analyzeCapabilities(graph: ApplicationGraph): CapabilityAnalysis {
  const reasons = new Map<RequiredCapability, string[]>();
  const require = (capability: RequiredCapability, reason: string): void => {
    const list = reasons.get(capability) ?? [];
    list.push(reason);
    reasons.set(capability, list);
  };

  const actions = graph.getNodesByKind('action');
  const workflows = graph.getNodesByKind('workflow');
  const queries = graph.getNodesByKind('query');
  const triggers = graph.getNodesByKind('trigger');
  const subscriptions = graph.getNodesByKind('subscription');
  const storages = graph.getNodesByKind('storage');
  const serverStates = graph.getNodesByKind('state').filter((s) => (s.authority ?? 'client') === 'server');

  if (serverStates.length > 0) {
    require('persistence', `server-authoritative StateDef: ${serverStates.map((s) => s.id).sort().join(', ')}`);
  }
  if (queries.length > 0) {
    require('persistence', `QueryDef reads authoritative data through a DataProvider: ${queries.map((q) => q.id).sort().join(', ')}`);
    require('provider-transaction', `QueryDef/provider-record mutation requires a transactional provider: ${queries.map((q) => q.id).sort().join(', ')}`);
  }

  if (workflows.length > 0) {
    require('persistence', `WorkflowDef instances are durable state: ${workflows.map((w) => w.id).sort().join(', ')}`);
    require('coordination', `WorkflowDef instance ownership is a fenced, leased claim: ${workflows.map((w) => w.id).sort().join(', ')}`);
    require('workflow-store', `WorkflowDef requires a durable WorkflowStore: ${workflows.map((w) => w.id).sort().join(', ')}`);
    for (const workflow of workflows) {
      const events = graph.getOutgoingEdges(workflow.id, { kinds: ['references'] }).filter((e) => graph.getNode(e.to)?.kind === 'event');
      if (events.length > 0) {
        require('event-journal', `WorkflowDef ${workflow.id} waits on an event, requiring the durable event journal`);
      }
    }
  }

  const timedTriggers = triggers.filter((t) => t.when.kind === 'interval' || t.when.kind === 'delay');
  if (timedTriggers.length > 0) {
    require('scheduler', `timed TriggerDef: ${timedTriggers.map((t) => t.id).sort().join(', ')}`);
    require('coordination', `a distributed scheduler must fence duplicate firings: ${timedTriggers.map((t) => t.id).sort().join(', ')}`);
  }

  for (const query of queries) {
    const capability = analyzeLiveQuery(graph, query.id).capability;
    if (capability.capability !== 'not-live-capable') {
      require('live-queries', `QueryDef ${query.id} is ${capability.capability}`);
      require('mutation-observation', `QueryDef ${query.id} is live-capable and needs commit revision observation`);
    }
  }

  for (const action of actions) {
    const effectOps = actionOperations(action).filter(
      (op) => op.kind === 'integration-effect' || op.kind === 'blob-commit' || op.kind === 'blob-delete',
    );
    if (effectOps.length > 0) {
      require('effect-execution', `ActionDef ${action.id} creates a logical effect (${effectOps.map((op) => op.kind).join(', ')})`);
    }
  }

  if (storages.length > 0) {
    require('blob-storage', `StorageDef: ${storages.map((s) => s.id).sort().join(', ')}`);
  }
  if (subscriptions.length > 0) {
    require('subscription-adapter', `SubscriptionDef: ${subscriptions.map((s) => s.id).sort().join(', ')}`);
    require('coordination', `SubscriptionDef cursor ownership is a fenced claim: ${subscriptions.map((s) => s.id).sort().join(', ')}`);
  }

  const requirements: CapabilityRequirement[] = REQUIRED_CAPABILITIES.map((capability) => ({
    capability,
    required: reasons.has(capability),
    reasons: reasons.get(capability) ?? [],
  }));

  return {
    requirements,
    requiredCapabilities: requirements.filter((r) => r.required).map((r) => r.capability),
  };
}
