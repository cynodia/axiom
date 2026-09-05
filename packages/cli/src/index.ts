#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileToHtml, compileToIR, compileToServerIR, hasServerAuthority } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createMemoryPersistence,
  createServerHost,
  createSqliteMigrationStore,
  createSqlitePersistence,
  createSqliteRowStore,
  dispatch,
  executeMigration,
  explainMigration,
  getMigrationStatus,
  isSqliteAvailable,
  migrationAuthority,
  planMigration,
} from '@cynodia/axiom-server';
import type { AxiomServer, PersistenceAdapter } from '@cynodia/axiom-server';
import { ApplicationGraph, diffSchema, formatLocation, semanticContextFromGraph, semanticDiff, validateGraph } from '@cynodia/axiom-core';
import type { AnyNode, NodeKind, Operation, SemanticContext, ValidationResult } from '@cynodia/axiom-core';
import { AgentAPI, explainSchemaDiff, inspectSchema, migrationImpact } from '@cynodia/axiom-agent-api';

const GRAPH_EXPORT_CANDIDATES = ['default', 'createGraph', 'createApplicationGraph'];

interface Options {
  command: string;
  modelFile: string;
  exportName?: string;
  port: number;
  /** Where authoritative state persists. Absent, it is held in memory. */
  store?: string;
  /** Schema-evolution flags. */
  from?: number;
  approve?: string[];
  sqlite?: string;
  against?: string;
  againstExport?: string;
  /** `explain`: which kind of node, and which id, to explain. */
  kind?: string;
  targetId?: string;
  /** Structured output for CI and external tooling (spec16 §108). */
  json?: boolean;
}

/** `<group> <sub>` command forms. `migrate` alone (no sub) is also valid. */
const SUBCOMMANDS: Record<string, Set<string>> = {
  schema: new Set(['status', 'diff']),
  migrate: new Set(['plan', 'status']),
};

