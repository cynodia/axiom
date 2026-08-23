import type {
  ContainerNode,
  DiagnosticNode,
  Expression,
  FieldId,
  FormNode,
  InputNode,
  NodeId,
  TextNode,
} from '@cynodia/axiom-core';
import { fieldLocation, ref, stateLocation } from '@cynodia/axiom-core';
import { definePattern } from '../pattern.js';
import type { PatternFinding } from '../pattern.js';
import {
  actionOf,
  controlFor,
  defaultFormFields,
  entityOf,
  fieldOf,
  labelFor,
  memberEntityId,
  stateOf,
} from '../inference.js';

/**
 * A form over a draft state, and the pattern where inference earns the most.
 *
 * From `EntityDef` and `FieldDef` alone the toolkit knows every field's label, its control,
 * whether it is required, and what order the entity declares them in. From the submit action
 * it knows what the form commits. The author restates none of it — and cannot contradict it,
 * which is the more important property.
 *
 * The form binds inputs to a **draft** state by default. That is not a convenience: a write
 * to canonical state is transactional per keystroke, so a half-filled form would fight every
 * invariant. Which state an input is rooted in is visible in the graph, and the pattern makes
 * the safe choice visible rather than implicit.
 */
export interface EntityFormDeclaration {
  pattern: 'entity-form';
  instance: string;
  /** The draft state the controls write into. */
  draft: NodeId;
  /**
   * Whether this form creates a new instance or edits an existing one.
   *
   * It changes exactly one thing — whether the identity field is offered — and it is explicit
   * because inference cannot tell the two apart from a draft state alone. Phase 1 inferred
   * "always omit the identity", which silently produced create forms that could never submit.
   * Default `create`, which is the failure-visible direction: a redundant field is obvious,
   * a missing required one is not.
   */
  mode?: 'create' | 'edit';
  /** Fields to edit, in order. Absent, every field but the identity. */
  fields?: FieldId[];
  /** The action the form submits. */
  submit: NodeId;
  /** Arguments for the submit action, keyed by action parameter id. */
  submitArguments?: Record<string, Expression>;
  submitLabel?: string;
  title?: string;
  /** The title's outline level. Default 2, which is the level below a page title. */
  titleLevel?: 2 | 3 | 4 | 5 | 6;
  description?: string;
  /** Extra controls beside the submit button — cancel, reset, a destructive action. */
  secondaryActions?: unknown;
}

