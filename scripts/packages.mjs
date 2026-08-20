import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export const version = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
).version;

/** Publishable packages, already in dependency order. */
export const publishable = [
  { directory: 'core', name: '@cynodia/axiom-core' },
  { directory: 'runtime', name: '@cynodia/axiom-runtime' },
  { directory: 'compiler', name: '@cynodia/axiom-compiler' },
  { directory: 'agent-api', name: '@cynodia/axiom-agent-api' },
  { directory: 'axiom', name: '@cynodia/axiom' },
];

export const releaseDir = path.join(repoRoot, 'release');

/** The tarball name npm produces for a scoped package. */
export function tarballName(name, packageVersion = version) {
  return `${name.replace('@', '').replace('/', '-')}-${packageVersion}.tgz`;
}

export function tarballPath(name, packageVersion = version) {
  return path.join(releaseDir, tarballName(name, packageVersion));
}

export function packageDir(directory) {
  return path.join(repoRoot, 'packages', directory);
}

export function readManifest(directory) {
  return JSON.parse(readFileSync(path.join(packageDir(directory), 'package.json'), 'utf8'));
}
