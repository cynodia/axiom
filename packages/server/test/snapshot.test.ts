import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  PROTOCOL_VERSION,
  SERVER_DIAGNOSTIC_CODES,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { PersistedState, ServerIR, SnapshotRequest, SnapshotResponse } from '@cynodia/axiom-server';

/**
 * Incremental snapshots.
 *
 * `sinceRevision` is the one place the protocol lets an authority answer with less than the
 * whole truth, so what it may leave out is a contract in its own right: omission means
 * unchanged, and the authority omits only what it can prove.
 */

const directory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance');
const fixture = JSON.parse(
  await readFile(path.join(directory, 'mutation-commits.json'), 'utf8'),
) as {
  serverIR: ServerIR;
  initialState: PersistedState[];
  principals: Record<string, Record<string, unknown>>;
  invocations: { actionId: string; arguments: Record<string, unknown> }[];
};

const S_PARTS = 'state_parts';
const S_LEDGER = 'state_ledger';
const S_TOTAL = 'state_total';

async function authority() {
  const server = createAxiomServer({
    ir: fixture.serverIR,
    persistence: createMemoryPersistence(fixture.initialState),
    host: createDeterministicServerHost({
      authenticate: (credential) =>
        credential ? (fixture.principals[credential] as never) ?? null : null,
    }),
  });
  await server.start();
  return server;
}

const ask = (sinceRevision?: number): SnapshotRequest => ({
  kind: 'snapshot',
  protocol: PROTOCOL_VERSION,
  ...(sinceRevision === undefined ? {} : { sinceRevision }),
});

test('a snapshot with no sinceRevision is complete', async () => {
  const server = await authority();
  const answer = (await server.handle(ask())) as SnapshotResponse;

  assert.equal(answer.snapshot.partial, undefined);
  assert.deepEqual(
    Object.keys(answer.snapshot.states).sort(),
    [...fixture.serverIR.observableStateIds].sort(),
  );
});

test('sinceRevision omits what provably did not change, and marks the answer partial', async () => {
  const server = await authority();
  const held = server.revision();
  await server.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId: fixture.invocations[0].actionId as never,
    arguments: fixture.invocations[0].arguments,
  });

  const answer = (await server.handle(ask(held))) as SnapshotResponse;
  assert.equal(answer.snapshot.partial, true);
  assert.equal(answer.snapshot.revision, server.revision(), 'usable as the next sinceRevision');
  assert.ok(S_PARTS in answer.snapshot.states, 'a state the action wrote');
  assert.ok(S_LEDGER in answer.snapshot.states, 'the other state the action wrote');
  assert.ok(
    S_TOTAL in answer.snapshot.states,
    'a derived state is always named: the authority will not reason about what it follows',
  );

  // Nothing has happened since, so nothing stored may be reported as changed.
  const quiet = (await server.handle(ask(answer.snapshot.revision))) as SnapshotResponse;
  assert.equal(quiet.snapshot.partial, true);
  assert.deepEqual(
    Object.keys(quiet.snapshot.states),
    [S_TOTAL],
    'stored states that did not move are omitted; the derived one is still offered',
  );
});

test('a revision the authority never issued is answered completely, not partially', async () => {
  // The caller is ahead of this authority — restored from elsewhere, or talking to a replica
  // that fell behind. "Nothing changed" would be a lie. The whole truth is not.
  const server = await authority();
  const answer = (await server.handle(ask(server.revision() + 1000))) as SnapshotResponse;

  assert.equal(answer.snapshot.partial, undefined);
  assert.ok(S_PARTS in answer.snapshot.states);
});

test('a sinceRevision that is not a revision is a malformed request', async () => {
  const server = await authority();
  for (const since of [-1, 1.5, Number.NaN, 'two' as unknown as number]) {
    const answer = await server.handle(ask(since));
    assert.equal(answer.kind, 'error', `${String(since)} is refused`);
    assert.equal(
      (answer as { diagnostics: { code: string }[] }).diagnostics[0].code,
      SERVER_DIAGNOSTIC_CODES.MALFORMED_REQUEST,
    );
  }
});
