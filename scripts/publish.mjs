import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
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
 * npm requires a one-time password for accounts with 2FA on publish. Pass it as
 * `--otp=123456`, or leave it out and this prompts for one — which is usually better,
 * since the code is only valid for about 30 seconds.
 */
let otp = process.argv.find((argument) => argument.startsWith('--otp='))?.slice('--otp='.length);
const interactive = process.stdin.isTTY === true;

async function askForOtp(reason) {
  if (!interactive) {
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${reason}npm one-time password (blank to skip): `)).trim();
    return answer || undefined;
  } finally {
    rl.close();
  }
}

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

if (!dryRun && otp === undefined) {
  otp = await askForOtp('');
}

console.log(`\n${dryRun ? 'Dry run:' : 'Publishing:'}`);
const published = [];

for (const [index, { name }] of publishable.entries()) {
  if (!dryRun && alreadyPublished(name)) {
    console.log(`  ${name} — already on the registry at ${version}, skipping`);
    continue;
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const args = ['publish', tarballPath(name), '--tag', tag, '--access', 'public'];
    if (dryRun) {
      args.push('--dry-run');
    }
    if (otp) {
      args.push('--otp', otp);
    }

    try {
      console.log(`  ${name}`);
      execFileSync('npm', args, { cwd: repoRoot, stdio: 'inherit' });
      published.push(name);
      break;
    } catch {
      // A one-time password expires in about 30 seconds, so a long release can outlive
      // the code it started with. Ask for a fresh one rather than abandoning the run.
      const fresh = attempt <= 3 ? await askForOtp(`Publishing ${name} failed. `) : undefined;
      if (fresh) {
        otp = fresh;
        continue;
      }

      console.error(`\n${name} could not be published.`);
      if (published.length > 0) {
        console.error(`Already published in this run: ${published.join(', ')}`);
      }
      const remaining = publishable.slice(index).map((entry) => entry.name);
      console.error(`Still to publish: ${remaining.join(', ')}`);
      console.error(
        '\nRe-run "npm run release:publish -- --skip-prepare" to continue. Packages that\n' +
          'already reached the registry are skipped, so resuming is safe.\n' +
          '\nIf npm reported a 403 asking for two-factor authentication, either supply a\n' +
          'one-time password when prompted (or with --otp=<code>), or authenticate with a\n' +
          'granular access token that has "bypass 2FA" enabled. Never commit that token.',
      );
      process.exit(1);
    }
  }
}

console.log(
  dryRun
    ? '\nDry run complete. Nothing was published.'
    : `\nPublished ${published.length} package(s) at ${version} under "${tag}".\n` +
        `Install with: npm install @cynodia/axiom@${tag}`,
);
