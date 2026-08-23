import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as facade from '@cynodia/axiom';
import {
  ApplicationGraph,
  AgentAPI,
  BUILTIN_FUNCTIONS,
  UI_NODE_KINDS,
  CONTROL_VARIANTS,
  DENSITIES,
  DEVICE_CLASSES,
  EMPHASIS_LEVELS,
  EXPRESSION_KINDS,
  ICON_NAMES,
  LAYOUT_KINDS,
  OPERATION_KINDS,
  PRESENTATION_ROLES,
  RUNTIME_DIAGNOSTIC_CODES,
  SPACING_TOKENS,
  SURFACE_ROLES,
  TEXT_ROLES,
  TREATMENTS,
  UX_ROLES,
  VALIDATION_CODES,
  VALUE_FORMAT_KINDS,
  collectionType,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  entityType,
  every,
  fieldId,
  filter,
  find,
  flatten,
  isEmptyValue,
  isPresent,
  literal,
  map,
  nodeId,
  optionalType,
  primitiveType,
  ref,
  some,
  toBoolean,
} from '@cynodia/axiom';
import type { EntityDef, RouteDef, StateDef, ViewNode } from '@cynodia/axiom';
import { SERVER_DIAGNOSTIC_CODES } from '@cynodia/axiom-server';
import { runMinimalExample } from '@cynodia/axiom-demo/minimal';
import { runSeatingExample } from '@cynodia/axiom-demo/minimal-server';

/**
 * Documentation is part of the public semantic contract, so it is tested like the rest of
 * it. These tests fail on drift in either direction: a documented symbol, code or token
 * that no longer exists, and an implemented one that is not documented.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const docsDir = path.join(repoRoot, 'docs');

const DOC_FILES = readdirSync(docsDir).filter((name) => name.endsWith('.md')).sort();

function read(file: string): string {
  return readFileSync(path.join(repoRoot, file), 'utf8');
}

const README = read('README.md');
const ALL_DOCS = new Map<string, string>([
  ['README.md', README],
  ...DOC_FILES.map((name) => [`docs/${name}`, read(`docs/${name}`)] as [string, string]),
]);
const EVERY_DOC = [...ALL_DOCS.values()].join('\n');

/** Every fenced TypeScript block in the documentation. */
function codeBlocks(): string[] {
  const blocks: string[] = [];
  for (const source of ALL_DOCS.values()) {
    for (const match of source.matchAll(/```ts\n([\s\S]*?)```/g)) {
      blocks.push(match[1]);
    }
  }
  return blocks;
}

// ------------------------------------------------------------ the README example

test('the README example is the compiled example, character for character', () => {
  const inReadme = /<!-- readme-example:start -->\n```ts\n([\s\S]*?)```\n<!-- readme-example:end -->/.exec(
    README,
  )?.[1];
  const inSource = /\/\/ readme-example:start\n([\s\S]*?)\/\/ readme-example:end/.exec(
    read('packages/demo/src/minimal.ts'),
  )?.[1];

  assert.ok(inReadme, 'the README has no marked example');
  assert.ok(inSource, 'packages/demo/src/minimal.ts has no marked example');
  assert.equal(inReadme, inSource, 'the README example and the compiled example have drifted apart');
});

test('the README full-stack example is the compiled example, character for character', () => {
  const inReadme = /<!-- readme-server-example:start -->\n```ts\n([\s\S]*?)```\n<!-- readme-server-example:end -->/.exec(
    README,
  )?.[1];
  const inSource = /\/\/ readme-server-example:start\n([\s\S]*?)\/\/ readme-server-example:end/.exec(
    read('packages/demo/src/minimal-server.ts'),
  )?.[1];

  assert.ok(inReadme, 'the README has no marked full-stack example');
  assert.ok(inSource, 'packages/demo/src/minimal-server.ts has no marked example');
  assert.equal(inReadme, inSource, 'the README full-stack example and the compiled one have drifted apart');
});

test('the README full-stack example runs, against a real authority over HTTP', async () => {
  // The point of the example is that one graph produces both halves. Running it proves the
  // authority enforced the guard the client never evaluated, and recorded the caller the
  // client never sent.
  assert.deepEqual(await runSeatingExample(), ['a1: ada', 'a2: free']);
});

