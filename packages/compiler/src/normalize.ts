import {
  actionAuthority,
  actionGuards,
  authorityContext,
  inferExpressionType,
  inferLocationType,
  itemTypeOf,
  locationFieldIds,
  locationRootStateId,
  referencedIds,
  resolvePresentationMap,
  semanticContextFromGraph,
  stateAuthority,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ApplicationGraph,
  Authority,
  ApplicationIR,
  CompiledRoute,
  ConstraintDef,
  EntityDef,
  Expression,
  ExpressionDef,
  FieldId,
  NodeId,
  ResolvedPresentation,
  RouteDef,
  RouteSegment,
  StateDef,
  TransitionConstraintDef,
  TriggerDef,
  TypeRef,
  UINode,
  ValidationIssue,
  ValidationResult,
} from '@cynodia/axiom-core';
import { isUINode, stripAuthoringMetadata } from '@cynodia/axiom-core';
import type { RendererCapabilities, TriggerRuntimeCapabilities } from '@cynodia/axiom-core';
import { BROWSER_RENDERER_CAPABILITIES, BROWSER_TRIGGER_CAPABILITIES } from '@cynodia/axiom-runtime';

export class GraphValidationError extends Error {
  readonly problems: ValidationIssue[];

  constructor(result: ValidationResult) {
    super(
      `Application graph is invalid:\n${result.errors
        .map((problem) => `  [${problem.code}] ${problem.message}`)
        .join('\n')}`,
    );
    this.name = 'GraphValidationError';
    this.problems = result.errors;
  }
}

export interface CompileOptions {
  /** Compilation refuses invalid graphs by default; disable only for diagnostics. */
  validate?: boolean;
  /**
   * Keep authoring metadata in the compiled artifact.
   *
   * Off by default, and that default is the point: metadata describing how a node was
   * *authored* has no business in a browser payload or across a trust boundary. A development
   * tool, a pattern inspector or an agent debugging an expansion asks for it explicitly.
   */
  includeAuthoringMetadata?: boolean;
  /**
   * The renderer the IR is being compiled for. Defaults to the browser renderer, because
   * that is what `compileToIR` produces a page for — so a UI node kind no browser can draw is
   * rejected at compile time rather than discovered on screen.
   */
  renderer?: RendererCapabilities;
  /**
   * The trigger runtime the IR is being compiled for. Defaults to the browser's real (empty)
   * capability set, because the browser runtime implements no trigger kind — so a
   * client-authority trigger is rejected at compile time rather than compiled inert.
   */
  triggerRuntime?: TriggerRuntimeCapabilities;
}

function compileRoute(route: RouteDef): CompiledRoute {
  const parameters = route.parameters ?? [];
  const segments: RouteSegment[] = route.path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (!segment.startsWith(':')) {
        return { kind: 'static', value: segment };
      }
      const name = segment.slice(1);
      const parameter = parameters.find((candidate) => candidate.name === name);
      return { kind: 'parameter', value: name, ...(parameter ? { parameterId: parameter.id } : {}) };
    });

  return {
    id: route.id,
    path: route.path,
    viewId: route.viewId,
    segments,
    parameters,
    specificity: segments.filter((segment) => segment.kind === 'parameter').length,
  };
}

/**
 * Validates a graph and normalizes it into the runtime-ready IR: references resolved,
 * lookups indexed, routes pre-compiled and ordered most-specific-first.
 */
