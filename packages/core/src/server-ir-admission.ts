import { canonicalJSON } from './schema-identity.js';
import { rawOperations } from './nodes.js';

/**
 * Structural admission of a serialized Server IR — the **totality boundary** every runtime
 * that consumes untrusted `axiom.server.*` JSON crosses before any semantic execution
 * (spec17 §15-§19, §80 F1-B).
 *
 * The frozen Server IR contract (`docs/AUTHORITY.md`) defines the semantic meaning of a
 * *well-formed* document. A hand-built, AI-generated, network-delivered or corrupted
 * document is not proof of shape: a `null`, a primitive or an array where a semantic node
 * belongs, a non-array where a collection belongs, or an un-normalized action guard
 * representation must all produce a **structured** rejection — never a native
 * `TypeError` / panic, never a silently skipped check, never a partial execution.
 *
 * These functions are pure, allocate no host object, and are total over `unknown`. An
 * independent runtime in another language needs only this contract and the shapes in
 * `docs/AUTHORITY.md` to reproduce the same admission decision; it needs nothing else from
 * this file.
 */

/** Stable diagnostic codes for a structurally invalid or non-normalized serialized Server IR. */
export const SERVER_IR_ADMISSION_CODES = {
  /** The serialized Server IR is not a JSON object. */
  SERVER_IR_NOT_OBJECT: 'SERVER_IR_NOT_OBJECT',
  /** A Server IR collection is present but is not the array / object container its contract requires. */
  SERVER_IR_INVALID_COLLECTION: 'SERVER_IR_INVALID_COLLECTION',
  /**
   * An entry of a semantic-node collection is `null`, a primitive, or otherwise not the
   * structural shape its node kind requires. A key being present does not make an invalid
   * value a valid node (spec17 §15-§16).
   */
  SERVER_IR_INVALID_NODE: 'SERVER_IR_INVALID_NODE',
  /**
   * An executable action carries authoring `guards` that are not represented in the aligned,
   * lowered `preconditions` / `failureModes` the authority evaluates. Compilation owns guard
   * lowering; an authority does not lower at execution time and does not silently skip the
   * unmatched guard semantics — it rejects the non-normalized document (spec17 §10-§14, §66).
   */
  SERVER_IR_NOT_NORMALIZED: 'SERVER_IR_NOT_NORMALIZED',
} as const;

export type ServerIRAdmissionCode =
  (typeof SERVER_IR_ADMISSION_CODES)[keyof typeof SERVER_IR_ADMISSION_CODES];

export interface ServerIRStructuralProblem {
  code: ServerIRAdmissionCode;
  /** A stable, non-secret dotted path into the document — e.g. `actions.a`, `states[3]`. */
  path: string;
  message: string;
}

/**
 * A structurally invalid or non-normalized serialized Server IR. Carries every structural
 * problem found, so a caller (or a conformance harness) can compare stable codes and paths
 * rather than prose. Thrown by `createAxiomServer` before any state, provider, effect,
 * event or workflow is touched.
 */
export class ServerIRError extends Error {
  readonly problems: ServerIRStructuralProblem[];

  constructor(problems: ServerIRStructuralProblem[]) {
    super(
      `Server IR is structurally invalid:\n${problems
        .map((problem) => `  [${problem.code}] ${problem.path}: ${problem.message}`)
        .join('\n')}`,
    );
    this.name = 'ServerIRError';
    this.problems = problems;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A structurally acceptable semantic node: a plain object carrying a string `id`. */
function isNodeShaped(value: unknown): boolean {
  return isPlainObject(value) && typeof value.id === 'string';
}

/**
 * Server IR collections that hold semantic nodes as a JSON **array**. `workflows` is
 * deliberately excluded: `WorkflowDef` admission has its own total validator
 * (`workflowStructuralProblems` / `WorkflowIRError`, spec14pt3-pt6) that `createAxiomServer`
 * already runs, and it reports a richer structured result than a generic node-shape check.
 */
const ARRAY_NODE_COLLECTIONS = [
  'entities',
  'states',
  'constraints',
  'transitionConstraints',
  'integrations',
  'events',
  'triggers',
  'subscriptions',
  'storages',
  'queries',
  'relationships',
  'readPolicies',
  'authorizationPolicies',
  'migrations',
] as const;

/** Server IR collections that hold semantic nodes as a JSON **object** keyed by id. */
const MAP_NODE_COLLECTIONS = ['actions', 'integrationOperations', 'expressionDefs'] as const;

/** Collections a compiled Server IR always emits; a present non-array value is a defect. */
const REQUIRED_ARRAY_COLLECTIONS = [
  'entities',
  'states',
  'constraints',
  'transitionConstraints',
  'observableStateIds',
] as const;

/**
 * Every structural problem in a serialized Server IR — total over `unknown`. An empty array
 * means the document is structurally admissible (it may still be semantically invalid;
 * that is `validateGraph` / per-node validation's job). This never throws.
 */
export function serverIRStructuralProblems(ir: unknown): ServerIRStructuralProblem[] {
  const problems: ServerIRStructuralProblem[] = [];

  if (!isPlainObject(ir)) {
    return [
      {
        code: SERVER_IR_ADMISSION_CODES.SERVER_IR_NOT_OBJECT,
        path: '(root)',
        message: `Server IR must be a JSON object, received ${ir === null ? 'null' : Array.isArray(ir) ? 'array' : typeof ir}`,
      },
    ];
  }

  // `fields` is a pre-indexed lookup object, not a node collection, but it is still iterated.
  if (ir.fields !== undefined && !isPlainObject(ir.fields)) {
    problems.push({
      code: SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_COLLECTION,
      path: 'fields',
      message: 'fields must be an object keyed by field id',
    });
  }

  for (const key of REQUIRED_ARRAY_COLLECTIONS) {
    const value = ir[key];
    if (value !== undefined && !Array.isArray(value)) {
      problems.push({
        code: SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_COLLECTION,
        path: key,
        message: `${key} must be an array`,
      });
    }
  }

  // `observableStateIds` holds ids, not nodes: every entry must be a string.
  if (Array.isArray(ir.observableStateIds)) {
    ir.observableStateIds.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        problems.push({
          code: SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_NODE,
          path: `observableStateIds[${index}]`,
          message: 'observableStateIds entries must be state id strings',
        });
      }
    });
  }

  for (const key of ARRAY_NODE_COLLECTIONS) {
    const value = ir[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      problems.push({
        code: SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_COLLECTION,
        path: key,
        message: `${key} must be an array`,
      });
      continue;
    }
    value.forEach((entry, index) => {
      if (!isNodeShaped(entry)) {
        problems.push({
          code: SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_NODE,
          path: `${key}[${index}]`,
          message: `${key}[${index}] is not a semantic node (a plain object with a string id)`,
        });
      }
    });
  }

  for (const key of MAP_NODE_COLLECTIONS) {
    const value = ir[key];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      problems.push({
        code: SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_COLLECTION,
        path: key,
        message: `${key} must be an object keyed by node id`,
      });
      continue;
    }
    for (const [entryKey, entry] of Object.entries(value)) {
      if (!isNodeShaped(entry)) {
        problems.push({
          code: SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_NODE,
          path: `${key}.${entryKey}`,
          message: `${key}.${entryKey} is not a semantic node (a plain object with a string id)`,
        });
      }
    }
  }

  // Operation shape, at admission: a `null` / primitive / array where an operation belongs
  // must be a structured rejection, not a value silently dropped later (spec17 §14, §62).
  if (isPlainObject(ir.actions)) {
    for (const [actionKey, action] of Object.entries(ir.actions)) {
      if (!isPlainObject(action)) continue;
      walkOperationShape(rawOperations(action), `actions.${actionKey}.operations`, problems);
    }
  }

  return problems;
}

