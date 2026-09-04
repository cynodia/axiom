import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  EXECUTABLE_KINDS,
  PRINCIPAL,
  binary,
  compareAuthorityCompatibility,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  usesUnenforcedAuthorizationVocabulary,
} from '@cynodia/axiom-core';
import type { ActionDef, AuthorizationPolicyDef, EntityDef, QueryDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import {
  SERVER_IR_EXECUTABLE_SLICES,
  createAxiomServer,
  createMemoryPersistence,
  serverIrCompatibilityKey,
  serverIrSemanticFingerprint,
  serverIrSemanticProjection,
} from '@cynodia/axiom-server';
import type { ServerIR } from '@cynodia/axiom-server';

/**
 * spec15 Phase B — authorization policy vocabulary enters the *single* semantic projection
 * (`EXECUTABLE_KINDS`), so `semanticFingerprint` and the authority-compatibility key pick it
 * up automatically, and a graph with none is byte-identical to its prior contract.
 * Phase C — an `ActionDef.authorizationPolicy` graph now admits and enforces; a still-unenforced
 * `QueryDef` / `WorkflowDef` policy fails closed at admission (see authorization-enforcement.test.ts
 * for the runtime decision).
 */

const S_COUNT = nodeId('state_count');
const E_PRIN = nodeId('entity_principal');
const F_P_ROLE = fieldId('field_principal_role');
const A_DO = nodeId('action_do');
const POL = nodeId('policy_role');

function ir(opts: { policy?: boolean; deny?: boolean; description?: string } = {}): ServerIR {
  const g = new ApplicationGraph('ai', 'Authz Identity');
  g.addNode<EntityDef>({ id: E_PRIN, kind: 'entity', fields: [{ id: F_P_ROLE, valueType: primitiveType('string'), required: true }] });
  g.setPrincipalEntity(E_PRIN);
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<ActionDef>({
    id: A_DO,
    kind: 'action',
    invocation: { allowedSources: ['system'] },
    ...(opts.policy ? { authorizationPolicy: POL } : {}),
    operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) }],
  });
  if (opts.policy) {
    g.addNode<AuthorizationPolicyDef>({
      id: POL,
      kind: 'authorization-policy',
      ...(opts.description ? { description: opts.description } : {}),
      allow: opts.deny
        ? literal(false)
        : binary('eq', field(ref(PRINCIPAL), F_P_ROLE), literal('editor')),
    });
  }
  return compileToServerIR(g);
}

test('spec15 §189/§97: every core EXECUTABLE_KIND (incl. authorization-policy) has a ServerIR slice', () => {
  for (const kind of EXECUTABLE_KINDS) {
    assert.ok(kind in SERVER_IR_EXECUTABLE_SLICES, `${kind} projected → cannot escape authority compatibility`);
  }
  assert.equal((SERVER_IR_EXECUTABLE_SLICES as Record<string, { field: string }>)['authorization-policy'].field, 'authorizationPolicies');
});

test('spec15 §70: a graph using authorization vocabulary compiles to axiom.server.v9', () => {
  assert.equal(ir({ policy: true }).contract, 'axiom.server.v9');
  assert.notEqual(ir({}).contract, 'axiom.server.v9');
});

test('spec15 §39/§132: a non-authorization graph fingerprint is unchanged (no workflows/authz slice)', () => {
  const projection = serverIrSemanticProjection(ir({}));
  assert.ok(!('authorizationPolicies' in projection), 'no authorizationPolicies key when empty');
  assert.ok(!('workflows' in projection));
  assert.equal(serverIrSemanticFingerprint(ir({})), serverIrSemanticFingerprint(ir({})), 'deterministic');
});

test('spec15 §45/§46: a policy ALLOW→DENY change flips the authority compatibility key', () => {
  const allow = serverIrCompatibilityKey(ir({ policy: true }));
  const deny = serverIrCompatibilityKey(ir({ policy: true, deny: true }));
  const cmp = compareAuthorityCompatibility(allow, deny);
  assert.equal(cmp.compatible, false, 'authorization semantic change ⇒ incompatible');
  assert.ok(cmp.mismatches.includes('semanticFingerprint'));
});

