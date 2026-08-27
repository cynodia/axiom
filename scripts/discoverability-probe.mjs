import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tarballPath, version } from './packages.mjs';

/**
 * Approximates what a cold AI agent sees, starting from the packed npm artifact alone.
 *
 * A blind external-agent test found that Axiom's contract was discoverable only after the
 * agent had guessed at the API, failed, searched the web and cloned the repository. The
 * documentation existed; the route to it did not. Documentation an unfamiliar agent cannot
 * discover costs almost as much as documentation that does not exist, so the route is
 * verified as part of the package rather than assumed.
 *
 * This probe answers, using nothing but the tarball:
 *
 *   1. What should an AI agent read first?
 *   2. Where is that instruction discoverable?
 *   3. Does that file exist?
 *   4. Where does it say to go next?
 *   5. Can every referenced file be reached without repository access?
 *
 * The answer to (1) must be unambiguous and must be docs/AGENT_REFERENCE.md.
 */
const PACKAGE = '@cynodia/axiom';
const ENTRY_POINTS = ['README.md', 'AGENTS.md', 'llms.txt'];
const EXPECTED_FIRST_READ = 'docs/AGENT_REFERENCE.md';
/** Phrases that name a starting document rather than merely mentioning one. */
const START_INSTRUCTION = /(?:read|start (?:with|here)|begin with)[^\n]*?(docs\/[A-Z_]+\.md)/gi;
/**
 * A package-local path named in prose or in a table cell rather than as a link. These are
 * always written relative to the package root; a markdown link is relative to its own file.
 * The lookbehind keeps a package-qualified path (`@cynodia/axiom-ui/docs/…`) from being read
 * as a path into this package.
 */
const BARE_PATH = /(?<![\w/-])(docs\/[A-Z_]+\.md|dist\/index\.d\.ts)/g;

const tarball = tarballPath(PACKAGE);
let files;
try {
  files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((entry) => !entry.endsWith('/'))
    .map((entry) => entry.replace(/^package\//, ''));
} catch {
  console.error(`No tarball at ${tarball} — run "npm run release:pack" first.`);
  process.exit(1);
}

const has = (file) => files.includes(file);
const read = (file) =>
  execFileSync('tar', ['-xzOf', tarball, `package/${file}`], { encoding: 'utf8' });

const problems = [];
const report = (message) => problems.push(message);

console.log(`Discoverability probe: ${PACKAGE}@${version}`);
console.log(`Artifact: ${tarball}`);
console.log(`${files.length} files packed.\n`);

// ---------------------------------------------------------------- what is visible at all

const rootFiles = files.filter((file) => !file.includes('/')).sort();
console.log('Visible at the package root, with no prior knowledge:');
for (const file of rootFiles) {
  console.log(`  ${file}`);
}
console.log();

for (const entry of ENTRY_POINTS) {
  if (!has(entry)) {
    report(`the package root has no ${entry}`);
  }
}

// -------------------------------------------------- 1-3. what to read first, and where

const answers = new Map();
for (const entry of ENTRY_POINTS.filter(has)) {
  const text = read(entry);
  const named = [...text.matchAll(START_INSTRUCTION)].map((match) => match[1]);
  if (named.length === 0) {
    report(`${entry} never instructs the reader to read a specific document`);
    continue;
  }
  answers.set(entry, named[0]);
  // The instruction must come early enough that it is read before the prose.
  const position = text.indexOf(named[0]);
  const share = position / text.length;
  console.log(
    `${entry.padEnd(12)} first says to read ${named[0]} ` +
      `(${(share * 100).toFixed(1)}% into the file, line ${text.slice(0, position).split('\n').length})`,
  );
  if (share > 0.25) {
    report(`${entry} buries its starting instruction ${(share * 100).toFixed(0)}% into the file`);
  }
}

const distinct = new Set(answers.values());
console.log(`\n1. What should an AI agent read first?     ${[...distinct].join(', ') || '(nothing named)'}`);
console.log(`2. Where is that instruction discoverable? ${[...answers.keys()].join(', ') || '(nowhere)'}`);
console.log(`3. Does that file exist in the package?    ${[...distinct].every(has) ? 'yes' : 'NO'}`);

if (distinct.size !== 1) {
  report(`the entry points disagree about what to read first: ${[...distinct].join(', ')}`);
} else if (!distinct.has(EXPECTED_FIRST_READ)) {
  report(`the entry points send the reader to ${[...distinct][0]}, not ${EXPECTED_FIRST_READ}`);
}
for (const answer of distinct) {
  if (!has(answer)) {
    report(`the entry points name ${answer}, which the package does not contain`);
  }
}

// ----------------------------------------------------------- 4. where does it go next

if (has(EXPECTED_FIRST_READ)) {
  const reference = read(EXPECTED_FIRST_READ);
  const onward = [...reference.matchAll(/\]\((?!https?:|#)([^)\s]+)\)/g)]
    .map((match) => match[1].split('#')[0])
    .filter((target) => target.endsWith('.md'));
  console.log(
    `4. Where does it say to go next?           ${new Set(onward).size} package-local documents, ` +
      `plus the .d.ts declarations`,
  );
  if (!/\.d\.ts/.test(reference)) {
    report(`${EXPECTED_FIRST_READ} never names the .d.ts declarations as the API contract`);
  }
}

// ------------------------------------ 5. transitive closure, without repository access

const queue = ENTRY_POINTS.filter(has);
const seen = new Set(queue);
const unreachable = [];
let checked = 0;
while (queue.length > 0) {
  const file = queue.shift();
  const text = read(file);
  /** target → the path it resolves to inside the package. */
  const targets = new Map();
  for (const match of text.matchAll(/\]\((?!https?:|#)([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0];
    targets.set(target, path.posix.normalize(path.posix.join(path.posix.dirname(file), target)));
  }
  for (const match of text.matchAll(BARE_PATH)) {
    targets.set(match[1], match[1]);
  }
  for (const [target, resolved] of targets) {
    checked += 1;
    if (!has(resolved)) {
      unreachable.push(`${file} → ${target}`);
      continue;
    }
    if (resolved.endsWith('.md') && !seen.has(resolved)) {
      seen.add(resolved);
      queue.push(resolved);
    }
  }
}
console.log(
  `5. Reachable without repository access?    ${unreachable.length === 0 ? 'yes' : 'NO'} ` +
    `(${seen.size} documents, ${checked} references)`,
);
for (const broken of unreachable) {
  report(`unreachable from the package alone: ${broken}`);
}

// ------------------------------------------------------------------------- the verdict

if (problems.length > 0) {
  console.error(`\n${problems.length} discoverability problem(s):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  `\nA cold agent reading only ${PACKAGE}@${version} is told to read ${EXPECTED_FIRST_READ} ` +
    `by all ${ENTRY_POINTS.length} root entry points, and every document it references ` +
    `resolves inside the package.`,
);
