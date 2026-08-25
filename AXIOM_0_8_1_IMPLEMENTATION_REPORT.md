# Axiom 0.8.1 Implementation Report

Target: `@cynodia/axiom` 0.8.1-alpha.1
Baseline: 0.8.0-alpha.1
Spec: `specs/spec8.1.md` — Integration & Trigger Hardening

## Summary

0.8.1 closes the two P0 defects Experiment #9 found (S3: unenforced integration-query
timeout could wedge a polling trigger forever; S4: a client could forge a system-target
action invocation), plus every P1 item the spec asked for: deterministic/real-host
scheduling parity, rejection of unsupported client triggers, a structured effect-outcome
envelope, and a start on portable `axiom.conformance.v2` fixtures for the integration/
trigger/effect/invocation-source vocabulary. All P2 polish items were also addressed. One
scope reduction from the spec's ask is stated plainly in Q26-29/Q38 below rather than
claimed complete.

Two corrections to the spec's own framing, discovered during implementation:

- §53's claim that the README doc-index omits `INTEGRATIONS.md`/`EFFECTS.md`/
  `TRIGGERS.md`/`EVENTS.md` did not hold against the current repository — all four were
  already listed. No fix was needed there.
- `ExecutionContext.source: 'client' | 'system'` already existed in
  `packages/server/src/host.ts`, correctly computed and threaded through both the client
  and trigger/event invocation paths — it was simply never read by `authorize()`. The P0
  fix was narrower than building new plumbing: wiring up existing, correctly designed but
  inert scaffolding.

---

## Answers to spec §93

**1. What invocation-source vocabulary was chosen?**
`InvocationSource = 'client' | 'system'` (`packages/core/src/nodes.ts`), exposed on
`ActionDef.invocation?: { allowedSources?: readonly InvocationSource[] }`.

**2. Can Actions restrict allowed invocation sources?**
Yes: `invocation: { allowedSources: ['system'] }` (or `['client']`) on any `ActionDef`.

**3. What is the backward-compatible default?**
Absent `invocation` means both sources are allowed
(`DEFAULT_ALLOWED_INVOCATION_SOURCES = ['client', 'system']`) — identical to every
existing 0.8.0 graph's behavior. Confirmed by the full existing 0.8.0 test suite passing
unchanged.

**4. Can anonymous clients invoke system-only Actions?**
No. `checkInvocationSource` runs in `invokeCore`, before `authorize()`, before any
argument-driven work and before any transaction opens. It refuses with
`SERVER_DIAGNOSTIC_CODES.INVOCATION_SOURCE_NOT_ALLOWED`; state is unchanged, nothing is
logged as a mutation, no effect or event fires. Tested in
`packages/server/test/integrations.test.ts` and end-to-end over real HTTP in
`packages/demo/test/device-monitor.test.ts`.

**5. Can authenticated clients invoke system-only Actions?**
No. The check is on `context.source`, not identity — an authenticated client's request
still carries `source: 'client'`. `allowedSources: ['system']` refuses it regardless of who
authenticated. (An application that *wants* an authenticated administrator to also be able
to call it can declare `allowedSources: ['client', 'system']` — the default — and add an
`authorization` rule; the two mechanisms compose rather than one subsuming the other.)

**6. Can a client forge system source in protocol data?**
No. `InvokeRequest`/`EventRequest` carry no `source` field to forge — the server hardcodes
`source: 'client'` in `invoke()` and `source: 'system'` in `invokeSystem()`, never reading
either from client input. A hostile-protocol-data test
(`'a client cannot forge system source through protocol data'`) sends a raw object with an
extra `source: 'system'` property and confirms it is silently ignored.

**7. Can webhook target Actions be protected?**
Yes — `device-monitor.ts`'s `action_apply_status_change` (the webhook-delivered
status-change handler) now declares `invocation: { allowedSources: ['system'] }`.
Demonstrated end-to-end over real HTTP (valid signed webhook accepted; forged direct
`InvokeRequest` refused) in `device-monitor.test.ts`.

