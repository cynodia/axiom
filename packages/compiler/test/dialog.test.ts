import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationGraph, literal, nodeId, primitiveType, ref, stateLocation, validateGraph } from '@cynodia/axiom-core';
import type { ActionDef, ButtonNode, DialogNode, RouteDef, StateDef, TextNode, ViewNode } from '@cynodia/axiom-core';
import { compileToIR } from '@cynodia/axiom-compiler';
import { MemoryElement, createAxiomRuntime, createMemoryHost, findAll } from '@cynodia/axiom-runtime';

/**
 * The dialog primitive.
 *
 * Phase 1 established that a dialog cannot be a toolkit pattern: a pattern only emits nodes
 * that already exist, and the half of a dialog that matters is behaviour no node described.
 * This is that behaviour, as canonical semantics — and these tests are the boundary between
 * what the graph says and what the runtime does.
 */

const OPEN = nodeId('state_open');
const ACTION_OPEN = nodeId('action_open');
const ACTION_CLOSE = nodeId('action_close');
const ACTION_ARCHIVE = nodeId('action_archive');
const TRIGGER = nodeId('ui_trigger');
const DIALOG = nodeId('ui_dialog');
const CONFIRM = nodeId('ui_confirm');
const CANCEL = nodeId('ui_cancel');

