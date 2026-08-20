import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { publishable, readManifest, repoRoot, tarballPath, version } from './packages.mjs';

/**
 * A deliberate, manual release. Nothing here runs on a push: publishing is only ever
 * what a person typed. Every gate below has to pass first.
 */
const dryRun = process.argv.includes('--dry-run');
const allowDirty = process.argv.includes('--allow-dirty');
const skipPrepare = process.argv.includes('--skip-prepare');
const tag = 'alpha';

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
console.log(`\n${dryRun ? 'Dry run:' : 'Publishing:'}`);
for (const { name } of publishable) {
  const args = ['publish', tarballPath(name), '--tag', tag, '--access', 'public'];
  if (dryRun) {
    args.push('--dry-run');
  }
  console.log(`  ${name}`);
  execFileSync('npm', args, { cwd: repoRoot, stdio: 'inherit' });
}

console.log(
  dryRun
    ? '\nDry run complete. Nothing was published.'
    : `\nPublished ${publishable.length} packages at ${version} under "${tag}".\n` +
        `Install with: npm install @cynodia/axiom@${tag}`,
);
