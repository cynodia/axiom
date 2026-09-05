import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishable, repoRoot, tarballPath, version } from './packages.mjs';

/**
 * Builds a project outside the repository from the packed tarballs alone. It has no
 * workspace links, no path aliases and no relative imports into the monorepo, so if it
 * compiles and runs, the published packages are self-sufficient.
 */
const keep = process.argv.includes('--keep');
const fixture = path.join(repoRoot, 'scripts', 'consumer-fixture');
const project = await mkdtemp(path.join(os.tmpdir(), 'axiom-consumer-'));

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: project, stdio: 'inherit', ...options });

try {
  console.log(`Consumer project: ${project}`);

  await writeFile(
    path.join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'axiom-consumer-test',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: {
          build: 'tsc --project tsconfig.json',
          start: 'node dist/main.js',
          materialized: 'node dist/materialized.js',
        },
      },
      null,
      2,
    )}\n`,
  );
  await cp(path.join(fixture, 'tsconfig.json'), path.join(project, 'tsconfig.json'));
  await cp(path.join(fixture, 'src'), path.join(project, 'src'), { recursive: true });

  const tarballs = publishable.map(({ name }) => tarballPath(name));
  console.log(`\nInstalling ${tarballs.length} tarballs plus a TypeScript compiler...`);
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    ...tarballs,
    'typescript@^5.8.3',
    '@types/node@^22.15.30',
  ]);

  // Nothing in the installed tree may point back at the repository.
  const installed = JSON.parse(
    execFileSync('npm', ['ls', '--json', '--all'], { cwd: project, encoding: 'utf8' }),
  );
  const offenders = [];
  const visit = (node, trail) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (child.resolved && !/^file:.*\.tgz$/.test(child.resolved) && child.resolved.includes(repoRoot)) {
        offenders.push(`${[...trail, name].join(' > ')} resolves to ${child.resolved}`);
      }
      if (name.startsWith('@cynodia/') && child.version !== version) {
        offenders.push(`${name} installed at ${child.version}, expected ${version}`);
      }
      visit(child, [...trail, name]);
    }
  };
  visit(installed, []);
  if (offenders.length > 0) {
    throw new Error(`The consumer project reaches back into the repository:\n  ${offenders.join('\n  ')}`);
  }
  console.log('Installed packages resolve only to the published tarballs.');

  console.log('\nType-checking against the published declarations...');
  run('npm', ['run', '--silent', 'build']);

  console.log('\nRunning the consumer application:');
  run('npm', ['run', '--silent', 'start']);

  /**
   * spec16pt2 D2 — the published CLI must be usable by a fresh consumer, from the
   * documented npm mechanism alone, with no repository path involved. `node_modules/.bin`
   * is exactly what `npm install @cynodia/axiom-cli` (or a project dependency on it)
   * produces; invoking it directly is equivalent to what a shell finds after `npm link` or
   * `npx @cynodia/axiom-cli`.
   */
  console.log('\nInvoking the installed axiom CLI against the compiled consumer graph:');
  const axiomBin = path.join(project, 'node_modules', '.bin', 'axiom');
  run(axiomBin, ['--help']);
  run(axiomBin, ['validate', 'dist/counter.js', '--export=createCounterGraph']);
  run(axiomBin, ['explain', 'action', 'action_increment', 'dist/counter.js', '--export=createCounterGraph', '--json']);
  run(axiomBin, ['analyze', 'dist/counter.js', '--export=createCounterGraph', '--json']);
  run(axiomBin, [
    'diff',
    'dist/counter.js',
    '--export=createCounterGraph',
    '--against=dist/counter.js',
    '--against-export=createCounterGraph',
    '--json',
  ]);
  console.log('The published CLI is installable and usable with no repository access.');

  /**
   * The materialization gate.
   *
   * The pattern-built application has written its expanded graph to disk. Removing the
   * toolkit and reproducing the application from that graph is what turns "the toolkit is
   * build-time only" from a design claim into a property of the artifact.
   */
  console.log('\nRemoving @cynodia/axiom-ui and running the materialized application:');
  run('npm', ['uninstall', '--no-audit', '--no-fund', '--loglevel=error', '@cynodia/axiom-ui']);
  run('npm', ['run', '--silent', 'materialized', '--', project]);
} finally {
  if (keep) {
    console.log(`\nLeaving ${project} in place (--keep).`);
  } else {
    await rm(project, { recursive: true, force: true });
  }
}
