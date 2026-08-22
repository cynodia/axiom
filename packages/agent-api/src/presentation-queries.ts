import {
  actionAuthority,
  authorityContext,
  isUINode,
  primaryChildIds,
  resolvePresentationMap,
  stateAuthority,
  uiChildIds,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  Authority,
  AuthorityContext,
  Density,
  DeviceClass,
  DiagnosticNode,
  FormNode,
  NodeId,
  Expression,
  Presentation,
  PresentationRole,
  ResolvedPresentation,
  ResolvedResponsive,
  StateDef,
  Theme,
  UINode,
  UxRole,
  ValidationIssue,
  ViewNode,
} from '@cynodia/axiom-core';
import { statesWrittenBy } from '@cynodia/axiom-core';
import { GraphQueries } from './queries.js';

/** Diagnostic codes produced by the presentation layer. */
const PRESENTATION_CODES = [
  'UNKNOWN_PRESENTATION_TOKEN',
  'PRESENTATION_SEMANTIC_CONFLICT',
  'MULTIPLE_PRIMARY_ACTIONS',
  'FORM_WITHOUT_PRIMARY_ACTION',
  'DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS',
  'DESTRUCTIVE_ACTION_UNMARKED',
  'EXCESSIVE_HORIZONTAL_ACTIONS',
  'EMPTY_STATE_WITHOUT_RECOVERY_ACTION',
  'RIGID_HORIZONTAL_LAYOUT',
  'CONFLICTING_SIZING',
  'INTERACTIVE_ELEMENT_MISSING_LABEL',
  'FORM_INPUT_MISSING_LABEL',
  'INVALID_HEADING_STRUCTURE',
  'OPAQUE_PRESENTATION',
];

/** One grouped part of a form, and what it contains. */
export interface FormSectionSummary {
  nodeId: NodeId;
  name?: string;
  /** Text nodes inside the section that act as headings. */
  headings: string[];
  inputIds: NodeId[];
}

/**
 * The shape of a form as UX, rather than as a list of children: which parts are sections,
 * which controls are required, where the actions are and which one is primary.
 */
/**
 * The **declared** structure of a form: what it contains, not what is on screen right now.
 *
 * It is read along the primary render path, so an alternative branch — an empty template,
 * a conditional's false branch — is not described as part of the form's structure.
 */
export interface FormStructure {
  formId: NodeId;
  density: Density;
  submitActionId?: NodeId;
  /** Set when the form uses a declared `ButtonNode` as its submit control. */
  submitButtonId?: NodeId;
  sections: FormSectionSummary[];
  /** Inputs that belong to no section. */
  ungroupedInputIds: NodeId[];
  actionGroupIds: NodeId[];
  primaryActionIds: NodeId[];
  destructiveActionIds: NodeId[];
  requiredInputIds: NodeId[];
}

/**
 * Presentation and UX queries, §46 and §47.
 *
 * These are the questions that cannot be answered from a stylesheet: which control is the
 * primary action, which regions are grouped and why, what happens on a narrow display,
 * where the presentation contradicts the application's own semantics. They are answerable
 * here only because UX intent is structured data.
 *
 * Resolution is recomputed per call rather than cached: a transaction mutates the graph
 * underneath these queries, and a stale presentation answer would be worse than a slow one.
 */
export class PresentationQueries extends GraphQueries {
  /** The application's visual identity, completed against the default theme. */
  getTheme(): Theme {
    return this.graph.theme;
  }

  /** Exactly what a node declares, before defaults, inheritance or inference. */
  getPresentation(nodeId: NodeId): Presentation | undefined {
    const node = this.graph.getNode(nodeId);
    return node && isUINode(node) ? node.presentation : undefined;
  }

  /** Presentation with every question answered, as a renderer receives it. */
  resolvePresentation(nodeId: NodeId): ResolvedPresentation | undefined {
    return this.presentationMap()[nodeId];
  }

  /** Resolved presentation for every UI node in the application. */
  resolveAllPresentation(): Record<NodeId, ResolvedPresentation> {
    return this.presentationMap();
  }

  getUxRole(nodeId: NodeId): UxRole | undefined {
    return this.resolvePresentation(nodeId)?.uxRole;
  }

  /** What changes on a compact, regular or wide display. */
  getResponsiveBehavior(nodeId: NodeId): Partial<Record<DeviceClass, ResolvedResponsive>> {
    return this.resolvePresentation(nodeId)?.responsive ?? {};
  }

