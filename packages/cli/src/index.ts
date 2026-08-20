#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileToHtml, compileToIR } from '@cynodia/axiom-compiler';
import { ApplicationGraph, formatLocation, semanticContextFromGraph, validateGraph } from '@cynodia/axiom-core';
import type { AnyNode, NodeKind, Operation, SemanticContext, ValidationResult } from '@cynodia/axiom-core';

const GRAPH_EXPORT_CANDIDATES = ['default', 'createGraph', 'createApplicationGraph'];

interface Options {
  command: string;
  modelFile: string;
  exportName?: string;
  port: number;
}

function parseArguments(argv: string[]): Options | null {
  const positional: string[] = [];
  let exportName: string | undefined;
  let port = 3000;

  for (const argument of argv) {
    if (argument.startsWith('--export=')) {
      exportName = argument.slice('--export='.length);
      continue;
    }
    if (argument.startsWith('--port=')) {
      port = Number(argument.slice('--port='.length)) || port;
      continue;
    }
    positional.push(argument);
  }

  const [command, modelFile] = positional;
  if (!command || !modelFile) {
    return null;
  }
  return { command, modelFile, exportName, port };
}

function toGraph(candidate: unknown): ApplicationGraph | null {
  if (candidate instanceof ApplicationGraph) {
    return candidate;
  }
  if (typeof candidate === 'string') {
    return ApplicationGraph.deserialize(candidate);
  }
  if (candidate && typeof candidate === 'object' && 'nodes' in candidate && 'edges' in candidate) {
    return ApplicationGraph.deserialize(candidate as Parameters<typeof ApplicationGraph.deserialize>[0]);
  }
  return null;
}

/**
 * Loads an application graph from a module. The module may export the graph directly or
 * a function that builds it; nothing about the application itself is assumed.
 */
async function loadGraph(options: Options): Promise<ApplicationGraph> {
  const resolved = path.resolve(process.cwd(), options.modelFile);
  const module = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;

  const names = options.exportName
    ? [options.exportName]
    : GRAPH_EXPORT_CANDIDATES.filter((name) => name in module);

  for (const name of names) {
    const exported = module[name];
    const value = typeof exported === 'function' ? (exported as () => unknown)() : exported;
    const graph = toGraph(value);
    if (graph) {
      return graph;
    }
  }

  if (!options.exportName) {
    const builders = Object.entries(module).filter(([, value]) => typeof value === 'function');
    if (builders.length === 1) {
      const graph = toGraph((builders[0][1] as () => unknown)());
      if (graph) {
        return graph;
      }
    }
    if (builders.length > 1) {
      throw new Error(
        `${options.modelFile} exports several candidates. Choose one with --export=<name>: ${builders
          .map(([name]) => name)
          .join(', ')}`,
      );
    }
  }

  throw new Error(`Could not load an application graph from ${options.modelFile}`);
}

const SECTIONS: Array<[string, NodeKind]> = [
  ['Entities', 'entity'],
  ['State', 'state'],
  ['Actions', 'action'],
  ['Constraints', 'constraint'],
  ['Routes', 'route'],
  ['Views', 'view'],
];

function describe(node: AnyNode): string {
  const label = node.name ? `${node.name} (${node.id})` : node.id;
  if (node.kind === 'entity') {
    const fields = node.fields.map((field) => field.name ?? field.id).join(', ');
    return `${label}${fields ? ` — fields: ${fields}` : ''}`;
  }
  if (node.kind === 'route') {
    return `${label} — ${node.path}`;
  }
  return label;
}

/** Locations are stored by id and resolved to names only for human inspection. */
function describeOperation(operation: Operation, semantics: SemanticContext): string {
  switch (operation.kind) {
    case 'set':
      return `set ${formatLocation(operation.target, semantics)}`;
    case 'insert':
      return `insert into ${formatLocation(operation.target, semantics)}`;
    case 'remove':
      return `remove ${formatLocation(operation.target, semantics)}`;
    case 'invoke':
      return `invoke ${semantics.getName?.(operation.actionId) ?? operation.actionId}`;
    case 'navigate':
      return `navigate ${operation.path ?? semantics.getName?.(operation.routeId!) ?? operation.routeId}`;
    case 'native':
      return `native ${operation.implementationId}`;
    default:
      return 'unknown operation';
  }
}

