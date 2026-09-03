import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  OPERATION,
  PRINCIPAL,
  binary,
  every,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  AuthorizationPolicyDef,
  EntityDef,
  StateDef,
  WorkflowDef,
} from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  PROTOCOL_VERSION,
  createAxiomServer,
  createDeterministicServerHost,
  createMemoryPersistence,
} from '@cynodia/axiom-server';
import type { InvokeResponse, PrincipalRecord } from '@cynodia/axiom-server';

/**
 * spec15 Phase C — `ActionDef.authorizationPolicy` is enforced by the one `authorize()`
 * evaluator on every path through `invokeCore`: direct call, workflow action step,
 * system-sourced invocation, retry, failover. ALLOW only when the policy is exactly `true`
 * (conjoined with any legacy `authorization` expression); an evaluation error is DENY.
 */

const E_USER = nodeId('entity_user');
const F_ID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const S_COUNT = nodeId('state_count');

const A_OPEN = nodeId('action_open'); // no authorization at all
const A_EDIT = nodeId('action_edit'); // policy: role == 'editor'
const A_OP = nodeId('action_op'); // policy: OPERATION == 'action.invoke'
const A_BOTH = nodeId('action_both'); // legacy(role==editor) ∧ policy(role==admin)
const A_BAD = nodeId('action_bad'); // policy throws at eval
const A_PRIV = nodeId('action_priv'); // policy: role == 'admin', system-only

const POL_EDITOR = nodeId('policy_editor');
const POL_OP = nodeId('policy_op');
const POL_ADMIN = nodeId('policy_admin');
const POL_BAD = nodeId('policy_bad');

const WF_ESCALATE = nodeId('wf_escalate');

function bump(): ActionDef['operations'] {
  return [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) }];
}

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('authz-c', 'Authz Enforcement');
  g.addNode<EntityDef>({
    id: E_USER,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });
  g.setPrincipalEntity(E_USER);
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });

  g.addNode<AuthorizationPolicyDef>({
    id: POL_EDITOR,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('editor')),
  });
  g.addNode<AuthorizationPolicyDef>({
    id: POL_OP,
    kind: 'authorization-policy',
    allow: binary('eq', ref(OPERATION), literal('action.invoke')),
  });
  g.addNode<AuthorizationPolicyDef>({
    id: POL_ADMIN,
    kind: 'authorization-policy',
    allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('admin')),
  });
  g.addNode<AuthorizationPolicyDef>({
    id: POL_BAD,
    kind: 'authorization-policy',
    // RESOURCE is a record, not a collection — `every` is strict and throws at eval, which
    // must be treated as DENY (spec15 §123), never ALLOW.
    allow: every(ref(OPERATION), nodeId('row'), literal(true)),
  });

  g.addNode<ActionDef>({ id: A_OPEN, kind: 'action', operations: bump() });
  g.addNode<ActionDef>({ id: A_EDIT, kind: 'action', authorizationPolicy: POL_EDITOR, operations: bump() });
  g.addNode<ActionDef>({ id: A_OP, kind: 'action', authorizationPolicy: POL_OP, operations: bump() });
  g.addNode<ActionDef>({
    id: A_BOTH,
    kind: 'action',
    authorization: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('editor')),
    authorizationPolicy: POL_ADMIN,
    operations: bump(),
  });
  g.addNode<ActionDef>({ id: A_BAD, kind: 'action', authorizationPolicy: POL_BAD, operations: bump() });
  g.addNode<ActionDef>({
    id: A_PRIV,
    kind: 'action',
    authorizationPolicy: POL_ADMIN,
    invocation: { allowedSources: ['system'] },
    operations: bump(),
  });

  g.addNode<WorkflowDef>({
    id: WF_ESCALATE,
    kind: 'workflow',
    entry: nodeId('run'),
    steps: [
      {
        type: 'action',
        id: nodeId('run'),
        action: A_PRIV,
        arguments: {},
        retry: { maxAttempts: 3, initialDelaySeconds: 0, backoffMultiplier: 1, maxDelaySeconds: 0 },
        next: nodeId('ok'),
      },
      { type: 'complete', id: nodeId('ok') },
    ],
  });
  return g;
}

const IR = compileToServerIR(graph());

const EDITOR: PrincipalRecord = { [F_ID]: 'u-editor', [F_ROLE]: 'editor' };
const VIEWER: PrincipalRecord = { [F_ID]: 'u-viewer', [F_ROLE]: 'viewer' };
const ADMIN: PrincipalRecord = { [F_ID]: 'u-admin', [F_ROLE]: 'admin' };

