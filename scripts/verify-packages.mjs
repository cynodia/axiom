import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { publishable, tarballPath, version } from './packages.mjs';

/**
 * Inspects the packed tarballs rather than the working tree: what npm would publish is
 * the only thing worth checking.
 */
const MAX_SIZE_BYTES = 2 * 1024 * 1024;
const COPYRIGHT_HOLDER = 'AskTech AS';
const FORBIDDEN_PREFIXES = ['file:', 'link:', 'workspace:', '../', './', 'git+', 'http'];
/**
 * The facade must carry the operational contract: a consumer of the published package must
 * never need repository access to obtain it.
 */
const REQUIRED_FACADE_DOCS = [
  'docs/AGENT_REFERENCE.md',
  'docs/SEMANTIC_CONTRACT.md',
  'docs/GRAPH_MODEL.md',
  'docs/EXPRESSIONS.md',
  'docs/LOCATIONS.md',
  'docs/STATE.md',
  'docs/ACTIONS_TRANSACTIONS.md',
  'docs/CONSTRAINTS.md',
  'docs/UI.md',
  'docs/PRESENTATION.md',
  'docs/RUNTIME.md',
  'docs/AGENT_API.md',
  'docs/VALIDATION.md',
  'docs/ANTI_PATTERNS.md',
];
const FORBIDDEN_PATHS = [/^package\/src\//, /^package\/test\//, /^package\/dist-test\//,
  /node_modules/, /\.tsbuildinfo$/, /^package\/tsconfig.*\.json$/];

const problems = [];
const report = (name, message) => problems.push(`${name}: ${message}`);

function listFiles(tarball) {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readPackedManifest(tarball) {
  return JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
}

for (const { name } of publishable) {
  const tarball = tarballPath(name);
  let files;
  let manifest;
  try {
    files = listFiles(tarball);
    manifest = readPackedManifest(tarball);
  } catch {
    report(name, `no tarball at ${tarball} — run "npm run release:pack" first`);
    continue;
  }

  if (manifest.name !== name) {
    report(name, `packed manifest declares the name "${manifest.name}"`);
  }
  if (manifest.version !== version) {
    report(name, `version is ${manifest.version}, expected ${version}`);
  }
  if (manifest.license !== 'MIT') {
    report(name, `license is ${manifest.license ?? 'missing'}, expected MIT`);
  }
  if (manifest.type !== 'module') {
    report(name, 'is not declared as an ES module');
  }
  if (manifest.publishConfig?.access !== 'public') {
    report(name, 'does not declare publishConfig.access = public');
  }
  if (manifest.private) {
    report(name, 'is marked private and cannot be published');
  }
  if (!manifest.repository?.url || !manifest.homepage || !manifest.bugs?.url) {
    report(name, 'is missing repository metadata');
  }

  // Every dependency must be resolvable from the registry at this exact version.
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (FORBIDDEN_PREFIXES.some((prefix) => String(range).startsWith(prefix))) {
      report(name, `dependency ${dependency} uses a non-registry version "${range}"`);
    } else if (range !== version) {
      report(name, `dependency ${dependency} is pinned to ${range}, expected ${version}`);
    }
    if (!dependency.startsWith('@cynodia/')) {
      report(name, `depends on ${dependency}, which is outside the Axiom scope`);
    }
  }
  if (manifest.devDependencies) {
    report(name, 'ships devDependencies in its published manifest');
  }

  // Entry points must resolve to files that are actually in the tarball.
  const has = (file) => files.includes(`package/${file}`);
  const entryPoints = new Set();
  for (const target of Object.values(manifest.exports ?? {})) {
    for (const value of Object.values(target ?? {})) {
      entryPoints.add(String(value).replace(/^\.\//, ''));
    }
  }
  entryPoints.add(String(manifest.main ?? '').replace(/^\.\//, ''));
  entryPoints.add(String(manifest.types ?? '').replace(/^\.\//, ''));
  for (const entry of entryPoints) {
    if (entry && !has(entry)) {
      report(name, `declares ${entry} but the tarball does not contain it`);
    }
  }

  const required = ['README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts'];
  if (name === '@cynodia/axiom') {
    required.push(...REQUIRED_FACADE_DOCS);
  }
  for (const file of required) {
    if (!has(file)) {
      report(name, `is missing ${file}`);
    }
  }
  if (!files.some((file) => file.endsWith('.d.ts'))) {
    report(name, 'contains no TypeScript declarations');
  }
  for (const file of files) {
    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(file))) {
      report(name, `should not publish ${file}`);
    }
  }

  // Each package carries its own copy of the licence, so check they have not drifted.
  const licence = execFileSync('tar', ['-xzOf', tarball, 'package/LICENSE'], { encoding: 'utf8' });
  if (!licence.includes('MIT License')) {
    report(name, 'ships a LICENSE that is not the MIT licence');
  }
  if (!licence.includes(COPYRIGHT_HOLDER)) {
    report(name, `ships a LICENSE that does not name ${COPYRIGHT_HOLDER}`);
  }

  const { size } = statSync(tarball);
  if (size > MAX_SIZE_BYTES) {
    report(name, `is ${(size / 1024 / 1024).toFixed(2)} MiB, which is larger than expected`);
  }

  console.log(
    `${name.padEnd(28)} ${String(files.length).padStart(4)} files  ` +
      `${(size / 1024).toFixed(1).padStart(8)} KiB  ok`,
  );
}

if (problems.length > 0) {
  console.error(`\n${problems.length} packaging problem(s):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(`\nAll ${publishable.length} packages are publishable at ${version}.`);
