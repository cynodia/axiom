import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  semanticDiff,
  semanticFingerprint,
} from '@cynodia/axiom-core';
import type { EntityDef, QueryDef, ReadPolicyDef } from '@cynodia/axiom-core';

/**
 * spec16pt2 F3 — `semanticDiff` must classify every authorization-bearing change as
 * `authorization`, never leaving a security-relevant edit looking like an ordinary `query`
 * edit. §92: a mechanically enumerated matrix over every authorization surface — attach,
 * detach, replace, and (for `ReadPolicyDef`) definition mutation.
 */

const ENTITY = nodeId('entity_doc');
const F_ID = fieldId('field_doc_id');
const F_OWNER = fieldId('field_doc_owner');
const Q = nodeId('query_docs');
const ROW = nodeId('scope_row');
const RP1 = nodeId('read_policy_owner');
const RP2 = nodeId('read_policy_other');

function graph(build: (g: ApplicationGraph) => void): ApplicationGraph {
  const g = new ApplicationGraph('f3', 'F3');
  g.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_OWNER, valueType: primitiveType('string'), required: true },
    ],
  });
  build(g);
  return g;
}

function queryWithReadPolicy(readPolicyId?: string): QueryDef {
  return {
    id: Q,
    kind: 'query',
    source: ENTITY,
    rowScopeId: ROW,
    pagination: { strategy: 'offset', maxPageSize: 50 },
    ...(readPolicyId ? { readPolicyId: readPolicyId as never } : {}),
  } as QueryDef;
}

function readPolicy(id: string, ownerField: typeof F_OWNER = F_OWNER): ReadPolicyDef {
  return {
    id: id as never,
    kind: 'read-policy',
    entityId: ENTITY,
    rowScopeId: ROW,
    predicate: binary('eq', field(ref(ROW), ownerField), literal('me')),
  };
}

function categoriesFor(diff: ReturnType<typeof semanticDiff>, nodeId_: string): string[] {
  return diff.entries.find((e) => e.nodeId === nodeId_)?.categories ?? [];
}

test('F3 exact reproduction: detaching QueryDef.readPolicyId is classified query + authorization (spec16pt2 §103)', () => {
  const before = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(RP1));
  });
  const after = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(undefined));
  });
  const diff = semanticDiff(before, after);
  const categories = categoriesFor(diff, Q);
  assert.ok(categories.includes('query'), `expected "query" in ${JSON.stringify(categories)}`);
  assert.ok(categories.includes('authorization'), `expected "authorization" in ${JSON.stringify(categories)}`);
});

test('F3 compatibility gate: the same pair still reports fingerprint/compatibility impact (spec16pt2 §104)', () => {
  const before = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(RP1));
  });
  const after = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(undefined));
  });
  assert.notEqual(semanticFingerprint(before), semanticFingerprint(after));
  const diff = semanticDiff(before, after);
  assert.equal(diff.compatibility.semanticFingerprintChanged, true);
  assert.equal(diff.compatibility.authorityCompatibilityAffected, true);
});

test('spec16pt2 §35 reverse case: attaching a read policy is also authorization', () => {
  const before = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(undefined));
  });
  const after = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(RP1));
  });
  assert.ok(categoriesFor(semanticDiff(before, after), Q).includes('authorization'));
});

test('spec16pt2 §36: replacing one read policy reference for another is authorization', () => {
  const before = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<ReadPolicyDef>(readPolicy(RP2));
    g.addNode<QueryDef>(queryWithReadPolicy(RP1));
  });
  const after = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<ReadPolicyDef>(readPolicy(RP2));
    g.addNode<QueryDef>(queryWithReadPolicy(RP2));
  });
  assert.ok(categoriesFor(semanticDiff(before, after), Q).includes('authorization'));
});

test('spec16pt2 §37: a ReadPolicyDef predicate edit is authorization even with the QueryDef reference unchanged', () => {
  const before = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1, F_OWNER));
    g.addNode<QueryDef>(queryWithReadPolicy(RP1));
  });
  const after = graph((g) => {
    // Same policy id, same governed entity — only the rule content changes.
    const policy = before.getNode<ReadPolicyDef>(RP1)!;
    g.addNode<ReadPolicyDef>({ ...policy, predicate: literal(true) });
    g.addNode<QueryDef>(queryWithReadPolicy(RP1));
  });
  const diff = semanticDiff(before, after);
  const categories = categoriesFor(diff, RP1);
  assert.ok(categories.includes('authorization'), `expected "authorization" in ${JSON.stringify(categories)}`);
  assert.notEqual(semanticFingerprint(before), semanticFingerprint(after));
});

test('spec16pt2 §45-46 false-positive control: sort/limit/presentation-only query changes are not authorization', () => {
  const before = graph((g) => {
    g.addNode<QueryDef>({ ...queryWithReadPolicy(undefined), name: 'Docs' } as QueryDef);
  });
  const after = graph((g) => {
    g.addNode<QueryDef>({
      ...queryWithReadPolicy(undefined),
      name: 'Docs',
      pagination: { strategy: 'offset', maxPageSize: 200 },
    } as QueryDef);
  });
  const categories = categoriesFor(semanticDiff(before, after), Q);
  assert.deepEqual(categories, ['query']);
});

test('spec16pt2 §50: diff symmetry — attach/detach direction does not alter security classification', () => {
  const withPolicy = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(RP1));
  });
  const withoutPolicy = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(undefined));
  });
  const forward = categoriesFor(semanticDiff(withPolicy, withoutPolicy), Q);
  const backward = categoriesFor(semanticDiff(withoutPolicy, withPolicy), Q);
  assert.ok(forward.includes('authorization'));
  assert.ok(backward.includes('authorization'));
});

test('spec16pt2 §47: a security-review filter over categories finds every authorization change', () => {
  const before = graph((g) => {
    g.addNode<ReadPolicyDef>(readPolicy(RP1));
    g.addNode<QueryDef>(queryWithReadPolicy(RP1));
  });
  const after = graph((g) => {
    g.addNode<QueryDef>(queryWithReadPolicy(undefined));
  });
  const diff = semanticDiff(before, after);
  const securityChanges = diff.entries.filter((e) => e.categories.includes('authorization'));
  const affectedIds = new Set(securityChanges.map((e) => e.nodeId));
  assert.ok(affectedIds.has(Q), 'the query whose readPolicyId changed must be in the security review set');
  assert.ok(affectedIds.has(RP1), 'the removed read policy must be in the security review set');
});
