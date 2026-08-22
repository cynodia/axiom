import { createOtpSession, otpFromArgv } from './otp.mjs';
import { moveDistTag, reportTags } from './dist-tag-lib.mjs';
import { version } from './packages.mjs';

/**
 * Points a dist-tag at this release across every published package.
 *
 * `release:publish` already does this as its final step, so this exists to repair a tag
 * that was left behind — a release interrupted after publishing, or a tag moved by hand.
 */
const dryRun = process.argv.includes('--dry-run');
const tag =
  process.argv.find((argument) => argument.startsWith('--tag='))?.slice('--tag='.length) ?? 'latest';

// No code is asked for up front: npm authenticates once, its own way, and the registry
// keeps the session 2FA-satisfied for the rest of the run.
const otp = createOtpSession(otpFromArgv());

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
