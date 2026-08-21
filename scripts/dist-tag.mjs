import { execFileSync } from 'node:child_process';
import { createOtpSession, otpFromArgv } from './otp.mjs';
import { publishable, repoRoot, version } from './packages.mjs';

/**
 * Points a dist-tag at this release across every published package.
 *
 * npm claims `latest` on the first publish of a new package whatever `--tag` says, and it
 * cannot be removed afterwards. So `latest` exists whether or not the project wants it,
 * and left alone it keeps pointing at whichever version was published first. This moves
 * it deliberately.
 */
const dryRun = process.argv.includes('--dry-run');
const tag = process.argv.find((argument) => argument.startsWith('--tag='))?.slice('--tag='.length) ?? 'latest';

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

const tagsOf = (name) => JSON.parse(view(name, 'dist-tags') ?? '{}');

// Ask about the exact version: `npm view <name> version` reports whatever `latest`
// points at, which is the very thing being corrected here.
const isPublished = (name) => view(`${name}@${version}`, 'version', false) === version;

const missing = publishable.filter(({ name }) => !isPublished(name));
if (missing.length > 0) {
  console.error(
    `Refusing to move "${tag}": ${missing.map((entry) => entry.name).join(', ')} ` +
      `${missing.length === 1 ? 'is' : 'are'} not published at ${version}.`,
  );
  process.exit(1);
}

const outstanding = publishable.filter(({ name }) => tagsOf(name)[tag] !== version);
if (outstanding.length === 0) {
  console.log(`"${tag}" already points at ${version} for every package.`);
  process.exit(0);
}

console.log(`${dryRun ? 'Would point' : 'Pointing'} "${tag}" at ${version}:`);
for (const { name } of outstanding) {
  console.log(`  ${name} (currently ${tagsOf(name)[tag] ?? 'unset'})`);
}

if (dryRun) {
  console.log('\nDry run. No tag was moved.');
  process.exit(0);
}

// No code is asked for up front: npm authenticates once, its own way, and the registry
// keeps the session 2FA-satisfied for the rest of the run.
const otp = createOtpSession(otpFromArgv());

const moved = [];
try {
  for (const { name } of outstanding) {
    await otp.run(name, ['dist-tag', 'add', `${name}@${version}`, tag], repoRoot);
    moved.push(name);
  }
} catch {
  console.error(`\nMoved "${tag}" for: ${moved.join(', ') || 'nothing'}`);
  console.error(
    `Re-run "npm run release:dist-tag" to continue — packages already tagged are skipped.`,
  );
  process.exit(1);
}

console.log('\nCurrent tags:');
for (const { name } of publishable) {
  console.log(`  ${name.padEnd(28)} ${JSON.stringify(tagsOf(name))}`);
}
