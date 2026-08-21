import { createRuntimeModuleSource } from '@cynodia/axiom-runtime';
import type { ApplicationGraph, ApplicationIR, Appearance } from '@cynodia/axiom-core';
import { compileToIR } from './normalize.js';
import { createThemeStylesheet } from './stylesheet.js';
import type { CompileOptions } from './normalize.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeForScript(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

export interface HtmlOptions extends CompileOptions {
  title?: string;
  /**
   * Pins the appearance of the emitted page. Omitted, the theme decides — and a theme set
   * to `system` follows the reader's own preference.
   */
  appearance?: Appearance;
}

/**
 * Emits a self-contained page: the normalized IR as data, plus the generic runtime. No
 * part of this output is derived from what the application is about.
 */
export function compileIRToHtml(ir: ApplicationIR, options: HtmlOptions = {}): string {
  const runtimeSource = createRuntimeModuleSource();
  const payload = escapeForScript(JSON.stringify(ir));
  const title = options.title ?? ir.name;
  const stylesheet = createThemeStylesheet(ir.theme);
  const appearance = options.appearance ?? (ir.theme.appearance === 'system' ? undefined : ir.theme.appearance);

  return [
    '<!DOCTYPE html>',
    `<html lang="en"${appearance ? ` data-axiom-appearance="${appearance}"` : ''}>`,
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    stylesheet,
    '  </style>',
    '</head>',
    '<body>',
    '  <div id="app"></div>',
    '  <script type="module">',
    runtimeSource,
    `const __AXIOM_IR__ = ${payload};`,
    'const __axiomRoot = document.getElementById("app");',
    'const __axiomApp = createAxiomRuntime({ ir: __AXIOM_IR__, rootElement: __axiomRoot, host: createBrowserHost() });',
    'globalThis.__AXIOM_APP__ = __axiomApp;',
    '__axiomApp.start();',
    '  </script>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function compileToHtml(graph: ApplicationGraph, options: HtmlOptions = {}): string {
  return compileIRToHtml(compileToIR(graph, options), options);
}
