import { PRINCIPAL, actionAuthority, authorityContext, stateAuthority, statesReadByAction } from './authority.js';
import type { AuthorityContext } from './authority.js';
import { referencedIds } from './derive-edges.js';
import { VALIDATION_CODES } from './diagnostics.js';
import type { ValidationIssue } from './diagnostics.js';
import type { NodeId } from './ids.js';
import { locationRootStateId } from './location.js';
import { allowedInvocationSources } from './nodes.js';
import { ALL_TRIGGER_KINDS_SUPPORTED } from './trigger-capabilities.js';
import type { TriggerRuntimeCapabilities } from './trigger-capabilities.js';
import type { AnyNode } from './types.js';
import { isUINode } from './ui.js';

/**
 * Validation of the authority boundary.
 *
 * These are errors, not advice. A graph in which a client could commit server-authoritative
 * state, or in which an authority would have to read state it does not own, cannot execute
 * correctly — and the point of the boundary is that its correctness does not depend on an
 * author remembering where to bind an input.
 */
export function validateAuthority(
  nodes: readonly AnyNode[],
  principalEntityId: NodeId | undefined,
  triggerRuntime: TriggerRuntimeCapabilities = ALL_TRIGGER_KINDS_SUPPORTED,
): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const context = authorityContext(nodes, principalEntityId);
  const entities = new Set(nodes.filter((node) => node.kind === 'entity').map((node) => node.id));

  const hasServerState = [...context.states.values()].some(
    (state) => stateAuthority(state) === 'server',
  );
  const authorizedActions = [...context.actions.values()].filter((action) => action.authorization);

  if (principalEntityId !== undefined && !entities.has(principalEntityId)) {
    errors.push({
      code: VALIDATION_CODES.invalidPrincipalEntity,
      message: `The principal entity ${principalEntityId} is not an entity`,
      details: { principalEntityId },
    });
  }
  for (const action of authorizedActions) {
    if (principalEntityId === undefined) {
      errors.push({
        code: VALIDATION_CODES.authorizationWithoutPrincipal,
        message: `${action.name ?? action.id} declares authorization, but the graph declares no principal entity to read the caller through`,
        nodeId: action.id,
      });
    }
  }

  // A client write can never reach server-authoritative state. An input binding is the one
  // path that would otherwise slip through, because it looks like presentation.
  for (const node of nodes) {
    if (!isUINode(node) || node.kind !== 'input') {
      continue;
    }
    const rootStateId = locationRootStateId(node.binding.location);
    const state = context.states.get(rootStateId);
    if (state && stateAuthority(state) === 'server') {
      errors.push({
        code: VALIDATION_CODES.clientWriteToServerState,
        message: `Input ${node.name ?? node.id} writes ${rootStateId}, which is server-authoritative; bind it to a draft and commit through an action instead`,
        nodeId: node.id,
        details: { stateId: rootStateId },
      });
    }
    if (state?.serverOnly) {
      errors.push({
        code: VALIDATION_CODES.serverOnlyStateObserved,
        message: `Input ${node.name ?? node.id} reads ${rootStateId}, which the client may not observe`,
        nodeId: node.id,
        details: { stateId: rootStateId },
      });
    }
  }

  // A server action cannot read state the authority does not own. A draft on the client is
  // exactly the case: it must arrive as an argument, not be read across the boundary.
  for (const action of context.actions.values()) {
    if (actionAuthority(action, context) !== 'server') {
      continue;
    }
    for (const stateId of statesReadByAction(action, context)) {
      const state = context.states.get(stateId);
      if (state && stateAuthority(state) === 'client') {
        errors.push({
          code: VALIDATION_CODES.serverDependsOnClientState,
          message: `${action.name ?? action.id} executes on the authority but reads ${stateId}, which is client-authoritative; pass the value as an action parameter instead`,
          nodeId: action.id,
          details: { stateId, authority: 'server' },
        });
      }
    }
  }

  // Server-authoritative state may not derive from client state either: the authority
  // would have nothing to compute it from.
  for (const state of context.states.values()) {
    if (stateAuthority(state) !== 'server' || !state.derivation) {
      continue;
    }
    for (const id of referencedIds(state.derivation)) {
      const source = context.states.get(id);
      if (source && stateAuthority(source) === 'client') {
        errors.push({
          code: VALIDATION_CODES.serverDependsOnClientState,
          message: `${state.name ?? state.id} is server-authoritative but derives from ${id}, which is client-authoritative`,
          nodeId: state.id,
          details: { stateId: id },
        });
      }
    }
  }

  // The client may not observe server-only state, however indirectly.
  for (const state of context.states.values()) {
    if (!state.derivation || stateAuthority(state) === 'server') {
      continue;
    }
    for (const id of referencedIds(state.derivation)) {
      if (context.states.get(id)?.serverOnly) {
        errors.push({
          code: VALIDATION_CODES.serverOnlyStateObserved,
          message: `${state.name ?? state.id} is observable by the client but derives from ${id}, which is server-only`,
          nodeId: state.id,
          details: { stateId: id },
        });
      }
    }
  }
  for (const node of nodes) {
    if (!isUINode(node)) {
      continue;
    }
    const expressions = [
      ...(node.visibleWhen ? [node.visibleWhen] : []),
      ...(node.kind === 'text' && typeof node.value !== 'string' ? [node.value] : []),
      ...(node.kind === 'repeat' ? [node.source] : []),
      ...(node.kind === 'field-display' ? [node.source] : []),
      ...(node.kind === 'form' ? [node.target] : []),
      ...(node.kind === 'conditional' ? [node.condition] : []),
    ];
    for (const expression of expressions) {
      for (const id of referencedIds(expression)) {
        if (context.states.get(id)?.serverOnly) {
          errors.push({
            code: VALIDATION_CODES.serverOnlyStateObserved,
            message: `${node.name ?? node.id} reads ${id}, which the client may not observe`,
            nodeId: node.id,
            details: { stateId: id },
          });
        }
      }
    }
  }

  // An `event` trigger only ever fires where the server dispatches an event, so its
  // target action must be server-authority. A `route-enter`/`route-leave` trigger only
  // ever fires from the client router, so its target must be client-authority.
  for (const node of nodes) {
    if (node.kind !== 'trigger') {
      continue;
    }
    const target = context.actions.get(node.actionId);
    if (!target) {
      continue;
    }
    const authority = actionAuthority(target, context);
    if (node.when.kind === 'event' && authority !== 'server') {
      errors.push({
        code: VALIDATION_CODES.triggerWrongAuthority,
        message: `Trigger ${node.name ?? node.id} fires on an event, which only the server dispatches, but ${target.name ?? target.id} is client-authority`,
        nodeId: node.id,
        details: { actionId: target.id, authority },
      });
    }
    if (node.when.kind === 'lifecycle' && (node.when.event === 'route-enter' || node.when.event === 'route-leave') && authority !== 'client') {
      errors.push({
        code: VALIDATION_CODES.triggerWrongAuthority,
        message: `Trigger ${node.name ?? node.id} fires on ${node.when.event}, which only the client router dispatches, but ${target.name ?? target.id} is server-authority`,
        nodeId: node.id,
        details: { actionId: target.id, authority },
      });
    }

    // A trigger of any kind always invokes with `source: 'system'` (spec 8.1 §3-9). An
    // action that has opted out of system invocation could never be reached by it.
    if (!allowedInvocationSources(target).includes('system')) {
      errors.push({
        code: VALIDATION_CODES.triggerTargetSourceMismatch,
        message: `Trigger ${node.name ?? node.id} targets ${target.name ?? target.id}, which does not accept 'system'-sourced invocations, so this trigger could never invoke it`,
        nodeId: node.id,
        details: { actionId: target.id },
      });
    }

    // A client-authority trigger executes in the trigger runtime the graph is compiled
    // for. A kind that runtime does not implement would validate, compile, and then
    // silently never fire (spec 8.1 §31-36) — exactly what a renderer capability gate
    // already prevents for UI node kinds.
    if (authority === 'client' && !triggerRuntime.supportedTriggerKinds.includes(node.when.kind)) {
      errors.push({
        code: VALIDATION_CODES.clientTriggerUnsupported,
        message:
          `Trigger ${node.name ?? node.id} is a client-authority '${node.when.kind}' trigger, which the ` +
          `${triggerRuntime.target} trigger runtime does not execute. Move ${target.name ?? target.id} to ` +
          `server-authoritative execution (so the trigger becomes server-authority), or compile for a ` +
          `trigger runtime that publishes '${node.when.kind}' in its supportedTriggerKinds.`,
        nodeId: node.id,
        details: { actionId: target.id, kind: node.when.kind, target: triggerRuntime.target },
      });
    }
  }

  // The principal exists only where an authority evaluates. Reading it anywhere a client
  // evaluates would be a rule the client could simply not apply.
  reportPrincipalOnClient(nodes, context, errors);

  if (hasServerState && authorizedActions.length === 0) {
    warnings.push({
      code: VALIDATION_CODES.authorizationWithoutPrincipal,
      message:
        'This application has server-authoritative state but no action declares authorization, so every caller may invoke every action',
      details: { serverActions: [...context.actions.values()].filter((a) => actionAuthority(a, context) === 'server').length },
    });
  }

  return { errors, warnings };
}

