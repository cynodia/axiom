# Axiom 0.8.1 Specification
## Integration & Trigger Hardening

Status: implementation / hardening specification
Target: @cynodia/axiom 0.8.1
Baseline: @cynodia/axiom 0.8.0-alpha.1
Primary evidence:
External Consumer Experiment #9
AXIOM_EXPERIMENT.md
AXIOM_FRICTION_LOG.md

Primary objective:

Harden the 0.8 integration/effect/trigger/event model based on adversarial external-consumer
findings.

0.8.1 MUST NOT broaden the external-integration feature set significantly.

The release exists to close semantic gaps where a valid 0.8 graph can currently:

    violate the intended trust boundary;
    silently wedge timed execution;
    declare client triggers that never execute;
    produce test-runtime behavior inconsistent with the real runtime;
    force text parsing for effect failure correlation;
    lack portable conformance fixtures for the new server vocabulary.

The release should make the existing 0.8 model robust enough to freeze as a cross-runtime
semantic contract.


===============================================================================
1. RELEASE INTENT
   ===============================================================================

Experiment #9 demonstrated:

    integrations are discoverable;
    query/effect separation is useful and learnable;
    external effects can be represented without application fetch();
    interval polling can be represented without setInterval();
    webhook delivery can be represented without bespoke application HTTP handlers;
    transactional outbox behavior survives restart;
    retries and idempotency work;
    AgentAPI exposes meaningful external-dependency relationships.

However, Experiment #9 classified the release:

    C — IMPORTANT SEMANTIC GAPS

because it found:

    S4 — system-trigger actions can be forged as anonymous client invocations;
    S3 — integration-query timeoutMs is not enforced by the runtime and can permanently
         wedge a polling trigger.

0.8.1 must eliminate these defects before further feature expansion.


===============================================================================
2. NON-GOALS
   ===============================================================================

Do NOT use 0.8.1 to add:

- cron/calendar scheduling;
- distributed scheduler coordination;
- Kafka/RabbitMQ;
- workflow orchestration;
- saga engine;
- multi-instance trigger ownership;
- durable webhook deduplication at arbitrary scale;
- provider-specific SDK packages;
- additional integration providers;
- generic compensation semantics;
- new UI toolkit patterns;
- Rust runtime implementation.

0.8.1 is semantic hardening.


===============================================================================
3. P0 — INVOCATION SOURCE MUST BE AUTHORITATIVE
   ===============================================================================

Experiment #9 found that:

    a genuine system-trigger invocation

and:

    an anonymous client InvokeRequest

both reach action authorization with:

    principal = null

The runtime does track:

    source = 'system'

but that fact is currently observational only and cannot be enforced through graph semantics.

Therefore an Action intended only for:

    webhook events;
    timer triggers;
    effect-success events;
    effect-failure events;

can be invoked directly by an anonymous client if the client knows the action id.

This is a trust-boundary defect.


===============================================================================
4. INTRODUCE INVOCATION SOURCE SEMANTICS
   ===============================================================================

Introduce a server-computed, client-unforgeable invocation source concept.

At minimum distinguish:

    client
    system

Prefer a vocabulary capable of future refinement:

    client
    interval-trigger
    lifecycle-trigger
    event-trigger
    webhook
    effect-result
    system

but do not expose unnecessary distinctions unless they are semantically stable.

The client MUST NOT be able to supply or override this value.


===============================================================================
5. ACTION INVOCATION POLICY
   ===============================================================================

Add an explicit ActionDef-level policy.

Preferred shape conceptually:

    invocation: {
        allowedSources: ['client', 'system']
    }

or:

    allowedInvocationSources

or an equivalent strongly typed representation.

Default MUST preserve existing behavior.

Recommended default:

    ['client', 'system']

for backward compatibility.


===============================================================================
6. SYSTEM-ONLY ACTIONS
   ===============================================================================

The graph must be able to declare:

    system-only Action

Conceptually:

    allowedInvocationSources: ['system']

A client InvokeRequest naming this Action MUST be rejected before ordinary Action execution.

Expected result:

    structured diagnostic
    state unchanged
    no mutation log commit
    no external effect
    no event dispatch


===============================================================================
7. CLIENT-ONLY ACTIONS
   ===============================================================================

Support:

    allowedInvocationSources: ['client']

