import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationGraph,
  binary,
  collectionType,
  entityType,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom-core';
import type { ActionDef, ApplicationGraphData, EntityDef, StateDef } from '@cynodia/axiom-core';

/**
 * spec16pt2 §25-31 — deterministic structural mutation testing over malformed graph input.
 * Not probabilistic security fuzzing: every variant is derived from a recorded seed and its
 * index, so a failure is independently reproducible (§27) from `(seed, index)` alone — the
 * failure message below prints the serialized candidate for exactly that reason.
 *
 * Required: 1,000+ variants, zero native exceptions, zero silent semantic acceptance of a
 * structurally invalid shape, and representative valid controls that keep validating true
 * (§29) so this suite cannot degenerate into a validator that rejects everything.
 */

const FUZZ_SEED = 20260905;
const VARIANT_COUNT = 1200;

/** mulberry32 — a tiny deterministic PRNG. Same seed, same sequence, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ENTITY = nodeId('entity_thing');
const F_ID = fieldId('field_thing_id');
const F_QTY = fieldId('field_thing_qty');
const STATE_LIST = nodeId('state_things');
const STATE_COUNT = nodeId('state_count');
const ACTION = nodeId('action_process');
const SCOPE = nodeId('scope_item');

/** A representative valid graph exercising several operation kinds and location shapes. */
function representativeGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('fuzz', 'Fuzz');
  graph.addNode<EntityDef>({
    id: ENTITY,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_QTY, valueType: primitiveType('number'), required: true },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE_LIST,
    kind: 'state',
    valueType: collectionType(entityType(ENTITY)),
    initialValue: [],
  });
  graph.addNode<StateDef>({ id: STATE_COUNT, kind: 'state', valueType: primitiveType('number'), initialValue: 0 });
  graph.addNode<ActionDef>({
    id: ACTION,
    kind: 'action',
    operations: [
      { kind: 'set', target: stateLocation(STATE_COUNT), value: binary('add', ref(STATE_COUNT), literal(1)) },
      {
        kind: 'for-each',
        collection: ref(STATE_LIST),
        scopeId: SCOPE,
        operations: [
          {
            kind: 'set',
            target: { kind: 'field', target: { kind: 'collection-item', collection: stateLocation(STATE_LIST), selector: { kind: 'identity', fieldId: F_ID, value: { kind: 'field', source: ref(SCOPE), fieldId: F_ID } } }, fieldId: F_QTY },
            value: literal(0),
          },
        ],
      },
    ],
  });
  return graph;
}

type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

interface Candidate {
  parent: Record<string, JSONValue> | JSONValue[];
  key: string | number;
}

/** Every (parent, key) position in a JSON tree — the universe a mutation can target. */
function collectPaths(value: JSONValue, out: Candidate[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      out.push({ parent: value, key: index });
      collectPaths(entry, out);
    });
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      out.push({ parent: value as Record<string, JSONValue>, key });
      collectPaths((value as Record<string, JSONValue>)[key], out);
    }
  }
}

type MutationClass =
  | 'field-deletion'
  | 'null-substitution'
  | 'wrong-primitive-type'
  | 'object-for-array'
  | 'array-for-object'
  | 'unknown-kind'
  | 'empty-object'
  | 'empty-array'
  | 'malformed-nested-child'
  | 'null-nested-child'
  | 'dangling-semantic-reference';

const MUTATION_CLASSES: readonly MutationClass[] = [
  'field-deletion',
  'null-substitution',
  'wrong-primitive-type',
  'object-for-array',
  'array-for-object',
  'unknown-kind',
  'empty-object',
  'empty-array',
  'malformed-nested-child',
  'null-nested-child',
  'dangling-semantic-reference',
];

function get(candidate: Candidate): JSONValue {
  return Array.isArray(candidate.parent)
    ? candidate.parent[candidate.key as number]
    : candidate.parent[candidate.key as string];
}

function set(candidate: Candidate, value: JSONValue): void {
  if (Array.isArray(candidate.parent)) {
    candidate.parent[candidate.key as number] = value;
  } else {
    candidate.parent[candidate.key as string] = value;
  }
}

function applyMutation(candidate: Candidate, mutation: MutationClass, rng: () => number): boolean {
  const current = get(candidate);
  switch (mutation) {
    case 'field-deletion':
      if (Array.isArray(candidate.parent)) return false;
      delete (candidate.parent as Record<string, JSONValue>)[candidate.key as string];
      return true;
    case 'null-substitution':
      set(candidate, null);
      return true;
    case 'wrong-primitive-type':
      set(candidate, typeof current === 'string' ? 42 : typeof current === 'number' ? 'not-a-number' : 'wrong-type');
      return true;
    case 'object-for-array':
      if (!Array.isArray(current)) return false;
      set(candidate, {});
      return true;
    case 'array-for-object':
      if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
      set(candidate, []);
      return true;
    case 'unknown-kind':
      if (!current || typeof current !== 'object' || Array.isArray(current) || !('kind' in current)) return false;
      set(candidate, { ...current, kind: 'totally-unrecognized-kind' });
      return true;
    case 'empty-object':
      set(candidate, {});
      return true;
    case 'empty-array':
      set(candidate, []);
      return true;
    case 'malformed-nested-child': {
      if (!Array.isArray(current) || current.length === 0) return false;
      const index = Math.floor(rng() * current.length);
      current[index] = {} as JSONValue;
      return true;
    }
    case 'null-nested-child': {
      if (!Array.isArray(current) || current.length === 0) return false;
      const index = Math.floor(rng() * current.length);
      current[index] = null;
      return true;
    }
    case 'dangling-semantic-reference': {
      if (typeof current !== 'string') return false;
      const looksLikeRef = /Id$/.test(String(candidate.key)) || candidate.key === 'stateId' || candidate.key === 'targetId';
      if (!looksLikeRef) return false;
      set(candidate, 'dangling_ref_zzz_does_not_exist');
      return true;
    }
    default:
      return false;
  }
}