function inspect(graph: ApplicationGraph): string {
  const semantics = semanticContextFromGraph(graph);
  const lines: string[] = [`${graph.name} (${graph.id}) v${graph.version}`, ''];

  const fieldNames = (edge: { metadata?: Record<string, unknown> }): string => {
    const fieldIds = edge.metadata?.fieldIds;
    if (!Array.isArray(fieldIds) || fieldIds.length === 0) {
      return '';
    }
    return ` (${fieldIds.map((id) => graph.getField(id as never)?.field.name ?? String(id)).join(', ')})`;
  };

  for (const [title, kind] of SECTIONS) {
    const nodes = graph.getNodesByKind(kind);
    lines.push(title);
    if (nodes.length === 0) {
      lines.push('- none');
    }
    for (const node of nodes) {
      const edges = graph
        .getOutgoingEdges(node.id)
        .map((edge) => `${edge.kind} → ${graph.getNode(edge.to)?.name ?? edge.to}${fieldNames(edge)}`)
        .join(', ');
      lines.push(`- ${describe(node)}${edges ? ` [${edges}]` : ''}`);
      if (node.kind === 'action') {
        for (const operation of node.operations ?? []) {
          lines.push(`    ${describeOperation(operation, semantics)}`);
        }
      }
    }
    lines.push('');
  }

  const uiCount = graph.listNodes().filter((node) => !SECTIONS.some(([, kind]) => kind === node.kind)).length;
  lines.push(`UI nodes: ${uiCount}`, `Edges: ${graph.listEdges().length}`);
  return lines.join('\n');
}

function formatValidation(result: ValidationResult): string {
  const lines: string[] = [];
  for (const problem of result.errors) {
    lines.push(`error   [${problem.code}] ${problem.message}`);
  }
  for (const problem of result.warnings) {
    lines.push(`warning [${problem.code}] ${problem.message}`);
  }
  lines.push(
    result.valid
      ? `Graph is valid (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}).`
      : `Graph is invalid: ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}.`,
  );
  return lines.join('\n');
}

async function build(options: Options): Promise<void> {
  const graph = await loadGraph(options);
  const html = compileToHtml(graph);
  const outputDir = path.resolve(process.cwd(), 'dist');
  const outputFile = path.join(outputDir, `${graph.id}.html`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, html, 'utf8');
  console.log(`Built ${outputFile}`);
}

async function serve(options: Options): Promise<void> {
  const graph = await loadGraph(options);
  const ir = compileToIR(graph);
  const html = compileToHtml(graph);
  const matches = (pathname: string): boolean =>
    ir.routes.some((route) => {
      const parts = pathname.split('?')[0].split('/').filter(Boolean);
      return (
        route.segments.length === parts.length &&
        route.segments.every((segment, index) => segment.kind === 'parameter' || segment.value === parts[index])
      );
    });

  const server = createServer((request, response) => {
    if (request.url && matches(request.url)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('No route matches this path');
  });

  server.listen(options.port, '127.0.0.1', () => {
    console.log(`${graph.name} available at http://127.0.0.1:${options.port}`);
  });
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error(
      'Usage: axiom <build|inspect|validate|serve> <modelFile> [--export=name] [--port=3000]',
    );
    process.exitCode = 1;
    return;
  }

  switch (options.command) {
    case 'build':
      await build(options);
      return;
    case 'inspect': {
      console.log(inspect(await loadGraph(options)));
      return;
    }
    case 'validate': {
      const result = validateGraph(await loadGraph(options));
      console.log(formatValidation(result));
      if (!result.valid) {
        process.exitCode = 1;
      }
      return;
    }
    case 'serve':
      await serve(options);
      return;
    default:
      console.error(`Unknown command: ${options.command}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
