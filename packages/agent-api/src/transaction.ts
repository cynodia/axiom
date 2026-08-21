import {
  ApplicationGraph,
  createFieldId,
  createNodeId,
  isUINode,
  randomHex,
  synchronizeEdges,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  AnyNode,
  ButtonNode,
  ConditionalNode,
  ConstraintDef,
  ContainerNode,
  Density,
  DeviceClass,
  EdgeId,
  EdgeKind,
  EntityDef,
  Expression,
  FieldDef,
  FieldDisplayNode,
  FieldId,
  FormNode,
  InputNode,
  Location,
  NodeId,
  Presentation,
  RepeatNode,
  ResponsiveOverride,
  RouteDef,
  StateDef,
  TextNode,
  ThemeInput,
  UINode,
  UxRole,
  ValidationResult,
  ValueFormat,
  ViewNode,
} from '@cynodia/axiom-core';
import { PresentationQueries } from './presentation-queries.js';
import type { ChangeSet, GraphChange } from './changes.js';

export class TransactionError extends Error {
  readonly result?: ValidationResult;

  constructor(message: string, result?: ValidationResult) {
    super(message);
    this.name = 'TransactionError';
    this.result = result;
  }
}

type UIInput<T extends UINode> = Omit<T, 'id' | 'kind'> & { id?: NodeId };

/**
 * A staged set of graph transformations. Every change is applied to a private copy, so
 * the graph an agent (or a runtime) can observe is unchanged until `commit()` succeeds.
 */
export class Transaction extends PresentationQueries {
  private readonly operations: GraphChange[] = [];
  private settled = false;

  constructor(
    private readonly target: ApplicationGraph,
    private readonly onCommit: (change: ChangeSet) => void,
  ) {
    super(ApplicationGraph.deserialize(target.toJSON()));
  }

  /** The staged graph. Reading it shows uncommitted changes. */
  get staged(): ApplicationGraph {
    return this.graph;
  }

  get changes(): GraphChange[] {
    return this.operations.map((operation) => ({ ...operation }));
  }

  // ------------------------------------------------------------ transformations

  addEntity(entity: { id?: NodeId; name?: string; fields?: FieldDef[]; identityFieldId?: FieldId }): NodeId {
    const id = entity.id ?? createNodeId('entity');
    this.addNode<EntityDef>({
      id,
      kind: 'entity',
      name: entity.name,
      fields: entity.fields ?? [],
      identityFieldId: entity.identityFieldId,
    });
    return id;
  }

  /** Adds a field to an existing entity without the caller rebuilding the entity. */
  addField(entityId: NodeId, field: Omit<FieldDef, 'id'> & { id?: FieldId }): FieldId {
    const entity = this.requireNode<EntityDef>(entityId, 'entity');
    const id = field.id ?? createFieldId('field');
    const before = structuredClone(entity);
    entity.fields = [...entity.fields, { ...field, id } as FieldDef];
    this.graph.updateNode(entity);
    this.operations.push({ kind: 'add-field', entityId, field: { ...field, id } as FieldDef });
    this.operations.push({ kind: 'update-node', nodeId: entityId, before, after: structuredClone(entity) });
    return id;
  }

  removeField(fieldId: FieldId): void {
    const location = this.graph.getField(fieldId);
    if (!location) {
      throw new TransactionError(`Field ${fieldId} does not exist`);
    }
    const entity = this.requireNode<EntityDef>(location.entityId, 'entity');
    const before = structuredClone(entity);
    entity.fields = entity.fields.filter((field) => field.id !== fieldId);
    if (entity.identityFieldId === fieldId) {
      delete entity.identityFieldId;
    }
    this.graph.updateNode(entity);
    this.operations.push({
      kind: 'remove-field',
      entityId: location.entityId,
      fieldId,
      field: location.field,
    });
    this.operations.push({
      kind: 'update-node',
      nodeId: location.entityId,
      before,
      after: structuredClone(entity),
    });
  }

