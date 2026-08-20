import type { Expression } from './expressions.js';
import type { EdgeId, FieldId, NodeId } from './ids.js';
import type { TypeRef } from './type-ref.js';

/** Minimal, optional presentation hints. Styling is not a 0.2 research objective. */
export interface PresentationHints {
  role?: 'primary' | 'secondary' | 'danger';
  density?: 'compact' | 'normal';
  emphasis?: 'normal' | 'strong';
}

export interface NodeBase {
  id: NodeId;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface FieldDef {
  id: FieldId;
  name?: string;
  valueType: TypeRef;
  required?: boolean;
  defaultValue?: LiteralValue;
  metadata?: Record<string, unknown>;
}

export type LiteralValue =
  | string
  | number
  | boolean
  | null
  | LiteralValue[]
  | { [key: string]: LiteralValue };

export interface EntityDef extends NodeBase {
  kind: 'entity';
  fields: FieldDef[];
  /** Field used to distinguish instances of this entity. */
  identityFieldId?: FieldId;
}

export type StatePersistence =
  | { kind: 'memory' }
  | { kind: 'local-storage'; key?: string }
  | { kind: 'remote'; sourceId: NodeId };

export interface StateDef extends NodeBase {
  kind: 'state';
  valueType: TypeRef;
  initialValue?: LiteralValue;
  /** When present the state is computed rather than stored. */
  derivation?: Expression;
  /**
   * Marks a state that holds work in progress. Draft instances are incomplete by
   * definition, so instance validation skips them until an action commits the value.
   */
  draft?: boolean;
  persistence?: StatePersistence;
}

export interface ActionParameter {
  id: NodeId;
  name?: string;
  valueType?: TypeRef;
  required?: boolean;
}

export interface FailureMode {
  code: string;
  message?: string;
}

export interface ActionDef extends NodeBase {
  kind: 'action';
  parameters?: ActionParameter[];
  preconditions?: Expression[];
  operations: Operation[];
  postconditions?: Expression[];
  failureModes?: FailureMode[];
  /** Declared destructive intent. Semantics may also be inferred from operations. */
  destructive?: boolean;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
}

export type Operation =
  | SetStateOperation
  | AddItemOperation
  | RemoveItemOperation
  | UpdateFieldOperation
  | InvokeOperation
  | NavigateOperation
  | NativeOperation;

export interface SetStateOperation {
  kind: 'set-state';
  stateId: NodeId;
  value: Expression;
}

export interface AddItemOperation {
  kind: 'add-item';
  collectionId: NodeId;
  value: Expression;
  position?: 'start' | 'end';
}

export interface RemoveItemOperation {
  kind: 'remove-item';
  collectionId: NodeId;
  item: Expression;
}

export interface UpdateFieldOperation {
  kind: 'update-field';
  target: Expression;
  fieldId: FieldId;
  value: Expression;
}

export interface InvokeOperation {
  kind: 'invoke';
  actionId: NodeId;
  arguments?: Record<string, Expression>;
}

export interface NavigateOperation {
  kind: 'navigate';
  routeId?: NodeId;
  path?: string;
  /** Keyed by route parameter id. */
  parameters?: Record<string, Expression>;
}

export type NativeEffect =
  | { kind: 'reads-state'; stateId: NodeId }
  | { kind: 'writes-state'; stateId: NodeId }
  | { kind: 'external'; description: string };

/**
 * Controlled boundary for behaviour the operation vocabulary cannot express. The graph
 * declares an implementation id and its effects; the implementation itself is registered
 * with the runtime and is never embedded in the graph as source text.
 */
export interface NativeOperation {
  kind: 'native';
  implementationId: string;
  inputs?: Record<string, Expression>;
  declaredEffects?: NativeEffect[];
}

export interface ConstraintDef extends NodeBase {
  kind: 'constraint';
  expression: Expression;
  /** When set, the expression is evaluated once per instance of this entity. */
  entityId?: NodeId;
  severity?: 'error' | 'warning';
  message?: string;
}

export interface RouteParameter {
  id: NodeId;
  /** Matches the `:name` placeholder in the route path. */
  name: string;
  valueType?: TypeRef;
}

export interface RouteDef extends NodeBase {
  kind: 'route';
  path: string;
  viewId: NodeId;
  parameters?: RouteParameter[];
}

export type EdgeKind =
  | 'contains'
  | 'reads'
  | 'writes'
  | 'invokes'
  | 'renders'
  | 'binds'
  | 'depends-on'
  | 'derives-from'
  | 'constrains'
  | 'routes-to'
  | 'references';

export const EDGE_KINDS: readonly EdgeKind[] = [
  'contains',
  'reads',
  'writes',
  'invokes',
  'renders',
  'binds',
  'depends-on',
  'derives-from',
  'constrains',
  'routes-to',
  'references',
];

export interface GraphEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
}
