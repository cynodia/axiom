import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  enumType,
  field,
  fieldId,
  fieldLocation,
  identitySelector,
  itemFieldLocation,
  itemLocation,
  literal,
  nodeId,
  optionalType,
  primitiveType,
  ref,
  stateLocation,
  synchronizeEdges,
} from '@axiom/core';
import type {
  ActionDef,
  ButtonNode,
  ConditionalNode,
  ConstraintDef,
  ContainerNode,
  EntityDef,
  Expression,
  FieldDisplayNode,
  FormNode,
  InputNode,
  RepeatNode,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@axiom/core';

// Entities
const ENTITY_USER = nodeId('entity_user');
const ENTITY_ISSUE = nodeId('entity_issue');
const ENTITY_COMMENT = nodeId('entity_comment');
const ENTITY_FILTER = nodeId('entity_issue_filter');

// Fields
const F_USER_ID = fieldId('field_user_id');
const F_USER_NAME = fieldId('field_user_name');

const F_ISSUE_ID = fieldId('field_issue_id');
const F_ISSUE_TITLE = fieldId('field_issue_title');
const F_ISSUE_DESCRIPTION = fieldId('field_issue_description');
const F_ISSUE_STATUS = fieldId('field_issue_status');
const F_ISSUE_ASSIGNEE = fieldId('field_issue_assignee');
const F_ISSUE_CREATED = fieldId('field_issue_created');

const F_COMMENT_ID = fieldId('field_comment_id');
const F_COMMENT_ISSUE = fieldId('field_comment_issue');
const F_COMMENT_AUTHOR = fieldId('field_comment_author');
const F_COMMENT_BODY = fieldId('field_comment_body');
const F_COMMENT_CREATED = fieldId('field_comment_created');

const F_FILTER_STATUS = fieldId('field_filter_status');
const F_FILTER_SEARCH = fieldId('field_filter_search');

// State
const STATE_USERS = nodeId('state_users');
const STATE_ISSUES = nodeId('state_issues');
const STATE_COMMENTS = nodeId('state_comments');
const STATE_FILTER = nodeId('state_filter');
const STATE_DRAFT_ISSUE = nodeId('state_draft_issue');
const STATE_DRAFT_COMMENT = nodeId('state_draft_comment');
const STATE_CURRENT_ISSUE = nodeId('state_current_issue');

// Actions and parameters
const ACTION_OPEN_LIST = nodeId('action_open_list');
const ACTION_OPEN_CREATE = nodeId('action_open_create');
const ACTION_OPEN_ISSUE = nodeId('action_open_issue');
const PARAM_OPEN_ISSUE_ID = nodeId('param_open_issue_id');
const ACTION_CREATE_ISSUE = nodeId('action_create_issue');
const ACTION_DELETE_ISSUE = nodeId('action_delete_issue');
const ACTION_ADD_COMMENT = nodeId('action_add_comment');

// Routes
const ROUTE_LIST = nodeId('route_issue_list');
const ROUTE_CREATE = nodeId('route_issue_create');
const ROUTE_DETAIL = nodeId('route_issue_detail');
const PARAM_ROUTE_ISSUE_ID = nodeId('param_route_issue_id');

// UI
const UI_LIST_VIEW = nodeId('ui_list_view');
const UI_LIST_HEADER = nodeId('ui_list_header');
const UI_LIST_TITLE = nodeId('ui_list_title');
const UI_LIST_NEW_BUTTON = nodeId('ui_list_new_button');
const UI_LIST_FILTERS = nodeId('ui_list_filters');
const UI_FILTER_SEARCH = nodeId('ui_filter_search');
const UI_FILTER_STATUS = nodeId('ui_filter_status');
const UI_LIST_REPEAT = nodeId('ui_list_repeat');
const UI_ISSUE_ROW = nodeId('ui_issue_row');
const UI_ROW_TITLE = nodeId('ui_row_title');
const UI_ROW_STATUS = nodeId('ui_row_status');
const UI_ROW_OPEN = nodeId('ui_row_open');
const UI_LIST_EMPTY = nodeId('ui_list_empty');

const UI_DETAIL_VIEW = nodeId('ui_detail_view');
const UI_DETAIL_CONDITIONAL = nodeId('ui_detail_conditional');
const UI_DETAIL_BODY = nodeId('ui_detail_body');
const UI_DETAIL_BACK = nodeId('ui_detail_back');
const UI_DETAIL_TITLE_INPUT = nodeId('ui_detail_title_input');
const UI_DETAIL_TITLE_WARNING = nodeId('ui_detail_title_warning');
const UI_DETAIL_TITLE_WARNING_TEXT = nodeId('ui_detail_title_warning_text');
const UI_DETAIL_DESCRIPTION_INPUT = nodeId('ui_detail_description_input');
const UI_DETAIL_STATUS_INPUT = nodeId('ui_detail_status_input');
const UI_DETAIL_ASSIGNEE_INPUT = nodeId('ui_detail_assignee_input');
const UI_DETAIL_CREATED = nodeId('ui_detail_created');
const UI_DETAIL_DELETE = nodeId('ui_detail_delete');
const UI_COMMENTS_HEADING = nodeId('ui_comments_heading');
const UI_COMMENTS_REPEAT = nodeId('ui_comments_repeat');
const UI_COMMENT_ROW = nodeId('ui_comment_row');
const UI_COMMENT_AUTHOR = nodeId('ui_comment_author');
const UI_COMMENT_BODY = nodeId('ui_comment_body');
const UI_COMMENTS_EMPTY = nodeId('ui_comments_empty');
const UI_COMMENT_FORM = nodeId('ui_comment_form');
const UI_COMMENT_AUTHOR_INPUT = nodeId('ui_comment_author_input');
const UI_COMMENT_BODY_INPUT = nodeId('ui_comment_body_input');
const UI_DETAIL_MISSING = nodeId('ui_detail_missing');
const UI_DETAIL_MISSING_TEXT = nodeId('ui_detail_missing_text');
const UI_DETAIL_MISSING_BACK = nodeId('ui_detail_missing_back');

const UI_CREATE_VIEW = nodeId('ui_create_view');
const UI_CREATE_BACK = nodeId('ui_create_back');
const UI_CREATE_FORM = nodeId('ui_create_form');
const UI_CREATE_TITLE_INPUT = nodeId('ui_create_title_input');
const UI_CREATE_DESCRIPTION_INPUT = nodeId('ui_create_description_input');
const UI_CREATE_STATUS_INPUT = nodeId('ui_create_status_input');
const UI_CREATE_ASSIGNEE_INPUT = nodeId('ui_create_assignee_input');
const UI_CREATE_WARNING = nodeId('ui_create_warning');
const UI_CREATE_WARNING_TEXT = nodeId('ui_create_warning_text');

const CONSTRAINT_TITLE = nodeId('constraint_issue_title');
const CONSTRAINT_COMMENT_BODY = nodeId('constraint_comment_body');

// Iteration scopes used by filter/find predicates.
const SCOPE_ISSUE_FILTER = nodeId('scope_issue_filter');
const SCOPE_ISSUE_LOOKUP = nodeId('scope_issue_lookup');
const SCOPE_COMMENT_FILTER = nodeId('scope_comment_filter');
const SCOPE_USER_OPTION = nodeId('scope_user_option');

const STATUS_VALUES = ['todo', 'in_progress', 'done'];

const emptyIssue = {
  [F_ISSUE_ID]: '',
  [F_ISSUE_TITLE]: '',
  [F_ISSUE_DESCRIPTION]: '',
  [F_ISSUE_STATUS]: 'todo',
  [F_ISSUE_ASSIGNEE]: '',
  [F_ISSUE_CREATED]: '',
};

const emptyComment = {
  [F_COMMENT_ID]: '',
  [F_COMMENT_ISSUE]: '',
  [F_COMMENT_AUTHOR]: '',
  [F_COMMENT_BODY]: '',
  [F_COMMENT_CREATED]: '',
};

/** The current issue as selected by the active route — a read-only derived copy. */
const currentIssue: Expression = ref(STATE_CURRENT_ISSUE);

/**
 * Where the issue named by the route actually lives. Editing addresses this location, so
 * nothing depends on the derived copy sharing an object with the stored record.
 */
const routedIssue = itemLocation(
  stateLocation(STATE_ISSUES),
  identitySelector(F_ISSUE_ID, ref(PARAM_ROUTE_ISSUE_ID)),
);

const routedIssueField = (id: typeof F_ISSUE_TITLE) => fieldLocation(routedIssue, id);
const draftIssueField = (id: typeof F_ISSUE_TITLE) =>
  fieldLocation(stateLocation(STATE_DRAFT_ISSUE), id);
const draftCommentField = (id: typeof F_COMMENT_BODY) =>
  fieldLocation(stateLocation(STATE_DRAFT_COMMENT), id);

export function createIssueTrackerGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('issue-tracker', 'Issue Tracker');

  graph.addNode<EntityDef>({
    id: ENTITY_USER,
    kind: 'entity',
    name: 'User',
    identityFieldId: F_USER_ID,
    fields: [
      { id: F_USER_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_USER_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_ISSUE,
    kind: 'entity',
    name: 'Issue',
    identityFieldId: F_ISSUE_ID,
    fields: [
      { id: F_ISSUE_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_ISSUE_TITLE, name: 'Title', valueType: primitiveType('string'), required: true },
      { id: F_ISSUE_DESCRIPTION, name: 'Description', valueType: optionalType(primitiveType('string')) },
      { id: F_ISSUE_STATUS, name: 'Status', valueType: enumType(STATUS_VALUES), required: true },
      { id: F_ISSUE_ASSIGNEE, name: 'Assignee', valueType: optionalType(primitiveType('string')) },
      { id: F_ISSUE_CREATED, name: 'Created', valueType: optionalType(primitiveType('datetime')) },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_COMMENT,
    kind: 'entity',
    name: 'Comment',
    identityFieldId: F_COMMENT_ID,
    fields: [
      { id: F_COMMENT_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_COMMENT_ISSUE, name: 'Issue', valueType: primitiveType('string'), required: true },
      { id: F_COMMENT_AUTHOR, name: 'Author', valueType: optionalType(primitiveType('string')) },
      { id: F_COMMENT_BODY, name: 'Body', valueType: primitiveType('string'), required: true },
      { id: F_COMMENT_CREATED, name: 'Created', valueType: optionalType(primitiveType('datetime')) },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_FILTER,
    kind: 'entity',
    name: 'IssueFilter',
    fields: [
      { id: F_FILTER_STATUS, name: 'Status', valueType: enumType(['all', ...STATUS_VALUES]) },
      { id: F_FILTER_SEARCH, name: 'Search', valueType: optionalType(primitiveType('string')) },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_USERS,
    kind: 'state',
    name: 'users',
    valueType: collectionType(entityType(ENTITY_USER)),
    initialValue: [
      { [F_USER_ID]: 'user-1', [F_USER_NAME]: 'Ada' },
      { [F_USER_ID]: 'user-2', [F_USER_NAME]: 'Grace' },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_ISSUES,
    kind: 'state',
    name: 'issues',
    valueType: collectionType(entityType(ENTITY_ISSUE)),
    initialValue: [
      {
        [F_ISSUE_ID]: 'issue-1',
        [F_ISSUE_TITLE]: 'Describe the semantic UI vocabulary',
        [F_ISSUE_DESCRIPTION]: 'The renderer should understand only generic node kinds.',
        [F_ISSUE_STATUS]: 'in_progress',
        [F_ISSUE_ASSIGNEE]: 'user-1',
        [F_ISSUE_CREATED]: '2026-08-19T09:00:00.000Z',
      },
      {
        [F_ISSUE_ID]: 'issue-2',
        [F_ISSUE_TITLE]: 'Validate every graph before execution',
        [F_ISSUE_DESCRIPTION]: 'Dangling references must be rejected by the compiler.',
        [F_ISSUE_STATUS]: 'todo',
        [F_ISSUE_ASSIGNEE]: 'user-2',
        [F_ISSUE_CREATED]: '2026-08-20T09:00:00.000Z',
      },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_COMMENTS,
    kind: 'state',
    name: 'comments',
    valueType: collectionType(entityType(ENTITY_COMMENT)),
    initialValue: [
      {
        [F_COMMENT_ID]: 'comment-1',
        [F_COMMENT_ISSUE]: 'issue-1',
        [F_COMMENT_AUTHOR]: 'user-1',
        [F_COMMENT_BODY]: 'The runtime should stay free of application vocabulary.',
        [F_COMMENT_CREATED]: '2026-08-19T10:00:00.000Z',
      },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_FILTER,
    kind: 'state',
    name: 'filter',
    valueType: entityType(ENTITY_FILTER),
    initialValue: { [F_FILTER_STATUS]: 'all', [F_FILTER_SEARCH]: '' },
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_ISSUE,
    kind: 'state',
    name: 'draftIssue',
    valueType: entityType(ENTITY_ISSUE),
    draft: true,
    initialValue: { ...emptyIssue },
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_COMMENT,
    kind: 'state',
    name: 'draftComment',
    valueType: entityType(ENTITY_COMMENT),
    draft: true,
    initialValue: { ...emptyComment },
  });

  graph.addNode<StateDef>({
    id: STATE_CURRENT_ISSUE,
    kind: 'state',
    name: 'currentIssue',
    valueType: optionalType(entityType(ENTITY_ISSUE)),
    derivation: {
      kind: 'find',
      source: ref(STATE_ISSUES),
      scopeId: SCOPE_ISSUE_LOOKUP,
      predicate: binary('eq', field(ref(SCOPE_ISSUE_LOOKUP), F_ISSUE_ID), ref(PARAM_ROUTE_ISSUE_ID)),
    },
  });

  // ------------------------------------------------------------------ actions

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_LIST,
    kind: 'action',
    name: 'openIssueList',
    operations: [{ kind: 'navigate', routeId: ROUTE_LIST }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_CREATE,
    kind: 'action',
    name: 'openCreateIssue',
    operations: [{ kind: 'navigate', routeId: ROUTE_CREATE }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_ISSUE,
    kind: 'action',
    name: 'openIssue',
    parameters: [
      { id: PARAM_OPEN_ISSUE_ID, name: 'issueId', valueType: primitiveType('string'), required: true },
    ],
    operations: [
      {
        kind: 'navigate',
        routeId: ROUTE_DETAIL,
        parameters: { [PARAM_ROUTE_ISSUE_ID]: ref(PARAM_OPEN_ISSUE_ID) },
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_CREATE_ISSUE,
    kind: 'action',
    name: 'createIssue',
    preconditions: [call('required', field(ref(STATE_DRAFT_ISSUE), F_ISSUE_TITLE))],
    failureModes: [{ code: 'title-missing', message: 'An issue needs a title before it can be created.' }],
    operations: [
      {
        kind: 'insert',
        target: stateLocation(STATE_ISSUES),
        position: 'start',
        value: {
          kind: 'object',
          entityId: ENTITY_ISSUE,
          entries: [
            { fieldId: F_ISSUE_ID, value: call('uuid') },
            { fieldId: F_ISSUE_TITLE, value: field(ref(STATE_DRAFT_ISSUE), F_ISSUE_TITLE) },
            { fieldId: F_ISSUE_DESCRIPTION, value: field(ref(STATE_DRAFT_ISSUE), F_ISSUE_DESCRIPTION) },
            { fieldId: F_ISSUE_STATUS, value: field(ref(STATE_DRAFT_ISSUE), F_ISSUE_STATUS) },
            { fieldId: F_ISSUE_ASSIGNEE, value: field(ref(STATE_DRAFT_ISSUE), F_ISSUE_ASSIGNEE) },
            { fieldId: F_ISSUE_CREATED, value: call('now') },
          ],
        },
      },
      { kind: 'set', target: stateLocation(STATE_DRAFT_ISSUE), value: literal({ ...emptyIssue }) },
      { kind: 'navigate', routeId: ROUTE_LIST },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_DELETE_ISSUE,
    kind: 'action',
    name: 'deleteIssue',
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: 'Delete this issue permanently?',
    operations: [
      { kind: 'remove', target: routedIssue },
      { kind: 'navigate', routeId: ROUTE_LIST },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_ADD_COMMENT,
    kind: 'action',
    name: 'addComment',
    preconditions: [call('required', field(ref(STATE_DRAFT_COMMENT), F_COMMENT_BODY))],
    failureModes: [{ code: 'body-missing', message: 'A comment needs a body.' }],
    operations: [
      {
        kind: 'insert',
        target: stateLocation(STATE_COMMENTS),
        value: {
          kind: 'object',
          entityId: ENTITY_COMMENT,
          entries: [
            { fieldId: F_COMMENT_ID, value: call('uuid') },
            { fieldId: F_COMMENT_ISSUE, value: ref(PARAM_ROUTE_ISSUE_ID) },
            { fieldId: F_COMMENT_AUTHOR, value: field(ref(STATE_DRAFT_COMMENT), F_COMMENT_AUTHOR) },
            { fieldId: F_COMMENT_BODY, value: field(ref(STATE_DRAFT_COMMENT), F_COMMENT_BODY) },
            { fieldId: F_COMMENT_CREATED, value: call('now') },
          ],
        },
      },
      { kind: 'set', target: stateLocation(STATE_DRAFT_COMMENT), value: literal({ ...emptyComment }) },
    ],
  });

  // ----------------------------------------------------------------- list view

  graph.addNode<TextNode>({
    id: UI_LIST_TITLE,
    kind: 'text',
    value: 'Issues',
    presentation: { emphasis: 'strong' },
  });

  graph.addNode<ButtonNode>({
    id: UI_LIST_NEW_BUTTON,
    kind: 'button',
    label: 'New issue',
    actionId: ACTION_OPEN_CREATE,
  });

  graph.addNode<ContainerNode>({
    id: UI_LIST_HEADER,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_LIST_TITLE, UI_LIST_NEW_BUTTON],
  });

  graph.addNode<InputNode>({
    id: UI_FILTER_SEARCH,
    kind: 'input',
    label: 'Search',
    placeholder: 'Search titles',
    binding: { location: fieldLocation(stateLocation(STATE_FILTER), F_FILTER_SEARCH) },
  });

  graph.addNode<InputNode>({
    id: UI_FILTER_STATUS,
    kind: 'input',
    label: 'Status',
    binding: { location: fieldLocation(stateLocation(STATE_FILTER), F_FILTER_STATUS) },
  });

  graph.addNode<ContainerNode>({
    id: UI_LIST_FILTERS,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_FILTER_SEARCH, UI_FILTER_STATUS],
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_TITLE,
    kind: 'field-display',
    source: ref(UI_LIST_REPEAT),
    fieldId: F_ISSUE_TITLE,
    label: '',
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_STATUS,
    kind: 'field-display',
    source: ref(UI_LIST_REPEAT),
    fieldId: F_ISSUE_STATUS,
  });

  graph.addNode<ButtonNode>({
    id: UI_ROW_OPEN,
    kind: 'button',
    label: 'Open',
    actionId: ACTION_OPEN_ISSUE,
    arguments: { [PARAM_OPEN_ISSUE_ID]: field(ref(UI_LIST_REPEAT), F_ISSUE_ID) },
  });

  graph.addNode<ContainerNode>({
    id: UI_ISSUE_ROW,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_ROW_TITLE, UI_ROW_STATUS, UI_ROW_OPEN],
  });

  graph.addNode<TextNode>({
    id: UI_LIST_EMPTY,
    kind: 'text',
    value: 'No issues match the current filters.',
  });

  graph.addNode<RepeatNode>({
    id: UI_LIST_REPEAT,
    kind: 'repeat',
    itemAlias: 'issue',
    templateId: UI_ISSUE_ROW,
    emptyTemplateId: UI_LIST_EMPTY,
    source: {
      kind: 'filter',
      source: ref(STATE_ISSUES),
      scopeId: SCOPE_ISSUE_FILTER,
      predicate: binary(
        'and',
        binary(
          'or',
          binary('eq', field(ref(STATE_FILTER), F_FILTER_STATUS), literal('all')),
          binary(
            'eq',
            field(ref(SCOPE_ISSUE_FILTER), F_ISSUE_STATUS),
            field(ref(STATE_FILTER), F_FILTER_STATUS),
          ),
        ),
        binary(
          'or',
          call('is-empty', field(ref(STATE_FILTER), F_FILTER_SEARCH)),
          call(
            'contains',
            field(ref(SCOPE_ISSUE_FILTER), F_ISSUE_TITLE),
            field(ref(STATE_FILTER), F_FILTER_SEARCH),
          ),
        ),
      ),
    },
  });

  graph.addNode<ViewNode>({
    id: UI_LIST_VIEW,
    kind: 'view',
    name: 'IssueList',
    children: [UI_LIST_HEADER, UI_LIST_FILTERS, UI_LIST_REPEAT],
  });

  // --------------------------------------------------------------- detail view

  graph.addNode<ButtonNode>({
    id: UI_DETAIL_BACK,
    kind: 'button',
    label: 'Back to list',
    actionId: ACTION_OPEN_LIST,
    presentation: { role: 'secondary' },
  });

  graph.addNode<InputNode>({
    id: UI_DETAIL_TITLE_INPUT,
    kind: 'input',
    label: 'Title',
    binding: { location: routedIssueField(F_ISSUE_TITLE) },
  });

  graph.addNode<TextNode>({
    id: UI_DETAIL_TITLE_WARNING_TEXT,
    kind: 'text',
    value: 'Title is required.',
    presentation: { role: 'danger' },
  });

  graph.addNode<ConditionalNode>({
    id: UI_DETAIL_TITLE_WARNING,
    kind: 'conditional',
    condition: call('is-empty', field(currentIssue, F_ISSUE_TITLE)),
    whenTrue: [UI_DETAIL_TITLE_WARNING_TEXT],
  });

  graph.addNode<InputNode>({
    id: UI_DETAIL_DESCRIPTION_INPUT,
    kind: 'input',
    label: 'Description',
    inputHint: 'multiline',
    binding: { location: routedIssueField(F_ISSUE_DESCRIPTION) },
  });

  graph.addNode<InputNode>({
    id: UI_DETAIL_STATUS_INPUT,
    kind: 'input',
    label: 'Status',
    binding: { location: routedIssueField(F_ISSUE_STATUS) },
  });

  graph.addNode<InputNode>({
    id: UI_DETAIL_ASSIGNEE_INPUT,
    kind: 'input',
    label: 'Assignee',
    binding: { location: routedIssueField(F_ISSUE_ASSIGNEE) },
    options: {
      source: ref(STATE_USERS),
      scopeId: SCOPE_USER_OPTION,
      valueFieldId: F_USER_ID,
      labelFieldId: F_USER_NAME,
    },
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_DETAIL_CREATED,
    kind: 'field-display',
    source: currentIssue,
    fieldId: F_ISSUE_CREATED,
    label: 'Created',
  });

  graph.addNode<ButtonNode>({
    id: UI_DETAIL_DELETE,
    kind: 'button',
    label: 'Delete issue',
    destructive: true,
    actionId: ACTION_DELETE_ISSUE,
  });

  graph.addNode<TextNode>({
    id: UI_COMMENTS_HEADING,
    kind: 'text',
    value: 'Comments',
    presentation: { emphasis: 'strong' },
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_COMMENT_AUTHOR,
    kind: 'field-display',
    source: ref(UI_COMMENTS_REPEAT),
    fieldId: F_COMMENT_AUTHOR,
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_COMMENT_BODY,
    kind: 'field-display',
    source: ref(UI_COMMENTS_REPEAT),
    fieldId: F_COMMENT_BODY,
  });

  graph.addNode<ContainerNode>({
    id: UI_COMMENT_ROW,
    kind: 'container',
    layout: 'stack',
    children: [UI_COMMENT_AUTHOR, UI_COMMENT_BODY],
  });

  graph.addNode<TextNode>({
    id: UI_COMMENTS_EMPTY,
    kind: 'text',
    value: 'No comments yet.',
  });

  graph.addNode<RepeatNode>({
    id: UI_COMMENTS_REPEAT,
    kind: 'repeat',
    itemAlias: 'comment',
    templateId: UI_COMMENT_ROW,
    emptyTemplateId: UI_COMMENTS_EMPTY,
    source: {
      kind: 'filter',
      source: ref(STATE_COMMENTS),
      scopeId: SCOPE_COMMENT_FILTER,
      predicate: binary(
        'eq',
        field(ref(SCOPE_COMMENT_FILTER), F_COMMENT_ISSUE),
        ref(PARAM_ROUTE_ISSUE_ID),
      ),
    },
  });

  graph.addNode<InputNode>({
    id: UI_COMMENT_AUTHOR_INPUT,
    kind: 'input',
    label: 'Author',
    binding: { location: draftCommentField(F_COMMENT_AUTHOR) },
    options: {
      source: ref(STATE_USERS),
      scopeId: SCOPE_USER_OPTION,
      valueFieldId: F_USER_ID,
      labelFieldId: F_USER_NAME,
    },
  });

  graph.addNode<InputNode>({
    id: UI_COMMENT_BODY_INPUT,
    kind: 'input',
    label: 'Comment',
    inputHint: 'multiline',
    binding: { location: draftCommentField(F_COMMENT_BODY) },
  });

  graph.addNode<FormNode>({
    id: UI_COMMENT_FORM,
    kind: 'form',
    target: ref(STATE_DRAFT_COMMENT),
    children: [UI_COMMENT_AUTHOR_INPUT, UI_COMMENT_BODY_INPUT],
    submitActionId: ACTION_ADD_COMMENT,
    submitLabel: 'Post comment',
  });

  graph.addNode<ContainerNode>({
    id: UI_DETAIL_BODY,
    kind: 'container',
    layout: 'vertical',
    children: [
      UI_DETAIL_BACK,
      UI_DETAIL_TITLE_INPUT,
      UI_DETAIL_TITLE_WARNING,
      UI_DETAIL_DESCRIPTION_INPUT,
      UI_DETAIL_STATUS_INPUT,
      UI_DETAIL_ASSIGNEE_INPUT,
      UI_DETAIL_CREATED,
      UI_DETAIL_DELETE,
      UI_COMMENTS_HEADING,
      UI_COMMENTS_REPEAT,
      UI_COMMENT_FORM,
    ],
  });

  graph.addNode<TextNode>({
    id: UI_DETAIL_MISSING_TEXT,
    kind: 'text',
    value: 'That issue no longer exists.',
  });

  graph.addNode<ButtonNode>({
    id: UI_DETAIL_MISSING_BACK,
    kind: 'button',
    label: 'Back to list',
    actionId: ACTION_OPEN_LIST,
  });

  graph.addNode<ContainerNode>({
    id: UI_DETAIL_MISSING,
    kind: 'container',
    layout: 'vertical',
    children: [UI_DETAIL_MISSING_TEXT, UI_DETAIL_MISSING_BACK],
  });

  graph.addNode<ConditionalNode>({
    id: UI_DETAIL_CONDITIONAL,
    kind: 'conditional',
    condition: call('required', currentIssue),
    whenTrue: [UI_DETAIL_BODY],
    whenFalse: [UI_DETAIL_MISSING],
  });

  graph.addNode<ViewNode>({
    id: UI_DETAIL_VIEW,
    kind: 'view',
    name: 'IssueDetail',
    children: [UI_DETAIL_CONDITIONAL],
  });

  // --------------------------------------------------------------- create view

  graph.addNode<ButtonNode>({
    id: UI_CREATE_BACK,
    kind: 'button',
    label: 'Back to list',
    actionId: ACTION_OPEN_LIST,
    presentation: { role: 'secondary' },
  });

  graph.addNode<InputNode>({
    id: UI_CREATE_TITLE_INPUT,
    kind: 'input',
    label: 'Title',
    binding: { location: draftIssueField(F_ISSUE_TITLE) },
  });

  graph.addNode<InputNode>({
    id: UI_CREATE_DESCRIPTION_INPUT,
    kind: 'input',
    label: 'Description',
    inputHint: 'multiline',
    binding: { location: draftIssueField(F_ISSUE_DESCRIPTION) },
  });

  graph.addNode<InputNode>({
    id: UI_CREATE_STATUS_INPUT,
    kind: 'input',
    label: 'Status',
    binding: { location: draftIssueField(F_ISSUE_STATUS) },
  });

  graph.addNode<InputNode>({
    id: UI_CREATE_ASSIGNEE_INPUT,
    kind: 'input',
    label: 'Assignee',
    binding: { location: draftIssueField(F_ISSUE_ASSIGNEE) },
    options: {
      source: ref(STATE_USERS),
      scopeId: SCOPE_USER_OPTION,
      valueFieldId: F_USER_ID,
      labelFieldId: F_USER_NAME,
    },
  });

  graph.addNode<FormNode>({
    id: UI_CREATE_FORM,
    kind: 'form',
    target: ref(STATE_DRAFT_ISSUE),
    children: [
      UI_CREATE_TITLE_INPUT,
      UI_CREATE_DESCRIPTION_INPUT,
      UI_CREATE_STATUS_INPUT,
      UI_CREATE_ASSIGNEE_INPUT,
    ],
    submitActionId: ACTION_CREATE_ISSUE,
    submitLabel: 'Create issue',
  });

  graph.addNode<TextNode>({
    id: UI_CREATE_WARNING_TEXT,
    kind: 'text',
    value: 'Title is required.',
    presentation: { role: 'danger' },
  });

  graph.addNode<ConditionalNode>({
    id: UI_CREATE_WARNING,
    kind: 'conditional',
    condition: call('is-empty', field(ref(STATE_DRAFT_ISSUE), F_ISSUE_TITLE)),
    whenTrue: [UI_CREATE_WARNING_TEXT],
  });

  graph.addNode<ViewNode>({
    id: UI_CREATE_VIEW,
    kind: 'view',
    name: 'CreateIssue',
    children: [UI_CREATE_BACK, UI_CREATE_FORM, UI_CREATE_WARNING],
  });

  // ------------------------------------------------------------- constraints

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_TITLE,
    kind: 'constraint',
    name: 'Issue title present',
    entityId: ENTITY_ISSUE,
    severity: 'error',
    message: 'Every issue must have a title.',
    expression: call('required', field(ref(ENTITY_ISSUE), F_ISSUE_TITLE)),
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_COMMENT_BODY,
    kind: 'constraint',
    name: 'Comment body present',
    entityId: ENTITY_COMMENT,
    severity: 'error',
    message: 'Every comment must have a body.',
    expression: call('required', field(ref(ENTITY_COMMENT), F_COMMENT_BODY)),
  });

  // ------------------------------------------------------------------ routes

  graph.addNode<RouteDef>({ id: ROUTE_LIST, kind: 'route', name: 'issueList', path: '/', viewId: UI_LIST_VIEW });
  graph.addNode<RouteDef>({
    id: ROUTE_CREATE,
    kind: 'route',
    name: 'createIssue',
    path: '/issues/new',
    viewId: UI_CREATE_VIEW,
  });
  graph.addNode<RouteDef>({
    id: ROUTE_DETAIL,
    kind: 'route',
    name: 'issueDetail',
    path: '/issues/:id',
    viewId: UI_DETAIL_VIEW,
    parameters: [{ id: PARAM_ROUTE_ISSUE_ID, name: 'id', valueType: primitiveType('string') }],
  });

  synchronizeEdges(graph);
  return graph;
}

export const issueTrackerIds = {
  ENTITY_ISSUE,
  ENTITY_COMMENT,
  F_ISSUE_ID,
  F_ISSUE_TITLE,
  F_ISSUE_STATUS,
  F_ISSUE_DESCRIPTION,
  F_COMMENT_BODY,
  STATE_ISSUES,
  STATE_COMMENTS,
  STATE_FILTER,
  STATE_DRAFT_ISSUE,
  STATE_DRAFT_COMMENT,
  STATE_CURRENT_ISSUE,
  ACTION_CREATE_ISSUE,
  ACTION_DELETE_ISSUE,
  ACTION_ADD_COMMENT,
  ACTION_OPEN_ISSUE,
  PARAM_OPEN_ISSUE_ID,
  PARAM_ROUTE_ISSUE_ID,
  ROUTE_DETAIL,
  UI_LIST_VIEW,
  UI_LIST_REPEAT,
  UI_DETAIL_BODY,
  UI_CREATE_FORM,
  UI_FILTER_SEARCH,
  UI_DETAIL_TITLE_INPUT,
  UI_DETAIL_DELETE,
  UI_ROW_OPEN,
} as const;
