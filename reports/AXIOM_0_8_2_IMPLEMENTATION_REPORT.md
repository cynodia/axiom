# Axiom 0.8.2 Implementation Report

Target: `@cynodia/axiom` 0.8.2-alpha.1
Baseline: 0.8.1-alpha.1
Spec: `specs/spec8.2.md` — Integration & Trigger Polish / Contract Clarity

## Summary

0.8.2 closes the documentation-correctness, validation-consistency, effect-observability
and portable-conformance friction spec 8.2 asked for, without expanding what the language
does. No 0.8/0.8.1 hardening guarantee changed: the invocation-source trust boundary, the
runtime-owned query timeout, the transactional outbox, retry/idempotency semantics and
deterministic/real-host scheduling parity are all untouched and re-verified by the existing
suite plus new regression tests.

Concretely: `validateGraph(graph)` now has a documented, tested companion
(`validateForBrowser`) that answers what a bare validate-only call cannot; `effectLog()`
now reports `running`/`attempts` truthfully instead of lying `pending`/`0` while an adapter
call is genuinely outstanding; `axiom.server.v4` and the manifest's three separate version
concepts are now documented and generated-tested rather than silently stale; the portable
conformance suite grew from 15 to 24 fixtures (10 of spec §11's list, plus the webhook
semantic fixture) and gained a public, independently-runnable reference runner; and
`getWebhookEvents()` is deprecated in favor of the accurately-named `getTriggeredEvents()`.

Two scope reductions are stated plainly below rather than silently skipped, matching the
0.8.1 report's own practice: "effect survives restart" and "event depth guard" as
*portable fixtures* specifically (both are already covered by ordinary TypeScript tests);
and no independent blind external-consumer retest was run this session.

---

## Answers to spec §64-72

### Validation

**1. What is `validateGraph()`'s default target/capability behavior now?**
Unchanged and now precisely documented: target-neutral. With no options, every UI node
kind and every trigger kind validates, because a graph is never rejected for a renderer or
trigger runtime nobody named — the same design `RendererCapabilities` already used.

**2. Can a client-authority unsupported trigger return `valid:true` under the default call?**
Yes, by design (spec 8.2 §4's "alternative" was chosen over §3's "preferred" default
change, to avoid breaking the existing target-neutral symmetry with `renderer` and to avoid
duplicating `BROWSER_TRIGGER_CAPABILITIES` — which deliberately lives beside the runtime
that has to be true to it, not in `core` — into a place `core` could reach). What changed:
`validateForBrowser(graph)` (`@cynodia/axiom-compiler`) now exists as the explicit,
documented, tested browser-real validate-only path, and `docs/TRIGGERS.md`,
`docs/VALIDATION.md` and `docs/AGENT_REFERENCE.md` all now state the target-neutral default
prominently rather than implying `validateGraph` alone catches it.

**3. Does `compileToIR` still reject unsupported client triggers?**
Yes, unchanged — `compileToIR` still applies `BROWSER_TRIGGER_CAPABILITIES` by default and
throws `GraphValidationError`. `validateForBrowser` applies the identical capability set, so
the two can never disagree (`packages/compiler/test/trigger-capabilities.test.ts`).

**4. Does `CLIENT_TRIGGER_UNSUPPORTED` explain the remediation?**
Yes. The message now states what to do instead: "Move `<action>` to server-authoritative
execution ..., or compile for a trigger runtime that publishes '`<kind>`' in its
supportedTriggerKinds." (`packages/core/src/validate-authority.ts`).

### Contract docs

**5. Is `axiom.server.v4` documented in `AUTHORITY.md`?**
Yes — it was completely absent from the contract table before this release (a real gap
spec 8.2 §7 found); it now has a row describing exactly what it adds (invocation-source
restriction, the structured effect-outcome envelope), and `server-ir.v4.schema.json` was
also missing from the "Machine-readable contracts" list and is now present.

**6. Is the contract table tested against `SERVER_IR_CONTRACTS`?**
Yes — `packages/demo/test/documentation.test.ts`'s new
`'every Server IR contract has a row in the AUTHORITY.md contract table, and vice versa'`
fails if either enumerates a contract the other does not.