export const entityForm = definePattern<EntityFormDeclaration>({
  name: 'entity-form',
  version: '0.2.0',
  purpose: 'A form over a draft state, with labels, controls, required markers and a submit action inferred from the graph.',
  inputs: {
    draft: {
      kind: 'state',
      required: true,
      purpose: 'The draft state the controls write into. Its entity supplies every field’s label, control and required status.',
    },
    submit: { kind: 'action', required: true, purpose: 'The action the form submits.' },
    mode: {
      kind: 'token',
      required: false,
      purpose: '"create" offers the identity field; "edit" omits it, because an identity is not editable.',
      inferredWhenAbsent: 'create — the direction whose mistake is visible.',
    },
    fields: {
      kind: 'field-list',
      required: false,
      purpose: 'Which fields to edit, in order.',
      inferredWhenAbsent:
        'Every field of the entity, in declaration order, identity included — omitting a required field would produce a form that can never submit.',
    },
    submitArguments: { kind: 'nodes', required: false, purpose: 'Arguments for the submit action.' },
    submitLabel: { kind: 'text', required: false, purpose: 'The submit control’s label.', inferredWhenAbsent: 'The action’s own name.' },
    title: { kind: 'text', required: false, purpose: 'A heading above the form.' },
    titleLevel: {
      kind: 'token',
      required: false,
      purpose: 'The title’s document-outline level.',
      inferredWhenAbsent: '2 — the level below a page title, so a page and its form do not skip a level.',
    },
    description: { kind: 'text', required: false, purpose: 'A caption under the heading.' },
    secondaryActions: { kind: 'slot', required: false, purpose: 'Controls placed beside the submit button.' },
  },
  slots: ['secondaryActions'],
  produces: ['form', 'input', 'button', 'container', 'text', 'diagnostic'],
  expansion: [
    { part: 'root', kind: 'form', role: 'the form; submitButtonId is the generated submit' },
    { part: 'title', kind: 'text', role: 'optional heading, level 2' },
    { part: 'description', kind: 'text', role: 'optional caption' },
    { part: 'input', kind: 'input', role: 'one per field, in entity declaration order' },
    { part: 'diagnostic', kind: 'diagnostic', role: 'where a refusal of the submit action appears' },
    { part: 'actions', kind: 'container', role: 'action-group holding submit and the secondaryActions slot' },
    { part: 'submit', kind: 'button', role: 'the primary action' },
  ],
  check(declaration, { graph, instance }) {
    const findings: PatternFinding[] = [];
    const draft = stateOf(graph, declaration.draft);
    if (!draft) {
      return [
        {
          code: 'DRAFT_NOT_A_STATE',
          message: `${String(declaration.draft)} is not a state in this graph.`,
          severity: 'error',
          path: `${instance}.draft`,
        },
      ];
    }
    if (draft.derivation) {
      return [
        {
          code: 'DRAFT_IS_DERIVED',
          message: `${draft.name ?? String(declaration.draft)} is derived and therefore read-only; a form cannot write to it.`,
          severity: 'error',
          path: `${instance}.draft`,
        },
      ];
    }
    if (draft.authority === 'server') {
      return [
        {
          code: 'DRAFT_IS_SERVER_OWNED',
          message:
            `${draft.name ?? String(declaration.draft)} is server-authoritative, so a control may not write it. ` +
            'Bind the form to a draft state and let the submit action commit it.',
          severity: 'error',
          path: `${instance}.draft`,
        },
      ];
    }
    if (!draft.draft) {
      findings.push({
        code: 'STATE_NOT_MARKED_DRAFT',
        message:
          `${draft.name ?? String(declaration.draft)} is not marked draft: true, so every keystroke is checked against ` +
          'every invariant and a partially filled form will be refused.',
        severity: 'warning',
        path: `${instance}.draft`,
      });
    }
    const entityId = memberEntityId(draft.valueType);
    const entity = entityId ? entityOf(graph, entityId) : undefined;
    if (!entity) {
      return [
        {
          code: 'DRAFT_NOT_AN_ENTITY',
          message: `${draft.name ?? String(declaration.draft)} does not hold an entity instance, so it has no fields to edit.`,
          severity: 'error',
          path: `${instance}.draft`,
        },
      ];
    }
    (declaration.fields ?? []).forEach((fieldId, index) => {
      if (!fieldOf(entity, fieldId)) {
        findings.push({
          code: 'FIELD_NOT_ON_ENTITY',
          message: `${String(fieldId)} is not a field of ${entity.name ?? String(entity.id)}.`,
          severity: 'error',
          path: `${instance}.fields[${index}]`,
        });
      }
    });
    const action = actionOf(graph, declaration.submit);
    if (!action) {
      findings.push({
        code: 'ACTION_NOT_FOUND',
        message: `${String(declaration.submit)} is not an action in this graph.`,
        severity: 'error',
        path: `${instance}.submit`,
      });
    } else {
      const missing = (action.parameters ?? [])
        .filter((parameter) => parameter.required)
        .filter((parameter) => declaration.submitArguments?.[String(parameter.id)] === undefined)
        .map((parameter) => String(parameter.id));
      if (missing.length > 0) {
        findings.push({
          code: 'MISSING_ACTION_ARGUMENT',
          message: `${action.name ?? String(declaration.submit)} requires ${missing.join(', ')}; supply it under submitArguments.`,
          severity: 'error',
          path: `${instance}.submitArguments`,
        });
      }
    }
    return findings;
  },
  expand(declaration, context) {
    const draft = stateOf(context.graph, declaration.draft);
    if (!draft) {
      throw new Error(`entity-form ${declaration.instance}: draft disappeared between check and expansion`);
    }
    const entity = entityOf(context.graph, memberEntityId(draft.valueType) as NodeId);
    if (!entity) {
      throw new Error(`entity-form ${declaration.instance}: entity disappeared between check and expansion`);
    }
    const action = actionOf(context.graph, declaration.submit);

    const mode = declaration.mode ?? 'create';
    const fields = declaration.fields ?? defaultFormFields(entity, mode);
    if (!declaration.fields) {
      context.explain(
        mode === 'create'
          ? `fields inferred from ${entity.name ?? String(entity.id)} in declaration order, identity included because this is a create form`
          : `fields inferred from ${entity.name ?? String(entity.id)} in declaration order, identity ${String(entity.identityFieldId)} omitted because this is an edit form`,
      );
    }

    const children: NodeId[] = [];
    if (declaration.title !== undefined) {
      children.push(
        context.add<TextNode>(
          {
            id: context.id('title'),
            kind: 'text',
            value: declaration.title,
            presentation: { textRole: 'heading', headingLevel: declaration.titleLevel ?? 2 },
          },
          'title',
        ),
      );
    }
    if (declaration.description !== undefined) {
      children.push(
        context.add<TextNode>(
          {
            id: context.id('description'),
            kind: 'text',
            value: declaration.description,
            presentation: { textRole: 'caption', headingLevel: 'none', emphasis: 'subtle' },
          },
          'description',
        ),
      );
    }

    fields.forEach((fieldId, index) => {
      const definition = fieldOf(entity, fieldId);
      const control = definition ? controlFor(definition.valueType) : undefined;
      if (control) {
        context.explain(`${String(fieldId)} uses the ${control} control, from its declared type`);
      }
      children.push(
        context.add<InputNode>(
          {
            id: context.id('input', index),
            kind: 'input',
            // The location is the field of the draft state. `locationRequired` in the IR then
            // marks the control required from the field's own declaration — the author never
            // restates it, and cannot disagree with it.
            binding: { location: fieldLocation(stateLocation(declaration.draft), fieldId) },
            ...(definition && labelFor(definition) ? { label: labelFor(definition) as string } : {}),
            presentation: { ...(control ? { control } : {}) },
          },
          'input',
        ),
      );
    });

    // A refusal has somewhere to appear before anyone asks. Without this the action's guards
    // would be invisible, and an author would be tempted to duplicate them as derived state.
    children.push(
      context.add<DiagnosticNode>(
        {
          id: context.id('diagnostic'),
          kind: 'diagnostic',
          actionId: declaration.submit,
          presentation: { uxRole: 'error-state' },
        },
        'diagnostic',
      ),
    );
    context.explain(`a diagnostic region is generated for ${String(declaration.submit)} so a refusal is presented, not logged`);

    const submitButton = context.add(
      {
        id: context.id('submit'),
        kind: 'button' as const,
        label: declaration.submitLabel ?? action?.name ?? 'Save',
        actionId: declaration.submit,
        ...(declaration.submitArguments ? { arguments: declaration.submitArguments } : {}),
        presentation: { uxRole: 'primary-action' as const },
      },
      'submit',
    );
    const actionChildren = [submitButton, ...context.slot('secondaryActions')];
    children.push(
      context.add<ContainerNode>(
        {
          id: context.id('actions'),
          kind: 'container',
          children: actionChildren,
          presentation: { uxRole: 'action-group', layout: { kind: 'horizontal', gap: 'small', align: 'center' } },
        },
        'actions',
      ),
    );

    return context.add<FormNode>(
      {
        id: context.id('root'),
        kind: 'form',
        target: ref(declaration.draft),
        children,
        // The declared button is the submit control, so its arguments survive submission and
        // presentation inference sees a form with a primary action.
        submitButtonId: submitButton,
        presentation: { uxRole: 'form-section', layout: { kind: 'vertical', gap: 'medium' } },
      },
      'root',
    );
  },
});
