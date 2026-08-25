# Axiom 0.8.2 Specification
## Integration & Trigger Polish / Contract Clarity

Status: implementation / polish specification
Target: @cynodia/axiom 0.8.2
Baseline: @cynodia/axiom 0.8.1-alpha.1

Primary evidence:
    External Consumer Experiment #10
    AXIOM_0_8_1_EXTERNAL_RETEST.md
    AXIOM_0_8_1_FRICTION_LOG.md

Primary objective:

Close the remaining non-blocking friction and portability gaps identified by the blind
0.8.1 external-consumer retest, without expanding the core integration/effect/trigger/event
feature set.

0.8.2 MUST preserve all 0.8.1 hardening guarantees:

    system-only Action trust boundary
    runtime-owned integration-query timeout
    late-result suppression
    polling recovery
    deterministic/real-host scheduling parity
    unsupported client-trigger rejection
    structured effect outcomes
    outbox durability
    retry/idempotency semantics

This release should primarily improve:

    validation consistency
    documentation correctness
    portable conformance coverage
    effect observability
    effect-outcome correlation guidance
    AgentAPI naming clarity


===============================================================================
1. NON-GOALS
===============================================================================

Do NOT add:

- effect timeout semantics;
- unknown-outcome state machine;
- subscriptions / streaming;
- blob/file semantics;
- new trigger kinds;
- cron;
- workflow engine;
- provider SDK abstractions;
- new UI patterns;
- Rust runtime implementation.

Effect timeout remains a deliberate future design topic.


===============================================================================
2. VALIDATION CONSISTENCY — CLIENT TRIGGERS
===============================================================================

Experiment #10 found:

    validateGraph(graph)

with no options can report a client-authority trigger as valid, while:

    compileToIR(graph)

correctly rejects it with:

    CLIENT_TRIGGER_UNSUPPORTED.

This is safe at compile time, but inconsistent for validate-only workflows.


===============================================================================
3. DEFAULT VALIDATION TARGET
===============================================================================

Choose a clear default contract for validateGraph().

Preferred:

    validateGraph(graph)

should validate against the default browser/client runtime capabilities when the graph contains
client-authority UI/runtime semantics.

At minimum, unsupported client triggers must not be silently accepted by the default validation
path used by ordinary consumers.


===============================================================================
4. ALTERNATIVE IF TARGET-NEUTRAL VALIDATION IS RETAINED
===============================================================================

If validateGraph() must remain target-neutral by design, then:

- document this prominently;
- add an explicit helper such as:

      validateForBrowser(graph)

  or equivalent;

- ensure AGENT_REFERENCE uses the target-aware path in examples;
- emit enough metadata/documentation that an agent does not assume target-neutral validation
  guarantees browser executability.


===============================================================================
5. VALIDATION CONTRACT MUST MATCH DOCS
===============================================================================

TRIGGERS.md currently implies validateGraph rejects unsupported client triggers.

After 0.8.2:

    documentation
    default API behavior
    compiler behavior

must agree exactly.


===============================================================================
6. CLIENT_TRIGGER_UNSUPPORTED DIAGNOSTIC
===============================================================================

Improve remediation guidance.

Current message explains:

    what
    where
    why

Add:

    what to do instead

Conceptually:

    "Move this trigger to server-authoritative execution or use a trigger kind supported by the
     selected runtime."


===============================================================================
7. DOCUMENTATION — SERVER CONTRACT TABLE
===============================================================================

Add:

    axiom.server.v4

to AUTHORITY.md's contract-version table.

Document what v4 adds:

    invocation-source restrictions
    structured effect-outcome semantics

or the exact final vocabulary rule.


===============================================================================
8. CONTRACT TABLE MUST BE GENERATED OR TESTED
===============================================================================

Add a documentation consistency test ensuring every value in:

    SERVER_IR_CONTRACTS

is represented in the public contract documentation.

Avoid another stale manually-maintained table.


===============================================================================
9. CONFORMANCE MANIFEST CONTRACT FIELD
===============================================================================

Experiment #10 found the manifest-level:

    "contract": "axiom.server.v1"

is misleading while fixtures include v4 documents.

Choose one:

A. remove the manifest-level contract field;

