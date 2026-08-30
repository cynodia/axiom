import type { ServerIR } from './deps.js';
import type { PrincipalRecord } from './host.js';
import type { DataProvider } from './data-provider.js';
import { createAxiomServer } from './server.js';
import { createDeterministicServerHost } from './host.js';
import { applyDelta, type LiveQueryDelta, type LiveQueryHandle, type LiveQueryMessage } from './live-query.js';
import { PROTOCOL_VERSION } from './protocol.js';
import type { QueryResponse } from './protocol.js';

/**
 * The portable **live-query conformance** model (`axiom.conformance.v7`, spec13 §152, §194).
 *
 * A fixture is pure data: a Server IR (`axiom.server.v7`), a dataset of provider rows, the
 * live query to open, its required initial result, and a script of committed mutations each
 * paired with the live message that must follow (`update` with canonical changes, whole
 * `reset`, or `none` when the result did not move). Running one needs no part of this
 * implementation beyond a `DataProvider`; a runtime in another language builds its own
 * runner from these shapes plus `docs/LIVE_QUERIES.md`.
 *
 * The runner also checks the **primary invariant** (spec13 §15, §40, §195): folding the
 * delivered `initial` + delta/reset stream with {@link applyDelta} must equal a fresh
 * one-shot execution of the same `QueryDef` at the end of the script.
 */

export interface LiveChangeExpectation {
  kind: 'insert' | 'remove' | 'update' | 'move';
  /** The semantic row identity (the value of the source entity's identity field, stringified). */
  key: string;
}

export type LiveMessageExpectation =
  | { kind: 'none' }
  | { kind: 'update'; changes: LiveChangeExpectation[] }
  | { kind: 'reset'; rows: Array<Record<string, unknown>> };

export interface LiveQueryConformanceStep {
  invoke: { actionId: string; arguments?: Record<string, unknown>; credential?: string };
  expect: LiveMessageExpectation;
}

export interface LiveQueryConformanceFixture {
  conformance: 'axiom.conformance.v7';
  name: string;
  covers: string[];
  description: string;
  serverIR: ServerIR;
  dataset: Record<string, Array<Record<string, unknown>>>;
  principals?: Record<string, PrincipalRecord>;
  open: { queryId: string; arguments?: Record<string, unknown>; credential?: string };
  /** Exact ordered initial rows, or the error code a non-live-capable query must return. */
  expectInitial: Array<Record<string, unknown>> | { errorCode: string };
  steps: LiveQueryConformanceStep[];
}

export interface LiveQueryConformanceResult {
  name: string;
  passed: boolean;
  failures: string[];
}

export interface RunLiveQueryConformanceOptions {
  makeProvider(
    dataset: Record<string, Array<Record<string, unknown>>>,
    ir: ServerIR,
  ): DataProvider | Promise<DataProvider>;
  /** How long to wait for a live message before concluding `none` (default 100ms). */
  messageTimeoutMs?: number;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The `(kind:key)` multiset of a delta's row changes, sorted — `reset` maps to `['reset']`. */
function changeSignature(delta: LiveQueryDelta): string[] {
  return delta.changes
    .map((change) => (change.kind === 'reset' ? 'reset' : `${change.kind}:${change.key}`))
    .sort();
}

function expectationSignature(changes: LiveChangeExpectation[]): string[] {
  return changes.map((change) => `${change.kind}:${change.key}`).sort();
}

const SENTINEL = Symbol('no-message');

/**
 * Reads from a pull-based `AsyncIterator` with a timeout, without ever abandoning an
 * in-flight `next()`. A timed-out read keeps its pending promise so the *next* call re-races
 * the same one — otherwise a message pushed after the timeout would resolve an orphaned
 * promise and be lost (which is exactly the "expected a message, got nothing" flake).
 */
class MessageReader {
  private pending: Promise<IteratorResult<LiveQueryMessage>> | null = null;

  constructor(private readonly it: AsyncIterator<LiveQueryMessage>) {}

