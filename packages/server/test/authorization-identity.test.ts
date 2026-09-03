import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  EXECUTABLE_KINDS,
  binary,
  compareAuthorityCompatibility,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, AuthorizationPolicyDef, EntityDef, StateDef } from '@cynodia/axiom-core';
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
 * up automatically; a graph with none is byte-identical to its prior contract; and a build
 * that cannot yet enforce a declared policy fails closed rather than running it as a no-op.
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
        : binary('eq', field(ref('PRINCIPAL' as never), F_P_ROLE), literal('editor')),
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

test('spec15 §128 / spec4 §4: createAxiomServer fails closed on an unenforceable authorization policy', async () => {
  let err: unknown;
  try {
    const s = createAxiomServer({ ir: ir({ policy: true }), persistence: createMemoryPersistence() });
    await s.start();
    await s.stop().catch(() => {});
  } catch (error) {
    err = error;
  }
  assert.ok(err instanceof Error, String(err));
  assert.match((err as Error).message, /AUTHORIZATION_ENFORCEMENT_UNAVAILABLE/);
  assert.ok(!/TypeError|Cannot read/.test((err as Error).message), 'structured, not native');

  // A graph with no authorization vocabulary still starts normally.
  const ok = createAxiomServer({ ir: ir({}), persistence: createMemoryPersistence() });
  await ok.start();
  await ok.stop();
});

test('spec15 §69: the authorization policy round-trips through Server IR serialization', () => {
  const original = ir({ policy: true });
  const roundTripped = JSON.parse(JSON.stringify(original)) as ServerIR;
  assert.equal(serverIrSemanticFingerprint(roundTripped), serverIrSemanticFingerprint(original));
  assert.deepEqual(roundTripped.authorizationPolicies, original.authorizationPolicies);
});
