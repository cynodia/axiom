/**
 * The materialization gate, run **with `@cynodia/axiom-ui` uninstalled**.
 *
 * It imports nothing but the facade, loads the graph the pattern-built application wrote, and
 * reproduces what that application did. If this passes, "the toolkit is an authoring
 * dependency" is a fact about the artifact rather than a claim about the design.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { reproduceWithoutToolkit } from './verify.js';
import type { ExpectedBehaviour } from './verify.js';

const directory = process.argv[2] ?? process.cwd();

// The toolkit must genuinely be gone, or this proves nothing.
const require = createRequire(path.join(directory, 'package.json'));
let resolved: string | undefined;
try {
  resolved = require.resolve('@cynodia/axiom-ui');
} catch {
  resolved = undefined;
}
assert.equal(resolved, undefined, '@cynodia/axiom-ui is still installed, so this gate is not testing anything');

const serialized = readFileSync(path.join(directory, 'materialized.json'), 'utf8');
const expected = JSON.parse(readFileSync(path.join(directory, 'expected.json'), 'utf8')) as ExpectedBehaviour;

reproduceWithoutToolkit(serialized, expected);
console.log('Materialized application: validated, compiled, ran — with no toolkit installed.');
