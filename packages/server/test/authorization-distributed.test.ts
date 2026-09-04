import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ApplicationGraph,
  PRINCIPAL,
  binary,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, AuthorizationPolicyDef, EntityDef, EventDef, StateDef, WorkflowDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryWorkflowStore,
  createSqlitePersistence,
  isSqliteAvailable,
} from '@cynodia/axiom-server';
import type { ServerRequest } from '@cynodia/axiom-server';

/**
 * spec15 Phase I — authorization under real durability and concurrency (§75, §76, §77,
 * §116). Same principal + same semantic state ⇒ same authorization result on 1, 2 or 8
 * authorities over one shared SQLite state store (no topology-dependent authorization). A
 * cross-principal race never lets the unauthorized side win on timing, and no raw SQLite
 * error escapes unstructured. Failover: an operation denied on one authority is denied
 * identically after the instance moves to another.
 */

const TRIALS = Math.max(1, Number(process.env.AXIOM_AUTHZ_TRIALS ?? 3));
const sqlite = await isSqliteAvailable();

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const S_COUNT = nodeId('state_count');
const POL_ADMIN = nodeId('policy_admin');
const A_BUMP = nodeId('action_bump'); // admin-gated authoritative state mutation
const A_STEP = nodeId('action_step'); // admin-gated system-only workflow step
const A_LEG = nodeId('action_legacy'); // legacy ActionDef.authorization: role != "banned" (spec15pt3)
const WF_ESCALATE = nodeId('wf_escalate');
const P_TAG = nodeId('input_tag');
const EV = nodeId('event_go');
const E_EV = nodeId('entity_ev');
const F_TAG = fieldId('field_ev_tag');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-dist', 'Authz Distributed');
  g.addNode<EntityDef>({
    id: E_USER,
    kind: 'entity',
    identityFieldId: F_UID,
    fields: [
      { id: F_UID, valueType: primitiveType('string'), required: true },
      { id: F_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });
  g.setPrincipalEntity(E_USER);
  g.addNode<EntityDef>({ id: E_EV, kind: 'entity', fields: [{ id: F_TAG, valueType: primitiveType('string'), required: true }] });
  g.addNode<EventDef>({ id: EV, kind: 'event', payloadType: entityType(E_EV) });
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<AuthorizationPolicyDef>({ id: POL_ADMIN, kind: 'authorization-policy', allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('admin')) });
  const bump = (): ActionDef['operations'] => [
    { kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) },
  ];
  g.addNode<ActionDef>({ id: A_BUMP, kind: 'action', authorizationPolicy: POL_ADMIN, operations: bump() });
  g.addNode<ActionDef>({ id: A_STEP, kind: 'action', authorizationPolicy: POL_ADMIN, invocation: { allowedSources: ['system'] }, operations: bump() });
  g.addNode<ActionDef>({
    id: A_LEG,
    kind: 'action',
    authorization: binary('neq', field(ref(PRINCIPAL), F_ROLE), literal('banned')),
    operations: bump(),
  } as ActionDef);
  g.addNode<WorkflowDef>({
    id: WF_ESCALATE,
    kind: 'workflow',
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('s1'),
    steps: [
      { type: 'action', id: nodeId('s1'), action: A_STEP, arguments: {}, next: nodeId('ok') },
      { type: 'complete', id: nodeId('ok') },
    ],
  });
  return g;
}

const IR = compileToServerIR(graph());
const ADMIN = { [F_UID]: 'u-admin', [F_ROLE]: 'admin' };
const CLERK = { [F_UID]: 'u-clerk', [F_ROLE]: 'clerk' };
const BANNED = { [F_UID]: 'u-ban', [F_ROLE]: 'banned' };

function host() {
  return createDeterministicServerHost({
    authenticate: (c) => (c === 'admin' ? ADMIN : c === 'clerk' ? CLERK : c === 'banned' ? BANNED : null) as never,
  });
}

const bump = (credential: string): ServerRequest =>
  ({ kind: 'invoke', protocol: PROTOCOL_VERSION, actionId: A_BUMP, arguments: {}, credential }) as ServerRequest;

const STRUCTURED_CODES = new Set(['AUTHORIZATION_DENIED', 'CONCURRENCY_CONFLICT', 'AUTHORITY_UNREACHABLE']);

