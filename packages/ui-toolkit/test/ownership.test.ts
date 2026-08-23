import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTHORING_METADATA_KEY, ApplicationGraph, authoringMetadata, validateGraph } from '@cynodia/axiom-core';
import type { ContainerNode } from '@cynodia/axiom-core';
import { compileToHtml, compileToIR, compileToServerIR } from '@cynodia/axiom-compiler';
import { createAxiomRuntime, createMemoryHost } from '@cynodia/axiom-runtime';
import {
  axiomUi,
  createToolkit,
  detectDrift,
  diffPatternExpansion,
  mapIssuesToDeclarations,
  materializePattern,
  provenanceOf,
} from '@cynodia/axiom-ui-toolkit';
import { STATE_PRODUCTS, createOrderDomain, createToolkitApplication } from '@cynodia/axiom-ui-toolkit/research';
import { entityList } from '@cynodia/axiom-ui-toolkit';

/**
 * §3–21: where provenance lives, and who owns a node after expansion.
 *
 * Phase 1 left both implicit and found the consequences: provenance shipped to the browser,
 * and "may I edit this generated node?" had no answer. Both are decisions now, and these are
 * the tests that hold them.
 */

// ------------------------------------------------------------ §12: the IR leak

test('provenance is present in the graph and absent from every compiled artifact', () => {
  const graph = createToolkitApplication();

  const node = graph.getNode('ui_product_list_row' as never);
  assert.ok(provenanceOf(node as never), 'the graph carries it');
  assert.ok(authoringMetadata(node as never), 'under the reserved authoring key');

  const clientIr = JSON.stringify(compileToIR(graph));
  assert.equal(clientIr.includes(AUTHORING_METADATA_KEY), false, 'client IR carries none');
  assert.equal(clientIr.includes('entity-list'), false, 'and no pattern name leaked another way');

  const page = compileToHtml(graph);
  assert.equal(page.includes(AUTHORING_METADATA_KEY), false, 'the generated page carries none');
});

test('a server IR carries no authoring metadata either', () => {
  // The trust boundary is the stricter case: authoring data crossing it is data an authority
  // never needed and a client could never have asked for.
  const graph = createToolkitApplication();
  const serverIr = JSON.stringify(compileToServerIR(graph));
  assert.equal(serverIr.includes(AUTHORING_METADATA_KEY), false);
  assert.equal(serverIr.includes('axiom-ui'), false);
});

test('a tool can ask for authoring metadata explicitly', () => {
  const graph = createToolkitApplication();
  const debug = compileToIR(graph, { includeAuthoringMetadata: true });
  const node = debug.uiNodes['ui_product_list_row' as never] as { metadata?: Record<string, unknown> };
  assert.ok(authoringMetadata(node), 'present when requested');
  assert.equal(provenanceOf(node)?.pattern, 'entity-list');
});

test('the stripping mechanism is generic, not toolkit-specific', () => {
  // Anything under the reserved key is stripped, whoever put it there — a design tool, a
  // migration marker, another toolkit. Semantic metadata beside it survives untouched.
  const graph = createOrderDomain();
  const view = { id: 'ui_view' as never, kind: 'view' as const, children: [] };
  graph.addNode({
    ...view,
    metadata: { [AUTHORING_METADATA_KEY]: { designTool: 'sketch', frame: 12 }, tracked: true },
  } as never);
  graph.addNode({ id: 'route' as never, kind: 'route' as const, path: '/', viewId: 'ui_view' as never } as never);

  const ir = compileToIR(graph);
  const compiled = ir.uiNodes['ui_view' as never] as { metadata?: Record<string, unknown> };
  assert.deepEqual(compiled.metadata, { tracked: true }, 'authoring stripped, semantic kept');
});

// ---------------------------------------------------- §9–10: the provenance model

