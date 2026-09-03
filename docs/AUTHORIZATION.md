# Authorization

Axiom 0.14.0-alpha.5. The operational contract for **authorization completeness** — the 0.15
milestone (spec15). Whether a principal may perform a semantic operation is part of the
graph's executable meaning — not a runtime concern, not UI visibility, not something that
varies by transport, provider, process, retry path or authority topology. `axiom.server.v9`
when a graph carries authorization vocabulary; a graph with none is byte-identical to its
prior contract.

> **Authentication** answers *who is this?* — credential adapters and transports do that,
> outside portable application semantics. **Authorization** answers *may this principal
> perform this semantic operation?* — that is what this document defines.

0.15 lands in phases. This document describes the **model** (stable) and marks which
surfaces **enforce** it in which phase.

| Phase | Delivers | Enforced |
| --- | --- | --- |
| A | Public-API authorization inventory (below) | — |
| **B** | `AuthorizationPolicyDef` vocabulary, `validateGraph` totality, single semantic projection, `axiom.server.v9` | *declared, validated, fingerprinted — not yet enforced* |
| C | One canonical `authorize()` evaluator; `action.invoke` / `record.*` / `state.*` | ✅ |
| D | `query.read` + row-level read authorization unified with `ReadPolicyDef` | ✅ |
| E | `workflow.start` / `workflow.inspect` / `workflow.history` / `workflow.cancel` | ✅ |
| F | `live.open` / `live.resume` / `subscription.open`, revocation propagation | ✅ |
| G | `AgentAPI.analyzeAuthorization` + coverage audit | — |
| H | `axiom.conformance.v9` | — |
| I | Real-process / mixed-build / adversarial validation | — |

Until enforcement for a surface ships, `createAxiomServer` **fails closed**
(`AUTHORIZATION_ENFORCEMENT_UNAVAILABLE`) on any IR that carries authorization vocabulary —
a declared policy is never run as a silent no-op (spec4 §4).

---

## The model

There is **one** authorization language. An `AuthorizationPolicyDef` is a graph node with a
single boolean `allow` expression:

```ts
graph.addNode<AuthorizationPolicyDef>({
  id: POLICY_DOC_OWNER,
  kind: 'authorization-policy',
  // the owner, or anyone in the same tenant
  allow: binary('or',
    binary('eq', field(ref('RESOURCE'), F_DOC_OWNER), field(ref('PRINCIPAL'), F_PRINCIPAL_ID)),
    binary('eq', field(ref('RESOURCE'), F_DOC_TENANT), field(ref('PRINCIPAL'), F_PRINCIPAL_TENANT))),
});
```

- **Closed scope.** A policy expression's `ref` may resolve **only** `PRINCIPAL` (the
  canonical caller — see `graph.principalEntityId`), `RESOURCE` (the semantic object the
  operation targets, where one exists) and `OPERATION` (the canonical operation identity).
  No `StateDef`, no `QueryDef`, no `now` / `uuid` / `random`, no ambient runtime state, no
  host-language callback — authorization is portable, deterministic, statically analyzable
  data (spec15 §7, §34).
- **ALLOW / DENY, fail closed.** `allow` evaluating to exactly `true` is **ALLOW**. `false`,
  an absent policy field, or *any evaluation error* is **DENY** — the safe direction for a
  failed access check is always refusal (spec15 §8, §123).
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

---

## Public-API authorization inventory (Phase A)

Every public `AxiomServer` semantic operation, classified. "Effective principal" is the
credential resolved at authority ingress; async work (workflow continuation, scheduler,
effect retry) reconstructs it from durable identity, never a process-local object
(spec15 §27).

