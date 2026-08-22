import type { Expression } from './expressions.js';
import { referencedIds } from './derive-edges.js';
import type { NodeId } from './ids.js';
import { actionGuards, isMutationOperation } from './nodes.js';
import type { ActionDef, ConstraintDef, Operation, StateDef, TransitionConstraintDef } from './nodes.js';
import { locationExpressions, locationRootStateId } from './location.js';
import type { AnyNode } from './types.js';

/**
 * Who may commit a canonical mutation.
 *
 * Authority and persistence are separate concerns. Authority says *who decides* a value;
 * persistence says *where a decided value survives*. A server-authoritative state may be
 * held only in memory, and a client-authoritative state may be persisted to local storage.
 */
export type Authority = 'client' | 'server';

export const AUTHORITIES: readonly Authority[] = ['client', 'server'];

/**
 * The scope an authorization expression resolves the caller through.
 *
 * It is bound to a record keyed by the field ids of the graph's principal entity, so an
 * authorization rule is written with the same `field`/`ref` vocabulary as everything else:
 *
 * ```ts
 * binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin'))
 * ```
 *
 * It is bound only where a server evaluates. A client never sees it.
 */
export const PRINCIPAL: NodeId = 'axiom_principal' as NodeId;

/**
 * The authority of a state. Absent metadata means `client`, so every 0.5.x graph keeps
 * executing exactly as it did.
 */
export function stateAuthority(state: StateDef): Authority {
  return state.authority === 'server' ? 'server' : 'client';
}

/** Whether the client may observe this state at all. */
export function isObservable(state: StateDef): boolean {
  return state.serverOnly !== true;
}

export interface AuthorityContext {
  states: Map<NodeId, StateDef>;
  actions: Map<NodeId, ActionDef>;
  constraints: ConstraintDef[];
  transitionConstraints: TransitionConstraintDef[];
  principalEntityId?: NodeId;
}

export function authorityContext(nodes: readonly AnyNode[], principalEntityId?: NodeId): AuthorityContext {
  const states = new Map<NodeId, StateDef>();
  const actions = new Map<NodeId, ActionDef>();
  const constraints: ConstraintDef[] = [];
  const transitionConstraints: TransitionConstraintDef[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case 'state':
        states.set(node.id, node);
        break;
      case 'action':
        actions.set(node.id, node);
        break;
      case 'constraint':
        constraints.push(node);
        break;
      case 'transition-constraint':
        transitionConstraints.push(node);
        break;
      default:
    }
  }
  return {
    states,
    actions,
    constraints,
    transitionConstraints,
    ...(principalEntityId ? { principalEntityId } : {}),
  };
}

/** Every state a set of expressions reads, following derived state transitively. */
export function statesReadBy(
  expressions: readonly Expression[],
  context: AuthorityContext,
): Set<NodeId> {
  const found = new Set<NodeId>();
  const seen = new Set<NodeId>();
  const walk = (expression: Expression): void => {
    for (const id of referencedIds(expression)) {
      const state = context.states.get(id);
      if (!state || seen.has(id)) {
        continue;
      }
      seen.add(id);
      found.add(id);
      if (state.derivation) {
        walk(state.derivation);
      }
    }
  };
  expressions.forEach(walk);
  return found;
}

/** Every expression an operation evaluates, including those inside its locations. */
function operationExpressions(operation: Operation): Expression[] {
  const found: Expression[] = [];
  if (isMutationOperation(operation)) {
    const target = operation.kind === 'remove' ? operation.target : operation.target;
    found.push(...locationExpressions(target));
    if (operation.kind !== 'remove') {
      found.push(operation.value);
    }
  }
  switch (operation.kind) {
    case 'for-each':
      found.push(operation.collection);
      for (const nested of operation.operations ?? []) {
        found.push(...operationExpressions(nested));
      }
      break;
    case 'invoke':
      found.push(...Object.values(operation.arguments ?? {}));
      break;
    case 'navigate':
      found.push(...Object.values(operation.parameters ?? {}));
      break;
    case 'native':
      found.push(...Object.values(operation.inputs ?? {}));
      if (operation.resultTarget) {
        found.push(...locationExpressions(operation.resultTarget));
      }
      break;
    default:
  }
  return found;
}

