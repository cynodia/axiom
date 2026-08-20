import { validateGraph } from '@axiom/core';
import type {
  ActionDef,
  ApplicationGraph,
  ApplicationIR,
  CompiledRoute,
  ConstraintDef,
  EntityDef,
  FieldId,
  NodeId,
  RouteDef,
  RouteSegment,
  StateDef,
  UINode,
  ValidationIssue,
  ValidationResult,
} from '@axiom/core';
import { isUINode } from '@axiom/core';

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
      case 'action':
        actions[node.id] = node;
        break;
      case 'constraint':
        constraints.push(node);
        break;
      case 'route':
        routes.push(compileRoute(node));
        break;
      default:
    }
  }

  routes.sort((left, right) => left.specificity - right.specificity || left.path.localeCompare(right.path));

  const fields: ApplicationIR['fields'] = {} as ApplicationIR['fields'];
  for (const location of graph.listFields()) {
    fields[location.field.id as FieldId] = location;
  }

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
    routes,
    edges: graph.listEdges(),
  };
}

export function serializeIR(ir: ApplicationIR): string {
  return JSON.stringify(ir);
}
