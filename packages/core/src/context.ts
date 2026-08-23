import type { ApplicationGraph } from './graph.js';
import type { FieldId, NodeId } from './ids.js';
import type { EntityDef, ExpressionDef, StateDef } from './nodes.js';
import type { SemanticContext } from './infer.js';
import type { TypeRef } from './type-ref.js';

/** Adapts an authoring graph to the lookups static analysis needs. */
export function semanticContextFromGraph(graph: ApplicationGraph): SemanticContext {
  const parameterTypes = new Map<NodeId, TypeRef | undefined>();
  const parameterNames = new Map<NodeId, string | undefined>();
  for (const action of graph.getNodesByKind('action')) {
    for (const parameter of action.parameters ?? []) {
      parameterTypes.set(parameter.id, parameter.valueType);
      parameterNames.set(parameter.id, parameter.name);
    }
  }
  for (const route of graph.getNodesByKind('route')) {
    for (const parameter of route.parameters ?? []) {
      parameterTypes.set(parameter.id, parameter.valueType);
      parameterNames.set(parameter.id, parameter.name);
    }
  }
  for (const definition of graph.getNodesByKind('expression')) {
    for (const parameter of definition.parameters ?? []) {
      parameterTypes.set(parameter.id, parameter.valueType);
      parameterNames.set(parameter.id, parameter.name);
    }
  }

  return {
    getState: (id: NodeId): StateDef | undefined => {
      const node = graph.getNode(id);
      return node?.kind === 'state' ? node : undefined;
    },
    getEntity: (id: NodeId): EntityDef | undefined => {
      const node = graph.getNode(id);
      return node?.kind === 'entity' ? node : undefined;
    },
    getField: (id: FieldId) => graph.getField(id),
    getExpressionDef: (id: NodeId): ExpressionDef | undefined => {
      const node = graph.getNode(id);
      return node?.kind === 'expression' ? node : undefined;
    },
    getParameterType: (id: NodeId) => parameterTypes.get(id),
    getName: (id: NodeId) => graph.getNode(id)?.name ?? parameterNames.get(id),
  };
}