/** `PRINCIPAL` is bound only by an authority; anywhere else it cannot resolve. */
function reportPrincipalOnClient(
  nodes: readonly AnyNode[],
  context: AuthorityContext,
  errors: ValidationIssue[],
): void {
  const report = (nodeId: NodeId, where: string): void => {
    errors.push({
      code: VALIDATION_CODES.principalReferenceOnClient,
      message: `${where} reads the caller through PRINCIPAL, which only an authority binds`,
      nodeId,
      details: { scope: PRINCIPAL },
    });
  };

  for (const state of context.states.values()) {
    if (state.derivation && referencedIds(state.derivation).includes(PRINCIPAL)) {
      report(state.id, `Derived state ${state.name ?? state.id}`);
    }
  }
  for (const node of nodes) {
    if (!isUINode(node)) {
      continue;
    }
    const expressions = [
      ...(node.visibleWhen ? [node.visibleWhen] : []),
      ...(node.kind === 'text' && typeof node.value !== 'string' ? [node.value] : []),
      ...(node.kind === 'repeat' ? [node.source] : []),
      ...(node.kind === 'conditional' ? [node.condition] : []),
    ];
    if (expressions.some((expression) => referencedIds(expression).includes(PRINCIPAL))) {
      report(node.id, `${node.kind} ${node.name ?? node.id}`);
    }
  }
  // An action that only the client executes cannot check an authorization rule either.
  for (const action of context.actions.values()) {
    if (!action.authorization || actionAuthority(action, context) === 'server') {
      continue;
    }
    errors.push({
      code: VALIDATION_CODES.principalReferenceOnClient,
      message: `${action.name ?? action.id} declares authorization but writes no server-authoritative state, so nothing authoritative would ever evaluate it`,
      nodeId: action.id,
      details: { scope: PRINCIPAL },
    });
  }
}