test('spec15 §45: a policy presentation-only change stays compatible', () => {
  assert.equal(
    compareAuthorityCompatibility(
      serverIrCompatibilityKey(ir({ policy: true })),
      serverIrCompatibilityKey(ir({ policy: true, description: 'a helpful description' })),
    ).compatible,
    true,
  );
});

test('spec15 Phases C–E: action, query and workflow policies all admit and are enforced', async () => {
  // Every `AuthorizationPolicyDef` reference the graph vocabulary defines is enforced (see
  // authorization-{enforcement,query,workflow-access}.test.ts for the decisions).
  const started = createAxiomServer({ ir: ir({ policy: true }), persistence: createMemoryPersistence() });
  await started.start();
  await started.stop();

  const withQueryPolicy = {
    ...ir({ policy: true }),
    queries: [{ id: nodeId('q'), kind: 'query', authorizationPolicy: POL } as unknown as QueryDef],
  } as ServerIR;
  const withQuery = createAxiomServer({ ir: withQueryPolicy, persistence: createMemoryPersistence() });
  await withQuery.start();
  await withQuery.stop();

  // `usesUnenforcedAuthorizationVocabulary` is now `false` for every valid IR — the
  // admission gate is the dormant extension point, not a live refusal.
  assert.equal(usesUnenforcedAuthorizationVocabulary(withQueryPolicy), false);
});

test('spec15 §69: the authorization policy round-trips through Server IR serialization', () => {
  const original = ir({ policy: true });
  const roundTripped = JSON.parse(JSON.stringify(original)) as ServerIR;
  assert.equal(serverIrSemanticFingerprint(roundTripped), serverIrSemanticFingerprint(original));
  assert.deepEqual(roundTripped.authorizationPolicies, original.authorizationPolicies);
});

test('spec15pt2 §35/§76-§78: the authorization-evaluator version discriminates alpha.1 from alpha.2', () => {
  // alpha.2 stamps `authorizationRuntime` on an authorization-bearing IR; a graph with no
  // policy does not carry it, so a non-authz cluster rolls the upgrade unaffected (§35).
  const authz = serverIrCompatibilityKey(ir({ policy: true }));
  const plain = serverIrCompatibilityKey(ir({}));
  assert.equal(typeof (authz as { authorizationRuntime?: string }).authorizationRuntime, 'string');
  assert.equal((plain as { authorizationRuntime?: string }).authorizationRuntime, undefined);

  // A stored alpha.1 key (same graph, no discriminator) is fail-closed incompatible with
  // this alpha.2 authority — the two evaluate the same policy differently (§76).
  const alpha1Stored = {
    schemaVersion: authz.schemaVersion,
    schemaFingerprint: authz.schemaFingerprint,
    serverContract: authz.serverContract,
    semanticFingerprint: authz.semanticFingerprint,
  } as typeof authz;
  const cmp = compareAuthorityCompatibility(authz, alpha1Stored);
  assert.equal(cmp.compatible, false);
  assert.ok(cmp.mismatches.includes('authorizationRuntime'));

  // Two alpha.2 authorities on the same graph stay compatible (§77); a presentation-only
  // difference stays compatible (§78).
  assert.equal(compareAuthorityCompatibility(authz, serverIrCompatibilityKey(ir({ policy: true }))).compatible, true);
  assert.equal(
    compareAuthorityCompatibility(authz, serverIrCompatibilityKey(ir({ policy: true, description: 'x' }))).compatible,
    true,
  );
  // A non-authz graph is compatible across the (missing) discriminator on both sides.
  assert.equal(compareAuthorityCompatibility(plain, serverIrCompatibilityKey(ir({}))).compatible, true);
});

// ---------------------------------- spec15pt3 §37-§42 — legacy evaluator version discriminator

const F_ROLE = fieldId('field_principal_role2');