where useful.

A timer/event/system trigger targeting such an Action must be rejected either:

    statically by validation

or:

    at invocation with a precise diagnostic

Prefer static validation when trigger/action relationships are known.


===============================================================================
8. INVOCATION SOURCE IS NOT PRINCIPAL
   ===============================================================================

Keep:

    identity
    invocation source

as separate concepts.

A system-triggered Action may have:

    principal = null
    source = system

A client request may have:

    principal = null
    source = client

Do not overload PRINCIPAL to solve source semantics.


===============================================================================
9. OPTIONAL EXECUTION SOURCE EXPRESSION
   ===============================================================================

Evaluate whether a reserved semantic reference such as:

    EXECUTION_SOURCE

should be available to authorization/precondition expressions.

If added, it MUST be:

    server-computed
    read-only
    impossible for client arguments to shadow
    documented as security-relevant semantic input.

However, an Action-level allowedSources policy should remain the primary trust-boundary
mechanism.

Do not require every application author to write an authorization expression merely to mark an
Action system-only.


===============================================================================
10. WEBHOOK SECURITY REGRESSION
    ===============================================================================

Required test:

    EventDef deviceStatusChanged
        ↓
    TriggerDef event → applyDeviceStatusChanged

Declare:

    applyDeviceStatusChanged = system-only

Then verify:

A. valid signed webhook:
accepted
event dispatched
Action runs
state changes

B. invalid webhook:
rejected before event dispatch

C. anonymous direct InvokeRequest:
rejected

D. authenticated ordinary client direct InvokeRequest:
rejected unless policy explicitly allows it


===============================================================================
11. EFFECT-RESULT ACTION REGRESSION
    ===============================================================================

Actions triggered by:

    succeededEventId
    failedEventId

must be capable of being system-only.

A client must not be able to forge:

    fake effect success
    fake effect failure

by directly invoking the target Action.


===============================================================================
12. INVOCATION SOURCE VALIDATION
    ===============================================================================

Add validation codes for invalid source configuration.

Examples:

    TRIGGER_TARGET_SOURCE_MISMATCH
    INVALID_INVOCATION_SOURCE

Exact names may follow existing conventions.

Validation should detect:

    system trigger → client-only Action

where statically knowable.


===============================================================================
13. AGENTAPI INVOCATION SOURCE QUERIES
    ===============================================================================

Extend semantic inspection sufficiently for an agent to ask:

    Is this Action client-invocable?
    Is this Action system-only?
    Which system-only Actions exist?
    Which triggers target client-incompatible Actions?

Exact API naming should remain consistent with GraphQueries.


===============================================================================
14. DOCUMENT LOAD-BEARING SECURITY INVARIANT
    ===============================================================================

AGENT_REFERENCE must state prominently:

    INVOCATION SOURCE INVARIANT

    A system-originated invocation and an anonymous client invocation are distinct
    authoritative facts.

    Client requests cannot forge system source.

    Actions may restrict allowed invocation sources independently of caller identity.


===============================================================================
15. P0 — RUNTIME-ENFORCED INTEGRATION QUERY TIMEOUT
    ===============================================================================

Experiment #9 found:

    integration-query.timeoutMs

is passed to the IntegrationAdapter but is not enforced by the runtime.

A non-cooperating adapter may return a Promise that never settles.

Consequences:

    query invocation hangs forever;
    interval trigger remains permanently "in flight";
    overlap:'skip' discards every future polling tick;
    the application silently stops refreshing.


===============================================================================
16. TIMEOUT OWNERSHIP
    ===============================================================================

Change the contract:

    timeoutMs is enforced by Axiom runtime/server.

Adapter cooperation is optional optimization.

Runtime correctness MUST NOT depend on adapter correctness.


===============================================================================
17. QUERY DEADLINE
    ===============================================================================

For an integration-query with:

    timeoutMs = N

the server must guarantee the semantic invocation settles after approximately N runtime-clock
milliseconds with:

    failure / diagnostic = INTEGRATION_TIMEOUT

or equivalent.

The adapter's unresolved Promise may continue internally if cancellation is impossible, but it
must no longer hold the semantic Action/Trigger in-flight.


===============================================================================
18. ADAPTER CANCELLATION CONTEXT
    ===============================================================================

