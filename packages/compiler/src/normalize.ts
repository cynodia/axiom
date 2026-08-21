import {
  actionGuards,
  inferLocationType,
  locationFieldIds,
  locationRootStateId,
  resolvePresentationMap,
  semanticContextFromGraph,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ApplicationGraph,
  ApplicationIR,
  CompiledRoute,
  ConstraintDef,
  EntityDef,
  FieldId,
  NodeId,
  ResolvedPresentation,
  RouteDef,
  RouteSegment,
  StateDef,
  TransitionConstraintDef,
  TypeRef,
  UINode,
  ValidationIssue,
  ValidationResult,
} from '@cynodia/axiom-core';
import { isUINode } from '@cynodia/axiom-core';

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
    const result = validateGraph(graph);
    if (!result.valid) {
      throw new GraphValidationError(result);
    }
  }

  const nodes: Record<NodeId, ApplicationIR['nodes'][NodeId]> = {};
  const actions: Record<NodeId, ActionDef> = {};
  const uiNodes: Record<NodeId, UINode> = {};
  const entities: EntityDef[] = [];
  const states: StateDef[] = [];
  const constraints: ConstraintDef[] = [];
  const transitionConstraints: TransitionConstraintDef[] = [];
  const routes: CompiledRoute[] = [];

  for (const node of graph.listNodes()) {
    nodes[node.id] = node;
    if (isUINode(node)) {
      uiNodes[node.id] = node;
      continue;
    }
    switch (node.kind) {
      case 'entity':
        entities.push(node);
        break;
      case 'state':
        states.push(node);
        break;
      case 'action': {
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
        constraints.push(node);
        break;
      case 'transition-constraint':
        transitionConstraints.push(node);
        break;
      case 'route':
        routes.push(compileRoute(node));
        break;
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
    routes,
    edges: graph.semanticEdges(),
    locationTypes,
    locationRoots,
    locationRequired,
    theme,
    presentation,
  };
}

export function serializeIR(ir: ApplicationIR): string {
  return JSON.stringify(ir);
}
