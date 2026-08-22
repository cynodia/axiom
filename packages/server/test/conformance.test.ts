import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SERVER_IR_CONTRACT } from '@cynodia/axiom-core';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { InvokeResponse, PersistedState, PrincipalRecord, ServerIR } from '@cynodia/axiom-server';

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
  invocations: Invocation[];
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

for (const file of files) {
  const fixture = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as Fixture;

  test(`conformance: ${fixture.name} — ${fixture.description}`, async () => {
    assert.equal(fixture.conformance, 'axiom.conformance.v1');

    const persistence = createMemoryPersistence(fixture.initialState);
    const host = createDeterministicServerHost({
      authenticate: (credential) =>
        credential ? fixture.principals[credential] ?? null : null,
    });
    const server = createAxiomServer({ ir: fixture.serverIR, persistence, host });
    await server.start();

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
      ? await Promise.all(fixture.invocations.map(send))
      : await (async () => {
          const collected: InvokeResponse[] = [];
          for (const invocation of fixture.invocations) {
            collected.push(await send(invocation));
          }
          return collected;
        })();

    answers.forEach((answer, index) => {
      const expected = fixture.invocations[index].expect;
      const where = `${fixture.name} invocation ${index}`;
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
    });

    if (fixture.expect?.committedCount !== undefined) {
      assert.equal(
        answers.filter((answer) => answer.ok).length,
        fixture.expect.committedCount,
        `${fixture.name}: exactly ${fixture.expect.committedCount} may commit`,
      );
    }

    const assertFinalState = (subject: typeof server, where: string): void => {
      for (const [stateId, expected] of Object.entries(fixture.expectedState)) {
        assert.deepEqual(subject.getState(stateId as never), expected, `${where}: ${stateId}`);
      }
    };
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
    assert.equal(fixture.serverIR.contract, 'axiom.server.v1');
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