| Operation | Kind | Resource | Effective principal | Pre-0.15 behaviour | 0.15 target |
| --- | --- | --- | --- | --- | --- |
| `handle({kind:'invoke'})` / `ActionDef` | execute | `ActionDef` | caller credential | `ActionDef.authorization` expr, or public | `action.invoke` policy ∧ legacy expr; re-evaluated at every step (C) |
| workflow `action` step | execute | `ActionDef` | **workflow's start principal** | inherits action's `authorization`, re-evaluated per step (0.14) | same evaluator as a direct call; workflow start never amplifies privilege (C, §101) |
| trigger / scheduler / event → action | execute | `ActionDef` | semantic object that scheduled it (no ambient SYSTEM) | `source: 'system'`, `invocation.allowedSources` | policy under the canonical effective principal (C, §26, §102) |
| `handle({kind:'query'})` / `QueryDef` | read | `QueryDef` + rows | caller credential | `ReadPolicyDef` row filter, or public | `query.read` policy (open) + row policy over the *authorized* dataset before limit/sort (D, §18) |
| live query `openLiveQuery` / initial / update | read | `QueryDef` + rows | caller credential | as one-shot query | identical to one-shot; revocation removes now-unauthorized data within the revision contract (F, §17, §19) |
| `resumeLiveQuery(cursor)` | read | `QueryDef` + rows | **re-resolved caller** | cursor bound to principal / args / policy fingerprint | a cursor is not a bearer token — resume re-resolves the principal and re-authorizes (F, §20) |
| provider-record mutation (via `ActionDef`) | mutate | provider record | caller credential | flows through the action's authorization | authorized through the causing `ActionDef`; no unchecked direct provider mutation path (C, §23) |
| authoritative `StateDef` write (via `ActionDef`) | mutate | `StateDef` | caller credential | flows through the action's authorization | same (C, §21) |
| `startWorkflow` | execute | `WorkflowDef` | caller credential | any principal | `WorkflowDef.startPolicy`; discovering a workflow ≠ starting it (E, §100) |
| `getWorkflow` / `inspectWorkflows` / `workflowHistory` | read | workflow instance | caller credential | `getWorkflow` unauthenticated (0.14) | `instanceAccessPolicy`, default owner-fingerprint; `instanceId` knowledge is not authorization (E, §13, §15) |
| `cancelWorkflow` | mutate | workflow instance | caller credential | **owner-fingerprint** (0.14 F4) | `instanceAccessPolicy`, default owner-fingerprint preserved; unauthorized mutates nothing (E, §14) |
| `handle({kind:'event'})` ingress | execute | `EventDef` | event source identity | payload-validated, infra-trusted | explicit trust boundary per source; credentials, where accepted, affect authorization (F, §24) |
| `mutationLog` / `effectLog` / `subscriptionLog` / `revisionInspection` | read | authority internals | — | operator inspection | **operator / infrastructure APIs** — explicit trust boundary, not principal-facing (§112, §113) |

---

## Diagnostics

Validation (`validateGraph`): `AUTHORIZATION_INVALID_POLICY`, `AUTHORIZATION_INVALID_SCOPE`,
`AUTHORIZATION_NONDETERMINISTIC`, `AUTHORIZATION_UNKNOWN_POLICY` — see
[`VALIDATION.md`](VALIDATION.md). Every one is structured; a malformed policy never produces
a native exception (spec15 §37).

Runtime refusal: `AUTHORIZATION_DENIED` — the canonical code, the same one a denied
`ActionDef` invocation returns. It survives transport faithfully (never a `500` / native
exception) and carries no secret (no raw credential, no non-semantic claim, no token)
(spec15 §38, §66, §68). `AUTHORIZATION_DENIED` is a **terminal** semantic refusal — not a
retryable infrastructure failure; a workflow action denied at a step routes to `onError` /
fails, and the attempt count does not grow (spec15 §56, §109).

---

## Not in 0.15

Axiom consumes canonical principals from authentication infrastructure and defines
*application* authorization. Out of scope: OAuth/OIDC, user management, MFA, delegation /
impersonation (`actAs` / `sudo` / `assumeRole`), an ABAC language with arbitrary functions,
external policy engines, cryptographic capability tokens, row encryption, an audit-log
product (spec15 §51, §89). Stronger explainability and AI authoring build on this model in
0.16.
