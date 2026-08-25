import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SERVER_IR_CONTRACT, SERVER_IR_CONTRACTS } from '@cynodia/axiom-core';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createFakeIntegrationAdapter,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type {
  InvokeResponse,
  IntegrationResult,
  PersistedState,
  PrincipalRecord,
  ServerIR,
} from '@cynodia/axiom-server';

const CONFORMANCE_VERSIONS = ['axiom.conformance.v1', 'axiom.conformance.v2'];

/**
 * The conformance suite.
 *
 * Every fixture is pure data: a Server IR, the state to start from, invocations to perform
 * and the results expected. This runner imports **only** `@cynodia/axiom-server` and the
 * JSON — no graph, no compiler, no builder. That is deliberate: the fixtures plus the
 * Server IR specification are the whole contract, so an independent runtime in another
 * language can be held to exactly the same standard.
 *
 * Regenerate with `npm run conformance:generate`.
 */

interface Invocation {
  actionId: string;
  arguments?: Record<string, unknown>;
  credential?: string;
  requestId?: string;
  expect?: {
    ok?: boolean;
    diagnosticCodes?: string[];
    failureModes?: string[];
    changedStates?: string[];
    replayed?: boolean;
  };
}

/**
 * `axiom.conformance.v2` vocabulary (spec 8.1 §42-49): a scripted, data-only external
 * adapter and a step sequence, for fixtures that exercise integrations, effects and
 * triggers without any executable code in the fixture file.
 */
interface ScriptedResponse {
  result?: IntegrationResult;
  /** Never resolves — models a non-cooperating provider, for a `timeoutMs` fixture. */
  neverSettle?: boolean;
}

interface ScriptedAdapter {
  /** Consumed one per call, in order; the last entry repeats once the list is exhausted. */
  query?: ScriptedResponse[];
  effect?: ScriptedResponse[];
}

type Step =
  | ({ kind: 'invoke' } & Invocation)
  | { kind: 'event'; eventId: string; payload: unknown; credential?: string; expect?: Invocation['expect'] }
  | { kind: 'advance'; ms: number };

interface Fixture {
  conformance: string;
  name: string;
  covers: string[];
  description: string;
  principals: Record<string, PrincipalRecord>;
  serverIR: ServerIR;
  initialState: PersistedState[];
  concurrent?: boolean;
  restartAndReassert?: boolean;
  invocations?: Invocation[];
  externalAdapters?: Record<string, ScriptedAdapter>;
  steps?: Step[];
  expect?: { committedCount?: number };
  expectedState: Record<string, unknown>;
}

/** Resolved from the compiled test, which sits in `dist-test/` beside `conformance/`. */
const directory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance');
const files = (await readdir(directory))
  .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
  .sort();

assert.ok(files.length > 0, 'there are conformance fixtures to run');

/** The manifest is the entry point a non-JavaScript implementation is expected to read. */
interface Manifest {
  conformance: string;
  contract: string;
  protocol: string;
  release: string;
  areas: string[];
  fixtures: { name: string; file: string; covers: string[]; description: string }[];
}
const manifest = JSON.parse(
  await readFile(path.join(directory, 'manifest.json'), 'utf8'),
) as Manifest;

/** Shared by both the `invocations` and the `steps` path. */
function assertExpect(answer: InvokeResponse, expected: Invocation['expect'] | undefined, where: string): void {
  assert.equal(answer.kind, 'result', where);
  if (!expected) {
    return;
  }
  if (expected.ok !== undefined) {
    assert.equal(
      answer.ok,
      expected.ok,
      `${where}: ${JSON.stringify(answer.diagnostics.map((d) => d.code))}`,
    );
  }
  for (const code of expected.diagnosticCodes ?? []) {
    assert.ok(
      answer.diagnostics.some((diagnostic) => diagnostic.code === code),
      `${where} should report ${code}, reported ${JSON.stringify(answer.diagnostics.map((d) => d.code))}`,
    );
  }
  for (const mode of expected.failureModes ?? []) {
    assert.ok(
      answer.diagnostics.some((diagnostic) => diagnostic.details?.failureMode === mode),
      `${where} should report failure mode ${mode}`,
    );
  }
  if (expected.changedStates) {
    // Exhaustive, not a subset: a runtime that reports a state as changed when its value
    // did not move is as wrong as one that omits a state that did.
    assert.deepEqual(
      Object.keys(answer.changes).sort(),
      [...expected.changedStates].sort(),
      `${where}: changes must name exactly the observable states whose value moved`,
    );
  }
  if (expected.replayed !== undefined) {
    assert.equal(answer.replayed ?? false, expected.replayed, `${where} replay`);
  }
}

/**
 * Builds a data-only `IntegrationAdapter` from a fixture's `externalAdapters` entry — no
 * TypeScript callback, just an ordered list of canned responses (spec 8.1 §23,42-49).
 */
function buildScriptedAdapter(spec: ScriptedAdapter) {
  const makeHandler = (responses: ScriptedResponse[] | undefined) => {
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
      return response.result ?? { ok: false, code: 'NOT_IMPLEMENTED', message: 'no result scripted' };
    };
  };
  return createFakeIntegrationAdapter({ query: makeHandler(spec.query), effect: makeHandler(spec.effect) });
}

