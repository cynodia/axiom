import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type { Location } from './location.js';
import type { PresentationHints } from './nodes.js';

export type UINodeKind =
  | 'view'
  | 'container'
  | 'text'
  | 'repeat'
  | 'field-display'
  | 'form'
  | 'input'
  | 'button'
  | 'conditional';

export const UI_NODE_KINDS: readonly UINodeKind[] = [
  'view',
  'container',
  'text',
  'repeat',
  'field-display',
  'form',
  'input',
  'button',
  'conditional',
];

export interface UIBase {
  id: NodeId;
  kind: UINodeKind;
  name?: string;
  visibleWhen?: Expression;
  presentation?: PresentationHints;
  metadata?: Record<string, unknown>;
}

/** A routable or independently renderable UI root. */
export interface ViewNode extends UIBase {
  kind: 'view';
  children: NodeId[];
}

export interface ContainerNode extends UIBase {
  kind: 'container';
  layout?: 'vertical' | 'horizontal' | 'stack';
  children: NodeId[];
}

export interface TextNode extends UIBase {
  kind: 'text';
  value: string | Expression;
}

/**
 * Repeats `templateId` over `source`. The current item is bound to this node's own id,
 * so templates reference it with `{ kind: 'ref', targetId: <repeat node id> }`.
 */
export interface RepeatNode extends UIBase {
  kind: 'repeat';
  source: Expression;
  itemAlias?: string;
  templateId: NodeId;
  emptyTemplateId?: NodeId;
}

export interface FieldDisplayNode extends UIBase {
  kind: 'field-display';
  source: Expression;
  fieldId: FieldId;
  label?: string;
}

export interface FormNode extends UIBase {
  kind: 'form';
  target: Expression;
  children: NodeId[];
  submitActionId?: NodeId;
  submitLabel?: string;
}

/**
 * An input writes to an addressed Location, never to whatever object an expression
 * happened to evaluate to.
 */
export interface InputBinding {
  location: Location;
}

export type InputHint = 'text' | 'email' | 'number' | 'password' | 'date' | 'checkbox' | 'multiline' | 'select';

/**
 * Offers a choice drawn from application data rather than a fixed enum, which is how a
 * value that identifies another record is entered. Each candidate is bound to `scopeId`
 * while `valueFieldId` and `labelFieldId` are read.
 */
export interface InputOptionsSource {
  source: Expression;
  scopeId: NodeId;
  valueFieldId: FieldId;
  labelFieldId?: FieldId;
}

export interface InputNode extends UIBase {
  kind: 'input';
  binding: InputBinding;
  /** Presentation hint only; the runtime infers a control from the field type otherwise. */
  inputHint?: InputHint;
  options?: InputOptionsSource;
  label?: string;
  placeholder?: string;
}

export interface ButtonNode extends UIBase {
  kind: 'button';
  label: string | Expression;
  actionId: NodeId;
  /** Keyed by action parameter id. */
  arguments?: Record<string, Expression>;
  destructive?: boolean;
}

export interface ConditionalNode extends UIBase {
  kind: 'conditional';
  condition: Expression;
  whenTrue: NodeId[];
  whenFalse?: NodeId[];
}

export type UINode =
  | ViewNode
  | ContainerNode
  | TextNode
  | RepeatNode
  | FieldDisplayNode
  | FormNode
  | InputNode
  | ButtonNode
  | ConditionalNode;

export function isUINode(node: { kind: string }): node is UINode {
  return (UI_NODE_KINDS as readonly string[]).includes(node.kind);
}

/** Child ids declared by a UI node, in render order. */
export function uiChildIds(node: UINode): NodeId[] {
  switch (node.kind) {
    case 'view':
    case 'container':
    case 'form':
      return [...node.children];
    case 'repeat':
      return node.emptyTemplateId ? [node.templateId, node.emptyTemplateId] : [node.templateId];
    case 'conditional':
      return [...node.whenTrue, ...(node.whenFalse ?? [])];
    default:
      return [];
  }
}