function parseArguments(argv: string[]): Options | null {
  const positional: string[] = [];
  let exportName: string | undefined;
  let port = 3000;
  let store: string | undefined;
  let from: number | undefined;
  let approve: string[] | undefined;
  let sqlite: string | undefined;
  let against: string | undefined;
  let againstExport: string | undefined;
  let json = false;

  for (const argument of argv) {
    if (argument.startsWith('--export=')) {
      exportName = argument.slice('--export='.length);
    } else if (argument.startsWith('--port=')) {
      port = Number(argument.slice('--port='.length)) || port;
    } else if (argument.startsWith('--store=')) {
      store = argument.slice('--store='.length);
    } else if (argument.startsWith('--from=')) {
      from = Number(argument.slice('--from='.length));
    } else if (argument.startsWith('--approve=')) {
      approve = argument.slice('--approve='.length).split(',').filter(Boolean);
    } else if (argument.startsWith('--sqlite=')) {
      sqlite = argument.slice('--sqlite='.length);
    } else if (argument.startsWith('--against=')) {
      against = argument.slice('--against='.length);
    } else if (argument.startsWith('--against-export=')) {
      againstExport = argument.slice('--against-export='.length);
    } else if (argument === '--json') {
      json = true;
    } else {
      positional.push(argument);
    }
  }

  let [command, modelFile] = positional;
  let kind: string | undefined;
  let targetId: string | undefined;
  if (command === 'explain') {
    // `axiom explain <kind> <id> <modelFile>` — three positionals after the command itself.
    kind = positional[1];
    targetId = positional[2];
    modelFile = positional[3];
  } else if (command && SUBCOMMANDS[command]?.has(positional[1] ?? '')) {
    command = `${command} ${positional[1]}`;
    modelFile = positional[2];
  }
  if (!command || !modelFile) {
    return null;
  }
  return {
    command,
    modelFile,
    exportName,
    port,
    ...(store ? { store } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(approve ? { approve } : {}),
    ...(sqlite ? { sqlite } : {}),
    ...(against ? { against } : {}),
    ...(againstExport ? { againstExport } : {}),
    ...(kind ? { kind } : {}),
    ...(targetId ? { targetId } : {}),
    ...(json ? { json } : {}),
  };
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
  return loadGraphModule(options.modelFile, options.exportName);
}

async function loadGraphModule(modelFile: string, exportName?: string): Promise<ApplicationGraph> {
  const options = { modelFile, exportName } as Options;
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
  lines.push(`UI nodes: ${uiCount}`, `Edges: ${graph.semanticEdges().length}`);
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

/** The authoritative half, when the graph has one. No application code is involved. */
async function startAuthority(
  graph: ApplicationGraph,
  options: Options,
): Promise<AxiomServer | null> {
  if (!hasServerAuthority(graph)) {
    return null;
  }
  let persistence: PersistenceAdapter;
  if (options.store && (await isSqliteAvailable())) {
    persistence = await createSqlitePersistence({ location: options.store });
    console.log(`Authoritative state persists to ${options.store}`);
  } else {
    if (options.store) {
      console.warn('node:sqlite is unavailable; authoritative state is held in memory only');
    }
    persistence = createMemoryPersistence();
  }
  const server = createAxiomServer({
    ir: compileToServerIR(graph),
    persistence,
    host: createServerHost({
      // Authentication belongs to a host. This one reads a bearer credential and treats it
      // as the caller's identity, which is enough to demonstrate the boundary and no more.
      authenticate: (credential) =>
        credential ? { [PRINCIPAL_IDENTITY]: credential } : null,
      report: (event) => {
        if (event.kind !== 'snapshot') {
          console.log(
            `[axiom] ${event.kind} ${event.actionId ?? ''} ${event.ok === undefined ? '' : event.ok ? 'ok' : 'refused'}`.trim(),
          );
        }
      },
    }),
  });
  await server.start();
  return server;
}

/** The identity field of the graph's principal entity, resolved at startup. */
let PRINCIPAL_IDENTITY = 'id';

async function serve(options: Options): Promise<void> {
  const graph = await loadGraph(options);
  const ir = compileToIR(graph);
  const html = compileToHtml(graph);
  const principalEntity = graph.principalEntityId
    ? graph.getNode(graph.principalEntityId)
    : undefined;
  if (principalEntity?.kind === 'entity' && principalEntity.identityFieldId) {
    PRINCIPAL_IDENTITY = String(principalEntity.identityFieldId);
  }
  const authority = await startAuthority(graph, options);
  const matches = (pathname: string): boolean =>
    ir.routes.some((route) => {
      const parts = pathname.split('?')[0].split('/').filter(Boolean);
      return (
        route.segments.length === parts.length &&
        route.segments.every((segment, index) => segment.kind === 'parameter' || segment.value === parts[index])
      );
    });

  const server = createServer((request, response) => {
    void (async () => {
      // One semantic endpoint, the same for every application. No route is declared here
      // and none is generated: the client asks for actions, not for URLs.
      if (authority && request.method === 'POST' && (request.url ?? '').split('?')[0] === SEMANTIC_ENDPOINT) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(chunk as Buffer);
        }
        let body: unknown = null;
        try {
          body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end('{"kind":"error","diagnostics":[]}');
          return;
        }
        const answer = await dispatch(authority, body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer));
        return;
      }
      if (request.url && matches(request.url)) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('No route matches this path');
    })();
  });

  server.listen(options.port, '127.0.0.1', () => {
    console.log(`${graph.name} available at http://127.0.0.1:${options.port}`);
    if (authority) {
      console.log(
        `Authoritative runtime at http://127.0.0.1:${options.port}${SEMANTIC_ENDPOINT} — ` +
          `${Object.keys(compileToServerIR(graph).actions).length} server actions`,
      );
    }
  });
}

/** The one endpoint every Axiom authority answers on. */
const SEMANTIC_ENDPOINT = '/axiom';

// --- Schema evolution (spec11 §89-91) --------------------------------------
// Thin wrappers over the already-tested library functions. The CLI is a consumer,
// never the definition of behaviour.

function schemaStatus(graph: ApplicationGraph): string {
  const s = inspectSchema(graph);
  const lines = [
    `semantic schema version : ${s.schemaVersion}`,
    `schema fingerprint      : ${s.schemaFingerprint}`,
    `migration chain          : ${s.chainComplete ? 'complete (1 → ' + s.schemaVersion + ')' : 'INCOMPLETE'}`,
    `entities                 : ${s.entities.length}`,
    `persisted states         : ${s.persistedStates.length}`,
    `relationships            : ${s.relationships.length}`,
    `read policies            : ${s.readPolicies.length}`,
  ];
  if (s.migrations.length > 0) {
    lines.push('migrations:');
    for (const migration of s.migrations) {
      lines.push(
        `  ${migration.fromSchema} → ${migration.toSchema}  ${migration.id}  (${migration.operationCount} ops, ${migration.destructiveOperationCount} destructive)`,
      );
    }
  }
  return lines.join('\n');
}

