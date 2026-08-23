import type {
  ButtonNode,
  ContainerNode,
  Expression,
  FieldDisplayNode,
  FieldId,
  NodeId,
  RepeatNode,
  TextNode,
  ValueFormat,
} from '@cynodia/axiom-core';
import { field, ref } from '@cynodia/axiom-core';
import { definePattern } from '../pattern.js';
import type { PatternFinding } from '../pattern.js';
import {
  actionOf,
  defaultListFields,
  entityOf,
  fieldOf,
  formatFor,
  isCollection,
  labelFor,
  memberEntityId,
  roleForAction,
  stateOf,
} from '../inference.js';

/**
 * A list of entity instances — the pattern most applications need most often.
 *
 * Everything below is read from the graph rather than restated by the author: which entity
 * the collection holds, what each field is called, how a value of that type is formatted,
 * which field is the row's identity, and whether an action is destructive. The author says
 * *which* collection and *which* fields matter; the pattern says how a list is built.
 *
 * It deliberately does not infer currency from a field named `price`, or a label from an id.
 * Those are guesses, and a guess that is usually right is worse than an omission, because an
 * agent cannot tell the two apart.
 */
export interface EntityListDeclaration {
  pattern: 'entity-list';
  instance: string;
  /** The collection state to list. */
  source: NodeId;
  /** Fields to show, in order. Absent, every field but the identity. */
  fields?: FieldId[];
  /** Per-field format, where the type cannot say it — currency, percentage. */
  formats?: Record<string, ValueFormat>;
  /** Actions offered on each row. Arguments are supplied per action. */
  rowActions?: NodeId[];
  /** Arguments per row action, evaluated in the row's scope. Use `rowRef` for the member. */
  rowArguments?: Record<string, Record<string, Expression>>;
  /** Caption shown when the collection is empty. */
  emptyMessage?: string;
  /** An action offered *from* the empty state, so it says what to do rather than only that there is nothing. */
  emptyAction?: NodeId;
  emptyActionArguments?: Record<string, Expression>;
  /**
   * Extra content inside each row, after the fields. Semantic nodes or nested patterns.
   *
   * This is also how a requirement the pattern never anticipated is met — a per-row badge, a
   * warning when a value is low — without copying the generated structure or leaving the
   * toolkit. A `conditional` node placed here is ordinary Axiom UI.
   */
  rowExtra?: unknown;
}

/** The expression that names the current row inside a `repeat`: the repeat node's own id. */
export function rowRef(instance: string): Expression {
  return ref(`ui_${instance}_rows`.replace(/[^a-zA-Z0-9_]/g, '_') as NodeId);
}

export function rowField(instance: string, fieldId: FieldId): Expression {
  return field(rowRef(instance), fieldId);
}

