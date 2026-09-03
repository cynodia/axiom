/**
 * Authorization completeness (spec15) — the canonical, portable authorization policy model.
 *
 * Authorization in Axiom is **semantic**: whether a principal may perform a semantic
 * operation is executable meaning, not presentation. It therefore lives in the graph, in
 * `semanticFingerprint`, in authority compatibility, in the Server IR and in conformance —
 * never as a host-language callback (spec15 §6, §7).
 *
 * There is exactly **one** authorization language: an `AuthorizationPolicyDef` with a single
 * boolean `allow` expression over a **closed scope** — `ref('PRINCIPAL')` (the canonical
 * caller), `ref('RESOURCE')` (the semantic object the operation targets, where one exists)
 * and `ref('OPERATION')` (the canonical operation identity). No `StateDef`, no `QueryDef`,
 * no `now` / `uuid` / `random`, no ambient runtime state (spec15 §34). `allow` evaluating to
 * exactly `true` is **ALLOW**; `false`, absence, or any evaluation error is **DENY** — the
 * safe direction is always refusal (spec15 §8, §123).
 *
 * A policy is referenced by id from the surface it protects — `ActionDef.authorizationPolicy`,
 * `QueryDef.authorizationPolicy`, `WorkflowDef.startPolicy` / `instanceAccessPolicy` — so the
 * same evaluator and the same decision model apply everywhere (spec15 §5, §96). The legacy
 * `ActionDef.authorization` boolean expression remains supported and is canonically
 * equivalent to an inline `allow` over `PRINCIPAL`; `ReadPolicyDef` (spec10) remains the
 * row-level read mechanism, unified into query authorization by spec15 Phase D.
 *
 * This module is portable plain data + `Expression` trees; it carries no enforcement (that
 * is Phases C–F). The accessors are **total over any input** so a hand-tampered policy fails
 * closed with a structured diagnostic, never a native exception (spec15 §37).
 */

import { OPERATION, PRINCIPAL, RESOURCE } from './authority.js';
import { EXPRESSION_KINDS } from './expressions.js';
import type { Expression } from './expressions.js';
import type { NodeId } from './ids.js';
import type { NodeBase } from './nodes.js';

// --------------------------------------------------------------------- reserved scope ids

/**
 * The canonical caller. The **same** reserved id `ActionDef.authorization` uses
 * (`'axiom_principal'`, exported from `authority.ts` as `PRINCIPAL`) — write a policy with
 * `field(ref(PRINCIPAL), F_ROLE)`, exactly as a legacy authorization expression.
 */
export const AUTHZ_PRINCIPAL_SCOPE: NodeId = PRINCIPAL;
/** The semantic object the operation targets (a record, a workflow instance, …), where one exists. */
export const AUTHZ_RESOURCE_SCOPE: NodeId = RESOURCE;
/** The canonical operation identity — `ref(OPERATION)` resolves to an `AuthorizationOperation` string. */
export const AUTHZ_OPERATION_SCOPE: NodeId = OPERATION;

/** Every id a policy `allow` expression's `ref` may resolve. Nothing else is in scope. */
export const AUTHORIZATION_SCOPE_IDS: readonly string[] = [
  AUTHZ_PRINCIPAL_SCOPE,
  AUTHZ_RESOURCE_SCOPE,
  AUTHZ_OPERATION_SCOPE,
];

/** Builtins forbidden in a policy expression — authorization must be deterministic (spec15 §34). */
export const AUTHORIZATION_NONDETERMINISTIC_BUILTINS: ReadonlySet<string> = new Set([
  'now',
  'uuid',
  'random',
]);

// ----------------------------------------------------------------------- operation identity

/**
 * The closed set of canonical semantic operations an authorization decision is made about
 * (spec15 §98). Policies reason over these, never over transport method names. Enforcement
 * of each arrives with its phase (C: `action.invoke` / `record.*` / `state.*`; D:
 * `query.read`; E: `workflow.*`; F: `live.*` / `subscription.*`).
 */