async function withAuthorities<T>(n: number, fn: (servers: Array<Awaited<ReturnType<typeof createAxiomServer>>>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), `axiom-authz-dist-${n}-`));
  try {
    const persistence = await createSqlitePersistence({ location: path.join(dir, 'state.db') });
    const servers: Array<Awaited<ReturnType<typeof createAxiomServer>>> = [];
    for (let i = 0; i < n; i += 1) {
      const s = createAxiomServer({ ir: IR, persistence, host: host() });
      await s.start();
      servers.push(s);
    }
    try {
      return await fn(servers);
    } finally {
      for (const s of servers) await s.stop().catch(() => {});
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('spec15 §75: the same authorized decision holds on 1, 2 and 8 authorities over shared state', { skip: !sqlite }, async () => {
  for (const n of [1, 2, 8]) {
    await withAuthorities(n, async (servers) => {
      // One authorized bump routed through each authority in turn, interleaved with a denied one.
      for (let i = 0; i < n; i += 1) {
        const ok = (await servers[i].handle(bump('admin'))) as { ok?: boolean };
        assert.equal(ok.ok, true, `authority ${i}/${n}: authorized invoke must ALLOW`);
        const no = (await servers[(i + 1) % n].handle(bump('clerk'))) as { ok?: boolean; diagnostics?: Array<{ code?: unknown }> };
        assert.equal(no.ok, false, `authority ${i}/${n}: unauthorized invoke must DENY`);
        assert.ok((no.diagnostics ?? []).some((x) => String(x.code) === 'AUTHORIZATION_DENIED'));
      }
      // Exactly the n authorized commits landed — the denied ones mutated nothing.
      const snap = await servers[0].coherentSnapshot();
      assert.equal(snap.states[S_COUNT as never], n, `only the ${n} authorized bumps committed`);
    });
  }
});

test('spec15pt3 §68/§69/§72: the legacy `role != "banned"` decision is identical on 1, 2 and 8 authorities', { skip: !sqlite }, async () => {
  const legInvoke = (credential?: string): ServerRequest =>
    ({ kind: 'invoke', protocol: PROTOCOL_VERSION, actionId: A_LEG, arguments: {}, ...(credential ? { credential } : {}) }) as ServerRequest;
  for (const n of [1, 2, 8]) {
    await withAuthorities(n, async (servers) => {
      let allowed = 0;
      for (let i = 0; i < n; i += 1) {
        const ok = (await servers[i].handle(legInvoke('admin'))) as { ok?: boolean };
        assert.equal(ok.ok, true, `authority ${i}/${n}: a concrete non-banned role must ALLOW`);
        allowed += 1;
        for (const bad of ['banned', undefined] as const) {
          const no = (await servers[(i + 1) % n].handle(legInvoke(bad))) as { ok?: boolean; diagnostics?: Array<{ code?: unknown }> };
          assert.equal(no.ok, false, `authority ${i}/${n}: ${bad ?? 'anonymous'} must DENY the legacy deny-list action`);
          assert.ok((no.diagnostics ?? []).some((x) => String(x.code) === 'AUTHORIZATION_DENIED'));
        }
      }
      const snap = await servers[0].coherentSnapshot();
      assert.equal(snap.states[S_COUNT as never], allowed, `only the ${allowed} authorized invoke(s) committed — banned / anonymous mutated nothing`);
    });
  }
});

test('spec15 §77/§116: a cross-principal race never lets the unauthorized side win; no raw error escapes', { skip: !sqlite }, async () => {
  let unauthorizedCommits = 0;
  let rawErrors = 0;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    await withAuthorities(2, async ([a, b]) => {
      const rounds = 4;
      for (let r = 0; r < rounds; r += 1) {
        const [authorized, unauthorized] = await Promise.all([
          a.handle(bump('admin')) as Promise<{ ok?: boolean; diagnostics?: Array<{ code?: unknown }> }>,
          b.handle(bump('clerk')) as Promise<{ ok?: boolean; diagnostics?: Array<{ code?: unknown }> }>,
        ]);
        if (unauthorized.ok === true) unauthorizedCommits += 1;
        if (!(unauthorized.diagnostics ?? []).some((x) => String(x.code) === 'AUTHORIZATION_DENIED')) unauthorizedCommits += 1;
        for (const d of [...(authorized.diagnostics ?? []), ...(unauthorized.diagnostics ?? [])]) {
          if (!STRUCTURED_CODES.has(String(d.code))) rawErrors += 1;
        }
      }
      // Every committed bump was the authorized principal's; a lost optimistic race is a
      // structured CONCURRENCY_CONFLICT, never a raw SQLite error or a silent unauthorized write.
      const committed = (await a.coherentSnapshot()).states[S_COUNT as never] as number;
      assert.ok(committed >= 1 && committed <= rounds, `committed count ${committed} within [1, ${rounds}]`);
    });
  }
  assert.equal(unauthorizedCommits, 0, `the unauthorized principal committed / was mis-denied ${unauthorizedCommits} time(s)`);
  assert.equal(rawErrors, 0, `${rawErrors} unstructured (raw SQLite) error(s) escaped`);
});

test('spec15 §76: an operation denied on one authority is denied identically after failover', async () => {
  const shared = createMemoryWorkflowStore();
  const a = createAxiomServer({ ir: IR, host: host(), workflowStore: shared });
  const b = createAxiomServer({ ir: IR, host: host(), workflowStore: shared });
  await Promise.all([a.start(), b.start()]);
  try {
    // A clerk starts a workflow whose only step needs admin. The step is denied under the
    // clerk start principal, so the instance fails — the same outcome whichever authority
    // drives it, and the principal identity survives the failover.
    const started = (await a.startWorkflow({ workflowId: String(WF_ESCALATE), arguments: { [String(P_TAG)]: 'f' }, credential: 'clerk' })) as { instanceId: string };
    const id = started.instanceId;
    await a.stop();

    let status: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      status = (await b.getWorkflow(id))?.status;
      if (status === 'failed' || status === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(status, 'failed', 'the admin-only step must not execute under the clerk start principal on any authority');
    const history = (await b.workflowHistory(id)).map((h) => String(h.kind));
    assert.ok(!history.includes('step-succeeded'), 'no step ever succeeded');
    assert.equal(b.getState(S_COUNT), 0, 'the denied step committed no mutation');
  } finally {
    await b.stop().catch(() => {});
  }
});