Optionally extend IntegrationAdapter context with:

    signal
    deadline
    timeoutMs

where:

    signal

is an abstract cancellation capability or runtime-specific adapter input.

Do not place AbortController or AbortSignal in Server IR.

If the TypeScript adapter API uses AbortSignal, document that as host/API implementation detail,
not semantic IR.


===============================================================================
19. TIMEOUT MUST USE HOST CLOCK
    ===============================================================================

Timeout enforcement must use:

    ServerHost time/scheduling abstraction

rather than raw:

    setTimeout()

inside semantic runtime logic.

This is required for deterministic tests and future runtimes.


===============================================================================
20. TIMEOUT OUTCOME
    ===============================================================================

After runtime timeout:

    Action must settle
    trigger in-flight marker must clear
    future interval ticks must remain healthy
    no state update from the timed-out query may commit later

If the adapter eventually resolves after the timeout, that late result MUST be ignored
semantically.


===============================================================================
21. LATE RESULT TEST
    ===============================================================================

Required test:

    timeoutMs = 1000
    adapter resolves after 5000

At t=1000:

    Action has failed with INTEGRATION_TIMEOUT

At t=5000:

    late adapter result does NOT mutate state
    no follow-up Action runs
    no duplicate diagnostics corrupt current state


===============================================================================
22. WEDGED TRIGGER REGRESSION
    ===============================================================================

Required scenario:

    interval = 5s
    first adapter call never settles
    timeoutMs = 4s
    overlap = skip

Expected:

    t=5  first query begins
    t=9  query times out
    trigger becomes idle
    t=10 or next defined tick:
          another invocation may execute

The polling trigger must not remain wedged forever.


===============================================================================
23. FAKE ADAPTER CONTEXT
    ===============================================================================

Update:

    createFakeIntegrationAdapter

so its callbacks receive the same documented query/effect context available to the raw
IntegrationAdapter.

Tests must be able to inspect:

    timeoutMs
    idempotency key
    cancellation/deadline context where applicable

without dropping to the raw adapter interface.


===============================================================================
24. TIMEOUT DOCUMENTATION
    ===============================================================================

Update docs to state unambiguously:

    Axiom runtime enforces timeoutMs.

Adapters MAY use context to cancel provider work early.

They MUST NOT be responsible for guaranteeing semantic timeout completion.


===============================================================================
25. EFFECT TIMEOUTS
    ===============================================================================

Review effect execution separately.

Do not automatically copy integration-query semantics if effect timeout behavior differs.

If effect attempts have provider-call deadlines, define them explicitly as EffectRunner attempt
semantics.

Do not imply cancellation means the external provider definitely did not perform the effect.


===============================================================================
26. P1 — DETERMINISTIC SERVER HOST FIDELITY
    ===============================================================================

Experiment #9 found:

    createDeterministicServerHost().advance()

may fire several simultaneously-due triggers in a way that creates
CONCURRENCY_CONFLICT results not observed under createServerHost() with the same graph and
timing.


===============================================================================
27. DETERMINISTIC SCHEDULER CONTRACT
    ===============================================================================

The deterministic host must model the same scheduling semantics as the real reference host unless
a documented difference is unavoidable.

For simultaneously due callbacks:

    define deterministic execution ordering.

Preferred:

    due callbacks execute in stable registration order

and:

    each scheduled callback's returned async work is allowed to reach the same scheduling boundary
    as production before the next callback is dispatched.


===============================================================================
28. DO NOT HIDE REAL CONCURRENCY
    ===============================================================================

Be careful not to "fix" the deterministic host by making all application execution globally
serial if the real host genuinely permits concurrency.

The goal is fidelity, not artificial simplification.

Write side-by-side conformance tests between:

    deterministic host
    real host

for representative trigger schedules.


===============================================================================
29. SAME-PERIOD MULTI-TRIGGER TEST
    ===============================================================================

Graph:

    3 Device refresh triggers
    same interval
    same authoritative collection

Compare:

    deterministic host
    real host

Expected:

    same semantic outcomes
    no deterministic-only CONCURRENCY_CONFLICT


===============================================================================
30. DETERMINISTIC ORDER DOCUMENTATION
    ===============================================================================

Document ordering sufficiently for tests to be reproducible.

