#!/usr/bin/env node
        import { createServer } from 'node:http';
        import { mkdir, writeFile } from 'node:fs/promises';
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        import { compileToHtml } from '@axiom/compiler';
        import { ApplicationGraph } from '@axiom/core';

        async function loadModel(modelFile: string): Promise<ApplicationGraph> {
          const resolved = path.resolve(process.cwd(), modelFile);
          const module = await import(pathToFileURL(resolved).href);
          const candidate =
            typeof module.createIssueTrackerModel === 'function'
              ? module.createIssueTrackerModel()
              : typeof module.default === 'function'
                ? module.default()
                : module.graph ?? module.default;

          if (candidate instanceof ApplicationGraph) {
            return candidate;
          }
          if (typeof candidate === 'string') {
            return ApplicationGraph.deserialize(candidate);
          }
          if (candidate && typeof candidate === 'object' && 'nodes' in candidate && 'edges' in candidate) {
            return ApplicationGraph.deserialize(candidate as Parameters<typeof ApplicationGraph.deserialize>[0]);
          }
          throw new Error(`Could not load an ApplicationGraph from ${modelFile}`);
        }

        function inspectGraph(graph: ApplicationGraph): string {
          const sections: Array<[string, Parameters<ApplicationGraph['getNodesByType']>[0]]> = [
            ['Entities', 'entity'],
            ['State', 'state'],
            ['Views', 'view'],
            ['Actions', 'action'],
            ['Constraints', 'constraint'],
            ['Routes', 'route'],
          ];

          return sections
            .map(([label, type]) => {
              const items = graph.getNodesByType(type);
              const lines = items.map((node) => {
                const edges = graph
                  .getOutgoingEdges(node.id)
                  .map((edge) => `${edge.kind} → ${graph.getNode(edge.to)?.name ?? edge.to}`)
                  .join(', ');
              return `- ${node.name} (${node.id})${edges ? ` [${edges}]` : ''}`;
            });
              return `${label}\n${lines.length ? lines.join('\n') : '- none'}`;
            })
            .join('\n\n');
        }

        async function build(modelFile: string): Promise<string> {
          const graph = await loadModel(modelFile);
          const html = compileToHtml(graph);
          const outputDir = path.resolve(process.cwd(), 'dist');
          const outputFile = path.join(outputDir, 'index.html');
          await mkdir(outputDir, { recursive: true });
          await writeFile(outputFile, html, 'utf8');
          return outputFile;
        }

        async function serve(modelFile: string): Promise<void> {
          const graph = await loadModel(modelFile);
          const html = compileToHtml(graph);
          const server = createServer((request, response) => {
            if (!request.url || request.url === '/' || request.url.startsWith('/issues/')) {
              response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
              response.end(html);
              return;
            }
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
          });
          server.listen(3000, '127.0.0.1', () => {
            console.log('Axiom demo available at http://127.0.0.1:3000');
          });
        }

        async function main(): Promise<void> {
          const [, , command, modelFile] = process.argv;
          if (!command || !modelFile) {
            console.error('Usage: axiom <build|inspect|serve> <modelFile>');
            process.exitCode = 1;
            return;
          }

          if (command === 'build') {
            const output = await build(modelFile);
            console.log(`Built ${output}`);
            return;
          }

          if (command === 'inspect') {
            const graph = await loadModel(modelFile);
            console.log(inspectGraph(graph));
            return;
          }

          if (command === 'serve') {
            await serve(modelFile);
            return;
          }

          console.error(`Unknown command: ${command}`);
          process.exitCode = 1;
        }

        main().catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        });
