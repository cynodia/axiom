export function createRuntimeModuleSource(): string {
          return String.raw`const graphData = globalThis.__AXIOM_GRAPH__;
const rootElement = document.getElementById('app');
const clone = (value) => JSON.parse(JSON.stringify(value));
const nodes = Object.values(graphData.nodes);
const states = new Map();
const entityByName = new Map();
const actionByName = new Map();
const routes = nodes.filter((node) => node.type === 'route').map((route) => ({
  ...route,
  matcher: compileRoute(route.path),
})).sort((left, right) => dynamicSegmentCount(left.path) - dynamicSegmentCount(right.path));
const views = new Map(nodes.filter((node) => node.type === 'view').map((view) => [view.id, view]));
for (const node of nodes) {
  if (node.type === 'entity') {
    entityByName.set(node.name, node);
  }
  if (node.type === 'action') {
    actionByName.set(node.name, node);
  }
  if (node.type === 'state') {
    states.set(node.name, clone(node.initialValue ?? null));
  }
}
const validStatuses = (() => {
  const issue = entityByName.get('Issue');
  const field = issue && issue.fields.find((candidate) => candidate.name === 'status');
  const enumRule = field && (field.validations || []).find((rule) => rule.startsWith('enum:'));
  return enumRule ? enumRule.replace('enum:', '').split('|') : ['todo', 'in_progress', 'done'];
})();
function dynamicSegmentCount(path) {
  return path.split('/').filter((part) => part.startsWith(':')).length;
}
function compileRoute(path) {
  const parts = path.split('/').filter(Boolean);
  return (candidate) => {
    const clean = candidate.split('?')[0];
    const routeParts = clean.split('/').filter(Boolean);
    if (parts.length !== routeParts.length) {
      return null;
    }
    const params = {};
    for (let index = 0; index < parts.length; index += 1) {
      const expected = parts[index];
      const actual = routeParts[index];
      if (expected.startsWith(':')) {
        params[expected.slice(1)] = decodeURIComponent(actual);
        continue;
      }
      if (expected !== actual) {
        return null;
      }
    }
    return params;
  };
}
function setState(name, value) {
  states.set(name, clone(value));
  render();
}
function getState(name) {
  return clone(states.get(name));
}
function upsertIssue(nextIssue) {
  const issues = getState('issues') || [];
  const index = issues.findIndex((issue) => issue.id === nextIssue.id);
  if (index === -1) {
    issues.unshift(nextIssue);
  } else {
    issues[index] = nextIssue;
  }
  setState('issues', issues);
  setState('currentIssue', nextIssue);
}
function removeIssue(id) {
  const issues = (getState('issues') || []).filter((issue) => issue.id !== id);
  setState('issues', issues);
  setState('currentIssue', null);
}
function randomId(prefix) {
  const segment = () => Math.random().toString(16).slice(2, 10);
  return prefix + '-' + segment() + '-' + segment();
}
function validateIssue(issue) {
  if (!issue.title || !String(issue.title).trim()) {
    return 'Issue title is required';
  }
  if (!validStatuses.includes(issue.status)) {
    return 'Issue status must be one of: ' + validStatuses.join(', ');
  }
  return null;
}
function invokeAction(name, payload) {
  const normalized = clone(payload || {});
  if (name === 'createIssue') {
    const issue = {
      id: randomId('issue'),
      title: normalized.title || '',
      description: normalized.description || '',
      status: normalized.status || 'todo',
      projectId: normalized.projectId || 'project-1',
      assigneeId: normalized.assigneeId || 'user-1',
      createdAt: new Date().toISOString(),
      comments: [],
    };
    const error = validateIssue(issue);
    if (error) {
      alert(error);
      return;
    }
    upsertIssue(issue);
    navigate('/issues/' + issue.id);
    return;
  }
  if (name === 'updateIssue') {
    const current = getState('currentIssue');
    if (!current) {
      return;
    }
    const issue = { ...current, ...normalized };
    const error = validateIssue(issue);
    if (error) {
      alert(error);
      return;
    }
    upsertIssue(issue);
    return;
  }
  if (name === 'deleteIssue') {
    removeIssue(normalized.id);
    navigate('/');
    return;
  }
  if (name === 'addComment') {
    const current = getState('currentIssue');
    if (!current) {
      return;
    }
    const body = String(normalized.body || '').trim();
    if (!body) {
      alert('Comment body is required');
      return;
    }
    const comment = {
      id: randomId('comment'),
      issueId: current.id,
      authorId: normalized.authorId || 'user-1',
      body,
      createdAt: new Date().toISOString(),
    };
    const comments = Array.isArray(current.comments) ? current.comments.slice() : [];
    comments.push(comment);
    upsertIssue({ ...current, comments });
  }
}
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function navigate(path) {
  history.pushState({}, '', path);
  syncRoute();
}
function syncRoute() {
  const match = matchRoute(location.pathname);
  if (match && match.route && match.route.path === '/issues/:id') {
    const issues = getState('issues') || [];
    const current = issues.find((issue) => issue.id === match.params.id) || null;
    setState('currentIssue', current);
    return;
  }
  if (match && match.route && match.route.path !== '/issues/:id') {
    setState('currentIssue', null);
    return;
  }
  render();
}
function matchRoute(pathname) {
  for (const route of routes) {
    const params = route.matcher(pathname);
    if (params) {
      return { route, params };
    }
  }
  return null;
}
function renderIssueList() {
  const filters = getState('filters') || { status: 'all', search: '' };
  const issues = getState('issues') || [];
  const filtered = issues.filter((issue) => {
    const matchesStatus = filters.status === 'all' || issue.status === filters.status;
    const search = String(filters.search || '').toLowerCase();
    const haystack = (issue.title + ' ' + (issue.description || '')).toLowerCase();
    return matchesStatus && (!search || haystack.includes(search));
  });
  const items = filtered.length
    ? filtered
        .map((issue) => '<li class="issue-row"><button data-nav="/issues/' + escapeHtml(issue.id) + '">' + escapeHtml(issue.title) + '</button><span class="issue-status">' + escapeHtml(issue.status) + '</span></li>')
        .join('')
    : '<li class="empty-state">No issues match the current filters.</li>';
  return '<section class="panel"><div class="panel-header"><h1>Issue Tracker</h1><button data-nav="/issues/new">Create issue</button></div><div class="filters"><label>Search <input name="search" value="' + escapeHtml(filters.search || '') + '" /></label><label>Status <select name="status">' + ['all'].concat(validStatuses).map((status) => '<option value="' + status + '"' + (status === filters.status ? ' selected' : '') + '>' + status + '</option>').join('') + '</select></label></div><ul class="issue-list">' + items + '</ul></section>';
}
function renderIssueEditor(issue) {
  const current = issue || { title: '', description: '', status: 'todo', assigneeId: 'user-1' };
  return '<section class="panel"><h2>Edit issue</h2><form data-action="updateIssue" class="stack"><label>Title <input name="title" value="' + escapeHtml(current.title || '') + '" /></label><label>Description <textarea name="description">' + escapeHtml(current.description || '') + '</textarea></label><label>Status <select name="status">' + validStatuses.map((status) => '<option value="' + status + '"' + (status === current.status ? ' selected' : '') + '>' + status + '</option>').join('') + '</select></label><label>Assignee <input name="assigneeId" value="' + escapeHtml(current.assigneeId || '') + '" /></label><div class="actions"><button type="submit">Save changes</button></div></form></section>';
}
function renderIssueDetail() {
  const issue = getState('currentIssue');
  if (!issue) {
    return '<section class="panel"><h1>Issue not found</h1><button data-nav="/">Back to issues</button></section>';
  }
  const comments = (issue.comments || []).length
    ? issue.comments.map((comment) => '<li><strong>' + escapeHtml(comment.authorId) + '</strong><p>' + escapeHtml(comment.body) + '</p></li>').join('')
    : '<li class="empty-state">No comments yet.</li>';
  return '<div class="layout"><section class="panel"><div class="panel-header"><div><button data-nav="/">← Back</button><h1>' + escapeHtml(issue.title) + '</h1><p>' + escapeHtml(issue.description || '') + '</p></div><div class="actions"><span class="badge">' + escapeHtml(issue.status) + '</span><button data-delete="' + escapeHtml(issue.id) + '">Delete</button></div></div><h2>Comments</h2><ul class="comment-list">' + comments + '</ul><form data-action="addComment" class="stack"><label>Add comment <textarea name="body"></textarea></label><button type="submit">Post comment</button></form></section>' + renderIssueEditor(issue) + '</div>';
}
function renderCreateIssue() {
  return '<section class="panel"><div class="panel-header"><div><button data-nav="/">← Back</button><h1>Create issue</h1></div></div><form data-action="createIssue" class="stack"><label>Title <input name="title" /></label><label>Description <textarea name="description"></textarea></label><label>Status <select name="status">' + validStatuses.map((status) => '<option value="' + status + '">' + status + '</option>').join('') + '</select></label><label>Project <input name="projectId" value="project-1" /></label><label>Assignee <input name="assigneeId" value="user-1" /></label><button type="submit">Create issue</button></form></section>';
}
function renderGeneric(view) {
  return '<section class="panel"><h1>' + escapeHtml(view.name) + '</h1><pre>' + escapeHtml(JSON.stringify(view, null, 2)) + '</pre></section>';
}
const generatedViews = globalThis.__AXIOM_VIEW_RENDERERS__ || {};
function render() {
  const match = matchRoute(location.pathname) || routes.find((route) => route.path === '/') && { route: routes.find((route) => route.path === '/'), params: {} };
  const view = match ? views.get(match.route.viewId) : null;
  const renderer = view && generatedViews[view.id] ? generatedViews[view.id] : null;
  if (!rootElement) {
    return;
  }
  rootElement.innerHTML = renderer ? renderer({ route: match ? match.route : null, params: match ? match.params : {} }) : '<section class="panel"><h1>Route not found</h1></section>';
}
if (!rootElement) {
  throw new Error('Axiom runtime could not find #app');
}
rootElement.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const nav = target.closest('[data-nav]');
  if (nav instanceof HTMLElement) {
    const destination = nav.getAttribute('data-nav');
    if (destination) {
      event.preventDefault();
      navigate(destination);
    }
    return;
  }
  const deletion = target.closest('[data-delete]');
  if (deletion instanceof HTMLElement) {
    const id = deletion.getAttribute('data-delete');
    if (id) {
      invokeAction('deleteIssue', { id });
    }
  }
});
rootElement.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }
  if (target.name === 'search' || target.name === 'status') {
    const current = getState('filters') || { status: 'all', search: '' };
    setState('filters', { ...current, [target.name]: target.value });
  }
});
rootElement.addEventListener('submit', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) {
    return;
  }
  const action = target.getAttribute('data-action');
  if (!action) {
    return;
  }
  event.preventDefault();
  const formData = new FormData(target);
  const payload = {};
  for (const [key, value] of formData.entries()) {
    payload[key] = value;
  }
  invokeAction(action, payload);
  if (action === 'addComment') {
    target.reset();
  }
});
window.addEventListener('popstate', syncRoute);
Object.assign(globalThis, {
  __AXIOM_APP__: {
    graph: graphData,
    getState,
    setState,
    navigate,
    invokeAction,
    render,
  },
});
syncRoute();`;
        }