async function schemaDiff(options: Options): Promise<string> {
  if (!options.against) {
    throw new Error('schema diff needs a --against=<file> naming the previous schema');
  }
  const previous = await loadGraphModule(options.against, options.againstExport);
  const next = await loadGraph(options);
  const diff = diffSchema(previous, next);
  const impact = migrationImpact(previous, next);
  const parts = [
    explainSchemaDiff(diff),
    '',
    `verdict            : ${impact.verdict}`,
    `data loss possible : ${impact.dataLossPossible}`,
    `migration covers it: ${impact.covered}${impact.covered ? '' : ' — uncovered: ' + impact.uncovered.map((e) => e.fieldId ?? e.entityId).join(', ')}`,
    `affected queries   : ${impact.affectedQueries.length}`,
    `affected actions   : ${impact.affectedActions.length}`,
    `affected constraints: ${impact.affectedConstraints.length}`,
    `affected UI nodes  : ${impact.affectedUiNodes.length}`,
  ];
  if (impact.authorizationChanges.length > 0) {
    parts.push(`authorization changes: ${impact.authorizationChanges.join(', ')}`);
  }
  return parts.join('\n');
}

async function migratePlan(options: Options): Promise<string> {
  const graph = await loadGraph(options);
  const ir = compileToServerIR(graph, { validate: false });
  const from = options.from ?? 1;
  const result = planMigration(ir, { fromVersion: from });
  if (!result.ok) {
    process.exitCode = 1;
    return result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n');
  }
  return explainMigration(result.plan);
}

async function migrateStatus(options: Options): Promise<string> {
  if (!options.sqlite) {
    throw new Error('migrate status needs --sqlite=<path> to read the provider metadata');
  }
  if (!(await isSqliteAvailable())) {
    throw new Error('this Node build has no node:sqlite');
  }
  const metadata = await createSqliteMigrationStore({ location: options.sqlite });
  const status = await getMigrationStatus(metadata);
  return [
    `schema version : ${status.schemaVersion ?? '(unstamped)'}`,
    `fingerprint    : ${status.schemaFingerprint ?? '(none)'}`,
    `phase          : ${status.phase}`,
    `lock           : ${status.lock ? status.lock.holder : 'free'}`,
    `checkpoint     : ${status.checkpoint ? `op ${status.checkpoint.operationIndex}, ${status.checkpoint.rowsProcessed} rows` : 'none'}`,
    `history        : ${status.history.map((h) => `${h.fromSchema}→${h.toSchema}`).join(', ') || 'none'}`,
  ].join('\n');
}

async function migrateRun(options: Options): Promise<string> {
  if (!options.sqlite) {
    return `${await migratePlan(options)}\n\n(supply --sqlite=<path> to execute this migration against a SQLite database)`;
  }
  if (!(await isSqliteAvailable())) {
    throw new Error('this Node build has no node:sqlite');
  }
  const graph = await loadGraph(options);
  const ir = compileToServerIR(graph, { validate: false });
  const rows = await createSqliteRowStore({ location: options.sqlite, ir });
  const metadata = await createSqliteMigrationStore({
    location: options.sqlite,
    database: (rows as { database: unknown }).database,
  });
  const result = await executeMigration({
    ir,
    metadata,
    rows,
    principal: migrationAuthority('axiom-cli'),
    ...(options.from !== undefined ? { fromVersion: options.from } : {}),
    approveDestructive: options.approve ?? [],
  });
  if (!result.ok) {
    process.exitCode = 1;
    return `${result.code}: ${result.message}`;
  }
  return [
    `migrated ${result.plan.fromVersion} → ${result.plan.toVersion}`,
    `rows transformed : ${result.run.rowsTransformed}`,
    `resumed          : ${result.run.resumed}`,
    `gate now         : ${result.gate.status}`,
  ].join('\n');
}

// --- Explainability & AI authoring tooling (spec16 §106-112) ---------------
// Thin renderers over AgentAPI / core, exactly like the schema commands above:
// the CLI is a consumer of the canonical analysis, never a second place it lives.

