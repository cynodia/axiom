# Axiom 0.15 — Implementation report

*Maintainer artifact. Not shipped in any npm tarball.*

Spec: `specs/spec15.md` — **Authorization Completeness**. Design note:
`reports/AXIOM_0_15_AUTHORIZATION_RESEARCH.md`. Full model: `docs/AUTHORIZATION.md`.

## Phase status

| Phase | Scope | State |
| --- | --- | --- |
| **A** | Public-API authorization inventory | ✅ landed |
| **B** | `AuthorizationPolicyDef` vocabulary, `validateGraph` totality, single semantic projection, `axiom.server.v9`, fail-closed admission | ✅ landed |
| **C** | One canonical `authorize()` evaluator; `ActionDef.authorizationPolicy` enforced on every `action.invoke` path; state / provider-record mutation authorized through the action boundary | ✅ landed |
| **D** | `QueryDef.authorizationPolicy` (`query.read`) enforced — one-shot query, `query` operation, live-query open; `ReadPolicyDef` composition (§18/§81/§82) confirmed | ✅ landed |
| **E** | `WorkflowDef.startPolicy` (`workflow.start`) + `instanceAccessPolicy` (`workflow.cancel` / `.inspect` / `.history`); owner-fingerprint baseline preserved; existence-leak-free inspection | ✅ landed |
| **F** | live-query re-authorization on every re-evaluation (revoked caller ⇒ stream error), row-level revocation / gain via re-resolved caller, `resumeLiveQuery` re-auth + cross-principal cursor refusal; `subscription.open` documented as an infra trust boundary | ✅ landed |
| **G** | `AgentAPI.analyzeAuthorization()` — coverage audit, per-policy dependency analysis, secret-free rule summaries, `unprotected` surface list, workflow `privilegeReviewActions`; `authorizationPolicyDependencies` in core | ✅ landed |
| **H** | `axiom.conformance.v9` — `conformance/authorization/` (10 fixtures), `runAuthorizationConformanceFixture` / `Suite`, verified over memory + SQLite | ✅ landed |
| **I** | The internal adversarial matrix (forbidden counters), topology-independence 1/2/8 authorities on shared SQLite, cross-principal race + contention, failover parity | ✅ landed |

**All nine phases are landed** at `0.15.0-alpha.1`. External blind adversarial validation
(spec15 §134-§137) precedes the 0.15 semantic freeze and is not part of this checkout.

**Version bumped to `0.15.0-alpha.1`.** Enforcement Phases C–F are landed — every
`AuthorizationPolicyDef` reference the graph vocabulary defines is enforced — so the
milestone's first pre-release is cut. G–I (analysis, conformance tier, adversarial soak)
harden it before the milestone freezes; they add no graph/IR vocabulary.

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

### Admission gate — `packages/server/src/server.ts` (Phase B → narrowed in C)

- `SERVER_DIAGNOSTIC_CODES.AUTHORIZATION_ENFORCEMENT_UNAVAILABLE`.
- Phase B threw it for *any* authorization vocabulary. Phase C narrows the check to
  `usesUnenforcedAuthorizationVocabulary(ir)` (new core helper) — true only for
  `QueryDef.authorizationPolicy` (D) or `WorkflowDef.startPolicy` / `instanceAccessPolicy`
  (E). An IR that carries only `ActionDef.authorizationPolicy` now admits and is enforced.
- `understatedContract` candidates keep the v9 derivation so a hand-labelled IR is refused.

## Phase C — enforcement

### The evaluator

- `decideAuthorization(input)` (`packages/core/src/authorization.ts`) — the pure ALLOW/DENY
  combiner, a function of *already evaluated* boolean outcomes so it is identical on every
  surface and independently checkable (spec15 §8, §96, §123). Rules: no parts ⇒ ALLOW;
  a policy `allow` that is not exactly `true` ⇒ DENY (`policy-denied`); a policy that failed
  to evaluate ⇒ DENY (`policy-error`); the legacy `authorization` expression keeps its
  historical truthiness (non-empty array / truthy ⇒ allow) and denies as `legacy-denied` /
  `legacy-error`; a present policy **and** a present legacy expression are conjoined.
