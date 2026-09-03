# Axiom 0.15 — Implementation report

*Maintainer artifact. Not shipped in any npm tarball.*

Spec: `specs/spec15.md` — **Authorization Completeness**. Design note:
`reports/AXIOM_0_15_AUTHORIZATION_RESEARCH.md`. Full model: `docs/AUTHORIZATION.md`.

## Phase status

| Phase | Scope | State |
| --- | --- | --- |
| **A** | Public-API authorization inventory | ✅ landed |
| **B** | `AuthorizationPolicyDef` vocabulary, `validateGraph` totality, single semantic projection, `axiom.server.v9`, fail-closed admission | ✅ landed |
| C | One canonical evaluator; `action.invoke` / `record.*` / `state.*` enforcement | ⏳ |
| D | `query.read` + row-level unification with `ReadPolicyDef` | ⏳ |
| E | `workflow.start` / `workflow.inspect` / `workflow.history` / `workflow.cancel` | ⏳ |
| F | `live.open` / `live.resume` / `subscription.open`, revocation propagation, `AUTHORIZATION_DENIED` | ⏳ |
| G | `AgentAPI.analyzeAuthorization` + coverage audit | ⏳ |
| H | `axiom.conformance.v9` | ⏳ |
| I | Real-process / mixed-build / adversarial validation | ⏳ |

**No package version bump.** The tree stays `0.14.0-alpha.5`. `0.15.0-alpha.1` is cut when
enforcement (Phases C–F) lands — a validated-and-fingerprinted-but-unenforced vocabulary is
not a release.

## What landed

### New core vocabulary — `packages/core/src/authorization.ts`

- `AuthorizationPolicyDef` — graph node kind `authorization-policy`, one field: `allow: Expression`.
- Scope constants `AUTHZ_PRINCIPAL_SCOPE` / `AUTHZ_RESOURCE_SCOPE` / `AUTHZ_OPERATION_SCOPE`
  and `AUTHORIZATION_SCOPE_IDS`.
- `AUTHORIZATION_OPERATIONS` (closed) + `AuthorizationOperation` type.
- `AUTHORIZATION_NONDETERMINISTIC_BUILTINS` = `{ now, uuid, random }`.
- `AUTHORIZATION_DEFAULT` — the canonical default map (`PUBLIC_SURFACE` /
  `KEEP_PRIOR_RESTRICTION` / `FAIL_CLOSED`).
- `authorizationPolicyExpressions(policy: unknown): Expression[]` — total; returns the
  `allow` expression when the policy is a plain object with a plain-object `allow`, else `[]`.
- `authorizationPolicyProblems(policy: unknown): AuthorizationPolicyProblem[]` — total.
  Non-object ⇒ `AUTHORIZATION_INVALID_POLICY`. No plain-object `allow` ⇒
  `AUTHORIZATION_INVALID_POLICY`. Walks `allow`: a `ref` to an id not in
  `AUTHORIZATION_SCOPE_IDS` ⇒ `AUTHORIZATION_INVALID_SCOPE`; a `call` to `now`/`uuid`/
  `random` ⇒ `AUTHORIZATION_NONDETERMINISTIC`. Cycle-safe (`seen` set), does not recurse
  into `literal` nodes.
- `nodeAuthorizationPolicyRefs(node: unknown): string[]` — the string values of
  `authorizationPolicy` / `startPolicy` / `instanceAccessPolicy`.

Exported from `packages/core/src/index.ts` (`export * from './authorization.js'`).

### Wiring into existing types

- `packages/core/src/types.ts` — `'authorization-policy'` added to `SemanticNodeKind`,
  `SEMANTIC_NODE_KINDS`, and `AnyNode`.
- `packages/core/src/nodes.ts` — `ActionDef.authorizationPolicy?: NodeId` (governs
  `action.invoke`; conjunction with the legacy `authorization` expression when both present).
- `packages/core/src/query.ts` — `QueryDef.authorizationPolicy?: NodeId` (governs
  `query.read`; distinct from `readPolicyId`, which filters rows).
- `packages/core/src/workflows.ts` — `WorkflowDef.startPolicy?: NodeId` (governs
  `workflow.start`) and `instanceAccessPolicy?: NodeId` (governs inspect / history /
  cancel; absent ⇒ the 0.14 owner-fingerprint rule).

### Validation — `packages/core/src/validate.ts`

- `validateAuthorizationPolicyNode` — emits every `authorizationPolicyProblems` finding
  against the node id.
- `requireAuthorizationPolicy(id, ownerId, context)` — a non-null policy ref that does not
  resolve to an `authorization-policy` node ⇒ `AUTHORIZATION_UNKNOWN_POLICY`. Wired into
  `validateAction` (`action.authorizationPolicy`), `validateQuery`
  (`query.authorizationPolicy`) and `validateWorkflow` (`startPolicy` +
  `instanceAccessPolicy`).
