/**
 * The external consumer smoke test: install, compile, validate, run — using nothing but
 * the published `@cynodia/axiom` package.
 */
import assert from 'node:assert/strict';
import {
  AgentAPI,
  DEFAULT_THEME,
  RUNTIME_DIAGNOSTIC_CODES,
  compileToHtml,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  createThemeStylesheet,
  findByNodeId,
  textOf,
  validateGraph,
} from '@cynodia/axiom';
import type { MemoryElement } from '@cynodia/axiom';
import {
  ACTION_DECREMENT,
  ACTION_INCREMENT,
  STATE_COUNT,
  UI_CONTROLS,
  UI_DECREMENT,
  UI_DISPLAY,
  UI_INCREMENT,
  UI_TITLE,
  createCounterGraph,
} from './counter.js';
import {
  ACTION_RESERVE,
  F_LINE_ID,
  F_LINE_QUANTITY,
  F_PART_ID,
  F_PART_STOCK,
  STATE_LINES,
  STATE_PARTS,
  STATE_SORTED,
  STATE_TOTAL,
  UI_STOCK_INPUT,
  createPickingListGraph,
} from './orders.js';

function step(description: string): void {
  console.log(`  ok  ${description}`);
}

const graph = createCounterGraph();

const validation = validateGraph(graph);
assert.equal(
  validation.valid,
  true,
  `the graph should be valid:\n${validation.errors.map((problem) => problem.message).join('\n')}`,
);
step('a graph built through the public API validates');

const ir = compileToIR(graph);
assert.equal(ir.routes.length, 1);
assert.equal(ir.states.length, 1);
step('the compiler normalizes it into an IR');

const host = createMemoryHost({ path: '/' });
const app = createAxiomRuntime({ ir, rootElement: host.root, host });
app.start();
assert.match(textOf(host.root), /Count 0/);
step('the runtime renders it headlessly');

const button = (id: string): MemoryElement => {
  const found = findByNodeId(host.root, id)[0];
  assert.ok(found, `no button rendered for ${id}`);
  return found;
};

button(UI_INCREMENT).dispatch('click');
button(UI_INCREMENT).dispatch('click');
assert.equal(app.getState(STATE_COUNT), 2);
assert.match(textOf(host.root), /Count 2/);
step('clicking a button runs an action and updates the view');

button(UI_DECREMENT).dispatch('click');
assert.equal(app.getState(STATE_COUNT), 1);
step('a second action mutates the same state through its location');

const entry = app.getMutationLog().at(-1);
assert.equal(entry?.source, 'action');
assert.equal(entry?.description, STATE_COUNT);
assert.equal(entry?.outcome, 'committed');
step('every mutation is logged with its semantic location');

app.invokeAction(ACTION_DECREMENT);
const blocked = app.invokeAction(ACTION_DECREMENT);
assert.equal(blocked.ok, false, 'the constraint should refuse to take the count below zero');
assert.equal(app.getState(STATE_COUNT), 0, 'the refused action rolled back');
step('a constraint violation rolls the action back');

assert.equal(app.invokeAction(ACTION_INCREMENT).ok, true);
assert.equal(app.getState(STATE_COUNT), 1);
step('the application keeps working afterwards');

const page = compileToHtml(graph);
assert.match(page, /<!DOCTYPE html>/);
assert.match(page, /createAxiomRuntime/);
assert.doesNotMatch(page, /^import /m, 'the emitted page resolves no modules');
step('the compiler emits a self-contained page');

// ------------------------------------------------- presentation and UX intent

assert.equal(ir.theme.id, DEFAULT_THEME.id, 'a graph that declares no theme gets the default one');
assert.equal(ir.presentation[UI_INCREMENT].role, 'primary');
assert.equal(ir.presentation[UI_CONTROLS].uxRole, 'toolbar');
assert.equal(ir.presentation[UI_CONTROLS].layout.kind, 'horizontal', 'implied by the role, not declared');
assert.equal(ir.presentation[UI_CONTROLS].responsive.compact?.layout?.kind, 'vertical');
step('presentation intent is normalized into the IR');

const titleElement = findByNodeId(host.root, UI_TITLE)[0];
assert.ok(titleElement);
assert.equal(titleElement.tagName, 'h1', 'a text role becomes a real heading');
const controls = findByNodeId(host.root, UI_CONTROLS)[0];
assert.ok(controls);
const controlClasses = (controls.getAttribute('class') ?? '').split(' ');
assert.ok(controlClasses.includes('axiom-ux-toolbar'));
assert.ok(controlClasses.includes('axiom-layout-horizontal'));
assert.ok(controlClasses.includes('axiom-compact-layout-vertical'));
assert.equal(controls.getAttribute('role'), 'toolbar');
step('the renderer emits semantic classes and accessible structure');

