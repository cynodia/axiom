import type { AnyNode, FieldDef, FieldId, GraphEdge, NodeId } from '@cynodia/axiom-core';

export type GraphChange =
  | AddNodeChange
  | RemoveNodeChange
  | UpdateNodeChange
  | AddFieldChange
  | RemoveFieldChange
  | AddEdgeChange
  | RemoveEdgeChange;

export interface AddNodeChange {
  kind: 'add-node';
  nodeId: NodeId;
  node: AnyNode;
}

export interface RemoveNodeChange {
  kind: 'remove-node';
  nodeId: NodeId;
  node: AnyNode;
}

export interface UpdateNodeChange {
  kind: 'update-node';
  nodeId: NodeId;
  before: AnyNode;
  after: AnyNode;
}

export interface AddFieldChange {
  kind: 'add-field';
  entityId: NodeId;
  field: FieldDef;
}

export interface RemoveFieldChange {
  kind: 'remove-field';
  entityId: NodeId;
  fieldId: FieldId;
  field: FieldDef;
}

export interface AddEdgeChange {
  kind: 'add-edge';
  edge: GraphEdge;
}

export interface RemoveEdgeChange {
  kind: 'remove-edge';
  edge: GraphEdge;
}

/** A semantic change record: graph operations and intent, never a textual diff. */
export interface ChangeSet {
  id: string;
  timestamp: number;
  operations: GraphChange[];
  reason?: string;
  actor?: string;
}
