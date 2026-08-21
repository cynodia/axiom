import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createOtpSession, otpFromArgv } from './otp.mjs';
import { publishable, readManifest, repoRoot, tarballPath, version } from './packages.mjs';

/**
 * A deliberate, manual release. Nothing here runs on a push: publishing is only ever
 * what a person typed. Every gate below has to pass first.
 */
const dryRun = process.argv.includes('--dry-run');
const allowDirty = process.argv.includes('--allow-dirty');
const skipPrepare = process.argv.includes('--skip-prepare');
const tag = 'alpha';

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

console.log(
  dryRun
    ? '\nDry run complete. Nothing was published.'
    : `\nPublished ${published.length} package(s) at ${version} under "${tag}".\n` +
        `Install with: npm install @cynodia/axiom@${tag}`,
);