B. rename it to something semantically precise, e.g.:

       baseContract
       manifestFormatContract

C. set it to the highest Server IR contract represented.

Preferred:

    remove or rename it.

Per-fixture contract remains authoritative.


===============================================================================
10. CONFORMANCE MANIFEST DOCUMENTATION
===============================================================================

Document explicitly:

    fixture.format / conformance format
    fixture.server contract
    manifest version

as separate concepts.

Do not overload "contract" for multiple layers.


===============================================================================
11. PORTABLE FIXTURE COVERAGE
===============================================================================

Expand axiom.conformance.v2 coverage beyond the current five 0.8.x scenarios.

Add portable, pure-JSON fixtures for at least:

1. failed effect structured outcome
2. late query result after timeout
3. late query rejection after timeout
4. authenticated client rejected by system-only Action
5. simultaneous same-instant triggers
6. rolled-back Action produces no effect
7. effect survives restart
8. effect retry sequence with stable idempotency key
9. event payload validation
10. event depth guard


===============================================================================
12. WEBHOOK SEMANTIC FIXTURE
===============================================================================

Add a portable semantic fixture for:

    verified external event
        → EventDef
        → TriggerDef
        → system-only Action

The fixture does NOT need to encode HTTP or cryptographic signature verification if those are host
adapter concerns.

It should encode the semantic boundary after verification.


===============================================================================
13. FIXTURE FORMAT REMAINS DATA-ONLY
===============================================================================

No new fixture may require:

    JavaScript functions
    Promises
    callbacks
    Node timers
    filesystem paths
    source implementation


===============================================================================
14. FIXTURE RUNNER CONTRACT
===============================================================================

Experiment #10 had to write an independent ~230-line runner because no public runner is exported.

Decide whether 0.8.2 should expose a public conformance runner.

Preferred:

    yes

if it can remain generic and useful to a future Rust implementation.


===============================================================================
15. PUBLIC CONFORMANCE RUNNER
===============================================================================

Potential API:

    runConformanceFixture(...)
    runConformanceSuite(...)

or equivalent.

It should accept:

    fixture JSON/data
    runtime implementation hooks where necessary

and return structured pass/fail output.


===============================================================================
16. DO NOT COUPLE RUNNER TO TYPESCRIPT REFERENCE RUNTIME
===============================================================================

If exposed as specification tooling, separate:

    fixture model

from:

    TypeScript reference-runtime adapter.

A non-JS runtime should still be able to consume the fixture contract independently.


===============================================================================
17. EFFECT LOG OBSERVABILITY
===============================================================================

Experiment #10 found a hung effect adapter is genuinely invoked, but:

    effectLog()

continues to report:

    status: pending
    attempts: 0

indefinitely.

This makes:

    not yet dispatched

indistinguishable from:

    dispatched and currently outstanding.


===============================================================================
18. EFFECT RUNNING STATE
===============================================================================

Before invoking an effect adapter, update observable effect state to:

    status: running

and increment:

    attempts

synchronously/durably enough that public observability reflects reality.


===============================================================================
19. EFFECT STATUS CONTRACT
===============================================================================

Document exact statuses:

    pending
    running
    succeeded
    failed

If other statuses exist, document them too.

Clarify:

    pending = durable intent exists, attempt not currently executing
    running = an adapter attempt has been started and has not settled


===============================================================================
20. EFFECT RUNNING PERSISTENCE
===============================================================================

Define restart semantics for an effect persisted as running.

Recommended:

    running from a previous process is treated as resumable/unknown outstanding work and is
    eligible for at-least-once redispatch under existing idempotency semantics.

Do not imply the old process definitely did or did not complete the external side effect.


===============================================================================
21. EFFECT ATTEMPT COUNT
===============================================================================

attempts must count:

    adapter invocation attempts started

not merely:

    attempts that settled.


===============================================================================
22. HUNG EFFECT REGRESSION
===============================================================================

Required test:

    effect intent committed
    adapter invoked
    adapter never settles

Expected public effectLog:

    status = running
    attempts = 1

not:

    pending / 0.


===============================================================================
23. HUNG EFFECT RESTART
===============================================================================

Restart against same persistence with a responsive adapter.