export const AUTHORIZATION_OPERATIONS = [
  'action.invoke',
  'query.read',
  'record.read',
  'record.mutate',
  'state.read',
  'state.mutate',
  'workflow.start',
  'workflow.inspect',
  'workflow.history',
  'workflow.cancel',
  'live.open',
  'live.resume',
  'subscription.open',
  'event.ingress',
] as const;
export type AuthorizationOperation = (typeof AUTHORIZATION_OPERATIONS)[number];

// ------------------------------------------------------------------ AuthorizationPolicyDef

export interface AuthorizationPolicyDef extends NodeBase {
  kind: 'authorization-policy';
  /**
   * Boolean, closed scope (`PRINCIPAL` / `RESOURCE` / `OPERATION` only). Exactly `true` ⇒
   * ALLOW; `false` / absent / evaluation error ⇒ DENY (spec15 §8). Deterministic — no
   * `now` / `uuid` / `random`, no `StateDef` / `QueryDef` (spec15 §34).
   */
  allow: Expression;
}

// --------------------------------------------------------------------------- default rule

/**
 * What a protected surface does when it has **no** attached policy (spec15 §9). Deliberately
 * one canonical rule, applied consistently, never left to the runtime:
 *
 * - a surface whose *current* (pre-0.15) contract is public — an unrestricted `ActionDef`,
 *   an unrestricted `QueryDef` — keeps that public contract (`'public'`);
 * - a surface whose current contract is already restricted — a `WorkflowDef` instance
 *   operation (0.14 owner-fingerprint), an `ActionDef` with a legacy `authorization`
 *   expression, a `QueryDef` with a `ReadPolicyDef` — keeps that restriction;
 * - a *new* privileged surface with no policy fails closed (`'deny'`).
 *
 * These constants name the rule so docs, tests and a future independent runtime agree.
 */
export const AUTHORIZATION_DEFAULT = {
  /** No policy, previously-public surface ⇒ still public. */
  PUBLIC_SURFACE: 'public',
  /** No policy, previously-restricted surface ⇒ keep the prior restriction. */
  KEEP_PRIOR_RESTRICTION: 'keep-prior-restriction',
  /** No policy, new privileged surface ⇒ DENY. */
  FAIL_CLOSED: 'deny',
} as const;

// -------------------------------------------------------------------------------- accessors

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Every `Expression` a policy embeds — total over malformed input. */
export function authorizationPolicyExpressions(policy: unknown): Expression[] {
  if (!isPlainObject(policy)) return [];
  const allow = policy.allow;
  return isPlainObject(allow) ? [allow as unknown as Expression] : [];
}

/** Walk an expression tree collecting every scope `ref` id and every nondeterministic call. */
function walkPolicyExpression(
  expression: unknown,
  refs: Set<string>,
  nondeterministic: Set<string>,
  seen: Set<object> = new Set(),
): void {
  if (!isPlainObject(expression) || seen.has(expression)) return;
  seen.add(expression);
  if (expression.kind === 'ref' && expression.targetId !== undefined) {
    refs.add(String(expression.targetId));
  }
  if (
    expression.kind === 'call' &&
    typeof expression.function === 'string' &&
    AUTHORIZATION_NONDETERMINISTIC_BUILTINS.has(expression.function)
  ) {
    nondeterministic.add(expression.function);
  }
  if (expression.kind === 'literal') return;
  for (const value of Object.values(expression)) {
    if (Array.isArray(value)) {
      for (const entry of value) walkPolicyExpression(entry, refs, nondeterministic, seen);
    } else if (isPlainObject(value)) {
      walkPolicyExpression(value, refs, nondeterministic, seen);
    }
  }
}

export interface AuthorizationPolicyProblem {
  code:
    | 'AUTHORIZATION_INVALID_POLICY'
    | 'AUTHORIZATION_INVALID_SCOPE'
    | 'AUTHORIZATION_NONDETERMINISTIC';
  message: string;
}

/**
 * A **total** structural + scope check on an `AuthorizationPolicyDef` value — for any input,
 * including a hand-tampered Server IR where the policy is the wrong shape entirely (spec15
 * §37). Cross-node reference resolution (does an `authorizationPolicy` id point at a real
 * policy) is `validateGraph`'s job, not this function's.
 */