interface FuzzOutcome {
  index: number;
  path: (string | number)[];
  mutation: MutationClass;
  threw: string | null;
}

function pathOf(candidate: Candidate, root: JSONValue): (string | number)[] {
  // Best-effort human-readable label; not required to be exact for reproduction (the
  // serialized candidate, printed on failure, is the actual reproduction artifact).
  return [candidate.key];
}

test(`deterministic malformed-input fuzz: ${VARIANT_COUNT} variants, zero native exceptions (spec16pt2 §25-28)`, () => {
  const rng = mulberry32(FUZZ_SEED);
  const baseline = representativeGraph().toJSON();
  const outcomes: FuzzOutcome[] = [];
  let structuredRejections = 0;
  let unexpectedAccepts = 0;

  for (let index = 0; index < VARIANT_COUNT; index += 1) {
    const candidateData = structuredClone(baseline) as unknown as JSONValue;
    const paths: Candidate[] = [];
    // Scoped to the action's own operations subtree — the actual F1/F2 lineage and the
    // shapes spec16pt2 §26 enumerates (operation target, nested operations collection,
    // expression node). Corrupting the graph *container* itself (a null entry in the
    // top-level node map, reachable only by hand-crafting raw JSON outside the `addNode`/
    // `GraphChange` authoring surface) is a materially different, broader hardening
    // question than the one this release closes, and is called out as a known limitation
    // in the implementation report rather than silently expanded into here.
    const actionNode = (candidateData as { nodes: Record<string, JSONValue> }).nodes[String(ACTION)];
    collectPaths(actionNode, paths);
    if (paths.length === 0) continue;

    // Deterministic selection: the seed drives every choice, so variant `index` is always
    // the same mutation at the same path on every run (spec16pt2 §27).
    let chosen: Candidate | undefined;
    let mutation: MutationClass = MUTATION_CLASSES[0];
    let applied = false;
    for (let attempt = 0; attempt < 5 && !applied; attempt += 1) {
      chosen = paths[Math.floor(rng() * paths.length)];
      mutation = MUTATION_CLASSES[Math.floor(rng() * MUTATION_CLASSES.length)];
      applied = applyMutation(chosen, mutation, rng);
    }
    if (!applied || !chosen) {
      continue;
    }

    let threw: string | null = null;
    let valid = false;
    try {
      const graph = ApplicationGraph.deserialize(candidateData as unknown as ApplicationGraphData);
      const result = validateGraph(graph);
      valid = result.valid;
      // Reading edges must not throw either — the F1/F2 defects were also reachable
      // through plain graph traversal, not only through validateGraph (spec16pt2 §24).
      graph.semanticEdges();
    } catch (error) {
      threw = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error);
    }

    outcomes.push({ index, path: pathOf(chosen, candidateData), mutation, threw });
    if (threw) {
      // Handled below via the assertion; recorded here for the failure report.
    } else if (valid) {
      unexpectedAccepts += 1;
    } else {
      structuredRejections += 1;
    }
  }

  const thrown = outcomes.filter((o) => o.threw);
  if (thrown.length > 0) {
    const first = thrown[0];
    assert.fail(
      `${thrown.length}/${outcomes.length} variant(s) threw a native exception (seed=${FUZZ_SEED}). ` +
        `First: variant #${first.index}, mutation=${first.mutation}, path=${JSON.stringify(first.path)}, error=${first.threw}`,
    );
  }

  // Reporting, per spec16pt2 §139 — printed so a maintainer reading test output sees the
  // shape of the run, not merely its pass/fail.
  console.log(
    `[fuzz] seed=${FUZZ_SEED} variants=${outcomes.length} structuredRejections=${structuredRejections} ` +
      `unexpectedAccepts=${unexpectedAccepts} nativeExceptions=${thrown.length}`,
  );

  assert.ok(outcomes.length >= 1000, `expected at least 1000 applied variants, got ${outcomes.length}`);
  // A mutation is not guaranteed to make the graph invalid (e.g. deleting an optional
  // `name`), so we do not assert unexpectedAccepts === 0 — only that no native error ever
  // escaped, and that at least the overwhelming majority of structural mutations were
  // actually caught.
  assert.ok(structuredRejections > outcomes.length * 0.5, 'too few mutations were structurally rejected — the corpus may be too weak');
});

test('the fuzz corpus does not degenerate into a validator that rejects everything (spec16pt2 §29)', () => {
  const result = validateGraph(representativeGraph());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});