Verify:

    effect resumes safely
    attempts increments appropriately
    idempotency key remains stable
    outcome applies once semantically


===============================================================================
24. EFFECT TIMEOUT REMAINS OUT OF SCOPE
===============================================================================

Do NOT add a deadline merely because running status now exists.

Document explicitly:

    effects have no runtime-enforced timeout in 0.8.2.

A running effect may remain running indefinitely.


===============================================================================
25. UNKNOWN OUTCOME RESEARCH NOTE
===============================================================================

Add a short design note for future work:

    effect timeout cannot safely map directly to failed

because provider execution may have happened despite loss of response.

Potential future state:

    unknown

but do not freeze it in 0.8.2.


===============================================================================
26. EFFECT_CORRELATION_ID_FIELD DOCUMENTATION
===============================================================================

Document exactly what:

    EFFECT_CORRELATION_ID_FIELD

contains.

Specify:

    source of value
    lifetime
    uniqueness scope
    whether stable across restart
    whether consumer can set it
    whether always present


===============================================================================
27. DO NOT MAKE INTERNAL TX IDS AN APPLICATION CONTRACT ACCIDENTALLY
===============================================================================

If the current value is an internal transaction id such as:

    tx_<n>

decide whether that format/value is intended public contract.

Preferred:

    document semantics, not string format.

Example:

    "identifies the Axiom transaction that created the effect intent"

without freezing implementation formatting.


===============================================================================
28. BUSINESS CORRELATION GUIDANCE
===============================================================================

Document prominently:

    effect outcomes do not carry the original operation arguments automatically.

For application-level correlation, use an explicit semantic key.

Current recommended mechanism:

    idempotencyKey

if appropriate.


===============================================================================
29. DO NOT OVERLOAD IDEMPOTENCY ACCIDENTALLY
===============================================================================

Evaluate whether using:

    idempotencyKey

as the only practical business correlation channel is conceptually clean.

If not, consider adding an explicit:

    correlationKey
    correlationValue

to integration-effect authoring.

Only add it if it remains simple and clearly distinct from idempotency.


===============================================================================
30. PREFERRED 0.8.2 DECISION
===============================================================================

Unless a strong use case proves otherwise:

    keep idempotencyKey behavior unchanged
    improve docs
    defer a new correlation primitive

Avoid adding API solely to remove a documentation inconvenience.


===============================================================================
31. EFFECT OUTCOME DOCUMENTATION
===============================================================================

Document the full structured outcome envelope in one place.

Include:

    always-present fields
    success-only fields
    failure-only fields
    optional fields
    correlation semantics
    security/disclosure rules


===============================================================================
32. SUCCESS/FAILURE SHAPE CLARITY
===============================================================================

Clarify that:

    success
    failure

share an envelope family but not identical populated fields.

Do not call them "symmetric" if they are not literally symmetric.


===============================================================================
33. EFFECT MESSAGE SECURITY
===============================================================================

Document the boundary clearly:

    framework diagnostics sanitize according to framework policy;

    application-authored copying of provider message text into state is the application's
    responsibility.

This distinction was correctly observed in Experiment #10 and should be explicit.


===============================================================================
34. getWebhookEvents()
===============================================================================

Resolve the naming ambiguity.

Current behavior is graph-static:

    EventDefs that have TriggerDefs reacting to them.

It is not:

    webhook deliveries received at runtime.


===============================================================================
35. PREFERRED API FIX
===============================================================================

Preferred:

    deprecate getWebhookEvents()

and replace with a semantically accurate name such as:

    getTriggeredEvents()

or:

    getEventsWithHandlers()

Choose terminology consistent with EventDef/TriggerDef.


===============================================================================
36. BACKWARD COMPATIBILITY
===============================================================================

Keep getWebhookEvents() temporarily as a deprecated alias if needed.

Docs should stop presenting it as webhook-specific behavior.


===============================================================================
37. WEBHOOK DEPLOYMENT INTROSPECTION
===============================================================================

Do NOT force GraphQueries to infer deployment-level webhook registration.

Webhook routes/configuration belong to host/deployment semantics, not canonical graph structure.


===============================================================================
38. RETRYABLE ABSENT SEMANTICS
===============================================================================

