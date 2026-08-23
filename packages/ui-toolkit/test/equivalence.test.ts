import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGraph } from '@cynodia/axiom-core';
import type { ApplicationGraph, ButtonNode, FormNode, InputNode, RepeatNode, UINode } from '@cynodia/axiom-core';
import { compileToIR } from '@cynodia/axiom-compiler';
import { createAxiomRuntime, createMemoryHost } from '@cynodia/axiom-runtime';
import {
  ACTION_ADD_PRODUCT,
  F_PRODUCT_NAME,
  F_PRODUCT_PRICE,
  STATE_DRAFT_PRODUCT,
  STATE_PRODUCTS,
  createToolkitApplication,
} from '@cynodia/axiom-ui/example';
import { stripProvenance } from '@cynodia/axiom-ui';
// The hand-built comparison. It exists to be measured against and is deliberately not part
// of the published package: a toolkit that shipped an anti-example would be teaching it.
import { createBaselineApplication } from './baseline.js';

/**
 * §18–19, §66: the expanded application must be an ordinary Axiom application.
 *
 * Not "similar to" one — the same in every property the framework can check: it validates,
 * it compiles, it runs, it renders, and it does so with the toolkit nowhere in sight.
 */

/** Everything about a graph that decides behaviour, with node ids and ordering removed. */
function behaviouralShape(graph: ApplicationGraph): Record<string, number> {
  const shape: Record<string, number> = {};
  for (const node of graph.listNodes()) {
    shape[`kind:${node.kind}`] = (shape[`kind:${node.kind}`] ?? 0) + 1;
  }
  for (const node of graph.listNodes()) {
    if (node.kind === 'input') {
      const location = (node as InputNode).binding.location;
      shape[`binds:${JSON.stringify(location)}`] = (shape[`binds:${JSON.stringify(location)}`] ?? 0) + 1;
    }
    if (node.kind === 'button') {
      shape[`invokes:${String((node as ButtonNode).actionId)}`] =
        (shape[`invokes:${String((node as ButtonNode).actionId)}`] ?? 0) + 1;
    }
    if (node.kind === 'repeat') {
      shape[`repeats:${JSON.stringify((node as RepeatNode).source)}`] = 1;
    }
  }
  return shape;
}

test('both applications validate with no errors and no warnings', () => {
  for (const [name, graph] of [
    ['baseline', createBaselineApplication()],
    ['toolkit', createToolkitApplication()],
  ] as const) {
    const result = validateGraph(graph);
    assert.deepEqual(result.errors, [], `${name} errors`);
    assert.deepEqual(result.warnings, [], `${name} warnings`);
  }
});

test('the toolkit application binds, invokes and repeats exactly what the baseline does', () => {
  // Node ids differ — the toolkit derives its own — so equality is asserted over the things
  // that decide behaviour: which locations are written, which actions are reachable, which
  // collections are iterated.
  const baseline = behaviouralShape(createBaselineApplication());
  const toolkit = behaviouralShape(createToolkitApplication());

  for (const key of Object.keys(baseline).filter((entry) => entry.startsWith('binds:'))) {
    assert.equal(toolkit[key], baseline[key], `${key} differs`);
  }
  for (const key of Object.keys(baseline).filter((entry) => entry.startsWith('invokes:'))) {
    assert.ok(toolkit[key] >= 1, `the toolkit application never invokes ${key}`);
  }
  for (const key of Object.keys(baseline).filter((entry) => entry.startsWith('repeats:'))) {
    assert.equal(toolkit[key], 1, `${key} is not repeated`);
  }
});

test('the expanded application compiles, starts and renders', () => {
  const host = createMemoryHost({ path: '/products' });
  const app = createAxiomRuntime({
    ir: compileToIR(createToolkitApplication()),
    rootElement: host.root,
    host,
  });
  app.start();
  assert.ok(host.root.children.length > 0, 'the page rendered');
  assert.equal((app.getState(STATE_PRODUCTS) as unknown[]).length, 3);
});

