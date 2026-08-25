import { PROTOCOL_VERSION } from './protocol.js';
import type { EventResponse, InvokeResponse } from './protocol.js';
import { createAxiomServer } from './server.js';
import type { AxiomServer } from './server.js';
import { createDeterministicServerHost } from './host.js';
import { createFakeIntegrationAdapter } from './integration.js';
import type { IntegrationResult } from './integration.js';
import { createMemoryPersistence } from './persistence.js';
import type {
  ConformanceExpectation,
  ConformanceFailure,
  ConformanceFixture,
  ConformanceInvocation,
  ConformanceRunResult,
  ConformanceScriptedAdapter,
} from './conformance-types.js';

/**
 * The public reference runner over the portable conformance fixture format (spec 8.2
 * §14-16). It imports only `@cynodia/axiom-server` and a fixture — no graph, no compiler,
 * no builder — so a consumer can hold an independent implementation to exactly the standard
 * this runner does. Deliberately separate from `conformance-types.ts`: the fixture model is
 * language-independent, this adapter is TypeScript-specific, and a non-JS implementation
 * needs only the former plus the semantics `docs/AUTHORITY.md` documents.
 *
 * `packages/server/test/conformance.test.ts` runs every shipped fixture through this exact
 * function, so this is not a parallel, potentially-drifting reimplementation of what the
 * internal test suite does — it is what the internal test suite calls.
 */

const CONFORMANCE_VERSIONS = ['axiom.conformance.v1', 'axiom.conformance.v2'];

function buildScriptedAdapter(
  spec: ConformanceScriptedAdapter,
  host: ReturnType<typeof createDeterministicServerHost>,
): ReturnType<typeof createFakeIntegrationAdapter> {
  const makeHandler = (responses: ConformanceScriptedAdapter['query']) => {
    let index = 0;
    return async (): Promise<IntegrationResult> => {
      const response = responses?.[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) {
        return { ok: false, code: 'NOT_IMPLEMENTED', message: 'no scripted response registered' };
      }
      if (response.neverSettle) {
        return new Promise<IntegrationResult>(() => undefined);
      }
      // Models a provider that answers only after the deadline: the runtime's own
      // `timeoutMs` enforcement must already have answered by the time this settles, so the
      // late value must never mutate state or fire a follow-up (spec 8.2 §11 items 2-3).
      if (response.resolveAfterMs !== undefined) {
        const value = response.result ?? { ok: false, code: 'NOT_IMPLEMENTED', message: 'no result scripted' };
        return new Promise<IntegrationResult>((resolve) => {
          host.scheduleOnce(response.resolveAfterMs as number, () => resolve(value));
        });
      }
      return response.result ?? { ok: false, code: 'NOT_IMPLEMENTED', message: 'no result scripted' };
    };
  };
  return createFakeIntegrationAdapter({ query: makeHandler(spec.query), effect: makeHandler(spec.effect) });
}

/** One real macrotask turn, so a timer/microtask chain queued by the runtime can settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function checkExpectation(
  answer: InvokeResponse | EventResponse,
  expected: ConformanceExpectation | undefined,
  where: string,
  failures: ConformanceFailure[],
): void {
  const kind: string = answer.kind;
  if (kind !== 'result' && kind !== 'event-result') {
    failures.push({ where, message: `expected a result response, got kind "${kind}"` });
    return;
  }
  if (!expected) {
    return;
  }
  if (expected.ok !== undefined && answer.ok !== expected.ok) {
    failures.push({
      where,
      message: `expected ok=${expected.ok}, got ok=${answer.ok} (diagnostics: ${JSON.stringify(answer.diagnostics.map((d) => d.code))})`,
    });
  }
  for (const code of expected.diagnosticCodes ?? []) {
    if (!answer.diagnostics.some((diagnostic) => diagnostic.code === code)) {
      failures.push({
        where,
        message: `expected diagnostic ${code}, got ${JSON.stringify(answer.diagnostics.map((d) => d.code))}`,
      });
    }
  }
  for (const mode of expected.failureModes ?? []) {
    if (!answer.diagnostics.some((diagnostic) => diagnostic.details?.failureMode === mode)) {
      failures.push({ where, message: `expected failure mode ${mode}, not reported` });
    }
  }
  // An EventResponse carries no `changes`/`replayed` (the protocol reports those only for
  // an InvokeResponse) — a fixture's `event` step may only assert `ok`/diagnostics/failure
  // modes; anything downstream a dispatched event caused is checked via `expectedState`.
  if (expected.changedStates) {
    if (answer.kind !== 'result') {
      failures.push({ where, message: 'changedStates was asserted on a non-invoke response, which carries no changes' });
    } else {
      const actual = Object.keys(answer.changes).sort();
      const wanted = [...expected.changedStates].sort();
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        failures.push({
          where,
          message: `expected changed states ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
        });
      }
    }
  }
  if (expected.replayed !== undefined) {
    const replayed = answer.kind === 'result' ? (answer.replayed ?? false) : false;
    if (replayed !== expected.replayed) {
      failures.push({ where, message: `expected replayed=${expected.replayed}, got ${replayed}` });
    }
  }
}

function checkFinalState(server: AxiomServer, fixture: ConformanceFixture, where: string, failures: ConformanceFailure[]): void {
  for (const [stateId, expected] of Object.entries(fixture.expectedState)) {
    const actual = server.getState(stateId as never);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push({
        where,
        message: `state ${stateId}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      });
    }
  }
}

/**
 * Runs one conformance fixture against the TypeScript reference runtime and reports
 * structured pass/fail — never throws for an ordinary fixture failure, only for a
 * malformed fixture the format itself does not allow.
 */