**7. What happened to `manifest.json`'s top-level `contract` field?**
Renamed to `baseContract`, per spec 8.2 §9's "Preferred: remove or rename it." It now means
precisely what it can honestly mean: the oldest Server IR contract any fixture in the
manifest may use (always `axiom.server.v1`), not a claim about the whole suite — which now
spans v1 through v4 simultaneously. Each fixture's own `contract` field remains
authoritative for what that fixture actually requires. `docs/AUTHORITY.md`'s Conformance
section now documents `conformance` (fixture-format version) / `baseContract` /
`fixtures[].contract` / `release` as four separate, non-overlapping concepts.

**8. Are all four Server IR schemas listed in agent-facing docs?**
Yes — `docs/AGENT_REFERENCE.md`'s portable-artifacts block now lists all four
(`server-ir.v1` through `v4`), and a new documentation test
(`'every shipped server-ir schema file is named in docs/AGENT_REFERENCE.md'`) fails in
either direction: a shipped schema file missing from the doc, or a doc-named file that does
not ship.

### Effect observability

**9. What does `effectLog()` report before dispatch?**
`status: 'pending'`, `attempts: 0` — unchanged.

**10. What does it report while an adapter call is outstanding?**
`status: 'running'`, `attempts: <n>` — this is the fix. Before 8.2, `effects.ts` durably
persisted the `running` transition (`persistence.recordEffectAttempt`) but never told
`AxiomServer`'s own in-memory `effectRecords` map — the map `effectLog()` actually reads —
so the public view stayed `pending`/`0` indefinitely even though the adapter had genuinely
been called. `EffectRunnerOptions` gained an `onRunning` callback, called synchronously
before the adapter is invoked, which `server.ts` wires straight into `effectRecords.set(...)`.

**11. When does `attempts` increment?**
Before the adapter call, atomically with the `running` transition — unchanged from 8.1, now
correctly visible. It counts invocation attempts *started*, not merely ones that settled.

**12. Does a hung effect show running/attempts=1?**
Yes — `'effectLog reports status running with attempts 1 for a hung effect, never
pending/0 (spec 8.2 §17-23)'` (`packages/server/test/integrations.test.ts`) is the required
regression test.

**13. What happens to running effects after restart?**
Unchanged (this was already correct, just under-tested): `loadPendingEffects()` returns
anything not `succeeded`/`failed`, including `running`; `effects.ts`'s local `attempt`
counter restarts at zero on resume (a fresh full budget, since the old process's one call is
unaccounted for, not spent) while the persisted `attempts` total keeps counting up honestly.
The restart test in `integrations.test.ts` now additionally asserts the persisted record is
`{ status: 'running', attempts: 1 }` immediately after commit, and `{ status: 'succeeded',
attempts: 2 }` after the resumed process's own attempt succeeds.

**14. Was any effect timeout introduced?**
No.

**15. If not, is the lack of effect timeout documented explicitly?**
Yes — `docs/EFFECTS.md` now states "No runtime-enforced effect timeout in 0.8.2" plainly,
plus a research note explaining *why* a naive timeout-to-`failed` mapping would be unsafe
(the provider may have already executed the side effect) and that a future `unknown` status
is a design candidate, not something 0.8.2 freezes.

### Outcomes / correlation

**16. What exactly does `EFFECT_CORRELATION_ID_FIELD` mean?**
Documented field-by-field in `docs/EFFECTS.md`: the internal Axiom transaction id
(`tx_<n>`) of the committing action's transaction.