Avoid relying on incidental JS Map iteration or Promise microtask behavior as semantic contract.


===============================================================================
31. P1 — CLIENT TRIGGERS MUST NOT BE SILENTLY INERT
    ===============================================================================

Experiment #9 confirmed:

    client-authority interval TriggerDef
        validates 0/0
        compiles into ApplicationIR.triggers
        browser runtime never executes it

This violates Axiom's no-silent-semantic-failure principle.


===============================================================================
32. CHOOSE ONE 0.8.1 CLIENT-TRIGGER POLICY
    ===============================================================================

Choose exactly one:

A. IMPLEMENT CLIENT TRIGGERS

or:

B. REJECT UNSUPPORTED CLIENT TRIGGERS


Do not retain:

    valid + compiled + inert.


===============================================================================
33. PREFERRED MINIMAL 0.8.1 OPTION
    ===============================================================================

If browser trigger execution is not ready, prefer:

    validation error

for unsupported client trigger kinds.

Possible diagnostic:

    CLIENT_TRIGGER_UNSUPPORTED

This is preferable to a warning because the declared semantics cannot execute.


===============================================================================
34. IF CLIENT TRIGGERS ARE IMPLEMENTED
    ===============================================================================

If implementing them instead, support only the kinds whose lifecycle can be specified correctly.

At minimum define for each supported kind:

    interval
    delay
    application/runtime lifecycle
    route-enter
    route-leave

the:

    start point
    lifetime
    route scoping
    suspension behavior
    overlap behavior
    cleanup behavior


===============================================================================
35. BROWSER TIMER SEMANTICS
    ===============================================================================

Do not promise wall-clock precision in suspended/background browser tabs.

If client interval triggers are implemented, define semantics in terms of:

    runtime scheduling opportunities

not guaranteed exact real-time firing.


===============================================================================
36. CLIENT TRIGGER VALIDATION
    ===============================================================================

Validation/compiler must know which trigger kinds the selected runtime supports.

This should align with the renderer/runtime capability philosophy introduced for UI kinds.


===============================================================================
37. P1 — STRUCTURED EFFECT FAILURE EVENT
    ===============================================================================

Experiment #9 found:

    failedEventId payload is currently a string:

        "<code>: <message>"

This forced the consumer to identify the failed Device using substring matching.


===============================================================================
38. EFFECT FAILURE PAYLOAD TYPE
    ===============================================================================

Introduce a canonical structured effect failure payload.

Conceptually:

    EffectFailure {
        effectId
        integrationId
        operationId
        code
        message
        retryable
        idempotencyKey?
        arguments?          // only if safe / appropriate
        correlationId?
    }

Do not require all fields if they create security or serialization problems.


===============================================================================
39. CORRELATION IDENTITY
    ===============================================================================

At minimum, a failure follow-up Action must have a robust semantic way to correlate the failure to
the original domain operation.

Preferred fields:

    effectId
    operationId
    idempotencyKey or correlation value

Avoid free-text parsing.


===============================================================================
40. EFFECT SUCCESS PAYLOAD
    ===============================================================================

Review success-event payload symmetry.

Current success event receives provider result.

Determine whether it also needs metadata envelope:

    effectId
    operationId
    result
    correlation

If changing this would break compatibility, consider a structured EffectOutcome envelope for both
success/failure under the new server contract version.


===============================================================================
41. NO SECRET LEAKAGE
    ===============================================================================

Structured failure payload must not expose:

    credentials
    Authorization headers
    provider secrets
    raw unsafe error objects

Use diagnostic-safe translated data only.


===============================================================================
42. P1 — PORTABLE V3 CONFORMANCE FIXTURES
    ===============================================================================

0.8.0 has no portable data-only fixtures for:

    integrations
    integration queries
    effects
    triggers
    events

This is the largest remaining portability gap before an independent Rust runtime experiment.


===============================================================================
43. EXTEND CONFORMANCE FORMAT
    ===============================================================================

Design a v3 fixture format capable of representing external behavior without executable callbacks.

Fixtures should declaratively define fake external adapter behavior.

Conceptual structure:

    {
      graph/serverIR: ...,
      initialState: ...,
      externalAdapters: {
        deviceProvider: {
          scriptedOperations: [...]
        }
      },
      clock: {...},
      steps: [...],
      expected: ...
    }