function formatExplanation(kind: string, result: Record<string, unknown>): string {
  const lines: string[] = [];
  switch (kind) {
    case 'action': {
      const reads = result.reads as { stateIds: string[] };
      const writes = result.writes as { stateIds: string[] };
      const authorization = result.authorization as { kind: string };
      const invokedBy = result.invokedBy as { triggers: string[]; workflowSteps: string[] };
      lines.push(`action ${result.actionId}${result.name ? ` (${result.name})` : ''}`);
      lines.push(`  reads     : ${reads.stateIds.join(', ') || 'none'}`);
      lines.push(`  writes    : ${writes.stateIds.join(', ') || 'none'}`);
      lines.push(`  authorization: ${authorization.kind}`);
      lines.push(`  invoked by: triggers [${invokedBy.triggers.join(', ')}], workflows [${invokedBy.workflowSteps.join(', ')}]`);
      if (result.analysisComplete === false) {
        lines.push(`  INCOMPLETE — ${(result.analysisGaps as string[]).join('; ')}`);
      }
      break;
    }
    case 'query': {
      const authorization = result.authorization as { kind: string };
      lines.push(`query ${result.queryId}`);
      lines.push(`  source        : ${result.source}`);
      lines.push(`  authorization : ${authorization.kind}`);
      lines.push(`  live capability: ${result.liveCapability}`);
      break;
    }
    case 'workflow': {
      const steps = result.steps as Array<{ id: string; type: string }>;
      lines.push(`workflow ${result.workflowId}`);
      lines.push(`  steps       : ${steps.map((s) => `${s.id}:${s.type}`).join(', ')}`);
      lines.push(`  start policy: ${result.startPolicyId ?? 'public'}`);
      lines.push(`  privilege-review actions: ${(result.privilegeReviewActions as string[]).join(', ') || 'none'}`);
      break;
    }
    case 'state': {
      lines.push(`state ${result.stateId}`);
      lines.push(`  authority : ${result.authority}   derived: ${result.derived}   draft: ${result.draft}`);
      lines.push(`  writers   : ${(result.writers as string[]).join(', ') || 'none'}`);
      lines.push(`  readers   : ${(result.readers as string[]).join(', ') || 'none'}`);
      break;
    }
    default:
      lines.push(JSON.stringify(result, null, 2));
  }
  return lines.join('\n');
}

async function explainCommand(options: Options): Promise<string> {
  if (!options.kind || !options.targetId) {
    throw new Error('usage: axiom explain <action|query|workflow|state> <id> <modelFile>');
  }
  const agent = new AgentAPI(await loadGraph(options));
  let result: Record<string, unknown> | undefined;
  switch (options.kind) {
    case 'action':
      result = agent.explainAction(options.targetId as never) as unknown as Record<string, unknown> | undefined;
      break;
    case 'query':
      result = agent.explainQuery(options.targetId as never) as unknown as Record<string, unknown> | undefined;
      break;
    case 'workflow':
      result = agent.explainWorkflow(options.targetId as never) as unknown as Record<string, unknown>;
      break;
    case 'state':
      result = agent.explainState(options.targetId as never) as unknown as Record<string, unknown> | undefined;
      break;
    default:
      throw new Error(`explain: unknown kind "${options.kind}" (expected action, query, workflow or state)`);
  }
  if (!result) {
    process.exitCode = 1;
    return `No ${options.kind} node "${options.targetId}" in this graph`;
  }
  return options.json ? JSON.stringify(result, null, 2) : formatExplanation(options.kind, result);
}