**8. Can effect-result Actions be protected?**
Yes — the same demo's `action_apply_effect_message` (the reboot effect's
succeeded/failed-event handler) is likewise `allowedSources: ['system']`.

**9. Is invocation source available to authorization expressions?**
No, deliberately not (per spec §9's guidance). The `ActionDef.invocation` policy is the
primary, structural trust-boundary mechanism; no reserved `EXECUTION_SOURCE` expression
reference was added, so an author never has to write an authorization expression merely to
mark an action system-only.

**10. What static validation exists for trigger/action source mismatch?**
`TRIGGER_TARGET_SOURCE_MISMATCH` (`packages/core/src/validate-authority.ts`): every
`TriggerDef` — any kind, since a trigger always invokes with `source: 'system'` — is
checked against its target's `allowedInvocationSources`; a target that excludes `'system'`
is rejected at validation, because the trigger could never succeed. A companion structural
check, `INVALID_INVOCATION_SOURCE`, rejects a declared-but-empty `allowedSources` array.

**11. Who enforces integration-query timeout?**
The Axiom runtime itself — `queryWithTimeout` in `packages/server/src/server.ts` races
`adapter.query(...)` against a `host.scheduleOnce(timeoutMs, ...)` deadline via
`Promise.race`.

**12. Does timeout depend on adapter cooperation?**
No. An adapter that never resolves is bounded by the runtime regardless. (An adapter MAY
still race its own deadline internally — `createHttpIntegrationAdapter` already did, via
`AbortController` — as an optimization, never a correctness requirement.)

**13. Does the adapter receive cancellation/deadline context?**
Unchanged from 0.8.0: `{ timeoutMs }` for a query, `{ idempotencyKey }` for an effect. No
new cancellation signal was added to the adapter interface or the IR — kept deliberately
minimal, since the runtime's own enforcement (Q11-12) is what a graph author can rely on
regardless of adapter cooperation, and adding an abstract cancellation capability was
explicitly optional per spec §18.

**14. What happens to late query results?**
Discarded. `queryWithTimeout`'s `finally` block cancels the timer (a no-op if it already
fired) and attaches `.catch(() => undefined)` to the adapter promise so a late
resolution/rejection is never read again and never produces an unhandled rejection. Since
`integration-query` resolves pre-transaction, a discarded late result structurally cannot
mutate state or fire a follow-up action. Verified by
`'a late adapter result does not mutate state or fire twice'`.

**15. Can a timeout wedge a polling trigger?**
No. Verified by `'a timeout does not wedge a polling trigger: the next tick still runs'`
(`packages/server/test/timeout-and-scheduling.test.ts`): a hung query times out, `inFlight`
clears, and the next scheduled tick runs normally rather than being skipped as a permanent
overlap.

**16. Does polling resume afterward?**
Yes, confirmed by the same test — a second tick after the first's timeout also completes
(and itself times out cleanly, proving the recovery is not a one-time fluke).

**17. Does `createFakeIntegrationAdapter` expose context?**
Yes — its `query`/`effect` callbacks now receive `context` as a third parameter (the same
`{ timeoutMs }`/`{ idempotencyKey }` shape the real `IntegrationAdapter` interface passes),
additive and backward compatible (existing two-parameter test callbacks are still valid
JavaScript/TypeScript function values).

**18. Does deterministic-host behavior match real-host behavior for same-period triggers?**
Yes. `'three same-period triggers commit all three under the deterministic host'` and
`'...under the real host too'` (`timeout-and-scheduling.test.ts`) run the identical graph —
three one-shot `delay` triggers all due at the same simulated instant — under
`createDeterministicServerHost().advance()` and under `createServerHost()` with real
timers, and assert the same outcome on both: all three commit, zero spurious
`CONCURRENCY_CONFLICT`s.

**19. What deterministic ordering rule was chosen?**
Every invocation this authority runs — an ordinary client request or a trigger tick — is
now serialized through the same FIFO queue `AxiomServer.handle()` already used only for
client requests (`packages/server/src/triggers.ts`'s `tick()` wraps just the actual
invocation, not the overlap bookkeeping around it, in that same `serialize()`; effect
outcome dispatch, a second genuinely independent entry point, gets its own turn in the same
queue). `DeterministicServerHost.advance()`'s existing due-time-then-registration-order
firing is unchanged; what changed is that firing several due triggers no longer lets their
*invocations* race each other's commit — each now waits its turn, exactly as staggered
real timer callbacks incidentally already tended to.