  /** Every UI node whose resolved UX role is this one. */
  findNodesByUxRole(uxRole: UxRole): UINode[] {
    const resolved = this.presentationMap();
    return this.uiNodes().filter((node) => resolved[node.id]?.uxRole === uxRole);
  }

  /** Every UI node presented in this role, however the role was decided. */
  findNodesByRole(role: PresentationRole): UINode[] {
    const resolved = this.presentationMap();
    return this.uiNodes().filter((node) => resolved[node.id]?.role === role);
  }

  /** Which nodes end up at a given density, inheritance included. */
  findNodesByDensity(density: Density): UINode[] {
    const resolved = this.presentationMap();
    return this.uiNodes().filter((node) => resolved[node.id]?.density === density);
  }

  /** Views that present anything in this role — "which views use this theme role?". */
  getViewsUsingRole(role: PresentationRole): ViewNode[] {
    const views = new Map<NodeId, ViewNode>();
    for (const node of this.findNodesByRole(role)) {
      for (const view of this.enclosingViews(node.id)) {
        views.set(view.id, view);
      }
    }
    return [...views.values()];
  }

  /** Actions a view presents as primary. */
  getPrimaryActions(viewId: NodeId): ActionDef[] {
    return this.actionsWithUxRole(viewId, 'primary-action');
  }

  /** Actions a view presents as destructive, whether declared or inferred. */
  getDestructiveActions(viewId: NodeId): ActionDef[] {
    return this.actionsWithUxRole(viewId, 'destructive-action');
  }

  /** Forms that offer no primary action, which is a hierarchy an agent can repair. */
  getFormsWithoutPrimaryAction(): FormNode[] {
    return this.graph
      .getNodesByKind('form')
      .filter((form) => this.getFormStructure(form.id).primaryActionIds.length === 0);
  }

  /** Nodes carrying renderer-specific presentation that cannot be analyzed. */
  getOpaquePresentationNodes(): UINode[] {
    const resolved = this.presentationMap();
    return this.uiNodes().filter((node) => resolved[node.id]?.opaque === true);
  }

  /** UI nodes that present failures from this action. */
  getDiagnosticPresentations(actionId: NodeId): DiagnosticNode[] {
    return this.uiNodes().filter(
      (node): node is DiagnosticNode => node.kind === 'diagnostic' && node.actionId === actionId,
    );
  }

  /**
   * Actions that can refuse but whose refusal no UI node presents.
   *
   * An action counts as able to refuse if it declares a guard, a precondition or a
   * postcondition. Only actions a control actually invokes are reported, since an action
   * nothing invokes has no refusal to explain.
   */
  getActionsWithoutDiagnosticPresentation(): ActionDef[] {
    const invoked = new Set<NodeId>();
    for (const node of this.uiNodes()) {
      if (node.kind === 'button') {
        invoked.add(node.actionId);
      }
      if (node.kind === 'form' && node.submitActionId) {
        invoked.add(node.submitActionId);
      }
    }
    const presented = new Set(
      this.uiNodes()
        .filter((node): node is DiagnosticNode => node.kind === 'diagnostic')
        .map((node) => node.actionId),
    );
    return this.graph.getNodesByKind('action').filter((action) => {
      if (!invoked.has(action.id) || presented.has(action.id)) {
        return false;
      }
      const canRefuse =
        (action.guards ?? []).length > 0 ||
        (action.preconditions ?? []).length > 0 ||
        (action.postconditions ?? []).length > 0;
      return canRefuse;
    });
  }

  // -------------------------------------------------------------- authority

  /**
   * Who may commit this state. Absent metadata means `'client'`, so a 0.5.x graph answers
   * `'client'` for everything.
   */
  getAuthority(stateId: NodeId): Authority | undefined {
    const state = this.graph.getNode<StateDef>(stateId);
    return state?.kind === 'state' ? stateAuthority(state) : undefined;
  }

  /** Where this action executes. Derived from what it writes, never declared. */
  getActionAuthority(actionId: NodeId): Authority | undefined {
    const action = this.graph.getNode<ActionDef>(actionId);
    return action?.kind === 'action' ? actionAuthority(action, this.authority()) : undefined;
  }

