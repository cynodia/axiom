import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type { Location } from './location.js';
import type { Presentation } from './presentation.js';

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
  /**
   * Whether the node is rendered. This is interaction behaviour, **not authorization**:
   * hidden is not forbidden, and a governed write is checked whether or not any control
   * for it is visible. A rule belongs in an action guard, a `ConstraintDef` or a
   * `TransitionConstraintDef`.
   */
  visibleWhen?: Expression;
  /** Presentation and UX intent. Entirely optional; defaults do the rest. */
  presentation?: Presentation;
  metadata?: Record<string, unknown>;
}

/** A routable or independently renderable UI root. */
export interface ViewNode extends UIBase {
  kind: 'view';
  children: NodeId[];
}

export interface ContainerNode extends UIBase {
  kind: 'container';
  /**
   * The 0.2 spelling of layout intent. `presentation.layout` supersedes it and can say
   * considerably more; this is read as a fallback so 0.4 graphs render unchanged.
   *
   * @deprecated Use `presentation.layout`.
   */
  layout?: 'vertical' | 'horizontal' | 'stack';
  children: NodeId[];
}

export interface TextNode extends UIBase {
  kind: 'text';
  value: string | Expression;
}

/**
 * Repeats `templateId` over `source`. The current item is bound to **this node's own id**,
 * so templates reference it with `{ kind: 'ref', targetId: <repeat node id> }`.
 *
 * `itemAlias` is metadata for humans and resolves nothing. A `source` that evaluates to
 * `null` fails the evaluation rather than rendering nothing — use
 * `coalesce(..., literal([]))` where a collection may legitimately be absent.
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

/**
 * An input's write goes through the same mutation engine and the same transaction
 * machinery as an action; there is no second write path inside the renderer.
 *
 * What governs it depends on what the location is **rooted in**. Rooted in canonical
 * state, the write is transactional with respect to hard invariants: a value that would
 * break one is rolled back and the control re-renders with what is actually stored. Rooted
 * in a `draft` or `ephemeral` state it is not guarded per keystroke, because such a value
 * is incomplete by definition while it is being filled in.
 *
 * Transition constraints apply either way. Binding an input to a protected location does
 * not bypass anything.
 */

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
  /**
   * The 0.2 spelling of control intent, shaped after HTML input types.
   * `presentation.control` supersedes it and is consulted first; absent both, the runtime
   * infers a control from the type of the bound location.
   */
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
  /**
   * Declares destructive intent at the control. The bound action's own `destructive`
   * flag is enough on its own — presentation is inferred from it.
   */
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
