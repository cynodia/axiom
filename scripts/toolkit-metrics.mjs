import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './packages.mjs';

/**
 * Measures the two research applications.
 *
 * Everything here counts **authoring**: what a person or an agent had to write. Generated
 * output is counted separately and deliberately is not the target — a pattern layer is
 * supposed to leave the canonical graph roughly as large as it was, and compress the
 * declaration of it.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const research = await import(path.join(repoRoot, 'packages/ui-toolkit/dist/example/index.js'));
const { createBaselineApplication } = await import(
  path.join(repoRoot, 'packages/ui-toolkit/dist-test/baseline.js')
);

/**
 * The two applications are measured from source.
 *
 * The pattern-built one **ships** — it is the reference application, under
 * `@cynodia/axiom-ui/example`. The hand-built baseline exists only to be measured against,
 * so it lives with the tests and is never published.
 */
const file = (name) =>
  readFileSync(
    path.join(repoRoot, name === 'baseline.ts' ? 'packages/ui-toolkit/test' : 'packages/ui-toolkit/src/example', name),
    'utf8',
  );

/** Lines that carry authoring, excluding blanks, comments and import bookkeeping. */
function authoringLines(source, { from, to }) {
  const lines = source.split('\n');
  const start = from ? lines.findIndex((line) => line.includes(from)) + 1 : 0;
  const end = to ? lines.findIndex((line) => line.includes(to)) : lines.length;
  return lines
    .slice(start, end)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

const baselineSource = file('baseline.ts');
const toolkitSource = file('app.ts');

// The shell — navigation and view/route wiring — is byte-identical in both applications and
// is not what a pattern layer addresses. It is reported, then excluded from the comparison.
const baselineUi = authoringLines(baselineSource, { from: 'readme-baseline:start', to: 'readme-baseline:end' });
const toolkitUi = authoringLines(toolkitSource, { from: 'readme-toolkit:start', to: 'readme-toolkit:end' });

const metrics = {
  baseline: {
    authoringLines: baselineUi.length,
    explicitIds: count(baselineSource, /\bnodeId\('ui_/g),
    nodeConstructionCalls: count(baselineSource, /graph\.addNode</g),
    presentationDeclarations: count(baselineSource, /presentation: \{/g),
    manualContainers: count(baselineSource, /kind: 'container'/g),
    patternInstances: 0,
  },
  toolkit: {
    authoringLines: toolkitUi.length,
    explicitIds: count(toolkitSource.split('readme-toolkit:start')[1].split('readme-toolkit:end')[0], /\bnodeId\(/g),
    nodeConstructionCalls: 0,
    presentationDeclarations: count(toolkitSource.split('readme-toolkit:start')[1].split('readme-toolkit:end')[0], /presentation: \{/g),
    manualContainers: 0,
    patternInstances: count(toolkitSource.split('readme-toolkit:start')[1].split('readme-toolkit:end')[0], /pattern: '/g),
  },
};

for (const [name, build] of [['baseline', createBaselineApplication], ['toolkit', research.createToolkitApplication]]) {
  const graph = build();
  const validation = core.validateGraph(graph);
  const nodes = graph.listNodes();
  metrics[name].canonicalNodes = nodes.length;
  metrics[name].canonicalUiNodes = nodes.filter((node) =>
    ['view', 'container', 'text', 'repeat', 'field-display', 'form', 'input', 'button', 'conditional', 'diagnostic'].includes(node.kind),
  ).length;
  metrics[name].validationErrors = validation.errors.length;
  metrics[name].validationWarnings = validation.warnings.length;
}

// The toolkit's own size. It is framework code, amortized across every application that
// uses it — but a reduction reported without it is a reduction that hid its cost somewhere.
import { readdirSync, statSync } from 'node:fs';
function treeLines(directory) {
  let total = 0;
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      total += treeLines(full);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    total += authoringLines(readFileSync(full, 'utf8'), {}).length;
  }
  return total;
}
metrics.toolkitImplementationLines = treeLines(path.join(repoRoot, 'packages/ui-toolkit/src'))
  - treeLines(path.join(repoRoot, 'packages/ui-toolkit/src/example'));

const reduction = (from, to) => (from === 0 ? 0 : Math.round(((from - to) / from) * 1000) / 10);

const summary = {
  authoringLines: reduction(metrics.baseline.authoringLines, metrics.toolkit.authoringLines),
  explicitIds: reduction(metrics.baseline.explicitIds, metrics.toolkit.explicitIds),
  constructionCalls: reduction(metrics.baseline.nodeConstructionCalls, metrics.toolkit.patternInstances),
  presentationDeclarations: reduction(
    metrics.baseline.presentationDeclarations,
    metrics.toolkit.presentationDeclarations,
  ),
};

const rows = [
  ['UI authoring lines', metrics.baseline.authoringLines, metrics.toolkit.authoringLines, `${summary.authoringLines}%`],
  ['Explicit node ids', metrics.baseline.explicitIds, metrics.toolkit.explicitIds, `${summary.explicitIds}%`],
  [
    'Node constructions / pattern instances',
    metrics.baseline.nodeConstructionCalls,
    metrics.toolkit.patternInstances,
    `${summary.constructionCalls}%`,
  ],
  [
    'Presentation declarations',
    metrics.baseline.presentationDeclarations,
    metrics.toolkit.presentationDeclarations,
    `${summary.presentationDeclarations}%`,
  ],
  ['Manual containers', metrics.baseline.manualContainers, metrics.toolkit.manualContainers, '—'],
  ['Canonical nodes produced', metrics.baseline.canonicalNodes, metrics.toolkit.canonicalNodes, 'not a target'],
  ['Canonical UI nodes', metrics.baseline.canonicalUiNodes, metrics.toolkit.canonicalUiNodes, 'not a target'],
  ['validateGraph errors', metrics.baseline.validationErrors, metrics.toolkit.validationErrors, '—'],
  ['validateGraph warnings', metrics.baseline.validationWarnings, metrics.toolkit.validationWarnings, '—'],
  ['Toolkit implementation lines', '—', metrics.toolkitImplementationLines, 'amortized'],
];

const width = Math.max(...rows.map(([label]) => label.length));
console.log(`${'Measure'.padEnd(width)}  baseline  toolkit  reduction`);
for (const [label, from, to, change] of rows) {
  console.log(`${label.padEnd(width)}  ${String(from).padStart(8)}  ${String(to).padStart(7)}  ${change}`);
}

writeFileSync(
  path.join(repoRoot, 'packages/ui-toolkit/metrics.json'),
  `${JSON.stringify({ metrics, summary }, null, 2)}\n`,
);
console.log('\nWrote packages/ui-toolkit/metrics.json');