- Reserved scope ids (`packages/core/src/authority.ts`): `PRINCIPAL` (`'axiom_principal'` —
  unchanged, the same id `ActionDef.authorization` uses), new `RESOURCE` (`'axiom_resource'`)
  and `OPERATION` (`'axiom_operation'`). `AUTHORIZATION_SCOPE_IDS` in
  `core/authorization.ts` now points at these (Phase B briefly used the bare strings
  `'PRINCIPAL'` etc.; no released build shipped that).

### Wiring — `packages/server/src/server.ts`

- `authorize(action, context)` (already the one place action authorization was decided) now:
  resolves `action.authorizationPolicy` against an `ir.authorizationPolicies` map built from
  this authority's own IR; hydrates the closed policy scope for the invocation
  (`OPERATION = 'action.invoke'`, `RESOURCE = { id, kind: 'action' }`; `PRINCIPAL` is already
  hydrated by `invokeCore`); evaluates the policy `allow` and the legacy expression through
  the one `runtime.evaluate`; feeds both to `decideAuthorization`; on DENY emits a structured
  `AUTHORIZATION_DENIED` carrying `operation` + `reason` (both added to
  `DISCLOSABLE_DETAIL_KEYS` — neither is a secret).
- Because every invocation path — direct `handle({kind:'invoke'})`, the workflow engine's
  `invokeAction`, scheduler / trigger / event-invoked actions, retries and failover
  reconciliation — funnels through `invokeCore` → `authorize`, they all get the identical
  contract with no second evaluator (spec15 §10, §96). A dangling policy ref (impossible for
  a `validateGraph`-checked graph, possible in a hand-tampered IR) fails closed.
- Synthetic runtime IR (`createRuntime`): two ephemeral, never-observable states `OPERATION`
  and `RESOURCE` alongside the existing `PRINCIPAL`, so `ref(OPERATION)` / `ref(RESOURCE)`
  resolve through the ordinary scope rules. Declared `valueType` is nominal — the runtime
  never type-checks a hydrated scope value.

### Properties this establishes

- **Privilege amplification (§101, release blocker):** a principal who may *start* a
  workflow gains no standing authority — each `action` step is authorized afresh under the
  workflow's durable start principal, and a step it may not invoke directly is denied.
- **Confused deputy (§102):** a `'system'`-sourced invocation is still authorized under the
  effective principal; `source: 'system'` is a trust-boundary fact, not privilege.
- **Denial is terminal (§109):** `AUTHORIZATION_DENIED` is not in the workflow retryable
  set, so a denied step fails (or takes `onError`) without consuming retry attempts.
- **Re-evaluation against current policy (§11):** the policy is read from the IR and
  evaluated on every invocation, not snapshotted at workflow start.

## Tests

| File | Tests | Covers |
| --- | --- | --- |
| `packages/core/test/authorization.test.ts` | 9 | closed enums = `[PRINCIPAL, RESOURCE, OPERATION]`; `decideAuthorization` fail-closed + conjunctive + legacy truthiness; valid owner policy validates; `AUTHORIZATION_INVALID_SCOPE` / `_NONDETERMINISTIC` / `_INVALID_POLICY` / 3× `_UNKNOWN_POLICY`; `authorizationPolicyProblems` total over 9 malformed inputs |
| `packages/core/test/semantic-identity.test.ts` | +4 | policy ALLOW→DENY moves `semanticFingerprint`; `name`/`description` does not; no-authz graph unchanged; re-pointing `action.authorizationPolicy` moves it |
| `packages/server/test/authorization-identity.test.ts` | 7 | slice guard covers `authorization-policy`; authz graph ⇒ v9; empty projection has no `authorizationPolicies` key; ALLOW→DENY flips the compat key; presentation-only stays compatible; an action-policy graph admits, an unenforced query-policy IR still fails closed; JSON round-trip |
| `packages/server/test/authorization-enforcement.test.ts` | 8 | no-policy ⇒ anonymous allowed; role policy allow/deny/anonymous-deny (§73.A); `OPERATION` scope resolves; policy ∧ legacy conjunction with `reason: policy-denied`; a policy that throws ⇒ DENY `reason: policy-error`, zero mutation (§123); workflow privilege amplification denied + not retried (§101, §109); the same step succeeds for an authorized principal |

