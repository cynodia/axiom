import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryElement, createMemoryHost, createRuntimeModuleSource, findAll, textOf } from '@cynodia/axiom-runtime';

test('the browser bundle is the compiled runtime with module syntax stripped', () => {
  const source = createRuntimeModuleSource();
  assert.match(source, /function createAxiomRuntime/);
  assert.match(source, /function createBrowserHost/);
  assert.doesNotMatch(source, /^export /m, 'exports are stripped for inline use');
  assert.doesNotMatch(source, /^import /m, 'the runtime resolves no modules at run time');
});

test('the browser bundle depends on nothing a browser does not have', () => {
  // The client path is not "mostly browser-safe". A single Node reference in it — a
  // `node:` import, a filesystem call, `process`, `require` — is a page that throws on load,
  // and the failure appears in a browser rather than in this build.
  const source = createRuntimeModuleSource();
  for (const forbidden of [
    /\bnode:[a-z_]+/,
    /\brequire\s*\(/,
    /\bprocess\.[a-z]/i,
    /\b__dirname\b/,
    /\bBuffer\b/,
  ]) {
    assert.doesNotMatch(source, forbidden, `the bundle must not reference ${String(forbidden)}`);
  }
  assert.match(source, /function createHttpRemoteGateway/, 'the remote gateway is bundled');
});

test('the gateway types are structurally the core types they stand in for', () => {
  // `runtime-types.ts` re-declares NodeId rather than importing it, because a value import
  // would be stripped from the browser bundle. That only works while the two declarations
  // are identical: the moment they differ, `createHttpRemoteGateway()` stops typechecking
  // as a `RemoteGateway` and every consumer needs a cast.
  const local = readFileSync(
    new URL('../../runtime/src/runtime-types.ts', import.meta.url),
    'utf8',
  );
  const core = readFileSync(new URL('../../core/src/ids.ts', import.meta.url), 'utf8');
  const declaration = /export type NodeId = ([^;]+);/;
  assert.equal(
    declaration.exec(local)?.[1],
    declaration.exec(core)?.[1],
    'runtime-types.ts and core/ids.ts declare NodeId differently',
  );
});

test('the group field ids the renderer uses are the ones core reserves', () => {
  // Same reason as `NodeId` above: the two group positions are re-declared locally because
  // a value the browser bundle imports from core would be stripped out of it. A drift here
  // would make the runtime read fields nothing ever writes, silently.
  const local = readFileSync(new URL('../../runtime/src/group-fields.ts', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../../core/src/group.ts', import.meta.url), 'utf8');
  for (const name of ['GROUP_KEY_FIELD', 'GROUP_ITEMS_FIELD']) {
    const value = new RegExp(`${name}[^=]*= (?:fieldId\\()?'([^']+)'`);
    assert.equal(
      value.exec(local)?.[1],
      value.exec(core)?.[1],
      `${name} differs between the runtime and core`,
    );
  }
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