**17. Is its string format part of the contract?**
No, explicitly not — only the semantics are ("identifies the Axiom transaction that created
this effect intent, within this process's lifetime"), stated as such in the doc.

**18. How should an app correlate outcome to a business entity?**
`idempotencyKey`, when it is naturally unique per business operation — documented
prominently, with the explicit statement that effect outcomes do not automatically carry
the original operation's arguments.

**19. Does the outcome contain original operation arguments?**
No — documented explicitly as a thing it does *not* do, so an author does not have to
discover this by testing.

**20. Was a new correlation primitive added?**
No — per spec 8.2 §29-30's preferred outcome, `idempotencyKey` behavior is unchanged and no
`correlationKey`/`correlationValue` was added. No concrete use case demonstrated
`idempotencyKey` alone is insufficient.

**21. Are success/failure envelope fields documented precisely?**
Yes — a full field table in `docs/EFFECTS.md` states presence (always / success-only /
failure-only / conditional), source, and for `EFFECT_CORRELATION_ID_FIELD` specifically:
lifetime, uniqueness scope, restart stability and settability. The doc also states plainly
that success and failure are **not symmetric** (disjoint field sets), correcting a framing
spec 8.2 §32 flagged.

### AgentAPI

**22. Was `getWebhookEvents` renamed/deprecated/clarified?**
Both: `getTriggeredEvents()` is the new, accurately-named primary method;
`getWebhookEvents()` is kept as a `@deprecated` alias calling it, for backward
compatibility.

**23. What does its replacement mean exactly?**
"Events at least one `TriggerDef` reacts to" — a graph-static query, documented as
explicitly *not* meaning "webhook deliveries received at runtime." The same event this
returns may be dispatched by a verified external webhook, by an effect's
`succeededEventId`/`failedEventId`, or any other internal source; the graph does not record
which.

**24. Does `GraphQueries` still avoid pretending to know deployment-level webhook
registrations?**
Yes, unchanged and now stated explicitly in `docs/EVENTS.md`: webhook routes and
deployment-level registration remain host/deployment concerns, deliberately outside what
`GraphQueries` infers.

### Retry / concurrency

**25. What does retryable absent mean?**
Documented as a three-row table in `docs/EFFECTS.md`: `false` stops immediately; `true`
continues; absent continues **exactly like `true`** — "the adapter could not determine
retryability" is not the same claim as "retry cannot succeed." Regression-tested in the new
`packages/server/test/effect-retry.test.ts` (three tests: false/true/absent), which also
exercises a genuine multi-attempt retry sequence with a stable `idempotencyKey` across every
attempt — nothing in the suite tested a real retry sequence before this.

**26. Does a hung query delay unrelated Actions?**
Yes, confirmed and now explicitly documented in `docs/INTEGRATIONS.md` — the authority's
single serialized FIFO queue means a hung query blocks whatever request queued up behind
it, including one sharing no state, integration or trigger with it.

**27. Is that delay bounded by `timeoutMs`?**
Yes — new regression test `'a hung query delays a genuinely unrelated queued Action, bounded
by timeoutMs (spec 8.2 §40-42)'` in `packages/server/test/timeout-and-scheduling.test.ts`
uses a state and action that share nothing with the hung query's graph, and asserts the
unrelated action has not run while the query is in flight, then does run once the timeout
fires.

**28. Was the serialized authority model changed?**
No — spec 8.2 §41 explicitly asks that it not be, and it was not.

### Conformance

**29. How many fixtures now ship?**
24 (up from 15): 10 unchanged `axiom.conformance.v1` fixtures plus 14
`axiom.conformance.v2` fixtures (5 carried over from 8.1, 9 new).

**30. Which new scenarios were added?**
`late-query-result-after-timeout`, `late-query-rejection-after-timeout`,
`failed-effect-structured-outcome`, `authenticated-client-rejects-system-only-action`,
`simultaneous-same-instant-triggers-both-commit`, `rolled-back-action-produces-no-effect`,
`effect-retry-sequence`, `event-payload-invalid`,
`verified-external-event-invokes-system-only-action`.

**31. Is failed-effect outcome covered?** Yes — `failed-effect-structured-outcome`.

**32. Is late-result-after-timeout covered?** Yes — both the success and rejection cases,
via a new `resolveAfterMs` scripted-response field (`ConformanceScriptedResponse`) that
resolves a canned response only after a given number of milliseconds on the fixture's own
deterministic clock — still pure data, no executable code in the fixture file.

**33. Is simultaneous-trigger scheduling covered?** Yes —
`simultaneous-same-instant-triggers-both-commit`: two one-shot `delay` triggers due at the
same simulated instant, both commit, zero spurious conflicts.

**34. Is effect restart covered?** As a TypeScript-level test (strengthened this release to
assert the exact `running`/`attempts` transition across the restart), not as a portable
fixture — see Remaining Limitations below. The declarative fixture format's `steps`/
`externalAdapters` shape has no way to swap in a different adapter for a "restarted"
instance mid-fixture, which a faithful restart scenario needs (a hanging first adapter, a
responsive one after restart).

**35. Is rollback-suppresses-effect covered?** Yes —
`rolled-back-action-produces-no-effect`: a constraint violation rolls back a transaction
that both wrote state and recorded an effect intent; the scripted adapter would move
`INT_STATE_MESSAGE` if ever called, and the fixture asserts it never does.

**36. Is retry sequence covered?** Yes — `effect-retry-sequence`: one transient failure
followed by a success, under a `fixed`/`maxAttempts: 3`/`delayMs: 50` policy.

**37. Is event-depth guard covered?** No, not as a portable fixture — see Remaining
Limitations. It is covered by
`'an event-dispatch cycle is stopped rather than recursing unboundedly (spec §120-121)'`
in `packages/server/test/integrations.test.ts`.

**38. Are all fixtures data-only?** Yes — unchanged invariant, re-verified by
`'a fixture is self-contained data, with nothing of this implementation in it'`, which
still passes for all 24.

**39. Is a public runner exported?** Yes —
`runConformanceFixture`/`runConformanceSuite` (`@cynodia/axiom-server`). The fixture
*model* (`conformance-types.ts`) is a separate module from the TypeScript reference-runtime
*adapter* (`conformance-runner.ts`), per spec 8.2 §16, so a non-JS implementation needs only
the former's shapes plus `docs/AUTHORITY.md`'s semantics.

**40. Did an independent external runner pass all fixtures?**
`scripts/run-conformance.mjs` runs the entire suite through nothing but the public
`runConformanceFixture` export and the manifest/fixture JSON — no internal test helper, no
graph, no compiler, no builder (`npm run conformance:run`). All 24 pass. This is the "held
to the same standard by an outside caller" claim demonstrated rather than merely asserted;
it is a standalone script rather than a genuinely separate implementation, which is the
honest scope of "independently-written" achievable in a single implementation session (see
Remaining Limitations).

### Versioning

**41. Is `axiom.server.v4` still latest?** Yes — `SERVER_IR_LATEST_CONTRACT` is unchanged.

**42. Was a new contract required?** No.

**43. If so, why?** N/A. 0.8.2 is documentation, validation-consistency, effect-observability
timing and fixture-coverage work — no new IR vocabulary, no incompatible serialized-semantics
change. Per spec 8.2 §55-56, no `axiom.server.v5` was created.

**44. Did older contract fixtures remain unchanged?**
The 10 original `axiom.conformance.v1` fixtures are semantically unchanged; their bytes
differ only in the graph's own `version` stamp (bumped from the release version, as every
release does) — confirmed by running the full existing assertion suite against them
unmodified. The five 8.1-era `v2` fixtures also gained new sibling nodes in the shared
`buildIntegrationGraph()` (the guard entity, counter state, external-status event added for
new fixtures), which changes their embedded `serverIR` bytes (each fixture carries the
*whole* compiled graph, self-contained) without changing what those five fixtures each
individually assert or exercise.