**20. Are client triggers implemented or rejected?**
Rejected, per spec §33's preferred minimal option. The browser trigger runtime implements
no kind at all; `BROWSER_TRIGGER_CAPABILITIES.supportedTriggerKinds` is `[]`
(`packages/runtime/src/runtime-types.ts`), and `validateGraph`/`compileToIR` now reject a
client-authority trigger of any kind with `CLIENT_TRIGGER_UNSUPPORTED` — the same
capability-gate pattern `RendererCapabilities` already applies to UI node kinds.

**21. Can an unsupported client trigger validate silently?**
No — confirmed by `packages/compiler/test/trigger-capabilities.test.ts` and
`packages/core/test/invocation-source.test.ts`. Before 8.1 such a trigger validated,
compiled into `ApplicationIR.triggers`, and simply never fired; it is now a compile-time
`GraphValidationError`.

**22. What structured effect-failure payload was chosen?**
`effectOutcomeEntity(id, resultType)` (`packages/core/src/effect-outcome.ts`) — **one**
shared entity shape covers both a succeeded and a failed dispatch, not a distinct entity
per outcome: field ids are graph-global (like `GROUP_KEY_FIELD`/`GROUP_ITEMS_FIELD`), so two
entities could not both declare `effectId`/`integrationId`/`operationId` without
colliding. Reserved fields: `EFFECT_ID_FIELD`, `EFFECT_INTEGRATION_ID_FIELD`,
`EFFECT_OPERATION_ID_FIELD` (always present), `EFFECT_IDEMPOTENCY_KEY_FIELD`/
`EFFECT_CORRELATION_ID_FIELD` (present when available), and either `EFFECT_RESULT_FIELD`
(success) or `EFFECT_CODE_FIELD`/`EFFECT_MESSAGE_FIELD`/`EFFECT_RETRYABLE_FIELD` (failure).

**23. Can follow-up Actions correlate failure without text parsing?**
Yes, via `EFFECT_ID_FIELD`/`EFFECT_OPERATION_ID_FIELD` on the structured payload — no more
`"<code>: <message>"` string to parse.

**24. Were success payload semantics changed?**
Yes, deliberately, for the symmetry spec §40 asks about: success now also carries the
envelope (`EFFECT_ID_FIELD`/`EFFECT_OPERATION_ID_FIELD`/etc.) wrapping the operation's own
result in `EFFECT_RESULT_FIELD`, rather than staying a bare unwrapped value while only
failure gained structure. `device-monitor.ts` and `integrations.test.ts` were updated
accordingly (trigger argument mappings now extract `EFFECT_RESULT_FIELD`/
`EFFECT_MESSAGE_FIELD` instead of binding the whole former payload).

**25. Which server contract version represents the new semantics?**
`axiom.server.v4` (`SERVER_IR_CONTRACTS` extended in `packages/core/src/server-ir.ts`,
`SERVER_IR_LATEST_CONTRACT` moved to it). Computed, never asserted by hand:
`usesV4Semantics(ir)` is true when any action's `invocation.allowedSources` is a genuine
subset of the two-source default, **or** any `integration-operation` has `mode: 'effect'`
(since every effect dispatch now uses the structured envelope). A merely-present but
non-restrictive `invocation` field (e.g. an author writing out the default explicitly)
only requires `axiom.server.v2` (`usesInvocationVocabulary`), the same tier
`group`/`expression-ref` already occupy — so a document is never bumped for vocabulary it
does not actually use. `axiom.server.v1` remains byte-frozen; `understatedContract` in
`packages/server/src/server.ts` was updated in lockstep so the authority still refuses a
document that understates its own contract.

