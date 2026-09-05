import type { Expression } from './expressions.js';
import { referencedIds } from './derive-edges.js';
import type { NodeId } from './ids.js';
import { actionGuards, actionOperations, isMutationOperation, operationChildren } from './nodes.js';
import type {
  ActionDef,
  ConstraintDef,
  ExpressionDef,
  Operation,
  StateDef,
  TransitionConstraintDef,
} from './nodes.js';
import { locationExpressions, locationProviderEntityId, locationRootStateId } from './location.js';
import type { AnyNode } from './types.js';
import type { QueryDef } from './query.js';
import { queryExpressions } from './query.js';
import type { ReadPolicyDef } from './read-policy.js';

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
 * The semantic object an authorization decision is made *about* — a provider record, a
 * workflow instance, or (for `action.invoke`, where there is no per-record target) a stable
 * descriptor of the operation's target. Bound only where an authority evaluates an
 * `AuthorizationPolicyDef` (spec15 §34, §99); like `PRINCIPAL` it is never client-visible.
 */
export const RESOURCE: NodeId = 'axiom_resource' as NodeId;

/**
 * The canonical semantic operation identity an authorization decision is made *for* — one of
 * `AUTHORIZATION_OPERATIONS` (`'action.invoke'`, `'query.read'`, …). `ref(OPERATION)`
 * resolves to that string directly. Bound only where an authority evaluates an
 * `AuthorizationPolicyDef` (spec15 §34, §98).
 */
export const OPERATION: NodeId = 'axiom_operation' as NodeId;

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
  /** Named expressions, so a rule that reuses one still declares what it reads. */
  expressions: Map<NodeId, ExpressionDef>;
  /** Registered queries — always authority-side, since they read authoritative data. */
  queries: Map<NodeId, QueryDef>;
  /** Row-level read policies, by the entity they govern. */
  readPolicies: Map<NodeId, ReadPolicyDef>;
  principalEntityId?: NodeId;
}

export function authorityContext(nodes: readonly AnyNode[], principalEntityId?: NodeId): AuthorityContext {
  const states = new Map<NodeId, StateDef>();
  const actions = new Map<NodeId, ActionDef>();
  const constraints: ConstraintDef[] = [];
  const transitionConstraints: TransitionConstraintDef[] = [];
  const expressions = new Map<NodeId, ExpressionDef>();
  const queries = new Map<NodeId, QueryDef>();
  const readPolicies = new Map<NodeId, ReadPolicyDef>();
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
      case 'expression':
        expressions.set(node.id, node);
        break;
      case 'query':
        queries.set(node.id, node);
        break;
      case 'read-policy':
        readPolicies.set(node.entityId, node);
        break;
      default:
    }
  }
  return {
    states,
    actions,
    constraints,
    transitionConstraints,
    expressions,
    queries,
    readPolicies,
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
    // Following named expressions matters here more than anywhere: a rule that reads
    // server state through a reused calculation reads server state.
    for (const id of referencedIds(expression, (target) => context.expressions.get(target))) {
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
      for (const nested of operationChildren(operation)) {
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
    case 'integration-query':
      found.push(...Object.values(operation.arguments ?? {}));
      break;
    case 'integration-effect':
      found.push(...Object.values(operation.arguments ?? {}));
      if (operation.idempotencyKey) {
        found.push(operation.idempotencyKey);
      }
      break;
    case 'blob-metadata':
    case 'blob-commit':
    case 'blob-delete':
      found.push(operation.blobKey);
      break;
    default:
  }
  return found;
}

/** Whether an action calls out to an integration anywhere in its top-level operations. */
export function actionUsesIntegration(action: ActionDef): boolean {
  return actionOperations(action).some(
    (operation) => operation.kind === 'integration-query' || operation.kind === 'integration-effect',
  );
}

/** Whether an action reaches an object store anywhere in its top-level operations. */
export function actionUsesStorage(action: ActionDef): boolean {
  return actionOperations(action).some(
    (operation) =>
      operation.kind === 'blob-metadata' ||
      operation.kind === 'blob-commit' ||
      operation.kind === 'blob-delete',
  );
}

/**
 * Whether an action runs a registered query (spec 0.10 §40). Only the authority holds a
 * data provider, so an action that reads authoritative data through a query executes there.
 */
export function actionUsesQuery(action: ActionDef): boolean {
  return actionOperations(action).some((operation) => operation.kind === 'query');
}

/**
 * Whether an action writes a `provider-record` location anywhere in its operations
 * (spec 0.10 §37-39). Mutating a canonical provider-backed row is authoritative work — the
 * client holds no provider — so such an action executes on the server.
 */
export function actionWritesProviderRecord(action: ActionDef): boolean {
  const targets = (operations: readonly Operation[]): boolean =>
    operations.some((operation) => {
      if (operation.kind === 'set' || operation.kind === 'insert' || operation.kind === 'remove') {
        return locationProviderEntityId(operation.target) !== undefined;
      }
      if (operation.kind === 'for-each') {
        return targets(operationChildren(operation));
      }
      return false;
    });
  return targets(actionOperations(action));
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
          walk(operationChildren(operation));
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
        case 'integration-query':
        case 'integration-effect':
        case 'blob-metadata':
        case 'blob-commit':
        case 'blob-delete':
          // None of these writes Axiom state directly: a query's (or a metadata lookup's)
          // result is a transaction-local scope binding, and an effect's outcome reaches
          // state only through a follow-up action invoked from its success/failure event.
          break;
        default:
      }
    }
  };
  walk(actionOperations(action));
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
  for (const operation of actionOperations(action)) {
    expressions.push(...operationExpressions(operation));
  }
  const found = statesReadBy(expressions, context);
  for (const operation of actionOperations(action)) {
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
  // Integrations and object stores are both server-only by default (spec §65: secrets,
  // trust, CORS, auditability, deterministic authority), so an action that reaches either
  // is unconditionally server — independent of what it writes.
  if (
    actionUsesIntegration(action) ||
    actionUsesStorage(action) ||
    actionUsesQuery(action) ||
    actionWritesProviderRecord(action)
  ) {
    return 'server';
  }
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
    // A query's filter/sort/projection and a read policy's predicate are evaluated on the
    // authority too, so any authoritative state they consult has to be present.
    ...[...context.queries.values()].flatMap((query) => queryExpressions(query)),
    ...[...context.readPolicies.values()].map((policy) => policy.predicate),
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