===============================================================================
44. SCRIPTED QUERY RESPONSE
    ===============================================================================

Fixture vocabulary should express:

    query operation called with X
        → return Y

    query operation called with X
        → fail code Z

    query operation called with X
        → delay N then return Y

    query operation called with X
        → never settle

without TypeScript functions.


===============================================================================
45. SCRIPTED EFFECT RESPONSE
    ===============================================================================

Fixtures should express:

    succeed
    fail retryable
    fail permanent
    delayed success
    sequence:
        first fail
        second succeed


===============================================================================
46. TEST CLOCK FIXTURES
    ===============================================================================

Fixture steps should support deterministic:

    advance time by N
    invoke action
    dispatch event
    restart runtime

No real-time waiting.


===============================================================================
47. REQUIRED V3 FIXTURES
    ===============================================================================

Add at minimum:

1. integration-query success
2. integration-query malformed result
3. integration-query timeout
4. timed trigger polling
5. overlap skip
6. effect committed post-transaction
7. rolled-back action does not produce effect
8. effect retry + stable idempotency key
9. effect survives restart
10. effect success event
11. effect failure event
12. event payload validation
13. system-only action rejects client invocation
14. webhook-derived event → system action semantics at the semantic layer
15. event depth guard


===============================================================================
48. REFERENCE RUNTIME MUST PASS FIXTURES
    ===============================================================================

TypeScript server runtime MUST execute all v3 fixtures exactly.

Make this a release gate.


===============================================================================
49. FIXTURES MUST BE LANGUAGE-INDEPENDENT
    ===============================================================================

A Rust runtime implementer must not need:

    TypeScript callbacks
    Promise behavior
    JS timers
    source implementation

to execute them.


===============================================================================
50. V3 SERVER CONTRACT
    ===============================================================================

Review whether 0.8.1 semantic changes require:

    axiom.server.v4

or whether they can remain v3.

Rule:

    If serialized semantics change incompatibly, bump the contract.

Do NOT silently reinterpret an existing frozen v3 document.


===============================================================================
51. INVOCATION POLICY AND CONTRACT VERSION
    ===============================================================================

If ActionDef allowedInvocationSources is serialized into Server IR and changes execution semantics,
this likely requires a new contract vocabulary.

Compute the contract from actual used vocabulary as before.

Do not bump documents that do not use the new semantics unnecessarily.


===============================================================================
52. EFFECT FAILURE ENVELOPE AND CONTRACT VERSION
    ===============================================================================

Likewise, if failure-event payload semantics change in a way an independent runtime must know,
reflect this in the contract version.


===============================================================================
53. P2 — README DOCUMENT INDEX
    ===============================================================================

Experiment #9 found the facade README documentation table omits:

    INTEGRATIONS.md
    EFFECTS.md
    TRIGGERS.md
    EVENTS.md

Fix it.


===============================================================================
54. DOCUMENTATION INDEX TEST
    ===============================================================================

Avoid another stale hand-maintained list.

Add a docs index consistency test where practical.


===============================================================================
55. P2 — STALE ANTI_PATTERN
    ===============================================================================

Update ANTI_PATTERNS.md item describing external effects as "future work."

New guidance should say:

    do not use NativeOperation for external integration;
    use IntegrationDef + integration-query/effect semantics.


===============================================================================
56. P2 — serveAxiomApplication WEBHOOK SUPPORT
    ===============================================================================

Experiment #9 found the high-level:

    serveAxiomApplication(...)

does not expose webhook configuration, requiring consumers to drop to:

    createAxiomServer
    compileToHtml
    serveOverHttp

for an otherwise standard 0.8 application.


===============================================================================
57. HIGH-LEVEL WEBHOOK HOSTING
    ===============================================================================

Add a webhooks option to serveAxiomApplication, or another equally simple full-stack hosting API.

The standard device-monitor application should be deployable with one high-level host setup.


===============================================================================
58. ZERO APPLICATION WEBHOOK ROUTES
    ===============================================================================

After the fix, the reference/consumer application should require:

    custom webhook HTTP handlers = 0
    manual server composition only for ordinary webhook use = 0


===============================================================================
59. P2 — RunningNodeHost URL CLARITY
    ===============================================================================

Clarify:

    url

if it means semantic endpoint URL.

