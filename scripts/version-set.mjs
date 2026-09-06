import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packageDir, publishable, repoRoot, version as currentVersion } from './packages.mjs';

/**
 * Sets the release version everywhere the repository states it.
 *
 * A release version lives in about forty places and all but one of them are copies of the
 * root manifest's. Bumping them by hand is what shipped a catalogue stamped for 0.15.0-alpha.3
 * inside a 0.16.0-alpha.1 tarball, and a conformance suite stamped for a release two behind:
 * the copies that no fast test guards drift silently, and the ones that are guarded only fail
 * at the end of `release:prepare`, eight minutes in.
 *
 * So the bump is one command. Every file below is a place the version is *stated*, never a
 * place it is *recorded*: `specs/`, `reports/` and `CLAUDE.md` name the release a change
 * landed in and are history, so they are deliberately untouched.
 *
 *   node scripts/version-set.mjs 0.16.0-alpha.4 [--dry-run]
 */
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const requested = argv.find((argument) => !argument.startsWith('--'));

function fail(message) {
  console.error(`version:set — ${message}`);
  process.exit(1);
}

if (!requested) {
  fail('no version given.\n  node scripts/version-set.mjs <version> [--dry-run]');
}
// The same shape publish.mjs requires: this project has no stable line yet, and a bump that
// drops the pre-release suffix by accident is one the publish script would refuse anyway.
if (!/^\d+\.\d+\.\d+-(alpha|beta|rc)\.\d+$/.test(requested)) {
  fail(`"${requested}" is not a pre-release version such as 0.16.0-alpha.4`);
}
if (requested === currentVersion) {
  console.log(`Already at ${currentVersion}; rewriting anyway to repair any drifted copy.`);
}

const release = (value) => value.replace(/-.*$/, '');
const oldVersion = currentVersion;
const newVersion = requested;
const oldRelease = release(oldVersion);
const newRelease = release(newVersion);

/** Files rewritten, with the number of substitutions each took. */
const touched = [];

function write(file, before, after, substitutions) {
  if (before === after) return;
  touched.push({ file: path.relative(repoRoot, file), substitutions });
  if (!dryRun) writeFileSync(file, after);
}

/** A manifest states its own version, and pins every sibling to the same one. */
function rewriteManifest(file) {
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf8');
  const manifest = JSON.parse(before);
  let substitutions = 0;
  if (manifest.version === oldVersion) {
    manifest.version = newVersion;
    substitutions += 1;
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (dependency.startsWith('@cynodia/') && range === oldVersion) {
        manifest[field][dependency] = newVersion;
        substitutions += 1;
      }
    }
  }
  // npm writes a trailing newline; keep the file byte-identical apart from the version.
  const after = `${JSON.stringify(manifest, null, 2)}\n`;
  write(file, before, after, substitutions);
}

/** Prose states the version it describes. Only the exact current string is a claim. */
function rewriteText(file) {
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf8');
  const substitutions = before.split(oldVersion).length - 1;
  write(file, before, before.split(oldVersion).join(newVersion), substitutions);
}

/** A generated artifact stamps the release it was generated for. */
function rewriteStamps(file) {
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf8');
  const document = JSON.parse(before);
  let substitutions = 0;
  if (document.release === oldVersion) {
    document.release = newVersion;
    substitutions += 1;
  }
  // A conformance fixture embeds a compiled Server IR whose `version` is the authoring
  // graph's. A fixture that pins an older one on purpose (0.6.0, 0.9.0) is frozen and must
  // not float, so only the value that tracked the release is rewritten.
  if (document.serverIR?.version === oldVersion || document.serverIR?.version === oldRelease) {
    document.serverIR.version = document.serverIR.version === oldVersion ? newVersion : newRelease;
    substitutions += 1;
  }
  write(file, before, `${JSON.stringify(document, null, 2)}\n`, substitutions);
}

/** Every `.json` under a directory, recursively. */
function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...jsonFiles(full));
    else if (entry.name.endsWith('.json')) found.push(full);
  }
  return found;
}

/** Every `.md` directly inside a directory. */
function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(directory, name));
}

// 1. Manifests — the root, and every workspace including the private ones.
rewriteManifest(path.join(repoRoot, 'package.json'));
const directories = new Set([
  ...publishable.map((entry) => entry.directory),
  ...readdirSync(path.join(repoRoot, 'packages')),
]);
for (const directory of directories) {
  rewriteManifest(path.join(packageDir(directory), 'package.json'));
}

// 2. The documentation, which states the version whose behaviour it describes, and the three
//    facade entry points an unfamiliar agent reads first.
rewriteText(path.join(repoRoot, 'README.md'));
for (const file of markdownFiles(path.join(repoRoot, 'docs'))) rewriteText(file);
for (const directory of directories) {
  rewriteText(path.join(packageDir(directory), 'README.md'));
  rewriteText(path.join(packageDir(directory), 'AGENTS.md'));
  rewriteText(path.join(packageDir(directory), 'llms.txt'));
  // packages/axiom/docs is a generated copy of docs/, rewritten by `npm run docs:sync`.
  if (directory !== 'axiom') {
    for (const file of markdownFiles(path.join(packageDir(directory), 'docs'))) rewriteText(file);
  }
}

// 3. The one source file that hardcodes the release: the default an ApplicationGraph takes
//    when its author does not state a version. It reaches every generated conformance fixture.
const graphSource = path.join(packageDir('core'), 'src/graph.ts');
if (existsSync(graphSource)) {
  const before = readFileSync(graphSource, 'utf8');
  const needle = `version = '${oldRelease}'`;
  const substitutions = before.split(needle).length - 1;
  write(graphSource, before, before.split(needle).join(`version = '${newRelease}'`), substitutions);
}

// 4. Generated artifacts. Regenerating them (`toolkit:catalog`, `conformance:generate`) would
//    produce the same bytes, but that needs a build and rewrites 94 fixtures to change a
//    stamp — so the stamp is set directly and regeneration stays a no-op.
rewriteStamps(path.join(packageDir('ui-toolkit'), 'docs/PATTERN_CATALOG.json'));
for (const file of jsonFiles(path.join(packageDir('server'), 'conformance'))) rewriteStamps(file);

const substitutions = touched.reduce((total, entry) => total + entry.substitutions, 0);
if (touched.length === 0) {
  console.log(`Nothing to change: no file states ${oldVersion}.`);
} else {
  for (const entry of touched.slice(0, 12)) {
    console.log(`  ${entry.file}${entry.substitutions > 1 ? ` (${entry.substitutions})` : ''}`);
  }
  if (touched.length > 12) console.log(`  … and ${touched.length - 12} more`);
  console.log(
    `\n${dryRun ? 'Would set' : 'Set'} ${oldVersion} → ${newVersion} in ${touched.length} file(s), ` +
      `${substitutions} substitution(s).`,
  );
}
if (!dryRun && touched.length > 0) {
  console.log('Next: npm run build && npm test — then commit.');
}