/** A graph carrying a legacy `ActionDef.authorization` expression (and optionally a policy). */
function legacyIr(opts: { policy?: boolean } = {}): ServerIR {
  const g = new ApplicationGraph('ali', 'Authz Legacy Identity');
  g.addNode<EntityDef>({ id: E_PRIN, kind: 'entity', fields: [{ id: F_ROLE, valueType: primitiveType('string'), required: false }] });
  g.setPrincipalEntity(E_PRIN);
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<ActionDef>({
    id: A_DO,
    kind: 'action',
    invocation: { allowedSources: ['system'] },
    authorization: binary('neq', field(ref(PRINCIPAL), F_ROLE), literal('banned')),
    ...(opts.policy ? { authorizationPolicy: POL } : {}),
    operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) }],
  } as ActionDef);
  if (opts.policy) {
    g.addNode<AuthorizationPolicyDef>({ id: POL, kind: 'authorization-policy', allow: literal(true) });
  }
  return compileToServerIR(g);
}

/** An alpha.2-shaped key: the same graph identity, but no `authorizationRuntime` at all. */
const dropRuntime = (k: ReturnType<typeof serverIrCompatibilityKey>) => ({
  schemaVersion: k.schemaVersion,
  schemaFingerprint: k.schemaFingerprint,
  serverContract: k.serverContract,
  semanticFingerprint: k.semanticFingerprint,
});
/** An alpha.2-shaped key that still stamps the *old* `axiom.authz.v2` discriminator (a policy graph on alpha.2). */
const withV2 = (k: ReturnType<typeof serverIrCompatibilityKey>) => ({ ...dropRuntime(k), authorizationRuntime: 'axiom.authz.v2' });

test('spec15pt3 §39: a legacy-`ActionDef.authorization` graph carries the evaluator discriminator', () => {
  const key = serverIrCompatibilityKey(legacyIr());
  assert.equal((key as { authorizationRuntime?: string }).authorizationRuntime, 'axiom.authz.v3');
});

test('spec15pt3 §40: alpha.2 ↔ alpha.3 over a legacy-auth graph is fail-closed incompatible', () => {
  const alpha3 = serverIrCompatibilityKey(legacyIr());
  // alpha.2 never stamped a discriminator for a legacy-only graph (`usesAuthorizationVocabulary` is false there).
  const cmp = compareAuthorityCompatibility(alpha3, dropRuntime(alpha3));
  assert.equal(cmp.compatible, false);
  assert.ok(cmp.mismatches.includes('authorizationRuntime'));
  // alpha.3 ↔ alpha.3 on the same graph stays compatible.
  assert.equal(compareAuthorityCompatibility(alpha3, serverIrCompatibilityKey(legacyIr())).compatible, true);
});

test('spec15pt3 §41: alpha.2 ↔ alpha.3 over a legacy + new-policy graph is incompatible', () => {
  const alpha3 = serverIrCompatibilityKey(legacyIr({ policy: true }));
  const cmp = compareAuthorityCompatibility(alpha3, withV2(alpha3));
  assert.equal(cmp.compatible, false);
  assert.ok(cmp.mismatches.includes('authorizationRuntime'));
});

test('spec15pt3 §41: alpha.2 ↔ alpha.3 over a new-policy-only graph is incompatible (v2 ≠ v3)', () => {
  const alpha3 = serverIrCompatibilityKey(ir({ policy: true }));
  assert.equal((alpha3 as { authorizationRuntime?: string }).authorizationRuntime, 'axiom.authz.v3');
  assert.equal(compareAuthorityCompatibility(alpha3, withV2(alpha3)).compatible, false);
});

test('spec15pt3 §42/§43: a graph with no authorization decision rolls alpha.2 → alpha.3 unaffected', () => {
  const plain = serverIrCompatibilityKey(ir({}));
  assert.equal((plain as { authorizationRuntime?: string }).authorizationRuntime, undefined);
  // Same semantic fingerprint across the two builds, no discriminator on either side ⇒ compatible.
  assert.equal(compareAuthorityCompatibility(plain, dropRuntime(plain)).compatible, true);
  assert.equal(serverIrSemanticFingerprint(ir({})), serverIrSemanticFingerprint(ir({})));
});