  addState(state: Omit<StateDef, 'id' | 'kind'> & { id?: NodeId }): NodeId {
    const id = state.id ?? createNodeId('state');
    this.addNode<StateDef>({ ...state, id, kind: 'state' } as StateDef);
    return id;
  }

  addAction(action: Omit<ActionDef, 'id' | 'kind'> & { id?: NodeId }): NodeId {
    const id = action.id ?? createNodeId('action');
    this.addNode<ActionDef>({ ...action, id, kind: 'action' } as ActionDef);
    return id;
  }

  addConstraint(constraint: Omit<ConstraintDef, 'id' | 'kind'> & { id?: NodeId }): NodeId {
    const id = constraint.id ?? createNodeId('constraint');
    this.addNode<ConstraintDef>({ ...constraint, id, kind: 'constraint' } as ConstraintDef);
    return id;
  }

  addRoute(route: Omit<RouteDef, 'id' | 'kind'> & { id?: NodeId }): NodeId {
    const id = route.id ?? createNodeId('route');
    this.addNode<RouteDef>({ ...route, id, kind: 'route' } as RouteDef);
    return id;
  }

  addView(view: UIInput<ViewNode>): NodeId {
    return this.addUiNode<ViewNode>({ ...view, kind: 'view' } as ViewNode);
  }

  addContainer(container: UIInput<ContainerNode>): NodeId {
    return this.addUiNode<ContainerNode>({ ...container, kind: 'container' } as ContainerNode);
  }

  addText(text: UIInput<TextNode>): NodeId {
    return this.addUiNode<TextNode>({ ...text, kind: 'text' } as TextNode);
  }

  addRepeat(repeat: UIInput<RepeatNode>): NodeId {
    return this.addUiNode<RepeatNode>({ ...repeat, kind: 'repeat' } as RepeatNode);
  }

  addForm(form: UIInput<FormNode>): NodeId {
    return this.addUiNode<FormNode>({ ...form, kind: 'form' } as FormNode);
  }

  addConditional(conditional: UIInput<ConditionalNode>): NodeId {
    return this.addUiNode<ConditionalNode>({ ...conditional, kind: 'conditional' } as ConditionalNode);
  }

  addInput(input: UIInput<InputNode>): NodeId {
    return this.addUiNode<InputNode>({ ...input, kind: 'input' } as InputNode);
  }

  addButton(button: UIInput<ButtonNode>): NodeId {
    return this.addUiNode<ButtonNode>({ ...button, kind: 'button' } as ButtonNode);
  }

  addFieldDisplay(display: UIInput<FieldDisplayNode>): NodeId {
    return this.addUiNode<FieldDisplayNode>({ ...display, kind: 'field-display' } as FieldDisplayNode);
  }

  /**
   * Creates an input for a field and attaches it to a parent, which is the whole of
   * "make this field editable here".
   */
  bindField(request: {
    parentId: NodeId;
    /** The addressable position the input writes to. */
    location: Location;
    label?: string;
    inputHint?: InputNode['inputHint'];
    id?: NodeId;
    position?: number;
  }): NodeId {
    const inputId = this.addInput({
      id: request.id,
      label: request.label,
      inputHint: request.inputHint,
      binding: { location: request.location },
    });
    this.appendChild(request.parentId, inputId, request.position);
    return inputId;
  }

  /** Creates a read-only display for a field and attaches it to a parent. */
  displayField(request: {
    parentId: NodeId;
    source: Expression;
    fieldId: FieldId;
    label?: string;
    id?: NodeId;
    position?: number;
  }): NodeId {
    const displayId = this.addFieldDisplay({
      id: request.id,
      source: request.source,
      fieldId: request.fieldId,
      label: request.label,
    });
    this.appendChild(request.parentId, displayId, request.position);
    return displayId;
  }

