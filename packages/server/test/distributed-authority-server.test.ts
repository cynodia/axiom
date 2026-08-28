import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ApplicationGraph,
  nodeId,
  primitiveType,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, IntegrationDef, IntegrationOperationDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createFakeIntegrationAdapter,
  createMemoryCoordinationProvider,
  createMemoryDurableWorkStorage,
  createMemoryPersistence,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
  createSqlitePersistence,
  isSqliteDurableWorkAvailable,
  PROTOCOL_VERSION,
} from '@cynodia/axiom-server';
import type { ServerRequest } from '@cynodia/axiom-server';

/**
 * spec12 §12, §88, §89: `createAxiomServer` wiring.
 *
 * Supplying a coordination provider activates the distributed outbox automatically — no
 * "cluster mode" flag. Two authorities over one shared state + coordination + work store
 * execute a committed effect exactly once.
 */

const INTEGRATION = nodeId('integration_pager');
const OP_PAGE = nodeId('integration_operation_page');
const STATE_COUNT = nodeId('state_page_count');
const ACTION_PAGE = nodeId('action_send_page');

function serverIr() {
  const graph = new ApplicationGraph('pager', 'Pager');
  graph.addNode<StateDef>({
    id: STATE_COUNT,
    kind: 'state',
    name: 'count',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  graph.addNode<IntegrationDef>({ id: INTEGRATION, kind: 'integration', name: 'Pager' });
  graph.addNode<IntegrationOperationDef>({
    id: OP_PAGE,
    kind: 'integration-operation',
    integrationId: INTEGRATION,
    name: 'sendPage',
    mode: 'effect',
    resultType: primitiveType('string'),
  });
  graph.addNode<ActionDef>({
    id: ACTION_PAGE,
    kind: 'action',
    name: 'send page',
    operations: [
      { kind: 'set', target: stateLocation(STATE_COUNT), value: { kind: 'literal', value: 1 } },
      { kind: 'integration-effect', operationId: OP_PAGE },
    ],
  });
  return compileToServerIR(graph);
}



function invokePage(reqId: string): ServerRequest {
  return {
    protocol: PROTOCOL_VERSION,
    kind: 'invoke',
    requestId: reqId,
    actionId: ACTION_PAGE,
    arguments: {},
  } as ServerRequest;
}

test('an unsafe distributed config makes createAxiomServer throw (spec12 §90)', () => {
  assert.throws(
    () =>
      createAxiomServer({
        ir: serverIr(),
        coordination: createMemoryCoordinationProvider(),
        distributed: { leaseDurationMs: 1_000, renewIntervalMs: 5_000 },
      }),
    /Unsafe coordination configuration/,
  );
});

test('authority() reports single-authority by default and distributed when a provider is wired', () => {
  const plain = createAxiomServer({ ir: serverIr(), persistence: createMemoryPersistence() });
  const info = plain.authority();
  assert.equal(info.distributed, false);
  assert.equal(info.coordination, null);
  assert.ok(info.instanceId.length > 0);
  assert.equal(typeof info.compatibilityKey.semanticFingerprint, 'string');

  const clustered = createAxiomServer({
    ir: serverIr(),
    persistence: createMemoryPersistence(),
    coordination: createMemoryCoordinationProvider(),
    workStorage: createMemoryDurableWorkStorage(),
    distributed: { instanceId: 'auth-A' },
  });
  const ci = clustered.authority();
  assert.equal(ci.distributed, true);
  assert.equal(ci.instanceId, 'auth-A');
  assert.equal(ci.coordination?.provider, 'memory');
  assert.ok(ci.coordination?.supports.includes('distributed-lease'));
  assert.deepEqual(ci.compatibilityKey, plain.authority().compatibilityKey, 'same IR → same compatibility key');
});

test(
  'two authorities over shared SQLite execute a committed effect exactly once (spec12 §17, §88)',
  { skip: !(await isSqliteDurableWorkAvailable()) },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-da-server-'));
    let calls = 0;
    const adapter = createFakeIntegrationAdapter({
      effect: async () => {
        calls += 1;
        return { ok: true, value: 'paged' };
      },
    });

    const build = async (instanceId: string) => {
      const persistence = await createSqlitePersistence({ location: path.join(dir, 'state.db') });
      const coordination = await createSqliteCoordinationProvider({ location: path.join(dir, 'coord.db') });
      const workStorage = await createSqliteDurableWorkStorage({ location: path.join(dir, 'work.db') });
      const server = createAxiomServer({
        ir: serverIr(),
        persistence,
        coordination,
        workStorage,
        integrations: { [INTEGRATION]: adapter },
        distributed: { instanceId, pollIntervalMs: 50, leaseDurationMs: 5_000, renewIntervalMs: 1_000 },
      });
      await server.start();
      return { server, persistence, coordination, workStorage };
    };

    const a = await build('auth-A');
    const b = await build('auth-B');
    try {
      const res = await a.server.handle(invokePage('r1'));
      assert.equal(res.kind, 'result');

      // Give both authorities' poll loops a few rounds to race for the one logical effect.
      for (let i = 0; i < 10 && calls === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        await Promise.all([a.server.effectLog(), b.server.effectLog()]);
      }
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(calls, 1, 'the integration effect was performed exactly once across both authorities');

      const terminal = [...a.server.effectLog(), ...b.server.effectLog()].filter(
        (e) => e.status === 'succeeded',
      );
      assert.ok(terminal.length >= 1, 'at least one authority recorded the terminal success');

      // inspectDistributedWork() surfaces the durable work item and its final state (spec12 §55).
      const inspection = await a.server.inspectDistributedWork();
      assert.equal(inspection.authority.distributed, true);
      assert.equal(inspection.incompatibleEffects.length, 0, 'both authorities share one build');
      assert.ok(
        inspection.effects.some((e) => e.state === 'succeeded'),
        'the effect work item is durably succeeded',
      );
    } finally {
      await a.server.stop();
      await b.server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