test('the README example runs and produces the documented result', () => {
  // The README says three increments succeed and the fourth is rolled back.
  assert.equal(runMinimalExample(), 3);
});

// ------------------------------------------------------------- symbol existence

test('every symbol the documentation imports is exported by the facade', () => {
  const missing = new Set<string>();
  for (const block of codeBlocks()) {
    for (const statement of block.matchAll(/import(?: type)? \{([^}]*)\} from '@cynodia\/axiom'/g)) {
      for (const name of statement[1].split(',').map((entry) => entry.trim()).filter(Boolean)) {
        if (!(name in facade)) {
          missing.add(name);
        }
      }
    }
  }
  // Type-only exports are erased at run time, so only value exports can be checked here.
  const typeOnly = new Set([
    'ActionDef', 'ButtonNode', 'ConstraintDef', 'ContainerNode', 'EntityDef', 'Expression',
    'FieldDisplayNode', 'FormNode', 'InputNode', 'MemoryElement', 'RepeatNode', 'RouteDef',
    'StateDef', 'TextNode', 'TransitionConstraintDef', 'ViewNode',
  ]);
  assert.deepEqual([...missing].filter((name) => !typeOnly.has(name)), []);
});

test('every documented method exists on the object the documentation calls it on', () => {
  const graph = new ApplicationGraph('doc', 'Doc');
  graph.addNode<ViewNode>({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  const host = createMemoryHost();
  const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
  const agent = new AgentAPI(graph);
  const transaction = agent.beginTransaction();

  const receivers: Record<string, object> = {
    graph,
    app,
    agent,
    tx: transaction,
    transaction,
  };
  const missing: string[] = [];
  for (const [receiver, target] of Object.entries(receivers)) {
    const pattern = new RegExp(`\\b${receiver}\\.(\\w+)\\s*[(<]`, 'g');
    for (const match of EVERY_DOC.matchAll(pattern)) {
      const member = match[1];
      if (!(member in (target as Record<string, unknown>))) {
        missing.push(`${receiver}.${member}`);
      }
    }
  }
  transaction.rollback();
  assert.deepEqual([...new Set(missing)], []);
});

// -------------------------------------------------------------- diagnostic codes

test('every validation code is documented, and every documented code exists', () => {
  const validation = ALL_DOCS.get('docs/VALIDATION.md');
  assert.ok(validation);
  const codes = Object.values(VALIDATION_CODES);

  const undocumented = codes.filter((code) => !validation.includes(code));
  assert.deepEqual(undocumented, [], 'validation codes missing from docs/VALIDATION.md');

  // Anything that looks like a code in any document must be a real one.
  const known = new Set<string>([
    ...codes,
    ...Object.values(RUNTIME_DIAGNOSTIC_CODES),
    ...Object.values(SERVER_DIAGNOSTIC_CODES),
  ]);
  const invented = new Set<string>();
  for (const match of EVERY_DOC.matchAll(/`([A-Z][A-Z0-9_]{6,})`/g)) {
    if (!known.has(match[1])) {
      invented.add(match[1]);
    }
  }
  // Vocabulary arrays and type names are also written in capitals.
  const notCodes = new Set([
    'VALIDATION_CODES', 'RUNTIME_DIAGNOSTIC_CODES', 'DEFAULT_THEME', 'COMPACT_DARK_THEME',
    'EXPRESSION_KINDS', 'OPERATION_KINDS', 'BUILTIN_FUNCTIONS', 'AGGREGATE_FUNCTIONS',
    'PRESENTATION_ROLES', 'UX_ROLES', 'EMPHASIS_LEVELS', 'DENSITIES', 'TEXT_ROLES',
    'SURFACE_ROLES', 'TREATMENTS', 'CONTROL_VARIANTS', 'ICON_NAMES', 'LAYOUT_KINDS',
    'SPACING_TOKENS', 'SIZING_VALUES', 'BOUNDED_SIZES', 'ALIGNMENTS', 'JUSTIFICATIONS',
    'DEVICE_CLASSES', 'VALUE_FORMAT_KINDS', 'SEMANTIC_COLOR_ROLES', 'EDGE_KINDS',
    'INHERITED_PROPERTIES', 'HEADING_LEVELS', 'TEXT_ROLE_HEADING_LEVELS', 'MUST', 'MUST_NOT',
    // Authority vocabulary: exported constants, not diagnostic codes.
    'PRINCIPAL', 'AUTHORITIES', 'SERVER_IR_CONTRACT', 'SERVER_DIAGNOSTIC_CODES', 'PROTOCOL_VERSION',
    'AUTHORITY', 'EXECUTION', 'TRUST', 'TRANSACTION', 'CONCURRENCY', 'PROTOCOL', 'SERIALIZATION',
    'DISCLOSABLE_DETAIL_KEYS', 'PORTABILITY', 'IDEMPOTENCY', 'STARTUP', 'CHANGES',
    'AUTHORING_METADATA_KEY', 'BROWSER_RENDERER_CAPABILITIES',
    'GROUP_KEY_FIELD', 'GROUP_ITEMS_FIELD', 'UI_NODE_KINDS', 'SERVER_IR_CONTRACTS',
    'SERVER_IR_LATEST_CONTRACT', 'TYPE_REF_KINDS', 'SEMANTIC_NODE_KINDS',
  ]);
  assert.deepEqual([...invented].filter((name) => !notCodes.has(name)), []);
});

test('every server diagnostic code is documented with a meaning', () => {
  const authority = ALL_DOCS.get('docs/AUTHORITY.md');
  assert.ok(authority);
  const undocumented = Object.values(SERVER_DIAGNOSTIC_CODES).filter(
    (code) => !authority.includes(code),
  );
  assert.deepEqual(undocumented, [], 'server codes missing from docs/AUTHORITY.md');
});

test('every runtime diagnostic code is documented with a meaning', () => {
  const runtime = ALL_DOCS.get('docs/RUNTIME.md');
  assert.ok(runtime);
  const undocumented = Object.values(RUNTIME_DIAGNOSTIC_CODES).filter(
    (code) => !runtime.includes(code),
  );
  assert.deepEqual(undocumented, [], 'runtime codes missing from docs/RUNTIME.md');
});

// ------------------------------------------------------------------ vocabularies

test('every construct in the public vocabulary is documented', () => {
  const expressions = ALL_DOCS.get('docs/EXPRESSIONS.md');
  const actions = ALL_DOCS.get('docs/ACTIONS_TRANSACTIONS.md');
  const presentation = ALL_DOCS.get('docs/PRESENTATION.md');
  assert.ok(expressions && actions && presentation);

  const gaps: string[] = [];
  const require_ = (source: string, where: string, values: readonly string[], label: string): void => {
    for (const value of values) {
      if (!source.includes(value)) {
        gaps.push(`${label} "${value}" is not documented in ${where}`);
      }
    }
  };

  require_(expressions, 'EXPRESSIONS.md', BUILTIN_FUNCTIONS, 'builtin');
  require_(expressions, 'EXPRESSIONS.md', EXPRESSION_KINDS, 'expression kind');
  require_(actions, 'ACTIONS_TRANSACTIONS.md', OPERATION_KINDS, 'operation');
  require_(ALL_DOCS.get('docs/UI.md') ?? '', 'UI.md', UI_NODE_KINDS, 'UI node kind');
  require_(presentation, 'PRESENTATION.md', PRESENTATION_ROLES, 'role');
  require_(presentation, 'PRESENTATION.md', UX_ROLES, 'UX role');
  require_(presentation, 'PRESENTATION.md', EMPHASIS_LEVELS, 'emphasis');
  require_(presentation, 'PRESENTATION.md', DENSITIES, 'density');
  require_(presentation, 'PRESENTATION.md', TEXT_ROLES, 'text role');
  require_(presentation, 'PRESENTATION.md', SURFACE_ROLES, 'surface');
  require_(presentation, 'PRESENTATION.md', TREATMENTS, 'treatment');
  require_(presentation, 'PRESENTATION.md', CONTROL_VARIANTS, 'control');
  require_(presentation, 'PRESENTATION.md', ICON_NAMES, 'icon');
  require_(presentation, 'PRESENTATION.md', LAYOUT_KINDS, 'layout kind');
  require_(presentation, 'PRESENTATION.md', SPACING_TOKENS, 'spacing token');
  require_(presentation, 'PRESENTATION.md', DEVICE_CLASSES, 'device class');
  require_(presentation, 'PRESENTATION.md', VALUE_FORMAT_KINDS, 'value format');

  assert.deepEqual(gaps, []);
});

// --------------------------------------------------------------- semantic tables

/**
 * The presence table in AGENT_REFERENCE.md, executed. These are the exact functions the
 * `required`, `is-empty` and truthiness semantics are built from.
 */
test('the documented presence table is the implemented behaviour', () => {
  const rows: Array<[unknown, boolean, boolean, boolean]> = [
    // value, required, is-empty, truthy
    [null, false, true, false],
    [undefined, false, true, false],
    [[], true, true, false],
    [['x'], true, false, true],
    ['', true, true, false],
    ['  ', true, true, true],
    [0, true, false, false],
    [false, true, false, false],
    [{}, true, false, true],
  ];
  for (const [value, required, empty, truthy] of rows) {
    assert.equal(isPresent(value), required, `required(${JSON.stringify(value)})`);
    assert.equal(isEmptyValue(value), empty, `is-empty(${JSON.stringify(value)})`);
    assert.equal(toBoolean(value), truthy, `truthiness of ${JSON.stringify(value)}`);
  }
});

/**
 * The collection-null table in AGENT_REFERENCE.md, executed through the runtime: every
 * operator is applied to a present empty collection and to a missing one.
 */
test('the documented collection null table is the implemented behaviour', () => {
  const ENTITY = nodeId('entity_row');
  const F_ID = fieldId('field_row_id');
  const EMPTY = nodeId('state_empty');
  const MISSING = nodeId('state_missing');
  const SCOPE = nodeId('scope_row');
  const VIEW = nodeId('ui_view');

  const operators = {
    map: (source: facade.Expression) => map(source, SCOPE, ref(SCOPE)),
    filter: (source: facade.Expression) => filter(source, SCOPE, literal(true)),
    find: (source: facade.Expression) => find(source, SCOPE, literal(true)),
    every: (source: facade.Expression) => every(source, SCOPE, literal(true)),
    some: (source: facade.Expression) => some(source, SCOPE, literal(true)),
    flatten: (source: facade.Expression) => flatten(source),
    count: (source: facade.Expression) => facade.call('count', source),
    sum: (source: facade.Expression) => facade.call('sum', source),
  };
  /** What the documentation says each operator yields for `[]`. */
  const documented: Record<string, unknown> = {
    map: [],
    filter: [],
    find: null,
    every: true,
    some: false,
    flatten: [],
    count: 0,
    sum: 0,
  };

  const graph = new ApplicationGraph('nulls', 'Nulls');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [{ id: F_ID, valueType: primitiveType('string'), required: true }],
  });
  graph.addNode<StateDef>({
    id: EMPTY,
    kind: 'state',
    valueType: collectionType(primitiveType('number')),
    initialValue: [],
  });
  graph.addNode<StateDef>({
    id: MISSING,
    kind: 'state',
    valueType: optionalType(collectionType(primitiveType('number'))),
    initialValue: null,
  });
  const derived: Record<string, string> = {};
  for (const [name, build] of Object.entries(operators)) {
    for (const [label, source] of [['empty', EMPTY], ['missing', MISSING]] as const) {
      const id = nodeId(`state_${name}_${label}`);
      derived[`${name}:${label}`] = id;
      graph.addNode<StateDef>({
        id,
        kind: 'state',
        // The declared type is deliberately loose: this test is about runtime behaviour.
        valueType: optionalType(primitiveType('string')),
        derivation: build(ref(source)),
      });
    }
  }
  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: VIEW });

  const host = createMemoryHost();
  const app = createAxiomRuntime({ ir: compileToIR(graph, { validate: false }), rootElement: host.root, host });
  app.start();

  for (const name of Object.keys(operators)) {
    assert.deepEqual(
      app.getState(nodeId(derived[`${name}:empty`])),
      documented[name],
      `${name} over [] should be ${JSON.stringify(documented[name])}`,
    );
    assert.equal(
      app.getState(nodeId(derived[`${name}:missing`])),
      null,
      `${name} over null should fail rather than return a value`,
    );
  }

  // Every failure is reported, and none of them is silent.
  const failures = app
    .diagnostics()
    .filter((diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.EXPRESSION_EVALUATION_FAILED);
  assert.equal(failures.length, Object.keys(operators).length);
  for (const failure of failures) {
    assert.equal(failure.severity, 'error');
    assert.ok(failure.details?.collectionOperator, 'the diagnostic names the operator that failed');
  }
});