/** The states an action writes, following `for-each`, `invoke` and declared native effects. */
export function statesWrittenBy(
  action: ActionDef,
  context: AuthorityContext,
  visited: Set<NodeId> = new Set(),
): Set<NodeId> {
  const found = new Set<NodeId>();
  if (visited.has(action.id)) {
    return found;
  }
  visited.add(action.id);

  const walk = (operations: readonly Operation[]): void => {
    for (const operation of operations) {
      if (isMutationOperation(operation)) {
        found.add(locationRootStateId(operation.target));
        continue;
      }
      switch (operation.kind) {
        case 'for-each':
          walk(operation.operations ?? []);
          break;
        case 'invoke': {
          const target = context.actions.get(operation.actionId);
          if (target) {
            for (const id of statesWrittenBy(target, context, visited)) {
              found.add(id);
            }
          }
          break;
        }
        case 'native':
          if (operation.resultTarget) {
            found.add(locationRootStateId(operation.resultTarget));
          }
          for (const effect of operation.declaredEffects ?? []) {
            if (effect.kind === 'writes-state') {
              found.add(effect.stateId);
            }
          }
          break;
        default:
      }
    }
  };
  walk(action.operations ?? []);
  return found;
}

/** The states an action reads: its guards, its values, its selectors, its authorization. */
export function statesReadByAction(
  action: ActionDef,
  context: AuthorityContext,
  visited: Set<NodeId> = new Set(),
): Set<NodeId> {
  if (visited.has(action.id)) {
    return new Set();
  }
  visited.add(action.id);

  const expressions: Expression[] = [
    ...actionGuards(action).map((guard) => guard.condition),
    ...(action.postconditions ?? []),
    ...(action.authorization ? [action.authorization] : []),
  ];
  for (const operation of action.operations ?? []) {
    expressions.push(...operationExpressions(operation));
  }
  const found = statesReadBy(expressions, context);
  for (const operation of action.operations ?? []) {
    if (operation.kind === 'invoke') {
      const target = context.actions.get(operation.actionId);
      if (target) {
        for (const id of statesReadByAction(target, context, visited)) {
          found.add(id);
        }
      }
    }
  }
  return found;
}

/**
 * Where an action must execute.
 *
 * An action that writes any server-authoritative state is a **server action**: only the
 * authority that owns the state may commit it. This is derived, never declared, so it
 * cannot disagree with what the action actually does.
 */
export function actionAuthority(action: ActionDef, context: AuthorityContext): Authority {
  for (const stateId of statesWrittenBy(action, context)) {
    const state = context.states.get(stateId);
    if (state && stateAuthority(state) === 'server') {
      return 'server';
    }
  }
  return 'client';
}

/** Actions the client must send to the authority rather than execute itself. */
export function serverActionIds(context: AuthorityContext): NodeId[] {
  return [...context.actions.values()]
    .filter((action) => actionAuthority(action, context) === 'server')
    .map((action) => action.id);
}

/**
 * Every state a server action needs in order to execute: what it writes, what it reads,
 * and the derived state either of those depends on.
 */
export function serverStateClosure(context: AuthorityContext): Set<NodeId> {
  const needed = new Set<NodeId>();
  for (const state of context.states.values()) {
    if (stateAuthority(state) === 'server') {
      needed.add(state.id);
    }
  }
  for (const action of context.actions.values()) {
    if (actionAuthority(action, context) !== 'server') {
      continue;
    }
    for (const id of statesWrittenBy(action, context)) {
      needed.add(id);
    }
    for (const id of statesReadByAction(action, context)) {
      needed.add(id);
    }
  }
  // Constraints and transition rules that govern what the server commits are evaluated
  // there, so whatever they read has to be present too.
  const ruleExpressions = [
    ...context.constraints.map((constraint) => constraint.expression),
    ...context.transitionConstraints.map((constraint) => constraint.expression),
  ];
  for (const id of statesReadBy(ruleExpressions, context)) {
    needed.add(id);
  }

  // Derived state is only meaningful if what it derives from is present as well.
  let growing = true;
  while (growing) {
    growing = false;
    for (const id of [...needed]) {
      const state = context.states.get(id);
      if (!state?.derivation) {
        continue;
      }
      for (const dependency of statesReadBy([state.derivation], context)) {
        if (!needed.has(dependency)) {
          needed.add(dependency);
          growing = true;
        }
      }
    }
  }
  return needed;
}
