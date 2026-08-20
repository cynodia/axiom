export type NodeType = 'entity' | 'state' | 'view' | 'action' | 'constraint' | 'route';

export interface BaseNode {
  id: string;
  type: NodeType;
  name: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface FieldDef {
  name: string;
  fieldType: string;
  required?: boolean;
  validations?: string[];
}

export interface EntityDef extends BaseNode {
  type: 'entity';
  fields: FieldDef[];
}

export interface StateDef extends BaseNode {
  type: 'state';
  stateType: string;
  initialValue?: unknown;
  derivedFrom?: string[];
}

export interface ViewChild {
  nodeId?: string;
  inline?: string;
}

export interface ViewDef extends BaseNode {
  type: 'view';
  renderKind?: 'list' | 'detail' | 'editor' | 'create' | 'generic';
  source?: string;
  children?: ViewChild[];
  actionIds?: string[];
  props?: Record<string, string>;
}

export interface EffectDef {
  kind: 'mutate' | 'navigate' | 'rest';
  target?: string;
  method?: string;
}

export interface ActionDef extends BaseNode {
  type: 'action';
  inputs?: FieldDef[];
  outputs?: FieldDef[];
  preconditions?: string[];
  effects?: EffectDef[];
  sideEffects?: EffectDef[];
  failureModes?: string[];
}

export interface ConstraintDef extends BaseNode {
  type: 'constraint';
  description: string;
  affectedEntityId?: string;
  expression?: string;
}

export interface RouteDef extends BaseNode {
  type: 'route';
  path: string;
  viewId: string;
}

export type AnyNode = EntityDef | StateDef | ViewDef | ActionDef | ConstraintDef | RouteDef;

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

export interface ApplicationGraphData {
  id: string;
  name: string;
  version: string;
  nodes: Record<string, AnyNode>;
  edges: GraphEdge[];
  createdAt: string;
  updatedAt: string;
}

export type NodeInput<T extends AnyNode = AnyNode> = T extends AnyNode
  ? Omit<T, 'id' | 'createdAt'> & Partial<Pick<T, 'id' | 'createdAt'>>
  : never;
