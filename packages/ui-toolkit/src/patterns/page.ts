import type { ContainerNode, NodeId, TextNode } from '@cynodia/axiom-core';
import { definePattern } from '../pattern.js';

/**
 * A conventional application page: a header region carrying the title, description and the
 * page-level actions, then a content region.
 *
 * What the caller does not write: the header container, the content container, the heading
 * level, the landmark roles, the spacing between regions, or the decision that the page
 * title is the document's level-1 heading. Those are the same on every page of every
 * application, which is exactly what makes them the pattern's business rather than the
 * author's.
 */
export interface PageDeclaration {
  pattern: 'page';
  instance: string;
  title: string;
  description?: string;
  /** Placed in the header, to the trailing side of the title. */
  actions?: unknown;
  /** The page body, in order. */
  content?: unknown;
}

export const page = definePattern<PageDeclaration>({
  name: 'page',
  version: '0.2.0',
  purpose: 'A titled application page with a header region, page-level actions and a content region.',
  inputs: {
    title: { kind: 'text', required: true, purpose: 'The page heading, and the document’s level-1 heading.' },
    description: { kind: 'text', required: false, purpose: 'A caption under the title.' },
    actions: {
      kind: 'slot',
      required: false,
      purpose: 'Page-level controls, placed in the header.',
      inferredWhenAbsent: 'No action group is generated.',
    },
    content: { kind: 'slot', required: false, purpose: 'The page body, in the order given.' },
  },
  slots: ['actions', 'content'],
  produces: ['container', 'text'],
  expansion: [
    { part: 'root', kind: 'container', role: 'the page, padded and vertical' },
    { part: 'header', kind: 'container', role: 'header-region landmark' },
    { part: 'title-block', kind: 'container', role: 'title and description' },
    { part: 'title', kind: 'text', role: 'the h1' },
    { part: 'description', kind: 'text', role: 'caption under the title' },
    { part: 'actions', kind: 'container', role: 'action-group beside the title, from the actions slot' },
    { part: 'content', kind: 'container', role: 'content-region landmark, holding the content slot' },
  ],
  expand(declaration, context) {
    const children: NodeId[] = [];

    const heading = context.add<TextNode>(
      {
        id: context.id('title'),
        kind: 'text',
        value: declaration.title,
        // `title` is the type scale; level 1 is the document outline. They are separate
        // decisions and the pattern makes both, because a page has exactly one of each.
        presentation: { textRole: 'title', headingLevel: 1 },
      },
      'title',
    );
    const headerChildren: NodeId[] = [heading];
    context.explain('page title rendered at text role "title" and heading level 1');

    if (declaration.description !== undefined) {
      headerChildren.push(
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

    // The title and description are one block so the action group sits beside the pair
    // rather than beside the title alone.
    const titleBlock = context.add<ContainerNode>(
      {
        id: context.id('title_block'),
        kind: 'container',
        children: headerChildren,
        presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
      },
      'title-block',
    );

    const actions = context.slot('actions');
    const headerBlocks: NodeId[] = [titleBlock];
    if (actions.length > 0) {
      headerBlocks.push(
        context.add<ContainerNode>(
          {
            id: context.id('actions'),
            kind: 'container',
            children: actions,
            presentation: { uxRole: 'action-group', layout: { kind: 'horizontal', gap: 'small', align: 'center' } },
          },
          'actions',
        ),
      );
      context.explain('page actions grouped in an action-group beside the title');
    }

    children.push(
      context.add<ContainerNode>(
        {
          id: context.id('header'),
          kind: 'container',
          children: headerBlocks,
          presentation: {
            uxRole: 'header-region',
            layout: { kind: 'horizontal', justify: 'between', align: 'center', gap: 'medium', wrap: true },
            // A header that cannot fit its actions beside the title stacks them rather than
            // truncating either. Intent, not a breakpoint.
            responsive: { compact: { layout: { kind: 'vertical', gap: 'small' }, } },
          },
        },
        'header',
      ),
    );

    const content = context.slot('content');
    if (content.length > 0) {
      children.push(
        context.add<ContainerNode>(
          {
            id: context.id('content'),
            kind: 'container',
            children: content,
            presentation: { uxRole: 'content-region', layout: { kind: 'vertical', gap: 'large' } },
          },
          'content',
        ),
      );
    }

    return context.add<ContainerNode>(
      {
        id: context.id('root'),
        kind: 'container',
        name: declaration.title,
        children,
        presentation: { layout: { kind: 'vertical', gap: 'large' }, padding: 'large' },
      },
      'root',
    );
  },
});