Experiment #10 confirmed:

    retryable: false → stop retrying
    retryable: true  → continue policy
    retryable absent → continue policy

Document the absent case explicitly.


===============================================================================
39. RETRYABLE CONTRACT
===============================================================================

Preferred normative wording:

    false:
        adapter declares retry cannot succeed; stop remaining policy.

    true:
        adapter declares retry may succeed; continue policy.

    absent:
        adapter does not know; continue the declared retry policy.


===============================================================================
40. QUERY SERIALIZATION / AUTHORITY QUEUE
===============================================================================

Document near integration-query timeout semantics that:

    Axiom authority executes Actions through a serialized FIFO authority queue.

Therefore a hung query:

    delays subsequent Actions up to timeoutMs

rather than:

    allowing unrelated Actions to run concurrently.


===============================================================================
41. DO NOT CHANGE CONCURRENCY MODEL IN 0.8.2
===============================================================================

The observed behavior is correct under current authority semantics.

Do not introduce query concurrency merely to remove this delay.


===============================================================================
42. TIMEOUT BOUNDS THE DELAY
===============================================================================

Add a regression test:

    query hangs
    unrelated Action queued
    timeout fires
    unrelated Action then executes

Ensure the bounded-delay invariant stays true.


===============================================================================
43. AGENT_REFERENCE PORTABLE ARTIFACTS
===============================================================================

Update the compressed portable-artifacts section to list:

    server-ir.v1.schema.json
    server-ir.v2.schema.json
    server-ir.v3.schema.json
    server-ir.v4.schema.json
    protocol schema(s)
    conformance manifest

or a generated equivalent.


===============================================================================
44. GENERATED DOC ENUMERATIONS
===============================================================================

Where docs enumerate:

    server contracts
    schema files
    diagnostic vocabularies
    public pattern/node kinds

prefer generated/tested content rather than manually duplicated counts/lists.


===============================================================================
45. DOC CONSISTENCY TEST
===============================================================================

Add automated checks covering at least:

    SERVER_IR_CONTRACTS vs AUTHORITY.md
    shipped schema files vs AGENT_REFERENCE
    conformance fixture manifest vs fixture directory
    public diagnostic codes vs diagnostic reference where applicable


===============================================================================
46. CONFORMANCE MANIFEST DIRECTORY PARITY
===============================================================================

Manifest entries must match actual shipped fixture files exactly.

No:

    unlisted fixture
    missing listed fixture


===============================================================================
47. PACKAGE EXPORT CHECK
===============================================================================

Ensure all intended public conformance artifacts remain reachable from the published npm package.

Test from packed artifacts, not workspace paths.


===============================================================================
48. EXTERNAL CONSUMER DOCUMENTATION SMOKE TEST
===============================================================================

From an empty project using packed/published artifacts:

    locate docs
    identify current server contract
    locate schemas
    locate conformance fixtures
    understand effect statuses
    understand client-trigger validation

without reading implementation source.


===============================================================================
49. SOURCE-HYGIENE REGRESSION
===============================================================================

Reference integration application remains:

    fetch() ......................... 0
    setInterval() ................... 0
    setTimeout() .................... 0
    custom webhook handlers ........ 0
    NativeOperation ................ 0
    failure-text parsing ............ 0


===============================================================================
50. NO CHANGE TO INVOCATION SOURCE SECURITY
===============================================================================

Retain all 0.8.1 protections:

    anonymous → system-only rejected
    authenticated → system-only rejected
    raw source spoof → rejected/ignored
    trigger → system-only accepted
    client-only target mismatch statically rejected


===============================================================================
51. NO CHANGE TO QUERY TIMEOUT GUARANTEE
===============================================================================

Retain:

    runtime-owned deadline
    adapter-independent completion
    late success ignored
    late rejection ignored
    polling recovery


===============================================================================
52. NO CHANGE TO CLIENT-TRIGGER SAFETY
===============================================================================

Unsupported client triggers must remain impossible to ship silently.

Regardless of validateGraph API choice:

    compileToIR must reject them.


===============================================================================
53. NO CHANGE TO SCHEDULER PARITY
===============================================================================

