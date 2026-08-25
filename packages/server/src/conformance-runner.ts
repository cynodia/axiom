import { PROTOCOL_VERSION } from './protocol.js';
import type { EventResponse, InvokeResponse } from './protocol.js';
import { createAxiomServer } from './server.js';
import type { AxiomServer } from './server.js';
import { createDeterministicServerHost } from './host.js';
import { createFakeIntegrationAdapter } from './integration.js';
import type { IntegrationResult } from './integration.js';
import { createMemoryPersistence } from './persistence.js';
import { createScriptedSubscriptionAdapter } from './subscription.js';
import type { SubscriptionAdapter } from './subscription.js';
import { createMemoryBlobStore } from './blobs.js';
import type { BlobStorageAdapter } from './blobs.js';
import type {
  ConformanceBlobStore,
  ConformanceExpectation,
  ConformanceFailure,
  ConformanceFixture,
  ConformanceInvocation,
  ConformanceRunResult,
  ConformanceScriptedAdapter,
  ConformanceSubscriptionExpectation,
  ConformanceSubscriptionScript,
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

const CONFORMANCE_VERSIONS = ['axiom.conformance.v1', 'axiom.conformance.v2', 'axiom.conformance.v3'];

/**
 * Scripted long-lived sources, keyed by the integration whose adapter maintains them.
 *
 * A fixture scripts per *subscription*, because that is the semantic unit; the runtime
 * resolves an adapter per *integration*, because that is the deployment unit. One adapter
 * therefore carries every script belonging to its integration — which is also what a real
 * multiplexing adapter does.
 */
function buildSubscriptionAdapters(
  fixture: ConformanceFixture,
  host: ReturnType<typeof createDeterministicServerHost>,
): Record<string, SubscriptionAdapter> {
  const scripts = fixture.externalSubscriptions ?? {};
  const byIntegration: Record<string, Record<string, ConformanceSubscriptionScript>> = {};
  for (const subscription of fixture.serverIR.subscriptions ?? []) {
    const integrationId = String(subscription.integrationId);
    byIntegration[integrationId] = {
      ...byIntegration[integrationId],
      [String(subscription.id)]: scripts[String(subscription.id)] ?? { entries: [] },
    };
  }
  return Object.fromEntries(
    Object.entries(byIntegration).map(([integrationId, script]) => [
      integrationId,
      createScriptedSubscriptionAdapter(script, host),
    ]),
  );
}

function buildBlobStores(fixture: ConformanceFixture): Record<string, BlobStorageAdapter> {
  const stores: Record<string, BlobStorageAdapter> = {};
  for (const storage of fixture.serverIR.storages ?? []) {
    const spec: ConformanceBlobStore = fixture.blobStores?.[String(storage.id)] ?? {};
    stores[String(storage.id)] = createMemoryBlobStore({
      ...(spec.objects ? { seed: spec.objects } : {}),
      ...(spec.failOn
        ? {
            failOn: Object.fromEntries(
              Object.entries(spec.failOn).map(([name, failure]) => [name, { ok: false as const, ...failure }]),
            ),
          }
        : {}),
    });
  }
  return stores;
}

function checkSubscription(
  server: AxiomServer,
  subscriptionId: string,
  expected: ConformanceSubscriptionExpectation,
  where: string,
  failures: ConformanceFailure[],
): void {
  const status = server.subscriptionStatus(subscriptionId as never);
  if (!status) {
    failures.push({ where, message: `no subscription ${subscriptionId}` });
    return;
  }
  for (const [key, wanted] of Object.entries(expected)) {
    const actual = (status as unknown as Record<string, unknown>)[key];
    if (actual !== wanted) {
      failures.push({ where, message: `subscription ${subscriptionId}.${key}: expected ${String(wanted)}, got ${String(actual)}` });
    }
  }
}

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
  const subscriptions = buildSubscriptionAdapters(fixture, host);
  const blobStores = buildBlobStores(fixture);
  const server = createAxiomServer({ ir: fixture.serverIR, persistence, host, integrations, subscriptions, blobStores });
  await server.start();

  /** The blob steps, which are answered immediately rather than queued like invocations. */
  async function runBlobStep(step: Extract<ConformanceFixture['steps'], object>[number], where: string): Promise<void> {
    if (step.kind === 'upload-blob') {
      const principal = step.credential ? (fixture.principals[step.credential] ?? null) : null;
      const staged = await server.stageBlob(step.storageId as never, principal, {
        data: new TextEncoder().encode(step.text),
        mediaType: step.mediaType,
        ...(step.filename !== undefined ? { filename: step.filename } : {}),
      });
      if (step.expect?.ok !== undefined && staged.ok !== step.expect.ok) {
        failures.push({ where, message: `expected upload ok=${step.expect.ok}, got ok=${staged.ok}` });
      }
      for (const code of step.expect?.diagnosticCodes ?? []) {
        if (staged.ok || staged.diagnostic.code !== code) {
          failures.push({ where, message: `expected upload diagnostic ${code}` });
        }
      }
      if (step.expectKey !== undefined && staged.ok) {
        const key = staged.ref['field_blob_key'];
        if (key !== step.expectKey) {
          failures.push({ where, message: `expected key ${step.expectKey}, got ${String(key)}` });
        }
      }
      return;
    }
    if (step.kind === 'read-blob') {
      const principal = step.credential ? (fixture.principals[step.credential] ?? null) : null;
      const allowed = await server.authorizeBlobRead(step.storageId as never, step.blobKey, principal);
      if (step.expect?.ok !== undefined && allowed.ok !== step.expect.ok) {
        failures.push({ where, message: `expected read ok=${step.expect.ok}, got ok=${allowed.ok}` });
      }
      for (const code of step.expect?.diagnosticCodes ?? []) {
        if (allowed.ok || allowed.diagnostic.code !== code) {
          failures.push({ where, message: `expected read diagnostic ${code}` });
        }
      }
      return;
    }
    if (step.kind === 'expect-blob') {
      const store = blobStores[step.storageId];
      const found = store ? await store.metadata(step.blobKey) : undefined;
      const present = found?.ok === true;
      if (present !== step.expect.present) {
        failures.push({ where, message: `expected object ${step.blobKey} present=${step.expect.present}, got ${present}` });
      }
      if (step.expect.lifecycle !== undefined && found?.ok && found.value.lifecycle !== step.expect.lifecycle) {
        failures.push({ where, message: `expected ${step.blobKey} to be ${step.expect.lifecycle}, it is ${found.value.lifecycle}` });
      }
    }
  }

  if (fixture.steps) {
    const pending: Array<{ promise: Promise<InvokeResponse | EventResponse>; expect: ConformanceExpectation | undefined; where: string }> = [];
    for (const [index, step] of fixture.steps.entries()) {
      const where = `${fixture.name} step ${index}`;
      if (step.kind === 'advance') {
        await settle();
        host.advance(step.ms);
        continue;
      }
      if (step.kind === 'expect-subscription') {
        // Assertions are point-in-time, so everything queued before them has to have been
        // answered first — otherwise the counters would be read mid-flight.
        await settle();
        for (const { promise, expect, where: earlier } of pending.splice(0)) {
          checkExpectation(await promise, expect, earlier, failures);
        }
        checkSubscription(server, step.subscriptionId, step.expect, where, failures);
        continue;
      }
      if (step.kind === 'upload-blob' || step.kind === 'read-blob' || step.kind === 'expect-blob') {
        await settle();
        for (const { promise, expect, where: earlier } of pending.splice(0)) {
          checkExpectation(await promise, expect, earlier, failures);
        }
        await runBlobStep(step, where);
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
    // The same adapters: a restart is a new process against the same durable state, not a
    // process with a different external world.
    const restarted = createAxiomServer({
      ir: fixture.serverIR,
      persistence,
      host,
      integrations,
      subscriptions: buildSubscriptionAdapters(fixture, host),
      blobStores,
    });
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
