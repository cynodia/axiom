import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packageDir, repoRoot } from './packages.mjs';

/**
 * The real-browser conformance gate.
 *
 * `npm test` skips the browser tests when Playwright or its Chromium build is absent, so
 * that a contributor without a browser can still run the suite. A **release** may not skip
 * them: 0.7's dialog semantics are only verified by a browser, and four defects in them were
 * found by one. So this refuses to pass when the browser is missing, rather than reporting a
 * suite in which every case was skipped.
 */
const require = createRequire(path.join(packageDir('demo'), 'package.json'));
try {
  require.resolve('playwright');
} catch {
  console.error(
    'Playwright is not installed, so the browser conformance gate cannot run.\n' +
      '  npm install --save-dev --workspace=packages/demo playwright\n' +
      '  npx playwright install chromium',
  );
  process.exit(1);
}

const output = execFileSync(
  'node',
  ['--test', 'dist-test/browser-dialog.test.js'],
  { cwd: packageDir('demo'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
process.stdout.write(output);

// A skipped case is not a passing case. The gate is that the browser actually ran them.
const skipped = /^# skipped (\d+)$/m.exec(output)?.[1] ?? /ℹ skipped (\d+)/.exec(output)?.[1];
const passed = /ℹ pass (\d+)/.exec(output)?.[1] ?? '0';
if (Number(skipped ?? 0) > 0) {
  console.error(`\n${skipped} browser test(s) were skipped. The browser conformance gate requires all of them to run.`);
  process.exit(1);
}
console.log(`\nBrowser conformance: ${passed} dialog cases passed in Chromium (${path.relative(repoRoot, packageDir('demo'))}).`);