Retain deterministic/real-host equivalence for simultaneous trigger scenarios.


===============================================================================
54. NO CHANGE TO OUTBOX GUARANTEES
===============================================================================

Retain:

    post-commit effects
    rollback suppresses effect intent
    durable restart recovery
    at-least-once delivery
    stable idempotency key


===============================================================================
55. SERVER CONTRACT VERSION
===============================================================================

Determine whether 0.8.2 changes serialized semantics.

If only:

    docs
    observability timing/status updates
    fixture coverage
    AgentAPI aliasing

change, DO NOT bump Server IR contract.

If effect status semantics are persisted/serialized in a portable contract in a meaningfully new
way, evaluate contract impact carefully.

Do not bump merely because package version changed.


===============================================================================
56. V4 FREEZE
===============================================================================

If no incompatible IR vocabulary change is required:

    axiom.server.v4 remains the latest contract.

Do not create v5 for polish-only changes.


===============================================================================
57. TEST GATE
===============================================================================

All existing tests pass.

Add permanent tests for:

    default client-trigger validation behavior
    diagnostic remediation text where testable
    running effect status
    attempt count before settlement
    hung effect restart
    expanded conformance fixtures
    docs/contract consistency
    manifest parity
    retryable absent semantics


===============================================================================
58. CONFORMANCE GATE
===============================================================================

All shipped fixtures pass the TypeScript reference runtime.

Target fixture coverage should include all core 0.8/0.8.1 behavior required for an independent
runtime.


===============================================================================
59. EXTERNAL RUNNER GATE
===============================================================================

Run the entire portable fixture suite through an independently-written/public-only runner or the new
public runner if one is added.

This guards against fixtures that only work because internal test code knows hidden behavior.


===============================================================================
60. VALIDATION GATE
===============================================================================

Reference app:

    valid: true
    errors: 0
    warnings: 0


===============================================================================
61. PACKAGING GATE
===============================================================================

From packed npm artifacts verify:

    docs present
    schemas present
    manifest present
    all fixtures present
    public conformance APIs present if added


===============================================================================
62. EXTERNAL RETEST
===============================================================================

Run a focused external consumer smoke/retest after implementation.

It need not repeat Experiment #10 in full.

At minimum verify:

    validateGraph behavior is understandable
    v4 docs are correct
    effectLog shows running attempt
    no text parsing for effect failure
    conformance suite is externally usable


===============================================================================
63. REQUIRED IMPLEMENTATION REPORT
===============================================================================

Produce:

    AXIOM_0_8_2_IMPLEMENTATION_REPORT.md


===============================================================================
64. REQUIRED FINAL QUESTIONS — VALIDATION
===============================================================================

Answer:

1. What is validateGraph()'s default target/capability behavior now?
2. Can a client-authority unsupported trigger return valid:true under the default call?
3. Does compileToIR still reject unsupported client triggers?
4. Does CLIENT_TRIGGER_UNSUPPORTED explain the remediation?


===============================================================================
65. REQUIRED FINAL QUESTIONS — CONTRACT DOCS
===============================================================================

5. Is axiom.server.v4 documented in AUTHORITY.md?
6. Is the contract table tested against SERVER_IR_CONTRACTS?
7. What happened to manifest.json's top-level contract field?
8. Are all four Server IR schemas listed in agent-facing docs?


===============================================================================
66. REQUIRED FINAL QUESTIONS — EFFECT OBSERVABILITY
===============================================================================

9. What does effectLog report before dispatch?
10. What does it report while an adapter call is outstanding?
11. When does attempts increment?
12. Does a hung effect show running/attempts=1?
13. What happens to running effects after restart?
14. Was any effect timeout introduced?
15. If not, is the lack of effect timeout documented explicitly?


===============================================================================
67. REQUIRED FINAL QUESTIONS — OUTCOMES/CORRELATION
===============================================================================

16. What exactly does EFFECT_CORRELATION_ID_FIELD mean?
17. Is its string format part of the contract?
18. How should an app correlate outcome to a business entity?
19. Does the outcome contain original operation arguments?
20. Was a new correlation primitive added?
21. Are success/failure envelope fields documented precisely?


===============================================================================
68. REQUIRED FINAL QUESTIONS — AGENTAPI
===============================================================================

