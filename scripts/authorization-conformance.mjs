import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, version } from './packages.mjs';

/**
 * Writes the portable **authorization conformance** fixtures (`axiom.conformance.v9`,
 * spec15 §71-§73). Each file carries a compiled `axiom.server.v9` Server IR, the principal
 * records each credential resolves to, provider seed rows, and a deterministic driver
 * script — every step carrying the decision the fixture author computed independently.
 * Running one needs only `runAuthorizationConformanceFixture` from `@cynodia/axiom-server`
 * and the semantics in `docs/AUTHORIZATION.md`.
 */
const core = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const compiler = await import(path.join(repoRoot, 'packages/compiler/dist/index.js'));
const {
  ApplicationGraph, PRINCIPAL, OPERATION, RESOURCE,
  binary, entityType, field, fieldId, literal, nodeId, primitiveType, ref, stateLocation,
} = core;

const E_USER = nodeId('entity_user');
const F_UID = fieldId('field_user_id');
const F_ROLE = fieldId('field_user_role');
const F_TENANT = fieldId('field_user_tenant');

const E_DOC = nodeId('entity_doc');
const F_DID = fieldId('field_doc_id');
const F_DTENANT = fieldId('field_doc_tenant');
const E_NOTE = nodeId('entity_note');
const F_NID = fieldId('field_note_id');

const S_COUNT = nodeId('state_count');
const ROW = nodeId('scope_row');
const PROW = nodeId('scope_policy_row');

const POL_ADMIN = nodeId('policy_admin');
const POL_ANALYST = nodeId('policy_analyst');
const POL_MANAGER = nodeId('policy_manager');
const POL_OP = nodeId('policy_op');
const POL_DENY = nodeId('policy_deny');
const RP_TENANT = nodeId('readpolicy_tenant');

const A_PUBLIC = nodeId('action_public');
const A_ADMIN = nodeId('action_admin');
const A_OP = nodeId('action_op');
const A_DENY = nodeId('action_deny');
const A_STEP = nodeId('action_step');

const Q_DOCS = nodeId('query_docs');
const Q_NOTES = nodeId('query_notes');

const EV_GO = nodeId('event_go');
const E_EV = nodeId('entity_ev');
const F_EV_TAG = fieldId('field_ev_tag');
const WF_GUARDED = nodeId('wf_guarded');
const WF_OPEN = nodeId('wf_open');
const P_TAG = nodeId('input_tag');