### Verdict

**45. Did any S3/S4 defect appear?**
No new S3/S4-class defect was introduced or found in this pass. The one genuine "silent
wrong answer" bug found and fixed was pre-existing and orthogonal to spec 8.2's brief:
`ApplicationGraph`'s default `version` parameter (`packages/core/src/graph.ts`) was
hardcoded to the string `'0.8.1'`, so bumping the release version alone would have made
`packages/demo/test/documentation.test.ts`'s `'a new graph is stamped with the release
version'` test fail — caught immediately by that test once the version bump ran, not
missed silently. Now `'0.8.2'`.

**46. Did effect observability improve?**
Yes, materially — `pending`/`0` no longer masks a genuinely outstanding adapter call.

**47. Are docs materially more self-consistent?**
Yes — the `axiom.server.v4` contract-table gap, the missing `v4` schema listing, the
imprecise "validateGraph/compileToIR reject" claim in `TRIGGERS.md`, the ambiguous manifest
`contract` field, and the stale `'0.8.0'` graph-version-default comments are all fixed, and
four of these are now guarded by generated/tested doc-consistency checks rather than
resting on prose alone.

**48. Is the portable contract closer to P1?**
Yes — see Portability Classification below.

**49. What are the five largest remaining limitations?**
1. Two of spec §11's ten fixture scenarios — "effect survives restart" and "event depth
   guard" — are not expressed as portable JSON fixtures, only as TypeScript tests, because
   the current fixture format has no way to express "restart with a different adapter" or
   assert on `report()`-level diagnostic events (the depth guard's evidence) rather than an
   `InvokeResponse`/`EventResponse`.
2. `scripts/run-conformance.mjs` proves the public runner is usable standalone from this
   repository's own package output; it is not a genuinely independent, separately-written
   implementation, which is a different and stronger claim than a single implementation
   session can make for itself.
3. No independent blind external-consumer retest was performed this session (spec 8.2 §62)
   — the same limitation the 0.8.1 report named and did not close either.
4. Effect timeout remains unenforced by design (unchanged from 8.1, and explicitly
   out-of-scope per spec 8.2 §24), so a hung effect adapter call can occupy a retry attempt
   indefinitely; the observability fix in this release makes that state *visible*
   (`running`, not `pending`) but does not bound it.
5. No formal npm-pack/release-pipeline run (`release:prepare`) was executed this session —
   the packaging-gate claims rest on the existing `packages/*.test.ts` export-map and
   `files`-whitelist assertions passing, plus manual inspection of `package.json`, not a
   from-tarball consumer test. (`test:browser` was also not run — Playwright's Chromium
   binary is not installed in this sandbox, unchanged from 8.1's report.)

**50. Is 0.8.x now complete enough to stop feature work and move to 0.9?**
Yes, on the strength of this release closing the specific friction items Experiment #10's
premise named. See Release Classification below for the qualified form of that answer.

---

## Release Classification (spec §73)

**B — COMPLETE WITH MINOR DOCUMENTATION/TOOLING DEBT.**

Every P1/P2-tier item spec 8.2 asked for by name is done: validation-consistency default
documented and given an explicit helper, `axiom.server.v4` documented and tested against
the enum, the manifest's ambiguous field renamed and its three version concepts documented
separately, effect `running`/`attempts` observability fixed and regression-tested,
`EFFECT_CORRELATION_ID_FIELD` and the full outcome envelope documented field-by-field,
`getWebhookEvents` clarified with an accurately-named replacement, `retryable` absent
semantics documented and tested with a real retry-sequence test that did not exist before,
query-serialization/authority-queue behavior documented and regression-tested, and the
portable conformance suite substantially expanded with a public, standalone-runnable
reference runner. What remains (Q49 above) is fixture-coverage completeness for two of ten
named scenarios and process-level verification (external retest, pack/consumer-test) that a
single implementation session cannot itself substitute for — S0/S1 in character, not a gap
that lets ordinary integration/trigger/effect usage misbehave or ship unsecured.

## Portability Classification (spec §74)

**P2 — PORTABLE CORE READY, SMALL FIXTURE/DOC GAPS REMAIN.**

The Server IR contract table, all four schemas, and the manifest's version semantics are
now internally consistent and generated/tested rather than hand-maintained prose. 24
portable fixtures cover mutation/rollback/constraints/authorization/persistence/concurrency
(v1) and integration query/timeout/late-result, effect success/failure/retry/rollback,
trigger scheduling parity, invocation source, and a verified-external-event → system-only
action pair (v2) — a substantially larger and more representative slice of 0.8's vocabulary
than 8.1 shipped. It is not P1 because two named scenarios (restart, depth guard) are not
yet expressible in the fixture format without an extension neither this spec nor this
session added, and because the "external runner" proof is this session's own script against
this session's own build, not a truly independent second implementation.

## Effect Observability Classification (spec §75)

**O1 — PENDING/RUNNING/TERMINAL STATES ARE CLEARLY OBSERVABLE.**

`effectLog()` now reports `running`/`attempts` synchronously with the adapter call starting,
confirmed by a dedicated hung-effect regression test. `pending` and `running` are
distinguishable in exactly the case Experiment #10's premise described as ambiguous. No
runtime-enforced timeout exists or was added — a `running` effect can still remain `running`
indefinitely — but that is now explicit, documented policy (spec 8.2 §24) rather than an
unstated gap, which is what O1 requires: clear observability of the states that exist, not a
promise about states 0.8.2 deliberately does not introduce.

---

## Verification

```
npm run build   # clean across all 9 workspaces
npm test        # 750 passed, 0 failed (agent-api 53, compiler 139, core 175, demo 156,
                 # runtime 19, server 129, ui-toolkit 79); browser-dialog tests still skip —
                 # Chromium unavailable in this sandbox, unrelated to 8.2's changes
npm run conformance:generate   # 24 fixtures + manifest; v1 fixtures semantically unchanged
npm run schema:generate        # all four server-ir schemas + protocol; only `release` moved
npm run conformance:run        # scripts/run-conformance.mjs, public-API-only: 24/24 pass
```

Every package manifest was bumped `0.8.1-alpha.1` → `0.8.2-alpha.1` (root, all nine
workspace packages, every pinned inter-package dependency, and `package-lock.json` via
`npm install`), and every `docs/*.md`/`README.md` status line updated to match, per the
packaging rule that a version bump touches every manifest and the documentation-consistency
tests that enforce it. No publish step was run — this is implementation only.
