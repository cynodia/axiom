import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryElement, createMemoryHost, createRuntimeModuleSource, findAll, textOf } from '@cynodia/axiom-runtime';

test('the browser bundle is the compiled runtime with module syntax stripped', () => {
  const source = createRuntimeModuleSource();
  assert.match(source, /function createAxiomRuntime/);
  assert.match(source, /function createBrowserHost/);
  assert.doesNotMatch(source, /^export /m, 'exports are stripped for inline use');
  assert.doesNotMatch(source, /^import /m, 'the runtime resolves no modules at run time');
});

test('the memory host records navigation, confirmation and reports', () => {
  const host = createMemoryHost({ path: '/start', confirm: false });
  let changes = 0;
  host.onPathChange(() => {
    changes += 1;
  });

  assert.equal(host.getPath(), '/start');
  host.pushPath('/next');
  assert.equal(host.getPath(), '/next');
  assert.equal(host.confirm('sure?'), false);
  assert.deepEqual(host.confirmations, ['sure?']);
  assert.equal(changes, 0, 'pushing a path does not itself fire the listener');
});

test('the memory host issues stable identifiers and timestamps', () => {
  const host = createMemoryHost();
  assert.equal(host.uuid(), 'id-1');
  assert.notEqual(host.uuid(), 'id-1');
  assert.match(host.now(), /^2026-01-01T/);
});

test('memory elements support the DOM surface the renderer uses', () => {
  const host = createMemoryHost();
  const parent = host.document.createElement('div') as MemoryElement;
  const child = host.document.createElement('span') as MemoryElement;
  child.textContent = 'hello';
  parent.appendChild(child);
  parent.setAttribute('class', 'axiom-view');

  assert.equal(textOf(parent), 'hello');
  assert.equal(parent.getAttribute('class'), 'axiom-view');
  assert.equal(findAll(parent, (element) => element.tagName === 'span').length, 1);

  const replacement = host.document.createElement('b') as MemoryElement;
  parent.replaceChildren(replacement);
  assert.deepEqual(
    parent.children.map((element) => element.tagName),
    ['b'],
  );

  let received = 0;
  replacement.addEventListener('click', () => {
    received += 1;
  });
  replacement.dispatch('click');
  assert.equal(received, 1);
});

test('storage is opt-in', () => {
  assert.equal(createMemoryHost().storage, undefined);
  const host = createMemoryHost({ storage: true });
  host.storage?.write('k', 'v');
  assert.equal(host.storage?.read('k'), 'v');
  assert.equal(host.storage?.read('missing'), null);
});
