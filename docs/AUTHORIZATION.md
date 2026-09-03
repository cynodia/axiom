# Authorization

Axiom 0.15.0-alpha.2. The operational contract for **authorization completeness** — the 0.15
milestone (spec15). Whether a principal may perform a semantic operation is part of the
graph's executable meaning — not a runtime concern, not UI visibility, not something that
varies by transport, provider, process, retry path or authority topology. `axiom.server.v9`
when a graph carries authorization vocabulary; a graph with none is byte-identical to its
prior contract.

> **Authentication** answers *who is this?* — credential adapters and transports do that,
> outside portable application semantics. **Authorization** answers *may this principal
> perform this semantic operation?* — that is what this document defines.

0.15 landed in nine phases (A–I); `0.15.0-alpha.2` (spec15pt2) is a corrective pass —
authorization **absent-value safety** (a missing PRINCIPAL / RESOURCE field never grants
authority), `validateGraph` totality over a malformed `allow` tree, and a fail-closed
`host.authenticate` exception boundary. This document describes the **model** (stable) and
marks which phase delivered each surface. External adversarial validation precedes the
semantic freeze (spec15 §134).

| Phase | Delivers | State |
| --- | --- | --- |
| A | Public-API authorization inventory (below) | ✅ landed |
| B | `AuthorizationPolicyDef` vocabulary, `validateGraph` totality, single semantic projection, `axiom.server.v9` | ✅ landed |
| **C** | One canonical `authorize()` evaluator; `ActionDef.authorizationPolicy` enforced on every `action.invoke` path (direct / workflow step / scheduler / event / retry / failover), conjoined with legacy `ActionDef.authorization`; state & provider-record mutation authorized through the action boundary | ✅ **enforced** |
| **D** | `QueryDef.authorizationPolicy` (`query.read`) enforced identically for a one-shot query, a `query` operation inside an action, and a live-query open — before any provider call. Row-level filtering stays `ReadPolicyDef`, AND-ed into the effective filter so `filter` / `sort` / `limit` / aggregation see only the authorized dataset | ✅ **enforced** |
| **E** | `WorkflowDef.startPolicy` decides `workflow.start` (discovering a workflow ≠ starting it). `instanceAccessPolicy` decides `workflow.cancel` / `.inspect` / `.history` when declared; with none, cancel keeps the 0.14 owner-fingerprint baseline and inspection stays an operator trust boundary. Unauthorized inspection is answered like a missing instance; terminal cancellation stays idempotent for any caller | ✅ **enforced** |
| **F** | A live query re-checks `query.read` against the **re-resolved** caller on every re-evaluation, so a revoked principal stops the stream (`{ kind: 'error', code: 'AUTHORIZATION_DENIED' }`). The current caller drives row filtering, so a claim / row change that removes access is a `remove` delta and the reverse an `insert`. `resumeLiveQuery` re-resolves + re-authorizes and refuses a cursor issued for a different principal. `subscription.open` (`SubscriptionDef`) is an infrastructure trust boundary — no graph policy, the adapter contract is the boundary | ✅ **enforced** |
| **G** | `AgentAPI.analyzeAuthorization()` — a graph-level coverage audit: what protects every action / query / workflow surface, what each policy depends on (`PRINCIPAL` / `RESOURCE` fields, `OPERATION`, a secret-free rule summary), which surfaces have **no** explicit boundary, and which workflow action steps run a policy the start principal is not statically proven to hold. `authorizationPolicyDependencies` in core | ✅ **landed** |
| **H** | `axiom.conformance.v9` — the portable authorization fixture tier (`conformance/authorization/`), `runAuthorizationConformanceFixture` / `Suite`; decisions verified over both memory and SQLite persistence | ✅ **landed** |
| **I** | The internal adversarial matrix (§74/§88/§136/§137 — every public surface × {owner, different, anonymous, role-equivalent, admin-like, malformed}, forbidden counters at zero), topology-independence over 1/2/8 authorities on shared SQLite, cross-principal race + contention (no unauthorized win, no raw SQLite error), and failover parity | ✅ **landed** |

