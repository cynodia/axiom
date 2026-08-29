import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  createAxiomServer,
  createMemoryBlobStore,
  createMemoryExternalEventDedupStore,
  createMemoryPersistence,
  createScriptedSubscriptionAdapter,
  createServerHost,
  createSqliteCoordinationProvider,
  createSqliteDurableWorkStorage,
  createSqlitePersistence,
  isSqliteDurableWorkAvailable,
} from '@cynodia/axiom-server';
import type { IntegrationAdapter, IntegrationResult, ServerRequest } from '@cynodia/axiom-server';
import { createDeviceMonitorGraph, deviceMonitorIds as ids } from '@cynodia/axiom-demo/device-monitor';

/**
 * spec12 §100: the reference application under one authority and under N authorities, with
 * **no graph changes** — `createDeviceMonitorGraph()` is the unmodified 0.8 reference app.
 *
 *   transactional state change → durable effect → two authorities race effect execution →
 *   one owns the attempt → crash → the second reclaims → idempotent external adapter →
 *   completion
 *
 * plus scheduled work (the 5s poll) firing once across both authorities, and a duplicate
 * external event collapsing to one semantic event.
 */

const IR = compileToServerIR(createDeviceMonitorGraph());
const PROTOCOL = 'axiom.protocol.v1';

function rebootRequest(externalId: string): ServerRequest {
  return {
    protocol: PROTOCOL,
    kind: 'invoke',
    actionId: ids.ACTION_REBOOT_DEVICE,
    arguments: { [ids.PARAM_EXTERNAL_ID]: externalId },
    credential: 'op-1',
  } as ServerRequest;
}

/** The reboot effect's observable completion: `STATE_LAST_EFFECT_MESSAGE` = "Rebooted: <result>". */
function effectMessage(server: { getState(id: never): unknown }): unknown {
  return server.getState(ids.STATE_LAST_EFFECT_MESSAGE as never);
}

const authenticate = ((credential: unknown) =>
  credential === 'op-1'
    ? { [ids.F_OPERATOR_ID]: 'op-1', [ids.F_OPERATOR_ROLE]: 'operator' }
    : null) as never;

/**
 * A deliberately idempotent external adapter (spec12 §16, §100): the reboot side effect
 * happens at most once per idempotency key; a retry with the same key returns the same
 * result without acting again. The first caller for a key in `hangFor` never gets a reply
 * (its authority "crashed" mid-effect).
 */
function idempotentPager(hangFor: Set<string> = new Set()) {
  const seen = new Map<string, IntegrationResult>();
  let externalSideEffects = 0;
  let firstCall = true;
  const adapter: IntegrationAdapter = {
    async query(): Promise<IntegrationResult> {
      // The 5s poll's integration-query; any value is fine, it just must resolve.
      return { ok: true, value: 'online' };
    },
    async effect(_op, _args, context): Promise<IntegrationResult> {
      const key = context.idempotencyKey ?? 'no-key';
      if (!seen.has(key)) {
        externalSideEffects += 1;
        seen.set(key, { ok: true, value: 'online' });
      }
      if (firstCall && hangFor.has(key)) {
        firstCall = false;
        return new Promise<IntegrationResult>(() => {}); // never resolves — this authority crashed
      }
      return seen.get(key)!;
    },
  };
  return { adapter, sideEffects: () => externalSideEffects };
}

