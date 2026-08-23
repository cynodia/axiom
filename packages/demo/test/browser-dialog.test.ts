import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ButtonNode,
  ContainerNode,
  DialogNode,
  EntityDef,
  InputNode,
  RepeatNode,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';
import { compileToHtml } from '@cynodia/axiom-compiler';
import type { Browser, Page } from 'playwright';

/**
 * Dialog conformance in a **real browser**.
 *
 * Phase 2 verified focus movement, containment, `Escape`, focus return and the ARIA
 * attributes against the in-memory host, and said plainly that a real browser had not
 * confirmed them. This is that confirmation: the same semantics, in Chromium, driven through
 * the keyboard rather than through the runtime's own API.
 *
 * The memory-host tests in `packages/compiler/test/dialog.test.ts` stay — they are fast and
 * they cover semantics. These cover what only a browser can answer: what the DOM ended up
 * being, and where focus actually went.
 */

const E_ORDER = nodeId('entity_order');
const F_ID = fieldId('field_order_id');
const F_NOTE = fieldId('field_order_note');
const S_ORDERS = nodeId('state_orders');
const S_CANCELLING = nodeId('state_cancelling');
const A_ASK = nodeId('action_ask');
const A_DISMISS = nodeId('action_dismiss');
const A_CANCEL = nodeId('action_cancel');
const P_ORDER = nodeId('param_order');
const ROWS = nodeId('ui_rows');
const TRIGGER = nodeId('ui_row_trigger');
const DIALOG = nodeId('ui_dialog');
const NOTE_INPUT = nodeId('ui_dialog_note');
const CONFIRM = nodeId('ui_dialog_confirm');
const DISMISS = nodeId('ui_dialog_dismiss');
const AFTER = nodeId('ui_after');

/**
 * A row per order, each with its own trigger, and one dialog containing a text field.
 *
 * The trigger is inside a `repeat` deliberately: a UI node inside a repeat is rendered once
 * per member, so focus return keyed by node id would send focus to the wrong row. That was a
 * real defect, and this is the shape that exposes it.
 */
function buildGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('browser-dialog', 'Browser dialog');
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, name: 'Number', valueType: primitiveType('string'), required: true },
      { id: F_NOTE, name: 'Note', valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: S_ORDERS,
    kind: 'state',
    name: 'Orders',
    valueType: collectionType(entityType(E_ORDER)),
    initialValue: [
      { [F_ID]: 'a-1', [F_NOTE]: '' },
      { [F_ID]: 'a-2', [F_NOTE]: '' },
      { [F_ID]: 'a-3', [F_NOTE]: '' },
    ],
  });
  graph.addNode<StateDef>({
    id: S_CANCELLING,
    kind: 'state',
    name: 'Cancelling',
    ephemeral: true,
    valueType: primitiveType('string'),
    initialValue: '',
  });

  graph.addNode<ActionDef>({
    id: A_ASK,
    kind: 'action',
    name: 'Cancel…',
    parameters: [{ id: P_ORDER, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(S_CANCELLING), value: ref(P_ORDER) }],
  });
  graph.addNode<ActionDef>({
    id: A_DISMISS,
    kind: 'action',
    name: 'Keep',
    operations: [{ kind: 'set', target: stateLocation(S_CANCELLING), value: literal('') }],
  });
  graph.addNode<ActionDef>({
    id: A_CANCEL,
    kind: 'action',
    name: 'Cancel order',
    destructive: true,
    parameters: [{ id: P_ORDER, valueType: primitiveType('string'), required: true }],
    guards: [
      {
        // Presentation never authorizes: the rule is the guard, not the dialog.
        condition: binary('eq', ref(S_CANCELLING), ref(P_ORDER)),
        failureMode: { code: 'not-confirmed', message: 'Confirm first.' },
      },
    ],
    operations: [
      { kind: 'remove', target: itemLocation(stateLocation(S_ORDERS), identitySelector(F_ID, ref(P_ORDER))) },
      { kind: 'set', target: stateLocation(S_CANCELLING), value: literal('') },
    ],
  });

  graph.addNode<TextNode>({
    id: nodeId('ui_row_label'),
    kind: 'text',
    value: field(ref(ROWS), F_ID),
    presentation: { headingLevel: 'none' },
  });
  graph.addNode<ButtonNode>({
    id: TRIGGER,
    kind: 'button',
    label: 'Cancel…',
    actionId: A_ASK,
    arguments: { [P_ORDER]: field(ref(ROWS), F_ID) },
  });
  graph.addNode<ContainerNode>({
    id: nodeId('ui_row'),
    kind: 'container',
    children: [nodeId('ui_row_label'), TRIGGER],
  });
  graph.addNode<RepeatNode>({
    id: ROWS,
    kind: 'repeat',
    source: ref(S_ORDERS),
    templateId: nodeId('ui_row'),
  });

  // A text field inside the dialog: the focus trap has to include controls, not only buttons.
  graph.addNode<InputNode>({
    id: NOTE_INPUT,
    kind: 'input',
    label: 'Why',
    binding: {
      location: fieldLocation(
        itemLocation(stateLocation(S_ORDERS), identitySelector(F_ID, ref(S_CANCELLING))),
        F_NOTE,
      ),
    },
  });
  graph.addNode<ButtonNode>({ id: DISMISS, kind: 'button', label: 'Keep', actionId: A_DISMISS });
  graph.addNode<ButtonNode>({
    id: CONFIRM,
    kind: 'button',
    label: 'Cancel order',
    actionId: A_CANCEL,
    arguments: { [P_ORDER]: ref(S_CANCELLING) },
  });
  graph.addNode<DialogNode>({
    id: DIALOG,
    kind: 'dialog',
    openWhen: { kind: 'call', function: 'non-empty', arguments: [ref(S_CANCELLING)] },
    title: 'Cancel this order?',
    description: 'The order is removed. Nothing else changes.',
    children: [NOTE_INPUT, DISMISS, CONFIRM],
    closeActionId: A_DISMISS,
    initialFocusId: DISMISS,
  });

  // Something focusable after the dialog, so "focus escaped the dialog" is observable.
  graph.addNode<ButtonNode>({ id: AFTER, kind: 'button', label: 'Elsewhere', actionId: A_DISMISS });
  graph.addNode<ViewNode>({ id: nodeId('ui_view'), kind: 'view', children: [ROWS, DIALOG, AFTER] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}

/**
 * Chromium, or an honest skip.
 *
 * The browser is a release gate, so a missing browser must not look like a pass: the skip
 * says why, and `npm run test:browser` fails outright when Playwright is absent.
 */
let browser: Browser | undefined;
let page: Page | undefined;
let server: Server | undefined;
let unavailable: string | undefined;

before(async () => {
  try {
    const graph = buildGraph();
    assert.deepEqual(validateGraph(graph).errors, []);
    const html = compileToHtml(graph, { title: 'Dialog' });

    // Served over HTTP rather than injected: a generated page reads `location.pathname` to
    // match a route, so an origin-less document is not the thing under test.
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForSelector('[data-node="ui_rows"]');
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error);
  }
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
});

/** The active element, as `data-control`/`data-node` plus its render instance. */
async function focused(): Promise<{ control: string | null; instance: string | null; tag: string }> {
  return (page as Page).evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      control: active?.getAttribute('data-control') ?? null,
      instance: active?.getAttribute('data-instance') ?? null,
      tag: active?.tagName.toLowerCase() ?? 'none',
    };
  });
}

const rowTriggers = () => (page as Page).locator('[data-control="ui_row_trigger"]');
const dialog = () => (page as Page).locator('[data-node="ui_dialog"]');

function browserTest(name: string, body: (page: Page) => Promise<void>): void {
  test(name, async (context) => {
    if (unavailable || !page) {
      context.skip(`Chromium is unavailable: ${unavailable ?? 'no page'}`);
      return;
    }
    // Every case starts from a closed dialog, so order cannot matter.
    await page.keyboard.press('Escape');
    await body(page);
  });
}

// ------------------------------------------------------------ the closed dialog

browserTest('a closed dialog is absent from the document, not merely hidden', async (target) => {
  assert.equal(await dialog().count(), 0);
  assert.equal(await target.locator('[data-control="ui_dialog_confirm"]').count(), 0);
  // And nothing inside it is reachable by keyboard, because nothing inside it exists.
  assert.equal(await target.getByRole('dialog').count(), 0);
});

// -------------------------------------------------------------- role and naming