/**
 * spec15pt2 §39-§41 (F2) — a **total** structural check on an `allow` expression tree.
 * Every node must be a plain object whose `kind` is a real `EXPRESSION_KINDS` member and
 * whose per-kind required children are present and themselves structurally valid. Returns a
 * short reason on the first problem, `null` when the tree is well-formed. Never throws.
 */
function malformedExpressionReason(expression: unknown, seen: Set<object> = new Set()): string | null {
  if (!isPlainObject(expression)) return 'a policy expression node is not an object';
  if (seen.has(expression)) return 'a policy expression contains a cycle';
  seen.add(expression);
  const kind = (expression as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(EXPRESSION_KINDS as readonly string[]).includes(kind)) {
    return `unknown expression kind ${JSON.stringify(kind)}`;
  }
  const child = (name: string): string | null => malformedExpressionReason((expression as Record<string, unknown>)[name], seen);
  const list = (name: string): string | null => {
    const arr = (expression as Record<string, unknown>)[name];
    if (!Array.isArray(arr)) return `${kind}.${name} is not an array`;
    for (const entry of arr) {
      const r = malformedExpressionReason(entry, seen);
      if (r) return r;
    }
    return null;
  };
  switch (kind) {
    case 'literal':
      return 'value' in (expression as object) ? null : 'literal has no value';
    case 'ref':
      return typeof (expression as { targetId?: unknown }).targetId === 'string' ? null : 'ref has no targetId';
    case 'field':
      return (typeof (expression as { fieldId?: unknown }).fieldId === 'string' ? null : 'field has no fieldId') ?? child('source');
    case 'unary':
      return (typeof (expression as { operator?: unknown }).operator === 'string' ? null : 'unary has no operator') ?? child('operand');
    case 'binary':
      return (typeof (expression as { operator?: unknown }).operator === 'string' ? null : 'binary has no operator') ?? child('left') ?? child('right');
    case 'call':
      return (typeof (expression as { function?: unknown }).function === 'string' ? null : 'call has no function') ?? list('arguments');
    case 'conditional':
      return child('condition') ?? child('whenTrue') ?? child('whenFalse');
    case 'object': {
      const entries = (expression as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) return 'object has no entries array';
      for (const e of entries) {
        if (!isPlainObject(e) || typeof e.fieldId !== 'string') return 'an object entry is malformed';
        const r = malformedExpressionReason(e.value, seen);
        if (r) return r;
      }
      return null;
    }
    case 'filter':
    case 'find':
    case 'every':
    case 'some':
      return child('source') ?? child('predicate');
    case 'map':
      return child('source') ?? child('projection');
    case 'sort':
    case 'group':
      return child('source') ?? child('by');
    case 'flatten':
      return child('source');
    case 'expression-ref':
      return typeof (expression as { targetId?: unknown }).targetId === 'string' ? null : 'expression-ref has no targetId';
    default:
      return `unsupported expression kind ${kind}`;
  }
}

export function authorizationPolicyProblems(policy: unknown): AuthorizationPolicyProblem[] {
  const problems: AuthorizationPolicyProblem[] = [];
  const pid = isPlainObject(policy) ? String(policy.id ?? '<unknown>') : '<unknown>';
  if (!isPlainObject(policy)) {
    return [{ code: 'AUTHORIZATION_INVALID_POLICY', message: `Authorization policy ${pid} is not an object` }];
  }
  if (!isPlainObject(policy.allow)) {
    problems.push({
      code: 'AUTHORIZATION_INVALID_POLICY',
      message: `Authorization policy ${pid} has no boolean 'allow' expression`,
    });
    return problems;
  }
  // spec15pt2 F2 — a malformed `allow` tree is rejected structurally here, before compile,
  // rather than surviving to a native exception at evaluation.
  const malformed = malformedExpressionReason(policy.allow);
  if (malformed) {
    return [{ code: 'AUTHORIZATION_INVALID_POLICY', message: `Authorization policy ${pid} has a malformed 'allow' expression: ${malformed}` }];
  }
  const refs = new Set<string>();
  const nondeterministic = new Set<string>();
  walkPolicyExpression(policy.allow, refs, nondeterministic);
  for (const id of refs) {
    if (!AUTHORIZATION_SCOPE_IDS.includes(id)) {
      problems.push({
        code: 'AUTHORIZATION_INVALID_SCOPE',
        message: `Authorization policy ${pid} references ${id}, which is not in the policy scope (PRINCIPAL / RESOURCE / OPERATION)`,
      });
    }
  }
  for (const fn of nondeterministic) {
    problems.push({
      code: 'AUTHORIZATION_NONDETERMINISTIC',
      message: `Authorization policy ${pid} calls ${fn}(), which is not deterministic and not allowed in a policy expression`,
    });
  }
  return problems;
}