/** One real macrotask turn — see `settle` in `timeout-and-scheduling.test.ts` for why. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

for (const file of files) {
  const fixture = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as Fixture;

  test(`conformance: ${fixture.name} — ${fixture.description}`, async () => {
    assert.ok(CONFORMANCE_VERSIONS.includes(fixture.conformance), fixture.conformance);

    const persistence = createMemoryPersistence(fixture.initialState);
    const host = createDeterministicServerHost({
      authenticate: (credential) =>
        credential ? fixture.principals[credential] ?? null : null,
    });
    const integrations = Object.fromEntries(
      Object.entries(fixture.externalAdapters ?? {}).map(([id, spec]) => [id, buildScriptedAdapter(spec)]),
    );
    const server = createAxiomServer({ ir: fixture.serverIR, persistence, host, integrations });
    await server.start();

    const assertFinalState = (subject: typeof server, where: string): void => {
      for (const [stateId, expected] of Object.entries(fixture.expectedState)) {
        assert.deepEqual(subject.getState(stateId as never), expected, `${where}: ${stateId}`);
      }
    };

    if (fixture.steps) {
      // Every `invoke`/`event` step is started immediately but checked only once every step
      // has run — an `advance` in between is what lets a `timeoutMs` deadline or a trigger's
      // schedule actually fire before the request it started settles.
      const pending: Array<{ promise: Promise<InvokeResponse>; expect: Invocation['expect']; where: string }> = [];
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
          promise: server.handle(request as never) as Promise<InvokeResponse>,
          expect: step.expect,
          where,
        });
      }
      // Detached, post-commit work (an effect dispatch, its outcome event, a follow-up
      // action) is never awaited by any request's own response — one more turn lets it
      // finish before state is asserted.
      await settle();
      for (const { promise, expect, where } of pending) {
        assertExpect(await promise, expect, where);
      }
      assertFinalState(server, fixture.name);
      await server.stop();
      return;
    }

    const invocations = fixture.invocations ?? [];
    const send = (invocation: Invocation): Promise<InvokeResponse> =>
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
      assertExpect(answer, invocations[index].expect, `${fixture.name} invocation ${index}`);
    });

    if (fixture.expect?.committedCount !== undefined) {
      assert.equal(
        answers.filter((answer) => answer.ok).length,
        fixture.expect.committedCount,
        `${fixture.name}: exactly ${fixture.expect.committedCount} may commit`,
      );
    }

    assertFinalState(server, fixture.name);
    await server.stop();

    if (fixture.restartAndReassert) {
      // The same persistence, a fresh runtime: committed state must be restored exactly,
      // and a rolled-back write must not reappear.
      const restarted = createAxiomServer({ ir: fixture.serverIR, persistence, host });
      await restarted.start();
      assertFinalState(restarted, `${fixture.name} after restart`);
      await restarted.stop();
    }
  });
}

test('the fixtures cover every area the contract requires', async () => {
  const covered = new Set<string>();
  for (const file of files) {
    const fixture = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as Fixture;
    fixture.covers.forEach((area) => covered.add(area));
  }
  for (const area of [
    'expression evaluation',
    'action guards',
    'mutation',
    'rollback',
    'constraints',
    'transition constraints',
    'for-each provisional writes',
    'authorization',
    'persistence',
    'restart',
    'concurrent mutation',
  ]) {
    assert.ok(covered.has(area), `no fixture covers "${area}"`);
  }
});

test('a fixture is self-contained data, with nothing of this implementation in it', async () => {
  for (const file of files) {
    const source = await readFile(path.join(directory, file), 'utf8');
    // `"function": "sum"` is a builtin's name — data. Executable text is what must be absent.
    assert.doesNotMatch(source, /=>|\bfunction\s*\(|\brequire\(|^import /m, `${file} contains code`);
    // It carries its own IR, so a runtime needs no compiler to execute it.
    const fixture = JSON.parse(source) as Fixture;
    assert.ok((SERVER_IR_CONTRACTS as readonly string[]).includes(fixture.serverIR.contract));
    assert.ok(fixture.serverIR.states.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture);
  }
});

test('the manifest describes exactly the fixtures that ship', () => {
  // An implementer who reads only the manifest must see the whole suite: a fixture missing
  // from it is a fixture nobody outside this repository knows to run.
  assert.equal(manifest.conformance, 'axiom.conformance.v1');
  assert.equal(manifest.contract, SERVER_IR_CONTRACT);
  assert.equal(manifest.protocol, PROTOCOL_VERSION);
  assert.deepEqual(
    manifest.fixtures.map((entry) => entry.file).sort(),
    files,
    'every fixture file is listed, and every listed file exists',
  );
});

test('the manifest is reachable through the package export map', async () => {
  // Shipping the files is not the same as making them addressable: an exports map without
  // a conformance subpath hides them from every consumer, which is what 0.6.0 did.
  const manifestPath = JSON.parse(
    await readFile(path.resolve(directory, '../package.json'), 'utf8'),
  ) as { exports: Record<string, unknown>; files: string[] };
  assert.equal(manifestPath.exports['./conformance'], './conformance/manifest.json');
  assert.equal(manifestPath.exports['./conformance/*'], './conformance/*');
  assert.ok(manifestPath.files.includes('conformance/*.json'));
});
