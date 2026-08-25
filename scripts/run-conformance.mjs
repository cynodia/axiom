import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './packages.mjs';

/**
 * Runs the whole portable conformance suite through nothing but the **public** package
 * surface: `runConformanceFixture` from `@cynodia/axiom-server`, plus the manifest and
 * fixture JSON files. No graph, no compiler, no builder, and — unlike
 * `packages/server/test/conformance.test.ts` — no internal test-only helper either.
 *
 * This is the "external runner gate" spec 8.2 §59 asks for: proof that the fixtures pass
 * for a reason other than "the internal test suite's own private assumptions happen to
 * match the runtime." A conforming implementation in another language is held to the same
 * fixtures and the same documented semantics (`docs/AUTHORITY.md`) this script uses.
 */

const { runConformanceFixture } = await import(path.join(repoRoot, 'packages/server/dist/index.js'));

const conformanceDir = path.join(repoRoot, 'packages/server/conformance');
const manifest = JSON.parse(await readFile(path.join(conformanceDir, 'manifest.json'), 'utf8'));

let failed = 0;
for (const entry of manifest.fixtures) {
  const fixture = JSON.parse(await readFile(path.join(conformanceDir, entry.file), 'utf8'));
  const result = await runConformanceFixture(fixture);
  if (result.ok) {
    console.log(`ok    ${result.name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${result.name}`);
    for (const failure of result.failures) {
      console.log(`        [${failure.where}] ${failure.message}`);
    }
  }
}

console.log(`\n${manifest.fixtures.length - failed}/${manifest.fixtures.length} fixtures passed`);
if (failed > 0) {
  process.exit(1);
}
