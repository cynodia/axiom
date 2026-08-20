import { readFileSync } from 'node:fs';

/**
 * The runtime modules, in dependency order. Each is authored as ordinary TypeScript —
 * type-checked and unit tested — and imports nothing at run time except its siblings,
 * so concatenating them and dropping the module syntax produces a complete browser
 * bundle without a bundler.
 */
const RUNTIME_MODULES = [
  './mutation/values.js',
  './mutation/store.js',
  './mutation/transaction.js',
  './mutation/resolve-location.js',
  './mutation/mutation-engine.js',
  './runtime.js',
];

const BUNDLED_BASENAMES = RUNTIME_MODULES.map((module) => module.slice(module.lastIndexOf('/') + 1));

export class UnbundledDependencyError extends Error {
  constructor(module: string, specifier: string) {
    super(
      `${module} imports "${specifier}" at run time, but only the runtime's own modules are ` +
        `inlined into a page. Import it as a type, inline the value, or resolve it during ` +
        `compilation instead.`,
    );
    this.name = 'UnbundledDependencyError';
  }
}

/**
 * Removes `import` statements and `export` keywords so the modules share one scope.
 * An import of anything outside the bundle is an error rather than a silent omission:
 * stripping it would leave an undefined identifier in the browser.
 */
function stripModuleSyntax(source: string, module: string): string {
  const kept: string[] = [];
  let insideImport = false;
  let pendingImport = '';

  const checkSpecifier = (statement: string): void => {
    const specifier = /from\s+'([^']+)'/.exec(statement)?.[1];
    if (!specifier) {
      return;
    }
    const basename = specifier.slice(specifier.lastIndexOf('/') + 1);
    if (!BUNDLED_BASENAMES.includes(basename)) {
      throw new UnbundledDependencyError(module, specifier);
    }
  };

  for (const line of source.split('\n')) {
    if (insideImport) {
      pendingImport += ` ${line.trim()}`;
      if (line.trimEnd().endsWith(';')) {
        insideImport = false;
        checkSpecifier(pendingImport);
        pendingImport = '';
      }
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('import ')) {
      if (trimmed.trimEnd().endsWith(';')) {
        checkSpecifier(trimmed);
      } else {
        insideImport = true;
        pendingImport = trimmed;
      }
      continue;
    }
    kept.push(line.startsWith('export ') ? line.slice('export '.length) : line);
  }

  return kept.join('\n');
}

export function createRuntimeModuleSource(): string {
  return RUNTIME_MODULES.map((module) =>
    stripModuleSyntax(readFileSync(new URL(module, import.meta.url), 'utf8'), module),
  ).join('\n');
}