// ------------------------------------------------------- dependency analysis (spec15 §35, §44)

export interface AuthorizationPolicyDependencies {
  /** Field ids the policy's `allow` expression reads off `PRINCIPAL`. */
  principalFields: string[];
  /** Field ids it reads off `RESOURCE`. */
  resourceFields: string[];
  /** Whether it references `OPERATION` at all. */
  readsOperation: boolean;
  /**
   * A verdict when `allow` is a constant `literal` (spec15 §8): a literal `true` always
   * allows, anything else always denies. `null` when the decision depends on the inputs.
   */
  constant: 'always-allow' | 'always-deny' | null;
}

function collectScopeFieldReads(
  expression: unknown,
  principal: Set<string>,
  resource: Set<string>,
  operation: { seen: boolean },
  seen: Set<object> = new Set(),
): void {
  if (!isPlainObject(expression) || seen.has(expression)) return;
  seen.add(expression);
  if (expression.kind === 'ref' && String(expression.targetId) === AUTHZ_OPERATION_SCOPE) {
    operation.seen = true;
  }
  if (
    expression.kind === 'field' &&
    isPlainObject(expression.source) &&
    expression.source.kind === 'ref' &&
    expression.fieldId !== undefined
  ) {
    const target = String(expression.source.targetId);
    if (target === AUTHZ_PRINCIPAL_SCOPE) principal.add(String(expression.fieldId));
    else if (target === AUTHZ_RESOURCE_SCOPE) resource.add(String(expression.fieldId));
  }
  if (expression.kind === 'literal') return;
  for (const value of Object.values(expression)) {
    if (Array.isArray(value)) {
      for (const entry of value) collectScopeFieldReads(entry, principal, resource, operation, seen);
    } else if (isPlainObject(value)) {
      collectScopeFieldReads(value, principal, resource, operation, seen);
    }
  }
}

/**
 * What an `AuthorizationPolicyDef` depends on — for explainability, static coverage analysis
 * and AI authoring (spec15 §35, §44). Total over malformed input (empty result). Reports
 * *structure only*, never a runtime value.
 */
export function authorizationPolicyDependencies(policy: unknown): AuthorizationPolicyDependencies {
  const principal = new Set<string>();
  const resource = new Set<string>();
  const operation = { seen: false };
  const allow = isPlainObject(policy) ? policy.allow : undefined;
  if (isPlainObject(allow)) {
    collectScopeFieldReads(allow, principal, resource, operation);
  }
  let constant: 'always-allow' | 'always-deny' | null = null;
  if (isPlainObject(allow) && allow.kind === 'literal') {
    constant = allow.value === true ? 'always-allow' : 'always-deny';
  }
  return {
    principalFields: [...principal].sort(),
    resourceFields: [...resource].sort(),
    readsOperation: operation.seen,
    constant,
  };
}

// --------------------------------------------------------------- the decision (spec15 §8)

export const AUTHORIZATION_DECISIONS = ['ALLOW', 'DENY'] as const;
export type AuthorizationDecision = (typeof AUTHORIZATION_DECISIONS)[number];

/** One evaluated boolean input to an authorization decision. `ok: false` ⇒ evaluation failed. */
export interface AuthorizationCheckPart {
  ok: boolean;
  value?: unknown;
}