22. Was getWebhookEvents renamed/deprecated/clarified?
23. What does its replacement mean exactly?
24. Does GraphQueries still avoid pretending to know deployment-level webhook registrations?


===============================================================================
69. REQUIRED FINAL QUESTIONS — RETRY / CONCURRENCY
===============================================================================

25. What does retryable absent mean?
26. Does a hung query delay unrelated Actions?
27. Is that delay bounded by timeoutMs?
28. Was the serialized authority model changed?


===============================================================================
70. REQUIRED FINAL QUESTIONS — CONFORMANCE
===============================================================================

29. How many fixtures now ship?
30. Which new scenarios were added?
31. Is failed-effect outcome covered?
32. Is late-result-after-timeout covered?
33. Is simultaneous-trigger scheduling covered?
34. Is effect restart covered?
35. Is rollback-suppresses-effect covered?
36. Is retry sequence covered?
37. Is event-depth guard covered?
38. Are all fixtures data-only?
39. Is a public runner exported?
40. Did an independent external runner pass all fixtures?


===============================================================================
71. REQUIRED FINAL QUESTIONS — VERSIONING
===============================================================================

41. Is axiom.server.v4 still latest?
42. Was a new contract required?
43. If so, why?
44. Did older contract fixtures remain unchanged?


===============================================================================
72. REQUIRED FINAL QUESTIONS — VERDICT
===============================================================================

45. Did any S3/S4 defect appear?
46. Did effect observability improve?
47. Are docs materially more self-consistent?
48. Is the portable contract closer to P1?
49. What are the five largest remaining limitations?
50. Is 0.8.x now complete enough to stop feature work and move to 0.9?


===============================================================================
73. RELEASE CLASSIFICATION
===============================================================================

Choose exactly one:

A — 0.8 LINE COMPLETE

    Remaining 0.8.1 friction is resolved sufficiently; no S3/S4 defects; documentation and portable
    contracts are coherent enough to move on.

B — COMPLETE WITH MINOR DOCUMENTATION/TOOLING DEBT

    Core semantics are finished, but small S0/S1 items remain.

C — IMPORTANT HARDENING GAP REMAINS

    An S2/S3-level issue still materially weakens integration/trigger usability or portability.

D — TRUST/SEMANTIC REGRESSION

    A new S4 or equivalent integrity defect appears.


===============================================================================
74. PORTABILITY CLASSIFICATION
===============================================================================

Choose:

    P1 — PORTABLE CONTRACT READY
    P2 — PORTABLE CORE READY, SMALL FIXTURE/DOC GAPS REMAIN
    P3 — IMPORTANT SEMANTICS STILL REQUIRE IMPLEMENTATION INFERENCE
    P4 — NOT PORTABLE


===============================================================================
75. EFFECT OBSERVABILITY CLASSIFICATION
===============================================================================

Choose:

    O1 — PENDING/RUNNING/TERMINAL STATES ARE CLEARLY OBSERVABLE
    O2 — IMPROVED BUT SOME AMBIGUITY REMAINS
    O3 — HUNG EFFECTS STILL CANNOT BE DISTINGUISHED
    O4 — EFFECT OBSERVABILITY UNSOUND


===============================================================================
76. PRIMARY SUCCESS TARGET
===============================================================================

Strong expected result:

    A/B + P1/P2 + O1

with:

    S3 defects ........................ 0
    S4 defects ........................ 0
    stale contract docs ............... 0
    ambiguous pending-vs-running ...... 0
    effect failure text parsing ....... 0
    client-trigger silent compile ..... 0
    portable fixture major gaps ....... substantially reduced


===============================================================================
77. CENTRAL RELEASE PRINCIPLE
===============================================================================

0.8.0 added the external-world semantic model.

0.8.1 made it trustworthy.

0.8.2 should make the contract:

    clear
    observable
    portable
    internally consistent


without expanding what the language fundamentally does.


The release succeeds when a consumer or independent runtime implementer no longer has to infer
important 0.8 semantics from:

    contradictory docs
    implementation behavior
    hidden status transitions
    missing portable examples.


After that, 0.8 should be considered closed and further architectural work should move to 0.9.