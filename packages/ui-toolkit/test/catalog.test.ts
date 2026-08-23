import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { UI_NODE_KINDS, nodeId } from '@cynodia/axiom-core';
import { TOOLKIT_NAME, TOOLKIT_VERSION, axiomUi, describePattern, listPatterns, provenanceOf } from '@cynodia/axiom-ui';
import { createToolkitApplication } from '@cynodia/axiom-ui/example';

/**
 * The catalogue is the toolkit's agent-facing interface, so its claims are tested rather
 * than reviewed.
 *
 * Phase 2's blind agent read five pattern implementations because the catalogue said what a
 * pattern *takes* and not what it *builds*. The `expansion` entries fixed that — and a
 * description of generated structure is only useful if it cannot drift from the structure,
 * which is what this file is for.
 */
const CATALOG = JSON.parse(
  readFileSync(new URL('../docs/PATTERN_CATALOG.json', import.meta.url), 'utf8'),
) as {
  catalog: string;
  toolkit: string;
  version: string;
  release: string;
  ownership: { default: string; values: Record<string, string> };
  patterns: Array<{
    name: string;
    purpose: string;
    required: string[];
    optional: string[];
    inputs: Record<string, { kind: string; required: boolean; purpose: string; inferredWhenAbsent?: string }>;
    slots: string[];
    produces: string[];
    expansion: Array<{ part: string; kind: string; role: string }>;
    generatedIdFormat: string;
    inferred: Record<string, string>;
  }>;
};

/** Every part every pattern actually stamped, from the expanded reference application. */
function stampedParts(): Map<string, Set<string>> {
  const graph = createToolkitApplication();
  const byPattern = new Map<string, Set<string>>();
  const kinds = new Map<string, string>();
  for (const node of graph.listNodes()) {
    const provenance = provenanceOf(node as { metadata?: Record<string, unknown> });
    if (!provenance) {
      continue;
    }
    const parts = byPattern.get(provenance.pattern) ?? new Set<string>();
    parts.add(provenance.part);
    byPattern.set(provenance.pattern, parts);
    kinds.set(`${provenance.pattern}/${provenance.part}`, node.kind);
  }
  stampedKinds = kinds;
  return byPattern;
}

let stampedKinds = new Map<string, string>();
const STAMPED = stampedParts();

test('the shipped catalogue is the toolkit the code defines', () => {
  assert.equal(CATALOG.catalog, 'axiom.ui.catalog.v1');
  assert.equal(CATALOG.toolkit, TOOLKIT_NAME);
  assert.equal(CATALOG.version, TOOLKIT_VERSION);
  assert.deepEqual(
    CATALOG.patterns.map((pattern) => pattern.name),
    listPatterns(axiomUi),
    'the catalogue names every pattern and no others',
  );
});

test('every catalogue entry matches the pattern definition it describes', () => {
  for (const entry of CATALOG.patterns) {
    const described = describePattern(axiomUi, entry.name);
    assert.ok(described, `${entry.name} exists`);
    assert.deepEqual(entry.inputs, described.inputs, `${entry.name}: inputs`);
    assert.deepEqual(entry.required, described.required, `${entry.name}: required inputs`);
    assert.deepEqual(entry.optional, described.optional, `${entry.name}: optional inputs`);
    assert.deepEqual(entry.slots, [...described.slots], `${entry.name}: slots`);
    assert.deepEqual(entry.produces, [...described.produces], `${entry.name}: produces`);
    assert.deepEqual(entry.expansion, described.expansion, `${entry.name}: expansion`);
    assert.deepEqual(entry.inferred, described.inferred, `${entry.name}: inferred values`);
  }
});

test('every part the catalogue promises is a part the expansion stamps', () => {
  // The reference application uses every pattern, so every documented part should appear —
  // except the ones that only exist when an optional input is given.
  const optionalParts = new Set([
    'metric-description', // only when a metric declares a description
    'empty-action', // only when the empty state offers one
    'description', // page and form descriptions are optional
  ]);
  const missing: string[] = [];
  for (const entry of CATALOG.patterns) {
    const stamped = STAMPED.get(entry.name) ?? new Set<string>();
    for (const part of entry.expansion) {
      if (!stamped.has(part.part) && !optionalParts.has(part.part)) {
        missing.push(`${entry.name}.${part.part}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'the catalogue describes parts nothing generates');
});

test('nothing is stamped that the catalogue does not describe', () => {
  const undocumented: string[] = [];
  for (const [pattern, parts] of STAMPED) {
    const described = new Set(
      (CATALOG.patterns.find((entry) => entry.name === pattern)?.expansion ?? []).map((entry) => entry.part),
    );
    for (const part of parts) {
      if (!described.has(part)) {
        undocumented.push(`${pattern}.${part}`);
      }
    }
  }
  assert.deepEqual(undocumented, [], 'expansion produces parts the catalogue never mentions');
});

test('the node kind the catalogue claims for a part is the kind that part is', () => {
  const wrong: string[] = [];
  for (const entry of CATALOG.patterns) {
    for (const part of entry.expansion) {
      const actual = stampedKinds.get(`${entry.name}/${part.part}`);
      if (actual && actual !== part.kind) {
        wrong.push(`${entry.name}.${part.part}: catalogue says ${part.kind}, expansion produced ${actual}`);
      }
      assert.ok(
        (UI_NODE_KINDS as readonly string[]).includes(part.kind),
        `${entry.name}.${part.part} claims ${part.kind}, which is not a canonical UI node kind`,
      );
    }
  }
  assert.deepEqual(wrong, []);
});

test('the documented id format is the format generated ids actually have', () => {
  const graph = createToolkitApplication();
  for (const entry of CATALOG.patterns) {
    assert.match(entry.generatedIdFormat, /ui_<instance>_<part>/);
  }
  // Stated as a rule, checked as a fact: a part with an underscore in its name is generated
  // with underscores, and an indexed part carries its index.
  assert.ok(graph.hasNode(nodeId('ui_product_list_row')), 'ui_<instance>_<part>');
  assert.ok(graph.hasNode(nodeId('ui_product_list_row_action_0')), 'ui_<instance>_<part>_<index>');
  assert.ok(graph.hasNode(nodeId('ui_dash_metrics_metric_0')), 'and again for a repeated part');
});

test('the catalogue states the ownership model, because the default decides who may edit', () => {
  assert.equal(CATALOG.ownership.default, 'declaration');
  assert.match(CATALOG.ownership.values.declaration, /source of truth/);
  assert.match(CATALOG.ownership.values.graph, /source of truth/);
});