Every `AuthorizationPolicyDef` reference the graph vocabulary defines is enforced across
`ActionDef` / `QueryDef` / `WorkflowDef` and every live-query re-evaluation.
`createAxiomServer` still **fails closed** (`AUTHORIZATION_ENFORCEMENT_UNAVAILABLE`) via
`usesUnenforcedAuthorizationVocabulary` — kept as the dormant extension point for any later
phase that introduces authorization vocabulary ahead of its enforcement (spec4 §4,
spec15 §128).

---

## The model

There is **one** authorization language. An `AuthorizationPolicyDef` is a graph node with a
single boolean `allow` expression:

```ts
import { OPERATION, PRINCIPAL, RESOURCE } from '@cynodia/axiom-core';

graph.addNode<AuthorizationPolicyDef>({
  id: POLICY_DOC_OWNER,
  kind: 'authorization-policy',
  // the owner, or anyone in the same tenant
  allow: binary('or',
    binary('eq', field(ref(RESOURCE), F_DOC_OWNER), field(ref(PRINCIPAL), F_PRINCIPAL_ID)),
    binary('eq', field(ref(RESOURCE), F_DOC_TENANT), field(ref(PRINCIPAL), F_PRINCIPAL_TENANT))),
});
```

- **Closed scope.** A policy expression's `ref` may resolve **only** the three reserved ids
  exported from `@cynodia/axiom-core` — `PRINCIPAL` (`'axiom_principal'`, the canonical
  caller, the *same* id `ActionDef.authorization` uses), `RESOURCE` (`'axiom_resource'`, the
  semantic object the decision is about — for `action.invoke` a stable `{ id, kind }`
  descriptor, since there is no per-record target), and `OPERATION` (`'axiom_operation'`;
  `ref(OPERATION)` resolves to the canonical operation string, e.g. `'action.invoke'`). No
  `StateDef`, no `QueryDef`, no `now` / `uuid` / `random`, no ambient runtime state, no
  host-language callback — authorization is portable, deterministic, statically analyzable
  data (spec15 §7, §34). Write a policy with the ordinary `field` / `ref` / `binary`
  vocabulary: `binary('eq', field(ref(RESOURCE), F_OWNER), field(ref(PRINCIPAL), F_USER_ID))`.
- **ALLOW / DENY, fail closed.** `allow` evaluating to exactly `true` is **ALLOW**. `false`,
  an absent policy field, or *any evaluation error* is **DENY** — the safe direction for a
  failed access check is always refusal (spec15 §8, §123).
- **A missing PRINCIPAL / RESOURCE field never satisfies a rule** (spec15pt2 F1). The policy
  evaluator is three-valued — a concrete value, **security-scope absence** (a field the
  scope object does not carry), or an evaluation error. A comparison, `not`, `neq` or `or`
  whose truth would depend on absence is *not satisfied*, so `PRINCIPAL.role != "banned"` /
  `NOT(PRINCIPAL.role == "banned")` / `RESOURCE.ownerId == PRINCIPAL.id` all **DENY** when
  the named field is absent or the caller is anonymous. This is authorization-evaluation
  semantics only; ordinary `Expression` equality/nullish behaviour elsewhere is unchanged
  (spec15pt2 §4). An `OR` branch that is *concretely* true still allows even if the other
  branch is absent-dependent. `literal(true)` is a genuine constant — an explicitly public
  policy still admits an anonymous caller.
- **Referenced by id.** A protected surface points at a policy:
  - `ActionDef.authorizationPolicy` — `action.invoke`
  - `QueryDef.authorizationPolicy` — `query.read` (distinct from `readPolicyId`, which
    filters *which rows* the result contains)
  - `WorkflowDef.startPolicy` — `workflow.start`
  - `WorkflowDef.instanceAccessPolicy` — `workflow.inspect` / `workflow.history` /
    `workflow.cancel` on a running instance
- **Same evaluator everywhere.** Actions, queries, workflows and live queries all make the
  decision through one evaluator with the same `{ principal, operation, resource, policy }`
  inputs — no per-surface policy engine (spec15 §5, §96).

### Operation identity

Policies reason over canonical semantic operations (`AUTHORIZATION_OPERATIONS`), never over
transport method names:

```
action.invoke   query.read      record.read    record.mutate   state.read   state.mutate
workflow.start  workflow.inspect  workflow.history  workflow.cancel
live.open       live.resume     subscription.open   event.ingress
```