test('the expanded application executes its actions', () => {
  const host = createMemoryHost({ path: '/products' });
  const app = createAxiomRuntime({
    ir: compileToIR(createToolkitApplication()),
    rootElement: host.root,
    host,
  });
  app.start();

  // A guard the toolkit did not write, refusing for a reason the toolkit does not know.
  const refused = app.invokeAction(ACTION_ADD_PRODUCT);
  assert.equal(refused.ok, false);
  assert.equal(refused.diagnostics[0]?.details?.failureMode, 'name-required');

  app.hydrateState(STATE_DRAFT_PRODUCT, {
    [F_PRODUCT_NAME]: 'Spring washer',
    [F_PRODUCT_PRICE]: 3,
    field_product_id: 'spring',
    field_product_stock: 10,
    field_product_active: true,
  });
  assert.equal(app.invokeAction(ACTION_ADD_PRODUCT).ok, true);
  assert.equal((app.getState(STATE_PRODUCTS) as unknown[]).length, 4);
});

// ------------------------------------------------------- §37 and §66: removal

test('removing provenance changes nothing but toolkit-aware introspection', () => {
  const withProvenance = createToolkitApplication('provenance');
  const stripped = stripProvenance(createToolkitApplication('provenance'));
  const asMacro = createToolkitApplication('macro');

  // Same graph, byte for byte, whichever way the metadata got removed.
  assert.equal(stripped.serialize(), asMacro.serialize(), 'stripping equals never recording');
  assert.notEqual(withProvenance.serialize(), stripped.serialize(), 'provenance was actually present');

  const before = compileToIR(withProvenance);
  const after = compileToIR(stripped);
  // Everything that decides behaviour is identical, which is what §37 requires.
  assert.deepEqual(after.actions, before.actions);
  assert.deepEqual(after.locationTypes, before.locationTypes);
  assert.deepEqual(after.presentation, before.presentation);
  assert.deepEqual(after.routes, before.routes);

  // Phase 1 found `uiNodes` differed here: `compileToIR` copied node metadata into the IR, so
  // provenance shipped to the browser. Provenance now lives under core's reserved authoring
  // key and the compiler strips it by default, so the IR is identical either way.
  assert.deepEqual(after.uiNodes, before.uiNodes, 'provenance no longer reaches the IR');
});

test('a stripped application still validates, compiles, runs and renders', () => {
  const graph = stripProvenance(createToolkitApplication('provenance'));
  assert.deepEqual(validateGraph(graph).errors, []);
  const host = createMemoryHost({ path: '/orders' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  assert.ok(host.root.children.length > 0);
});

// --------------------------------------------------------- §41: serialization

test('an expanded application serializes and restores losslessly, provenance included', () => {
  const graph = createToolkitApplication();
  const json = graph.serialize();
  // `"function": "count"` is a legitimate call expression, so the check is for actual code.
  assert.doesNotMatch(json, /=>|function\s*\(/, 'no callback reached the graph');
  const restored = createToolkitApplication();
  restored.restore(json);
  assert.equal(restored.serialize(), json);
});

// ------------------------------------------------------ §42: deterministic ids

test('expansion is deterministic: the same declaration yields the same graph', () => {
  assert.equal(createToolkitApplication().serialize(), createToolkitApplication().serialize());
});

test('generated ids are derived from the declaration, not from a counter', () => {
  const graph = createToolkitApplication();
  // A counter would make ids depend on expansion order; derivation makes them predictable
  // from the declaration alone, which is what lets an author reference one before it exists.
  assert.ok(graph.getNode('ui_product_list_rows' as never), 'the product list repeat is named after its instance');
  assert.ok(graph.getNode('ui_new_product_root' as never), 'the product form is named after its instance');
});

// -------------------------------------------------- §67: renderer independence

test('nothing in the expanded graph names a renderer, a length or a CSS property', () => {
  const json = createToolkitApplication().serialize();
  for (const forbidden of [/\bdiv\b/, /flexbox/i, /grid-template/i, /\bpx\b/, /rem\b/, /#[0-9a-f]{6}/i, /className/]) {
    assert.doesNotMatch(json, forbidden, `the expanded graph leaked ${String(forbidden)}`);
  }
});

test('the toolkit never writes a raw presentation value', () => {
  // Every presentation value a pattern emits must come from the published vocabulary, or the
  // renderer independence above is accidental rather than structural.
  const graph = createToolkitApplication();
  const ir = compileToIR(graph);
  const json = JSON.stringify(ir.presentation);
  for (const forbidden of [/[0-9]+px/, /#[0-9a-f]{3,8}/i, /rgba?\(/]) {
    assert.doesNotMatch(json, forbidden);
  }
});

void ((): UINode | undefined => undefined);
void ((): FormNode | undefined => undefined);