- `packages/core/src/diagnostics.ts` — `VALIDATION_CODES` gains
  `AUTHORIZATION_INVALID_POLICY`, `AUTHORIZATION_INVALID_SCOPE`,
  `AUTHORIZATION_UNKNOWN_POLICY`, `AUTHORIZATION_NONDETERMINISTIC` (125 codes total).

### Semantic identity — the single projection

- `packages/core/src/semantic-identity.ts` — `'authorization-policy'` joins
  `EXECUTABLE_KINDS` (after `'workflow'`).
- `packages/server/src/authority-identity.ts` — `SERVER_IR_EXECUTABLE_SLICES` gains
  `'authorization-policy': { field: 'authorizationPolicies', shape: 'list', since: 'v9' }`;
  the empty-slice guard generalized from `slice.since === 'v8'` to `slice.since !== undefined`.
- Result: an `allow` ALLOW→DENY edit, or re-pointing `action.authorizationPolicy`, moves
  `semanticFingerprint(graph)` **and** the enforced
  `AuthorityCompatibilityKey.semanticFingerprint`. A `name` / `description` edit does not.
  A graph with no authorization vocabulary is byte-identical to its prior v1–v8 document.

### Server IR contract — `axiom.server.v9`

- `packages/core/src/server-ir.ts` — `SERVER_IR_CONTRACTS` gains `'axiom.server.v9'`;
  `SERVER_IR_LATEST_CONTRACT = 'axiom.server.v9'`. `usesAuthorizationVocabulary(ir)` — true
  if any policy node **or** any `authorizationPolicy` / `startPolicy` / `instanceAccessPolicy`
  is set; total over a tampered IR. `ServerIR.authorizationPolicies?: AuthorizationPolicyDef[]`.
  `serverIRExpressions` collects policy `allow` expressions.
- `packages/compiler/src/server.ts` — collects `authorization-policy` nodes (authoring
  metadata stripped), emits `authorizationPolicies` only when non-empty, contract candidate
  `usesAuthorizationVocabulary(document) ? 'axiom.server.v9' : 'axiom.server.v1'`.
- `packages/server/schema/server-ir.v9.schema.json` — generated by `npm run schema:generate`.
  v1–v8 schemas byte-unchanged.

### Fail closed — `packages/server/src/server.ts`

- `SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_ENFORCEMENT_UNAVAILABLE`.
- `createAxiomServer` throws it (structured `Error`, not a native exception) when
  `usesAuthorizationVocabulary(options.ir)` — this build validates and fingerprints
  authorization vocabulary but does not yet enforce it, and refusing is the only
  spec4-§4-compliant option. Removed when Phase C wires the evaluator.
- `understatedContract` candidates gain the v9 derivation so a hand-labelled IR is refused.

## Tests

| File | Tests | Covers |
| --- | --- | --- |
| `packages/core/test/authorization.test.ts` | 7 | closed enums; a valid owner policy validates; out-of-scope `ref` ⇒ `AUTHORIZATION_INVALID_SCOPE`; `now`/`uuid`/`random` ⇒ `AUTHORIZATION_NONDETERMINISTIC`; missing `allow` ⇒ `AUTHORIZATION_INVALID_POLICY`; 3 dangling refs ⇒ 3× `AUTHORIZATION_UNKNOWN_POLICY`; `authorizationPolicyProblems` total over 9 malformed inputs |
| `packages/core/test/semantic-identity.test.ts` | +4 | policy ALLOW→DENY moves `semanticFingerprint`; `name`/`description` does not; no-authz graph unchanged; re-pointing `action.authorizationPolicy` moves it |
| `packages/server/test/authorization-identity.test.ts` | 7 | `EXECUTABLE_KINDS` ↔ slice guard covers `authorization-policy`; authz graph ⇒ `axiom.server.v9`; non-authz projection has no `authorizationPolicies` key; ALLOW→DENY flips `serverIrCompatibilityKey` with a `semanticFingerprint` mismatch; presentation-only stays compatible; `createAxiomServer` fails closed with `/AUTHORIZATION_ENFORCEMENT_UNAVAILABLE/` (structured, not native) and a non-authz graph still starts; policy round-trips through `JSON.parse(JSON.stringify(ir))` |

Doc/contract drift tests updated: `docs/VALIDATION.md` (125 codes, new "Authorization
(0.15)" table), `docs/AUTHORITY.md` (`axiom.server.v9` row,
`AUTHORIZATION_ENFORCEMENT_UNAVAILABLE` row), `docs/AGENT_REFERENCE.md` (new AUTHORIZATION
section), `README.md` + `packages/axiom/README.md` doc maps (new `docs/AUTHORIZATION.md`
row).

## Not done (deferred to later phases, documented as such)

- No evaluator, no enforcement, no runtime `AUTHORIZATION_DENIED` yet.
- No `AgentAPI.analyzeAuthorization`.
- No `axiom.conformance.v9` fixture tier.
- Legacy `ActionDef.authorization` and `ReadPolicyDef` are unchanged; their unification
  through the single evaluator is Phases C–D.
- No version bump.