export async function runConformanceFixture(fixture: ConformanceFixture): Promise<ConformanceRunResult> {
  const failures: ConformanceFailure[] = [];
  if (!CONFORMANCE_VERSIONS.includes(fixture.conformance)) {
    return { name: fixture.name, ok: false, failures: [{ where: 'conformance', message: `unknown fixture format ${fixture.conformance}` }] };
  }

  const persistence = createMemoryPersistence(fixture.initialState);
  const host = createDeterministicServerHost({
    authenticate: (credential) => (credential ? fixture.principals[credential] ?? null : null),
  });
  const integrations = Object.fromEntries(
    Object.entries(fixture.externalAdapters ?? {}).map(([id, spec]) => [id, buildScriptedAdapter(spec, host)]),
  );
  const server = createAxiomServer({ ir: fixture.serverIR, persistence, host, integrations });
  await server.start();

  if (fixture.steps) {
    const pending: Array<{ promise: Promise<InvokeResponse | EventResponse>; expect: ConformanceExpectation | undefined; where: string }> = [];
    for (const [index, step] of fixture.steps.entries()) {
      const where = `${fixture.name} step ${index}`;
      if (step.kind === 'advance') {
        await settle();
        host.advance(step.ms);
        continue;
      }
      const request =
        step.kind === 'invoke'
          ? {
              kind: 'invoke' as const,
              protocol: PROTOCOL_VERSION,
              actionId: step.actionId as never,
              arguments: step.arguments ?? {},
              ...(step.credential ? { credential: step.credential } : {}),
              ...(step.requestId ? { requestId: step.requestId } : {}),
            }
          : {
              kind: 'event' as const,
              protocol: PROTOCOL_VERSION,
              eventId: step.eventId as never,
              payload: step.payload,
              ...(step.credential ? { credential: step.credential } : {}),
            };
      pending.push({
        promise: server.handle(request as never) as Promise<InvokeResponse | EventResponse>,
        expect: step.expect,
        where,
      });
    }
    await settle();
    for (const { promise, expect, where } of pending) {
      checkExpectation(await promise, expect, where, failures);
    }
    checkFinalState(server, fixture, fixture.name, failures);
    await server.stop();
    return { name: fixture.name, ok: failures.length === 0, failures };
  }

  const invocations = fixture.invocations ?? [];
  const send = (invocation: ConformanceInvocation): Promise<InvokeResponse> =>
    server.handle({
      kind: 'invoke',
      protocol: PROTOCOL_VERSION,
      actionId: invocation.actionId as never,
      arguments: invocation.arguments ?? {},
      ...(invocation.credential ? { credential: invocation.credential } : {}),
      ...(invocation.requestId ? { requestId: invocation.requestId } : {}),
    }) as Promise<InvokeResponse>;

  const answers = fixture.concurrent
    ? await Promise.all(invocations.map(send))
    : await (async () => {
        const collected: InvokeResponse[] = [];
        for (const invocation of invocations) {
          collected.push(await send(invocation));
        }
        return collected;
      })();

  answers.forEach((answer, index) => {
    checkExpectation(answer, invocations[index]?.expect, `${fixture.name} invocation ${index}`, failures);
  });

  if (fixture.expect?.committedCount !== undefined) {
    const committed = answers.filter((answer) => answer.ok).length;
    if (committed !== fixture.expect.committedCount) {
      failures.push({
        where: fixture.name,
        message: `expected exactly ${fixture.expect.committedCount} invocations to commit, ${committed} did`,
      });
    }
  }

  checkFinalState(server, fixture, fixture.name, failures);
  await server.stop();

  if (fixture.restartAndReassert) {
    const restarted = createAxiomServer({ ir: fixture.serverIR, persistence, host });
    await restarted.start();
    checkFinalState(restarted, fixture, `${fixture.name} after restart`, failures);
    await restarted.stop();
  }

  return { name: fixture.name, ok: failures.length === 0, failures };
}

/** Runs a whole suite of fixtures and reports one result per fixture, in order. */
export async function runConformanceSuite(fixtures: ConformanceFixture[]): Promise<ConformanceRunResult[]> {
  const results: ConformanceRunResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runConformanceFixture(fixture));
  }
  return results;
}

export type {
  ConformanceExpectation,
  ConformanceFailure,
  ConformanceFixture,
  ConformanceInvocation,
  ConformanceManifest,
  ConformanceManifestEntry,
  ConformanceRunResult,
  ConformanceScriptedAdapter,
  ConformanceScriptedResponse,
  ConformanceStep,
} from './conformance-types.js';