Consider exposing:

    endpointUrl
    origin
    pageUrl

with unambiguous semantics.


===============================================================================
60. BACKWARD COMPATIBILITY
    ===============================================================================

Existing 0.8.0 graphs should continue to work.

Default Action invocation policy must preserve ordinary current behavior.

Do not retroactively mark existing event-target Actions system-only automatically unless it can be
done without changing intentional behavior.


===============================================================================
61. OPTIONAL VALIDATION ADVICE
    ===============================================================================

Consider a warning for:

    Action targeted only by system triggers
    but still client-invocable

Example:

    SYSTEM_TRIGGER_ACTION_CLIENT_INVOKABLE

This may be valuable even when default policy remains backwards-compatible.


===============================================================================
62. DO NOT AUTO-SECURE BY HEURISTIC
    ===============================================================================

Do not automatically infer:

    "this Action is only referenced by TriggerDef, therefore systemOnly"

without explicit semantics.

Graph references can change, and client invocation may be intentional.

Prefer explicit declaration + optional diagnostic advice.


===============================================================================
63. INVOCATION SOURCE OBSERVABILITY
    ===============================================================================

Execution reports/logs should expose:

    source

accurately for:

    client
    interval
    lifecycle
    event
    effect outcome
    webhook-derived event

where supported.


===============================================================================
64. SOURCE PROPAGATION
    ===============================================================================

Ensure source/correlation data propagates correctly through:

    webhook
      → event
      → trigger
      → action

and:

    action
      → effect
      → outcome event
      → trigger
      → follow-up action


===============================================================================
65. SOURCE IS NOT CLIENT-SUPPLIED PROTOCOL DATA
    ===============================================================================

InvokeRequest must not allow a client to write:

    source: 'system'

and gain system semantics.

Any protocol field resembling source is informational only and must be overwritten/ignored by the
authority.


===============================================================================
66. HOSTILE CLIENT TEST
    ===============================================================================

Send raw protocol data attempting to forge:

    principal
    source
    event-origin metadata
    effect-result metadata

Verify authority computes its own trusted context.


===============================================================================
67. QUERY TIMEOUT + AUTHORITY TEST
    ===============================================================================

A timed-out query must not leave:

    a dangling transaction
    a held revision lock
    an in-flight trigger marker
    provisional state


===============================================================================
68. QUERY TIMEOUT + CONCURRENCY TEST
    ===============================================================================

Run:

    slow timed-out poll
    concurrent ordinary user Action

Verify query timeout does not poison future/concurrent authority execution.


===============================================================================
69. EFFECT RUNNER UNCHANGED INVARIANTS
    ===============================================================================

All previous 0.8 guarantees must remain:

    effects post-commit
    rolled-back transactions produce no effect
    durable outbox
    at-least-once delivery
    idempotency key stability
    retries
    restart resumption
    event depth guard


===============================================================================
70. WEBHOOK VERIFICATION REGRESSION
    ===============================================================================

Retain:

    raw-body verification before decode
    before Event construction
    before Action dispatch.


===============================================================================
71. EVENT PAYLOAD REGRESSION
    ===============================================================================

Retain strict TypeRef validation for external event payloads.


===============================================================================
72. INTEGRATION RESULT REGRESSION
    ===============================================================================

Retain strict result validation including:

    wrong primitive
    missing required field
    extra unexpected entity field

according to current contract.


===============================================================================
73. RETRYABLE DOCUMENTATION
    ===============================================================================

Experiment #9 discovered:

    IntegrationFailure.retryable = false

actually short-circuits the remaining retry policy.

Document this as load-bearing runtime behavior, not merely metadata.


===============================================================================
74. FAKE ADAPTER CONFORMANCE
    ===============================================================================

Ensure the fake adapter can simulate:

    retryable true
    retryable false
    timeout
    malformed response
    hanging call
    delayed result

using only public test APIs.


===============================================================================
75. AGENTAPI getWebhookEvents NAMING
    ===============================================================================

Experiment #9 found:

    getWebhookEvents()

returns events that may also be effect-outcome events because "webhook-ness" is not purely a graph
property.

Review this method.


===============================================================================
76. PREFERRED FIX
    ===============================================================================

Either:

A. rename to something semantically accurate such as:
getExternallyDispatchableEvents / getTriggeredEvents