### Default when no policy is attached (`AUTHORIZATION_DEFAULT`)

One canonical rule, applied consistently, never left to the runtime (spec15 §9):

- a surface whose **pre-0.15 contract is public** (an unrestricted `ActionDef`, an
  unrestricted `QueryDef`) stays public;
- a surface whose contract is **already restricted** — a legacy `ActionDef.authorization`
  expression, a `QueryDef` with a `ReadPolicyDef`, a workflow instance operation (0.14
  owner-fingerprint) — keeps that restriction;
- a **new privileged surface** with no policy fails closed.

A policy may broaden an owner-only default, but only explicitly — a role like `admin` never
bypasses owner-only semantics unless the policy says so (spec15 §14, §74).

---

## Authorization is semantic identity

`AuthorizationPolicyDef` is in `EXECUTABLE_KINDS` — the *single* projection both
`semanticFingerprint` and the authority-compatibility key derive from (spec14pt3's
architecture, preserved). Therefore:

- editing a policy from ALLOW to DENY **moves the semantic fingerprint**;
- a presentation-only change (`name`, `description`) does **not**;
- two authorities whose executable authorization meaning differs are **incompatible** — a
  mixed-build authority with an incompatible policy fails closed before advancing a durable
  workflow or serving a query, exactly as for any other semantic change (spec15 §45, §46,
  §47). "Only security" is still semantic; it does not bypass compatibility.

A graph with **no** authorization vocabulary compiles to the byte-identical v1–v8 document
it always did and its fingerprint is unchanged (spec15 §39, §132).

**Evaluator version.** `0.15.0-alpha.1` and `0.15.0-alpha.2` evaluate the *same* policy
differently (absent-value safety, spec15pt2 F1), yet the graph — and its
`semanticFingerprint` — is identical. So the `AuthorityCompatibilityKey` carries an
`authorizationRuntime` discriminator, present only when the IR uses authorization
vocabulary: a mixed `alpha.1` / `alpha.2` cluster over an authorization-bearing graph is
fail-closed **incompatible** (spec15pt2 §35), while a graph with no policy rolls the
upgrade unaffected.

---

## Public-API authorization inventory (Phase A)

Every public `AxiomServer` semantic operation, classified. "Effective principal" is the
credential resolved at authority ingress; async work (workflow continuation, scheduler,
effect retry) reconstructs it from durable identity, never a process-local object
(spec15 §27).

