/**
 * The external consumer smoke test: install, compile, validate, run — using nothing but
 * the published `@cynodia/axiom` package.
 */
import assert from 'node:assert/strict';
import {
  compileToHtml,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  findByNodeId,
  textOf,
  validateGraph,
} from '@cynodia/axiom';
import type { MemoryElement } from '@cynodia/axiom';
import {
  ACTION_DECREMENT,
  ACTION_INCREMENT,
  STATE_COUNT,
  UI_DECREMENT,
  UI_INCREMENT,
  createCounterGraph,
} from './counter.js';

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
assert.match(textOf(host.root), /Count: 0/);
step('the runtime renders it headlessly');

const button = (id: string): MemoryElement => {
  const found = findByNodeId(host.root, id)[0];
  assert.ok(found, `no button rendered for ${id}`);
  return found;
};

button(UI_INCREMENT).dispatch('click');
button(UI_INCREMENT).dispatch('click');
assert.equal(app.getState(STATE_COUNT), 2);
assert.match(textOf(host.root), /Count: 2/);
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

console.log('\nExternal consumer smoke test passed.');