async function server() {
  const s = createAxiomServer({
    ir: IR,
    persistence: createMemoryPersistence(),
    host: createDeterministicServerHost({
      authenticate: (credential) =>
        credential === 'editor' ? EDITOR : credential === 'viewer' ? VIEWER : credential === 'admin' ? ADMIN : null,
    }),
  });
  await s.start();
  return s;
}

async function invoke(
  s: Awaited<ReturnType<typeof server>>,
  actionId: ReturnType<typeof nodeId>,
  credential?: string,
): Promise<InvokeResponse> {
  const response = await s.handle({
    kind: 'invoke',
    protocol: PROTOCOL_VERSION,
    actionId,
    arguments: {},
    ...(credential ? { credential } : {}),
  });
  assert.equal(response.kind, 'result');
  return response as InvokeResponse;
}

const denied = (r: InvokeResponse) =>
  r.ok === false && (r.diagnostics ?? []).some((d) => String(d.code) === 'AUTHORIZATION_DENIED');

async function waitFor<T>(fn: () => Promise<T | undefined>, ok: (v: T) => boolean, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined && ok(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

test('spec15 §70: an action-policy graph labels itself axiom.server.v9 and admits', () => {
  assert.equal(IR.contract, 'axiom.server.v9');
});

test('spec15 §9: an action with no authorization runs for an anonymous caller', async () => {
  const s = await server();
  const r = await invoke(s, A_OPEN);
  assert.equal(r.ok, true);
  await s.stop();
});

test('spec15 §73.A: a role policy allows the authorized principal and denies the rest', async () => {
  const s = await server();
  assert.equal((await invoke(s, A_EDIT, 'editor')).ok, true);
  assert.equal(denied(await invoke(s, A_EDIT, 'viewer')), true);
  assert.equal(denied(await invoke(s, A_EDIT)), true, 'anonymous is denied, not defaulted through');
  await s.stop();
});

test('spec15 §98: the OPERATION scope resolves to the canonical operation string', async () => {
  const s = await server();
  assert.equal((await invoke(s, A_OP, 'viewer')).ok, true, 'OPERATION == action.invoke');
  await s.stop();
});

test('spec15 §8: policy and legacy authorization are conjoined', async () => {
  const s = await server();
  // editor passes the legacy expr but fails POL_ADMIN; admin fails the legacy expr.
  const asEditor = await invoke(s, A_BOTH, 'editor');
  assert.equal(denied(asEditor), true);
  assert.equal(
    (asEditor.diagnostics ?? []).find((d) => String(d.code) === 'AUTHORIZATION_DENIED')?.details?.reason,
    'policy-denied',
  );
  assert.equal(denied(await invoke(s, A_BOTH, 'admin')), true);
  await s.stop();
});

test('spec15 §123: a policy that throws at evaluation is DENY, never ALLOW', async () => {
  const s = await server();
  const r = await invoke(s, A_BAD, 'admin');
  assert.equal(denied(r), true);
  assert.equal(
    (r.diagnostics ?? []).find((d) => String(d.code) === 'AUTHORIZATION_DENIED')?.details?.reason,
    'policy-error',
  );
  assert.equal(s.getState(S_COUNT), 0, 'nothing mutated');
  await s.stop();
});

test('spec15 §101: a workflow grants no authority — a step is denied under the start principal', async () => {
  const s = await server();
  // The editor may start the workflow (start policy is Phase E, still open) but MUST NOT
  // thereby invoke the admin-only action it contains.
  const started = await s.startWorkflow({ workflowId: String(WF_ESCALATE), arguments: {}, credential: 'editor' });
  const id = (started as { instanceId: string }).instanceId;
  const failed = await waitFor(() => s.getWorkflow(id), (w) => w.status === 'failed');
  assert.equal(s.getState(S_COUNT), 0, 'the privileged action never ran');
  // spec15 §109 — an authorization denial is terminal, not a retryable infrastructure
  // failure: the attempt counter did not climb through the retry policy.
  assert.ok((failed.attempt ?? 0) <= 1, `attempt did not grow (was ${failed.attempt})`);
  const history = await s.workflowHistory(id);
  assert.ok(
    !history.some((h) => (h as { kind?: string }).kind === 'retry-scheduled'),
    'a denied step is not retried',
  );
  await s.stop();
});

test('spec15 §10: the same workflow step succeeds for an authorized principal', async () => {
  const s = await server();
  const started = await s.startWorkflow({ workflowId: String(WF_ESCALATE), arguments: {}, credential: 'admin' });
  const id = (started as { instanceId: string }).instanceId;
  await waitFor(() => s.getWorkflow(id), (w) => w.status === 'completed');
  assert.equal(s.getState(S_COUNT), 1);
  await s.stop();
});
