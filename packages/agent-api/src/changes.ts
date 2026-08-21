import type { AnyNode, FieldDef, FieldId, GraphEdge, NodeId, ThemeInput } from '@cynodia/axiom-core';

export type GraphChange =
  | AddNodeChange
  | RemoveNodeChange
  | UpdateNodeChange
  | AddFieldChange
  | RemoveFieldChange
  | AddEdgeChange
  | RemoveEdgeChange
  | SetThemeChange;

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

/**
 * A change to the application's visual identity. It is recorded like any other change and
 * can never alter behaviour, which is why an application-wide restyling is one operation
 * rather than an edit to every node.
 */
export interface SetThemeChange {
  kind: 'set-theme';
  before?: ThemeInput;
  after?: ThemeInput;
}

/** A semantic change record: graph operations and intent, never a textual diff. */
export interface ChangeSet {
  id: string;
  timestamp: number;
  operations: GraphChange[];
  reason?: string;
  actor?: string;
}
