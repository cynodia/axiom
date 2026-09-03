# Axiom 0.15 — Authorization design note (Phase A)

*Maintainer artifact. Not shipped in any npm tarball.*

Companion to `specs/spec15.md`. This note records the Phase A **inventory** — every public
`AxiomServer` semantic operation, how it is authorized today, and the intended 0.15
behaviour — and the design decisions that shaped the Phase B vocabulary.

## 1. Why 0.15 exists

Through 0.14, authorization in Axiom is a scatter of partial mechanisms:

- `ActionDef.authorization` — an `Expression` over `PRINCIPAL`, checked at action ingress.
- `ReadPolicyDef` (spec10) — a row-level predicate AND-ed into a query's effective filter.
- `ActionDef.invocation.allowedSources` (spec8.1) — a client/system *source* gate, not an
  identity check.
- workflow instance owner-fingerprint (spec14pt6 F4) — `cancelWorkflow` requires the
  caller's principal fingerprint to equal the one the instance was started under.
- `getWorkflow` / `inspectWorkflows` / `workflowHistory` — **unauthenticated** in 0.14.
- live query cursors — HMAC-sealed and principal-bound, but resume does not re-authorize.

Each was added for one surface. There is no single language, no single evaluator, no
inventory of what is covered, and no guarantee that a new surface is default-deny. That is
the gap spec15 closes.

## 2. Design decisions (Phase B vocabulary)

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **One** node kind — `AuthorizationPolicyDef` with a single boolean `allow` — not `ActionAuthorization` / `QueryAuthorization` / `WorkflowAuthorization` variants. | spec15 §5. One language ⇒ one evaluator ⇒ one thing to audit. Per-surface differences are expressed by *which* policy id a surface points at and by the `OPERATION` scope value, not by a different type. |
| D2 | Policy is referenced **by id** (`ActionDef.authorizationPolicy`, `QueryDef.authorizationPolicy`, `WorkflowDef.startPolicy` / `instanceAccessPolicy`), never inlined. | A policy is reusable across surfaces and is independently addressable for analysis and for the fingerprint projection. Matches `ReadPolicyDef` / `readPolicyId`. |
| D3 | Closed expression scope: `PRINCIPAL`, `RESOURCE`, `OPERATION` only. No `StateDef`, no `QueryDef`, no `now` / `uuid` / `random`. | spec15 §7, §34. Authorization must be portable, deterministic and statically analyzable — the same properties the workflow expression scope enforces (spec14). A policy that could read mutable authority state would not be reproducible across authorities or across a retry. |
| D4 | `allow` evaluating to exactly `true` ⇒ ALLOW. `false`, an absent policy field, **or any evaluation error** ⇒ DENY. | spec15 §8, §123, §128. The safe direction for a failed access check is refusal. This also means a malformed policy that somehow reaches the runtime denies rather than crashes or opens. |
| D5 | `AuthorizationPolicyDef` joins `EXECUTABLE_KINDS`. It flows through the **single** projection (`serverIrSemanticProjection` via `SERVER_IR_EXECUTABLE_SLICES`) that both `semanticFingerprint` and `AuthorityCompatibilityKey` derive from. | spec15 §45, §97; the exact architecture spec14pt3 F3 established for workflows. "Only a security change" is still a semantic change: two authorities that would make different ALLOW/DENY decisions are incompatible and the mixed-build guard must catch it. |
| D6 | The `authorization-policy` slice carries `since: 'v9'` and is emitted **only when non-empty**. | A graph with no authorization vocabulary compiles to the byte-identical v1–v8 document it always did and its `semanticFingerprint` is unchanged (spec15 §39, §132). No existing conformance fixture moves. |
| D7 | Contract id `axiom.server.v9`, derived by `usesAuthorizationVocabulary(ir)`, never asserted. `understatedContract` (server) re-derives it to refuse a hand-labelled IR. | The established contract-identifier discipline (`axiom.server.v1..v8`). |
| D8 | During the phased period, `createAxiomServer` **fails closed** (`AUTHORIZATION_ENFORCEMENT_UNAVAILABLE`) on any IR carrying authorization vocabulary. | spec4 §4 / spec15 §128. A declared-but-unenforced policy is a silent semantic failure. Better to refuse the build than to run a policy as a no-op and let an operator believe a surface is protected. Removed the moment Phase C wires the evaluator. |
| D9 | Legacy `ActionDef.authorization` (an `Expression`) and `ReadPolicyDef` (row-level) are **kept**. When both a policy and a legacy expression apply, the effective decision is their **conjunction**. | No migration break. Unification (a single evaluator that folds legacy expressions and row policies through the same path) is Phases C–D, behind the same fingerprint. |
| D10 | `AUTHORIZATION_OPERATIONS` is a closed vocabulary of canonical operation ids (`action.invoke`, `query.read`, `record.read`, `record.mutate`, `state.read`, `state.mutate`, `workflow.start`, `workflow.inspect`, `workflow.history`, `workflow.cancel`, `live.open`, `live.resume`, `subscription.open`, `event.ingress`). | Policies reason over semantic operations, never transport method names (spec15 §36). A closed enum keeps the coverage audit (Phase G) decidable. |

