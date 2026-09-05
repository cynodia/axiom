import { execFileSync } from 'node:child_process';
import { publishable, version } from './packages.mjs';

/**
 * Registry-backed publication verification (spec16pt3 §54-58, §156-160).
 *
 * `npm publish` returning successfully is not the publication boundary — the alpha.2
 * defect was exactly "implementation says published, actual registry says 404". This
 * queries the real public registry for each coordinated package at the exact release
 * version, with bounded retry for ordinary propagation lag, and fails loudly rather than
 * silently treating a persistent 404 as success (§158).
 *
 * Safe to run any time: it makes no registry writes, only `npm view` lookups.
 */
const RETRY_ATTEMPTS = Number(process.env.AXIOM_REGISTRY_VERIFY_ATTEMPTS ?? 5);
const RETRY_DELAY_MS = Number(process.env.AXIOM_REGISTRY_VERIFY_DELAY_MS ?? 3000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registryVersion(name) {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function registryBin(name) {
  try {
    const raw = execFileSync('npm', ['view', `${name}@${version}`, 'bin', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

console.log(`Verifying ${publishable.length} package(s) at ${version} against the public npm registry...`);

const problems = [];
for (const { name } of publishable) {
  let found = null;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    found = registryVersion(name);
    if (found === version) {
      break;
    }
    if (attempt < RETRY_ATTEMPTS - 1) {
      console.log(
        `  ${name}@${version} not yet visible (attempt ${attempt + 1}/${RETRY_ATTEMPTS}); retrying in ${RETRY_DELAY_MS}ms...`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (found !== version) {
    problems.push(`${name}@${version} did not resolve from the registry (got: ${found ?? 'nothing'})`);
    continue;
  }
  console.log(`  ${name}@${version} ok`);
  // The CLI's bin mapping is the specific artifact spec16pt3 D2 turns on — confirm the
  // registry-visible manifest actually carries it, not merely that the version resolves.
  if (name === '@cynodia/axiom-cli') {
    const bin = registryBin(name);
    if (!bin || !bin.axiom) {
      problems.push(`${name}@${version} resolved but its registry manifest has no "axiom" bin entry`);
    } else {
      console.log(`    bin.axiom -> ${bin.axiom}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} package(s) failed registry-backed verification:`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    '\nThe release is INCOMPLETE (spec16pt3 §58): a package described as published must be ' +
      'externally resolvable from the registry, not merely present as a local tarball.',
  );
  process.exit(1);
}

console.log(`\nAll ${publishable.length} package(s) resolve from the public registry at ${version}.`);
