import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { InvokeResponse, PersistedState, PrincipalRecord, ServerIR } from '@cynodia/axiom-server';

/**
 * What a refusal is allowed to say.
 *
 * A diagnostic is the one thing an authority hands a caller that it did not choose word by
 * word: it is produced by the same engine a client runs, and locally that engine attaches the
 * record a rule was judging, which is exactly what makes a client-side message useful. Across
 * the trust boundary that attachment is the record itself — possibly one the caller may not
 * observe at all.
 */

const directory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance');
const fixture = JSON.parse(
  await readFile(path.join(directory, 'transition-constraint.json'), 'utf8'),
) as {
  serverIR: ServerIR;
  initialState: PersistedState[];
  principals: Record<string, PrincipalRecord>;
  invocations: { actionId: string; credential?: string; arguments: Record<string, unknown> }[];
};

async function authority() {
  const server = createAxiomServer({
    ir: fixture.serverIR,
    persistence: createMemoryPersistence(fixture.initialState),
    host: createDeterministicServerHost({
      authenticate: (credential) => (credential ? fixture.principals[credential] ?? null : null),
    }),
  });
  await server.start();
  return server;
}

test('a refusal names the rule that refused, never the record it was judging', async () => {
  const server = await authority();
  // The fixture's first invocation raises stock, which the "stock only falls" rule refuses.
  const refused = fixture.invocations[0];
  const answer = (await server.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: refused.actionId as never,
    arguments: refused.arguments,
    ...(refused.credential ? { credential: refused.credential } : {}),
  })) as InvokeResponse;

  assert.equal(answer.ok, false);
  const violation = answer.diagnostics.find(
    (diagnostic) => diagnostic.code === 'TRANSITION_CONSTRAINT_VIOLATION',
  );
  assert.ok(
    violation,
    `expected a transition refusal, got ${JSON.stringify(answer.diagnostics.map((d) => d.code))}`,
  );
  assert.ok(violation.message, 'the authored message still crosses — a refusal must say why');
  assert.ok(violation.details?.transitionConstraintId, 'and which rule refused');
  assert.ok(violation.details?.entityId, 'and which entity it governs');
  assert.equal(violation.details?.previousValue, undefined, 'but not the stored record');
  assert.equal(violation.details?.proposedValue, undefined, 'and not the proposed one');
});

test('the detail whitelist is a whitelist: an unlisted key does not cross', async () => {
  // The failure mode this guards against is a detail added to the runtime later and disclosed
  // by default. Anything not named in DISCLOSABLE_DETAIL_KEYS must be absent, whatever it is.
  const server = await authority();
  const refused = fixture.invocations[0];
  const answer = (await server.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: refused.actionId as never,
    arguments: refused.arguments,
    ...(refused.credential ? { credential: refused.credential } : {}),
  })) as InvokeResponse;

  const permitted = new Set([
    'actionId', 'code', 'conflicts', 'constraintId', 'entityId', 'failureMode', 'identity',
    'preconditionIndex', 'principal', 'severity', 'source', 'stateId', 'transitionConstraintId',
  ]);
  for (const diagnostic of answer.diagnostics) {
    for (const key of Object.keys(diagnostic.details ?? {})) {
      assert.ok(permitted.has(key), `${diagnostic.code} disclosed an unlisted detail "${key}"`);
    }
  }
});