**26. Were portable integration fixtures added?**
Yes — a new `axiom.conformance.v2` fixture-format extension (`externalAdapters` + `steps`,
data-only, no executable code) plus five fixtures:
`integration-query-success`, `integration-query-timeout`, `timed-trigger-polling`,
`effect-success-event`, `system-only-action-rejects-client`
(`packages/server/conformance/*.json`, generated by `scripts/conformance.mjs`).

**27. Can fixtures express timeout/hanging adapter behavior?**
Yes — `{ "neverSettle": true }` in a scripted response models a non-cooperating adapter;
`integration-query-timeout` exercises it.

**28. Can fixtures express retry sequences?**
The mechanism supports it structurally — `externalAdapters[integrationId].query`/`effect`
is an ordered list of responses, consumed one per call (the last repeats once exhausted),
so a "fail once, then succeed" sequence is directly expressible — but no fixture
exercising a *retry* sequence specifically was added in this pass. Scope reduction, stated
here rather than silently skipped (see Q39).

**29. Does the TypeScript runtime pass all fixtures exactly?**
Yes — all 15 fixture files plus the 4 suite-level tests (19 tests total in
`conformance.test.ts`) pass, including every pre-existing v1 fixture unchanged.

**30. Did v1 fixtures remain unchanged?**
Yes, byte-identical — confirmed via `git diff --stat` after regeneration: all ten original
`.json` fixture files show zero diff; only `manifest.json` (its `release` field and new
entries) changed.

**31. Did README/doc index get fixed?**
No fix was needed — investigated first and found `README.md`'s documentation map already
lists `INTEGRATIONS.md`, `EFFECTS.md`, `TRIGGERS.md` and `EVENTS.md` (spec §53's premise
did not hold against the current repository).

**32. Was stale ANTI_PATTERNS guidance fixed?**
Yes — item 30 no longer says "external effects are deliberately unsolved in 0.6... future
work"; it now points to `IntegrationDef` + `integration-query`/`integration-effect`.

**33. Can `serveAxiomApplication` host webhooks directly?**
Yes — `AxiomApplicationOptions` gained `webhooks?: Record<string, WebhookConfig>` (and
`integrations?: Record<NodeId, IntegrationAdapter>`, without which no 0.8 application using
integrations could even `start()` through this API at all). Both are forwarded to
`createAxiomServer`/`serveOverHttp` internally.

**34. Is `RunningNodeHost` URL naming clarified?**
Yes — `url`'s doc comment now states it is the semantic `POST` endpoint
(`http://127.0.0.1:<port><path>`, `/axiom` by default), explicitly distinct from
`RunningAxiomApplication.pageUrl`.

**35. Is retryable behavior documented as control flow?**
Yes — `docs/EFFECTS.md`'s Retry section now states plainly that
`IntegrationFailure.retryable: false` stops the remaining retry policy immediately
regardless of `maxAttempts`, not merely descriptive metadata.

**36. Was `getWebhookEvents` clarified/renamed?**
No — reviewed but not changed in this pass. The naming ambiguity spec §75-77 raises (an
event returned by `getWebhookEvents()` may in fact be an effect-outcome event, since
"webhook-ness" is not a pure graph property) still stands. Listed as a remaining limitation
(Q39).

**37. How many total tests pass?**
730 across the seven test-bearing packages (agent-api 52, compiler 137, core 175, demo 154,
runtime 19, server 114, ui-toolkit 79), all passing; 9 of the demo package's tests are
browser-dialog conformance tests skipped in this environment because the Playwright
Chromium binary is not installed here (`npx playwright install` was not run — a sandbox
constraint, not a code issue; none of the 8.1 changes touch focus/DOM/dialog code). Zero
failures.

**38. Did the focused external consumer re-run find S3/S4 defects?**
Not performed in this pass. Spec §80-81 calls for an independently-run blind agent from a
fresh project/context; that is a separate exercise from a single implementation session
and was not conducted here. This is listed as a remaining gap (Q39), not claimed done.

