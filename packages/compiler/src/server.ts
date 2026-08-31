import {
  actionAuthority,
  actionGuards,
  authorityContext,
  expressionDefsIn,
  isObservable,
  maxContract,
  requiredServerContract,
  schemaFingerprint,
  stripAuthoringMetadata,
  serverIRExpressions,
  serverStateClosure,
  stateAuthority,
  usesExternalIOVocabulary,
  usesIntegrationVocabulary,
  usesInvocationVocabulary,
  usesMigrationVocabulary,
  usesQueryVocabulary,
  usesWorkflowVocabulary,
  usesV4Semantics,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ApplicationGraph,
  ConstraintDef,
  EntityDef,
  EventDef,
  ExpressionDef,
  FieldId,
  IntegrationDef,
  IntegrationOperationDef,
  NodeId,
  MigrationDef,
  QueryDef,
  ReadPolicyDef,
  RelationshipDef,
  ServerIR,
  ServerIRContract,
  StateDef,
  StorageDef,
  SubscriptionDef,
  TransitionConstraintDef,
  TriggerDef,
  WorkflowDef,
} from '@cynodia/axiom-core';
import { GraphValidationError } from './normalize.js';
import type { CompileOptions } from './normalize.js';

/**
 * Compiles the authoritative half of a graph.
 *
 * What an authority needs is not what a client needs, and the difference is the point: the
 * Server IR carries the rules a client must never be trusted with, and none of the UI,
 * presentation, theme or routing that decides nothing.
 *
 * The result is plain JSON — deterministic, closure-free and free of anything specific to
 * a language or host — so a conforming runtime in another language can execute it and reach
 * the same semantic result.
 */