// ------------------------------------------------------------------- consistency

test('the documentation map and the documentation set agree', () => {
  for (const name of DOC_FILES) {
    assert.ok(README.includes(`docs/${name}`), `docs/${name} is not linked from the README`);
  }
  for (const match of README.matchAll(/\(docs\/([A-Z_]+\.md)\)/g)) {
    assert.ok(DOC_FILES.includes(match[1]), `the README links docs/${match[1]}, which does not exist`);
  }
});

test('every relative link between documents resolves', () => {
  const broken: string[] = [];
  for (const [file, source] of ALL_DOCS) {
    for (const match of source.matchAll(/\]\((?!https?:)([^)#]+)(#[^)]*)?\)/g)) {
      const target = path.resolve(path.dirname(path.join(repoRoot, file)), match[1]);
      try {
        readFileSync(target);
      } catch {
        broken.push(`${file} → ${match[1]}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('the documentation states the version it describes', () => {
  const version = JSON.parse(read('package.json')).version as string;
  assert.ok(README.includes(version), `the README does not state ${version}`);

  // Every topic file names the version whose behaviour it describes, so a document can
  // never silently describe a superseded release.
  for (const name of DOC_FILES) {
    assert.ok(
      ALL_DOCS.get(`docs/${name}`)?.includes(version),
      `docs/${name} does not state the version it describes`,
    );
  }
});

test('no document claims to describe a version other than the current one', () => {
  const version = JSON.parse(read('package.json')).version as string;
  const release = version.replace(/-.*$/, '');
  const stale = new Set<string>();
  for (const [file, source] of ALL_DOCS) {
    // Links to the specification documents carry their own historical version numbers.
    const prose = source.replace(/specs\/spec[\d.]*\.md/g, '');
    // A document "names a version" when it states which one it describes, or names a
    // published release. Prose about an earlier release — "the 0.5.0 mapping" — is history,
    // not a claim, and stays legitimate.
    for (const match of prose.matchAll(/(?:Axiom |@cynodia\/axiom@)(\d+\.\d+\.\d+)/g)) {
      if (match[1] !== release) {
        stale.add(`${file}: ${match[0]}`);
      }
    }
    for (const match of prose.matchAll(/(\d+\.\d+\.\d+)-alpha\.[\dx]+/g)) {
      if (match[1] !== release) {
        stale.add(`${file}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual([...stale], []);
});

test('every package manifest is at the root version', () => {
  const version = JSON.parse(read('package.json')).version as string;
  const drifted: string[] = [];
  for (const directory of readdirSync(path.join(repoRoot, 'packages'))) {
    const manifestPath = `packages/${directory}/package.json`;
    const manifest = JSON.parse(read(manifestPath));
    if (manifest.version !== version) {
      drifted.push(`${manifestPath} is at ${manifest.version}`);
    }
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@cynodia/') && range !== version) {
        drifted.push(`${manifestPath} pins ${dependency} to ${String(range)}`);
      }
    }
  }
  assert.deepEqual(drifted, []);
});

test('a new graph is stamped with the release version', () => {
  const release = (JSON.parse(read('package.json')).version as string).replace(/-.*$/, '');
  assert.equal(new ApplicationGraph('v', 'V').version, release);
});

test('the facade ships the documentation set', () => {
  const manifest = JSON.parse(read('packages/axiom/package.json'));
  assert.ok(
    (manifest.files as string[]).includes('docs/*.md'),
    'the facade manifest does not whitelist the documentation',
  );
  for (const name of DOC_FILES) {
    readFileSync(path.join(repoRoot, 'packages/axiom/docs', name));
  }
});

// ------------------------------------------------- 0.6.1 consistency checks

test('the documentation names no package that is not published', () => {
  // Documenting a CLI that is not on npm sent an external implementer looking for it. Every
  // `@cynodia/…` the documentation names must be something a reader can actually install.
  const published = new Set(
    readdirSync(path.join(repoRoot, 'packages'))
      .map((directory) => {
        const manifest = path.join(repoRoot, 'packages', directory, 'package.json');
        try {
          return JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; private?: boolean };
        } catch {
          return undefined;
        }
      })
      .filter((manifest): manifest is { name: string; private?: boolean } => Boolean(manifest))
      .filter((manifest) => !manifest.private)
      .map((manifest) => manifest.name),
  );

  const named = new Set<string>();
  for (const match of EVERY_DOC.matchAll(/@cynodia\/[a-z-]+/g)) {
    named.add(match[0]);
  }
  assert.deepEqual(
    [...named].filter((name) => !published.has(name)).sort(),
    [],
    'documented packages that are not published',
  );
});

test('the documentation does not promise a CLI this project does not ship', () => {
  // `packages/cli` is private. It may appear in the README's instructions for working in
  // this repository, where it is what a contributor actually runs — but only alongside a
  // statement that it is not published. It may not appear in the contract documentation at
  // all: a reader of docs/ is a reader of the published packages.
  const promises = /packages\/cli\/dist\/index\.js|npx @cynodia|\baxiom (serve|build|inspect|validate)\b/;
  const promised: string[] = [];
  for (const [file, source] of ALL_DOCS) {
    if (file !== 'README.md' && promises.test(source)) {
      promised.push(file);
    }
  }
  assert.deepEqual(promised, [], 'contract documents referring to an unpublished CLI');

  if (promises.test(README)) {
    assert.match(
      README,
      /packages\/cli is a private development tool|There is no published Axiom CLI/,
      'the README names the CLI without saying it is unpublished',
    );
  }
});

test('the conformance and schema subpaths a document names actually resolve', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/server/package.json'), 'utf8'),
  ) as { exports: Record<string, unknown> };
  const patterns = Object.keys(manifest.exports);

  const resolves = (subpath: string): boolean =>
    patterns.some((pattern) =>
      pattern.includes('*')
        ? new RegExp(`^${pattern.replace('*', '.*')}$`).test(subpath)
        : pattern === subpath,
    );

  for (const match of EVERY_DOC.matchAll(/@cynodia\/axiom-server(\/[\w./*-]+)/g)) {
    assert.ok(resolves(`.${match[1]}`), `${match[0]} is not exported by @cynodia/axiom-server`);
  }
});

test('every startup step the documentation states is stated the same way everywhere', () => {
  // RUNTIME.md, AUTHORITY.md and the runtime's own declaration comments describe one
  // lifecycle. Three descriptions of it are three chances for them to disagree.
  const runtimeDoc = ALL_DOCS.get('docs/RUNTIME.md') as string;
  const authorityDoc = ALL_DOCS.get('docs/AUTHORITY.md') as string;
  const declaration = readFileSync(
    path.join(repoRoot, 'packages/runtime/dist/runtime.d.ts'),
    'utf8',
  );

  for (const [where, source] of [
    ['docs/RUNTIME.md', runtimeDoc],
    ['docs/AUTHORITY.md', authorityDoc],
    ['runtime.d.ts', declaration],
  ] as const) {
    assert.match(source, /[Rr]ender/, `${where} describes the render step`);
    assert.match(source, /authoritative state/i, `${where} describes the synchronization step`);
  }

  // The three specific promises, each of which a reader will rely on.
  for (const [where, source] of [['docs/RUNTIME.md', runtimeDoc], ['docs/AUTHORITY.md', authorityDoc]] as const) {
    assert.match(source, /gateway .*before .*`?start\(\)`?|before `start\(\)`/i, `${where} states the bootstrap invariant`);
    assert.match(source, /authoritativeStateLoaded/, `${where} names the predicate for a failed load`);
    assert.match(source, /AUTHORITY_UNREACHABLE/, `${where} names the diagnostic for a failed load`);
  }
  assert.match(declaration, /authoritativeStateLoaded/, 'the runtime declares the predicate');
});

test('every protocol field the documentation names exists in the protocol declaration', () => {
  const declaration = readFileSync(
    path.join(repoRoot, 'packages/server/dist/protocol.d.ts'),
    'utf8',
  );
  const authorityDoc = ALL_DOCS.get('docs/AUTHORITY.md') as string;

  // The message shapes as AUTHORITY.md prints them, field by field.
  for (const match of authorityDoc.matchAll(/\{ kind: '(snapshot|invoke|result|error)',([^}]*)\}/g)) {
    for (const field of match[2].split(',').map((entry) => entry.trim().replace(/[?:].*$/, ''))) {
      if (!field || field === 'protocol' || field === 'snapshot') continue;
      assert.ok(
        declaration.includes(`${field}?:`) || declaration.includes(`${field}:`),
        `AUTHORITY.md names "${field}" on a ${match[1]} message; the protocol does not declare it`,
      );
    }
  }
});

test('the changes contract is described identically by the docs, the runtime and the fixtures', () => {
  const authorityDoc = ALL_DOCS.get('docs/AUTHORITY.md') as string;
  const serverSource = readFileSync(
    path.join(repoRoot, 'packages/server/src/server.ts'),
    'utf8',
  );

  // The rule in one sentence: difference from transaction entry, over observable states.
  const rule = /whose value differs from\s+what it was when the transaction opened/;
  assert.match(authorityDoc.replace(/\s+/g, ' '), /whose value differs from what it was when the transaction opened/);
  assert.match(serverSource.replace(/\s+\*?\s*/g, ' '), rule);

  // And the fixtures state it exhaustively rather than as a subset, which is what makes the
  // conformance suite able to catch a runtime that over-reports.
  const fixture = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/server/conformance/mutation-commits.json'), 'utf8'),
  ) as { invocations: { expect?: { changedStates?: string[] } }[] };
  assert.ok(
    (fixture.invocations[0].expect?.changedStates?.length ?? 0) > 0,
    'the fixtures declare which states changed',
  );
});

test('a documented count of the UI node kinds is the actual count', () => {
  // A blind agent trusting a stale enumeration in the reference card shipped the wrong
  // construct entirely: `dialog` had been added to the vocabulary and to UI.md, but the
  // reference card still said "Ten kinds" and listed ten. Prose counts drift silently; this
  // is the check that they cannot.
  const spelled: Record<string, number> = {
    Nine: 9, Ten: 10, Eleven: 11, Twelve: 12, Thirteen: 13, Fourteen: 14,
  };
  const wrong: string[] = [];
  for (const [file, source] of ALL_DOCS) {
    for (const match of source.matchAll(/\b(Nine|Ten|Eleven|Twelve|Thirteen|Fourteen)\b[^.\n]*\b(?:semantic )?UI node kinds?\b/gi)) {
      const claimed = spelled[match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()];
      if (claimed !== UI_NODE_KINDS.length) {
        wrong.push(`${file}: claims ${match[1]} UI node kinds, there are ${UI_NODE_KINDS.length}`);
      }
    }
    for (const match of source.matchAll(/\bAll (nine|ten|eleven|twelve|thirteen|fourteen)\b/gi)) {
      const claimed = spelled[match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()];
      if (claimed !== UI_NODE_KINDS.length) {
        wrong.push(`${file}: says "All ${match[1]}", there are ${UI_NODE_KINDS.length} kinds`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test('every UI node kind is listed wherever the kinds are enumerated', () => {
  // Being documented somewhere is not enough: an agent reads the enumeration it finds first.
  const enumerations = [
    // The reference no longer spells a count — §87: an enumeration is tested against the
    // vocabulary, never counted by hand. It still has to list every kind.
    ['docs/AGENT_REFERENCE.md', /Every kind is in `UI_NODE_KINDS`:([^.]*)\./],
    ['README.md', /Semantic interaction structure \(([^)]*)\)/],
  ] as const;
  for (const [file, pattern] of enumerations) {
    const source = ALL_DOCS.get(file);
    assert.ok(source, file);
    const listed = pattern.exec(source)?.[1];
    assert.ok(listed, `${file} has no enumeration matching ${String(pattern)}`);
    for (const kind of UI_NODE_KINDS) {
      assert.ok(listed.includes(kind), `${file} enumerates the UI kinds but omits ${kind}`);
    }
  }
});