  /** Actions the client must send to the authority rather than execute itself. */
  getServerActions(): ActionDef[] {
    const context = this.authority();
    return this.graph
      .getNodesByKind('action')
      .filter((action) => actionAuthority(action, context) === 'server');
  }

  /** States a client may commit directly. */
  getClientWritableStates(): StateDef[] {
    return this.graph
      .getNodesByKind('state')
      .filter((state) => !state.derivation && stateAuthority(state) === 'client');
  }

  /** States only the authority may commit. */
  getServerWritableStates(): StateDef[] {
    return this.graph
      .getNodesByKind('state')
      .filter((state) => !state.derivation && stateAuthority(state) === 'server');
  }

  /** States the client never receives at all. */
  getServerOnlyStates(): StateDef[] {
    return this.graph.getNodesByKind('state').filter((state) => state.serverOnly === true);
  }

  /** Actions that write any server-authoritative state, with the states each touches. */
  getActionsAffectingServerState(): Array<{ action: ActionDef; stateIds: NodeId[] }> {
    const context = this.authority();
    const server = new Set(this.getServerWritableStates().map((state) => state.id));
    return this.getServerActions().map((action) => ({
      action,
      stateIds: [...statesWrittenBy(action, context)].filter((id) => server.has(id)),
    }));
  }

  /**
   * The rule deciding whether a caller may invoke this action, or `undefined` when there is
   * none — in which case every caller may.
   */
  getAuthorizationForAction(actionId: NodeId): Expression | undefined {
    return this.graph.getNode<ActionDef>(actionId)?.authorization;
  }

  /** Server actions whose invocation no authorization rule restricts. */
  getUnauthorizedServerActions(): ActionDef[] {
    return this.getServerActions().filter((action) => !action.authorization);
  }

  /** Where a state's committed value survives. */
  getPersistenceForState(stateId: NodeId): StateDef['persistence'] {
    return this.graph.getNode<StateDef>(stateId)?.persistence;
  }

  protected authority(): AuthorityContext {
    return authorityContext(this.graph.listNodes(), this.graph.principalEntityId);
  }

  /** States marked as ephemeral presentation state rather than domain facts. */
  getEphemeralStates(): StateDef[] {
    return this.graph.getNodesByKind('state').filter((state) => state.ephemeral === true);
  }

  /**
   * Presentation and UX findings, optionally narrowed to one view. These are the answers
   * to "which views contain presentation warnings?".
   */
  getPresentationWarnings(viewId?: NodeId): ValidationIssue[] {
    const result = validateGraph(this.graph);
    const findings = [...result.errors, ...result.warnings].filter((finding) =>
      PRESENTATION_CODES.includes(finding.code),
    );
    if (!viewId) {
      return findings;
    }
    const scope = new Set<NodeId>([viewId, ...this.descendantIds(viewId)]);
    return findings.filter((finding) => finding.nodeId !== undefined && scope.has(finding.nodeId));
  }

  /** A form described as UX: sections, controls, action groups and hierarchy. */
  getFormStructure(formId: NodeId): FormStructure {
    const form = this.graph.getNode<FormNode>(formId);
    if (!form || form.kind !== 'form') {
      throw new Error(`${formId} is not a form`);
    }
    const resolved = this.presentationMap();
    const sections: FormSectionSummary[] = [];
    const sectionInputs = new Set<NodeId>();
    const actionGroupIds: NodeId[] = [];
    const primaryActionIds = new Set<NodeId>();
    const destructiveActionIds = new Set<NodeId>();
    const requiredInputIds: NodeId[] = [];
    const allInputIds: NodeId[] = [];

    const submitButton = form.submitButtonId
      ? this.graph.getNode(form.submitButtonId)
      : undefined;
    const submitActionId =
      form.submitActionId ??
      (submitButton && isUINode(submitButton) && submitButton.kind === 'button'
        ? submitButton.actionId
        : undefined);
    if (submitActionId) {
      primaryActionIds.add(submitActionId);
    }

    for (const node of this.descendants(formId, { primaryPathOnly: true })) {
      const view = resolved[node.id];
      if (view?.uxRole === 'form-section') {
        const inner = this.descendants(node.id, { primaryPathOnly: true });
        const inputIds = inner.filter((child) => child.kind === 'input').map((child) => child.id);
        inputIds.forEach((id) => sectionInputs.add(id));
        sections.push({
          nodeId: node.id,
          ...(node.name ? { name: node.name } : {}),
          headings: inner
            .filter((child): child is UINode & { kind: 'text' } => child.kind === 'text')
            .filter((child) => isHeading(resolved[child.id]))
            .map((child) => (typeof child.value === 'string' ? child.value : '')),
          inputIds,
        });
      }
      if (view?.uxRole === 'action-group' || view?.uxRole === 'toolbar') {
        actionGroupIds.push(node.id);
      }
      if (node.kind === 'input') {
        allInputIds.push(node.id);
        // Required is a fact about the model, not a presentation decision.
        const addressed = requiredFieldOf(this, node);
        if (addressed) {
          requiredInputIds.push(node.id);
        }
      }
      if (node.kind === 'button') {
        if (view?.uxRole === 'primary-action') {
          primaryActionIds.add(node.actionId);
        }
        if (view?.uxRole === 'destructive-action') {
          destructiveActionIds.add(node.actionId);
        }
      }
    }

    return {
      formId,
      density: resolved[formId]?.density ?? 'comfortable',
      ...(submitActionId ? { submitActionId } : {}),
      ...(form.submitButtonId ? { submitButtonId: form.submitButtonId } : {}),
      sections,
      ungroupedInputIds: allInputIds.filter((id) => !sectionInputs.has(id)),
      actionGroupIds,
      primaryActionIds: [...primaryActionIds],
      destructiveActionIds: [...destructiveActionIds],
      requiredInputIds,
    };
  }

