import { ApplicationGraph } from '@axiom/core';

export function createIssueTrackerModel(): ApplicationGraph {
  const graph = new ApplicationGraph('issue-tracker', 'Issue Tracker');

  const userId = graph.addNode({
    type: 'entity',
    name: 'User',
    fields: [
      { name: 'id', fieldType: 'string', required: true },
      { name: 'name', fieldType: 'string', required: true },
      { name: 'email', fieldType: 'string', required: true },
    ],
  });

  const projectId = graph.addNode({
    type: 'entity',
    name: 'Project',
    fields: [
      { name: 'id', fieldType: 'string', required: true },
      { name: 'name', fieldType: 'string', required: true },
      { name: 'description', fieldType: 'string' },
    ],
  });

  const issueId = graph.addNode({
    type: 'entity',
    name: 'Issue',
    fields: [
      { name: 'id', fieldType: 'string', required: true },
      { name: 'title', fieldType: 'string', required: true },
      { name: 'description', fieldType: 'string' },
      { name: 'status', fieldType: 'string', required: true, validations: ['enum:todo|in_progress|done'] },
      { name: 'projectId', fieldType: 'Project', required: true },
      { name: 'assigneeId', fieldType: 'User', required: true },
      { name: 'createdAt', fieldType: 'date', required: true },
    ],
  });

  const commentId = graph.addNode({
    type: 'entity',
    name: 'Comment',
    fields: [
      { name: 'id', fieldType: 'string', required: true },
      { name: 'issueId', fieldType: 'Issue', required: true },
      { name: 'authorId', fieldType: 'User', required: true },
      { name: 'body', fieldType: 'string', required: true },
      { name: 'createdAt', fieldType: 'date', required: true },
    ],
  });

  const issuesStateId = graph.addNode({
    type: 'state',
    name: 'issues',
    stateType: 'Collection<Issue>',
    initialValue: [
      {
        id: 'issue-1',
        title: 'Set up repository build graph',
        description: 'Create the monorepo structure, references, and automated build pipeline.',
        status: 'todo',
        projectId: 'project-1',
        assigneeId: 'user-1',
        createdAt: '2026-08-20T00:00:00.000Z',
        comments: [
          {
            id: 'comment-1',
            issueId: 'issue-1',
            authorId: 'user-1',
            body: 'Bootstrap the MVP so agents can reason over the app graph.',
            createdAt: '2026-08-20T00:30:00.000Z',
          },
        ],
      },
      {
        id: 'issue-2',
        title: 'Add semantic agent API',
        description: 'Expose query and transactional editing methods over the application graph.',
        status: 'in_progress',
        projectId: 'project-1',
        assigneeId: 'user-2',
        createdAt: '2026-08-19T12:00:00.000Z',
        comments: [],
      },
    ],
  });

  const currentIssueStateId = graph.addNode({
    type: 'state',
    name: 'currentIssue',
    stateType: 'Issue | null',
    initialValue: null,
    derivedFrom: [issuesStateId],
  });

  const filtersStateId = graph.addNode({
    type: 'state',
    name: 'filters',
    stateType: '{ status: string; search: string }',
    initialValue: { status: 'all', search: '' },
  });

  const createIssueActionId = graph.addNode({
    type: 'action',
    name: 'createIssue',
    inputs: [
      { name: 'title', fieldType: 'string', required: true },
      { name: 'description', fieldType: 'string' },
      { name: 'status', fieldType: 'string', required: true },
    ],
    effects: [
      { kind: 'mutate', target: issuesStateId },
      { kind: 'navigate', target: '/issues/:id' },
    ],
    failureModes: ['title missing', 'invalid status'],
  });

  const updateIssueActionId = graph.addNode({
    type: 'action',
    name: 'updateIssue',
    inputs: [
      { name: 'title', fieldType: 'string', required: true },
      { name: 'description', fieldType: 'string' },
      { name: 'status', fieldType: 'string', required: true },
    ],
    effects: [{ kind: 'mutate', target: issuesStateId }],
  });

  const deleteIssueActionId = graph.addNode({
    type: 'action',
    name: 'deleteIssue',
    inputs: [{ name: 'id', fieldType: 'string', required: true }],
    effects: [
      { kind: 'mutate', target: issuesStateId },
      { kind: 'navigate', target: '/' },
    ],
  });

  const addCommentActionId = graph.addNode({
    type: 'action',
    name: 'addComment',
    inputs: [{ name: 'body', fieldType: 'string', required: true }],
    effects: [{ kind: 'mutate', target: currentIssueStateId }],
  });

  const issueListViewId = graph.addNode({
    type: 'view',
    name: 'IssueList',
    renderKind: 'list',
    source: issuesStateId,
    children: [{ nodeId: currentIssueStateId }],
    actionIds: [createIssueActionId],
    props: { emptyMessage: 'No issues found' },
  });

  const issueEditorViewId = graph.addNode({
    type: 'view',
    name: 'IssueEditor',
    renderKind: 'editor',
    source: currentIssueStateId,
    actionIds: [updateIssueActionId],
  });

  const issueDetailViewId = graph.addNode({
    type: 'view',
    name: 'IssueDetail',
    renderKind: 'detail',
    source: currentIssueStateId,
    children: [{ nodeId: issueEditorViewId }],
    actionIds: [updateIssueActionId, deleteIssueActionId, addCommentActionId],
  });

  const createIssueViewId = graph.addNode({
    type: 'view',
    name: 'CreateIssue',
    renderKind: 'create',
    source: filtersStateId,
    actionIds: [createIssueActionId],
  });

  const titleConstraintId = graph.addNode({
    type: 'constraint',
    name: 'Issue title required',
    description: 'Issue.title must remain required for the MVP editor experience.',
    affectedEntityId: issueId,
    expression: 'fieldRequired("Issue", "title")',
  });

  const statusConstraintId = graph.addNode({
    type: 'constraint',
    name: 'Issue status enum',
    description: 'Issue.status must use the todo/in_progress/done enum.',
    affectedEntityId: issueId,
    expression: 'fieldEnum("Issue", "status", ["todo", "in_progress", "done"])',
  });

  const homeRouteId = graph.addNode({
    type: 'route',
    name: 'IssueListRoute',
    path: '/',
    viewId: issueListViewId,
  });

  const detailRouteId = graph.addNode({
    type: 'route',
    name: 'IssueDetailRoute',
    path: '/issues/:id',
    viewId: issueDetailViewId,
  });

  const createRouteId = graph.addNode({
    type: 'route',
    name: 'CreateIssueRoute',
    path: '/issues/new',
    viewId: createIssueViewId,
  });

  graph.addEdge(issuesStateId, issueId, 'stores');
  graph.addEdge(currentIssueStateId, issueId, 'selects');
  graph.addEdge(filtersStateId, issuesStateId, 'filters');
  graph.addEdge(issueListViewId, issuesStateId, 'reads');
  graph.addEdge(issueListViewId, createIssueActionId, 'invokes');
  graph.addEdge(issueDetailViewId, currentIssueStateId, 'reads');
  graph.addEdge(issueDetailViewId, issueEditorViewId, 'composes');
  graph.addEdge(issueDetailViewId, updateIssueActionId, 'invokes');
  graph.addEdge(issueDetailViewId, deleteIssueActionId, 'invokes');
  graph.addEdge(issueDetailViewId, addCommentActionId, 'invokes');
  graph.addEdge(issueEditorViewId, updateIssueActionId, 'invokes');
  graph.addEdge(createIssueViewId, createIssueActionId, 'invokes');
  graph.addEdge(createIssueActionId, issuesStateId, 'mutates');
  graph.addEdge(updateIssueActionId, currentIssueStateId, 'mutates');
  graph.addEdge(deleteIssueActionId, issuesStateId, 'mutates');
  graph.addEdge(addCommentActionId, currentIssueStateId, 'mutates');
  graph.addEdge(titleConstraintId, issueId, 'constrains');
  graph.addEdge(statusConstraintId, issueId, 'constrains');
  graph.addEdge(homeRouteId, issueListViewId, 'routesTo');
  graph.addEdge(detailRouteId, issueDetailViewId, 'routesTo');
  graph.addEdge(createRouteId, createIssueViewId, 'routesTo');
  graph.addEdge(issueId, userId, 'references');
  graph.addEdge(issueId, projectId, 'references');
  graph.addEdge(commentId, issueId, 'references');
  graph.addEdge(commentId, userId, 'references');

  return graph;
}
