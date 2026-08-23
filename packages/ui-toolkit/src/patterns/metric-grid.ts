import type { ContainerNode, Expression, NodeId, TextNode, ValueFormat } from '@cynodia/axiom-core';
import type { Emphasis } from '@cynodia/axiom-core';
import { definePattern, nameOf } from '../pattern.js';
import type { PatternFinding, PatternText } from '../pattern.js';
import { stateOf } from '../inference.js';

/**
 * Prominent summary values — the row of figures at the top of a dashboard.
 *
 * The caller supplies a label, a value expression and optionally an emphasis. Everything
 * structural is the pattern's: the grid that reflows by available width rather than by
 * breakpoint, the caption-above-figure pairing, the fact that a metric's label is a label and
 * not a heading, and that the figure is drawn at display scale while staying outside the
 * document outline.
 */
export interface MetricDeclaration {
  /**
   * The caption. Absent, and where `value` is a plain reference to a named state, the
   * state's own `name` — because a measure the graph has already named does not need
   * naming twice, and prose duplicated is prose that can disagree.
   */
  label?: PatternText;
  value: Expression;
  format?: ValueFormat;
  emphasis?: Emphasis;
  description?: PatternText;
}

export interface MetricGridDeclaration {
  pattern: 'metric-grid';
  instance: string;
  metrics: MetricDeclaration[];
}

/**
 * The label a metric can be given without the author writing one.
 *
 * Only a plain `ref` to a state qualifies: the state has a name, and that name is the
 * measure. Nothing is guessed from an id or from the shape of a computation — a label
 * invented from an identifier is a guess presented as a fact.
 */
function inferredLabel(
  graph: Parameters<typeof stateOf>[0],
  metric: MetricDeclaration,
): string | undefined {
  return metric.value.kind === 'ref' ? stateOf(graph, metric.value.targetId)?.name : undefined;
}

export const metricGrid = definePattern<MetricGridDeclaration>({
  name: 'metric-grid',
  version: '0.7.0',
  purpose: 'A reflowing grid of prominent summary values.',
  inputs: {
    metrics: {
      kind: 'nodes',
      required: true,
      purpose: 'Each metric: a value expression, and optionally a label, format, emphasis and description.',
      inferredWhenAbsent:
        'A metric label is inferred from the name of the state its value refers to; a label is required only where the value is not a plain state reference.',
    },
  },
  slots: [],
  produces: ['container', 'text'],
  expansion: [
    { part: 'root', kind: 'container', role: 'adaptive grid of metrics' },
    { part: 'metric', kind: 'container', role: 'one raised cell per metric' },
    { part: 'metric-label', kind: 'text', role: 'the caption, a label and not a heading' },
    { part: 'metric-value', kind: 'text', role: 'the figure, display scale, outside the outline' },
    { part: 'metric-description', kind: 'text', role: 'optional caption under the figure' },
  ],
  check(declaration, { graph, instance }) {
    const findings: PatternFinding[] = [];
    declaration.metrics.forEach((metric, index) => {
      if (metric.label === undefined && inferredLabel(graph, metric) === undefined) {
        findings.push({
          code: 'METRIC_LABEL_REQUIRED',
          message:
            'A metric needs a label, and one can only be inferred when its value is a reference to a named state.',
          severity: 'error',
          path: `${instance}.metrics[${index}].label`,
        });
      }
    });
    return findings;
  },
  expand(declaration, context) {
    const cells = declaration.metrics.map((metric, index) => {
      const caption = metric.label ?? (inferredLabel(context.graph, metric) as PatternText);
      if (metric.label === undefined) {
        context.explain(`metric ${index} labelled "${String(caption)}" from the name of the state it reads`);
      }
      const label = context.add<TextNode>(
        {
          id: context.id('label', index),
          kind: 'text',
          value: caption,
          // A metric's caption is a label, never a heading: a dashboard of eight figures
          // would otherwise put eight headings into the document outline.
          presentation: { textRole: 'label', headingLevel: 'none', emphasis: 'subtle' },
        },
        'metric-label',
      );
      const value = context.add<TextNode>(
        {
          id: context.id('value', index),
          kind: 'text',
          value: metric.value,
          presentation: {
            textRole: 'display',
            headingLevel: 'none',
            ...(metric.emphasis ? { emphasis: metric.emphasis } : {}),
            ...(metric.format ? { format: metric.format } : {}),
          },
        },
        'metric-value',
      );
      const children = [label, value];
      if (metric.description !== undefined) {
        children.push(
          context.add<TextNode>(
            {
              id: context.id('description', index),
              kind: 'text',
              value: metric.description,
              presentation: { textRole: 'caption', headingLevel: 'none', emphasis: 'subtle' },
            },
            'metric-description',
          ),
        );
      }
      return context.add<ContainerNode>(
        {
          id: context.id('metric', index),
          kind: 'container',
          ...(nameOf(caption) ? { name: nameOf(caption) as string } : {}),
          children,
          presentation: {
            surface: 'raised',
            padding: 'medium',
            layout: { kind: 'vertical', gap: 'xsmall' },
          },
        },
        'metric',
      );
    });

    context.explain(
      `${cells.length} metrics laid out as an adaptive grid: as many columns of at least medium width as fit`,
    );
    return context.add<ContainerNode>(
      {
        id: context.id('root'),
        kind: 'container',
        children: cells as NodeId[],
        presentation: {
          layout: { kind: 'grid', gap: 'medium', columns: { mode: 'adaptive', minimum: 'narrow' } },
          // Stacking on a compact device is responsive *intent*; what width triggers it is
          // the renderer's business and appears nowhere in the graph.
          responsive: { compact: { layout: { kind: 'vertical', gap: 'small' } } },
        },
      },
      'root',
    );
  },
});