| Operation | Kind | Resource | Effective principal | Pre-0.15 behaviour | 0.15 target |
| --- | --- | --- | --- | --- | --- |
| `handle({kind:'invoke'})` / `ActionDef` | execute | `ActionDef` (`{id,kind}`) | caller credential | `ActionDef.authorization` expr, or public | **C ✅** — `action.invoke` policy ∧ legacy expr, re-evaluated on every invocation against current policy |
| workflow `action` step | execute | `ActionDef` | **workflow's start principal** | inherits action's `authorization`, re-evaluated per step (0.14) | **C ✅** — same `authorize()` as a direct call; workflow start never amplifies privilege (§101); denial is terminal not retried (§109) |
| trigger / scheduler / event → action | execute | `ActionDef` | semantic object that scheduled it (no ambient SYSTEM) | `source: 'system'`, `invocation.allowedSources` | **C ✅** — policy under the canonical effective principal; `'system'` source is not privilege (§26, §102) |
| `handle({kind:'query'})` / `QueryDef` | read | `QueryDef` | caller credential | `ReadPolicyDef` row filter, or public | **D ✅** — `query.read` policy gates the whole query before any provider call; `ReadPolicyDef` still filters rows, AND-ed into the effective filter so `filter`/`sort`/`limit`/aggregate see the authorized dataset (§18, §81, §82) |
| `query` operation inside an `ActionDef` | read | `QueryDef` | the running action's caller | flows through the action | **D ✅** — `query.read` under `activePrincipal`; a denial fails the operation and rolls the action back (§54) |
| live query `openLiveQuery` (open) | read | `QueryDef` | caller credential | as one-shot query | **D ✅** — `query.read` decided once at open, identically to a one-shot query (§16) |
| live query update / `resumeLiveQuery` | read | `QueryDef` + rows | **re-resolved caller** | as one-shot query | **F ✅** — every re-evaluation re-resolves the caller and re-checks `query.read` (a revoked principal ⇒ `{ kind:'error', code:'AUTHORIZATION_DENIED' }`); row filtering tracks current claims so lost/gained access is a `remove`/`insert` delta (§19, §58, §79, §80); resume re-authorizes and rejects another principal's cursor (§20) |
| `SubscriptionDef` delivery (`subscription.open`) | execute | `SubscriptionDef` | event source identity | adapter-authenticated | **infrastructure trust boundary** — no graph policy; a `SubscriptionDef` is a world→Axiom inbound stream connected by an adapter, not a principal-facing subscribe. The adapter contract is the boundary (§24, §59) |
| provider-record mutation (via `ActionDef`) | mutate | provider record | caller credential | flows through the action's authorization | **C ✅** — authorized through the causing `ActionDef`; there is no public mutation path that bypasses `invokeCore` (§23) |
| authoritative `StateDef` write (via `ActionDef`) | mutate | `StateDef` | caller credential | flows through the action's authorization | **C ✅** — same; `hydrateState` stays administrative, not a semantic write (§21) |
| `startWorkflow` | execute | `WorkflowDef` (`{id,kind}`) | caller credential | any principal | **E ✅** — `WorkflowDef.startPolicy`; a denied start creates no instance; separate from the ActionDef auth a later step is subject to (§100, §101) |
| `getWorkflow` / `inspectWorkflows` / `workflowHistory` | read | workflow instance | caller credential | `getWorkflow` unauthenticated (0.14) | **E ✅** — gated by `instanceAccessPolicy` when declared (unauthorized ⇒ answered like a missing instance, no existence leak, §39); with none they stay **operator-inspection APIs**, an explicit trust boundary, not reachable through the principal-facing protocol (§15, §112-§113) |
| `cancelWorkflow` | mutate | workflow instance | caller credential | **owner-fingerprint** (spec14pt6 F4) | **E ✅** — `instanceAccessPolicy` decides when declared (explicit cross-principal, no implicit role bypass); with none the owner-fingerprint baseline is preserved. Unauthorized mutates nothing; terminal cancel stays idempotent for any caller (§14, §110) |
| `handle({kind:'event'})` ingress | execute | `EventDef` | event source identity | payload-validated, infra-trusted | explicit trust boundary per source; credentials, where accepted, affect authorization (F, §24) |
| `mutationLog` / `effectLog` / `subscriptionLog` / `revisionInspection` | read | authority internals | — | operator inspection | **operator / infrastructure APIs** — explicit trust boundary, not principal-facing (§112, §113) |

---

## Diagnostics

Validation (`validateGraph`): `AUTHORIZATION_INVALID_POLICY`, `AUTHORIZATION_INVALID_SCOPE`,
`AUTHORIZATION_NONDETERMINISTIC`, `AUTHORIZATION_UNKNOWN_POLICY` — see
[`VALIDATION.md`](VALIDATION.md). Every one is structured; a malformed policy never produces
a native exception (spec15 §37).

Runtime refusal: `AUTHORIZATION_DENIED` — the canonical code a denied `action.invoke`
(Phase C), `query.read` (Phase D — including a live query whose caller is revoked
mid-subscription, Phase F), `workflow.start` or `workflow.cancel` (Phase E) returns. On a
live subscription it arrives as `{ kind: 'error', code: 'AUTHORIZATION_DENIED' }` and the
stream serves no further data. Its `details` carry the canonical `operation`, a non-secret
machine `reason` —
`policy-denied` (the policy is not exactly `true`), `policy-error` (the policy threw — an
evaluation error is DENY, never ALLOW, spec15 §123), `legacy-denied` / `legacy-error` (the
legacy `authorization` expression), or (for workflow instance ops with no policy declared)
`owner-mismatch`, or (spec15pt2 F3, when `host.authenticate` itself threw)
`authentication-error` with `operation: 'authentication'` — plus `actionId` / `queryId`
where applicable. A denied `query` operation
inside an action surfaces as `QUERY_OPERATION_FAILED` with `details.code =
'AUTHORIZATION_DENIED'` and rolls the action transaction back. A denied `workflow.inspect` /
`workflow.history` is answered like a missing instance (`undefined` / `[]`), never
`AUTHORIZATION_DENIED` — no existence leak (§39). No state value, credential, claim or token
crosses the boundary (spec15 §38, §66, §68). The refusal survives transport faithfully
(never a `500` / native exception). It is a **terminal** semantic refusal — not a retryable
infrastructure failure: a workflow action denied at a step routes to `onError` / fails, and
the attempt count does not grow (spec15 §56, §109).

