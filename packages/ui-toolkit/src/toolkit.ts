import { createToolkit } from './expand.js';
import type { PatternDefinition } from './pattern.js';
import { page } from './patterns/page.js';
import { metricGrid } from './patterns/metric-grid.js';
import { entityList } from './patterns/entity-list.js';
import { entityForm } from './patterns/entity-form.js';
import { actionBar } from './patterns/action-bar.js';

/**
 * The prototype toolkit: five patterns, deliberately.
 *
 * Adding a sixth because it would be convenient is how a pattern layer becomes a component
 * catalogue, which is the outcome this research exists to avoid.
 */
export const axiomUi = createToolkit([
  page,
  metricGrid,
  entityList,
  entityForm,
  actionBar,
] as unknown as PatternDefinition<never>[]);