Doc/contract drift tests still green. No new diagnostic code, no schema change (the
evaluator and scope are runtime, not IR vocabulary).

## Phase D — query authorization

### Wiring — `packages/server/src/server.ts`

- `evaluatePolicy(policyId, operation, resource)` extracted from `authorize()` — the shared
  primitive: hydrate `OPERATION` / `RESOURCE`, resolve the policy from the authority's own
  IR, evaluate `allow`, return the `{ ok, value }` part for `decideAuthorization`. Fail
  closed on a dangling id.
- `authorizeQueryRead(query, principal)` — `query.read` (`RESOURCE = { id: queryId, kind:
  'query' }`), the same evaluator, no legacy expression. Wired into **all three** query
  paths, each *before* the provider / result cache is touched:
  - `runQuery` (protocol one-shot) — returns an `AUTHORIZATION_DENIED` `query-result`;
  - `liveQueryContext` (`openLiveQuery` / `resumeLiveQuery`) — returns `{ ok: false, code:
    AUTHORIZATION_DENIED }`, so the subscription is never created;
  - `executeQueryForOperation` (a `query` operation inside an action) — returns `{ ok: false,
    code: AUTHORIZATION_DENIED }`, which the runtime surfaces as `QUERY_OPERATION_FAILED`
    (`details.code = AUTHORIZATION_DENIED`) and the action transaction rolls back.
- `DISCLOSABLE_DETAIL_KEYS` gains `queryId`.
- Admission gate narrowed again: `usesUnenforcedAuthorizationVocabulary` drops the query
  check — an IR with `QueryDef.authorizationPolicy` now admits; only
  `WorkflowDef.startPolicy` / `instanceAccessPolicy` still fail closed.

### Row-level authorization — no code change, confirmed by test

`ReadPolicyDef` remains the row-level read mechanism (spec10). Its predicate is already
`AND`-ed into the effective filter (`effectiveFilter` in `query-runtime.ts`) and pushed to
the provider *before* `filter` / `sort` / `limit` / `aggregate`, so:

- **§18 / §81** — `limit N` is `N` rows over the *authorized* dataset, not a global limit
  then a filter (the provider never sees the unauthorized rows).
- **§82** — an aggregate sums only the authorized rows.
- **§125 / §128** — if a provider cannot execute the policy predicate it is
  `QUERY_CAPABILITY_UNSUPPORTED`, never an approximated / skipped check.

"Unified with `ReadPolicyDef`" (spec15 §17) means: `query.read` is the whole-query gate,
`ReadPolicyDef` is the row filter, both are authorization, both evaluated on the authority,
and one-shot / live-open decide identically.

## Phase E — workflow instance access

### Wiring

- `packages/server/src/workflows.ts` — `WorkflowEngineOptions.authorizePolicy(policyId,
  operation, resource, principal)` is the injected policy evaluator (the server implements it
  with `evaluatePolicy` + `decideAuthorization`, so the *same* single evaluator decides
  every surface). The engine owns the defaults:
  - `startWorkflow` — if `workflow.startPolicy` is set, evaluate `workflow.start` (`RESOURCE
    = { id: workflowId, kind: 'workflow' }`); a denial returns `AUTHORIZATION_DENIED` and
    **no instance is created** — separate from the ActionDef auth a later step faces
    (§100, §101).
  - `cancelWorkflow` — `authorizeInstanceMutation`: a declared `instanceAccessPolicy`
    decides `workflow.cancel` (`RESOURCE` = a non-secret instance projection `{ id, kind:
    'workflow-instance', workflowId, status, ownerFingerprint }`); with none, the
    spec14pt6 owner-fingerprint comparison (`reason: 'owner-mismatch'` on failure). A role
    never bypasses the owner default implicitly (§14). Terminal instances stay idempotent
    for any caller, before the auth check (§110).
  - `getWorkflow` / `listWorkflows` / `workflowHistory` — new optional `credential`;
    `mayInspectInstance` gates them **only** when `instanceAccessPolicy` is declared, and an
    unauthorized caller is answered exactly like a missing instance (`undefined` / filtered
    out / `[]`) — no existence leak (§15, §39). With no policy they are operator-inspection
    APIs, an explicit trust boundary (not reachable through the protocol, §112-§113), and
    their 0.14 open behaviour is unchanged.
