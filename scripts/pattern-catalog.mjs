import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './packages.mjs';

/**
 * Generates PATTERN_CATALOG.json from the pattern definitions themselves.
 *
 * The catalogue is the toolkit's primary agent-facing interface, so it must not be a document
 * someone maintains beside the code — it is generated from the same `inputs`, `slots` and
 * `produces` the expander reads, and cannot describe a pattern that does not exist or miss an
 * input that does.
 */
const toolkit = await import(path.join(repoRoot, 'packages/ui-toolkit/dist/index.js'));
const { axiomUi, describeToolkit, TOOLKIT_NAME, TOOLKIT_VERSION } = toolkit;

const catalog = {
  catalog: 'axiom.ui.catalog.v1',
  toolkit: TOOLKIT_NAME,
  version: TOOLKIT_VERSION,
  description:
    'Semantic UI patterns for Axiom. A pattern is not a component: it expands, at authoring ' +
    'time, into ordinary Axiom UI nodes and has no runtime existence. Declare the UX concept; ' +
    'the expansion is explicit, inspectable application semantics.',
  ownership: {
    default: 'declaration',
    values: {
      declaration: 'The pattern declaration is the source of truth. Re-expansion is authoritative and editing a generated node is drift.',
      graph: 'The expanded graph is the source of truth. The declaration is history and edits are legitimate.',
    },
  },
  patterns: describeToolkit(axiomUi),
};

writeFileSync(
  path.join(repoRoot, 'packages/ui-toolkit/docs/PATTERN_CATALOG.json'),
  `${JSON.stringify(catalog, null, 2)}\n`,
);
console.log(`Wrote PATTERN_CATALOG.json with ${catalog.patterns.length} patterns.`);