or:

B. redefine/document exact graph-derived semantics.

Do not imply deployment facts AgentAPI cannot know.


===============================================================================
77. DEPLOYMENT INTROSPECTION
    ===============================================================================

If webhook registration is host/deployment data, do not pretend GraphQueries can infer it from the
graph alone.

Keep graph semantics and deployment configuration distinct.


===============================================================================
78. VALID-BUT-WRONG REGRESSION SUITE
    ===============================================================================

Add permanent tests for all Experiment #9 failure searches:

    client forging system-target Action
    hung query
    late query result
    wedged trigger
    simultaneous deterministic triggers
    client trigger inertness
    effect rollback
    malformed provider result
    trigger authorization


===============================================================================
79. DEFECT SEVERITY TARGET
    ===============================================================================

0.8.1 release target:

    S4 defects = 0
    S3 defects = 0

in the external adversarial scenario.


===============================================================================
80. BLIND EXTERNAL CONSUMER RE-RUN
    ===============================================================================

After implementing 0.8.1, repeat a focused external-consumer test from a fresh project.

Do not reuse the implementation agent's context.


===============================================================================
81. REQUIRED FOCUSED RE-RUN SCENARIOS
    ===============================================================================

The blind agent must independently test:

    webhook-only Action cannot be directly invoked
    effect-result Action cannot be directly invoked
    hung adapter times out
    polling resumes after timeout
    deterministic host matches real host for same-period triggers
    unsupported client trigger cannot silently validate/compile
    effect failure can be correlated without parsing text


===============================================================================
82. ZERO ESCAPE TARGET
    ===============================================================================

Retain:

    application fetch() ................ 0
    application setInterval() .......... 0
    application setTimeout() ........... 0
    bespoke webhook handlers ........... 0
    NativeOperation .................... 0
    provider SDK graph calls ........... 0


===============================================================================
83. PORTABLE CONFORMANCE RELEASE GATE
    ===============================================================================

Before Rust experiment:

    v3/v4 integration semantics must have portable fixtures

and:

    TypeScript reference runtime must pass all of them.


===============================================================================
84. REAL RUNTIME / TEST RUNTIME PARITY GATE
    ===============================================================================

For timed semantics covered by the deterministic host:

    deterministic outcome
        ==
    real-host semantic outcome

for equivalent scenarios, excluding wall-clock timestamps.


===============================================================================
85. DOCUMENTATION GATE
    ===============================================================================

Published docs must agree on:

    timeout ownership
    invocation source
    client trigger support
    effect failure payload
    retryable behavior
    webhook hosting path
    external doc index


===============================================================================
86. PACKAGE GATE
    ===============================================================================

Verify exact packed/published packages from a clean project.

No workspace resolution.


===============================================================================
87. VALIDATION GATE
    ===============================================================================

Reference integration application:

    errors = 0
    warnings = 0

If a client trigger is unsupported, it must not be part of the valid reference application.


===============================================================================
88. SECURITY GATE
    ===============================================================================

At minimum:

    anonymous client cannot invoke system-only Action
    authenticated client cannot invoke system-only Action unless allowed
    client cannot forge execution source
    invalid webhook cannot create trusted Event
    malformed external payload cannot reach Action
    secrets do not leak


===============================================================================
89. TIMEOUT GATE
    ===============================================================================

At minimum:

    non-cooperating query adapter
    declared timeout
    Action settles
    diagnostic returned
    late result ignored
    trigger continues later


===============================================================================
90. DURABILITY GATE
    ===============================================================================

Outbox durability remains unchanged:

    committed effect survives restart
    rolled-back effect intent does not.


===============================================================================
91. CONFORMANCE GATE
    ===============================================================================

Reference runtime passes:

    all previous v1 fixtures
    all v2 fixtures if present
    all newly added integration/trigger/event fixtures

without fixture/runtime disagreement.


===============================================================================
92. CONTRACT FREEZE DECISION
    ===============================================================================

At the end explicitly decide:

    INTEGRATION_TRIGGER_CONTRACT_READY_FOR_CROSS_RUNTIME = yes | no

Answer yes only if:

    system/source semantics are explicit
    timeout semantics are runtime-defined
    client trigger semantics are explicit
    effect outcome payloads are portable
    test clock behavior is specified
    portable fixtures exist