- `packages/server/src/server.ts` — `authorizePolicy` wired into `createWorkflowEngine`;
  `getWorkflow` / `inspectWorkflows` / `workflowHistory` gain an optional `credential`
  threaded to the engine.
- `usesUnenforcedAuthorizationVocabulary` now returns `false` for every IR — every
  graph-defined `AuthorizationPolicyDef` reference is enforced. The `createAxiomServer`
  admission gate + `AUTHORIZATION_ENFORCEMENT_UNAVAILABLE` are kept as the dormant
  fail-closed extension point.

## Phase F — live-query authorization over time

### Wiring

- `packages/server/src/server.ts` — the live `reevaluate` closure (`liveQueryContext`) now,
  on **every** re-evaluation: re-resolves the caller from the retained credential
  (`host.authenticate`), re-checks `authorizeQueryRead` (`query.read`), and uses the
  *current* principal for `buildProviderQuery`. A denial throws an `Error` carrying
  `.code = 'AUTHORIZATION_DENIED'`.
- `packages/server/src/live-query.ts` — the engine's re-evaluation `catch` propagates
  `(error as { code }).code ?? 'LIVE_QUERY_EVALUATION_FAILED'`, so a revoked caller yields
  `{ kind: 'error', code: 'AUTHORIZATION_DENIED' }` and the subscription serves no more
  data (spec15 §19 "delta removal / reset / authorization error / close").
- `openLiveQuery` / `resumeLiveQuery` wrap the initial `reevaluate()` and return the same
  `{ error: { code, message } }` shape on a throw (so an at-open re-resolve failure is a
  clean refusal, not an unhandled rejection).
- `resumeLiveQuery` already routed through `liveQueryContext` (Phase D) → re-resolves +
  re-authorizes; the spec13 HMAC cursor is bound to the open-time `principalFingerprint`, so
  another principal's cursor mismatches (`LIVE_QUERY_CURSOR_INVALID`) and an unauthorized
  principal is refused `AUTHORIZATION_DENIED` before the match check (§20).
- **Row-level revocation / gain (§79 / §80)** — no code change: the `ReadPolicyDef`
  predicate is already `AND`-ed into the effective filter and its field dependencies are in
  `queryDependencies`, so a commit that changes a policy-referenced field (or, now, a
  caller-claim change picked up by the re-resolve) re-evaluates the query and the
  now-unauthorized row leaves as an ordinary `remove` delta; the reverse is an `insert`.
- **`subscription.open`** — `SubscriptionDef` (spec9) is a world→Axiom inbound stream
  connected by an adapter, not a principal-facing subscribe; it has no policy field. Its
  trust boundary is the adapter contract (spec15 §24, §59), documented in
  `docs/AUTHORIZATION.md`. No vocabulary added.

## Tests