export function compileToIR(graph: ApplicationGraph, options: CompileOptions = {}): ApplicationIR {
  if (options.validate !== false) {
    const result = validateGraph(graph, {
      renderer: options.renderer ?? (BROWSER_RENDERER_CAPABILITIES as RendererCapabilities),
      triggerRuntime:
        options.triggerRuntime ?? (BROWSER_TRIGGER_CAPABILITIES as TriggerRuntimeCapabilities),
    });
    if (!result.valid) {
      throw new GraphValidationError(result);
    }
  }

  // The authority boundary decides what may cross into the client at all.
  const authorityOf = authorityContext(graph.listNodes(), graph.principalEntityId);
  const hiddenStateIds = new Set<NodeId>();
  for (const state of authorityOf.states.values()) {
    if (state.serverOnly) {
      hiddenStateIds.add(state.id);
    }
  }
  const remoteActionIds: NodeId[] = [];
  const authority: Record<NodeId, Authority> = {};

  /** Nothing that reads state the client may not observe may reach the client. */
  const readsHiddenState = (expressions: readonly Expression[]): boolean =>
    expressions.some((expression) =>
      // Following named expressions is not optional here: a calculation that reads
      // server-only state must not reach the client because a consumer named it instead of
      // inlining it.
      referencedIds(expression, (id) => authorityOf.expressions.get(id)).some((id) =>
        hiddenStateIds.has(id),
      ),
    );

  const nodes: Record<NodeId, ApplicationIR['nodes'][NodeId]> = {};
  const actions: Record<NodeId, ActionDef> = {};
  const uiNodes: Record<NodeId, UINode> = {};
  const entities: EntityDef[] = [];
  const states: StateDef[] = [];
  const constraints: ConstraintDef[] = [];
  const transitionConstraints: TransitionConstraintDef[] = [];
  const expressionDefs: Record<NodeId, ExpressionDef> = {};
  const routes: CompiledRoute[] = [];
  const triggers: TriggerDef[] = [];

  // Authoring metadata is stripped on the way in, so no later stage has to remember to.
  const forIR = <T extends { metadata?: Record<string, unknown> }>(node: T): T =>
    options.includeAuthoringMetadata ? node : stripAuthoringMetadata(node);

  for (const raw of graph.listNodes()) {
    const node = forIR(raw);
    nodes[node.id] = node;
    if (isUINode(node)) {
      uiNodes[node.id] = node;
      continue;
    }
    switch (node.kind) {
      case 'entity':
        entities.push(node);
        break;
      case 'state': {
        if (hiddenStateIds.has(node.id)) {
          // Server-only state is not merely unwritable here; it is absent.
          delete nodes[node.id];
          break;
        }
        authority[node.id] = stateAuthority(node);
        states.push(
          stateAuthority(node) === 'server'
            ? // The authority owns the value. A seed shipped to the client would be a
              // second, unauthoritative source of truth.
              { ...node, initialValue: undefined }
            : node,
        );
        break;
      }
      case 'action': {
        if (actionAuthority(node, authorityOf) === 'server') {
          // A remote action reaches the client as its name, its parameters and nothing
          // else: no operations to replay, no guards to fake, no authorization to satisfy.
          remoteActionIds.push(node.id);
          const remote: ActionDef = {
            id: node.id,
            kind: 'action',
            ...(node.name ? { name: node.name } : {}),
            ...(node.parameters ? { parameters: node.parameters } : {}),
            ...(node.destructive !== undefined ? { destructive: node.destructive } : {}),
            ...(node.requiresConfirmation !== undefined
              ? { requiresConfirmation: node.requiresConfirmation }
              : {}),
            ...(node.confirmationMessage ? { confirmationMessage: node.confirmationMessage } : {}),
            ...(node.confirmation ? { confirmation: node.confirmation } : {}),
            ...(node.metadata ? { metadata: node.metadata } : {}),
            operations: [],
          };
          actions[node.id] = remote;
          nodes[node.id] = remote;
          break;
        }
        // Guards are authoring sugar: the IR carries conditions and failures aligned.
        const guards = actionGuards(node);
        actions[node.id] = {
          ...node,
          preconditions: guards.map((guard) => guard.condition),
          failureModes: guards.map((guard) => guard.failureMode ?? { code: 'precondition-failed' }),
        };
        nodes[node.id] = actions[node.id];
        break;
      }
      case 'constraint':
        if (readsHiddenState([node.expression])) {
          delete nodes[node.id];
          break;
        }
        constraints.push(node);
        break;
      case 'transition-constraint':
        if (readsHiddenState([node.expression])) {
          delete nodes[node.id];
          break;
        }
        transitionConstraints.push(node);
        break;
      case 'route':
        routes.push(compileRoute(node));
        break;
      case 'expression':
        if (readsHiddenState([node.expression])) {
          delete nodes[node.id];
          break;
        }
        expressionDefs[node.id] = node;
        break;
      case 'integration':
      case 'integration-operation':
      case 'event':
      case 'subscription':
      case 'storage':
      case 'query':
      case 'relationship':
      case 'read-policy':
        // Server-only vocabulary: no client concern ever needs to know an integration, its
        // operations, the events it can raise (spec §80), the live sources it subscribes to,
        // the object stores it reaches, or — new in 0.10 — the registered queries,
        // entity relationships and row-level read policies the authority executes. A client
        // invokes a query by id and receives a typed page; it never sees a clause or a
        // policy predicate (spec 0.10 §6, §46-49).
        delete nodes[node.id];
        break;
      case 'trigger': {
        // Only client-authority, non-event triggers belong in the client IR. An `event`
        // trigger only ever fires from a server-dispatched event, and a trigger whose
        // target action is server-authority executes there, not here.
        const target = authorityOf.actions.get(node.actionId);
        const triggerAuthority = target ? actionAuthority(target, authorityOf) : 'client';
        const triggerExpressions = [
          ...Object.values(node.arguments ?? {}),
          ...(node.enabledWhen ? [node.enabledWhen] : []),
        ];
        if (node.when.kind === 'event' || triggerAuthority === 'server' || readsHiddenState(triggerExpressions)) {
          delete nodes[node.id];
          break;
        }
        triggers.push(node);
        break;
      }
      default:
    }
  }

  routes.sort((left, right) => left.specificity - right.specificity || left.path.localeCompare(right.path));

  const fields: ApplicationIR['fields'] = {} as ApplicationIR['fields'];
  for (const entry of graph.listFields()) {
    fields[entry.field.id as FieldId] = entry;
  }

  // Resolve what each input writes to, so the runtime carries no type inference itself.
  const semantics = semanticContextFromGraph(graph);
  const locationTypes: Record<NodeId, TypeRef> = {};
  const locationRoots: Record<NodeId, NodeId> = {};
  const locationRequired: Record<NodeId, boolean> = {};
  for (const node of Object.values(uiNodes)) {
    if (node.kind !== 'input') {
      continue;
    }
    const resolved = inferLocationType(node.binding.location, semantics);
    if (resolved) {
      locationTypes[node.id] = resolved;
    }
    locationRoots[node.id] = locationRootStateId(node.binding.location);
    // Whether a value is required is already in the model; a renderer should not re-derive it.
    const addressed = locationFieldIds(node.binding.location)[0];
    locationRequired[node.id] = addressed
      ? graph.getField(addressed)?.field.required === true
      : resolved !== undefined && resolved.kind !== 'optional';
  }

  // Which field distinguishes the members of each repeat, so the renderer can give every
  // rendered instance a stable identity without inferring anything itself.
  const repeatIdentityFields: Record<NodeId, FieldId> = {};
  for (const node of Object.values(uiNodes)) {
    if (node.kind !== 'repeat') {
      continue;
    }
    const sourceType = inferExpressionType(node.source, semantics);
    const item = itemTypeOf(sourceType);
    const resolved = item?.kind === 'optional' ? item.valueType : item;
    if (resolved?.kind !== 'entity') {
      continue;
    }
    const identity = graph.getNode<EntityDef>(resolved.entityId)?.identityFieldId;
    if (identity) {
      repeatIdentityFields[node.id] = identity;
    }
  }

  // Presentation is normalized here, once: renderer defaults, theme, inheritance,
  // semantic inference, node declarations and responsive overrides are all decided before
  // a renderer sees them. What lands in the IR is still semantic — roles and tokens, not
  // CSS — so a second renderer stays possible.
  const theme = graph.theme;
  const presentation: Record<NodeId, ResolvedPresentation> = resolvePresentationMap(
    graph.listNodes(),
    theme,
  );

  return {
    id: graph.id,
    name: graph.name,
    version: graph.version,
    nodes,
    fields,
    entities,
    states,
    actions,
    uiNodes,
    constraints,
    transitionConstraints,
    expressionDefs,
    routes,
    // An edge naming a node the client does not receive would tell it that node exists.
    edges: graph.semanticEdges().filter((edge) => nodes[edge.from] && nodes[edge.to]),
    locationTypes,
    locationRoots,
    locationRequired,
    repeatIdentityFields,
    authority,
    remoteActionIds,
    theme,
    presentation,
    triggers,
  };
}