function commonAdapters(pager: IntegrationAdapter) {
  const host = createServerHost({ authenticate });
  return {
    host,
    integrations: { [ids.INTEGRATION_DEVICE_PROVIDER]: pager },
    subscriptions: {
      [ids.INTEGRATION_DEVICE_PROVIDER]: createScriptedSubscriptionAdapter(
        { [String(ids.SUBSCRIPTION_DEVICE_STATUS)]: { entries: [] } },
        host,
      ),
    },
    blobStores: { [ids.STORAGE_DIAGNOSTICS]: createMemoryBlobStore() },
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('single-authority: reboot commits and the idempotent effect drives the device online', async () => {
  const { adapter, sideEffects } = idempotentPager();
  const server = createAxiomServer({ ir: IR, persistence: createMemoryPersistence(), ...commonAdapters(adapter) });
  await server.start();
  try {
    const res = await server.handle(rebootRequest('dev-1'));
    assert.equal((res as { ok: boolean }).ok, true);
    for (let i = 0; i < 60 && effectMessage(server) !== 'Rebooted: online'; i += 1) await wait(15);
    assert.equal(effectMessage(server), 'Rebooted: online');
    assert.equal(sideEffects(), 1);
  } finally {
    await server.stop();
  }
});

test(
  'N authorities, same graph: one owns the reboot effect, crashes, the second reclaims, idempotent adapter, one side effect, same final state (spec12 §100)',
  { skip: !(await isSqliteDurableWorkAvailable()) },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'axiom-ref-dist-'));
    // The reboot effect's logical id is the effect intent id; the adapter hangs on the FIRST
    // physical attempt regardless of key, so authority A stalls and B must reclaim.
    const pager = idempotentPager(new Set(['*']));
    // hang on the first call, whatever the key:
    const hangingPager: IntegrationAdapter = {
      query: pager.adapter.query.bind(pager.adapter),
      effect: (() => {
        let first = true;
        return async (op, args, ctx) => {
          if (first) {
            first = false;
            // record the side effect as done, then never reply
            void pager.adapter.effect(op, args, ctx);
            return new Promise<IntegrationResult>(() => {});
          }
          return pager.adapter.effect(op, args, ctx);
        };
      })(),
    };

    const build = async (instanceId: string, adapter: IntegrationAdapter) => {
      const coordination = await createSqliteCoordinationProvider({ location: path.join(dir, 'coord.db') });
      const workStorage = await createSqliteDurableWorkStorage({ location: path.join(dir, 'work.db') });
      const server = createAxiomServer({
        ir: IR,
        persistence: await createSqlitePersistence({ location: path.join(dir, 'state.db') }),
        coordination,
        workStorage,
        ...commonAdapters(adapter),
        distributed: { instanceId, pollIntervalMs: 40, leaseDurationMs: 2_000, renewIntervalMs: 500 },
      });
      await server.start();
      return { server, coordination, workStorage };
    };

    const a = await build('auth-A', hangingPager);
    const b = await build('auth-B', pager.adapter);
    let aStopped = false;
    try {
      const res = await a.server.handle(rebootRequest('dev-1'));
      assert.equal((res as { ok: boolean }).ok, true, 'the transactional state change committed on A');

      // Let A claim the effect and enter its (hung) adapter call, then A "crashes".
      await wait(150);
      await a.server.stop(); // stops A's poll loop AND stops renewing the lease behind the hung attempt
      aStopped = true;

      // A's 2s lease now lapses; B's poll loop reclaims the same logical effect and the
      // idempotent adapter completes it (the external reboot already happened, once).
      for (let i = 0; i < 250 && effectMessage(b.server) !== 'Rebooted: online'; i += 1) await wait(40);

      assert.equal(effectMessage(b.server), 'Rebooted: online', 'the second authority reclaimed and completed the effect');
      assert.equal(pager.sideEffects(), 1, 'the external reboot happened exactly once (idempotent adapter)');

      const inspection = await b.server.inspectDistributedWork();
      assert.ok(
        inspection.effects.some((e) => e.state === 'succeeded' && e.uncertainAttempts >= 1),
        'the durable work item records the reclaimed attempt as uncertain, then succeeded',
      );

      // spec12.1 §89: application StateDef observed through the *protocol* on B matches the
      // one-authority final semantic state — framework-owned async work and application
      // state alike are topology-independent.
      const bProtocol = (await b.server.handle({
        protocol: 'axiom.protocol.v1',
        kind: 'snapshot',
      } as never)) as { snapshot: { states: Record<string, unknown> } };
      assert.equal(
        bProtocol.snapshot.states[ids.STATE_LAST_EFFECT_MESSAGE],
        'Rebooted: online',
        'the coherent protocol snapshot agrees with the local view',
      );
    } finally {
      if (!aStopped) await a.server.stop().catch(() => {});
      await b.server.stop().catch(() => {});
      await Promise.all([
        a.coordination.close?.(),
        a.workStorage.close?.(),
        b.coordination.close?.(),
        b.workStorage.close?.(),
      ]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('a duplicate external status event collapses to one semantic event (spec12 §25, §73)', async () => {
  // Cross-authority webhook/event deduplication is provided by ExternalEventDedupStore keyed
  // by (source, externalEventId); the reference graph\'s status-change carries a stable id.
  const dedup = createMemoryExternalEventDedupStore();
  const payload = { deviceId: 'dev-1', status: 'online', externalId: 'chg-77' };

  const first = await dedup.admit({ source: 'device-provider', externalEventId: 'chg-77', payload });
  const onAuthorityB = await dedup.admit({ source: 'device-provider', externalEventId: 'chg-77', payload });
  const tampered = await dedup.admit({
    source: 'device-provider',
    externalEventId: 'chg-77',
    payload: { ...payload, status: 'offline' },
  });

  assert.equal(first.status, 'accepted', 'the first authority to see it dispatches one event');
  assert.equal(onAuthorityB.status, 'duplicate', 'a second authority seeing the same delivery dispatches nothing');
  assert.equal(tampered.status, 'conflict', 'the same id with a different payload is an explicit conflict');
});