| File | Tests | Covers |
| --- | --- | --- |
| `packages/core/test/authorization.test.ts` | 9 | closed enums = `[PRINCIPAL, RESOURCE, OPERATION]`; `decideAuthorization` fail-closed + conjunctive + legacy truthiness; valid owner policy validates; `AUTHORIZATION_INVALID_SCOPE` / `_NONDETERMINISTIC` / `_INVALID_POLICY` / 3× `_UNKNOWN_POLICY`; totality over 9 malformed inputs |
| `packages/core/test/semantic-identity.test.ts` | +4 | policy ALLOW→DENY moves `semanticFingerprint`; `name`/`description` does not; no-authz graph unchanged; re-pointing `action.authorizationPolicy` moves it |
| `packages/server/test/authorization-identity.test.ts` | 7 | slice guard; authz graph ⇒ v9; empty projection has no `authorizationPolicies` key; ALLOW→DENY flips the compat key; presentation-only stays compatible; action / query / workflow policy graphs all admit; `usesUnenforcedAuthorizationVocabulary` is `false`; JSON round-trip |
| `packages/server/test/authorization-enforcement.test.ts` | 8 | action `authorize()` — no-policy allow; role allow/deny/anon-deny (§73.A); `OPERATION` scope; policy ∧ legacy; policy throws ⇒ DENY zero mutation (§123); workflow privilege amplification + not retried (§101, §109); authorized step succeeds |
| `packages/server/test/authorization-query.test.ts` | 7 | `query.read` allow/deny/anon-deny (§16); policy throws ⇒ DENY (§123); no-policy unchanged; `ReadPolicy` before sort/limit (§18/§81); aggregate excludes unauthorized (§82); `query` operation gated + rollback (§54); `openLiveQuery` refused at open (§16) |
| `packages/server/test/authorization-workflow-access.test.ts` | 8 | `workflow.start` allow/deny/anon, no instance on deny (§100); no-policy cancel keeps owner-fingerprint (§13); no-policy inspection stays open (§112-§113); declared policy decides cancel, no implicit owner bypass (§14); declared policy gates inspection, unauthorized ⇒ not-found-equivalent + list filtered (§15, §39); terminal cancel idempotent for any caller (§110); failover parity (§75) |
| `packages/server/test/authorization-live-query.test.ts` | 6 | `openLiveQuery` enforces `query.read` (§16); revoking the caller mid-subscription ⇒ `{ kind:'error', code:'AUTHORIZATION_DENIED' }` (§19, §59); row leaves authorized set ⇒ `remove` delta, one-shot agrees (§79); row enters ⇒ `insert` delta (§80); a resume cursor does not carry another principal's access (§20); a revoked principal cannot resume its own cursor (§20, §59) |
| `packages/agent-api/test/authorization.test.ts` | 6 | `authorizationPolicyDependencies` — scope reads, constants, totality (§35); `analyzeAuthorization` classifies every surface's protection (§42, §43); `unprotected` list is exactly the public surfaces, workflow instance ops excluded (§43); secret-free `summary` renderings (§44, §83); workflow `privilegeReviewActions` (§101); on `AgentAPI`, total over a no-vocabulary graph |
| `packages/server/test/authorization-conformance.test.ts` | 13 | every `axiom.conformance.v9` fixture through `runAuthorizationConformanceFixture` (memory); category coverage vs spec15 §71; every fixture re-run over SQLite persistence with identical decisions (§114/§115); `runAuthorizationConformanceSuite` fold |
| `packages/server/test/authorization-adversarial.test.ts` | 1 (13 forbidden counters) | every public surface × {owner, different, anonymous, role-equivalent, admin-like, malformed credential}; direct vs live, one-shot vs live, direct vs workflow, open vs resume, idempotency reuse; `unauthorized_*` / `cross_principal_*` / `revoked_*` / `policy_fail_open` / `native_authorization_exception` all **0** (§74, §88, §136, §137) |
| `packages/server/test/authorization-distributed.test.ts` | 3 | same decision on 1/2/8 authorities over shared SQLite state (§75); cross-principal race + contention — no unauthorized commit, only structured `AUTHORIZATION_DENIED` / `CONCURRENCY_CONFLICT`, zero raw SQLite errors (§77, §116); denied-operation parity after failover (§76). `AXIOM_AUTHZ_TRIALS` (3 fast / 25 soak) |

## Phase G — static authorization analysis

- `packages/core/src/authorization.ts` — `authorizationPolicyDependencies(policy)`: total,
  secret-free — the `PRINCIPAL` / `RESOURCE` field ids the `allow` expression reads,
  whether it reads `OPERATION`, and a `constant` verdict for a literal `allow`.