/**
 * Validates a graph against the same capabilities `compileToIR` compiles for by default —
 * the real browser renderer and the real (empty) browser trigger runtime — without
 * compiling it.
 *
 * `validateGraph(graph)` alone is deliberately target-neutral (spec 8.2 §2-4, §41 of spec5):
 * a graph is never rejected for a renderer or trigger runtime nobody named, the same way
 * `RendererCapabilities` was already optional before triggers existed. That means a bare
 * `validateGraph(graph).valid === true` does not by itself say the graph is executable by a
 * browser — a UI node kind no renderer draws, or a client-authority trigger kind the browser
 * trigger runtime does not execute (`CLIENT_TRIGGER_UNSUPPORTED`), both validate silently
 * under the no-options call. A consumer that wants a validate-only answer reflecting actual
 * browser executability — without compiling the whole IR just to catch a thrown
 * `GraphValidationError` — calls this instead; `compileToIR(graph)`'s own validation step is
 * exactly this call, so the two never disagree.
 */
export function validateForBrowser(
  graph: ApplicationGraph,
  options: Pick<CompileOptions, 'renderer' | 'triggerRuntime'> = {},
): ValidationResult {
  return validateGraph(graph, {
    renderer: options.renderer ?? (BROWSER_RENDERER_CAPABILITIES as RendererCapabilities),
    triggerRuntime: options.triggerRuntime ?? (BROWSER_TRIGGER_CAPABILITIES as TriggerRuntimeCapabilities),
  });
}

export function serializeIR(ir: ApplicationIR): string {
  return JSON.stringify(ir);
}