## 3. Phase A inventory

See `docs/AUTHORIZATION.md` § "Public-API authorization inventory (Phase A)" for the
canonical table (operation → kind → resource → effective principal → pre-0.15 behaviour →
0.15 target → enforcing phase). It is in the shipped contract doc rather than duplicated
here so it cannot drift.

Salient findings from building it:

- **`getWorkflow` is unauthenticated in 0.14.** Anyone who can guess or observe an
  `instanceId` reads its status, current step, failure and output. 0.15 Phase E puts it
  behind `instanceAccessPolicy` with an owner-fingerprint default — `instanceId` knowledge
  is not authorization (spec15 §13, §15).
- **`startWorkflow` accepts any principal in 0.14.** Discovering that a workflow exists is
  not permission to start one; Phase E adds `WorkflowDef.startPolicy` (spec15 §100).
- **`resumeLiveQuery` does not re-authorize.** The cursor is principal-bound and
  fingerprinted, but a cursor is not a bearer token — Phase F re-resolves the principal on
  resume and re-authorizes, so a revoked principal cannot resume a stream (spec15 §20).
- **Async work (workflow steps, scheduler, effect retry) must reconstruct the effective
  principal from durable identity**, never a process-local object. spec14 already stamps
  the workflow start principal fingerprint durably; Phase C/E evaluate policies under it
  (spec15 §27).
- **Operator / infrastructure APIs** (`mutationLog`, `effectLog`, `subscriptionLog`,
  `revisionInspection`, `inspectDistributedWork`) are an explicit trust boundary, not
  principal-facing surfaces, and are out of the policy model (spec15 §112, §113).

## 4. What Phase B deliberately does not do

- No evaluator. No enforcement anywhere. No `AUTHORIZATION_DENIED` at runtime yet (the code
  is documented as arriving in Phase C).
- No `AgentAPI.analyzeAuthorization` (Phase G).
- No `axiom.conformance.v9` fixtures (Phase H).
- No package version bump. `0.15.0-alpha.1` is cut when enforcement (C–F) lands.

## 5. Open questions carried into Phase C+

1. **Row-level vs operation-level unification (D).** `ReadPolicyDef` filters rows;
   `query.read` gates the whole query. The intended model is: `query.read` decides whether
   the query runs at all, then the row policy (still `ReadPolicyDef`, possibly re-expressed
   as an `AuthorizationPolicyDef` over `record.read`) filters the authorized dataset
   *before* limit/sort. Needs the evaluator first.
2. **`RESOURCE` binding for operations with no single resource** (`query.read` over a
   dataset, `subscription.open`). Likely `RESOURCE` is absent and the policy leans on
   `PRINCIPAL` / `OPERATION`; a policy that dereferences an absent `RESOURCE` field denies
   by D4.
3. **Revocation propagation timing for live queries (F)** — within the revision contract,
   an update that removes now-unauthorized rows behaves as a normal `remove` delta. Needs
   the live engine wired to the evaluator.