  async next(ms: number): Promise<LiveQueryMessage | typeof SENTINEL> {
    if (!this.pending) this.pending = this.it.next();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<typeof SENTINEL>((resolve) => {
      // Deliberately *not* unref'd. When the expected answer is `none` this timer is the only
      // thing left in the event loop — the live-query engine is idle by definition and the
      // authority's revision poll is itself unref'd — so an unref'd timeout lets the loop
      // drain, and `await` on a promise nothing will ever settle. `clearTimeout` in the
      // `finally` below is what stops it outliving the read.
      timer = setTimeout(() => resolve(SENTINEL), ms);
    });
    try {
      const result = await Promise.race([this.pending, timeout]);
      if (result === SENTINEL) return SENTINEL;
      this.pending = null;
      return result.done ? SENTINEL : result.value;
    } finally {
      clearTimeout(timer!);
    }
  }
}

export async function runLiveQueryConformanceFixture(
  fixture: LiveQueryConformanceFixture,
  options: RunLiveQueryConformanceOptions,
): Promise<LiveQueryConformanceResult> {
  const failures: string[] = [];
  const timeoutMs = options.messageTimeoutMs ?? 100;
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

  const identityFieldId = (() => {
    const query = (fixture.serverIR.queries ?? []).find((q) => String(q.id) === fixture.open.queryId);
    const source = query
      ? (fixture.serverIR.entities ?? []).find((e) => String(e.id) === String(query.source))
      : undefined;
    return source?.identityFieldId ? String(source.identityFieldId) : undefined;
  })();

  try {
    const opened = await server.openLiveQuery({
      queryId: fixture.open.queryId,
      ...(fixture.open.arguments ? { arguments: fixture.open.arguments } : {}),
      ...(fixture.open.credential ? { credential: fixture.open.credential } : {}),
    });

    if ('error' in opened) {
      if (!('errorCode' in fixture.expectInitial)) {
        failures.push(`open failed unexpectedly: ${JSON.stringify(opened.error)}`);
      } else if (opened.error.code !== fixture.expectInitial.errorCode) {
        failures.push(
          `open error code mismatch: expected ${fixture.expectInitial.errorCode}, got ${opened.error.code}`,
        );
      }
      return { name: fixture.name, passed: failures.length === 0, failures };
    }

    if ('errorCode' in fixture.expectInitial) {
      failures.push(`expected open to fail with ${fixture.expectInitial.errorCode}, but it succeeded`);
      (opened as LiveQueryHandle).close();
      return { name: fixture.name, passed: false, failures };
    }

    const handle = opened as LiveQueryHandle;
    const reader = new MessageReader(handle[Symbol.asyncIterator]());

    const first = await reader.next(timeoutMs);
    if (first === SENTINEL || first.kind !== 'initial') {
      failures.push(`expected an initial message, got ${first === SENTINEL ? 'nothing' : first.kind}`);
      handle.close();
      return { name: fixture.name, passed: false, failures };
    }
    if (!eq(first.rows, fixture.expectInitial)) {
      failures.push(
        `initial rows mismatch\n  expected ${JSON.stringify(fixture.expectInitial)}\n  got      ${JSON.stringify(first.rows)}`,
      );
    }
    let folded: unknown[] = first.rows;

    for (const [index, step] of fixture.steps.entries()) {
      const label = `${fixture.name} step ${index} (${step.invoke.actionId})`;
      const response = (await server.handle({
        kind: 'invoke',
        protocol: PROTOCOL_VERSION,
        actionId: step.invoke.actionId as never,
        arguments: step.invoke.arguments ?? {},
        ...(step.invoke.credential ? { credential: step.invoke.credential } : {}),
      })) as { ok: boolean; diagnostics?: Array<{ code: string }> };
      if (!response.ok) {
        failures.push(`${label}: invoke was refused: ${JSON.stringify(response.diagnostics)}`);
      }

      const message = await reader.next(timeoutMs);
      if (step.expect.kind === 'none') {
        if (message !== SENTINEL) {
          failures.push(`${label}: expected no live message, got ${JSON.stringify(message)}`);
          if (message.kind === 'update') folded = applyDelta(folded, message.delta, identityFieldId);
          else if (message.kind === 'reset') folded = message.rows;
        }
        continue;
      }
      if (message === SENTINEL) {
        failures.push(`${label}: expected a ${step.expect.kind} message, got nothing`);
        continue;
      }
      if (message.kind === 'update') {
        folded = applyDelta(folded, message.delta, identityFieldId);
        if (step.expect.kind !== 'update') {
          failures.push(`${label}: expected ${step.expect.kind}, got update`);
        } else if (!eq(changeSignature(message.delta), expectationSignature(step.expect.changes))) {
          failures.push(
            `${label}: change set mismatch\n  expected ${JSON.stringify(expectationSignature(step.expect.changes))}\n  got      ${JSON.stringify(changeSignature(message.delta))}`,
          );
        }
      } else if (message.kind === 'reset') {
        folded = message.rows;
        if (step.expect.kind !== 'reset') {
          failures.push(`${label}: expected ${step.expect.kind}, got reset`);
        } else if (!eq(message.rows, step.expect.rows)) {
          failures.push(
            `${label}: reset rows mismatch\n  expected ${JSON.stringify(step.expect.rows)}\n  got      ${JSON.stringify(message.rows)}`,
          );
        }
      } else {
        failures.push(`${label}: unexpected message kind ${message.kind}`);
      }
    }

    handle.close();

    // Primary invariant (spec13 §15, §40, §195): the folded live result equals a fresh
    // one-shot execution of the same QueryDef.
    const fresh = (await server.handle({
      kind: 'query',
      protocol: PROTOCOL_VERSION,
      queryId: fixture.open.queryId as never,
      ...(fixture.open.arguments ? { arguments: fixture.open.arguments } : {}),
      ...(fixture.open.credential ? { credential: fixture.open.credential } : {}),
    } as never)) as QueryResponse;
    if (fresh.aggregate) {
      // A reset-only query: compare the folded rows to the fresh aggregate rows directly.
      const freshRows = fresh.aggregate.rows.map((r) => r.values);
      if (!eq(folded, freshRows)) {
        failures.push(
          `folded live result != fresh aggregate result\n  folded ${JSON.stringify(folded)}\n  fresh  ${JSON.stringify(freshRows)}`,
        );
      }
    } else {
      const freshItems = fresh.page?.items ?? [];
      const key = (row: unknown): string =>
        identityFieldId && row && typeof row === 'object'
          ? String((row as Record<string, unknown>)[identityFieldId])
          : JSON.stringify(row);
      if (!eq(folded.map(key).sort(), [...freshItems].map(key).sort())) {
        failures.push(
          `folded live result != fresh QueryDef result\n  folded ${JSON.stringify(folded.map(key).sort())}\n  fresh  ${JSON.stringify(freshItems.map(key).sort())}`,
        );
      }
    }
  } finally {
    await server.stop();
  }

  return { name: fixture.name, passed: failures.length === 0, failures };
}

export async function runLiveQueryConformanceSuite(
  fixtures: readonly LiveQueryConformanceFixture[],
  options: RunLiveQueryConformanceOptions,
): Promise<{ passed: boolean; results: LiveQueryConformanceResult[] }> {
  const results: LiveQueryConformanceResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runLiveQueryConformanceFixture(fixture, options));
  }
  return { passed: results.every((result) => result.passed), results };
}
