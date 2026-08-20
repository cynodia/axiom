import type { ActionDef, ApplicationGraphData, RouteDef, ViewDef } from '@axiom/core';
        import { ApplicationGraph } from '@axiom/core';
        import { createRuntimeModuleSource } from '@axiom/runtime';

        function escapeForScript(value: string): string {
          return value.replace(/<\/script/gi, '<\\/script');
        }

        function escapeHtml(value: string): string {
          return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        }

        function sanitizeFunctionSuffix(id: string): string {
          return id.replace(/[^a-zA-Z0-9_$]/g, '_');
        }

        function createViewRenderer(view: ViewDef): string {
          const fnName = `renderView_${sanitizeFunctionSuffix(view.id)}`;
          const renderKind = view.renderKind ?? 'generic';
          const renderCall: Record<string, string> = {
            list: 'renderIssueList()',
            detail: 'renderIssueDetail()',
            editor: `renderIssueEditor(globalThis.__AXIOM_APP__.getState('currentIssue'))`,
            create: 'renderCreateIssue()',
            generic: `renderGeneric(${JSON.stringify(view)})`,
          };
          const body = renderCall[renderKind] ?? `renderGeneric(${JSON.stringify(view)})`;
          return [
            `function ${fnName}(ctx) {`,
            `  return ${body};`,
            `}`,
          ].join('\n');
        }

        function createViewRegistry(views: ViewDef[]): string {
          const entries = views
            .map((view) => {
              const fnName = `renderView_${sanitizeFunctionSuffix(view.id)}`;
              return `${JSON.stringify(view.id)}: ${fnName}`;
            })
            .join(',\n  ');
          return `globalThis.__AXIOM_VIEW_RENDERERS__ = {\n  ${entries}\n};`;
        }

        function summarizeGraph(graph: ApplicationGraphData): string {
          const counts = ['entity', 'state', 'view', 'action', 'constraint', 'route']
            .map((type) => `${type}: ${Object.values(graph.nodes).filter((node) => node.type === type).length}`)
            .join(' · ');
          return `<p class="summary">${escapeHtml(counts)}</p>`;
        }

        export function compileToHtml(graph: ApplicationGraph): string {
          const data = graph.toJSON();
          const views = Object.values(data.nodes).filter((node): node is ViewDef => node.type === 'view');
          const runtimeSource = createRuntimeModuleSource();
          const graphJson = escapeForScript(JSON.stringify(data));
          const viewRenderers = views.map(createViewRenderer).join('\n\n');
          const viewRegistry = createViewRegistry(views);
          const actionNames = Object.values(data.nodes)
            .filter((node): node is ActionDef => node.type === 'action')
            .map((action) => action.name)
            .join(', ');
          const routeNames = Object.values(data.nodes)
            .filter((node): node is RouteDef => node.type === 'route')
            .map((route) => route.path)
            .join(', ');

          return [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '  <meta charset="utf-8" />',
            '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
            `  <title>${escapeHtml(data.name)}</title>`,
            '  <style>',
            '    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }',
            '    body { margin: 0; background: #f4f7fb; color: #1f2937; }',
            '    #app { padding: 24px; max-width: 1100px; margin: 0 auto; }',
            '    .layout { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.5fr) minmax(320px, 1fr); align-items: start; }',
            '    .panel { background: white; border-radius: 16px; padding: 20px; box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08); }',
            '    .panel-header { display: flex; justify-content: space-between; gap: 12px; align-items: start; }',
            '    .filters, .actions, .stack { display: grid; gap: 12px; }',
            '    .filters { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 16px; }',
            '    .issue-list, .comment-list { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 10px; }',
            '    .issue-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 12px 14px; background: #eef2ff; border-radius: 12px; }',
            '    .issue-row button { text-align: left; }',
            '    .issue-status, .badge { font-size: 12px; padding: 6px 10px; border-radius: 999px; background: #dbeafe; color: #1d4ed8; }',
            '    input, textarea, select, button { font: inherit; }',
            '    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; margin-top: 6px; }',
            '    textarea { min-height: 120px; resize: vertical; }',
            '    button { border: none; border-radius: 10px; padding: 10px 14px; background: #2563eb; color: white; cursor: pointer; }',
            '    button[data-nav="/"] { background: #64748b; }',
            '    .empty-state { padding: 20px; text-align: center; background: #f8fafc; border-radius: 12px; }',
            '    .summary { color: #475569; margin: 0 0 20px; }',
            '  </style>',
            '</head>',
            '<body>',
            '  <div id="app"></div>',
            '  <script type="module">',
            `    globalThis.__AXIOM_GRAPH__ = ${graphJson};`,
            `    globalThis.__AXIOM_METADATA__ = ${JSON.stringify({ actions: actionNames, routes: routeNames })};`,
            `    ${viewRenderers}`,
            `    ${viewRegistry}`,
            `    ${runtimeSource}`,
            '  </script>',
            '</body>',
            '</html>',
          ].join('\n').replace('<div id="app"></div>', `<div id="app"></div>${summarizeGraph(data)}`);
        }