export const entityList = definePattern<EntityListDeclaration>({
  name: 'entity-list',
  version: '0.7.0',
  purpose: 'Lists the instances of a collection, one row per member, with optional per-row actions.',
  inputs: {
    source: { kind: 'state', required: true, purpose: 'The collection state to list.' },
    fields: {
      kind: 'field-list',
      required: false,
      purpose: 'Which fields to display, in order.',
      inferredWhenAbsent: 'Every field of the member entity except its identity field.',
    },
    formats: {
      kind: 'nodes',
      required: false,
      purpose: 'Value format per field, where the declared type cannot imply one.',
      inferredWhenAbsent: 'number, boolean, date and datetime from the field’s type; currency and percentage are never guessed.',
    },
    rowActions: { kind: 'action-list', required: false, purpose: 'Actions offered on each row.' },
    rowArguments: { kind: 'nodes', required: false, purpose: 'Arguments per row action, evaluated in the row scope.' },
    emptyMessage: {
      kind: 'text',
      required: false,
      purpose: 'What the empty state says.',
      inferredWhenAbsent: 'An empty state is still generated, with a generic caption.',
    },
    emptyAction: {
      kind: 'action',
      required: false,
      purpose: 'An action offered from the empty state, so it says what to do about it.',
      inferredWhenAbsent: 'The empty state is a caption only, and validateGraph warns that it offers no recovery.',
    },
    emptyActionArguments: { kind: 'nodes', required: false, purpose: 'Arguments for the empty-state action.' },
    rowExtra: { kind: 'slot', required: false, purpose: 'Extra semantic content inside each row.' },

  },
  slots: ['rowExtra'],
  produces: ['container', 'repeat', 'field-display', 'button', 'text'],
  expansion: [
    { part: 'root', kind: 'container', role: 'wraps the list' },
    { part: 'rows', kind: 'repeat', role: 'the repeat; ref this id to address the current row' },
    { part: 'row', kind: 'container', role: 'one row, horizontal when wide and stacked when compact' },
    { part: 'cell', kind: 'field-display', role: 'one per field, in order' },
    { part: 'row-actions', kind: 'container', role: 'action-group at the end of the row' },
    { part: 'row-action', kind: 'button', role: 'one per row action' },
    { part: 'empty-state', kind: 'container', role: 'shown when the collection is empty' },
    { part: 'empty-caption', kind: 'text', role: 'what the empty state says' },
    { part: 'empty-action', kind: 'button', role: 'the recovery action, when one is given' },
  ],
  check(declaration, { graph, instance }) {
    const findings: PatternFinding[] = [];
    const state = stateOf(graph, declaration.source);
    if (!state) {
      return [
        {
          code: 'SOURCE_NOT_A_STATE',
          message: `${String(declaration.source)} is not a state in this graph.`,
          severity: 'error',
          path: `${instance}.source`,
        },
      ];
    }
    if (!isCollection(state.valueType)) {
      return [
        {
          code: 'SOURCE_NOT_A_COLLECTION',
          message: `${state.name ?? String(declaration.source)} is not a collection, so it has no rows to list.`,
          severity: 'error',
          path: `${instance}.source`,
        },
      ];
    }
    const entityId = memberEntityId(state.valueType);
    const entity = entityId ? entityOf(graph, entityId) : undefined;
    if (!entity) {
      return [
        {
          code: 'SOURCE_NOT_ENTITIES',
          message: `${state.name ?? String(declaration.source)} holds primitives, not entity instances, so it has no fields to show.`,
          severity: 'error',
          path: `${instance}.source`,
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
    if (!entity.identityFieldId && (declaration.rowActions ?? []).length > 0) {
      findings.push({
        code: 'NO_IDENTITY_FIELD',
        message:
          `${entity.name ?? String(entity.id)} declares no identityFieldId, so a row action cannot address the row it belongs to.`,
        severity: 'warning',
        path: `${instance}.rowActions`,
      });
    }
    return findings;
  },
  expand(declaration, context) {
    const state = stateOf(context.graph, declaration.source);
    if (!state) {
      throw new Error(`entity-list ${declaration.instance}: source disappeared between check and expansion`);
    }
    const entity = entityOf(context.graph, memberEntityId(state.valueType) as NodeId);
    if (!entity) {
      throw new Error(`entity-list ${declaration.instance}: member entity disappeared between check and expansion`);
    }

    const fields = declaration.fields ?? defaultListFields(entity);
    if (!declaration.fields) {
      context.explain(
        `fields inferred from ${entity.name ?? String(entity.id)}: every field except the identity field ${String(entity.identityFieldId)}`,
      );
    }

    // The repeat binds the current member to its own id, so a cell reads
    // `field(ref(<repeat id>), <field id>)`. The id is derived from the instance, which is
    // what lets `rowRef(instance)` be written by a caller before expansion has happened.
    const rowsId = context.id('rows');

    const cells = fields.map((fieldId, index) => {
      const definition = fieldOf(entity, fieldId);
      const format = declaration.formats?.[String(fieldId)] ?? (definition ? formatFor(definition.valueType) : undefined);
      if (!declaration.formats?.[String(fieldId)] && format) {
        context.explain(`${String(fieldId)} formatted as ${format.kind}, from its declared type`);
      }
      const label = definition ? labelFor(definition) : undefined;
      return context.add<FieldDisplayNode>(
        {
          id: context.id('cell', index),
          kind: 'field-display',
          source: ref(rowsId),
          fieldId,
          ...(label ? { label } : {}),
          presentation: { ...(format ? { format } : {}) },
        },
        'cell',
      );
    });

    const rowChildren = [...cells, ...context.slot('rowExtra')];

    const rowActions = (declaration.rowActions ?? []).map((actionId, index) => {
      const action = actionOf(context.graph, actionId);
      const uxRole = action ? roleForAction(action, index === 0 && !action.destructive) : 'secondary-action';
      if (action?.destructive) {
        context.explain(`${String(actionId)} placed in row actions as destructive because the action declares it`);
      }
      return context.add<ButtonNode>(
        {
          id: context.id('row_action', index),
          kind: 'button',
          label: action?.name ?? String(actionId),
          actionId,
          ...(declaration.rowArguments?.[String(actionId)]
            ? { arguments: declaration.rowArguments[String(actionId)] }
            : {}),
          presentation: { uxRole },
        },
        'row-action',
      );
    });
    if (rowActions.length > 0) {
      rowChildren.push(
        context.add<ContainerNode>(
          {
            id: context.id('row_actions'),
            kind: 'container',
            children: rowActions,
            presentation: { uxRole: 'action-group', layout: { kind: 'horizontal', gap: 'small', align: 'center' } },
          },
          'row-actions',
        ),
      );
    }

    const row = context.add<ContainerNode>(
      {
        id: context.id('row'),
        kind: 'container',
        children: rowChildren,
        presentation: {
          surface: 'base',
          padding: { horizontal: 'medium', vertical: 'small' },
          // Wide: a row reads across, table-like. Compact: it stacks into a record. Both are
          // stated as intent; neither names a width.
          layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between' },
          responsive: { compact: { layout: { kind: 'vertical', gap: 'xsmall' }, } },
        },
      },
      'row',
    );

    const emptyCaption = context.add<TextNode>(
      {
        id: context.id('empty_caption'),
        kind: 'text',
        value: declaration.emptyMessage ?? `No ${entity.name ?? 'records'} yet.`,
        presentation: { textRole: 'body', headingLevel: 'none', emphasis: 'subtle' },
      },
      'empty-caption',
    );
    const emptyChildren = [emptyCaption];
    if (declaration.emptyAction !== undefined) {
      const recovery = actionOf(context.graph, declaration.emptyAction);
      emptyChildren.push(
        context.add<ButtonNode>(
          {
            id: context.id('empty_action'),
            kind: 'button',
            label: recovery?.name ?? String(declaration.emptyAction),
            actionId: declaration.emptyAction,
            ...(declaration.emptyActionArguments ? { arguments: declaration.emptyActionArguments } : {}),
            presentation: { uxRole: 'primary-action' },
          },
          'empty-action',
        ),
      );
      context.explain('the empty state offers a recovery action, so it says what to do and not only that there is nothing');
    }
    // The empty state is a container even when it holds only a caption, so adding a recovery
    // action later changes a declaration rather than the shape of the generated tree.
    const empty = context.add<ContainerNode>(
      {
        id: context.id('empty'),
        kind: 'container',
        children: emptyChildren,
        presentation: {
          uxRole: 'empty-state',
          padding: 'medium',
          layout: { kind: 'vertical', gap: 'small', align: 'start' },
        },
      },
      'empty-state',
    );
    context.explain('an empty state is always generated: a collection may be empty and a blank region explains nothing');

    const repeat = context.add<RepeatNode>(
      {
        id: rowsId,
        kind: 'repeat',
        // A collection state is never null in a validated graph, but a derived one can be;
        // the coalesce is what keeps a legitimately absent collection from failing the render.
        source: ref(declaration.source),
        templateId: row,
        emptyTemplateId: empty,
        presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
      },
      'rows',
    );

    return context.add<ContainerNode>(
      {
        id: context.id('root'),
        kind: 'container',
        name: state.name,
        children: [repeat],
        presentation: { layout: { kind: 'vertical', gap: 'small' } },
      },
      'root',
    );
  },
});