export function compileToServerIR(graph: ApplicationGraph, options: CompileOptions = {}): ServerIR {
  if (options.validate !== false) {
    const result = validateGraph(graph);
    if (!result.valid) {
      throw new GraphValidationError(result);
    }
  }

  const nodes = graph.listNodes();
  const context = authorityContext(nodes, graph.principalEntityId);
  const needed = serverStateClosure(context);

  const entities: EntityDef[] = [];
  const constraints: ConstraintDef[] = [];
  const transitionConstraints: TransitionConstraintDef[] = [];
  const expressionDefs: Record<NodeId, ExpressionDef> = {};
  const integrations: IntegrationDef[] = [];
  const integrationOperations: Record<NodeId, IntegrationOperationDef> = {};
  const events: EventDef[] = [];
  const subscriptions: SubscriptionDef[] = [];
  const storages: StorageDef[] = [];
  const queries: QueryDef[] = [];
  const relationships: RelationshipDef[] = [];
  const readPolicies: ReadPolicyDef[] = [];
  const migrations: MigrationDef[] = [];
  const workflows: WorkflowDef[] = [];
  for (const node of nodes) {
    if (node.kind === 'entity') {
      entities.push(node);
    } else if (node.kind === 'constraint') {
      constraints.push(node);
    } else if (node.kind === 'transition-constraint') {
      transitionConstraints.push(node);
    } else if (node.kind === 'expression') {
      expressionDefs[node.id] = node;
    } else if (node.kind === 'integration') {
      integrations.push(node);
    } else if (node.kind === 'integration-operation') {
      integrationOperations[node.id] = node;
    } else if (node.kind === 'event') {
      events.push(node);
    } else if (node.kind === 'subscription') {
      // Every subscription is authority-side by construction: there is no client half to
      // decide about (spec 0.9 §62-64), and validation has already refused a graph that
      // declares one without an authority to activate it.
      subscriptions.push(node);
    } else if (node.kind === 'storage') {
      storages.push(node);
    } else if (node.kind === 'query') {
      // A query reads authoritative data, so it is executed on the authority and nowhere
      // else. The client invokes it by id (spec 0.10 §6); it never receives the clauses.
      queries.push(node);
    } else if (node.kind === 'relationship') {
      relationships.push(node);
    } else if (node.kind === 'read-policy') {
      readPolicies.push(node);
    } else if (node.kind === 'workflow') {
      // A workflow is authority-side by construction: only the authoritative runtime owns
      // durable orchestration state, leases and fencing (spec14 §87). It never reaches a
      // client. Authoring markers are stripped like any other trust-boundary payload.
      workflows.push(stripAuthoringMetadata(node));
    } else if (node.kind === 'migration') {
      // A migration is authority-side by construction: only the authoritative runtime
      // executes a schema evolution, and only against persisted canonical data (spec11
      // §73). It never reaches a client. Authoring markers on the migration or its
      // operations are stripped like any other trust-boundary payload.
      migrations.push({
        ...stripAuthoringMetadata(node),
        operations: node.operations.map((operation) => stripAuthoringMetadata(operation)),
        ...(node.reverseOperations
          ? { reverseOperations: node.reverseOperations.map((operation) => stripAuthoringMetadata(operation)) }
          : {}),
      });
    }
  }

  const states: StateDef[] = [];
  const observableStateIds: NodeId[] = [];
  for (const state of context.states.values()) {
    if (!needed.has(state.id)) {
      continue;
    }
    states.push(state);
    if (stateAuthority(state) === 'server' && isObservable(state)) {
      observableStateIds.push(state.id);
    }
  }

  const actions: Record<NodeId, ActionDef> = {};
  for (const action of context.actions.values()) {
    if (actionAuthority(action, context) !== 'server') {
      continue;
    }
    // Guards are authoring sugar in both halves: the IR carries conditions and failures
    // aligned by position, exactly as the client IR does. An authority that read `guards`
    // and not `preconditions` would silently not check them.
    const guards = actionGuards(action);
    actions[action.id] = {
      ...action,
      preconditions: guards.map((guard) => guard.condition),
      failureModes: guards.map((guard) => guard.failureMode ?? { code: 'precondition-failed' }),
    };
  }

  // Only the triggers whose target action executes here. A `route-enter`/`route-leave`
  // trigger's target is always client-authority (validated), so it is naturally excluded.
  const triggers: TriggerDef[] = [];
  for (const node of nodes) {
    if (node.kind !== 'trigger') {
      continue;
    }
    const target = context.actions.get(node.actionId);
    if (target && actionAuthority(target, context) === 'server') {
      triggers.push(node);
    }
  }

  const fields: Record<FieldId, ServerIR['fields'][FieldId]> = {} as ServerIR['fields'];
  for (const entry of graph.listFields()) {
    fields[entry.field.id] = entry;
  }

  // Schema-evolution vocabulary is emitted only when the document actually uses it — a
  // migration node, or a schemaVersion past the default 1. A plain graph compiles to the
  // byte-identical pre-v7 document it always did, so the frozen v1–v6 contracts and their
  // conformance fixtures are untouched (spec11 §87).
  const emitSchemaEvolution = usesMigrationVocabulary({
    migrations,
    schemaVersion: graph.schemaVersion,
  });

  const rules = {
    id: graph.id,
    name: graph.name,
    version: graph.version,
    ...(emitSchemaEvolution
      ? {
          schemaVersion: graph.schemaVersion,
          schemaFingerprint: schemaFingerprint(graph),
          ...(migrations.length > 0 ? { migrations } : {}),
        }
      : {}),
    entities,
    fields,
    states,
    actions,
    constraints,
    transitionConstraints,
    ...(graph.principalEntityId ? { principalEntityId: graph.principalEntityId } : {}),
    observableStateIds,
    ...(integrations.length > 0 ? { integrations } : {}),
    ...(Object.keys(integrationOperations).length > 0 ? { integrationOperations } : {}),
    ...(events.length > 0 ? { events } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(subscriptions.length > 0 ? { subscriptions } : {}),
    ...(storages.length > 0 ? { storages } : {}),
    ...(queries.length > 0 ? { queries } : {}),
    ...(relationships.length > 0 ? { relationships } : {}),
    ...(readPolicies.length > 0 ? { readPolicies } : {}),
    ...(workflows.length > 0 ? { workflows } : {}),
  };

  // Only the definitions the authority's own rules reach. A calculation used by the client
  // alone decides nothing here, and the Server IR carries nothing that decides nothing.
  const used: Record<NodeId, ExpressionDef> = {};
  const pending = serverIRExpressions(rules).flatMap((expression) => expressionDefsIn(expression));
  while (pending.length > 0) {
    const id = pending.pop() as NodeId;
    const definition = expressionDefs[id];
    if (!definition || used[id]) {
      continue;
    }
    used[id] = definition;
    pending.push(...expressionDefsIn(definition.expression));
  }
  const carriesDefinitions = Object.keys(used).length > 0;
  const document = { ...rules, ...(carriesDefinitions ? { expressionDefs: used } : {}) };

  /**
   * The label follows the vocabulary the document actually uses. An application that uses
   * nothing from 0.7 or 0.8 compiles to the same `axiom.server.v1` document it always did;
   * one that groups or names an expression, or uses any integration/trigger/event
   * vocabulary, says so, because an older runtime could not execute it.
   */
  const contractCandidates: ServerIRContract[] = [
    carriesDefinitions || usesInvocationVocabulary(document)
      ? 'axiom.server.v2'
      : requiredServerContract(serverIRExpressions(document)),
    usesIntegrationVocabulary(document) ? 'axiom.server.v3' : 'axiom.server.v1',
    usesV4Semantics(document) ? 'axiom.server.v4' : 'axiom.server.v1',
    usesExternalIOVocabulary(document) ? 'axiom.server.v5' : 'axiom.server.v1',
    usesQueryVocabulary(document) ? 'axiom.server.v6' : 'axiom.server.v1',
    usesMigrationVocabulary(document) ? 'axiom.server.v7' : 'axiom.server.v1',
    usesWorkflowVocabulary(document) ? 'axiom.server.v8' : 'axiom.server.v1',
  ];
  const contract = contractCandidates.reduce(maxContract);

  return { contract, ...document };
}

export function serializeServerIR(ir: ServerIR): string {
  return JSON.stringify(ir);
}

/** Whether a graph has any authoritative half at all. */
export function hasServerAuthority(graph: ApplicationGraph): boolean {
  const context = authorityContext(graph.listNodes(), graph.principalEntityId);
  return [...context.states.values()].some((state) => stateAuthority(state) === 'server');
}
