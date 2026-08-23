import type {
  ContainerNode,
  DiagnosticNode,
  EntityDef,
  Expression,
  FieldId,
  FormNode,
  InputNode,
  InputOptionsSource,
  Location,
  NodeId,
  StateDef,
  TextNode,
} from '@cynodia/axiom-core';
import {
  binary,
  field,
  fieldLocation,
  find,
  identitySelector,
  itemLocation,
  nodeId,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import { definePattern, nameOf } from '../pattern.js';
import type { PatternFinding, PatternText } from '../pattern.js';
import {
  actionOf,
  controlFor,
  defaultFormFields,
  entityOf,
  fieldOf,
  isCollection,
  labelFor,
  memberEntityId,
  stateOf,
} from '../inference.js';

/**
 * A form over a record, and the pattern where inference earns the most.
 *
 * From `EntityDef` and `FieldDef` alone the toolkit knows every field's label, its control,
 * whether it is required, and what order the entity declares them in. From the submit action
 * it knows what the form commits. The author restates none of it — and cannot contradict it,
 * which is the more important property.
 *
 * It covers both halves of the CRUD it is named after, and the two are different semantics
 * rather than a flag:
 *
 * | | writes to | governed |
 * | --- | --- | --- |
 * | `draft: S` | a field of a draft state | not per keystroke — a new record is incomplete until it is committed |
 * | `target: { state, identity }` | that field of the addressed member | per keystroke, against every hard invariant |
 *
 * Which one an application uses is visible in the graph: look at what the input's location is
 * rooted in. The pattern never chooses for the author, because the choice changes what is
 * enforced and when.
 */
/**
 * The existing record an edit form addresses.
 *
 * The capability Phase 2 found missing was **addressing a collection member by expression**:
 * an edit form needs to say "the product whose code is the one in the route", and no pattern
 * input could. This is that, declared semantically — a state and an identity expression —
 * rather than as application-specific JavaScript that builds the location by hand.
 *
 * The identity field is the entity's own `identityFieldId`; nothing else can address an
 * instance, so nothing else is asked for.
 */
export interface EntityFormTarget {
  /** The collection state holding the record. */
  state: NodeId;
  /** Which member: an expression, usually `ref(routeParameter)`. */
  identity: Expression;
}

export interface EntityFormDeclaration {
  pattern: 'entity-form';
  instance: string;
  /**
   * Create mode: the draft state the controls write into.
   *
   * Exactly one of `draft` and `target` is given. That is what makes the mode unambiguous
   * without a flag to forget.
   */
  draft?: NodeId;
  /**
   * Edit mode: the existing collection member the controls write into.
   *
   * Writes go straight into canonical state, so each one is transactional against every
   * hard invariant — a value that would break one is rolled back and the control re-renders
   * with what is actually stored. That is the semantics an edit form wants; a create form
   * wants a draft, because a half-filled new record is incomplete by definition.
   */
  target?: EntityFormTarget;
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
  /**
   * A choice drawn from application data, per field id — the canonical
   * `InputOptionsSource`. This is how a field that identifies another record is entered: a
   * product picker, a category, a customer.
   *
   * Phase 2 had to hand-build a form for exactly this, because no pattern input could
   * carry it.
   */
  options?: Record<string, InputOptionsSource>;
  /** Fields to edit, in order. Absent, every field but the identity. */
  fields?: FieldId[];
  /** The action the form submits. */
  submit: NodeId;
  /** Arguments for the submit action, keyed by action parameter id. */
  submitArguments?: Record<string, Expression>;
  submitLabel?: PatternText;
  title?: PatternText;
  /** The title's outline level. Default 2, which is the level below a page title. */
  titleLevel?: 2 | 3 | 4 | 5 | 6;
  description?: PatternText;
  /** Extra controls beside the submit button — cancel, reset, a destructive action. */
  secondaryActions?: unknown;
}

/**
 * Where one control writes.
 *
 * Create: a field of the draft state. Edit: the same field of the addressed member, which is
 * an ordinary `Location` — the mutation engine, the transaction and every invariant apply to
 * it exactly as they would to a location an author wrote by hand.
 */
function fieldTarget(
  declaration: EntityFormDeclaration,
  entity: EntityDef,
  fieldId: FieldId,
): Location {
  if (!declaration.target) {
    return fieldLocation(stateLocation(declaration.draft as NodeId), fieldId);
  }
  return fieldLocation(
    itemLocation(
      stateLocation(declaration.target.state),
      identitySelector(entity.identityFieldId as FieldId, declaration.target.identity),
    ),
    fieldId,
  );
}

/** The record the form is about, as an expression. Never used to decide where a control writes. */
function recordExpression(declaration: EntityFormDeclaration, entity: EntityDef): Expression {
  if (!declaration.target) {
    return ref(declaration.draft as NodeId);
  }
  // A scope of the pattern's own, derived from the instance so it is deterministic and
  // cannot collide with a caller's: nothing else names a scope this way.
  const scope = nodeId(`scope_${declaration.instance}_record`.replace(/[^a-zA-Z0-9_]/g, '_'));
  return find(
    ref(declaration.target.state),
    scope,
    binary('eq', field(ref(scope), entity.identityFieldId as FieldId), declaration.target.identity),
  );
}

export const entityForm = definePattern<EntityFormDeclaration>({
  name: 'entity-form',
  version: '0.7.0',
  purpose:
    'A form that creates a record in a draft state or edits an existing one addressed by expression, with labels, controls, required markers and a submit action inferred from the graph.',
  inputs: {
    draft: {
      kind: 'state',
      required: false,
      purpose:
        'Create mode: the draft state the controls write into. Its entity supplies every field’s label, control and required status.',
      inferredWhenAbsent: 'Required unless `target` is given; exactly one of the two is.',
    },
    target: {
      kind: 'nodes',
      required: false,
      purpose:
        'Edit mode: { state, identity } addressing an existing collection member — identity is an expression, usually a route parameter.',
      inferredWhenAbsent: 'Required unless `draft` is given; exactly one of the two is.',
    },
    options: {
      kind: 'nodes',
      required: false,
      purpose:
        'A canonical InputOptionsSource per field id, for a field whose value identifies another record.',
      inferredWhenAbsent: 'A field with no options source uses the control its declared type implies.',
    },
    submit: { kind: 'action', required: true, purpose: 'The action the form submits.' },
    mode: {
      kind: 'token',
      required: false,
      purpose: '"create" offers the identity field; "edit" omits it, because an identity is not editable.',
      inferredWhenAbsent:
        'edit when `target` is given, create when `draft` is. Declaring it is only needed to edit through a draft state.',
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
    {
      part: 'root',
      kind: 'form',
      role: 'the form; submitButtonId is the generated submit, and target reads the record being edited',
    },
    { part: 'title', kind: 'text', role: 'optional heading, level 2' },
    { part: 'description', kind: 'text', role: 'optional caption' },
    {
      part: 'input',
      kind: 'input',
      role: 'one per field, in entity declaration order; bound to the draft field or to the addressed member’s field',
    },
    { part: 'diagnostic', kind: 'diagnostic', role: 'where a refusal of the submit action appears' },
    { part: 'actions', kind: 'container', role: 'action-group holding submit and the secondaryActions slot' },
    { part: 'submit', kind: 'button', role: 'the primary action' },
  ],
  check(declaration, { graph, instance }) {
    const findings: PatternFinding[] = [];
    if ((declaration.draft === undefined) === (declaration.target === undefined)) {
      // Neither, or both. Either way the mode would have to be guessed, and a create form
      // that quietly omits identity semantics is the failure this refuses to allow.
      return [
        {
          code: 'FORM_TARGET_AMBIGUOUS',
          message:
            declaration.draft === undefined
              ? 'A form needs either draft (to create) or target (to edit an existing record).'
              : 'A form declares both draft and target; it writes to one place, so give one.',
          severity: 'error',
          path: `${instance}.${declaration.draft === undefined ? 'draft' : 'target'}`,
        },
      ];
    }
    if (declaration.target && declaration.mode === 'create') {
      findings.push({
        code: 'MODE_CONTRADICTS_TARGET',
        message: 'A form with a target edits an existing record; it cannot be a create form.',
        severity: 'error',
        path: `${instance}.mode`,
      });
    }

    const written = declaration.target ? declaration.target.state : (declaration.draft as NodeId);
    const draft = stateOf(graph, written);
    if (!draft) {
      return [
        {
          code: declaration.target ? 'TARGET_NOT_A_STATE' : 'DRAFT_NOT_A_STATE',
          message: `${String(written)} is not a state in this graph.`,
          severity: 'error',
          path: `${instance}.${declaration.target ? 'target.state' : 'draft'}`,
        },
      ];
    }
    if (declaration.target && !isCollection(draft.valueType)) {
      return [
        {
          code: 'TARGET_NOT_A_COLLECTION',
          message: `${draft.name ?? String(written)} is not a collection, so it has no member to address by identity.`,
          severity: 'error',
          path: `${instance}.target.state`,
        },
      ];
    }
    if (draft.derivation) {
      return [
        {
          code: 'DRAFT_IS_DERIVED',
          message: `${draft.name ?? String(written)} is derived and therefore read-only; a form cannot write to it.`,
          severity: 'error',
          path: `${instance}.${declaration.target ? 'target.state' : 'draft'}`,
        },
      ];
    }
    if (draft.authority === 'server') {
      return [
        {
          code: 'DRAFT_IS_SERVER_OWNED',
          message:
            `${draft.name ?? String(written)} is server-authoritative, so a control may not write it. ` +
            'Bind the form to a draft state and let the submit action commit it.',
          severity: 'error',
          path: `${instance}.${declaration.target ? 'target.state' : 'draft'}`,
        },
      ];
    }
    // An edit form writes canonical state on purpose; only a *create* form staged in
    // unmarked state would be checked against every invariant on every keystroke.
    if (!declaration.target && !draft.draft) {
      findings.push({
        code: 'STATE_NOT_MARKED_DRAFT',
        message:
          `${draft.name ?? String(written)} is not marked draft: true, so every keystroke is checked against ` +
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
          message: `${draft.name ?? String(written)} does not hold an entity instance, so it has no fields to edit.`,
          severity: 'error',
          path: `${instance}.${declaration.target ? 'target.state' : 'draft'}`,
        },
      ];
    }
    if (declaration.target && !entity.identityFieldId) {
      findings.push({
        code: 'NO_IDENTITY_FIELD',
        message:
          `${entity.name ?? String(entity.id)} declares no identityFieldId, so no expression can address one of its ` +
          'instances. Declare one, or bind the form to a draft and commit it with an action.',
        severity: 'error',
        path: `${instance}.target.identity`,
      });
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
    for (const key of Object.keys(declaration.options ?? {})) {
      if (!fieldOf(entity, key as FieldId)) {
        findings.push({
          code: 'FIELD_NOT_ON_ENTITY',
          message: `${key} is not a field of ${entity.name ?? String(entity.id)}, so it cannot take an options source.`,
          severity: 'error',
          path: `${instance}.options.${key}`,
        });
      }
    }
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
    const written = declaration.target ? declaration.target.state : (declaration.draft as NodeId);
    const state = stateOf(context.graph, written);
    if (!state) {
      throw new Error(`entity-form ${declaration.instance}: ${String(written)} disappeared between check and expansion`);
    }
    const entity = entityOf(context.graph, memberEntityId(state.valueType) as NodeId);
    if (!entity) {
      throw new Error(`entity-form ${declaration.instance}: entity disappeared between check and expansion`);
    }
    const action = actionOf(context.graph, declaration.submit);

    // The mode is not a flag an author has to remember: a target is an existing record and a
    // draft is a new one. `mode` only remains meaningful for editing *through* a draft.
    const mode = declaration.target ? 'edit' : (declaration.mode ?? 'create');
    if (declaration.target) {
      context.explain(
        `edit mode: every control writes into ${state.name ?? String(written)}, addressed by ${String(entity.identityFieldId)}`,
      );
    }
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
      const options = declaration.options?.[String(fieldId)];
      // An options source decides the control: a value drawn from application data is a
      // choice, whatever the primitive type underneath it is.
      const control = options ? 'select' : definition ? controlFor(definition.valueType) : undefined;
      if (options) {
        context.explain(`${String(fieldId)} offers a choice drawn from application data`);
      } else if (control) {
        context.explain(`${String(fieldId)} uses the ${control} control, from its declared type`);
      }
      children.push(
        context.add<InputNode>(
          {
            id: context.id('input', index),
            kind: 'input',
            // The location is the field of whatever the form writes: a draft state, or the
            // addressed member of a collection. `locationRequired` in the IR then marks the
            // control required from the field's own declaration — the author never restates
            // it, and cannot disagree with it.
            binding: { location: fieldTarget(declaration, entity, fieldId) },
            ...(definition && labelFor(definition) ? { label: labelFor(definition) as string } : {}),
            ...(options ? { options } : {}),
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
        // What the form is *about*, which is a read: an edit form is about the record it
        // addresses, a create form about the draft being filled in.
        target: recordExpression(declaration, entity),
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
