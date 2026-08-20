import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The architecture test of section 40: framework packages must not contain identifiers
 * belonging to any application domain. Demo applications may rename their entities
 * freely; what matters is that none of those names ever appear here.
 */
const FRAMEWORK_PACKAGES = ['core', 'compiler', 'runtime', 'agent-api', 'cli'];

const FORBIDDEN_WORDS = [
  'issue',
  'project',
  'comment',
  'customer',
  'product',
  'warehouse',
  'todo',
  'invoice',
];

/**
 * `ValidationIssue` is framework vocabulary named by the specification itself
 * (section 26), not application vocabulary. It is the only permitted collision.
 */
const EXEMPT_IDENTIFIERS = ['ValidationIssue'];

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(full);
      }
      return entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

/** Splits source text into lower-cased words, breaking camelCase and snake_case apart. */
function words(source: string): string[] {
  let text = source;
  for (const exempt of EXEMPT_IDENTIFIERS) {
    text = text.split(exempt).join(' ');
  }
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

test('framework packages contain no application-domain identifiers', async () => {
  const leaks: string[] = [];

  for (const packageName of FRAMEWORK_PACKAGES) {
    const directory = path.join(repoRoot, 'packages', packageName, 'src');
    for (const file of await sourceFiles(directory)) {
      const found = new Set(words(await readFile(file, 'utf8')).filter((word) => FORBIDDEN_WORDS.includes(word)));
      for (const word of found) {
        leaks.push(`${path.relative(repoRoot, file)}: "${word}"`);
      }
    }
  }

  assert.deepEqual(leaks, [], `Domain vocabulary leaked into framework packages:\n${leaks.join('\n')}`);
});

test('the leak detector actually detects a leak', () => {
  assert.deepEqual(
    words('const customerEditor = 1;').filter((word) => FORBIDDEN_WORDS.includes(word)),
    ['customer'],
  );
  assert.deepEqual(
    words('interface ValidationIssue {}').filter((word) => FORBIDDEN_WORDS.includes(word)),
    [],
  );
});
