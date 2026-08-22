import {
  SERVER_IR_CONTRACT,
  actionAuthority,
  actionGuards,
  authorityContext,
  isObservable,
  serverStateClosure,
  stateAuthority,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ApplicationGraph,
  ConstraintDef,
  EntityDef,
  FieldId,
  NodeId,
  ServerIR,
  StateDef,
  TransitionConstraintDef,
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
  for (const node of nodes) {
    if (node.kind === 'entity') {
      entities.push(node);
    } else if (node.kind === 'constraint') {
      constraints.push(node);
    } else if (node.kind === 'transition-constraint') {
      transitionConstraints.push(node);
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

  const fields: Record<FieldId, ServerIR['fields'][FieldId]> = {} as ServerIR['fields'];
  for (const entry of graph.listFields()) {
    fields[entry.field.id] = entry;
  }

  return {
    contract: SERVER_IR_CONTRACT,
    id: graph.id,
    name: graph.name,
    version: graph.version,
    entities,
    fields,
    states,
    actions,
    constraints,
    transitionConstraints,
    ...(graph.principalEntityId ? { principalEntityId: graph.principalEntityId } : {}),
    observableStateIds,
  };
}

export function serializeServerIR(ir: ServerIR): string {
  return JSON.stringify(ir);
}

/** Whether a graph has any authoritative half at all. */
export function hasServerAuthority(graph: ApplicationGraph): boolean {
  const context = authorityContext(graph.listNodes(), graph.principalEntityId);
  return [...context.states.values()].some((state) => stateAuthority(state) === 'server');
}
