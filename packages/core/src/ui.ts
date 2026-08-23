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
  | 'conditional'
  | 'diagnostic'
  | 'dialog';

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
  'diagnostic',
  'dialog',
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

/**
 * Groups controls, and optionally submits an action.
 *
 * There are two ways to give a form a submit control:
 *
 * - `submitActionId` (+ `submitLabel`) is the simple form: the renderer generates the
 *   button. Nothing else has to be declared.
 * - `submitButtonId` is the advanced form: a declared `ButtonNode` inside the form becomes
 *   the submit control. It stays an ordinary graph node — queryable, positionable in an
 *   action group, and able to carry its own presentation and icon — while still receiving
 *   native form-submit behaviour.
 *
 * `target` is the record the form is about. It is a read: it does **not** decide where the
 * children write, because every input carries its own location.
 */
export interface FormNode extends UIBase {
  kind: 'form';
  target: Expression;
  children: NodeId[];
  /**
   * The action the form submits. Optional when `submitButtonId` is given, in which case
   * that button's own `actionId` is the submit action; if both are given they must agree.
   */
  submitActionId?: NodeId;
  /** Label for the generated submit button. Ignored when `submitButtonId` is given. */
  submitLabel?: string;
  /**
   * A `ButtonNode` among this form's descendants to use as the submit control instead of a
   * generated one.
   */
  submitButtonId?: NodeId;
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

/**
 * Presents why an action refused.
 *
 * The runtime already knows an action failed and why. This node makes that available to
 * the semantic application model, so an application never has to duplicate an action's
 * guards as derived state merely to explain them, inspect console output, or copy an
 * `ActionResult` into its own state.
 *
 * It presents the diagnostics of the referenced action's **most recent invocation**:
 *
 * - a failed invocation replaces whatever was there with its own diagnostics;
 * - a successful one replaces them with nothing, so the message clears;
 * - a declined confirmation is recorded as `cancelled` and likewise presents nothing;
 * - the record is cleared by `clearDiagnostics()` and by navigating to another route.
 *
 * The messages come from the structured diagnostics — `failureMode.message` for a refused
 * guard, `ConstraintDef.message` for a broken invariant — never from wording in the
 * renderer.
 */
export interface DiagnosticNode extends UIBase {
  kind: 'diagnostic';
  /** The action whose most recent invocation is reported. */
  actionId: NodeId;
  /**
   * The lowest severity presented. `'error'` (the default) presents only errors;
   * `'warning'` presents warnings as well.
   */
  severity?: 'error' | 'warning';
}

/**
 * A dialog: content that interrupts, and the interaction rules that make it one.
 *
 * A dialog is the case where "compose it from existing nodes" stops being enough. Its
 * *visibility* is expressible today — an ephemeral state and a `conditional` — but everything
 * that makes it a dialog rather than a box that appears is behaviour no node describes: focus
 * moves into it, focus cannot leave it, Escape dismisses it, focus returns to whatever opened
 * it, and assistive technology is told all of that. None of it can be added by a pattern,
 * because a pattern only emits nodes that already exist.
 *
 * So it is canonical semantics, and the split is deliberate:
 *
 * - **The graph says** what is open, what it is called, what it contains, what closes it, and whether it is modal.
 * - **The runtime does** focus movement, focus containment, Escape, focus return, `role` and `aria-modal`.
 *
 * Nothing here names an element, a CSS class, a position or a z-index. A renderer that is not
 * a browser implements the same semantics its own way.
 */
export interface DialogNode extends UIBase {
  kind: 'dialog';
  /**
   * True while the dialog is open.
   *
   * An ordinary expression over ordinary state — usually an `ephemeral` boolean — rather than
   * hidden runtime state. Openness is then inspectable, addressable and mutated through the
   * same governed path as everything else: an action opens it, an action closes it, and the
   * mutation log records both.
   */
  openWhen: Expression;
  /** The accessible name. Required: a dialog nobody can name is a dialog nobody can use. */
  title: string | Expression;
  description?: string | Expression;
  children: NodeId[];
  /**
   * The action that closes it, invoked when the person dismisses the dialog.
   *
   * Dismissal is an interaction; what it *means* is this action's business. Closing a dialog
   * is not cancelling an operation unless this action cancels one — the runtime will never
   * infer that it does.
   */
  closeActionId: NodeId;
  /** Default true. A modal dialog contains focus; a non-modal one does not. */
  modal?: boolean;
  /** Which descendant receives focus when it opens. Absent, the first focusable one. */
  initialFocusId?: NodeId;
  /** The control focus returns to when it closes. Usually whatever opened it. */
  returnFocusId?: NodeId;
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
  | ConditionalNode
  | DiagnosticNode
  | DialogNode;

export function isUINode(node: { kind: string }): node is UINode {
  return (UI_NODE_KINDS as readonly string[]).includes(node.kind);
}

/**
 * Children along the **primary render path**: the arrangement that appears when every
 * collection has members and every condition holds.
 *
 * An empty template and a false branch are *alternatives* to that path, not part of it.
 * Analysis of structure that is on screen together — a document outline, the sections of a
 * form — walks this rather than `uiChildIds`, which is what keeps it free of findings about
 * content that never appears at the same time.
 */
export function primaryChildIds(node: UINode): NodeId[] {
  switch (node.kind) {
    case 'repeat':
      return [node.templateId];
    case 'conditional':
      return [...node.whenTrue];
    default:
      return uiChildIds(node);
  }
}

/**
 * The action a form submits, however it was declared.
 *
 * A form may name the action directly (`submitActionId`) or name a declared button that
 * invokes it (`submitButtonId`). Every layer — execution, validation, presentation
 * inference, `AgentAPI` — must resolve it the same way, or a form's primary action means
 * one thing to the renderer and another to an agent.
 */
export function formSubmitActionId(
  form: FormNode,
  lookup: (id: NodeId) => { kind: string; actionId?: NodeId } | undefined,
): NodeId | undefined {
  if (form.submitActionId) {
    return form.submitActionId;
  }
  if (!form.submitButtonId) {
    return undefined;
  }
  const button = lookup(form.submitButtonId);
  return button?.kind === 'button' ? button.actionId : undefined;
}

/** Child ids declared by a UI node, in render order. */
export function uiChildIds(node: UINode): NodeId[] {
  switch (node.kind) {
    case 'view':
    case 'container':
    case 'form':
    case 'dialog':
      return [...node.children];
    case 'repeat':
      return node.emptyTemplateId ? [node.templateId, node.emptyTemplateId] : [node.templateId];
    case 'conditional':
      return [...node.whenTrue, ...(node.whenFalse ?? [])];
    default:
      return [];
  }
}
