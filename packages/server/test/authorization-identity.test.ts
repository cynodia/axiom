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