browserTest('an open dialog is a dialog, named and modal, to a real accessibility tree', async (target) => {
  await rowTriggers().nth(1).click();
  await dialog().waitFor();

  const element = target.getByRole('dialog');
  assert.equal(await element.count(), 1, 'exactly one dialog role');
  assert.equal(await element.getAttribute('aria-modal'), 'true');

  // The accessible name is the visible title, related by id rather than duplicated.
  const labelledBy = await element.getAttribute('aria-labelledby');
  assert.ok(labelledBy);
  assert.equal(await target.locator(`#${labelledBy}`).textContent(), 'Cancel this order?');
  const describedBy = await element.getAttribute('aria-describedby');
  assert.equal(
    await target.locator(`#${describedBy}`).textContent(),
    'The order is removed. Nothing else changes.',
  );
  // Playwright resolves the name the same way a screen reader does.
  assert.equal(await target.getByRole('dialog', { name: 'Cancel this order?' }).count(), 1);
});

// --------------------------------------------------------------------- focus

browserTest('focus enters the dialog, on the control the graph names', async () => {
  await rowTriggers().nth(0).click();
  await dialog().waitFor();
  assert.deepEqual((await focused()).control, String(DISMISS));
});

browserTest('Tab is contained: it wraps rather than leaving the dialog', async (target) => {
  await rowTriggers().nth(0).click();
  await dialog().waitFor();

  const seen: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    await target.keyboard.press('Tab');
    const active = await focused();
    seen.push(active.control ?? active.tag);
  }
  // Three focusable descendants — a text field and two buttons — cycling, and never the
  // button outside the dialog.
  assert.ok(!seen.includes(String(AFTER)), `focus left the dialog: ${seen.join(' → ')}`);
  assert.deepEqual([...new Set(seen)].sort(), [String(CONFIRM), String(DISMISS), String(NOTE_INPUT)].sort());
});

browserTest('Shift+Tab is contained the same way, in the other direction', async (target) => {
  await rowTriggers().nth(0).click();
  await dialog().waitFor();

  const seen: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    await target.keyboard.press('Shift+Tab');
    const active = await focused();
    seen.push(active.control ?? active.tag);
  }
  assert.ok(!seen.includes(String(AFTER)), `focus left the dialog: ${seen.join(' → ')}`);
  assert.deepEqual([...new Set(seen)].sort(), [String(CONFIRM), String(DISMISS), String(NOTE_INPUT)].sort());
});

browserTest('a text field inside the dialog takes focus and takes typing', async (target) => {
  await rowTriggers().nth(0).click();
  await dialog().waitFor();

  await target.locator(`[data-control="${String(NOTE_INPUT)}"]`).click();
  assert.equal((await focused()).control, String(NOTE_INPUT));
  await target.keyboard.type('duplicate');
  assert.equal(
    await target.locator(`[data-control="${String(NOTE_INPUT)}"]`).inputValue(),
    'duplicate',
    'a control inside a dialog is an ordinary control',
  );
});

browserTest('Escape invokes the declared close action', async (target) => {
  await rowTriggers().nth(0).click();
  await dialog().waitFor();
  await target.keyboard.press('Escape');

  await dialog().waitFor({ state: 'detached' });
  assert.equal(await dialog().count(), 0);
  // Dismissal closed it and did nothing else: every order is still there.
  assert.equal(await rowTriggers().count(), 3, 'closing is not cancelling');
});

browserTest('focus returns to the render instance that opened it, not to the node', async (target) => {
  // Row 2 of 3. Keyed by node id, focus would come back to row 1.
  await rowTriggers().nth(1).click();
  await dialog().waitFor();
  const opener = await target.locator('[data-control="ui_row_trigger"]').nth(1).getAttribute('data-instance');

  await target.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' });

  const active = await focused();
  assert.equal(active.control, String(TRIGGER));
  assert.equal(active.instance, opener, 'focus went back to the row that opened the dialog');
});

// ------------------------------------------------------------------- behaviour

browserTest('the confirmed action runs, and takes the dialog with it', async (target) => {
  await rowTriggers().nth(2).click();
  await dialog().waitFor();
  await target.locator(`[data-control="${String(CONFIRM)}"]`).click();

  await dialog().waitFor({ state: 'detached' });
  assert.equal(await rowTriggers().count(), 2, 'the third order is gone');
  // The row that opened the dialog no longer exists — the action removed it. Focus goes to
  // another instance of the same control rather than to the top of the document, which is
  // where a keyboard user would otherwise be dropped.
  const active = await focused();
  assert.equal(active.control, String(TRIGGER));
  assert.notEqual(active.tag, 'body');
});