  /**
   * Teaches every action that constructs instances of an entity about a new field, so a
   * field added to the model is also populated by the actions that create records.
   */
  addFieldToConstructors(entityId: NodeId, fieldId: FieldId, value: Expression): NodeId[] {
    const updated: NodeId[] = [];
    for (const action of this.graph.getNodesByKind('action')) {
      let changed = false;
      const operations = (action.operations ?? []).map((operation) => {
        if (!('value' in operation) || operation.value.kind !== 'object') {
          return operation;
        }
        if (operation.value.entityId !== entityId) {
          return operation;
        }
        if (operation.value.entries.some((entry) => entry.fieldId === fieldId)) {
          return operation;
        }
        changed = true;
        return {
          ...operation,
          value: { ...operation.value, entries: [...operation.value.entries, { fieldId, value }] },
        };
      });
      if (changed) {
        this.updateNode({ ...action, operations } as ActionDef);
        updated.push(action.id);
      }
    }
    return updated;
  }

  // ------------------------------------------------------- presentation and theme

  /**
   * Replaces a node's presentation intent outright.
   *
   * "Make this form more compact" is one of these calls, not seventeen edited style
   * declarations — and because the result is still semantic data, the next agent can read
   * back what was intended rather than infer it from CSS.
   */
  setPresentation(nodeId: NodeId, presentation: Presentation | undefined): void {
    const node = this.requireUiNode(nodeId);
    if (presentation === undefined) {
      delete node.presentation;
    } else {
      node.presentation = structuredClone(presentation);
    }
    this.updateNode(node);
  }

  /** Merges presentation intent, leaving whatever the node already said in place. */
  mergePresentation(nodeId: NodeId, patch: Presentation): void {
    const node = this.requireUiNode(nodeId);
    node.presentation = { ...(node.presentation ?? {}), ...structuredClone(patch) };
    this.updateNode(node);
  }

  setUxRole(nodeId: NodeId, uxRole: UxRole | undefined): void {
    this.mergePresentation(nodeId, { uxRole } as Presentation);
  }

  setDensity(nodeId: NodeId, density: Density): void {
    this.mergePresentation(nodeId, { density });
  }

  setValueFormat(nodeId: NodeId, format: ValueFormat | undefined): void {
    this.mergePresentation(nodeId, { format } as Presentation);
  }

  /** States what a node does on one class of display. */
  setResponsiveBehavior(nodeId: NodeId, device: DeviceClass, override: ResponsiveOverride | undefined): void {
    const node = this.requireUiNode(nodeId);
    const responsive = { ...(node.presentation?.responsive ?? {}) };
    if (override === undefined) {
      delete responsive[device];
    } else {
      responsive[device] = structuredClone(override);
    }
    node.presentation = { ...(node.presentation ?? {}), responsive };
    this.updateNode(node);
  }

  /**
   * Replaces the theme. An application-wide visual change belongs here rather than in the
   * UI nodes: a theme cannot alter an action, a constraint, a location or a route.
   */
  setTheme(theme: ThemeInput | undefined): void {
    const before = this.graph.declaredTheme;
    this.graph.setTheme(theme);
    this.operations.push({
      kind: 'set-theme',
      ...(before ? { before } : {}),
      ...(theme ? { after: structuredClone(theme) } : {}),
    });
  }

  /** Changes part of the theme, keeping the rest of what the application declared. */
  mergeTheme(patch: ThemeInput): void {
    const before = this.graph.declaredTheme ?? {};
    this.setTheme(mergeThemeInput(before, patch));
  }

  appendChild(parentId: NodeId, childId: NodeId, position?: number): void {
    const parent = this.graph.getNode(parentId);
    if (!parent || !('children' in parent) || !Array.isArray((parent as { children: NodeId[] }).children)) {
      throw new TransactionError(`Node ${parentId} cannot contain children`);
    }
    const before = structuredClone(parent);
    const container = parent as unknown as { children: NodeId[] };
    const children = [...container.children];
    children.splice(position ?? children.length, 0, childId);
    container.children = children;
    this.graph.updateNode(parent);
    this.operations.push({
      kind: 'update-node',
      nodeId: parentId,
      before,
      after: structuredClone(parent),
    });
  }