`AUTHORIZATION_ENFORCEMENT_UNAVAILABLE` — `createAxiomServer` refuses at admission when the
IR carries authorization vocabulary a phase has **not yet** wired. Every
`AuthorizationPolicyDef` reference the graph vocabulary defines is now enforced, so the gate
is dormant; it is kept as the fail-closed extension point for a later phase.

---

## Static analysis (`AgentAPI.analyzeAuthorization`)

`AgentAPI.analyzeAuthorization()` returns an `AuthorizationAnalysis` over the graph — no
running authority, and it never claims a principal *is* authorized where it cannot prove it
(spec15 §42, §50). It exposes policy **structure**, never a runtime secret (spec15 §83):

- `policies[]` — per `AuthorizationPolicyDef`: `principalFields` / `resourceFields` (field
  ids read off each scope), `readsOperation`, `constant` (`always-allow` / `always-deny` /
  `null`), a secret-free one-line `summary` (`requires RESOURCE.field_doc_owner ==
  PRINCIPAL.field_user_id`), and any `AUTHORIZATION_*` `problems`.
- `operations[]` — every `action.invoke` / `query.read` / `workflow.*` surface with its
  `protection` (`policy` / `legacy-expression` / `policy+legacy` / `read-policy` /
  `policy+read-policy` / `owner-fingerprint` / `public`) and an `unresolved` flag.
- `unprotected[]` — every surface with **no** explicit authorization boundary (a `public`
  action or query; a workflow with no `startPolicy`). A workflow instance op with no
  `instanceAccessPolicy` is *not* unresolved — owner-fingerprint is a defined default.
- `workflows[]` — `start` / `instanceAccess` mode, `actionDependencies` (each step's
  `ActionDef` with its own protection), and `privilegeReviewActions` — action steps whose
  `ActionDef` carries a policy that static analysis cannot prove the start principal
  satisfies (the runtime enforces it per step, spec15 §10, §101).
- `usesAuthorizationVocabulary` — `true` ⇒ the graph requires `axiom.server.v9`.

`authorizationPolicyDependencies(policy)` (core) is the total, secret-free primitive the
analysis is built on.

---

## Conformance

`axiom.conformance.v9` (`conformance/authorization/`) is the portable authorization tier.
Each fixture is a compiled `axiom.server.v9` Server IR, the principal records each
credential resolves to, provider seed rows, and a deterministic driver script — every step
carrying the **decision the fixture author computed independently** (ALLOW / DENY, and for a
query the exact set of authorized row ids). `runAuthorizationConformanceFixture` /
`runAuthorizationConformanceSuite` (from `@cynodia/axiom-server`) run a fixture through a
real authority and assert the runtime matches and that a denied step changed nothing
(spec15 §115). The tier is verified over both memory and SQLite persistence (spec15 §114).
Covered categories (spec15 §71): allow, deny, anonymous, owner, cross-principal, role/claim
condition, resource-owner condition, tenant isolation, query filtering, action invocation,
workflow continuation / cancellation / inspection, live-query resume, and the fail-closed
behaviour of a constant-deny (mixed-build-incompatible) policy. Full semantic-fingerprint
divergence and real-process crash boundaries are the Phase I suite.

---

## Not in 0.15

Axiom consumes canonical principals from authentication infrastructure and defines
*application* authorization. Out of scope: OAuth/OIDC, user management, MFA, delegation /
impersonation (`actAs` / `sudo` / `assumeRole`), an ABAC language with arbitrary functions,
external policy engines, cryptographic capability tokens, row encryption, an audit-log
product (spec15 §51, §89). Stronger explainability and AI authoring build on this model in
0.16.
