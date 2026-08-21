import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { packageDir, repoRoot } from './packages.mjs';

/**
 * Copies the canonical documentation into the facade package so it ships in the tarball.
 *
 * The published package has to be sufficient on its own — an external consumer must not
 * need repository access to obtain Axiom's operational contract. The files under `docs/`
 * at the repository root are the single source of truth; this makes the copy that npm
 * packs, and `release:clean` removes it again.
 */
const source = path.join(repoRoot, 'docs');
const target = path.join(packageDir('axiom'), 'docs');

const entries = (await readdir(source)).filter((name) => name.endsWith('.md')).sort();
if (entries.length === 0) {
  console.error('No documentation found in docs/.');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of entries) {
  await cp(path.join(source, name), path.join(target, name));
}

console.log(`Copied ${entries.length} documentation files into packages/axiom/docs/.`);