function confirmationGraph(overrides: Partial<DialogNode> = {}): ApplicationGraph {
  const graph = new ApplicationGraph('dialog', 'Dialog');
  graph.addNode<StateDef>({
    id: OPEN,
    kind: 'state',
    name: 'Confirming',
    ephemeral: true,
    valueType: primitiveType('boolean'),
    initialValue: false,
  });
  graph.addNode<StateDef>({
    id: nodeId('state_archived'),
    kind: 'state',
    name: 'Archived',
    valueType: primitiveType('boolean'),
    initialValue: false,
  });
  for (const [id, name, value] of [
    [ACTION_OPEN, 'Archive…', true],
    [ACTION_CLOSE, 'Keep', false],
  ] as const) {
    graph.addNode<ActionDef>({
      id,
      kind: 'action',
      name,
      operations: [{ kind: 'set', target: stateLocation(OPEN), value: literal(value) }],
    });
  }
  // Archiving both performs the operation and closes the dialog — because *this action* says
  // so, not because the runtime assumed dismissal means anything.
  graph.addNode<ActionDef>({
    id: ACTION_ARCHIVE,
    kind: 'action',
    name: 'Archive',
    destructive: true,
    operations: [
      { kind: 'set', target: stateLocation(nodeId('state_archived')), value: literal(true) },
      { kind: 'set', target: stateLocation(OPEN), value: literal(false) },
    ],
  });

  graph.addNode<ButtonNode>({ id: TRIGGER, kind: 'button', label: 'Archive…', actionId: ACTION_OPEN });
  graph.addNode<TextNode>({
    id: nodeId('ui_body'),
    kind: 'text',
    value: 'This cannot be undone.',
    presentation: { textRole: 'body', headingLevel: 'none' },
  });
  graph.addNode<ButtonNode>({ id: CANCEL, kind: 'button', label: 'Keep', actionId: ACTION_CLOSE });
  graph.addNode<ButtonNode>({
    id: CONFIRM,
    kind: 'button',
    label: 'Archive',
    actionId: ACTION_ARCHIVE,
    presentation: { uxRole: 'destructive-action' },
  });
  graph.addNode<DialogNode>({
    id: DIALOG,
    kind: 'dialog',
    openWhen: ref(OPEN),
    title: 'Archive this order?',
    description: 'It will no longer appear in the order list.',
    children: [nodeId('ui_body'), CANCEL, CONFIRM],
    closeActionId: ACTION_CLOSE,
    initialFocusId: CANCEL,
    returnFocusId: TRIGGER,
    ...overrides,
  });

  graph.addNode<ViewNode>({ id: nodeId('ui_view'), kind: 'view', children: [TRIGGER, DIALOG] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

function running(graph = confirmationGraph()) {
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  app.start();
  const dialog = () => findAll(host.root, (element) => element.getAttribute('data-node') === DIALOG)[0];
  const control = (id: string) =>
    findAll(host.root, (element) => element.getAttribute('data-control') === id)[0] as MemoryElement | undefined;
  return { app, host, dialog, control };
}

// ------------------------------------------------------------------ semantics

test('a closed dialog is absent, not hidden', () => {
  const { dialog, host } = running();
  assert.equal(dialog(), undefined);
  // Nothing inside it is reachable by keyboard or by assistive technology, because nothing
  // inside it exists.
  assert.equal(findAll(host.root, (element) => element.getAttribute('data-control') === CONFIRM).length, 0);
});

test('an open dialog announces itself correctly', () => {
  const { app, dialog } = running();
  app.invokeAction(ACTION_OPEN);

  const element = dialog();
  assert.ok(element);
  assert.equal(element.getAttribute('role'), 'dialog');
  assert.equal(element.getAttribute('aria-modal'), 'true');

  const labelledBy = element.getAttribute('aria-labelledby');
  assert.ok(labelledBy, 'it has an accessible name');
  const title = findAll(element, (child) => child.getAttribute('id') === labelledBy)[0];
  assert.equal(title.textContent, 'Archive this order?', 'and the name is the visible title');

  const describedBy = element.getAttribute('aria-describedby');
  const description = findAll(element, (child) => child.getAttribute('id') === describedBy)[0];
  assert.equal(description.textContent, 'It will no longer appear in the order list.');
});

test('a non-modal dialog is a dialog without containment', () => {
  const { app, dialog } = running(confirmationGraph({ modal: false, initialFocusId: undefined }));
  app.invokeAction(ACTION_OPEN);
  assert.equal(dialog().getAttribute('role'), 'dialog');
  assert.equal(dialog().getAttribute('aria-modal'), null);
});

// ---------------------------------------------------------------------- focus

test('focus moves to the declared control when it opens', () => {
  const { app, control } = running();
  app.invokeAction(ACTION_OPEN);
  assert.equal(control(CANCEL)?.focused, true, 'the declared initial focus');
  assert.equal(control(CONFIRM)?.focused, false);
});

test('focus returns to the trigger when it closes', () => {
  const { app, control } = running();
  app.invokeAction(ACTION_OPEN);
  const trigger = control(TRIGGER) as MemoryElement;
  trigger.focused = false;

  app.invokeAction(ACTION_CLOSE);
  assert.equal(control(TRIGGER)?.focused, true, 'focus went back to what opened it');
});

test('a re-render while open does not steal focus back', () => {
  // A full re-render happens on every state change. Moving focus each time would fight the
  // person using the dialog.
  const { app, control } = running();
  app.invokeAction(ACTION_OPEN);
  const confirm = control(CONFIRM) as MemoryElement;
  confirm.focus();
  (control(CANCEL) as MemoryElement).focused = false;

  app.render();
  assert.equal(control(CANCEL)?.focused, false, 'focus was not pulled back to the initial control');
});

test('Tab wraps inside a modal dialog', () => {
  const { app, dialog, control } = running();
  app.invokeAction(ACTION_OPEN);

  // Focus is on the last focusable control; Tab must wrap to the first, not leave.
  (control(CONFIRM) as MemoryElement).focus();
  (dialog() as MemoryElement).dispatch('keydown', { key: 'Tab' });
  assert.equal(control(CANCEL)?.focused, true, 'wrapped to the first control');

  // And Shift+Tab from the first wraps to the last.
  (control(CANCEL) as MemoryElement).focus();
  (dialog() as MemoryElement).dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(control(CONFIRM)?.focused, true);
});

// ------------------------------------------------------------------ dismissal

test('Escape invokes the declared close action and nothing else', () => {
  const { app, dialog } = running();
  app.invokeAction(ACTION_OPEN);
  (dialog() as MemoryElement).dispatch('keydown', { key: 'Escape' });

  assert.equal(app.getState(OPEN), false, 'it closed');
  assert.equal(app.getState(nodeId('state_archived')), false, 'and nothing was archived');
});

test('closing is not cancelling: the runtime infers no business meaning', () => {
  // The archive action closes the dialog itself, because it says so. Dismissal does the
  // opposite of nothing only when an action makes it so.
  const { app } = running();
  app.invokeAction(ACTION_OPEN);
  app.invokeAction(ACTION_ARCHIVE);
  assert.equal(app.getState(nodeId('state_archived')), true);
  assert.equal(app.getState(OPEN), false);
});

// ------------------------------------------------------------------ validation

test('a dialog with no accessible name is rejected', () => {
  const result = validateGraph(confirmationGraph({ title: '   ' }));
  const problem = result.errors.find((error) => error.code === 'INVALID_DIALOG');
  assert.equal(problem?.details?.reason, 'empty-title');
});

test('initial focus must be inside the dialog, and return focus outside it', () => {
  const inside = validateGraph(confirmationGraph({ initialFocusId: TRIGGER }));
  assert.equal(
    inside.errors.find((error) => error.code === 'INVALID_DIALOG')?.details?.reason,
    'focus-target-outside',
  );

  const outside = validateGraph(confirmationGraph({ returnFocusId: CONFIRM }));
  assert.equal(
    outside.errors.find((error) => error.code === 'INVALID_DIALOG')?.details?.reason,
    'return-focus-inside',
  );
});

test('an unknown focus target is rejected, and a close action must be an action', () => {
  const unknown = validateGraph(confirmationGraph({ initialFocusId: nodeId('ui_absent') }));
  assert.equal(
    unknown.errors.find((error) => error.code === 'INVALID_DIALOG')?.details?.reason,
    'unknown-focus-target',
  );

  const notAnAction = validateGraph(confirmationGraph({ closeActionId: TRIGGER }));
  assert.ok(notAnAction.errors.some((error) => error.code === 'INVALID_ACTION_REF'));
});

test('a non-modal dialog that moves focus is a warning, not an error', () => {
  const result = validateGraph(confirmationGraph({ modal: false }));
  assert.deepEqual(result.errors, []);
  assert.equal(
    result.warnings.find((warning) => warning.code === 'INVALID_DIALOG')?.details?.reason,
    'non-modal-initial-focus',
  );
});

// -------------------------------------------------------- portability

test('dialog semantics survive serialization and name no renderer', () => {
  const graph = confirmationGraph();
  const json = graph.serialize();
  assert.doesNotMatch(json, /=>|function\s*\(/, 'no callback');
  for (const forbidden of [/z-?index/i, /position:/i, /<dialog/i, /\bdiv\b/, /\bpx\b/]) {
    assert.doesNotMatch(json, forbidden, `the graph leaked ${String(forbidden)}`);
  }

  const restored = new ApplicationGraph('x', 'x');
  restored.restore(json);
  assert.equal(restored.serialize(), json);
  assert.deepEqual(validateGraph(restored).errors, []);
});

// ------------------------------- focus return inside a repeat, and non-button controls

/** A list of rows, each with a trigger, and one dialog outside the repeat. */
function repeatedTriggerGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('rows', 'Rows');
  graph.addNode({
    id: nodeId('entity_order'),
    kind: 'entity',
    identityFieldId: nodeId('field_order_id') as never,
    fields: [{ id: nodeId('field_order_id') as never, valueType: primitiveType('string'), required: true }],
  } as never);
  graph.addNode({
    id: nodeId('state_orders'),
    kind: 'state',
    name: 'Orders',
    valueType: { kind: 'collection', itemType: { kind: 'entity', entityId: nodeId('entity_order') } },
    initialValue: [{ field_order_id: 'order-1' }, { field_order_id: 'order-2' }],
  } as never);
  graph.addNode<StateDef>({
    id: OPEN,
    kind: 'state',
    name: 'Confirming',
    ephemeral: true,
    valueType: primitiveType('boolean'),
    initialValue: false,
  });
  graph.addNode<StateDef>({
    id: nodeId('state_note'),
    kind: 'state',
    name: 'Note',
    draft: true,
    valueType: primitiveType('string'),
    initialValue: '',
  });
  for (const [id, value] of [
    [ACTION_OPEN, true],
    [ACTION_CLOSE, false],
  ] as const) {
    graph.addNode<ActionDef>({
      id,
      kind: 'action',
      name: String(id),
      operations: [{ kind: 'set', target: stateLocation(OPEN), value: literal(value) }],
    });
  }

  graph.addNode<ButtonNode>({ id: TRIGGER, kind: 'button', label: 'Archive…', actionId: ACTION_OPEN });
  graph.addNode({
    id: nodeId('ui_rows'),
    kind: 'repeat',
    source: ref(nodeId('state_orders')),
    templateId: TRIGGER,
  } as never);

  // A dialog whose first focusable control is a text field, not a button.
  graph.addNode({
    id: nodeId('ui_note'),
    kind: 'input',
    binding: { location: stateLocation(nodeId('state_note')) },
    label: 'Why?',
  } as never);
  graph.addNode<ButtonNode>({ id: CANCEL, kind: 'button', label: 'Keep', actionId: ACTION_CLOSE });
  graph.addNode<DialogNode>({
    id: DIALOG,
    kind: 'dialog',
    openWhen: ref(OPEN),
    title: 'Archive?',
    children: [nodeId('ui_note'), CANCEL],
    closeActionId: ACTION_CLOSE,
  });

  graph.addNode<ViewNode>({ id: nodeId('ui_view'), kind: 'view', children: [nodeId('ui_rows'), DIALOG] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

test('focus returns to the row the dialog was opened from, not the last row rendered', () => {
  // A trigger inside a `repeat` is many rendered elements. Returning focus by node id sends a
  // keyboard user to whichever row happened to render last — for a long list, never the right
  // one. Focus return is therefore keyed by the render instance that actually held it.
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(repeatedTriggerGraph()), rootElement: host.root, host });
  app.start();

  const triggers = findAll(host.root, (element) => element.getAttribute('data-control') === TRIGGER);
  assert.equal(triggers.length, 2, 'one trigger per row');
  const firstRow = triggers[0] as MemoryElement;
  const firstInstance = firstRow.getAttribute('data-instance');
  firstRow.focus();

  app.invokeAction(ACTION_OPEN);
  app.invokeAction(ACTION_CLOSE);

  const after = findAll(host.root, (element) => element.getAttribute('data-control') === TRIGGER) as MemoryElement[];
  const focused = after.find((element) => element.focused);
  assert.ok(focused, 'focus went back to a trigger');
  assert.equal(
    focused.getAttribute('data-instance'),
    firstInstance,
    'and to the row it was opened from, not the last one rendered',
  );
});

test('a dialog containing a text field traps focus at that field', () => {
  // Registering only buttons left every other control outside the trap, so Shift+Tab from the
  // first button escaped the dialog instead of wrapping to the input.
  const host = createMemoryHost({ path: '/' });
  const app = createAxiomRuntime({ ir: compileToIR(repeatedTriggerGraph()), rootElement: host.root, host });
  app.start();
  app.invokeAction(ACTION_OPEN);

  const dialog = findAll(host.root, (element) => element.getAttribute('data-node') === DIALOG)[0] as MemoryElement;
  const note = findAll(host.root, (element) => element.getAttribute('data-control') === 'ui_note')[0] as MemoryElement;
  const cancel = findAll(host.root, (element) => element.getAttribute('data-control') === CANCEL)[0] as MemoryElement;

  assert.equal(note.focused, true, 'the first focusable control is the input, and it received focus');

  // Shift+Tab from the first control wraps to the last, rather than leaving the dialog.
  dialog.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(cancel.focused, true, 'wrapped to the last control');

  // And Tab from the last wraps back to the input.
  cancel.focus();
  dialog.dispatch('keydown', { key: 'Tab' });
  assert.equal(note.focused, true, 'wrapped back to the input');
});
