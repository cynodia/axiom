import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentAPI } from '@axiom/agent-api';
import { ApplicationGraph } from '@axiom/core';

function createGraph(): { graph: ApplicationGraph; issueId: string; stateId: string } {
  const graph = new ApplicationGraph('graph-api', 'API Graph');
  const issueId = graph.addNode({
    type: 'entity',
    name: 'Issue',
    fields: [
      { name: 'title', fieldType: 'string', required: true },
      { name: 'status', fieldType: 'string', validations: ['enum:todo|in_progress|done'] },
    ],
  });
  const stateId = graph.addNode({
    type: 'state',
    name: 'issues',
    stateType: 'Collection<Issue>',
    initialValue: [],
  });
  graph.addEdge(stateId, issueId, 'references');
  return { graph, issueId, stateId };
}

test('AgentAPI traverses dependencies and extracts subgraphs', () => {
  const { graph, issueId, stateId } = createGraph();
  const api = new AgentAPI(graph);

  assert.equal(api.getDependencies(stateId)[0]?.id, issueId);
  assert.equal(api.getDependents(issueId)[0]?.id, stateId);

  const neighborhood = api.subgraph(stateId, 1);
  assert.equal(neighborhood.nodes.length, 2);
  assert.equal(neighborhood.edges.length, 1);
});

test('AgentAPI transactions can commit and rollback', () => {
  const { graph, issueId } = createGraph();
  const api = new AgentAPI(graph);

  api.beginChange();
  api.addField(issueId, { name: 'priority', fieldType: 'string' });
  const constraint = api.addConstraint({
    name: 'Issue title required',
    description: 'Issue must keep a required title field',
    affectedEntityId: issueId,
    expression: 'fieldRequired("Issue", "title")',
  });
  const record = api.commitChange('Extend issue schema');

  assert.ok(record.modifiedNodes.includes(issueId));
  assert.ok(record.addedNodes.includes(constraint.id));
  assert.equal(api.getChangeHistory().length, 1);

  api.beginChange();
  api.addField(issueId, { name: 'temporary', fieldType: 'boolean' });
  api.rollbackChange();
  assert.equal(graph.getNode(issueId)?.type, 'entity');
  assert.equal((graph.getNode(issueId) as { fields: Array<{ name: string }> }).fields.some((field) => field.name === 'temporary'), false);
});

test('AgentAPI runs invariants', () => {
  const { graph, issueId } = createGraph();
  graph.addNode({
    type: 'constraint',
    name: 'Issue status enum',
    description: 'Issue status must keep the MVP enum',
    affectedEntityId: issueId,
    expression: 'fieldEnum("Issue", "status", ["todo", "in_progress", "done"])',
  });
  const api = new AgentAPI(graph);
  const [result] = api.runInvariants();

  assert.equal(result.passed, true);
});