  // ---------------------------------------------------------------- internals

  protected presentationMap(): Record<NodeId, ResolvedPresentation> {
    return resolvePresentationMap(this.graph.listNodes(), this.graph.theme);
  }

  protected uiNodes(): UINode[] {
    return this.graph.listNodes().filter((node): node is UINode => isUINode(node));
  }

  /**
   * UI nodes beneath this one. `primaryPathOnly` restricts the walk to the arrangement that
   * appears when every collection has members and every condition holds, which is what
   * "structure that is on screen together" means.
   */
  protected descendants(id: NodeId, options: { primaryPathOnly?: boolean } = {}): UINode[] {
    const children = options.primaryPathOnly ? primaryChildIds : uiChildIds;
    const found: UINode[] = [];
    const seen = new Set<NodeId>([id]);
    const visit = (current: NodeId): void => {
      const node = this.graph.getNode(current);
      if (!node || !isUINode(node)) {
        return;
      }
      for (const childId of children(node)) {
        if (seen.has(childId)) {
          continue;
        }
        seen.add(childId);
        const child = this.graph.getNode(childId);
        if (child && isUINode(child)) {
          found.push(child);
          visit(childId);
        }
      }
    };
    visit(id);
    return found;
  }

  protected descendantIds(id: NodeId): NodeId[] {
    return this.descendants(id).map((node) => node.id);
  }

  private actionsWithUxRole(viewId: NodeId, uxRole: UxRole): ActionDef[] {
    const resolved = this.presentationMap();
    const found = new Map<NodeId, ActionDef>();
    const candidates = [this.graph.getNode(viewId), ...this.descendants(viewId)];
    for (const node of candidates) {
      if (!node || !isUINode(node) || node.kind !== 'button') {
        continue;
      }
      if (resolved[node.id]?.uxRole !== uxRole) {
        continue;
      }
      const action = this.graph.getNode<ActionDef>(node.actionId);
      if (action?.kind === 'action') {
        found.set(action.id, action);
      }
    }
    // A form's own submit is a primary action even without a button node of its own.
    if (uxRole === 'primary-action') {
      for (const node of candidates) {
        if (node && isUINode(node) && node.kind === 'form' && node.submitActionId) {
          const action = this.graph.getNode<ActionDef>(node.submitActionId);
          if (action?.kind === 'action') {
            found.set(action.id, action);
          }
        }
      }
    }
    return [...found.values()];
  }
}

function isHeading(resolved: ResolvedPresentation | undefined): boolean {
  const role = resolved?.textRole;
  return role === 'heading' || role === 'title' || role === 'display';
}

/** Whether the field an input addresses is declared required. */
function requiredFieldOf(queries: PresentationQueries, node: UINode & { kind: 'input' }): boolean {
  const location = node.binding.location;
  const fieldId = location.kind === 'field' ? location.fieldId : undefined;
  return fieldId ? queries.getField(fieldId)?.field.required === true : false;
}
