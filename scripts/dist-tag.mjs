import { createOtpSession, otpFromArgv } from './otp.mjs';
import { moveDistTag, removeDistTag, reportTags } from './dist-tag-lib.mjs';
import { version } from './packages.mjs';

/**
 * Points a dist-tag at this release across every published package, or removes one.
 *
 * `release:publish` already sets `latest` as it publishes, so this exists to repair a tag
 * left behind — a release interrupted after publishing, a tag moved by hand, or a tag from
 * an older release policy that no longer means anything.
 *
 *   npm run release:dist-tag                      # point "latest" at this release
 *   npm run release:dist-tag -- --tag=alpha       # point "alpha" at this release
 *   npm run release:dist-tag -- --tag=alpha --rm  # remove "alpha" everywhere
 */
const dryRun = process.argv.includes('--dry-run');
const remove = process.argv.includes('--rm');
const tag =
  process.argv.find((argument) => argument.startsWith('--tag='))?.slice('--tag='.length) ?? 'latest';

// No code is asked for up front: npm authenticates once, its own way, and the registry
// keeps the session 2FA-satisfied for the rest of the run.
const otp = createOtpSession(otpFromArgv());

if (remove) {
  let outcome;
  try {
    outcome = await removeDistTag({ tag, dryRun, otp });
  } catch (error) {
    console.error(`\nRemoved "${tag}" from: ${error.removed?.join(', ') || 'nothing'}`);
    console.error(`${error.message}`);
    console.error('Re-run to continue — packages that no longer carry the tag are skipped.');
    process.exit(1);
  }
  if (dryRun) {
    console.log('\nDry run. No tag was removed.');
    process.exit(0);
  }
  if (outcome.removed.length > 0) {
    console.log(`\nRemoved "${tag}" from ${outcome.removed.length} package(s).`);
  }
  reportTags();
  process.exit(0);
}


let result;
try {
  result = await moveDistTag({ tag, dryRun, otp });
} catch (error) {
  console.error(`\nMoved "${tag}" for: ${error.moved?.join(', ') || 'nothing'}`);
  console.error('Re-run "npm run release:dist-tag" to continue — packages already tagged are skipped.');
  process.exit(1);
}

if (result.missing.length > 0) {
  console.error(
    `Refusing to move "${tag}": ${result.missing.join(', ')} ` +
      `${result.missing.length === 1 ? 'is' : 'are'} not published at ${version}.`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log('\nDry run. No tag was moved.');
  process.exit(0);
}

reportTags();
