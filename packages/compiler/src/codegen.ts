import { createRuntimeModuleSource } from '@cynodia/axiom-runtime';
import type { ApplicationGraph, ApplicationIR } from '@cynodia/axiom-core';
import { compileToIR } from './normalize.js';
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

/** Domain-neutral styling for the semantic UI vocabulary. */
const STYLESHEET = `
:root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }
body { margin: 0; background: #f4f7fb; color: #1f2937; }
#app { padding: 24px; max-width: 1100px; margin: 0 auto; }
.axiom-view { display: grid; gap: 16px; }
.axiom-container { display: flex; gap: 12px; }
.axiom-layout-vertical { flex-direction: column; align-items: stretch; }
.axiom-layout-horizontal { flex-direction: row; align-items: center; flex-wrap: wrap; }
.axiom-layout-stack { flex-direction: column; gap: 4px; }
.axiom-view > .axiom-container,
.axiom-view > .axiom-form { background: #ffffff; border-radius: 16px; padding: 20px; box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08); }
.axiom-repeat { display: grid; gap: 10px; }
.axiom-field { display: flex; gap: 8px; align-items: baseline; }
.axiom-field-label { color: #64748b; font-size: 13px; }
.axiom-field-value { font-weight: 500; }
.axiom-form { display: grid; gap: 12px; }
.axiom-input { display: grid; gap: 6px; }
.axiom-input-label { font-size: 13px; color: #475569; }
.axiom-control { font: inherit; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; width: 100%; box-sizing: border-box; }
textarea.axiom-control { min-height: 120px; resize: vertical; }
input[type="checkbox"].axiom-control { width: auto; }
.axiom-button { font: inherit; border: none; border-radius: 10px; padding: 10px 14px; background: #2563eb; color: #ffffff; cursor: pointer; }
.axiom-button.axiom-destructive, .axiom-role-danger { background: #dc2626; }
.axiom-role-secondary { background: #64748b; }
.axiom-emphasis-strong { font-weight: 700; font-size: 18px; }
.axiom-density-compact { padding: 6px 10px; }
.axiom-no-route { padding: 20px; background: #ffffff; border-radius: 12px; }
`.trim();

export interface HtmlOptions extends CompileOptions {
  title?: string;
}

/**
 * Emits a self-contained page: the normalized IR as data, plus the generic runtime. No
 * part of this output is derived from what the application is about.
 */
export function compileIRToHtml(ir: ApplicationIR, options: HtmlOptions = {}): string {
  const runtimeSource = createRuntimeModuleSource();
  const payload = escapeForScript(JSON.stringify(ir));
  const title = options.title ?? ir.name;

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    STYLESHEET,
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