export interface AuthorizationCheckInput {
  /**
   * The `AuthorizationPolicyDef.allow` outcome, when a policy is attached. Per spec15 §8 a
   * policy allows only when it evaluates to **exactly `true`**.
   */
  policy?: AuthorizationCheckPart;
  /**
   * The legacy `ActionDef.authorization` expression outcome, when that expression is present.
   * Its historical truthiness rule is kept: a non-empty array or any truthy value allows.
   */
  legacy?: AuthorizationCheckPart;
}

export interface AuthorizationCheckResult {
  decision: AuthorizationDecision;
  reason:
    | 'no-policy'
    | 'allowed'
    | 'policy-denied'
    | 'policy-error'
    | 'legacy-denied'
    | 'legacy-error';
}

/**
 * The canonical ALLOW/DENY combination (spec15 §8, §123) — a pure function of already
 * evaluated inputs, so it is identical on every surface and independently checkable.
 *
 * - neither a policy nor a legacy expression ⇒ ALLOW (`no-policy`);
 * - a policy that failed to evaluate ⇒ DENY (`policy-error`) — an evaluation error never allows;
 * - a policy whose value is not exactly `true` ⇒ DENY (`policy-denied`);
 * - a legacy expression that failed to evaluate ⇒ DENY (`legacy-error`);
 * - a legacy expression that is falsy / an empty collection ⇒ DENY (`legacy-denied`);
 * - otherwise ALLOW (`allowed`). Both, when present, must pass (conjunction).
 */
export function decideAuthorization(input: AuthorizationCheckInput): AuthorizationCheckResult {
  const { policy, legacy } = input;
  if (!policy && !legacy) return { decision: 'ALLOW', reason: 'no-policy' };
  if (policy) {
    if (!policy.ok) return { decision: 'DENY', reason: 'policy-error' };
    if (policy.value !== true) return { decision: 'DENY', reason: 'policy-denied' };
  }
  if (legacy) {
    if (!legacy.ok) return { decision: 'DENY', reason: 'legacy-error' };
    const permitted = Array.isArray(legacy.value) ? legacy.value.length > 0 : Boolean(legacy.value);
    if (!permitted) return { decision: 'DENY', reason: 'legacy-denied' };
  }
  return { decision: 'ALLOW', reason: 'allowed' };
}

// ------------------------------------- three-valued policy evaluation (spec15pt2 F1)

/**
 * The closed scope an `AuthorizationPolicyDef.allow` expression is evaluated against. Each
 * field is a plain record or `null` (anonymous / no resource); a `field` read of a key that
 * is not present is **security-scope absence**, not an ordinary `undefined` (spec15pt2 §5-§7).
 */
export interface AuthorizationPolicyScope {
  principal: Record<string, unknown> | null | undefined;
  resource: Record<string, unknown> | null | undefined;
  operation: string;
}

/** `concrete` value | `unknown` (a missing PRINCIPAL/RESOURCE field) | `error`. */
type AuthzValue = { t: 'c'; v: unknown } | { t: 'u' } | { t: 'e' };
const U: AuthzValue = { t: 'u' };
const E: AuthzValue = { t: 'e' };
const C = (v: unknown): AuthzValue => ({ t: 'c', v });

function asBool(v: unknown): boolean {
  return v === true ? true : v === false ? false : Boolean(v);
}
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}
/** Whether an expression tree reads only through `field` / `ref` rooted at PRINCIPAL / RESOURCE. */
function isSecurityRooted(expression: unknown): boolean {
  if (!isPlainObject(expression)) return false;
  if (expression.kind === 'ref') {
    const t = String(expression.targetId);
    return t === AUTHZ_PRINCIPAL_SCOPE || t === AUTHZ_RESOURCE_SCOPE;
  }
  if (expression.kind === 'field') return isSecurityRooted(expression.source);
  return false;
}