function walkOperationShape(
  operations: readonly unknown[],
  path: string,
  problems: ServerIRStructuralProblem[],
): void {
  operations.forEach((operation, index) => {
    if (!isPlainObject(operation) || typeof operation.kind !== 'string') {
      problems.push({
        code: SERVER_IR_ADMISSION_CODES.SERVER_IR_INVALID_NODE,
        path: `${path}[${index}]`,
        message: 'operation is not a plain object with a string kind',
      });
      return;
    }
    if (operation.kind === 'for-each') {
      walkOperationShape(rawOperations(operation), `${path}[${index}].operations`, problems);
    }
  });
}

/**
 * Every guard-normalization problem in a serialized Server IR — total over `unknown`
 * (spec17 §10-§14, §80 F2).
 *
 * A compiled Server IR carries each authoring guard lowered into `preconditions[i]` /
 * `failureModes[i]` aligned by position, and retains `guards` alongside them. A document is
 * **normalized** when, for every action, `preconditions` has at least one entry per guard
 * and `canonicalJSON(preconditions[i]) === canonicalJSON(guards[i].condition)`. Anything
 * else — a guard with no lowered precondition, or a precondition that does not match its
 * guard's condition — means the executable representation would silently omit a check the
 * document declares, and the authority MUST reject it fail-closed rather than execute the
 * action.
 *
 * Actions with no `guards`, or `guards: []`, are always normalized (the positional
 * `preconditions` / `failureModes` form is itself the normalized form).
 */
export function serverIRNormalizationProblems(ir: unknown): ServerIRStructuralProblem[] {
  const problems: ServerIRStructuralProblem[] = [];
  if (!isPlainObject(ir) || !isPlainObject(ir.actions)) {
    return problems;
  }
  for (const [actionKey, action] of Object.entries(ir.actions)) {
    if (!isPlainObject(action)) continue;
    const guards = Array.isArray(action.guards) ? action.guards : undefined;
    if (!guards || guards.length === 0) continue;
    const preconditions = Array.isArray(action.preconditions) ? action.preconditions : [];
    if (preconditions.length < guards.length) {
      problems.push({
        code: SERVER_IR_ADMISSION_CODES.SERVER_IR_NOT_NORMALIZED,
        path: `actions.${actionKey}`,
        message: `action carries ${guards.length} guard(s) but only ${preconditions.length} lowered precondition(s); Server IR must be normalized by compilation before execution`,
      });
      continue;
    }
    guards.forEach((guard, index) => {
      const condition = isPlainObject(guard) ? guard.condition : undefined;
      if (canonicalJSON(condition) !== canonicalJSON(preconditions[index])) {
        problems.push({
          code: SERVER_IR_ADMISSION_CODES.SERVER_IR_NOT_NORMALIZED,
          path: `actions.${actionKey}.guards[${index}]`,
          message: `guard ${index} is not represented at preconditions[${index}]; the lowered executable form does not preserve this guard's semantics`,
        });
      }
    });
  }
  return problems;
}

/**
 * Throws {@link ServerIRError} if a serialized Server IR is structurally invalid or not
 * normalized. Runs structural admission first (a non-object / malformed-collection document
 * is reported without also running the guard check against it).
 */
export function assertAdmissibleServerIR(ir: unknown): void {
  const structural = serverIRStructuralProblems(ir);
  if (structural.length > 0) {
    throw new ServerIRError(structural);
  }
  const normalization = serverIRNormalizationProblems(ir);
  if (normalization.length > 0) {
    throw new ServerIRError(normalization);
  }
}