===============================================================================
93. FINAL IMPLEMENTATION REPORT
    ===============================================================================

Produce:

    AXIOM_0_8_1_IMPLEMENTATION_REPORT.md

Answer at minimum:

1. What invocation-source vocabulary was chosen?
2. Can Actions restrict allowed invocation sources?
3. What is the backward-compatible default?
4. Can anonymous clients invoke system-only Actions?
5. Can authenticated clients invoke system-only Actions?
6. Can a client forge system source in protocol data?
7. Can webhook target Actions be protected?
8. Can effect-result Actions be protected?
9. Is invocation source available to authorization expressions?
10. What static validation exists for trigger/action source mismatch?
11. Who enforces integration-query timeout?
12. Does timeout depend on adapter cooperation?
13. Does the adapter receive cancellation/deadline context?
14. What happens to late query results?
15. Can a timeout wedge a polling trigger?
16. Does polling resume afterward?
17. Does createFakeIntegrationAdapter expose context?
18. Does deterministic-host behavior match real-host behavior for same-period triggers?
19. What deterministic ordering rule was chosen?
20. Are client triggers implemented or rejected?
21. Can an unsupported client trigger validate silently?
22. What structured effect-failure payload was chosen?
23. Can follow-up Actions correlate failure without text parsing?
24. Were success payload semantics changed?
25. Which server contract version represents the new semantics?
26. Were portable integration fixtures added?
27. Can fixtures express timeout/hanging adapter behavior?
28. Can fixtures express retry sequences?
29. Does TypeScript runtime pass all fixtures exactly?
30. Did v1 fixtures remain unchanged?
31. Did README/doc index get fixed?
32. Was stale ANTI_PATTERNS guidance fixed?
33. Can serveAxiomApplication host webhooks directly?
34. Is RunningNodeHost URL naming clarified?
35. Is retryable behavior documented as control flow?
36. Was getWebhookEvents clarified/renamed?
37. How many total tests pass?
38. Did the focused external consumer re-run find S3/S4 defects?
39. What are the five largest remaining limitations?
40. Is the integration/trigger contract ready for Rust?


===============================================================================
94. RELEASE CLASSIFICATION
    ===============================================================================

Choose exactly one:

A — HARDENED AND PORTABLE

    The trust boundary, timeout semantics, trigger semantics and portable contract are robust.
    No S3/S4 defects remain in the adversarial integration scenario.

B — HARDENED WITH NON-BLOCKING LIMITATIONS

    Core S3/S4 defects are fixed, but some S1/S2/documentation/tooling gaps remain.

C — IMPORTANT SEMANTIC GAP REMAINS

    One or more ordinary integration/event/timer requirements can still silently misbehave or
    cannot be secured semantically.

D — 0.8 MODEL REQUIRES REDESIGN

    Fixes reveal deeper incompatibility in integration/effect/trigger semantics.


===============================================================================
95. PRIMARY SUCCESS TARGET
    ===============================================================================

Strong target:

    A

with:

    direct system-action forgery ........ 0
    hung query wedge .................... 0
    silent client trigger ............... 0
    deterministic-only conflicts ........ 0
    effect failure text parsing ......... 0
    S3 defects .......................... 0
    S4 defects .......................... 0


===============================================================================
96. CENTRAL RELEASE PRINCIPLE
    ===============================================================================

0.8 proved that Axiom can model:

    time
    integrations
    effects
    events

without falling back to imperative application I/O.

0.8.1 must prove that these semantics remain correct when:

    the client is hostile;
    the external adapter is broken;
    the network never answers;
    triggers overlap;
    tests run under virtual time;
    asynchronous failures must be correlated;
    another runtime needs to implement the same contract.


The target is not merely:

    "the integration works."

The target is:

    "the semantic boundary remains trustworthy even when everything outside Axiom behaves badly."


===============================================================================
97. FINAL RULE
    ===============================================================================

Do not fix Experiment #9 findings by moving responsibility back into application code.

Specifically, do NOT solve them with:

    application network ACL conventions;
    custom timeout wrappers;
    manual polling watchdogs;
    text parsing;
    custom webhook guards;
    custom JavaScript scheduler logic.

If Axiom claims the semantic concept, Axiom must enforce the semantic invariant.