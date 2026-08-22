import { execFileSync } from 'node:child_process';
import { publishable, repoRoot, version } from './packages.mjs';

/**
 * Moving a dist-tag onto this release, shared by `release:publish` and `release:dist-tag`.
 *
 * npm claims `latest` on the first publish of a new package whatever `--tag` says, and it
 * cannot be removed afterwards. So `latest` exists whether or not the project wants it, and
 * left alone it keeps pointing at whichever version was published first — meaning a plain
 * `npm install @cynodia/axiom` quietly hands out a stale release. This moves it
 * deliberately.
 *
 * One implementation serves both entry points so a release and a repair cannot disagree.
 */

function view(specifier, field, json = true) {
  try {
    return execFileSync('npm', ['view', specifier, field, ...(json ? ['--json'] : [])], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export const tagsOf = (name) => JSON.parse(view(name, 'dist-tags') ?? '{}');

/**
 * Ask about the exact version: `npm view <name> version` reports whatever `latest` points
 * at, which is the very thing being corrected here.
 */
export const isPublished = (name) => view(`${name}@${version}`, 'version', false) === version;

/**
 * Points `tag` at this release for every published package.
 *
 * Returns `{ moved, alreadyCorrect, missing }` rather than exiting, so a caller decides
 * what a partial result means. Packages already carrying the tag are skipped, which is what
 * makes re-running after a failure safe.
 */
export async function moveDistTag({ tag = 'latest', dryRun = false, otp, log = console.log }) {
  const missing = publishable.filter(({ name }) => !isPublished(name)).map((entry) => entry.name);
  if (missing.length > 0) {
    return { moved: [], alreadyCorrect: [], missing };
  }

  const outstanding = publishable.filter(({ name }) => tagsOf(name)[tag] !== version);
  const alreadyCorrect = publishable
    .filter(({ name }) => tagsOf(name)[tag] === version)
    .map((entry) => entry.name);

  if (outstanding.length === 0) {
    log(`"${tag}" already points at ${version} for every package.`);
    return { moved: [], alreadyCorrect, missing: [] };
  }

  log(`${dryRun ? 'Would point' : 'Pointing'} "${tag}" at ${version}:`);
  for (const { name } of outstanding) {
    log(`  ${name} (currently ${tagsOf(name)[tag] ?? 'unset'})`);
  }
  if (dryRun) {
    return { moved: [], alreadyCorrect, missing: [] };
  }

  const moved = [];
  for (const { name } of outstanding) {
    // Any failure propagates with what was already moved recorded, so the caller can say
    // exactly where the release stopped.
    try {
      await otp.run(name, ['dist-tag', 'add', `${name}@${version}`, tag], repoRoot);
      moved.push(name);
    } catch (error) {
      error.moved = moved;
      throw error;
    }
  }
  return { moved, alreadyCorrect, missing: [] };
}

export function reportTags(log = console.log) {
  log('\nCurrent tags:');
  for (const { name } of publishable) {
    log(`  ${name.padEnd(28)} ${JSON.stringify(tagsOf(name))}`);
  }
}
