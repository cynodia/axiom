import { ApplicationGraph, semanticDiff, synchronizeEdges, validateGraph } from '@cynodia/axiom-core';
import type { NodeId, SemanticDiff, ValidationResult } from '@cynodia/axiom-core';
import type { GraphChange } from './changes.js';

/**
 * Portable, structured graph edits and candidate-graph validation (spec16 §79-87). `Transaction`
 * already stages typed builder calls against a private clone; this module is the **data**
 * counterpart — a `GraphChange[]` (spec16 §79, already the log `Transaction` records) is
 * itself the closed edit vocabulary: add/remove/update a node, add/remove a field, add/remove
 * an edge, change the theme. It is serializable, inspectable and deterministic (spec16 §80),
 * and applying it never touches the graph an agent is proposing to change until the caller
 * accepts a validated candidate (spec16 §81, §145).
 */

export interface EditPrecondition {
  nodeId: NodeId;
  /** `'exists'` / `'absent'`, or an equality check on one field of the *current* node. */
  expect: 'exists' | 'absent' | { field: string; equals: unknown };
}

export interface GraphEditRequest {
  changes: readonly GraphChange[];
  /** Checked against the base graph before any change is applied (spec16 §85). */
  preconditions?: readonly EditPrecondition[];
}

export interface GraphEditConflict {
  preconditionIndex: number;
  nodeId: string;
  reason: string;
}

export interface GraphEditResult {
  /** True only when the candidate was built and validates — safe to accept. */
  applied: boolean;
  /** A stale precondition — no change was attempted (spec16 §86). */
  conflict?: GraphEditConflict;
  /** A change referenced something that does not exist, or is the wrong kind. */
  applyError?: string;
  validation?: ValidationResult;
  /** The semantic difference this edit would make, computed even when the candidate is invalid. */
  diff?: SemanticDiff;
  /** The resulting candidate graph. Present whenever construction succeeded, valid or not — spec16 §100 marks an invalid answer explicitly rather than omitting it. */
  candidate?: ApplicationGraph;
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function checkPreconditions(
  graph: ApplicationGraph,
  preconditions: readonly EditPrecondition[],
): GraphEditConflict | undefined {
  for (let index = 0; index < preconditions.length; index += 1) {
    const precondition = preconditions[index];
    const node = graph.getNode(precondition.nodeId);
    if (precondition.expect === 'exists' && !node) {
      return { preconditionIndex: index, nodeId: String(precondition.nodeId), reason: `node ${precondition.nodeId} does not exist` };
    }
    if (precondition.expect === 'absent' && node) {
      return { preconditionIndex: index, nodeId: String(precondition.nodeId), reason: `node ${precondition.nodeId} already exists` };
    }
    if (typeof precondition.expect === 'object') {
      const actual = node ? (node as unknown as Record<string, unknown>)[precondition.expect.field] : undefined;
      if (!jsonEq(actual, precondition.expect.equals)) {
        return {
          preconditionIndex: index,
          nodeId: String(precondition.nodeId),
          reason: `expected ${precondition.nodeId}.${precondition.expect.field} to equal ${JSON.stringify(precondition.expect.equals)}, found ${JSON.stringify(actual ?? null)}`,
        };
      }
    }
  }
  return undefined;
}

function applyOneChange(graph: ApplicationGraph, change: GraphChange): void {
  switch (change.kind) {
    case 'add-node':
      graph.addNode(change.node);
      return;
    case 'remove-node':
      if (!graph.removeNode(change.nodeId)) {
        throw new Error(`node ${change.nodeId} does not exist`);
      }
      return;
    case 'update-node':
      graph.updateNode(change.after);
      return;
    case 'add-field': {
      const entity = graph.getNode(change.entityId);
      if (!entity || entity.kind !== 'entity') {
        throw new Error(`${change.entityId} is not an entity`);
      }
      graph.updateNode({ ...entity, fields: [...entity.fields, change.field] });
      return;
    }
    case 'remove-field': {
      const entity = graph.getNode(change.entityId);
      if (!entity || entity.kind !== 'entity') {
        throw new Error(`${change.entityId} is not an entity`);
      }
      const { identityFieldId, ...rest } = entity;
      const fields = rest.fields.filter((field) => field.id !== change.fieldId);
      const keepIdentity = identityFieldId !== change.fieldId ? identityFieldId : undefined;
      graph.updateNode({ ...rest, fields, ...(keepIdentity ? { identityFieldId: keepIdentity } : {}) });
      return;
    }
    case 'add-edge':
      graph.addEdge(change.edge.from, change.edge.to, change.edge.kind, {
        id: change.edge.id,
        ...(change.edge.metadata ? { metadata: change.edge.metadata } : {}),
      });
      return;
    case 'remove-edge':
      graph.removeEdge(change.edge.id);
      return;
    case 'set-theme':
      graph.setTheme(change.after);
      return;
    default: {
      const exhaustive: never = change;
      throw new Error(`unknown graph edit kind ${String((exhaustive as { kind?: unknown }).kind)}`);
    }
  }
}

/** Replays a `GraphChange[]` onto a clone of `base`, never touching `base` itself. */
export function applyGraphChanges(base: ApplicationGraph, changes: readonly GraphChange[]): ApplicationGraph {
  const candidate = ApplicationGraph.deserialize(base.toJSON());
  for (const change of changes) {
    applyOneChange(candidate, change);
  }
  return candidate;
}

/**
 * Propose a candidate edit: check preconditions, apply the change set to a private clone,
 * validate, and compute the semantic diff — all without mutating `base` (spec16 §81-87,
 * §133). The caller decides whether to accept the result; nothing here commits it.
 */
export function proposeGraphEdit(base: ApplicationGraph, request: GraphEditRequest): GraphEditResult {
  if (request.preconditions && request.preconditions.length > 0) {
    const conflict = checkPreconditions(base, request.preconditions);
    if (conflict) {
      return { applied: false, conflict };
    }
  }
  let candidate: ApplicationGraph;
  try {
    candidate = applyGraphChanges(base, request.changes);
  } catch (error) {
    return { applied: false, applyError: error instanceof Error ? error.message : String(error) };
  }
  synchronizeEdges(candidate);
  const validation = validateGraph(candidate);
  const diff = semanticDiff(base, candidate);
  return { applied: validation.valid, validation, diff, candidate };
}