async function analyzeCommand(options: Options): Promise<string> {
  const agent = new AgentAPI(await loadGraph(options));
  const summary = agent.explainGraph();
  const capabilities = agent.analyzeCapabilities();
  const native = agent.summarizeNativeOperations();
  const authorization = agent.analyzeAuthorization();
  if (options.json) {
    return JSON.stringify({ summary, capabilities, native, unprotected: authorization.unprotected }, null, 2);
  }
  return [
    `nodes by kind : ${Object.entries(summary.nodeCountsByKind).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `executable roots: ${summary.executableRoots.actions.length} client-invocable action(s), ${summary.executableRoots.workflows.length} workflow(s), ${summary.executableRoots.queries.length} quer(y/ies)`,
    `security      : ${summary.securityBoundaries.protectedActions} protected / ${summary.securityBoundaries.publicActions} public action(s); ${summary.securityBoundaries.protectedQueries} protected / ${summary.securityBoundaries.publicQueries} public quer(y/ies)`,
    `native ops    : ${native.count} (${native.opaqueCount} opaque — static analysis cannot see past them)`,
    `capabilities  : ${capabilities.requiredCapabilities.join(', ') || 'none required'}`,
    `unprotected   : ${authorization.unprotected.length} surface(s) with no explicit authorization boundary`,
  ].join('\n');
}

async function diffCommand(options: Options): Promise<string> {
  if (!options.against) {
    throw new Error('diff needs a --against=<file> naming the graph to compare against');
  }
  const before = await loadGraphModule(options.against, options.againstExport);
  const after = await loadGraph(options);
  const diff = semanticDiff(before, after);
  if (options.json) {
    return JSON.stringify(diff, null, 2);
  }
  const lines = [
    `${diff.entries.length} node change(s), ${diff.schema.entries.length} schema change(s)`,
    ...diff.entries.map((entry) => `  ${entry.changeKind[0].toUpperCase()} ${entry.nodeKind} ${entry.nodeId} [${entry.categories.join(', ')}]`),
    ...diff.schema.entries.map((entry) => `  ~ schema: ${entry.message}`),
    '',
    `semanticFingerprint changed : ${diff.compatibility.semanticFingerprintChanged}`,
    `schemaFingerprint changed   : ${diff.compatibility.schemaFingerprintChanged}`,
    `server contract             : ${diff.compatibility.serverContractBefore} -> ${diff.compatibility.serverContractAfter}`,
  ];
  return lines.join('\n');
}

/**
 * The one usage text, printed both for `--help` (exit 0) and for missing/malformed
 * arguments (exit 1) — a fresh consumer must be able to discover every command and its
 * `--json` / exit behavior from this alone, without repository access (spec16pt2 §63-64).
 */
const USAGE = [
  'axiom — inspect, validate, explain and analyze an Axiom application graph.',
  '',
  'Usage:',
  '  axiom <build|inspect|serve> <modelFile> [--export=name] [--port=3000] [--store=state.db]',
  '  axiom validate <modelFile> [--export=name] [--json]',
  '  axiom schema status  <modelFile> [--export=name]',
  '  axiom schema diff    <modelFile> --against=<prevFile> [--export=name] [--against-export=name]',
  '  axiom migrate plan   <modelFile> [--export=name] [--from=<version>]',
  '  axiom migrate        <modelFile> [--export=name] [--from=<version>] [--approve=op1,op2] [--sqlite=<path>]',
  '  axiom migrate status <modelFile> --sqlite=<path>',
  '  axiom explain <action|query|workflow|state> <id> <modelFile> [--json]',
  '  axiom analyze <modelFile> [--json]',
  '  axiom diff <modelFile> --against=<prevFile> [--export=name] [--against-export=name] [--json]',
  '  axiom --help',
  '',
  '<modelFile> is a compiled (built) JavaScript module exporting an ApplicationGraph or a',
  'function that builds one — see docs/AGENT_API.md and docs/AGENT_REFERENCE.md in',
  '@cynodia/axiom for the semantic contract every command renders.',
  '',
  'Exit codes: 0 on success; nonzero on invalid input, an invalid graph, or a tooling failure.',
].join('\n');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(USAGE);
    return;
  }

  const options = parseArguments(argv);
  if (!options) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  switch (options.command) {
    case 'schema status':
      console.log(schemaStatus(await loadGraph(options)));
      return;
    case 'schema diff':
      console.log(await schemaDiff(options));
      return;
    case 'migrate plan':
      console.log(await migratePlan(options));
      return;
    case 'migrate status':
      console.log(await migrateStatus(options));
      return;
    case 'migrate':
      console.log(await migrateRun(options));
      return;
    case 'build':
      await build(options);
      return;
    case 'inspect': {
      console.log(inspect(await loadGraph(options)));
      return;
    }
    case 'validate': {
      const result = validateGraph(await loadGraph(options));
      console.log(options.json ? JSON.stringify(result, null, 2) : formatValidation(result));
      if (!result.valid) {
        process.exitCode = 1;
      }
      return;
    }
    case 'serve':
      await serve(options);
      return;
    case 'explain':
      console.log(await explainCommand(options));
      return;
    case 'analyze':
      console.log(await analyzeCommand(options));
      return;
    case 'diff':
      console.log(await diffCommand(options));
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