function buildGraph() {
  const g = new ApplicationGraph('authz-conformance', 'Authorization Conformance', version);
  g.addNode({
    id: E_USER, kind: 'entity', identityFieldId: F_UID,
    fields: [
      { id: F_UID, valueType: primitiveType('string'), required: true },
      { id: F_ROLE, valueType: primitiveType('string'), required: true },
      { id: F_TENANT, valueType: primitiveType('string'), required: true },
    ],
  });
  g.setPrincipalEntity(E_USER);
  g.addNode({
    id: E_DOC, kind: 'entity', identityFieldId: F_DID,
    fields: [
      { id: F_DID, valueType: primitiveType('string'), required: true },
      { id: F_DTENANT, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode({
    id: E_NOTE, kind: 'entity', identityFieldId: F_NID,
    fields: [{ id: F_NID, valueType: primitiveType('string'), required: true }],
  });
  g.addNode({ id: E_EV, kind: 'entity', fields: [{ id: F_EV_TAG, valueType: primitiveType('string'), required: true }] });
  g.addNode({ id: EV_GO, kind: 'event', payloadType: entityType(E_EV) });
  g.addNode({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });

  g.addNode({ id: POL_ADMIN, kind: 'authorization-policy', allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('admin')) });
  g.addNode({ id: POL_ANALYST, kind: 'authorization-policy', allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('analyst')) });
  g.addNode({ id: POL_MANAGER, kind: 'authorization-policy', allow: binary('eq', field(ref(PRINCIPAL), F_ROLE), literal('manager')) });
  g.addNode({ id: POL_OP, kind: 'authorization-policy', allow: binary('eq', ref(OPERATION), literal('action.invoke')) });
  g.addNode({ id: POL_DENY, kind: 'authorization-policy', allow: literal(false) });
  g.addNode({
    id: RP_TENANT, kind: 'read-policy', entityId: E_DOC, rowScopeId: PROW,
    predicate: binary('eq', field(ref(PROW), F_DTENANT), field(ref(PRINCIPAL), F_TENANT)),
  });

  const bump = () => [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) }];
  g.addNode({ id: A_PUBLIC, kind: 'action', operations: bump() });
  g.addNode({ id: A_ADMIN, kind: 'action', authorizationPolicy: POL_ADMIN, operations: bump() });
  g.addNode({ id: A_OP, kind: 'action', authorizationPolicy: POL_OP, operations: bump() });
  g.addNode({ id: A_DENY, kind: 'action', authorizationPolicy: POL_DENY, operations: bump() });
  g.addNode({ id: A_STEP, kind: 'action', invocation: { allowedSources: ['system'] }, operations: bump() });

  g.addNode({
    id: Q_DOCS, kind: 'query', source: E_DOC, rowScopeId: ROW,
    authorizationPolicy: POL_ANALYST, readPolicyId: RP_TENANT,
    sort: [{ key: field(ref(ROW), F_DID), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  });
  g.addNode({
    id: Q_NOTES, kind: 'query', source: E_NOTE, rowScopeId: ROW,
    sort: [{ key: field(ref(ROW), F_NID), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  });

  const waitStep = (id, next) => ({
    type: 'wait-event', id, event: EV_GO,
    where: binary('eq', field(ref('EVENT'), F_EV_TAG), ref(P_TAG)), next,
  });
  g.addNode({
    id: WF_GUARDED, kind: 'workflow', startPolicy: POL_ADMIN, instanceAccessPolicy: POL_MANAGER,
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('g_wait'),
    steps: [waitStep(nodeId('g_wait'), nodeId('g_do')), { type: 'action', id: nodeId('g_do'), action: A_STEP, arguments: {}, next: nodeId('g_ok') }, { type: 'complete', id: nodeId('g_ok') }],
  });
  g.addNode({
    id: WF_OPEN, kind: 'workflow',
    inputs: [{ id: P_TAG, valueType: primitiveType('string'), required: true }],
    entry: nodeId('o_wait'),
    steps: [waitStep(nodeId('o_wait'), nodeId('o_do')), { type: 'action', id: nodeId('o_do'), action: A_STEP, arguments: {}, next: nodeId('o_ok') }, { type: 'complete', id: nodeId('o_ok') }],
  });

  const result = compiler.validateGraph ? core.validateGraph(g) : { valid: true, errors: [] };
  if (!result.valid) throw new Error(`authz-conformance graph invalid:\n${JSON.stringify(result.errors, null, 2)}`);
  return g;
}

const serverIR = compiler.compileToServerIR(buildGraph());
if (serverIR.contract !== 'axiom.server.v9') throw new Error(`expected axiom.server.v9, got ${serverIR.contract}`);

const principals = {
  admin: { field_user_id: 'u-admin', field_user_role: 'admin', field_user_tenant: 't1' },
  analyst: { field_user_id: 'u-an1', field_user_role: 'analyst', field_user_tenant: 't1' },
  analyst2: { field_user_id: 'u-an2', field_user_role: 'analyst', field_user_tenant: 't2' },
  manager: { field_user_id: 'u-mgr', field_user_role: 'manager', field_user_tenant: 't1' },
  nobody: { field_user_id: 'u-nob', field_user_role: 'viewer', field_user_tenant: 't1' },
};
const providerRows = {
  [E_DOC]: [
    { field_doc_id: 'a', field_doc_tenant: 't1' },
    { field_doc_id: 'b', field_doc_tenant: 't2' },
    { field_doc_id: 'c', field_doc_tenant: 't1' },
  ],
  [E_NOTE]: [{ field_note_id: 'n1' }, { field_note_id: 'n2' }],
};
const T = String(P_TAG);

const fixtures = [
  {
    name: 'action-allow-deny-anonymous', covers: ['allow', 'deny', 'anonymous', 'role/claim condition', 'action invocation'],
    description: 'A role policy on action.invoke: the authorized role is allowed, another role and an anonymous caller are denied AUTHORIZATION_DENIED with no mutation.',
    providerRows, principals,
    steps: [
      { do: 'invoke', action: String(A_ADMIN), credential: 'admin', expect: { decision: 'ALLOW' } },
      { do: 'invoke', action: String(A_ADMIN), credential: 'nobody', expect: { decision: 'DENY', reason: 'policy-denied' } },
      { do: 'invoke', action: String(A_ADMIN), expect: { decision: 'DENY', reason: 'policy-denied' } },
    ],
    expectFinalState: { [String(S_COUNT)]: 1 },
  },
  {
    name: 'operation-scope', covers: ['allow', 'action invocation'],
    description: 'A policy over the OPERATION scope: ref(OPERATION) == "action.invoke" allows any caller.',
    providerRows, principals,
    steps: [{ do: 'invoke', action: String(A_OP), credential: 'nobody', expect: { decision: 'ALLOW' } }],
    expectFinalState: { [String(S_COUNT)]: 1 },
  },
  {
    name: 'constant-deny-policy', covers: ['deny', 'mixed-build policy change'],
    description: 'A policy whose allow is literal(false) always denies — the fail-closed behaviour a mixed-build incompatible authority also exhibits (full semantic-fingerprint divergence is authorization-identity.test.ts; real-process is Phase I).',
    providerRows, principals,
    steps: [
      { do: 'invoke', action: String(A_DENY), credential: 'admin', expect: { decision: 'DENY', reason: 'policy-denied' } },
    ],
    expectFinalState: { [String(S_COUNT)]: 0 },
  },
  {
    name: 'query-tenant-isolation', covers: ['query filtering', 'tenant isolation', 'resource-owner condition', 'role/claim condition', 'deny'],
    description: 'query.read is gated by a role policy; a ReadPolicyDef then filters rows to the caller tenant. The authorized row set is computed independently.',
    providerRows, principals,
    steps: [
      { do: 'query', query: String(Q_DOCS), credential: 'analyst', expect: { decision: 'ALLOW', rowIds: ['a', 'c'] } },
      { do: 'query', query: String(Q_DOCS), credential: 'analyst2', expect: { decision: 'ALLOW', rowIds: ['b'] } },
      { do: 'query', query: String(Q_DOCS), credential: 'nobody', expect: { decision: 'DENY' } },
      { do: 'query', query: String(Q_DOCS), expect: { decision: 'DENY' } },
    ],
  },
  {
    name: 'query-public-preserved', covers: ['allow', 'query filtering'],
    description: 'A QueryDef with no authorizationPolicy and no ReadPolicyDef keeps its pre-0.15 public contract.',
    providerRows, principals,
    steps: [{ do: 'query', query: String(Q_NOTES), expect: { decision: 'ALLOW', rowIds: ['n1', 'n2'] } }],
  },
  {
    name: 'workflow-start', covers: ['workflow continuation', 'allow', 'deny', 'role/claim condition'],
    description: 'WorkflowDef.startPolicy gates workflow.start; a denied start creates no instance.',
    providerRows, principals,
    steps: [
      { do: 'start-workflow', workflow: String(WF_GUARDED), as: 'w1', credential: 'admin', arguments: { [T]: 'x' }, expect: { decision: 'ALLOW' } },
      { do: 'start-workflow', workflow: String(WF_GUARDED), as: 'w2', credential: 'nobody', arguments: { [T]: 'y' }, expect: { decision: 'DENY' } },
    ],
  },
  {
    name: 'workflow-cancellation-owner', covers: ['workflow cancellation', 'owner', 'cross-principal', 'deny'],
    description: 'With no instanceAccessPolicy, cancel keeps the owner-fingerprint baseline: the starter may cancel, a different principal may not.',
    providerRows, principals,
    steps: [
      { do: 'start-workflow', workflow: String(WF_OPEN), as: 'o', credential: 'admin', arguments: { [T]: 'z' }, expect: { decision: 'ALLOW' } },
      { do: 'cancel-workflow', instance: 'o', credential: 'analyst', expect: { decision: 'DENY' } },
      { do: 'cancel-workflow', instance: 'o', credential: 'admin', expect: { decision: 'ALLOW' } },
    ],
  },
  {
    name: 'workflow-cancellation-policy', covers: ['workflow cancellation', 'cross-principal', 'role/claim condition'],
    description: 'A declared instanceAccessPolicy decides workflow.cancel — a manager may, the (non-manager) starter may not, no implicit owner bypass.',
    providerRows, principals,
    steps: [
      { do: 'start-workflow', workflow: String(WF_GUARDED), as: 'g', credential: 'admin', arguments: { [T]: 'k' }, expect: { decision: 'ALLOW' } },
      { do: 'cancel-workflow', instance: 'g', credential: 'admin', expect: { decision: 'DENY' } },
      { do: 'cancel-workflow', instance: 'g', credential: 'nobody', expect: { decision: 'DENY' } },
      { do: 'cancel-workflow', instance: 'g', credential: 'manager', expect: { decision: 'ALLOW' } },
    ],
  },
  {
    name: 'workflow-inspection', covers: ['workflow inspection', 'cross-principal', 'anonymous'],
    description: 'A declared instanceAccessPolicy gates getWorkflow; an unauthorized caller is answered exactly like a missing instance (no existence leak).',
    providerRows, principals,
    steps: [
      { do: 'start-workflow', workflow: String(WF_GUARDED), as: 'g', credential: 'admin', arguments: { [T]: 'k' }, expect: { decision: 'ALLOW' } },
      { do: 'inspect-workflow', instance: 'g', credential: 'manager', expect: { visible: true } },
      { do: 'inspect-workflow', instance: 'g', credential: 'admin', expect: { visible: false } },
      { do: 'inspect-workflow', instance: 'g', expect: { visible: false } },
    ],
  },
  {
    name: 'live-query-resume', covers: ['live-query resume', 'allow', 'deny', 'query filtering'],
    description: 'A live query enforces query.read at open; resume re-authorizes — the same principal resumes, an unauthorized principal is refused AUTHORIZATION_DENIED (a cursor is not a bearer token).',
    providerRows, principals,
    steps: [
      { do: 'open-live-query', query: String(Q_DOCS), as: 'lq', credential: 'analyst', expect: { decision: 'ALLOW', rowIds: ['a', 'c'] } },
      { do: 'open-live-query', query: String(Q_DOCS), as: 'lq-denied', credential: 'nobody', expect: { decision: 'DENY' } },
      { do: 'resume-live-query', from: 'lq', query: String(Q_DOCS), credential: 'analyst', expect: { decision: 'ALLOW' } },
      { do: 'resume-live-query', from: 'lq', query: String(Q_DOCS), credential: 'nobody', expect: { decision: 'DENY' } },
    ],
  },
];

const dir = path.join(repoRoot, 'packages/server/conformance/authorization');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const manifest = {
  conformance: 'axiom.conformance.v9',
  baseContract: 'axiom.server.v9',
  protocol: 'axiom.protocol.v1',
  release: version,
  description:
    'Portable authorization conformance fixtures (spec15 §71-§73). Each file carries a compiled axiom.server.v9 Server IR, the principal records each credential resolves to, provider seed rows, and a deterministic driver script — every step carrying the decision the fixture author computed independently (ALLOW/DENY, and for a query the exact authorized row set). Running one needs only runAuthorizationConformanceFixture from @cynodia/axiom-server and the semantics in docs/AUTHORIZATION.md. Full mixed-build semantic-fingerprint divergence and real-process crash boundaries are the spec15 Phase I suite.',
  fixtures: [],
};

for (const fixture of fixtures) {
  const document = { conformance: 'axiom.conformance.v9', ...fixture, serverIR };
  await writeFile(path.join(dir, `${fixture.name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  manifest.fixtures.push({ name: fixture.name, covers: fixture.covers });
}
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${fixtures.length} authorization conformance fixtures to ${path.relative(repoRoot, dir)}`);
