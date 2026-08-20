import { rm } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { releaseDir, repoRoot } from './packages.mjs';

const packagesDir = path.join(repoRoot, 'packages');
const entries = await readdir(packagesDir, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue;
  }
  for (const output of ['dist', 'dist-test']) {
    await rm(path.join(packagesDir, entry.name, output), { recursive: true, force: true });
  }
}
await rm(releaseDir, { recursive: true, force: true });

console.log('Removed build output and previous release artifacts.');
