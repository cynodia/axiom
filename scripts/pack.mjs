import { execFileSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { packageDir, publishable, releaseDir, tarballPath, version } from './packages.mjs';

await mkdir(releaseDir, { recursive: true });

for (const { directory, name } of publishable) {
  execFileSync('npm', ['pack', '--pack-destination', releaseDir], {
    cwd: packageDir(directory),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const tarball = tarballPath(name);
  const { size } = await stat(tarball);
  console.log(`${name.padEnd(28)} ${(size / 1024).toFixed(1).padStart(8)} KiB  ${tarball}`);
}

console.log(`\nPacked ${publishable.length} packages at ${version}.`);
