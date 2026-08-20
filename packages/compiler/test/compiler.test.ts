import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationGraph } from '@axiom/core';
import { compileToHtml } from '@axiom/compiler';

test('compileToHtml emits self-contained html', () => {
  const graph = new ApplicationGraph('demo', 'Demo App');
  const stateId = graph.addNode({
    type: 'state',
    name: 'issues',
    stateType: 'Collection<Issue>',
    initialValue: [],
  });
  const viewId = graph.addNode({
    type: 'view',
    name: 'IssueList',
    source: stateId,
    actionIds: [],
  });
  graph.addNode({
    type: 'route',
    name: 'Home',
    path: '/',
    viewId,
  });

  const html = compileToHtml(graph);
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /globalThis\.__AXIOM_GRAPH__/);
  assert.match(html, /IssueList/);
});