- `packages/agent-api/src/authorization.ts` — `analyzeAuthorization(graph)` →
  `AuthorizationAnalysis`: `policies[]` (dependencies + a best-effort secret-free one-line
  `summary` + `AUTHORIZATION_*` problems), `operations[]` (every `action.invoke` /
  `query.read` / `workflow.*` surface with a `protection` discriminant and an `unresolved`
  flag), `unprotected[]` (surfaces with no explicit boundary — a `public` action / query,
  a workflow with no `startPolicy`; a workflow instance op with no `instanceAccessPolicy`
  is *not* listed, owner-fingerprint being a defined default), `workflows[]`
  (`start` / `instanceAccess` mode, `actionDependencies` with each action's own protection,
  `privilegeReviewActions`), `usesAuthorizationVocabulary`. Static, never claims
  authorization it cannot prove (spec15 §50), exposes no runtime secret (spec15 §83).
- `AgentAPI.analyzeAuthorization()` + `index.ts` export. agent-api still depends on `core`
  only.

## Phase I — adversarial / distributed / failover

- `packages/server/test/authorization-adversarial.test.ts` — one in-process `AxiomServer`,
  the full §74/§136 matrix over every surface, measuring the §137 forbidden counters. All
  zero: no unauthorized action / state / provider mutation, no unauthorized record
  observation (incl. tenant isolation and one-shot↔live symmetry), no unauthorized workflow
  start / inspection / cancellation, no cross-principal cursor resume, no cross-principal
  idempotency reuse (`recordKey` is principal-scoped — §120), no revoked-live-data
  continuation, no revoked-workflow-privilege continuation (§101), no policy fail-open (a
  throwing policy DENIES), no native exception from the authorization path.
- `packages/server/test/authorization-distributed.test.ts` — shared SQLite state store:
  the same authorized/denied decision on 1, 2 and 8 authorities (§75, no topology
  dependence); a `Promise.all` race of an authorized and an unauthorized invoke across two
  authorities never commits the unauthorized one and surfaces only structured codes
  (`AUTHORIZATION_DENIED` / `CONCURRENCY_CONFLICT`), zero raw SQLite errors (§77, §116);
  a workflow whose step is denied under its start principal fails identically after the
  starting authority dies and another resumes it (§76). `AXIOM_AUTHZ_TRIALS`.
- **Audit findings (already correct, now pinned by test):** action idempotency
  (`recordKey`) is scoped by resolved principal identity (§120); `WorkflowStartIdentity`
  includes `principalFingerprint` so `P1+K` and `P2+K` are distinct (§119).

## Phase H — portable conformance tier

- `packages/server/src/authorization-conformance.ts` — `AuthorizationConformanceFixture`
  (`conformance: 'axiom.conformance.v9'`), `runAuthorizationConformanceFixture(fixture,
  { persistence? })`, `runAuthorizationConformanceSuite`. A fixture carries a compiled
  Server IR, the principal records each credential resolves to, `providerRows`, and a
  driver script of `invoke` / `query` / `start-workflow` / `cancel-workflow` /
  `inspect-workflow` / `open-live-query` / `resume-live-query` steps — each with the
  fixture author's independently-computed `expect` (ALLOW/DENY + reason; for a query the
  exact `rowIds`). The runner uses a real `createAxiomServer`; `expectFinalState` proves a
  denied step mutated nothing (§115). Exported from `packages/server/src/index.ts`.
- `scripts/authorization-conformance.mjs` — the generator (one graph → 10 fixtures),
  appended to `conformance:generate`.
- `packages/server/conformance/authorization/` — 10 fixtures + `manifest.json`
  (`axiom.conformance.v9`), covering the spec15 §71 categories.
- `packages/server/test/authorization-conformance.test.ts` — runs every fixture over memory
  **and** SQLite persistence, asserting identical decisions (§114/§115).

## Scope boundary

- **Internal** gates A–I are complete. **External blind adversarial validation**
  (spec15 §134-§137) — a tester working from the published npm packages, docs, `.d.ts`,
  AgentAPI, conformance fixtures, a fresh consumer, real OS processes and SQLite, with no
  repository access — precedes the 0.15 semantic freeze and is a separate milestone
  activity, not part of this checkout.
- The internal Phase I suite runs authorities **in one process** over shared SQLite. A
  forked-process SIGKILL boundary specific to the authorization path (§117) is not added
  separately: `workflow-crash-matrix.test.ts` already SIGKILLs forked authorities, and
  every workflow action step now flows through `authorize()`, so authorization-under-crash
  is exercised there transitively.
