import {
  authorityCompatibilityKey,
  schemaFingerprint,
  semanticFingerprint,
  type ApplicationGraph,
  type AuthorityCompatibilityKey,
} from '@cynodia/axiom-core';
import type { ActionDef, SubscriptionDef, TriggerDef } from '@cynodia/axiom-core';

/**
 * Static, graph-derivable distributed-authority inspection (spec12 §56, §57).
 *
 * The AgentAPI works over an `ApplicationGraph`, not a running authority, so it answers the
 * *semantic* questions — which framework-owned async work this application has, and what
 * distributed guarantee applies to each — not the live runtime state (that is
 * `AxiomServer.authority()` / `inspectDistributedWork()`).
 *
 * Every answer separates the four things spec12 §56 says must never be conflated:
 * `semanticGuarantee` (fixed by the framework), `runtimeStateAvailableFrom` (where to read
 * the live state), `providerCapabilityRequired` (what a provider must advertise), and
 * `operationalTuning` (knobs that never change a guarantee).
 */

export interface DeliveryContract {
  logicalCreation: 'exactly-once';
  physicalExecution: 'at-least-once' | 'exactly-once-if-provider-idempotent';
  completionTransition: 'exactly-once';
}

export interface DistributedWorkClassInfo {
  workClass: 'effect' | 'schedule-firing' | 'subscription-delivery';
  /** The graph nodes that produce this class of work. */
  sources: string[];
  ownership: 'leased-per-work-item-fenced';
  orderingScope: 'none' | 'per-subscription';
  delivery: DeliveryContract | { guarantee: 'at-least-once'; duplicatesPossible: true };
  providerCapabilityRequired: string[];
  runtimeStateAvailableFrom: string;
}

export interface DistributedSemanticsInspection {
  /** No application API activates this; a capable shared provider does (spec12 §88). */
  activation: 'automatic-when-coordination-provider-and-durable-persistence-shared';
  compatibility: AuthorityCompatibilityKey & { note: string };
  workClasses: DistributedWorkClassInfo[];
  cacheCoherence: {
    mechanism: 'durable-revision-observation';
    stalenessBoundRevisions: 0;
    requiresBroadcast: false;
  };
  operationalTuning: string[];
}

const EFFECT_OP_KINDS = new Set(['integration-effect', 'blob-commit', 'blob-delete']);

function actionsWithEffects(graph: ApplicationGraph): ActionDef[] {
  return (graph.getNodesByKind('action') as ActionDef[]).filter((action) =>
    (action.operations ?? []).some((op) => EFFECT_OP_KINDS.has(op.kind)),
  );
}

function scheduledTriggers(graph: ApplicationGraph): TriggerDef[] {
  return (graph.getNodesByKind('trigger') as TriggerDef[]).filter(
    (trigger) => trigger.when.kind === 'interval' || trigger.when.kind === 'delay',
  );
}

/**
 * Summarize the distributed-authority semantics of an application (spec12 §56). Pure over
 * the graph. `serverContract` defaults to `axiom.server.v7` (0.12 adds no IR vocabulary).
 */
export function inspectDistributedSemantics(
  graph: ApplicationGraph,
  serverContract = 'axiom.server.v7',
): DistributedSemanticsInspection {
  const effects = actionsWithEffects(graph);
  const schedules = scheduledTriggers(graph);
  const subscriptions = graph.getNodesByKind('subscription') as SubscriptionDef[];

  const workClasses: DistributedWorkClassInfo[] = [];

  if (effects.length > 0) {
    workClasses.push({
      workClass: 'effect',
      sources: effects.map((action) => String(action.id)),
      ownership: 'leased-per-work-item-fenced',
      orderingScope: 'none',
      delivery: {
        logicalCreation: 'exactly-once',
        physicalExecution: 'at-least-once', // 'exactly-once-if-provider-idempotent' per operation
        completionTransition: 'exactly-once',
      },
      providerCapabilityRequired: ['distributed-lease', 'fencing', 'atomic-work-claim', 'durable-retry'],
      runtimeStateAvailableFrom: 'AxiomServer.inspectDistributedWork().effects',
    });
  }

  if (schedules.length > 0) {
    workClasses.push({
      workClass: 'schedule-firing',
      sources: schedules.map((trigger) => String(trigger.id)),
      ownership: 'leased-per-work-item-fenced',
      orderingScope: 'none',
      delivery: {
        logicalCreation: 'exactly-once',
        physicalExecution: 'at-least-once',
        completionTransition: 'exactly-once',
      },
      providerCapabilityRequired: ['distributed-lease', 'fencing', 'atomic-work-claim'],
      runtimeStateAvailableFrom: 'AxiomServer.inspectDistributedWork().schedules',
    });
  }

  if (subscriptions.length > 0) {
    workClasses.push({
      workClass: 'subscription-delivery',
      sources: subscriptions.map((subscription) => String(subscription.id)),
      ownership: 'leased-per-work-item-fenced',
      orderingScope: 'per-subscription',
      delivery: { guarantee: 'at-least-once', duplicatesPossible: true },
      providerCapabilityRequired: ['distributed-lease', 'fencing', 'durable-subscription-cursor', 'event-dedup'],
      runtimeStateAvailableFrom: 'AxiomServer.subscriptionLog() + inspectDistributedWork().subscriptionCursors',
    });
  }

  return {
    activation: 'automatic-when-coordination-provider-and-durable-persistence-shared',
    compatibility: {
      ...authorityCompatibilityKey({
        schemaVersion: graph.schemaVersion,
        schemaFingerprint: schemaFingerprint(graph),
        serverContract,
        semanticFingerprint: semanticFingerprint(graph),
      }),
      note: 'Two authorities may execute the same durable work iff these four fields are equal (fail closed).',
    },
    workClasses,
    cacheCoherence: {
      mechanism: 'durable-revision-observation',
      stalenessBoundRevisions: 0,
      requiresBroadcast: false,
    },
    operationalTuning: [
      'instanceId',
      'leaseDurationMs',
      'renewIntervalMs',
      'workerConcurrency',
      'claimBatchSize',
      'pollIntervalMs',
    ],
  };
}