**39. What are the five largest remaining limitations?**
1. Portable `v2` fixture coverage is partial: 5 of the 15 scenarios spec §47 lists are
   covered (query success/timeout, trigger polling, effect success, invocation-source
   rejection). Missing: a retry-sequence fixture, effect-survives-restart, rolled-back
   action produces no effect, effect failure event, event payload validation, webhook-
   derived event at the semantic layer, and the event-depth guard — all as *fixtures*
   specifically (their behavior is already covered by ordinary TypeScript tests in
   `integrations.test.ts`/`device-monitor.test.ts`; they are just not yet expressed as
   portable, language-independent JSON).
2. Effect execution has no runtime-enforced timeout — only integration queries do (spec
   §25 explicitly asked this be reviewed separately rather than assumed identical, and it
   was reviewed and deliberately left unenforced this round; an effect adapter that never
   resolves will hold that effect's retry attempt open indefinitely).
3. `getWebhookEvents()`'s naming ambiguity (Q36) is unresolved.
4. No independent blind external-consumer re-run was performed (Q38) — the S3/S4-fixed
   claim rests on this session's own adversarial tests, not a fresh, uninformed agent.
5. No reserved `EXECUTION_SOURCE` expression exists (Q9) — an author cannot write
   source-conditional logic *inside* an authorization expression; the `ActionDef.invocation`
   policy is the only mechanism, which was a deliberate simplicity trade-off but is a real
   expressiveness ceiling if a future use case needs finer-grained, expression-level source
   logic.

**40. Is the integration/trigger contract ready for Rust?**
Provisionally yes for the hardened core semantics — invocation source, runtime-enforced
timeout, deterministic/real-host scheduling parity, and the structured effect envelope are
now well-defined, tested from both the client-request and trigger-tick paths, and (for five
representative scenarios) expressed as portable JSON with a documented, language-agnostic
scripted-adapter format. It is **not** unconditionally ready in the strictest sense the
spec's release-classification gate implies: fixture coverage of the full v3/v4 vocabulary is
partial (Q26-29, Q39.1) and no independent blind re-run has confirmed the hardening from
outside this implementation session (Q38, Q39.4). See Release Classification below.

---

## Release Classification (spec §94)

**B — HARDENED WITH NON-BLOCKING LIMITATIONS.**

Every S3/S4 defect Experiment #9 found is fixed and covered by dedicated regression tests:
direct system-action forgery (0), hung-query wedge (0), silent client-trigger inertness (0),
deterministic-only conflicts (0), effect-failure text parsing (0). The remaining gaps —
partial v2 conformance fixture coverage, no independent blind consumer re-run, effect
timeouts left unenforced by design this round, `getWebhookEvents` naming — are S1/S2/
documentation/tooling in character, not defects that let ordinary integration/event/timer
usage silently misbehave or go unsecured. None of them regress a guarantee 0.8.0 made;
several of them are net-new hardening on top of it (deterministic/real-host parity,
`serveAxiomApplication` webhook hosting, `close()` now stopping the authority's own
triggers — see below).

---

## Incidental fix found and corrected

While writing the real-HTTP webhook regression test, `serveOverHttp`'s (and by extension
`serveAxiomApplication`'s) `close()` was found to close only the HTTP listener, never the
underlying `AxiomServer` — leaving any registered interval/delay trigger's real
`setInterval`/`setTimeout` running forever after "shutdown," a resource leak (and, in a
test harness, a process that never exits). `close()` now also calls `server.stop()`.
Confirmed safe: `AxiomServer.stop()` was already the exact operation the existing
restart-testing pattern elsewhere in the suite depends on (stop, then start a fresh
`AxiomServer` against the same persistence).

## Verification

```
npm run build   # clean across all 9 workspaces
npm test        # 730 passed, 0 failed, 9 skipped (Chromium unavailable in this sandbox)
npm run conformance:generate   # v1 fixtures byte-identical; 5 new v2 fixtures added
npm run schema:generate        # v1-v3 schemas unchanged except the additive, v1-excluded
                                # `invocation` property; new server-ir.v4.schema.json
```

Every package manifest was bumped `0.8.0-alpha.1` → `0.8.1-alpha.1` (root, all nine
workspace packages, every pinned inter-package dependency, and `package-lock.json` via
`npm install`), per the packaging rule that a version bump touches every manifest. No
publish step was run — this is implementation only.