function evalAuthz(expression: unknown, scope: AuthorizationPolicyScope, seen: Set<object>): AuthzValue {
  if (!isPlainObject(expression) || seen.has(expression)) return E;
  seen.add(expression);
  switch (expression.kind) {
    case 'literal':
      return C(expression.value);
    case 'ref': {
      const t = String(expression.targetId);
      if (t === AUTHZ_PRINCIPAL_SCOPE) return C(scope.principal ?? null);
      if (t === AUTHZ_RESOURCE_SCOPE) return C(scope.resource ?? null);
      if (t === AUTHZ_OPERATION_SCOPE) return C(scope.operation);
      return E; // out of the closed scope — validation rejects it; be total
    }
    case 'field': {
      const src = evalAuthz(expression.source, scope, seen);
      if (src.t === 'e') return E;
      if (src.t === 'u') return U;
      const key = String(expression.fieldId);
      const rooted = isSecurityRooted(expression.source);
      const obj = src.v;
      if (obj === null || obj === undefined || typeof obj !== 'object') {
        return rooted ? U : C(null);
      }
      const present = Object.prototype.hasOwnProperty.call(obj, key) && (obj as Record<string, unknown>)[key] !== undefined;
      if (!present) return rooted ? U : C(null);
      return C((obj as Record<string, unknown>)[key]);
    }
    case 'unary': {
      const operand = evalAuthz(expression.operand, scope, seen);
      if (operand.t !== 'c') return operand; // NOT unknown ⇒ unknown; NOT error ⇒ error (§9, §12)
      return expression.operator === 'not' ? C(!asBool(operand.v)) : C(-Number(operand.v));
    }
    case 'binary': {
      const op = String(expression.operator);
      if (op === 'and') {
        const l = evalAuthz(expression.left, scope, seen);
        if (l.t === 'c' && !asBool(l.v)) return C(false); // FALSE AND _ ⇒ FALSE (short-circuit-independent)
        const r = evalAuthz(expression.right, scope, seen);
        if (l.t === 'e' || r.t === 'e') return E;
        if (r.t === 'c' && !asBool(r.v)) return C(false);
        if (l.t === 'c' && r.t === 'c') return C(true); // both concrete-true
        return U;
      }
      if (op === 'or') {
        const l = evalAuthz(expression.left, scope, seen);
        if (l.t === 'c' && asBool(l.v)) return C(true); // TRUE OR _ ⇒ TRUE
        const r = evalAuthz(expression.right, scope, seen);
        if (l.t === 'e' || r.t === 'e') return E;
        if (r.t === 'c' && asBool(r.v)) return C(true);
        if (l.t === 'c' && r.t === 'c') return C(false); // both concrete-false
        return U;
      }
      const l = evalAuthz(expression.left, scope, seen);
      const r = evalAuthz(expression.right, scope, seen);
      if (l.t === 'e' || r.t === 'e') return E;
      if (l.t === 'u' || r.t === 'u') return U; // any comparison touching absence ⇒ non-satisfied (§8)
      const a = l.v as never;
      const b = r.v as never;
      switch (op) {
        case 'eq':
          return C(deepEq(a, b));
        case 'neq':
          return C(!deepEq(a, b));
        case 'lt':
          return C((a as number) < (b as number));
        case 'lte':
          return C((a as number) <= (b as number));
        case 'gt':
          return C((a as number) > (b as number));
        case 'gte':
          return C((a as number) >= (b as number));
        case 'add':
          return C((a as number) + (b as number));
        case 'subtract':
          return C((a as number) - (b as number));
        case 'multiply':
          return C((a as number) * (b as number));
        case 'divide':
          return C((a as number) / (b as number));
        default:
          return E;
      }
    }
    case 'conditional': {
      const c = evalAuthz(expression.condition, scope, seen);
      if (c.t !== 'c') return c;
      return asBool(c.v) ? evalAuthz(expression.whenTrue, scope, seen) : evalAuthz(expression.whenFalse, scope, seen);
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of (expression.entries as Array<{ fieldId: unknown; value: unknown }>) ?? []) {
        const v = evalAuthz(entry.value, scope, seen);
        if (v.t === 'e') return E;
        if (v.t === 'u') return U;
        out[String(entry.fieldId)] = v.v;
      }
      return C(out);
    }
    case 'call': {
      const args: unknown[] = [];
      for (const argument of (expression.arguments as unknown[]) ?? []) {
        const v = evalAuthz(argument, scope, seen);
        if (v.t === 'e') return E;
        if (v.t === 'u') return U; // conservative: any absent input ⇒ non-satisfied (spec15pt2 §57, §85)
        args.push(v.v);
      }
      return applyPolicyBuiltin(String(expression.function), args);
    }
    default:
      return E;
  }
}