  addNode<T extends AnyNode>(node: T): NodeId {
    const id = this.graph.addNode<T>(node as never);
    const stored = this.graph.getNode(id);
    if (stored) {
      this.operations.push({ kind: 'add-node', nodeId: id, node: stored });
    }
    return id;
  }

  updateNode(node: AnyNode): void {
    const before = this.graph.getNode(node.id);
    if (!before) {
      throw new TransactionError(`Node ${node.id} does not exist`);
    }
    this.graph.updateNode(node);
    this.operations.push({ kind: 'update-node', nodeId: node.id, before, after: structuredClone(node) });
  }

  removeNode(id: NodeId): void {
    const node = this.graph.getNode(id);
    if (!node) {
      throw new TransactionError(`Node ${id} does not exist`);
    }
    for (const edge of this.graph.getEdges(id)) {
      this.operations.push({ kind: 'remove-edge', edge });
    }
    this.graph.removeNode(id);
    this.operations.push({ kind: 'remove-node', nodeId: id, node });
  }

  addEdge(from: NodeId, to: NodeId, kind: EdgeKind): EdgeId {
    const id = this.graph.addEdge(from, to, kind);
    const edge = this.graph.getEdge(id);
    if (edge) {
      this.operations.push({ kind: 'add-edge', edge });
    }
    return id;
  }

  removeEdge(id: EdgeId): void {
    const edge = this.graph.getEdge(id);
    if (!edge) {
      return;
    }
    this.graph.removeEdge(id);
    this.operations.push({ kind: 'remove-edge', edge });
  }

  // ------------------------------------------------------------------ lifecycle

  /** Re-derives structural edges and checks referential integrity of the staged graph. */
  validate(): ValidationResult {
    synchronizeEdges(this.graph);
    return validateGraph(this.graph);
  }

  commit(options: { reason?: string; actor?: string; timestamp?: number } = {}): ChangeSet {
    this.assertOpen();
    const result = this.validate();
    if (!result.valid) {
      throw new TransactionError(
        `Refusing to commit an invalid graph:\n${result.errors
          .map((problem) => `  [${problem.code}] ${problem.message}`)
          .join('\n')}`,
        result,
      );
    }
    this.target.restore(this.graph.toJSON());
    this.settled = true;
    const change: ChangeSet = {
      id: `change_${randomHex(6)}`,
      timestamp: options.timestamp ?? Date.now(),
      operations: this.changes,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
    };
    this.onCommit(change);
    return change;
  }

  rollback(): void {
    this.assertOpen();
    this.settled = true;
  }

  private assertOpen(): void {
    if (this.settled) {
      throw new TransactionError('This transaction has already been committed or rolled back');
    }
  }

  private addUiNode<T extends UINode>(node: T): NodeId {
    const id = node.id ?? createNodeId(node.kind.replace('-', '_'));
    return this.addNode<T>({ ...node, id } as T);
  }

  private requireUiNode(id: NodeId): UINode {
    const node = this.graph.getNode(id);
    if (!node || !isUINode(node)) {
      throw new TransactionError(`${id} is not a UI node`);
    }
    return node;
  }

  private requireNode<T extends AnyNode>(id: NodeId, kind: T['kind']): T {
    const node = this.graph.getNode<T>(id);
    if (!node || node.kind !== kind) {
      throw new TransactionError(`${id} is not a ${String(kind)} node`);
    }
    return node;
  }
}

/** Deep merge of two partial themes, so a patch never has to restate whole tables. */
function mergeThemeInput(base: ThemeInput, patch: ThemeInput): ThemeInput {
  const isPlain = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const merge = (left: unknown, right: unknown): unknown => {
    if (!isPlain(right)) {
      return right === undefined ? left : right;
    }
    const result: Record<string, unknown> = isPlain(left) ? { ...left } : {};
    for (const [key, value] of Object.entries(right)) {
      if (value !== undefined) {
        result[key] = merge(result[key], value);
      }
    }
    return result;
  };
  return merge(structuredClone(base), structuredClone(patch)) as ThemeInput;
}
