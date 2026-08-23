import type { ActionDef, ButtonNode, ContainerNode, Expression, NodeId } from '@cynodia/axiom-core';
import { definePattern } from '../pattern.js';
import { actionOf, roleForAction } from '../inference.js';
import type { PatternFinding } from '../pattern.js';

/**
 * A group of controls bound to actions, with emphasis taken from what the actions *are*.
 *
 * The caller lists action ids and nothing else. Which button is primary comes from position
 * — the first non-destructive action — and which is destructive comes from the action's own
 * `destructive` flag, already in the graph. An author who had to write
 * `variant: 'danger'` beside an action already marked destructive would be restating a fact
 * Axiom holds, and could contradict it.
 */
export interface ActionBarDeclaration {
  pattern: 'action-bar';
  instance: string;
  actions: NodeId[];
  /** Arguments per action id, keyed by action parameter id. */
  arguments?: Record<string, Record<string, Expression>>;
  /** Labels per action id. Absent, the action's own `name` is used. */
  labels?: Record<string, string>;
  /** Which action is the primary one. Absent, the first non-destructive action is. */
  primary?: NodeId;
  alignment?: 'start' | 'end';
}

export const actionBar = definePattern<ActionBarDeclaration>({
  name: 'action-bar',
  version: '0.2.0',
  purpose: 'A row of action controls whose emphasis is inferred from the actions themselves.',
  inputs: {
    actions: { kind: 'action-list', required: true, purpose: 'The actions to expose, in order.' },
    primary: {
      kind: 'action',
      required: false,
      purpose: 'Which action is the primary one.',
      inferredWhenAbsent: 'The first action that is not destructive.',
    },
    labels: { kind: 'text', required: false, purpose: 'Override a control’s label.', inferredWhenAbsent: 'The action’s own name.' },
    arguments: { kind: 'nodes', required: false, purpose: 'Arguments per action, keyed by action parameter id.' },
    alignment: { kind: 'token', required: false, purpose: 'Where the group sits along its axis.', inferredWhenAbsent: 'start' },
  },
  slots: [],
  produces: ['container', 'button'],
  expansion: [
    { part: 'root', kind: 'container', role: 'the action-group' },
    { part: 'button', kind: 'button', role: 'one per action, emphasis from the action' },
  ],
  check(declaration, { graph, instance }) {
    const findings: PatternFinding[] = [];
    declaration.actions.forEach((actionId, index) => {
      const action = actionOf(graph, actionId);
      if (!action) {
        findings.push({
          code: 'ACTION_NOT_FOUND',
          message: `${String(actionId)} is not an action in this graph.`,
          severity: 'error',
          path: `${instance}.actions[${index}]`,
        });
        return;
      }
      // A control that cannot supply a required parameter would be rejected by
      // validateGraph later; saying so here points at the declaration instead.
      const missing = (action.parameters ?? [])
        .filter((parameter) => parameter.required)
        .filter((parameter) => declaration.arguments?.[String(actionId)]?.[String(parameter.id)] === undefined)
        .map((parameter) => String(parameter.id));
      if (missing.length > 0) {
        findings.push({
          code: 'MISSING_ACTION_ARGUMENT',
          message: `${action.name ?? String(actionId)} requires ${missing.join(', ')}; supply it under arguments.${String(actionId)}.`,
          severity: 'error',
          path: `${instance}.actions[${index}]`,
        });
      }
    });
    return findings;
  },
  expand(declaration, context) {
    const resolved = declaration.actions
      .map((actionId) => ({ actionId, action: actionOf(context.graph, actionId) as ActionDef }))
      .filter((entry) => entry.action !== undefined);

    const primary =
      declaration.primary ?? resolved.find((entry) => !entry.action.destructive)?.actionId;
    if (declaration.primary === undefined && primary !== undefined) {
      context.explain(`primary action inferred as ${String(primary)}: the first action that is not destructive`);
    }

    const buttons = resolved.map((entry, index) => {
      const uxRole = roleForAction(entry.action, entry.actionId === primary);
      if (entry.action.destructive) {
        context.explain(`${String(entry.actionId)} presented as destructive because the action declares it`);
      }
      const args = declaration.arguments?.[String(entry.actionId)];
      return context.add<ButtonNode>(
        {
          id: context.id('button', index),
          kind: 'button',
          label: declaration.labels?.[String(entry.actionId)] ?? entry.action.name ?? String(entry.actionId),
          actionId: entry.actionId,
          ...(args ? { arguments: args } : {}),
          presentation: { uxRole },
        },
        'button',
      );
    });

    return context.add<ContainerNode>(
      {
        id: context.id('root'),
        kind: 'container',
        children: buttons,
        presentation: {
          uxRole: 'action-group',
          layout: {
            kind: 'horizontal',
            gap: 'small',
            align: 'center',
            justify: declaration.alignment === 'end' ? 'end' : 'start',
            wrap: true,
          },
        },
      },
      'root',
    );
  },
});
