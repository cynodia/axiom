import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOOLING_CONFORMANCE_CONTRACT,
  runToolingConformanceSuite,
  toolingConformanceFixtures,
} from '@cynodia/axiom-agent-api';

/**
 * spec16 Phase J — `axiom.conformance.v10`, the tooling/explainability conformance tier.
 * Every fixture's expected result is hand-specified in `tooling-conformance.ts` (spec16
 * §125): this test proves the implementation agrees with those independently-stated
 * expectations, not that the implementation agrees with itself.
 */

test('axiom.conformance.v10 is a stable identifier', () => {
  assert.equal(TOOLING_CONFORMANCE_CONTRACT, 'axiom.conformance.v10');
});

test('every tooling conformance fixture passes', () => {
  const results = runToolingConformanceSuite();
  const failed = results.filter((r) => !r.passed);
  assert.deepEqual(
    failed.map((r) => ({ id: r.id, actual: r.actual, expected: r.expected, error: r.error })),
    [],
  );
});

test('the suite covers a representative spread of spec16 categories (spec16 §124)', () => {
  const categories = new Set(toolingConformanceFixtures().map((f) => f.category));
  for (const expected of [
    'inventory',
    'dependencies',
    'explain-action',
    'explain-query',
    'authorization-analysis',
    'capabilities',
    'semantic-diff',
    'diagnostics',
    'authoring-schema',
    'graph-edit',
    'native-boundary',
  ]) {
    assert.ok(categories.has(expected as never), `no fixture covers category "${expected}"`);
  }
});

test('every fixture id is unique', () => {
  const ids = toolingConformanceFixtures().map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});