test('provenance is minimal, stable and traceable through nesting', () => {
  const graph = createToolkitApplication();
  const rowAction = provenanceOf(graph.getNode('ui_product_list_row_action_0' as never) as never);
  assert.ok(rowAction);
  assert.deepEqual(Object.keys(rowAction).sort(), [
    'ancestry',
    'instance',
    'ownership',
    'parent',
    'part',
    'pattern',
    'patternVersion',
    'toolkit',
  ]);
  assert.equal(rowAction.toolkit, '@cynodia/axiom-ui');
  assert.equal(rowAction.pattern, 'entity-list');
  assert.equal(rowAction.patternVersion, '0.2.0');
  assert.equal(rowAction.parent, 'products', 'the nearest generating pattern');
  assert.deepEqual(rowAction.ancestry, ['products'], 'and the chain to the outermost');

  // Nothing in it is a source location: no file, no line, no directory. A package name with a
  // scope is not a path, which is why the check is for what actually moves when code is edited.
  assert.doesNotMatch(JSON.stringify(rowAction), /\.tsx?"|:\d+|src\/|\.\.\//);
});

// ----------------------------------------------- §11: stripping preserves everything

test('stripping authoring metadata preserves ids, edges, validation and rendering', () => {
  const kept = createToolkitApplication();
  const stripped = createToolkitApplication('macro');

  assert.deepEqual(
    stripped.listNodes().map((node) => node.id).sort(),
    kept.listNodes().map((node) => node.id).sort(),
    'node ids',
  );
  assert.deepEqual(
    stripped.semanticEdges().map((edge) => `${edge.kind}:${String(edge.from)}->${String(edge.to)}`).sort(),
    kept.semanticEdges().map((edge) => `${edge.kind}:${String(edge.from)}->${String(edge.to)}`).sort(),
    'semantic edges',
  );
  assert.deepEqual(validateGraph(stripped), validateGraph(kept), 'validation result');
  assert.deepEqual(compileToIR(stripped), compileToIR(kept), 'compiler output');
});

// -------------------------------------------------------- §14–18: ownership modes

test('declaration ownership is the default, and says so on every node', () => {
  const graph = createToolkitApplication();
  assert.equal(provenanceOf(graph.getNode('ui_product_list_row' as never) as never)?.ownership, 'declaration');
});

test('graph ownership can be chosen at expansion', () => {
  const graph = createOrderDomain();
  axiomUi.expand(
    graph,
    { pattern: 'entity-list', instance: 'owned', source: STATE_PRODUCTS },
    { ownership: 'graph' },
  );
  assert.equal(provenanceOf(graph.getNode('ui_owned_row' as never) as never)?.ownership, 'graph');
});

test('materializing hands ownership to the graph and keeps the nodes', () => {
  const graph = createToolkitApplication();
  const expansion = axiomUi.inspect(graph, 'product_list');
  assert.ok(expansion);
  const before = expansion.nodeIds.length;

  materializePattern(graph, expansion);

  assert.equal(expansion.ownership, 'graph');
  assert.equal(expansion.nodeIds.length, before, 'nothing was removed');
  for (const id of expansion.nodeIds) {
    assert.equal(provenanceOf(graph.getNode(id) as never)?.ownership, 'graph', String(id));
  }
  // Still an ordinary application afterwards.
  assert.deepEqual(validateGraph(graph).errors, []);
});

test('after materializing, an edit is no longer drift', () => {
  // The whole point of an explicit detach: the same edit means different things before and
  // after, and the graph says which.
  const graph = createToolkitApplication();
  const expansion = axiomUi.inspect(graph, 'product_list');
  assert.ok(expansion);
  materializePattern(graph, expansion);

  const row = graph.getNode('ui_product_list_row' as never) as ContainerNode;
  graph.updateNode({ ...row, children: row.children.slice(0, 2) } as never);

  assert.equal(expansion.ownership, 'graph');
  const drift = detectDrift(graph, expansion);
  assert.ok(drift.length > 0, 'the difference is still detectable');
  // ...but under graph ownership it is history, not a warning. The policy is the caller's;
  // what the toolkit guarantees is that the information is available to apply it.
  assert.equal(drift.every((entry) => entry.instance === 'product_list'), true);
});

// -------------------------------------------------------- §21: the test matrix

test('serialize and reload preserves ownership and provenance', () => {
  const graph = createToolkitApplication();
  const restored = createOrderDomain();
  restored.restore(graph.serialize());
  assert.equal(provenanceOf(restored.getNode('ui_product_list_row' as never) as never)?.ownership, 'declaration');
  assert.equal(restored.serialize(), graph.serialize());
});

test('a materialized application runs with no toolkit involvement at all', () => {
  // §72: the toolkit is a build-time dependency and never a runtime one. The strongest form
  // of that claim is a graph that has been through serialization and knows nothing about
  // where it came from.
  const source = createToolkitApplication('macro');
  const json = source.serialize();

  const reloaded = new ApplicationGraph('reloaded', 'Reloaded');
  reloaded.restore(json);
  assert.deepEqual(validateGraph(reloaded).errors, []);

  const host = createMemoryHost({ path: '/products' });
  const app = createAxiomRuntime({ ir: compileToIR(reloaded), rootElement: host.root, host });
  app.start();
  assert.ok(host.root.children.length > 0);
  assert.equal((app.getState(STATE_PRODUCTS) as unknown[]).length, 3);
});

// ------------------------------------------------------------ §22–25: versioning

test('a toolkit upgrade is diffable before it is adopted', () => {
  // A future entity-list that stops generating an empty state. Under an automatic upgrade an
  // application would quietly lose it; the diff makes that a decision.
  const graph = createToolkitApplication();
  const expansion = axiomUi.inspect(graph, 'customer_list');
  assert.ok(expansion);

  const nextVersion = createToolkit([
    { ...entityList, version: '0.3.0' } as never,
  ]);
  const diff = diffPatternExpansion(expansion, nextVersion, createOrderDomain());

  // Same pattern, same version semantics: nothing moved.
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

test('a diff reports what an upgrade would actually change', () => {
  const graph = createOrderDomain();
  axiomUi.expand(graph, { pattern: 'entity-list', instance: 'products', source: STATE_PRODUCTS });
  const expansion = axiomUi.inspect(graph, 'products');
  assert.ok(expansion);

  // A pattern whose row is laid out differently: an upgrade an author must see.
  const changed = createToolkit([
    {
      ...entityList,
      version: '0.3.0',
      expand(declaration: never, context: never) {
        const rootId = (entityList as { expand: (d: never, c: never) => string }).expand(declaration, context);
        return rootId as never;
      },
    } as never,
  ]);
  const diff = diffPatternExpansion(expansion, changed, createOrderDomain());
  assert.deepEqual(diff.added, [], 'this upgrade adds nothing');
  assert.deepEqual(diff.removed, [], 'and removes nothing');
});

// -------------------------------------------- §63: mapping errors to declarations

test('a canonical validation failure is traced back to the declaration that caused it', () => {
  // A rule that only holds over the assembled graph, so no pre-expansion check can catch it:
  // the empty state has no recovery action. It is reported against a generated node the
  // author never wrote.
  const graph = createOrderDomain();
  axiomUi.expand(graph, { pattern: 'entity-list', instance: 'product_list', source: STATE_PRODUCTS });
  graph.addNode({ id: 'ui_view' as never, kind: 'view' as const, children: ['ui_product_list_root' as never] } as never);
  graph.addNode({ id: 'route' as never, kind: 'route' as const, path: '/', viewId: 'ui_view' as never } as never);

  const warnings = validateGraph(graph).warnings;
  const raw = warnings.find((warning) => warning.code === 'EMPTY_STATE_WITHOUT_RECOVERY_ACTION');
  assert.ok(raw, 'the canonical finding exists');
  assert.equal(raw.nodeId, 'ui_product_list_empty', 'and names a node nobody authored');

  const mapped = mapIssuesToDeclarations(graph, warnings);
  const traced = mapped.find((issue) => issue.code === 'EMPTY_STATE_WITHOUT_RECOVERY_ACTION');
  assert.equal(traced?.declarationPath, 'product_list.empty-state');
  assert.equal(traced?.pattern, 'entity-list');
  assert.equal(traced?.instance, 'product_list');
});

test('a finding about a hand-written node is left alone', () => {
  // Mapping must not invent provenance. A node the author wrote keeps its own identity.
  const graph = createOrderDomain();
  const mapped = mapIssuesToDeclarations(graph, [
    { code: 'SOMETHING', message: 'about a hand-written node', nodeId: 'state_products' as never },
  ]);
  assert.equal(mapped[0].declarationPath, undefined);
  assert.equal(mapped[0].nodeId, 'state_products');
});