const stylesheet = createThemeStylesheet(ir.theme);
assert.match(stylesheet, /--axiom-color-accent/);
assert.match(stylesheet, /\.axiom-ux-empty-state/);
assert.doesNotMatch(stylesheet, /count/i, 'the stylesheet knows nothing about the application');
step('a theme becomes a stylesheet, and the graph never sees CSS');

const agent = new AgentAPI(graph);
assert.deepEqual(
  agent.getPrimaryActions(nodeIdOf(graph)).map((action) => action.name),
  ['increment'],
);
assert.equal(agent.getUxRole(UI_CONTROLS), 'toolbar');
step('an agent can inspect UX intent');

const restyled = agent.transact(
  (transaction) => transaction.setTheme({ appearance: 'dark', defaults: { density: 'compact' } }),
  { reason: 'Use a denser dark identity' },
);
assert.equal(restyled.committed, true);
assert.equal(restyled.change?.operations.length, 1, 'an application-wide restyle is one change');
assert.equal(new AgentAPI(graph).resolvePresentation(UI_CONTROLS)?.density, 'compact');
assert.equal(compileToIR(graph).theme.appearance, 'dark');
step('an agent restyles the whole application by changing the theme');

assert.equal(app.getState(STATE_COUNT), 1, 'and the application behaves exactly as before');
step('changing the theme changed no behaviour');

assert.match(textOf(findByNodeId(host.root, UI_DISPLAY)[0]!), /1/);

// --------------------------------------------------- collection semantics

const picking = createPickingListGraph();
const pickingValidation = validateGraph(picking);
assert.equal(
  pickingValidation.valid,
  true,
  pickingValidation.errors.map((problem) => problem.message).join('\n'),
);

const pickingHost = createMemoryHost({ path: '/' });
const list = createAxiomRuntime({
  ir: compileToIR(picking),
  rootElement: pickingHost.root,
  host: pickingHost,
});
list.start();

assert.equal(list.getState(STATE_TOTAL), 2 * 30 + 4 * 10);
assert.match(textOf(pickingHost.root), /Total: 100/);
step('a projection can be summed into a derived total');

assert.deepEqual(
  (list.getState(STATE_SORTED) as Array<Record<string, string>>).map((line) => line[F_LINE_ID]),
  ['l2', 'l1'],
);
step('a collection can be ordered by a projected key');

const reserved = list.invokeAction(ACTION_RESERVE);
assert.equal(reserved.ok, true, JSON.stringify(reserved.diagnostics));
const stockOf = (partId: string): number =>
  (list.getState(STATE_PARTS) as Array<Record<string, number>>).find(
    (part) => (part[F_PART_ID] as unknown as string) === partId,
  )?.[F_PART_STOCK] as number;
assert.equal(stockOf('bolt'), 3);
assert.equal(stockOf('nut'), 5);
step('one action reduced the stock of every part its lines mention');

// Ask for more than exists, across two lines for the same part.
const lines = list.getState(STATE_LINES) as Array<Record<string, unknown>>;
lines.push({ [F_LINE_ID]: 'l3', ['field_line_part']: 'bolt', [F_LINE_QUANTITY]: 9, ['field_line_price']: 30 });
list.hydrateState(STATE_LINES, lines);

const refused = list.invokeAction(ACTION_RESERVE);
assert.equal(refused.ok, false, 'the aggregate guard should refuse this');
assert.equal(stockOf('bolt'), 3, 'and nothing may have moved');
assert.equal(stockOf('nut'), 5);
step('an aggregate guard refuses, and the whole action rolls back');

// A rule that governs the write path, not merely the value.
const stockControl = findByNodeId(pickingHost.root, UI_STOCK_INPUT).find(
  (element) => element.tagName !== 'label',
);
assert.ok(stockControl, 'the stock input is rendered — nothing is hidden from the user');

stockControl.value = '99';
stockControl.dispatch('input');
assert.equal(stockOf('bolt'), 3, 'raising stock through a direct binding was refused');
assert.ok(
  list
    .diagnostics()
    .some((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.TRANSITION_CONSTRAINT_VIOLATION),
  'and refused as a transition, naming the rule',
);
step('a transition rule protects canonical state from a direct input binding');

const lowering = findByNodeId(pickingHost.root, UI_STOCK_INPUT).find(
  (element) => element.tagName !== 'label',
);
assert.ok(lowering);
lowering.value = '1';
lowering.dispatch('input');
assert.equal(stockOf('bolt'), 1, 'a change the rule allows still goes through');
step('the same input still works for a change the rule permits');

console.log('\nExternal consumer smoke test passed.');

/** The counter's only view, found through the graph rather than hard-coded. */
function nodeIdOf(target: ReturnType<typeof createCounterGraph>) {
  const [view] = target.getNodesByKind('view');
  assert.ok(view);
  return view.id;
}