function applyPolicyBuiltin(fn: string, args: unknown[]): AuthzValue {
  switch (fn) {
    case 'required':
      return C(args[0] !== null && args[0] !== undefined);
    case 'is-empty':
      return C(args[0] === null || args[0] === undefined || args[0] === '' || (Array.isArray(args[0]) && args[0].length === 0));
    case 'non-empty':
      return C(!(args[0] === null || args[0] === undefined || args[0] === '' || (Array.isArray(args[0]) && args[0].length === 0)));
    case 'length':
      return C(Array.isArray(args[0]) || typeof args[0] === 'string' ? (args[0] as { length: number }).length : 0);
    case 'contains':
      return C(
        typeof args[0] === 'string'
          ? args[0].includes(String(args[1]))
          : Array.isArray(args[0])
            ? args[0].some((x) => deepEq(x, args[1]))
            : false,
      );
    case 'one-of':
      return C(args.slice(1).some((x) => deepEq(x, args[0])));
    case 'concat':
      return C(args.map((x) => (x === null || x === undefined ? '' : String(x))).join(''));
    case 'to-string':
      return C(args[0] === null || args[0] === undefined ? '' : String(args[0]));
    case 'lowercase':
      return C(String(args[0] ?? '').toLowerCase());
    case 'trim':
      return C(String(args[0] ?? '').trim());
    case 'substring-before': {
      const s = String(args[0] ?? '');
      const i = s.indexOf(String(args[1] ?? ''));
      return C(i < 0 ? '' : s.slice(0, i));
    }
    case 'substring-after': {
      const s = String(args[0] ?? '');
      const needle = String(args[1] ?? '');
      const i = s.indexOf(needle);
      return C(i < 0 ? '' : s.slice(i + needle.length));
    }
    case 'coalesce':
      return C(args.find((x) => x !== null && x !== undefined) ?? null);
    default:
      return E; // an unknown / non-deterministic builtin fails closed
  }
}

/**
 * spec15pt2 F1 — the **canonical** three-valued `AuthorizationPolicyDef.allow` evaluator,
 * used by every policy-bearing surface (spec15pt2 §33). Returns the `{ ok, value }` shape
 * `decideAuthorization` already consumes:
 *
 * - `allow` reduces to **exactly `true`** (with every required security input present) ⇒
 *   `{ ok: true, value: true }` — the only ALLOW;
 * - `allow` reduces to any other concrete value ⇒ `{ ok: true, value: false }`;
 * - the truth of `allow` depends on a **missing PRINCIPAL / RESOURCE field**
 *   (`AbsentSecurityValue`) ⇒ `{ ok: true, value: false }` — absence never creates authority
 *   through `eq` / `neq` / `not` / `or` (spec15pt2 §8-§12);
 * - an evaluation error (malformed node reaching the runtime, unsupported builtin) ⇒
 *   `{ ok: false }`.
 *
 * A constant `literal(true)` is `{ ok: true, value: true }` regardless of principal — an
 * explicitly public policy still admits an anonymous caller (spec15pt2 §13, §14).
 */
export function evaluateAuthorizationPolicyAllow(
  allow: unknown,
  scope: AuthorizationPolicyScope,
): AuthorizationCheckPart {
  let result: AuthzValue;
  try {
    result = evalAuthz(allow, scope, new Set());
  } catch {
    return { ok: false };
  }
  if (result.t === 'e') return { ok: false };
  if (result.t === 'u') return { ok: true, value: false };
  return { ok: true, value: result.v };
}

/**
 * The distinct policy ids a graph node references for authorization — for dependency
 * analysis and `validateGraph` reference resolution. Total over malformed input.
 */
export function nodeAuthorizationPolicyRefs(node: unknown): string[] {
  if (!isPlainObject(node)) return [];
  const out: string[] = [];
  for (const key of ['authorizationPolicy', 'startPolicy', 'instanceAccessPolicy'] as const) {
    const value = node[key];
    if (typeof value === 'string') out.push(value);
  }
  return out;
}
