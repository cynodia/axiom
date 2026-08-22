import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createOtpSession, otpFromArgv } from './otp.mjs';
import { moveDistTag, reportTags } from './dist-tag-lib.mjs';
import { publishable, readManifest, repoRoot, tarballPath, version } from './packages.mjs';

/**
 * A deliberate, manual release. Nothing here runs on a push: publishing is only ever
 * what a person typed. Every gate below has to pass first.
 */
const dryRun = process.argv.includes('--dry-run');
const allowDirty = process.argv.includes('--allow-dirty');
const skipPrepare = process.argv.includes('--skip-prepare');
const tag = 'alpha';
/**
 * npm claims `latest` on a package's first publish whatever `--tag` says, so a release that
 * only sets `alpha` leaves `npm install @cynodia/axiom` pointing at whichever version went
 * out first. Moving it is part of releasing, not a separate errand — and doing it in the
 * same run reuses the 2FA session npm has already granted.
 */
const distTag =
  process.argv.find((argument) => argument.startsWith('--dist-tag='))?.slice('--dist-tag='.length) ??
  'latest';
const skipDistTag = process.argv.includes('--no-dist-tag');

/** npm requires a one-time password when the account has 2FA on publish. */
const otp = createOtpSession(otpFromArgv());

const fail = (message) => {
  console.error(`\nRefusing to publish: ${message}`);
  process.exit(1);
};

const capture = (command, args) =>
  execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' }).trim();

// 1. Every manifest must agree on the version.
const rootVersion = JSON.parse(
  execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }),
).version;
if (rootVersion !== version) {
  fail(`the root manifest is at ${rootVersion} but the release is ${version}`);
}
for (const { directory, name } of publishable) {
  const manifest = readManifest(directory);
  if (manifest.version !== version) {
    fail(`${name} is at ${manifest.version}, expected ${version}`);
  }
}
console.log(`Releasing ${version} under the "${tag}" tag.`);

// 2. An alpha must never take the "latest" tag.
if (!/-(alpha|beta|rc)\./.test(version)) {
  fail(`${version} does not look like a pre-release; check the intended dist-tag first`);
}

// 3. The tree must be the tree that was tested.
if (!allowDirty) {
  const status = capture('git', ['status', '--porcelain']);
  if (status) {
    fail(
      'the working tree has uncommitted changes. Commit them, or pass --allow-dirty ' +
        `if that is deliberate.\n${status}`,
    );
  }
}

// 4. Whoever is publishing must be logged in.
let whoami;
try {
  whoami = capture('npm', ['whoami']);
} catch {
  fail('npm is not authenticated. Run "npm login" first.');
}
console.log(`Authenticated as ${whoami}.`);
if (whoami !== 'cynodia') {
  fail(`authenticated as ${whoami}, but this release publishes under the @cynodia scope`);
}

// 5. Build, test, pack and prove an external consumer can use the result.
if (skipPrepare) {
  console.log('Skipping release preparation (--skip-prepare).');
} else {
  console.log('\nRunning release preparation...');
  execFileSync('npm', ['run', 'release:prepare'], { cwd: repoRoot, stdio: 'inherit' });
}

for (const { name } of publishable) {
  if (!existsSync(tarballPath(name))) {
    fail(`no tarball for ${name}; run "npm run release:prepare"`);
  }
}

// 6. Publish the verified tarballs themselves, in dependency order.
/** A version already on the registry is skipped, so a partial release can be resumed. */
function alreadyPublished(name) {
  try {
    const found = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return found === version;
  } catch {
    return false;
  }
}

console.log(`\n${dryRun ? 'Dry run:' : 'Publishing:'}`);
const published = [];

for (const [index, { name }] of publishable.entries()) {
  if (!dryRun && alreadyPublished(name)) {
    console.log(`  ${name} — already on the registry at ${version}, skipping`);
    continue;
  }

  const args = ['publish', tarballPath(name), '--tag', tag, '--access', 'public'];
  if (dryRun) {
    args.push('--dry-run');
  }

  try {
    console.log(`  ${name}`);
    await otp.run(name, args, repoRoot);
    published.push(name);
  } catch {
    console.error(`\n${name} could not be published.`);
    if (published.length > 0) {
      console.error(`Already published in this run: ${published.join(', ')}`);
    }
    const remaining = publishable.slice(index).map((entry) => entry.name);
    console.error(`Still to publish: ${remaining.join(', ')}`);
    console.error(
      '\nRe-run "npm run release:publish -- --skip-prepare" to continue. Packages that\n' +
        'already reached the registry are skipped, so resuming is safe.\n' +
        '\nIf npm reported a 403 asking for two-factor authentication, authenticate with a\n' +
        'granular access token that has "bypass 2FA" enabled instead. Never commit that token.',
    );
    process.exit(1);
  }
}

if (dryRun) {
  console.log('\nDry run complete. Nothing was published.');
  if (!skipDistTag) {
    console.log(`\nWould then point "${distTag}" at ${version}.`);
  }
  process.exit(0);
}

console.log(
  `\nPublished ${published.length} package(s) at ${version} under "${tag}".\n` +
    `Install with: npm install @cynodia/axiom@${tag}`,
);

// 7. Point the default tag at what was just released, in the same run and the same
//    authenticated session.
if (skipDistTag) {
  console.log(`\nLeaving "${distTag}" where it is (--no-dist-tag).`);
} else {
  console.log(`\nMoving "${distTag}":`);
  try {
    const result = await moveDistTag({ tag: distTag, otp });
    if (result.missing.length > 0) {
      // Everything above succeeded, so this can only mean the registry has not caught up.
      console.error(
        `  ${result.missing.join(', ')} ${result.missing.length === 1 ? 'is' : 'are'} not ` +
          `visible at ${version} yet.\n  Run "npm run release:dist-tag" in a moment.`,
      );
      process.exit(1);
    }
    reportTags();
  } catch (error) {
    console.error(`\nMoved "${distTag}" for: ${error.moved?.join(', ') || 'nothing'}`);
    console.error(
      'The packages are published; only the tag is outstanding.\n' +
        'Run "npm run release:dist-tag" to finish — packages already tagged are skipped.',
    );
    process.exit(1);
  }
}
