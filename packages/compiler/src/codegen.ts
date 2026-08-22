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

/**
 * How a generated page reaches its authority.
 *
 * `true` means the standard semantic endpoint on the current origin, which is what the
 * reference host serves — so an application with server-authoritative state needs no
 * endpoint string and no gateway code of its own.
 */
export type RemoteOption = boolean | { endpoint?: string; timeoutMs?: number };

export interface HtmlOptions extends CompileOptions {
  title?: string;
  /**
   * Configure the page to talk to an authority. Omitted, it defaults to `true` whenever the
   * IR contains a remote action, because such a page cannot work without one.
   */
  remote?: RemoteOption;
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

  // A page with remote actions is not usable without a gateway, so one is configured by
  // default rather than left for an author to discover.
  const needsRemote = (ir.remoteActionIds ?? []).length > 0;
  const remote = options.remote ?? needsRemote;
  const remoteConfig =
    remote === false
      ? null
      : {
          endpoint: (remote === true ? undefined : remote.endpoint) ?? '/axiom',
          ...(remote !== true && remote.timeoutMs !== undefined ? { timeoutMs: remote.timeoutMs } : {}),
        };
  const bootstrap = remoteConfig
    ? [
        `const __axiomRemote = createHttpRemoteGateway(${JSON.stringify(remoteConfig)});`,
        'const __axiomApp = createAxiomRuntime({ ir: __AXIOM_IR__, rootElement: __axiomRoot, host: createBrowserHost(), remote: __axiomRemote });',
      ]
    : [
        'const __axiomApp = createAxiomRuntime({ ir: __AXIOM_IR__, rootElement: __axiomRoot, host: createBrowserHost() });',
      ];

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
    ...bootstrap,
    'globalThis.__AXIOM_APP__ = __axiomApp;',
    // `start()` is the whole startup sequence: it renders synchronously and then loads
    // authoritative state when a gateway is configured.
    '__axiomApp.start();',
    '  </script>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function compileToHtml(graph: ApplicationGraph, options: HtmlOptions = {}): string {
  return compileIRToHtml(compileToIR(graph, options), options);
}
