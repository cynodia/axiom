import { ApplicationGraph, randomHex } from '@axiom/core';
import type {
  AnyNode,
  ConstraintDef,
  EntityDef,
  FieldDef,
  GraphEdge,
  NodeType,
} from '@axiom/core';

export interface ChangeRecord {
  id: string;
  reason?: string;
  timestamp: string;
  addedNodes: string[];
  removedNodes: string[];
  modifiedNodes: string[];
}

export interface InvariantResult {
  constraintId: string;
  constraintName: string;
  passed: boolean;
  message?: string;
}

interface ActiveChange {
  snapshot: string;
  addedNodes: Set<string>;
  removedNodes: Set<string>;
  modifiedNodes: Set<string>;
}

export class AgentAPI {
  private activeChange?: ActiveChange;
  private history: ChangeRecord[] = [];

  constructor(private graph: ApplicationGraph) {}

  getNode(id: string): AnyNode | undefined {
    return this.graph.getNode(id);
  }

  queryNodes(opts: { type?: NodeType; namePattern?: RegExp }): AnyNode[] {
    return this.graph
      .listNodes()
      .filter((node) => (opts.type ? node.type === opts.type : true))
      .filter((node) => (opts.namePattern ? opts.namePattern.test(node.name) : true));
  }

  getDependencies(id: string): AnyNode[] {
    return this.graph
      .getOutgoingEdges(id)
      .map((edge) => this.graph.getNode(edge.to))
      .filter((node): node is AnyNode => Boolean(node));
  }

  getDependents(id: string): AnyNode[] {
    return this.graph
      .getIncomingEdges(id)
      .map((edge) => this.graph.getNode(edge.from))
      .filter((node): node is AnyNode => Boolean(node));
  }

  subgraph(id: string, depth: number): { nodes: AnyNode[]; edges: GraphEdge[] } {
    const visited = new Set<string>([id]);
    const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
    const edges = new Map<string, GraphEdge>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      if (current.depth >= depth) {
        continue;
      }
      for (const edge of this.graph.getEdges(current.id)) {
        edges.set(`${edge.from}:${edge.to}:${edge.kind}`, edge);
        const neighborId = edge.from === current.id ? edge.to : edge.from;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({ id: neighborId, depth: current.depth + 1 });
        }
      }
    }

    return {
      nodes: [...visited].map((nodeId) => this.graph.getNode(nodeId)).filter((node): node is AnyNode => Boolean(node)),
      edges: [...edges.values()],
    };
  }

  addField(entityId: string, field: FieldDef): void {
    const entity = this.graph.getNode<EntityDef>(entityId);
    if (!entity || entity.type !== 'entity') {
      throw new Error(`Entity ${entityId} does not exist`);
    }
    entity.fields.push(structuredClone(field));
    this.graph.updateNode(entity);
    this.trackModified(entityId);
  }

  addConstraint(constraint: Omit<ConstraintDef, 'id' | 'type' | 'createdAt'>): ConstraintDef {
    const id = this.graph.addNode({
      ...constraint,
      type: 'constraint',
    });
    if (constraint.affectedEntityId) {
      this.graph.addEdge(id, constraint.affectedEntityId, 'constrains');
    }
    this.trackAdded(id);
    const created = this.graph.getNode<ConstraintDef>(id);
    if (!created) {
      throw new Error('Failed to create constraint');
    }
    return created;
  }

  beginChange(): void {
    if (this.activeChange) {
      throw new Error('A change is already in progress');
    }
    this.activeChange = {
      snapshot: this.graph.serialize(),
      addedNodes: new Set(),
      removedNodes: new Set(),
      modifiedNodes: new Set(),
    };
  }

  commitChange(reason?: string): ChangeRecord {
    if (!this.activeChange) {
      throw new Error('No active change to commit');
    }
    const change: ChangeRecord = {
      id: `change-${randomHex(4)}`,
      reason,
      timestamp: new Date().toISOString(),
      addedNodes: [...this.activeChange.addedNodes],
      removedNodes: [...this.activeChange.removedNodes],
      modifiedNodes: [...this.activeChange.modifiedNodes],
    };
    this.history.push(change);
    this.activeChange = undefined;
    return change;
  }

  rollbackChange(): void {
    if (!this.activeChange) {
      throw new Error('No active change to rollback');
    }
    this.graph.restore(this.activeChange.snapshot);
    this.activeChange = undefined;
  }

  runInvariants(): InvariantResult[] {
    const entities = this.graph.getNodesByType<EntityDef>('entity');
    const entityByName = new Map(entities.map((entity) => [entity.name, entity]));
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const helpers = {
      entity: (name: string) => entityByName.get(name),
      field: (entityName: string, fieldName: string) =>
        entityByName.get(entityName)?.fields.find((field) => field.name === fieldName),
      fieldRequired: (entityName: string, fieldName: string) =>
        Boolean(entityByName.get(entityName)?.fields.find((field) => field.name === fieldName)?.required),
      fieldType: (entityName: string, fieldName: string, expected: string) =>
        entityByName.get(entityName)?.fields.find((field) => field.name === fieldName)?.fieldType === expected,
      fieldHasValidation: (entityName: string, fieldName: string, validation: string) =>
        Boolean(
          entityByName
            .get(entityName)
            ?.fields.find((field) => field.name === fieldName)
            ?.validations?.includes(validation),
        ),
      fieldEnum: (entityName: string, fieldName: string, allowed: string[]) => {
        const validations = entityByName.get(entityName)?.fields.find((field) => field.name === fieldName)?.validations ?? [];
        return validations.includes(`enum:${allowed.join('|')}`);
      },
    };

    return this.graph.getNodesByType<ConstraintDef>('constraint').map((constraint) => {
      const targetEntity = constraint.affectedEntityId ? entityById.get(constraint.affectedEntityId) : undefined;
      if (!constraint.expression) {
        return {
          constraintId: constraint.id,
          constraintName: constraint.name,
          passed: true,
          message: 'No expression supplied; treated as documentation-only invariant.',
        };
      }

      try {
        const evaluate = new Function(
          'helpers',
          'entity',
          'field',
          'fieldRequired',
          'fieldType',
          'fieldHasValidation',
          'fieldEnum',
          'targetEntity',
          `return Boolean(${constraint.expression});`,
        ) as (...args: unknown[]) => boolean;

        const passed = evaluate(
          helpers,
          helpers.entity,
          helpers.field,
          helpers.fieldRequired,
          helpers.fieldType,
          helpers.fieldHasValidation,
          helpers.fieldEnum,
          targetEntity,
        );
        return {
          constraintId: constraint.id,
          constraintName: constraint.name,
          passed,
          message: passed ? 'Invariant passed.' : constraint.description,
        };
      } catch (error) {
        return {
          constraintId: constraint.id,
          constraintName: constraint.name,
          passed: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  getChangeHistory(): ChangeRecord[] {
    return this.history.map((record) => ({ ...record }));
  }

  private trackAdded(id: string): void {
    this.activeChange?.addedNodes.add(id);
  }

  private trackModified(id: string): void {
    if (this.activeChange?.addedNodes.has(id)) {
      return;
    }
    this.activeChange?.modifiedNodes.add(id);
  }
}
