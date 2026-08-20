import { readFileSync } from 'node:fs';

/**
 * Returns the runtime as browser-ready source. `runtime.js` is authored as ordinary
 * TypeScript — type-checked and unit tested — and imports nothing at runtime, so
 * stripping the `export` keywords is a complete "bundle" for inlining into a page.
 */
export function createRuntimeModuleSource(): string {
  const compiled = readFileSync(new URL('./runtime.js', import.meta.url), 'utf8');
  return compiled.replace(/^export /gm, '');
}
