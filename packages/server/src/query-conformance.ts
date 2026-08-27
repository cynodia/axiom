import type { ServerIR } from './deps.js';
import type { PrincipalRecord } from './host.js';
import type { DataProvider } from './data-provider.js';
import { createAxiomServer } from './server.js';
import { createDeterministicServerHost } from './host.js';
import type { QueryResponse } from './protocol.js';
import { PROTOCOL_VERSION } from './protocol.js';

/**
 * The portable **query conformance** model (`axiom.conformance.v4`, spec 0.10 §89-91).
 *
 * A fixture is pure data: a Server IR (`axiom.server.v6`), a dataset of provider rows, the
 * principals, and a sequence of query / invoke steps with the results required. Running one
 * needs no part of this implementation beyond a `DataProvider`; a runtime in another
 * language builds its own runner from these shapes plus `docs/AUTHORITY.md` and
 * `docs/QUERIES.md`.
 */

export interface QueryConformanceExpectation {
  ok?: boolean;
  /** Exact projected/row items for a row query. */
  items?: Array<Record<string, unknown>>;
  /** Exact aggregate rows for an aggregate query. */
  aggregateRows?: Array<{ key?: unknown[]; values: Record<string, unknown> }>;
  hasMore?: boolean;
  /** Whether a non-null `nextCursor` is required (true) or forbidden (false). */
  hasNextCursor?: boolean;
  diagnosticCodes?: string[];
}

export type QueryConformanceStep =
  | {
      kind: 'query';
      queryId: string;
      arguments?: Record<string, unknown>;
      /** `'$prev'` reuses the `nextCursor` from the previous query step. */
      cursor?: string;
      pageSize?: number;
      offset?: number;
      credential?: string;
      expect: QueryConformanceExpectation;
    }
  | {
      kind: 'invoke';
      actionId: string;
      arguments?: Record<string, unknown>;
      credential?: string;
      expect?: { ok?: boolean; diagnosticCodes?: string[] };
    };

export interface QueryConformanceFixture {
  conformance: 'axiom.conformance.v4';
  name: string;
  covers: string[];
  description: string;
  serverIR: ServerIR;
  dataset: Record<string, Array<Record<string, unknown>>>;
  principals?: Record<string, PrincipalRecord>;
  steps: QueryConformanceStep[];
}

export interface QueryConformanceResult {
  name: string;
  passed: boolean;
  failures: string[];
  /** Per query-step, the items returned — so a caller can cross-check two providers. */
  queryResults: Array<{ items?: Array<Record<string, unknown>>; aggregateRows?: unknown[] }>;
}

export interface RunQueryConformanceOptions {
  /** Builds the provider for one fixture's dataset. */
  makeProvider(dataset: Record<string, Array<Record<string, unknown>>>, ir: ServerIR): DataProvider | Promise<DataProvider>;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runQueryConformanceFixture(
  fixture: QueryConformanceFixture,
  options: RunQueryConformanceOptions,
): Promise<QueryConformanceResult> {
  const failures: string[] = [];
  const queryResults: QueryConformanceResult['queryResults'] = [];
  const provider = await options.makeProvider(fixture.dataset, fixture.serverIR);
  const principals = fixture.principals ?? {};
  const server = createAxiomServer({
    ir: fixture.serverIR,
    host: createDeterministicServerHost({
      authenticate: (credential) => (credential && principals[credential]) || null,
    }),
    dataProvider: provider,
    cursorSecret: 'conformance',
  });
  await server.start();

  let previousCursor: string | null = null;
  for (const [index, step] of fixture.steps.entries()) {
    const label = `${fixture.name} step ${index} (${step.kind})`;
    if (step.kind === 'invoke') {
      const response = (await server.handle({
        kind: 'invoke',
        protocol: PROTOCOL_VERSION,
        actionId: step.actionId as never,
        arguments: step.arguments ?? {},
        ...(step.credential ? { credential: step.credential } : {}),
      })) as { ok: boolean; diagnostics: Array<{ code: string }> };
      if (step.expect?.ok !== undefined && response.ok !== step.expect.ok) {
        failures.push(`${label}: expected ok=${step.expect.ok}, got ${response.ok}`);
      }
      for (const code of step.expect?.diagnosticCodes ?? []) {
        if (!response.diagnostics.some((diagnostic) => diagnostic.code === code)) {
          failures.push(`${label}: expected diagnostic ${code}`);
        }
      }
      continue;
    }

    const cursor = step.cursor === '$prev' ? previousCursor ?? undefined : step.cursor;
    const response = (await server.handle({
      kind: 'query',
      protocol: PROTOCOL_VERSION,
      queryId: step.queryId as never,
      ...(step.arguments ? { arguments: step.arguments } : {}),
      ...(cursor ? { cursor } : {}),
      ...(step.pageSize !== undefined ? { pageSize: step.pageSize } : {}),
      ...(step.offset !== undefined ? { offset: step.offset } : {}),
      ...(step.credential ? { credential: step.credential } : {}),
    })) as QueryResponse;

    queryResults.push({
      ...(response.page ? { items: response.page.items as Array<Record<string, unknown>> } : {}),
      ...(response.aggregate ? { aggregateRows: response.aggregate.rows } : {}),
    });

    const expect = step.expect;
    if (expect.ok !== undefined && response.ok !== expect.ok) {
      failures.push(`${label}: expected ok=${expect.ok}, got ${response.ok} (${JSON.stringify(response.diagnostics)})`);
    }
    for (const code of expect.diagnosticCodes ?? []) {
      if (!response.diagnostics.some((diagnostic) => diagnostic.code === code)) {
        failures.push(`${label}: expected diagnostic ${code}, got ${JSON.stringify(response.diagnostics)}`);
      }
    }
    if (expect.items !== undefined) {
      if (!eq(response.page?.items ?? null, expect.items)) {
        failures.push(`${label}: items mismatch\n  expected ${JSON.stringify(expect.items)}\n  got      ${JSON.stringify(response.page?.items)}`);
      }
    }
    if (expect.aggregateRows !== undefined) {
      if (!eq(response.aggregate?.rows ?? null, expect.aggregateRows)) {
        failures.push(`${label}: aggregate rows mismatch\n  expected ${JSON.stringify(expect.aggregateRows)}\n  got      ${JSON.stringify(response.aggregate?.rows)}`);
      }
    }
    if (expect.hasMore !== undefined && response.page?.hasMore !== expect.hasMore) {
      failures.push(`${label}: expected hasMore=${expect.hasMore}, got ${response.page?.hasMore}`);
    }
    if (expect.hasNextCursor !== undefined) {
      const present = Boolean(response.page?.nextCursor);
      if (present !== expect.hasNextCursor) {
        failures.push(`${label}: expected hasNextCursor=${expect.hasNextCursor}, got ${present}`);
      }
    }
    previousCursor = response.page?.nextCursor ?? null;
  }

  await server.stop();
  return { name: fixture.name, passed: failures.length === 0, failures, queryResults };
}

/** Runs every fixture and returns the aggregate outcome. */
export async function runQueryConformanceSuite(
  fixtures: readonly QueryConformanceFixture[],
  options: RunQueryConformanceOptions,
): Promise<{ passed: boolean; results: QueryConformanceResult[] }> {
  const results: QueryConformanceResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runQueryConformanceFixture(fixture, options));
  }
  return { passed: results.every((result) => result.passed), results };
}
